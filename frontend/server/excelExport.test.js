import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildFilledExcelWorkbook } from "./excelExport.js";

test("Excel export keeps only selected treatment rows and removes unrelated worksheets", async () => {
  const sourceWorkbook = new ExcelJS.Workbook();
  const targetSheet = sourceWorkbook.addWorksheet("référent");
  targetSheet.addRow(["NOM", "EAN13"]);
  targetSheet.addRow(["", "1234567890123"]);
  targetSheet.getCell("A1").font = { bold: true };
  sourceWorkbook.addWorksheet("Autre onglet").getCell("A1").value = "préservé";
  const sourceBuffer = Buffer.from(await sourceWorkbook.xlsx.writeBuffer());

  const result = await buildFilledExcelWorkbook(sourceBuffer, [
    ["NOM", "EAN13"],
    ["", "1234567890123"],
  ], [{
    sourceRow: 2,
    currentData: [
      { k: "NOM", v: "CHOCOLAT" },
      { k: "Label", v: "BIO EQUITABLE" },
      { k: "Dans le scope ?", v: "OUI" },
    ],
    agentName: "Jean Dupont",
    treatmentDate: "2026-10-06T07:15:00.000Z",
  }], "'référent'!A:ZZ");

  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(result);
  assert.equal(exported.getWorksheet("référent").getCell("A2").value, "Jean Dupont");
  assert.equal(exported.getWorksheet("référent").getCell("B2").value, "1234567890123");
  assert.equal(exported.getWorksheet("référent").getCell("C1").value, "Label");
  assert.equal(exported.getWorksheet("référent").getCell("C2").value, "BIO EQUITABLE");
  assert.equal(exported.getWorksheet("référent").getCell("D1").value, "NUMERO DE LIGNE SOURCE");
  assert.equal(exported.getWorksheet("référent").getCell("D2").value, 2);
  assert.equal(exported.getWorksheet("référent").getCell("E1").value, "DATE DE TRAITEMENT");
  assert.equal(exported.getWorksheet("référent").getCell("E2").value, "2026-10-06T07:15:00.000Z");
  assert.equal(exported.getWorksheet("référent").getCell("A1").font.bold, true);
  assert.equal(exported.getWorksheet("Autre onglet"), undefined);
  assert.equal(exported.getWorksheet("référent").rowCount, 2);
});

test("export contains only the selected rows even when they are all eligible submissions", async () => {
  const sourceWorkbook = new ExcelJS.Workbook();
  const targetSheet = sourceWorkbook.addWorksheet("référent");
  const sourceRows = [["NOM", "EAN13"]];
  for (let sourceRow = 2; sourceRow <= 5_709; sourceRow += 1) {
    sourceRows.push(["", `EAN-${sourceRow}`]);
  }
  targetSheet.addRows(sourceRows);
  sourceWorkbook.addWorksheet("Autre onglet").getCell("A1").value = "hors filtre";

  const result = await buildFilledExcelWorkbook(Buffer.from(await sourceWorkbook.xlsx.writeBuffer()), [
    ...sourceRows,
  ], [
    {
      sourceRow: 12,
      currentData: [{ k: "NOM", v: "CHOCOLAT FILTRÉ 1" }],
      agentName: "Jean Dupont",
      treatmentDate: "2026-10-06T07:15:00.000Z",
    },
    {
      sourceRow: 5_709,
      currentData: [{ k: "NOM", v: "CHOCOLAT FILTRÉ 2" }],
      agentName: "Marie Martin",
      treatmentDate: "2026-10-06T07:15:00.000Z",
    },
  ], "'référent'!A:ZZ");

  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(result);
  const worksheet = exported.getWorksheet("référent");
  assert.equal(worksheet.rowCount, 3);
  assert.deepEqual(worksheet.getSheetValues().slice(1).map((row) => row.slice(1)), [
    ["NOM", "EAN13", "NUMERO DE LIGNE SOURCE", "DATE DE TRAITEMENT"],
    ["Jean Dupont", "EAN-12", 12, "2026-10-06T07:15:00.000Z"],
    ["Marie Martin", "EAN-5709", 5_709, "2026-10-06T07:15:00.000Z"],
  ]);
  assert.equal(exported.getWorksheet("Autre onglet"), undefined);
});
