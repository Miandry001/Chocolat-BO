import { fieldType } from "./fields.js";
import { OFFICIAL_PERFUME_VALUES } from "../../../shared/officialPerfumeValues.mjs";

const OFFICIAL_PERFUME_SET = new Set(OFFICIAL_PERFUME_VALUES);

const SORT_EXCLUDED_FIELDS = new Set([
  "MAJOR BRAND",
  "BRAND",
  "LIBELLE PRODUIT",
  "NEW NOM DE SPECIALITE",
]);

function compareByInitial(left, right) {
  const initialOrder = left[0].localeCompare(right[0], "fr");
  return initialOrder || left.localeCompare(right, "fr");
}

function compareSlashBlocks(left, right) {
  return compareByInitial(left.split("&")[0].trim(), right.split("&")[0].trim());
}

export function normalizeSeparators(value) {
  return value.replace(/\s*([/&])\s*/g, " $1 ").trim();
}

export function sortFreeText(value) {
  const slashBlocks = normalizeSeparators(value)
    .split(/\s*\/\s*/)
    .map((block) => block.trim())
    .filter(Boolean);

  return slashBlocks
    .sort(compareSlashBlocks)
    .map((block) => block
      .split(/\s*&\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
      .sort(compareByInitial)
      .join("&"))
    .join("/");
}

export function sortPerfume(value) {
  const trimmed = value.trim();
  const officialValue = trimmed.toUpperCase();
  if (OFFICIAL_PERFUME_SET.has(officialValue)) return officialValue;

  const normalized = normalizeSeparators(value);
  if (!/\bCHOCOLAT\b/i.test(normalized)) return sortFreeText(normalized);

  const withoutChocolate = normalized.replace(/\bCHOCOLAT\b/i, "");
  const sorted = sortFreeText(withoutChocolate).replace(/^[\s/&]+|[\s/&]+$/g, "");
  return sorted ? `CHOCOLAT ${sorted}` : "CHOCOLAT";
}

export function shouldSortFreeText(name, customFields = {}) {
  if (SORT_EXCLUDED_FIELDS.has(name.toUpperCase())) return false;
  return ["text", "textarea"].includes(fieldType(name)) || Boolean(customFields[name]);
}