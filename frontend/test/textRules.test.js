import test from "node:test";
import assert from "node:assert/strict";
import { shouldSortFreeText, sortFreeText, sortPerfume } from "../src/data/textRules.js";
import { OFFICIAL_PERFUME_VALUES } from "../../shared/officialPerfumeValues.mjs";

test("sortFreeText joins sorted terms without spaces around separators", () => {
  assert.equal(sortFreeText("NOIX & AMANDE / BLANC"), "BLANC/AMANDE&NOIX");
});

test("sortPerfume sorts the supplied example without separator spaces", () => {
  assert.equal(
    sortPerfume("CHOCOLAT BLANC / AMANDE & NOIX"),
    "CHOCOLAT AMANDE&NOIX/BLANC",
  );
});

test("official perfume values bypass sorting and preserve their spacing", () => {
  for (const value of OFFICIAL_PERFUME_VALUES) {
    assert.equal(sortPerfume(value), value);
  }
  assert.equal(sortPerfume("chocolat blanc/lait /noir"), "CHOCOLAT BLANC/LAIT /NOIR");
});

test("custom Additifs values remain alphabetically sorted", () => {
  assert.equal(shouldSortFreeText("Additifs", { Additifs: true }), true);
  assert.equal(
    sortFreeText("AMANDE CARAMELISEE/ ECORCE D'ORANGE CONFITE/RAISIN SEC"),
    "AMANDE CARAMELISEE/ECORCE D'ORANGE CONFITE/RAISIN SEC",
  );
  assert.equal(sortFreeText("ECLATS D'AMANDE & POINE DE SEL"), "ECLATS D'AMANDE&POINE DE SEL");
});