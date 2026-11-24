const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const run = promisify(execFile);
const execute = (file, args, options = {}) => run(file, args, { timeout: 20000, maxBuffer: 1024 * 1024, ...options });
const launcher = "/bin/launchctl";
const now = () => Date.now();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(DOCVIA_|GH_TOKEN$|GITHUB_TOKEN$|CODEX_|OPENAI_|ANTHROPIC_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
}
function bundleExecutable(bundle) { return path.join(bundle, "Contents", "MacOS", "Docvia"); }
async function requireAbsent(target) {
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
}
async function appVersion(app) {
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(), packaged: app.isPackaged,
    userData: app.getPath("userData"), appPath: app.getAppPath(),
  }));
  assert.equal(runtime.version, "1.1.1");
  assert.equal(runtime.packaged, true);
  return runtime;
}
async function bridge(page, method, ...args) {
  return page.evaluate(({ method, args }) => window.docvia[method](...args), { method, args });
}

async function verifyMountedApp(electron, bundle, scratch) {
  const data = path.join(scratch, "mounted-data");
  await fs.mkdir(data);
  const app = await electron.launch({ executablePath: bundleExecutable(bundle),
    env: { ...cleanEnvironment(), DOCVIA_DATA_DIR: data }, viewport: null, timeout: 60000 });
  try {
    const runtime = await appVersion(app);
    assert.equal(await fs.realpath(runtime.userData), data);
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.docvia);
    assert.equal((await bridge(page, "snapshot")).documents.length, 0);
    const reminders = await bridge(page, "reminderView");
    assert.equal(reminders.native.supported, false);
  } finally {
    await app.close();
  }
  console.log("Mounted Universal 1.1.1 application opened against an isolated preview profile.");
}

async function printAgent(service) {
  try { return (await execute(launcher, ["print", service])).stdout; }
  catch (error) {
    if ([3, 113].includes(Number(error.code))) return null;
    throw error;
  }
}

function hasPlistPath(job, plist) {
  return job.split(/\r?\n/).some(line => line.trim() === "path = " + plist);
}

function readReceipts(database, id) {
  const storage = new DatabaseSync(database, { readOnly: true });
  try {
    return storage.prepare("SELECT state,data FROM reminder_receipts WHERE reminder_id=? ORDER BY observed_at").all(id);
  } finally {
    storage.close();
  }
}

async function waitForScheduledReceipt(database, id, dueAt) {
  const end = dueAt + 135000;
  while (now() < end) {
    const rows = readReceipts(database, id);
    assert(rows.length <= 1, "Native wake delivered multiple receipts for one appointment");
    if (rows[0] && rows[0].state !== "pending") {
      const { observedAt, dueAt: recordedDueAt } = JSON.parse(rows[0].data);
      assert.equal(recordedDueAt, dueAt);
      assert(observedAt >= dueAt && observedAt <= end, "Receipt is outside the scheduled wake window");
      assert(["shown", "blocked"].includes(rows[0].state), "A missed receipt does not demonstrate OS delivery");
      // The scheduler should not reissue this occurrence after the process observes it.
      await sleep(1800);
      assert.equal(readReceipts(database, id).length, 1);
      return rows[0].state;
    }
    await sleep(1200);
  }
  throw new Error("No native launchd delivery receipt arrived while Docvia was closed");
}

async function stopOwnedWake(executable, argument) {
  const result = await execute("/bin/ps", ["-ax", "-o", "pid=,command="]);
  const expected = executable + " " + argument;
  const owned = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    if (match[2] === expected || (match[2].startsWith(expected + " -psn_") && !match[2].includes("--type="))) {
      const pid = Number(match[1]);
      try { process.kill(pid, "SIGTERM"); owned.push(pid); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  for (let attempt = 0; attempt < 20 && owned.length; attempt++) {
    await sleep(250);
    for (let index = owned.length - 1; index >= 0; index--) {
      try { process.kill(owned[index], 0); }
      catch (error) {
        if (error.code !== "ESRCH") throw error;
        owned.splice(index, 1);
      }
    }
  }
  assert.equal(owned.length, 0, "Verifier-owned wake process did not exit");
}

async function verifyNativeWake(electron, mountedBundle, scratch) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Native installer verification requires a new hosted macOS user session");
  assert.equal(typeof process.getuid, "function");
  const home = await fs.realpath(os.homedir());
  const data = path.join(home, "Library", "Application Support", "Docvia");
  const installed = path.join(home, "Applications", "Docvia.app");
  const executable = bundleExecutable(installed);
  const uid = process.getuid();
  const profileId = createHash("sha256").update(data.normalize("NFC").toLowerCase()).digest("hex").slice(0, 32);
  const arg = "--docvia-reminder-wake=" + profileId;
  const label = "com.docvia.reminder." + profileId;
  const service = "gui/" + uid + "/" + label;
  const plist = path.join(home, "Library", "LaunchAgents", label + ".plist");
  const marker = path.join(data, ".docvia-ci-reminder-owned");
  const owned = randomUUID();
  await requireAbsent(data);
  await requireAbsent(installed);
  await requireAbsent(plist);
  assert.equal(await printAgent(service), null);

  let app;
  let installedByVerifier = false;
  let verifiedProfile = false;
  let intendedRegistration = false;
  try {
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.mkdir(installed);
    installedByVerifier = true;
    await execute("/usr/bin/ditto", [mountedBundle, installed], { timeout: 90000 });

    const env = cleanEnvironment();
    assert(!env.DOCVIA_DATA_DIR);
    app = await electron.launch({ executablePath: executable, env, viewport: null, timeout: 60000 });
    const runtime = await appVersion(app);
    assert.equal(await fs.realpath(runtime.userData), data);
    assert.equal(await fs.realpath(runtime.appPath), path.join(installed, "Contents", "Resources", "app"));
    await fs.writeFile(marker, owned, { flag: "wx", mode: 0o600 });
    verifiedProfile = true;
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => !!window.docvia);

    const view = await bridge(page, "reminderView");
    assert.deepEqual({ enabled: view.native.enabled, supported: view.native.supported, platform: view.native.platform },
      { enabled: false, supported: true, platform: "darwin" });
    assert.equal((await bridge(page, "snapshot")).documents.length, 0);
    const vault = path.join(scratch, "reminder-vault");
    await fs.mkdir(vault);
    await bridge(page, "chooseVault", vault);
    await bridge(page, "setAutoAnalyze", false);
    await bridge(page, "setAutoPlace", false);
    const input = path.join(scratch, "fixtures", "layout-fixture-1.docx");
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, input);
    const results = await bridge(page, "importDialog", null);
    assert.equal(results.length, 1);
    assert(results[0].document && !results[0].error);
    await page.waitForFunction(async () => {
      const snapshot = await window.docvia.snapshot();
      return !snapshot.jobs?.some(job => job.state === "queued" || job.state === "running");
    }, undefined, { timeout: 60000 });
    const doc = results[0].document;
    const row = await bridge(page, "ledgerEnsureRow", { ledgerId: "maintenance-contracts", documentId: doc.id });

    const dueAt = Math.ceil((now() + 65000) / 60000) * 60000;
    const when = new Date(dueAt).toISOString();
    await bridge(page, "ledgerSaveEntry", {
      rowId: row.id, columnId: "expires", revision: row.revision,
      change: { mode: "confirmed", value: when.slice(0, 10) },
    });
    const reminder = await bridge(page, "reminderSave", {
      rowId: row.id, expiryColumnId: "expires", deadline: { kind: "expiry" },
      reminderDaysBefore: 0, localTime: when.slice(11, 16), timeZone: "UTC",
    });
    assert.equal(reminder.dueAt, dueAt);
    intendedRegistration = true;
    const native = await bridge(page, "reminderSetNative", true);
    assert.equal(native.enabled, true);
    assert.equal(native.error, null);
    assert.equal(native.nextWakeAt, dueAt);
    const job = await printAgent(service);
    assert(job && hasPlistPath(job, plist), "The expected LaunchAgent is not loaded");
    const { stdout: argumentsXml } = await execute("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist]);
    assert.deepEqual(JSON.parse(argumentsXml), ["/usr/bin/open", "-g", "-n", "-a", installed, "--args", arg]);
    const database = path.join(data, "docvia.sqlite");
    assert.deepEqual(readReceipts(database, reminder.id), []);
    const pid = app.process().pid;
    assert(Number.isInteger(pid));
    await app.close();
    app = undefined;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert(now() < dueAt, "The UI app was not closed before the scheduled wake");
    console.log("Closed the interactive instance before the loaded LaunchAgent's scheduled minute.");
    const result = await waitForScheduledReceipt(database, reminder.id, dueAt);
    console.log(result === "shown" ?
      "Closed-app launchd wake and one native show receipt verified. No click or visual inspection was simulated." :
      "Closed-app launchd wake and one blocked delivery receipt verified. Native banner display was unavailable or unconfirmed.");
  } finally {
    if (app) await app.close().catch(() => {});
    if (intendedRegistration) {
      const record = await printAgent(service);
      if (record) {
        assert(hasPlistPath(record, plist), "Verifier refuses to stop an unowned LaunchAgent");
        await execute(launcher, ["bootout", service]);
      }
      const file = await fs.readFile(plist, "utf8").catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (file) {
        assert(file.includes("<string>" + label + "</string>") && file.includes("<string>" + arg + "</string>"));
        await fs.unlink(plist);
      }
      await stopOwnedWake(executable, arg);
    }
    if (verifiedProfile) {
      assert.equal(await fs.readFile(marker, "utf8"), owned);
      await fs.rm(data, { recursive: true });
    }
    if (installedByVerifier) await fs.rm(installed, { recursive: true });
  }
}

async function main() {
  const [bundleArg, scratchArg, modulePath] = process.argv.slice(2);
  assert([bundleArg, scratchArg, modulePath].every(arg => arg && path.isAbsolute(arg)));
  const bundle = await fs.realpath(bundleArg);
  const scratch = await fs.realpath(scratchArg);
  const temp = await fs.realpath(process.env.RUNNER_TEMP);
  assert(scratch.startsWith(temp + path.sep));
  assert.equal(bundle, path.join(scratch, "final-mounted", "Docvia.app"));
  const { _electron } = require(modulePath);
  await verifyMountedApp(_electron, bundle, scratch);
  await verifyNativeWake(_electron, bundle, scratch);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
