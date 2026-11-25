const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const bridgeDeadline = 20000;
let activeStage = "initialization";
let active;
const log = value => console.log("[mac-smoke] " + value);

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

async function bounded(label, milliseconds, operation) {
  const previous = activeStage;
  activeStage = label;
  log("start " + label);
  let timer;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " exceeded " + milliseconds + " ms")), milliseconds);
      }),
    ]);
    log("done " + label);
    return answer;
  } finally {
    clearTimeout(timer);
    if (activeStage === label) activeStage = previous;
  }
}

function describeOwnedApp(context) {
  const child = active?.child;
  let windows = null;
  try { windows = active?.app.windows().length ?? null; } catch { /* The pipe may already be closed. */ }
  console.error("[mac-smoke]", JSON.stringify({
    context, stage: activeStage, version: active?.version ?? null,
    pid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, windows,
  }));
}

function running(child) {
  return !!child?.pid && child.exitCode === null && child.signalCode === null;
}

function signalOwnedChild(child, signal) {
  if (running(child)) child.kill(signal);
}

async function waitForExit(child, milliseconds) {
  if (!running(child)) return;
  let timer;
  let finished;
  try {
    await new Promise((resolve, reject) => {
      finished = resolve;
      child.once("exit", finished);
      timer = setTimeout(() => reject(new Error("The owned Electron child did not exit")), milliseconds);
    });
  } finally {
    clearTimeout(timer);
    child.removeListener("exit", finished);
  }
}

async function stopOwnedChild(child) {
  signalOwnedChild(child, "SIGTERM");
  try { await waitForExit(child, 2500); }
  catch {
    signalOwnedChild(child, "SIGKILL");
    await waitForExit(child, 2500);
  }
}

async function requireReleasedLock(userData) {
  for (const name of ["SingletonLock", "SingletonSocket"]) {
    try {
      await fs.lstat(path.join(userData, name));
      throw new Error("Stale Electron instance artifact after close: " + name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function bridge(page, method, ...args) {
  return bounded("bridge " + method, bridgeDeadline, () =>
    page.evaluate(({ method, args }) => window.docvia[method](...args), { method, args }));
}

async function installBundle(source, applications, version, upgrading = false) {
  const installed = path.join(applications, "DocBogi.app");
  const staged = path.join(applications, ".staging-" + randomUUID() + ".app");
  return bounded("install " + version, 36000, async () => {
    assert(!running(active?.child), "Close the owned application before installing another version");
    await exec("/usr/bin/ditto", [source, staged], { timeout: 24000 });
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], { timeout: 8000 });
    if (upgrading) {
      // Darwin swaps both complete bundles in one rename operation on the same volume.
      const exchange = [
        "import ctypes, os, sys",
        "libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)",
        "swap = libc.renamex_np",
        "swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]",
        "swap.restype = ctypes.c_int",
        "RENAME_SWAP = 0x00000002",
        "if swap(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), RENAME_SWAP) != 0:",
        "    code = ctypes.get_errno()",
        "    raise OSError(code, os.strerror(code))",
      ].join("\n");
      await exec("python3", ["-c", exchange, staged, installed], { timeout: 3000 });
    } else await fs.rename(staged, installed);
    assert.equal(await fs.realpath(installed), installed);
    return installed;
  });
}

async function withApplication(electron, bundle, { name, version, userData }, label, exercise) {
  const launchOptions = {
    executablePath: path.join(bundle, "Contents", "MacOS", name),
    env: cleanEnvironment(),
    viewport: null,
    timeout: 24000,
  };
  // Optional CI-only switch for a hosted runner with no unlocked login keychain.
  // The smoke keeps only a synthetic profile and never exercises real credentials.
  if (process.env.DOCBOGI_SMOKE_MOCK_KEYCHAIN === "1") launchOptions.args = ["--use-mock-keychain"];
  const app = await bounded("launch " + label, 26000, () => electron.launch(launchOptions));
  const child = app.process();
  active = { app, child, version };
  let exerciseError;
  try {
    const runtime = await bounded("read installed runtime " + label, 12000, () => app.evaluate(({ app }) => ({
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      data: app.getPath("userData"),
      resources: app.getAppPath(),
    })));
    assert.equal(runtime.version, version);
    assert.equal(runtime.name, name);
    assert.equal(runtime.packaged, true);
    assert.equal(await fs.realpath(runtime.data), userData);
    assert.equal(await fs.realpath(runtime.resources), path.join(bundle, "Contents", "Resources", "app"));

    const page = await bounded("first window " + label, 22000, () => app.firstWindow({ timeout: 20000 }));
    page.setDefaultTimeout(15000);
    await bounded("renderer bridge ready " + label, 20000, async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => !!window.docvia);
    });
    return await bounded("exercise " + label, 62000, () => exercise(app, page));
  } catch (error) {
    exerciseError = error;
    describeOwnedApp(error.message);
    throw error;
  } finally {
    try {
      await bounded("close " + label, 11000, () => app.close());
      await bounded("confirm process exit " + label, 6000, () => waitForExit(child, 5000));
      await bounded("check instance lock " + label, 4000, () => requireReleasedLock(userData));
    } catch (error) {
      describeOwnedApp(error.message);
      await stopOwnedChild(child);
      if (!exerciseError) throw error;
    } finally {
      if (!running(child)) active = undefined;
    }
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
  await bounded("set synthetic file picker", 12000, () => app.evaluate(({ dialog }, filenames) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: filenames });
  }, inputs));
  const results = await bridge(page, "importDialog", null);
  assert.equal(results.length, inputs.length);
  assert(results.every(item => item.document && !item.error), "Synthetic documents could not be imported");
  await bounded("wait for synthetic imports", 22000, () => page.waitForFunction(async () => {
    const snapshot = await window.docvia.snapshot();
    return !snapshot.jobs?.some(job => job.state === "queued" || job.state === "running");
  }, undefined, { timeout: 20000 }));
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
    const applications = path.join(scratch, "Applications");
    await fs.mkdir(applications);
    const installed = await installBundle(base, applications, previous.version);
    const fixture = await withApplication(_electron, installed, previous, "1.1.3 baseline", (app, page) =>
      seedLegacyProfile(app, page, scratch));
    const upgraded = await installBundle(bundle, applications, current.version, true);
    assert.equal(upgraded, installed);
    const saved = await withApplication(_electron, installed, current, "1.1.4 upgrade", async (_app, page) => {
      await requireLegacyProfileAndEvent(page, fixture);
      return verifyCalendar(page, fixture);
    });
    await withApplication(_electron, installed, current, "1.1.4 restart", async (_app, page) => {
      await requireLegacyProfileAndEvent(page, fixture);
      const view = await bridge(page, "calendarView", october);
      const event = view.events.find(item => item.id === saved.id);
      assert.deepEqual(event, saved, "The ranged event and linked documents must persist after restarting");
    });
    log("Installed upgrade migrated the 1.1.3 day event and reopened an inclusive range with linked documents.");
  } finally {
    assert.equal(await fs.readFile(marker, "utf8"), ownership);
    if (!running(active?.child)) await fs.rm(userData, { recursive: true });
  }
}

const watchdog = setTimeout(() => {
  describeOwnedApp("180-second smoke watchdog expired");
  const child = active?.child;
  signalOwnedChild(child, "SIGTERM");
  setTimeout(() => {
    signalOwnedChild(child, "SIGKILL");
    process.exit(1);
  }, 2500);
}, 180000);
log("start hosted macOS acceptance");
main().then(() => log("done hosted macOS acceptance"), error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  // Let a clean process exit normally. A leaked Playwright handle still has a deadline.
  watchdog.unref();
});
