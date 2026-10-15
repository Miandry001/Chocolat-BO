import ExcelJS from "exceljs";
import {
  buildSubmittedValueUpdates,
  sheetNameFromRange,
} from "./sheetExport.js";

const EXCEL_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function columnNumber(columnName) {
  return [...columnName].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function worksheetTitle(sourceRange) {
  return sheetNameFromRange(sourceRange).slice(1, -1).replace(/''/g, "'");
}

function compactWorksheet(workbook, sourceWorksheet, treatments) {
  const sourceTitle = sourceWorksheet.name;
  let temporaryTitle = "__export__";
  while (workbook.getWorksheet(temporaryTitle)) temporaryTitle = `_${temporaryTitle}`;

  const result = workbook.addWorksheet(temporaryTitle);
  sourceWorksheet.columns.forEach((sourceColumn, index) => {
    const targetColumn = result.getColumn(index + 1);
    targetColumn.width = sourceColumn.width;
    targetColumn.hidden = sourceColumn.hidden;
    targetColumn.outlineLevel = sourceColumn.outlineLevel;
    targetColumn.style = { ...sourceColumn.style };
  });

  const sourceRows = [...new Set([1, ...treatments.map(({ sourceRow }) => sourceRow)])].sort((a, b) => a - b);
  sourceRows.forEach((sourceRowNumber, index) => {
    const sourceRow = sourceWorksheet.getRow(sourceRowNumber);
    const targetRow = result.getRow(index + 1);
    targetRow.values = sourceRow.values;
    targetRow.height = sourceRow.height;
    targetRow.hidden = sourceRow.hidden;
    targetRow.outlineLevel = sourceRow.outlineLevel;
    sourceRow.eachCell({ includeEmpty: true }, (sourceCell, columnNumber) => {
      result.getRow(index + 1).getCell(columnNumber).style = { ...sourceCell.style };
    });
  });

  for (const sheet of [...workbook.worksheets]) {
    if (sheet.id !== result.id) workbook.removeWorksheet(sheet.id);
  }
  result.name = sourceTitle;
}

export async function buildFilledExcelWorkbook(sourceWorkbook, sourceRows, treatments, sourceRange) {
  const updates = buildSubmittedValueUpdates(sourceRows, treatments, sourceRange);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(sourceWorkbook);

  const worksheet = workbook.getWorksheet(worksheetTitle(sourceRange));
  if (!worksheet) throw new Error(`L’onglet « ${worksheetTitle(sourceRange)} » est absent du classeur Excel.`);

  for (const update of updates) {
    const match = update.range.match(/!([A-Z]+)(\d+)$/);
    if (!match) throw new Error(`Plage de cellule invalide pour l’export : ${update.range}.`);
    worksheet.getCell(Number(match[2]), columnNumber(match[1])).value = update.values[0][0];
  }

  compactWorksheet(workbook, worksheet, treatments);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export { EXCEL_MIME_TYPE };
