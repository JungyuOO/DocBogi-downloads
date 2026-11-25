const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const profileName = "Offline macOS smoke profile";
const legacyDate = "2028-06-12";
const legacyTitle = "Synthetic single-day calendar migration";
const rangeTitle = "Synthetic multi-day contract review";
const rangeNotes = "Packaged macOS calendar persistence fixture";
const startDate = "2027-09-27", endDate = "2027-11-02";
const october = { start: "2027-10-01", end: "2027-10-31" };

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
    assert.equal(runtime.name, name);
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
  const inputs = [1, 2].map(index => path.join(scratch, "fixtures", "layout-fixture-" + index + ".docx"));
  await app.evaluate(({ dialog }, filenames) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: filenames });
  }, inputs);
  const results = await bridge(page, "importDialog", null);
  assert.equal(results.length, inputs.length);
  assert(results.every(item => item.document && !item.error), "Synthetic documents could not be imported");
  await page.waitForFunction(async () => {
    const snapshot = await window.docvia.snapshot();
    return !snapshot.jobs?.some(job => job.state === "queued" || job.state === "running");
  }, undefined, { timeout: 60000 });
  const snapshot = await bridge(page, "snapshot");
  const profile = snapshot.profiles.find(item => item.name === profileName);
  assert(profile, "Synthetic profile was not saved");
  const documents = results.map(item => item.document);
  const legacyEvent = await bridge(page, "calendarSave", {
    date: legacyDate, time: null, title: legacyTitle, notes: "Legacy day note", documentId: documents[0].id,
    reminderEnabled: true, reminderDaysBefore: 1, reminderTime: "09:00",
  });
  assert.equal(legacyEvent.date, legacyDate);
  assert.equal(legacyEvent.endDate, undefined);
  assert.equal(legacyEvent.documentIds, undefined);
  assert(Number.isSafeInteger(legacyEvent.alarmAt));
  return { profileId: profile.id, documents, legacyEvent };
}

async function requireLegacyProfileAndEvent(page, fixture) {
  const snapshot = await bridge(page, "snapshot");
  assert(snapshot.profiles.some(item => item.id === fixture.profileId && item.name === profileName),
    "Existing AI profile was not retained");
  for (const document of fixture.documents) {
    assert(snapshot.documents.some(item => item.id === document.id && item.name === document.name && item.hash === document.hash),
      "An existing vault document was not retained");
  }
  const event = await bridge(page, "calendarEvent", fixture.legacyEvent.id);
  assert.equal(event.title, legacyTitle);
  assert.equal(event.notes, fixture.legacyEvent.notes);
  assert.equal(event.revision, fixture.legacyEvent.revision);
  assert.equal(event.date, legacyDate);
  assert.equal(event.endDate, legacyDate);
  assert.equal(event.documentId, fixture.documents[0].id);
  assert.deepEqual(event.documentIds, [fixture.documents[0].id]);
  assert.equal(event.reminderAnchor, "start");
  assert.equal(event.alarmAt, fixture.legacyEvent.alarmAt);
  const matchingDay = await bridge(page, "calendarView", { start: legacyDate, end: legacyDate });
  assert(matchingDay.events.some(item => item.id === event.id));
}

async function openCalendar(page) {
  const button = page.getByRole("button", { name: "업무 캘린더", exact: true });
  if (!await button.isVisible()) await page.getByRole("button", { name: "업무 도구", exact: true }).click();
  await button.click();
  const pane = page.getByRole("complementary", { name: "업무 캘린더", exact: true });
  await pane.waitFor();
  assert.equal(await page.getByRole("dialog", { name: "업무 캘린더", exact: true }).count(), 0);
  return pane;
}

async function verifyCalendar(page, fixture) {
  assert.equal(await page.title(), "DocBogi");
  const brand = page.locator(".brand").first();
  await brand.locator("small").waitFor({ state: "visible" });
  assert.equal((await brand.textContent()).replace(/\s/g, ""), "DocBogi내문서작업공간");

  const calendar = await openCalendar(page);
  await calendar.getByRole("button", { name: "일정 추가", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await editor.getByLabel("제목", { exact: true }).fill(rangeTitle);
  await editor.getByLabel("메모", { exact: true }).fill(rangeNotes);
  await editor.getByLabel("시작일", { exact: true }).fill(startDate);
  await editor.getByLabel("종료일", { exact: true }).fill(endDate);
  for (const document of fixture.documents) {
    await editor.getByRole("combobox", { name: "문서 추가", exact: true }).click();
    await page.getByRole("option", { name: document.name, exact: true }).click();
    await editor.getByRole("button", { name: document.name + " 열기", exact: true }).waitFor();
  }
  await editor.getByRole("checkbox", { name: "일정 알림", exact: true }).check();
  await editor.getByRole("combobox", { name: "알림 기준일", exact: true }).click();
  await page.getByRole("option", { name: "종료일", exact: true }).click();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await editor.waitFor({ state: "hidden" });

  await calendar.getByRole("heading", { name: "2027년 9월", exact: true }).waitFor();
  const previous = calendar.getByRole("button", { name: "이전 달", exact: true });
  const next = calendar.getByRole("button", { name: "다음 달", exact: true });
  const positions = await Promise.all([previous.boundingBox(), next.boundingBox()]);
  await next.click();
  await calendar.getByRole("heading", { name: "2027년 10월", exact: true }).waitFor();
  assert.deepEqual(await Promise.all([previous.boundingBox(), next.boundingBox()]), positions);
  await calendar.getByRole("button", { name: "목록", exact: true }).click();
  await calendar.getByRole("button", { name: new RegExp(rangeTitle) }).waitFor();

  const event = (await bridge(page, "calendarView", october)).events.find(item => item.title === rangeTitle);
  assert(event, "The overlapping range was not returned for a fully covered month");
  assert.equal(event.date, startDate);
  assert.equal(event.endDate, endDate);
  assert.equal(event.notes, rangeNotes);
  assert.equal(event.reminderAnchor, "end");
  assert(Number.isSafeInteger(event.alarmAt));
  assert.deepEqual(event.documentIds, fixture.documents.map(document => document.id));
  return event;
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
  assert.equal(base, path.join(scratch, "base-mounted", "DocBogi.app"));
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
    const previous = { name: "DocBogi", version: "1.1.3", userData };
    const current = { name: "DocBogi", version: "1.1.4", userData };
    const fixture = await withApplication(_electron, base, previous, (app, page) =>
      seedLegacyProfile(app, page, scratch));
    const saved = await withApplication(_electron, bundle, current, async (_app, page) => {
      await requireLegacyProfileAndEvent(page, fixture);
      return verifyCalendar(page, fixture);
    });
    await withApplication(_electron, bundle, current, async (_app, page) => {
      await requireLegacyProfileAndEvent(page, fixture);
      const view = await bridge(page, "calendarView", october);
      const event = view.events.find(item => item.id === saved.id);
      assert.deepEqual(event, saved, "The ranged event and linked documents must persist after restarting");
    });
    console.log("Mounted DocBogi 1.1.4 opened, migrated the 1.1.3 day event, and saved and reopened an inclusive range with linked documents.");
  } finally {
    assert.equal(await fs.readFile(marker, "utf8"), ownership);
    await fs.rm(userData, { recursive: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
