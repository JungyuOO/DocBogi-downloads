const assert = require("node:assert/strict");
const { runVerification } = require("./verify_macos_candidate_114.cjs");
const { seedBaseline, verifyMigrated, verifyPdf } = require("./verify_macos_release_115.cjs");

const baseVersion = "1.1.5";

async function openCalendar(page) {
  const navigation = page.getByRole("navigation", { name: "문서함", exact: true });
  const entry = navigation.getByRole("button", { name: "업무 캘린더", exact: true });
  await entry.click();
  const calendar = page.getByRole("main", { name: "업무 캘린더", exact: true });
  await calendar.getByRole("heading", { level: 1, name: "업무 캘린더", exact: true }).waitFor();
  await calendar.getByRole("button", { name: /처리 현황/ }).waitFor();
  await navigation.waitFor({ state: "visible" });
  assert.equal(await entry.getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("main").count(), 1, "The calendar should be the active main workspace");
  assert.equal(await page.getByRole("complementary", { name: "업무 캘린더", exact: true }).count(), 0);
  const [navBounds, calendarBounds] = await Promise.all([navigation.boundingBox(), calendar.boundingBox()]);
  assert(navBounds && calendarBounds && calendarBounds.x >= navBounds.x + navBounds.width - 1,
    "The calendar workspace should start after the visible left navigation");
  return calendar;
}

async function verifyCalendarEditor(page, calendar, editor) {
  await editor.waitFor({ state: "visible" });
  const view = calendar.getByRole("region", { name: "업무 캘린더 보기", exact: true });
  await view.waitFor({ state: "visible" });
  await page.getByRole("navigation", { name: "문서함", exact: true }).waitFor({ state: "visible" });
  assert(await editor.evaluate(element => element.closest("main")?.id === "docvia-calendar" && !element.matches(":modal")),
    "The wide editor should be a non-modal dialog inside the calendar workspace");
  await editor.evaluate(async element => {
    const dock = element.closest(".calendar-editor-dock");
    // An open dialog is visible before the dock and drawer reach their final positions.
    await new Promise(resolve => requestAnimationFrame(resolve));
    const animations = [...element.getAnimations(), ...(dock?.getAnimations() ?? [])];
    await Promise.allSettled(animations.map(animation => animation.finished));
  });
  const [viewBounds, editorBounds, workspaceBounds] = await Promise.all([
    view.boundingBox(), editor.boundingBox(), calendar.boundingBox(),
  ]);
  assert(viewBounds && editorBounds && workspaceBounds &&
    editorBounds.x >= viewBounds.x + viewBounds.width - 1 &&
    Math.abs(editorBounds.x + editorBounds.width - workspaceBounds.x - workspaceBounds.width) <= 1,
    "The editor should occupy the right edge of the calendar workspace");
}

runVerification({
  baseVersion,
  targetVersion: "1.1.6",
  seedBaseline: (app, page, scratch, scenario) => seedBaseline(app, page, scratch, scenario, baseVersion),
  verifyMigrated,
  verifyFresh: verifyPdf,
  openCalendar,
  verifyCalendarEditor,
});
