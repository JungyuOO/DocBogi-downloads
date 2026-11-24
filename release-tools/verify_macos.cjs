const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const [executablePath, scratch, playwrightModule] = process.argv.slice(2);
assert([executablePath, scratch, playwrightModule].every(value => value && path.isAbsolute(value)));
const { _electron } = require(playwrightModule);

async function verify() {
  const data = path.join(scratch, "qa-data");
  const vault = path.join(scratch, "qa-vault");
  const fixtures = [1, 2, 3].map(n => path.join(scratch, "fixtures", "layout-fixture-" + n + ".docx"));
  await fs.mkdir(vault);
  const env = { ...process.env, DOCVIA_DATA_DIR: data };
  for (const key of Object.keys(env)) {
    if (/^(DOCVIA_(?!DATA_DIR$)|CODEX_|OPENAI_|ANTHROPIC_|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)/i.test(key)) {
      delete env[key];
    }
  }

  const app = await _electron.launch({ executablePath, env, viewport: null, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await page.waitForFunction(() => !!window.docvia);
    const runtime = await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      appData: app.getPath("userData"),
    }));
    assert.equal(runtime.version, "1.0.9");
    assert.equal(runtime.packaged, true);
    assert.equal(await fs.realpath(runtime.appData), await fs.realpath(data));

    const bridge = (method, ...args) =>
      page.evaluate(({ method, args }) => window.docvia[method](...args), { method, args });
    assert.equal((await bridge("snapshot")).documents.length, 0);
    await bridge("chooseVault", vault);
    await bridge("setAutoAnalyze", false);
    await bridge("setAutoPlace", false);
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, fixtures);
    const results = await bridge("importDialog", null);
    assert.equal(results.length, 3);
    assert(results.every(result => result.document && !result.error && !result.duplicate));
    await page.waitForFunction(async () => {
      const snapshot = await window.docvia.snapshot();
      return !snapshot.jobs?.some(job => job.state === "queued" || job.state === "running");
    }, undefined, { timeout: 60000 });
    await page.reload();
    for (const file of fixtures) {
      await page.getByText(path.basename(file), { exact: true }).first().waitFor();
    }
    assert.equal((await bridge("snapshot")).documents.length, 3);

    const selectAll = page.getByRole("checkbox", { name: /현재 필터 결과 .* 전체 선택/ });
    await selectAll.check();
    assert(await page.locator(".selection-toolbar").isVisible());
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      window.setMinimumSize(420, 450);
      window.setContentSize(1280, 720);
      window.webContents.setBackgroundThrottling(false);
      window.webContents.setZoomFactor(1.5);
    });
    const targetViewport = { width: 853, height: 480 };
    const matchesTargetViewport = ({ width, height }) =>
      Math.abs(innerWidth - width) <= 6 && Math.abs(innerHeight - height) <= 6;
    await page.waitForTimeout(1000);
    const nativeViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const nativeWindow = await app.evaluate(({ BrowserWindow, screen }) => {
      const [window] = BrowserWindow.getAllWindows();
      const display = screen.getDisplayMatching(window.getBounds());
      return {
        contentBounds: window.getContentBounds(),
        screen: display.size,
        workArea: display.workAreaSize,
        zoom: window.webContents.getZoomFactor(),
      };
    });
    console.log("Native macOS viewport attempt", JSON.stringify({ ...nativeViewport, ...nativeWindow }));

    let viewportMode = "native macOS viewport";
    if (Math.abs(nativeViewport.width - targetViewport.width) > 6 ||
        Math.abs(nativeViewport.height - targetViewport.height) > 6) {
      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        window.webContents.setZoomFactor(1);
      });
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setDeviceMetricsOverride", {
        ...targetViewport,
        deviceScaleFactor: 1,
        mobile: false,
      });
      viewportMode = "emulated CSS viewport";
    }
    await page.waitForFunction(matchesTargetViewport, targetViewport);
    await page.waitForFunction(() =>
      !document.querySelector(".detail-shell.is-overlay.is-open, .detail-backdrop.is-open, .sidebar.is-open"));
    const list = page.locator(".explorer-content");
    const metrics = await list.evaluate(element => ({
      width: innerWidth,
      height: innerHeight,
      listHeight: element.getBoundingClientRect().height,
    }));
    assert(metrics.listHeight >= 80, JSON.stringify(metrics));
    const row = page.getByText(path.basename(fixtures[0]), { exact: true }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click({ trial: true });
    await page.locator(".selection-toolbar button.primary").click({ trial: true });
    console.log("Mounted macOS app verified", JSON.stringify({
      version: runtime.version,
      documents: 3,
      viewportMode,
      ...metrics,
    }));
  } finally {
    await app.close();
  }
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
