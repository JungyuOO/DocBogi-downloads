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
let diagnostics;
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
        timer = setTimeout(() => {
          const error = new Error(label + " exceeded " + milliseconds + " ms");
          error.name = "TimeoutError";
          reject(error);
        }, milliseconds);
      }),
    ]);
    log("done " + label);
    return answer;
  } catch (error) {
    error.smokeStage ??= label;
    throw error;
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

function instrumentNativeWindows({ app, BrowserWindow, dialog }) {
  const monitored = new WeakSet();
  const notices = [];
  const remember = entry => { if (notices.length < 16) notices.push(entry); };
  globalThis.__docbogiSmokeNotices = notices;
  const monitor = window => {
    if (monitored.has(window)) return;
    monitored.add(window);
    window.webContents.on("preload-error", (_, preload, error) => {
      remember({ type: "preload-error", preload, error: error?.name ?? "Error" });
    });
    window.webContents.on("did-fail-load", (_, code, _text, url, isMainFrame) => {
      if (isMainFrame) remember({ type: "did-fail-load", code, url: url?.split("?")[0] });
    });
    window.webContents.on("render-process-gone", (_, details) => {
      remember({ type: "render-process-gone", reason: details.reason, exitCode: details.exitCode });
    });
  };
  app.on("browser-window-created", (_, window) => monitor(window));
  BrowserWindow.getAllWindows().forEach(monitor);
  for (const method of ["showErrorBox", "showMessageBoxSync", "showMessageBox"]) {
    const original = dialog[method];
    dialog[method] = function(...args) {
      const options = args.find(value => value && typeof value === "object" && typeof value.message === "string");
      const title = method === "showErrorBox" ? args[0] : options?.title;
      remember({ type: "native-dialog", method, dialogType: options?.type ?? null, title: typeof title === "string" ? title.slice(0, 120) : null });
      return original.apply(this, args);
    };
  }
  return { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged,
    data: app.getPath("userData"), resources: app.getAppPath() };
}

function mainThreadSample(output) {
  const lines = output.split(/\r?\n/);
  const graph = lines.findIndex(line => /^Call graph:/.test(line));
  if (graph < 0) return [];
  const start = lines.findIndex((line, index) => index > graph &&
    /^\s*\d+\s+Thread_/.test(line) && /com\.apple\.main-thread|Main Thread/.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start &&
    (/^\s*\d+\s+Thread_/.test(line) || /^\s*(?:Total number|Sort by|Binary Images:)/.test(line)));
  return lines.slice(start, end < 0 ? undefined : end).map(line => line.trim()).filter(Boolean);
}

async function collectFailure(error, label) {
  const current = active;
  const metadata = { stage: error.smokeStage ?? activeStage, errorName: error.name, version: current?.version ?? null,
    pid: current?.child?.pid ?? null, windowUrl: current?.page?.url() ?? null, stderr: current?.stderr ?? "" };
  describeOwnedApp("collect failure for " + label + " at " + metadata.stage);
  const attempts = await Promise.allSettled([
    bounded("diagnose native window and preload", 2000, () => current?.app.evaluate(({ BrowserWindow }) => ({
      notices: globalThis.__docbogiSmokeNotices ?? [],
      windows: BrowserWindow.getAllWindows().map(window => ({
        visible: window.isVisible(), focused: window.isFocused(), title: window.getTitle().slice(0, 120),
        url: window.webContents.getURL().split("?")[0], loading: window.webContents.isLoading(), crashed: window.webContents.isCrashed(),
      })),
    }))),
    bounded("diagnose renderer state", 2000, () => current?.page?.evaluate(() => ({
      url: location.href.split("?")[0], title: document.title.slice(0, 120),
      ready: document.readyState, visibility: document.visibilityState, bridge: typeof window.docvia,
    }))),
    bounded("sample owned main process", 5000, async () => {
      if (!running(current?.child)) return [];
      const samplePath = path.join(path.dirname(diagnostics), ".sample-" + randomUUID());
      try {
        await exec("/usr/bin/sample", [String(current.child.pid), "1", "1", "-file", samplePath], { timeout: 4200 });
        return mainThreadSample(await fs.readFile(samplePath, "utf8"));
      } finally {
        await fs.unlink(samplePath).catch(() => {});
      }
    }),
  ]);
  const value = (result, otherwise) => result.status === "fulfilled" ? result.value ?? otherwise : otherwise;
  const native = value(attempts[0], null), renderer = value(attempts[1], null), sample = value(attempts[2], []);
  const credentialFrames = sample.filter(line =>
    /\b(?:SecKeychain\w+|SecItemCopyMatching|AuthorizationCopyRights|SecurityAgent|securityd::client|AppleKeychain)\b/.test(line));
  const waiting = sample.some(line => /mach_msg|semaphore_wait|dispatch_sync|xpc_connection_send_message_with_reply_sync|CFRunLoopRun/.test(line));
  const credentialDialog = native?.notices?.some(notice => notice.type === "native-dialog" &&
    /(?:keychain|SecKeychain|credential consent|키체인)/i.test(notice.title ?? ""));
  const credentialStage = /^(?:read installed runtime|first window|show and focus window|renderer bridge ready|bridge (?:snapshot|saveProfile)$|close )/.test(metadata.stage);
  const osCredentialConsent = error.name === "TimeoutError" && credentialStage &&
    (Boolean(credentialDialog) || credentialFrames.length > 0 && waiting);
  const result = {
    ...metadata, native, renderer, osCredentialConsent,
    sample: { mainThreadFound: sample.length > 0, credentialFrames: credentialFrames.slice(0, 12), frames: sample.slice(0, 26) },
  };
  console.error("[mac-smoke] failure diagnostic", JSON.stringify(result));
  if (diagnostics) {
    const name = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await fs.writeFile(path.join(diagnostics, name + "-" + randomUUID() + ".json"), JSON.stringify(result, null, 2));
  }
  if (osCredentialConsent) error.credentialWaitPhase = label;
  return osCredentialConsent;
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
  return bounded("install " + version, 110000, async () => {
    assert(!running(active?.child), "Close the owned application before installing another version");
    await exec("/usr/bin/ditto", [source, staged], { timeout: 60000 });
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], { timeout: 45000 });
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

async function withApplication(electron, bundle, { name, version, userData, isolateData = false, mockKeychain = false }, label, exercise) {
  const env = cleanEnvironment();
  if (isolateData) env.DOCVIA_DATA_DIR = userData;
  const launchOptions = {
    executablePath: path.join(bundle, "Contents", "MacOS", name),
    args: mockKeychain ? ["--use-mock-keychain"] : [],
    env: { ...env, ELECTRON_ENABLE_LOGGING: "1" },
    viewport: null,
    timeout: 24000,
  };
  const app = await bounded("launch " + label, 26000, () => electron.launch(launchOptions));
  const child = app.process();
  const instance = { app, child, version, stderr: "" };
  active = instance;
  child.stderr?.on("data", data => { instance.stderr = (instance.stderr + data.toString("utf8")).slice(-6000); });
  let exerciseError;
  try {
    const runtime = await bounded("read installed runtime " + label, 12000, () => app.evaluate(instrumentNativeWindows));
    assert.equal(runtime.version, version);
    assert.equal(runtime.name, name);
    assert.equal(runtime.packaged, true);
    assert.equal(await fs.realpath(runtime.data), userData);
    assert.equal(await fs.realpath(runtime.resources), path.join(bundle, "Contents", "Resources", "app"));

    const page = await bounded("first window " + label, 22000, () => app.firstWindow({ timeout: 20000 }));
    instance.page = page;
    page.setDefaultTimeout(15000);
    await bounded("show and focus window " + label, 8000, async () => {
      await app.evaluate(({ app, BrowserWindow }) => {
        app.focus({ steal: true });
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        if (window) { window.show(); window.focus(); }
      });
    });
    await bounded("renderer bridge ready " + label, 20000, async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => !!window.docvia, undefined, { polling: 100, timeout: 18000 });
    });
    return await bounded("exercise " + label, 62000, () => exercise(app, page));
  } catch (error) {
    exerciseError = error;
    error.osCredentialConsent = await collectFailure(error, label);
    throw error;
  } finally {
    try {
      await bounded("close " + label, 11000, () => app.close());
      await bounded("confirm process exit " + label, 6000, () => waitForExit(child, 5000));
      await bounded("check instance lock " + label, 4000, () => requireReleasedLock(userData));
    } catch (error) {
      try { error.osCredentialConsent = await collectFailure(error, label + " close"); }
      finally { await stopOwnedChild(child); }
      if (!exerciseError) throw error;
    } finally {
      if (!running(child)) active = undefined;
    }
  }
}

async function prepareOfflineVault(page, scenario) {
  const vault = path.join(scenario, "fixture-vault");
  await fs.mkdir(vault);
  await bridge(page, "chooseVault", vault);
  await bridge(page, "setAutoAnalyze", false);
  await bridge(page, "setAutoPlace", false);
}

async function importDocuments(app, page, inputs) {
  await bounded("set synthetic file picker", 12000, () => app.evaluate(({ dialog }, filenames) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: filenames });
  }, inputs));
  const results = await bridge(page, "importDialog", null);
  assert.equal(results.length, inputs.length);
  assert(results.every(item => item.document && !item.error), "Synthetic documents could not be imported");
  await bounded("wait for synthetic imports", 22000, () => page.waitForFunction(async () => {
    const snapshot = await window.docvia.snapshot();
    return !snapshot.jobs?.some(job => job.state === "queued" || job.state === "running");
  }, undefined, { polling: 100, timeout: 20000 }));
  return results.map(item => item.document);
}

async function seedProfileAndDocuments(app, page, scratch, scenario) {
  const initial = await bridge(page, "snapshot");
  assert.equal(initial.documents.length, 0);
  assert.equal(initial.profiles.length, 0);
  await prepareOfflineVault(page, scenario);
  await bridge(page, "saveProfile", {
    provider: "custom",
    name: profileName,
    endpoint: "https://example.invalid/chat",
    persist: true,
  });
  const inputs = [1, 2].map(index => path.join(scratch, "fixtures", "layout-fixture-" + index + ".docx"));
  const documents = await importDocuments(app, page, inputs);
  const snapshot = await bridge(page, "snapshot");
  const profile = snapshot.profiles.find(item => item.name === profileName);
  assert(profile, "Synthetic profile was not saved");
  return { profileId: profile.id, documents };
}

async function seedLegacyProfile(app, page, scratch, scenario) {
  const fixture = await seedProfileAndDocuments(app, page, scratch, scenario);
  const legacyEvent = await bridge(page, "calendarSave", {
    date: legacyDate, time: null, title: legacyTitle, notes: "Legacy day note", documentId: fixture.documents[0].id,
    reminderEnabled: true, reminderDaysBefore: 1, reminderTime: "09:00",
  });
  assert.equal(legacyEvent.date, legacyDate);
  assert.equal(legacyEvent.endDate, undefined);
  assert.equal(legacyEvent.documentIds, undefined);
  assert(Number.isSafeInteger(legacyEvent.alarmAt));
  return { ...fixture, legacyEvent };
}

async function requireExistingProfileAndDocuments(page, fixture) {
  const snapshot = await bridge(page, "snapshot");
  assert(snapshot.profiles.some(item => item.id === fixture.profileId && item.name === profileName),
    "Existing AI profile was not retained");
  for (const document of fixture.documents) {
    assert(snapshot.documents.some(item => item.id === document.id && item.name === document.name && item.hash === document.hash),
      "An existing vault document was not retained");
  }
}

async function requireLegacyProfileAndEvent(page, fixture) {
  await requireExistingProfileAndDocuments(page, fixture);
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

async function openDockedCalendar(page) {
  const button = page.getByRole("button", { name: "업무 캘린더", exact: true });
  if (!await button.isVisible()) await page.getByRole("button", { name: "업무 도구", exact: true }).click();
  await button.click();
  const pane = page.getByRole("complementary", { name: "업무 캘린더", exact: true });
  await pane.waitFor();
  assert.equal(await page.getByRole("dialog", { name: "업무 캘린더", exact: true }).count(), 0);
  return pane;
}

async function verifyCalendar(page, fixture, { openCalendar = openDockedCalendar, verifyCalendarEditor }) {
  assert.equal(await page.title(), "DocBogi");
  const brand = page.locator(".brand").first();
  await brand.locator("small").waitFor({ state: "visible" });
  assert.equal((await brand.textContent()).replace(/\s/g, ""), "DocBogi내문서작업공간");

  const calendar = await openCalendar(page);
  await calendar.getByRole("button", { name: "일정 추가", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await verifyCalendarEditor?.(page, calendar, editor);
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
  const listedEvent = calendar.getByRole("button", { name: new RegExp(rangeTitle) });
  await listedEvent.waitFor();
  if (verifyCalendarEditor) {
    await listedEvent.click();
    const existingEditor = page.getByRole("dialog", { name: "일정 편집", exact: true });
    await verifyCalendarEditor(page, calendar, existingEditor);
    assert.equal(await existingEditor.getByLabel("제목", { exact: true }).inputValue(), rangeTitle);
    await existingEditor.getByRole("button", { name: "닫기", exact: true }).click();
    await existingEditor.waitFor({ state: "hidden" });
  }

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

async function withOwnedUserData(userData, run) {
  await fs.mkdir(userData, { mode: 0o700 });
  const marker = path.join(userData, ".docbogi-release-smoke"), ownership = randomUUID();
  await fs.writeFile(marker, ownership, { flag: "wx", mode: 0o600 });
  try { return await run(); }
  finally {
    assert.equal(await fs.readFile(marker, "utf8"), ownership);
    if (!running(active?.child)) await fs.rm(userData, { recursive: true });
  }
}

async function verifyFreshInstall(electron, mounted, scratch, { targetVersion, verifyFresh }) {
  const scenario = path.join(scratch, "fresh-install"), applications = path.join(scenario, "Applications");
  await fs.mkdir(applications, { recursive: true });
  const installed = await installBundle(mounted, applications, targetVersion + " fresh");
  const userData = path.join(scenario, "data");
  await withOwnedUserData(userData, () => withApplication(electron, installed, {
    name: "DocBogi", version: targetVersion, userData, isolateData: true,
  }, targetVersion + " fresh real keychain", async (app, page) => {
    assert.equal(await page.title(), "DocBogi");
    const brand = page.locator(".brand").first();
    await brand.waitFor({ state: "visible" });
    assert.match(await brand.textContent(), /DocBogi/);
    const welcome = page.getByRole("dialog", { name: "DocBogi에 오신 것을 환영합니다", exact: true });
    await welcome.getByRole("button", { name: "보관함 위치 선택", exact: true }).waitFor({ state: "visible" });
    await welcome.getByRole("button", { name: "업무 캘린더 먼저 열기", exact: true }).waitFor({ state: "visible" });
    const snapshot = await bridge(page, "snapshot");
    assert.equal(snapshot.vault, null);
    assert.equal(snapshot.documents.length, 0);
    assert.equal(snapshot.profiles.length, 0);
    const view = await bridge(page, "calendarView", october);
    assert.deepEqual(view.events, []);
    await verifyFresh?.(app, page, scenario);
  }));
  log("passed " + targetVersion + " new installation with the real default keychain");
}

async function verifyUpgrade(electron, mountedBase, mountedCurrent, scratch, userData, mockKeychain, config) {
  const { baseVersion, targetVersion, seedBaseline, verifyMigrated } = config;
  const mode = mockKeychain ? "mock keychain" : "real keychain";
  const scenario = path.join(scratch, mockKeychain ? "upgrade-mock" : "upgrade-real");
  const applications = path.join(scenario, "Applications");
  await fs.mkdir(applications, { recursive: true });
  const options = { name: "DocBogi", userData, isolateData: mockKeychain, mockKeychain };
  await withOwnedUserData(userData, async () => {
    const installed = await installBundle(mountedBase, applications, baseVersion + " " + mode);
    const fixture = await withApplication(electron, installed, { ...options, version: baseVersion },
      baseVersion + " baseline " + mode, (app, page) => seedBaseline(app, page, scratch, scenario));
    const upgraded = await installBundle(mountedCurrent, applications, targetVersion + " " + mode, true);
    assert.equal(upgraded, installed);
    const current = { ...options, version: targetVersion };
    const saved = await withApplication(electron, installed, current, targetVersion + " upgrade " + mode, async (_app, page) => {
      await verifyMigrated(page, fixture);
      return verifyCalendar(page, fixture, config);
    });
    await withApplication(electron, installed, current, targetVersion + " restart " + mode, async (_app, page) => {
      await verifyMigrated(page, fixture);
      const view = await bridge(page, "calendarView", october);
      const event = view.events.find(item => item.id === saved.id);
      assert.deepEqual(event, saved, "The ranged event and linked documents must persist after restarting");
    });
  });
  log("passed " + baseVersion + " to " + targetVersion + " installed upgrade and restart with " + mode);
}

async function main(config) {
  const [baseArg, bundleArg, scratchArg, modulePath] = process.argv.slice(2);
  assert([baseArg, bundleArg, scratchArg, modulePath].every(arg => arg && path.isAbsolute(arg)));
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Release smoke requires a fresh hosted macOS profile");
  const scratch = await fs.realpath(scratchArg);
  const temp = await fs.realpath(process.env.RUNNER_TEMP);
  assert(scratch.startsWith(temp + path.sep));
  const base = await fs.realpath(baseArg), bundle = await fs.realpath(bundleArg);
  assert.equal(base, path.join(scratch, "base-mounted", "DocBogi.app"));
  assert.equal(bundle, path.join(scratch, "final-mounted", "DocBogi.app"));
  const { _electron } = require(modulePath);
  const home = await fs.realpath(os.homedir());
  const appData = path.join(home, "Library", "Application Support");
  await fs.mkdir(appData, { recursive: true });
  assert.equal(await fs.realpath(appData), appData);
  diagnostics = path.join(scratch, "diagnostics");
  await fs.mkdir(diagnostics, { recursive: true });

  // The fresh install runs before the baseline can create any DocBogi keychain access rule.
  await verifyFreshInstall(_electron, bundle, scratch, config);
  let upgrade = "real default keychain";
  let credentialWait;
  try {
    await verifyUpgrade(_electron, base, bundle, scratch, path.join(appData, "Docvia"), false, config);
  } catch (error) {
    if (!error.osCredentialConsent || running(active?.child)) throw error;
    credentialWait = { phase: error.credentialWaitPhase, stage: error.smokeStage };
    console.error("::warning::macOS credential wait during " + credentialWait.phase + " (" + credentialWait.stage +
      "). The synthetic storage migration will rerun with the mock keychain. OS credential consent remains a user action on an ad-hoc build.");
    await verifyUpgrade(_electron, base, bundle, scratch, path.join(scratch, "upgrade-mock", "data"), true, config);
    upgrade = "mock keychain after diagnosed OS credential wait";
  }
  await fs.writeFile(path.join(diagnostics, "result.json"), JSON.stringify({
    fresh: "real default keychain", upgrade, credentialWait,
  }, null, 2));
}

function runVerification(config) {
  const watchdog = setTimeout(() => {
    describeOwnedApp("420-second smoke watchdog expired");
    const child = active?.child;
    signalOwnedChild(child, "SIGTERM");
    setTimeout(() => {
      signalOwnedChild(child, "SIGKILL");
      process.exit(1);
    }, 2500);
  }, 420000);
  log("start hosted macOS acceptance");
  main(config).then(() => log("done hosted macOS acceptance"), error => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => {
    // Let a clean process exit normally. A leaked Playwright handle still has a deadline.
    watchdog.unref();
  });
}

module.exports = { bridge, importDocuments, prepareOfflineVault, requireExistingProfileAndDocuments,
  runVerification, seedProfileAndDocuments };

if (require.main === module) {
  runVerification({
    baseVersion: "1.1.3",
    targetVersion: "1.1.4",
    seedBaseline: seedLegacyProfile,
    verifyMigrated: requireLegacyProfileAndEvent,
  });
}
