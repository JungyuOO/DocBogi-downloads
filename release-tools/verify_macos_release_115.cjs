const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  bridge, importDocuments, prepareOfflineVault, requireExistingProfileAndDocuments,
  runVerification, seedProfileAndDocuments,
} = require("./verify_macos_candidate_114.cjs");

const pdfText = "DocBogi installed PDF smoke fixture";
const baselineDate = "2028-06-12";
const baselineEnd = "2028-06-14";

function fixturePdf() {
  const text = `BT /F1 16 Tf 48 340 Td (${pdfText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  const entries = offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return pdf + `xref\n0 6\n0000000000 65535 f \n${entries}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

async function verifyPdf(app, page, scenario) {
  const file = path.join(scenario, "installed-pdf-smoke.pdf");
  await fs.writeFile(file, fixturePdf(), { flag: "wx" });
  await prepareOfflineVault(page, scenario);
  const [document] = await importDocuments(app, page, [file]);
  assert.equal(document.name, path.basename(file));

  // Refresh the renderer snapshot after setting up the synthetic vault through the bridge.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "문서 작업실", exact: true }).click();
  await page.getByRole("combobox", { name: "작업실 문서", exact: true }).click();
  await page.getByRole("option", { name: document.name, exact: true }).click();
  const pdf = page.getByRole("region", { name: "PDF 페이지 작업실", exact: true });
  const image = pdf.getByRole("img", { name: "PDF 원본 페이지 1", exact: true });
  await image.waitFor();
  const rendered = await image.evaluate(async element => {
    await element.decode();
    return element.naturalWidth > 0 && element.naturalHeight > 0;
  });
  assert(rendered, "The original PDF page did not render");
  await pdf.getByText("질문할 추출 본문 확인", { exact: true }).click();
  await pdf.getByText(pdfText, { exact: true }).waitFor();
  console.log("[mac-smoke] passed PDF import, original-page rendering and text extraction");
}

async function seedBaseline(app, page, scratch, scenario) {
  const fixture = await seedProfileAndDocuments(app, page, scratch, scenario);
  const documentIds = fixture.documents.map(document => document.id);
  const baselineEvent = await bridge(page, "calendarSave", {
    date: baselineDate, endDate: baselineEnd, time: null, title: "Existing multi-day calendar event",
    notes: "Saved by 1.1.4 before the installed upgrade", documentIds,
    reminderEnabled: true, reminderAnchor: "end", reminderDaysBefore: 1, reminderTime: "09:00",
  });
  assert.equal(baselineEvent.date, baselineDate);
  assert.equal(baselineEvent.endDate, baselineEnd);
  assert.equal(baselineEvent.documentId, documentIds[0]);
  assert.deepEqual(baselineEvent.documentIds, documentIds);
  assert.equal(baselineEvent.reminderAnchor, "end");
  assert(Number.isSafeInteger(baselineEvent.alarmAt));
  return { ...fixture, baselineEvent };
}

async function verifyMigrated(page, fixture) {
  await requireExistingProfileAndDocuments(page, fixture);
  const event = await bridge(page, "calendarEvent", fixture.baselineEvent.id);
  assert.deepEqual(event, fixture.baselineEvent, "The 1.1.4 event, document links and reminder must survive the upgrade");
  const day = await bridge(page, "calendarView", { start: baselineEnd, end: baselineEnd });
  assert(day.events.some(item => item.id === event.id), "The migrated event must remain visible on its end date");
}

runVerification({
  baseVersion: "1.1.4",
  targetVersion: "1.1.5",
  seedBaseline,
  verifyMigrated,
  verifyFresh: verifyPdf,
});
