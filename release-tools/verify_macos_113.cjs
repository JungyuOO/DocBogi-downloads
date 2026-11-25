const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const profileName = "Offline macOS smoke profile";
const eventTitle = "Synthetic contract review";
const eventNotes = "Packaged macOS calendar persistence fixture";

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(DOCVIA_|GH_TOKEN$|GITHUB_TOKEN$|CODEX_|OPENAI_|ANTHROPIC_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
}

async function bridge(page, method, ...args) {
  return page.evaluate(({ method, args }) => window.docvia[method](...args), { method, args });
}

async function withApplication(electron, bundle, { name, version, userData }, exercise) {
  const app = await electron.launch({
    executablePath: path.join(bundle, "Contents", "MacOS", name),
    env: cleanEnvironment(),
    viewport: null,
    timeout: 60000,
  });
  try {
    const runtime = await app.evaluate(({ app }) => ({
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      data: app.getPath("userData"),
      resources: app.getAppPath(),
    }));
    assert.equal(runtime.version, version);
    if (version === "1.1.3") assert.equal(runtime.name, name);
    assert.equal(runtime.packaged, true);
    assert.equal(await fs.realpath(runtime.data), userData);
    assert.equal(await fs.realpath(runtime.resources), path.join(bundle, "Contents", "Resources", "app"));
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => !!window.docvia);
    return await exercise(app, page);
  } finally {
    await app.close();
  }
}

async function seedLegacyProfile(app, page, scratch) {
  const initial = await bridge(page, "snapshot");
  assert.equal(initial.documents.length, 0);
  assert.equal(initial.profiles.length, 0);
  const vault = path.join(scratch, "fixture-vault");
  await fs.mkdir(vault);
  await bridge(page, "chooseVault", vault);
  await bridge(page, "setAutoAnalyze", false);
  await bridge(page, "setAutoPlace", false);
  await bridge(page, "saveProfile", {
    provider: "custom",
    name: profileName,
    endpoint: "https://example.invalid/chat",
    persist: true,
  });
  const input = path.join(scratch, "fixtures", "layout-fixture-1.docx");
  await app.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, input);
  const results = await bridge(page, "importDialog", null);
  assert.equal(results.length, 1);
  assert(results[0].document && !results[0].error, "Synthetic document could not be imported");
  await page.waitForFunction(async () => {
    const snapshot = await window.docvia.snapshot();
    return !snapshot.jobs?.some(job => job.state === "queued" || job.state === "running");
  }, undefined, { timeout: 60000 });
  const snapshot = await bridge(page, "snapshot");
  const profile = snapshot.profiles.find(item => item.name === profileName);
  assert(profile, "Synthetic profile was not saved");
  return { profileId: profile.id, document: results[0].document };
}

async function requireLegacyProfile(page, fixture) {
  const snapshot = await bridge(page, "snapshot");
  assert(snapshot.profiles.some(item => item.id === fixture.profileId && item.name === profileName),
    "Existing AI profile was not retained");
  assert(snapshot.documents.some(item => item.id === fixture.document.id && item.name === fixture.document.name),
    "Existing vault document was not retained");
}

async function openCalendar(page) {
  const calendar = page.getByRole("button", { name: "업무 캘린더", exact: true });
  if (!await calendar.isVisible()) {
    await page.getByRole("button", { name: "업무 도구", exact: true }).click();
  }
  await calendar.click();
  const dialog = page.getByRole("dialog", { name: "업무 캘린더", exact: true });
  await dialog.waitFor();
  return dialog;
}

async function verifyCalendarAndSelectors(page, fixture) {
  assert.equal(await page.title(), "DocBogi");
  const brand = page.locator(".brand").first();
  await brand.locator("small").waitFor({ state: "visible" });
  assert.equal((await brand.locator("small").textContent()).trim(), "내 문서 작업 공간");
  assert.equal((await brand.textContent()).replace(/\s/g, ""), "DocBogi내문서작업공간");

  const format = page.getByRole("combobox", { name: "문서 형식", exact: true });
  await format.press("Enter");
  const docx = page.getByRole("option", { name: "DOCX", exact: true });
  await docx.waitFor();
  await docx.click();
  assert.match(await format.textContent(), /DOCX/);

  const calendar = await openCalendar(page);
  await calendar.getByRole("button", { name: "일정 추가", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await editor.getByLabel("제목", { exact: true }).fill(eventTitle);
  await editor.getByLabel("메모", { exact: true }).fill(eventNotes);
  const date = await editor.getByLabel("날짜", { exact: true }).inputValue();
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  await editor.getByRole("combobox", { name: "연결 문서", exact: true }).click();
  await page.getByRole("option", { name: fixture.document.name, exact: true }).click();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await calendar.getByRole("button", { name: "목록", exact: true }).click();
  await calendar.getByRole("button", { name: new RegExp(eventTitle) }).waitFor();

  const range = { start: date, end: date };
  const event = (await bridge(page, "calendarView", range)).events.find(item => item.title === eventTitle);
  assert(event, "Calendar event was not saved");
  assert.equal(event.notes, eventNotes);
  assert.equal(event.documentId, fixture.document.id);
  return { id: event.id, range };
}

async function main() {
  const [baseArg, bundleArg, scratchArg, modulePath] = process.argv.slice(2);
  assert([baseArg, bundleArg, scratchArg, modulePath].every(arg => arg && path.isAbsolute(arg)));
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Release smoke requires a fresh hosted macOS profile");
  const scratch = await fs.realpath(scratchArg);
  const temp = await fs.realpath(process.env.RUNNER_TEMP);
  assert(scratch.startsWith(temp + path.sep));
  const base = await fs.realpath(baseArg);
  const bundle = await fs.realpath(bundleArg);
  assert.equal(base, path.join(scratch, "base-mounted", "Docvia.app"));
  assert.equal(bundle, path.join(scratch, "final-mounted", "DocBogi.app"));
  const { _electron } = require(modulePath);
  const home = await fs.realpath(os.homedir());
  const appData = path.join(home, "Library", "Application Support");
  await fs.mkdir(appData, { recursive: true });
  assert.equal(await fs.realpath(appData), appData);
  const userData = path.join(appData, "Docvia");
  await fs.mkdir(userData, { mode: 0o700 });
  const marker = path.join(userData, ".docbogi-release-smoke");
  const ownership = randomUUID();
  await fs.writeFile(marker, ownership, { flag: "wx", mode: 0o600 });

  try {
    const previous = { name: "Docvia", version: "1.1.2", userData };
    const current = { name: "DocBogi", version: "1.1.3", userData };
    const fixture = await withApplication(_electron, base, previous, (app, page) =>
      seedLegacyProfile(app, page, scratch));
    const saved = await withApplication(_electron, bundle, current, async (_app, page) => {
      await requireLegacyProfile(page, fixture);
      return verifyCalendarAndSelectors(page, fixture);
    });
    await withApplication(_electron, bundle, current, async (_app, page) => {
      await requireLegacyProfile(page, fixture);
      const view = await bridge(page, "calendarView", saved.range);
      const event = view.events.find(item => item.id === saved.id);
      assert(event, "Calendar event was not retained after restarting");
      assert.equal(event.title, eventTitle);
      assert.equal(event.notes, eventNotes);
      assert.equal(event.documentId, fixture.document.id);
    });
    console.log("Mounted DocBogi 1.1.3 opened, displayed its sidebar and accessible selectors, saved and reopened a calendar event, and retained the synthetic 1.1.2 profile and document.");
  } finally {
    assert.equal(await fs.readFile(marker, "utf8"), ownership);
    await fs.rm(userData, { recursive: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
