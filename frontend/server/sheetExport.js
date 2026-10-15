export function sheetNameFromRange(value) {
  const separator = value.lastIndexOf("!");
  if (separator < 1) throw new Error("La plage Google Sheets doit préciser un onglet.");
  const name = value.slice(0, separator).replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
  return `'${name.replace(/'/g, "''")}'`;
}

function columnName(index) {
  let number = index + 1;
  let name = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

export function buildSubmittedValueUpdates(rows, treatments, sourceRange) {
  const headers = rows[0] ?? [];
  if (!headers.length) throw new Error("Le fichier Google Sheets ne contient pas d’en-têtes.");

  const originalHeaderCount = headers.length;
  const columns = new Map(headers.map((header, index) => [header, index]));
  const updates = [];
  const seenRows = new Set();
  const targetSheet = sheetNameFromRange(sourceRange);
  const nonExportedFields = new Set(["Dans le scope ?"]);
  const appendableFields = new Set(["Label", "NUMERO DE LIGNE SOURCE", "DATE DE TRAITEMENT"]);
  const missingFields = new Set();

  for (const treatment of treatments) {
    if (!Array.isArray(treatment.currentData)) continue;
    for (const entry of treatment.currentData) {
      if (nonExportedFields.has(entry.k) || columns.has(entry.k)) continue;
      if (!appendableFields.has(entry.k)) {
        throw new Error(`La colonne « ${entry.k} » n’existe pas dans le fichier source.`);
      }
      missingFields.add(entry.k);
    }
  }
  for (const field of appendableFields) {
    if (field !== "Label" || treatments.some(({ currentData }) => currentData?.some(({ k }) => k === field))) {
      if (!columns.has(field)) missingFields.add(field);
    }
  }

  for (const field of missingFields) {
    const column = originalHeaderCount + [...missingFields].indexOf(field);
    columns.set(field, column);
    updates.push({
      range: `${targetSheet}!${columnName(column)}1`,
      values: [[field]],
    });
  }

  for (const treatment of treatments) {
    const { sourceRow } = treatment;
    if (!Number.isInteger(sourceRow) || sourceRow < 2 || sourceRow - 1 >= rows.length || seenRows.has(sourceRow)) {
      throw new Error(`Numéro de ligne de saisie invalide ou absent du fichier source : ${sourceRow}.`);
    }
    if (!Array.isArray(treatment.currentData)) throw new Error(`Les données de saisie de la ligne ${sourceRow} sont invalides.`);
    seenRows.add(sourceRow);
    for (const entry of treatment.currentData) {
      if (nonExportedFields.has(entry.k)) continue;
      if (entry.k === "NOM" && treatment.agentName) continue;
      const column = columns.get(entry.k);
      if (column == null) throw new Error(`La colonne « ${entry.k} » n’existe pas dans le fichier source.`);
      updates.push({
        range: `${targetSheet}!${columnName(column)}${sourceRow}`,
        values: [[entry.v ?? ""]],
      });
    }
    const agentColumn = columns.get("NOM");
    if (agentColumn == null) throw new Error("La colonne « NOM » n’existe pas dans le fichier source.");
    updates.push({
      range: `${targetSheet}!${columnName(agentColumn)}${sourceRow}`,
      values: [[treatment.agentName ?? ""]],
    });
    updates.push({
      range: `${targetSheet}!${columnName(columns.get("NUMERO DE LIGNE SOURCE"))}${sourceRow}`,
      values: [[sourceRow]],
    });
    updates.push({
      range: `${targetSheet}!${columnName(columns.get("DATE DE TRAITEMENT"))}${sourceRow}`,
      values: [[treatment.treatmentDate ? new Date(treatment.treatmentDate).toISOString() : ""]],
    });
  }

  return updates;
}

export function getUnselectedRowRanges(rows, treatments) {
  const selectedRows = new Set(treatments.map(({ sourceRow }) => sourceRow));
  const ranges = [];
  let rangeStart = null;

  for (let sourceRow = 2; sourceRow <= rows.length; sourceRow += 1) {
    if (selectedRows.has(sourceRow)) {
      if (rangeStart != null) {
        ranges.push({ startRow: rangeStart, count: sourceRow - rangeStart });
        rangeStart = null;
      }
    } else if (rangeStart == null) {
      rangeStart = sourceRow;
    }
  }
  if (rangeStart != null) {
    ranges.push({ startRow: rangeStart, count: rows.length - rangeStart + 1 });
  }

  return ranges.reverse();
}
