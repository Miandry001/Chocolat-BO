import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSubmittedValueUpdates,
  getUnselectedRowRanges,
} from "./sheetExport.js";

test("export updates submitted cells at their source row and preserves all other cells", () => {
  const rows = [
    ["NOM", "EAN13", "KEYCAT"],
    ["", "1234567890123", "original"],
    ["", "9876543210123", "another"],
  ];
  const updates = buildSubmittedValueUpdates(rows, [{
    sourceRow: 3,
    currentData: [{ k: "NOM", v: "CHOCOLAT" }, { k: "EAN13", v: "" }],
    agentName: "Jean Dupont",
    treatmentDate: "2026-10-06T07:15:00.000Z",
  }], "'référent'!A:ZZ");

  assert.deepEqual(updates, [
    { range: "'référent'!D1", values: [["NUMERO DE LIGNE SOURCE"]] },
    { range: "'référent'!E1", values: [["DATE DE TRAITEMENT"]] },
    { range: "'référent'!B3", values: [[""]] },
    { range: "'référent'!A3", values: [["Jean Dupont"]] },
    { range: "'référent'!D3", values: [[3]] },
    { range: "'référent'!E3", values: [["2026-10-06T07:15:00.000Z"]] },
  ]);
  assert.equal(rows[2][0], "");
  assert.equal(rows[2][2], "another");
});

test("export rejects submitted fields that do not exist in the source headers", () => {
  assert.throws(
    () => buildSubmittedValueUpdates([["NOM"], [""]], [{
      sourceRow: 2,
      currentData: [{ k: "UNKNOWN", v: "value" }],
    }], "Sheet1!A:ZZ"),
    /n’existe pas dans le fichier source/,
  );
});

test("export appends the Label field to the copied sheet and omits the workflow-only scope field", () => {
  const rows = [
    ["NOM", "EAN13"],
    ["", "1234567890123"],
  ];
  const updates = buildSubmittedValueUpdates(rows, [{
    sourceRow: 2,
    currentData: [
      { k: "NOM", v: "CHOCOLAT" },
      { k: "Label", v: "BIO EQUITABLE" },
      { k: "Dans le scope ?", v: "OUI" },
    ],
  }], "'référent'!A:ZZ");

  assert.deepEqual(updates, [
    { range: "'référent'!C1", values: [["Label"]] },
    { range: "'référent'!D1", values: [["NUMERO DE LIGNE SOURCE"]] },
    { range: "'référent'!E1", values: [["DATE DE TRAITEMENT"]] },
    { range: "'référent'!A2", values: [["CHOCOLAT"]] },
    { range: "'référent'!C2", values: [["BIO EQUITABLE"]] },
    { range: "'référent'!A2", values: [[""]] },
    { range: "'référent'!D2", values: [[2]] },
    { range: "'référent'!E2", values: [[""]] },
  ]);
  assert.deepEqual(rows[0], ["NOM", "EAN13"]);
});

test("filtered export identifies omitted source rows", () => {
  const rows = [["NOM"], ["un",], ["deux"], ["trois"], ["quatre"], ["cinq"]];
  const filteredTreatments = [2, 4, 5].map((sourceRow) => ({ sourceRow }));

  assert.deepEqual(getUnselectedRowRanges(rows, filteredTreatments), [
    { startRow: 6, count: 1 },
    { startRow: 3, count: 1 },
  ]);
});
