import test from "node:test";
import assert from "node:assert/strict";
import { formatValue, validate, getRules, validateAll, requiresPluralVerification, hasPluralWord, DEFAULT_RULES, FIELD_RULES } from "../src/data/rules.js";
import { fieldType, getFieldOptions, FIELDS, SEASONS, PRODUCT_TYPES, CONFISERY_TYPES, OTHER_OPTION, emptyValues, SCOPE_FIELD, fieldId } from "../src/data/fields.js";
import { ALL_SUGGESTION_DICTIONARIES } from "../src/data/suggestionDictionaries.js";
import { sortFreeText, sortPerfume, normalizeSeparators, shouldSortFreeText } from "../src/data/textRules.js";

const EMPTY = {};

test("formatValue uppercases and strips accents and converts œ/æ", () => {
  assert.equal(formatValue("café"), "CAFE");
  assert.equal(formatValue("œuvre"), "OEUVRE");
  assert.equal(formatValue("blanc"), "BLANC");
});

test("formatValue preserves spaces but uppercases and strips accents", () => {
  assert.equal(formatValue("chocolat"), "CHOCOLAT");
  assert.equal(formatValue("  espace  "), "  ESPACE  ");
});

test("formatValue handles empty strings", () => {
  assert.equal(formatValue(""), "");
});

test("DEFAULT_RULES has correct structure for each field type", () => {
  assert.deepEqual(DEFAULT_RULES.text, { required: true, maxLength: 255 });
  assert.deepEqual(DEFAULT_RULES.textarea, { required: true, maxLength: 2000 });
  assert.deepEqual(DEFAULT_RULES.number, { required: true, maxLength: 20, number: true, min: 0 });
  assert.deepEqual(DEFAULT_RULES.yesno, { required: true, oneOf: ["OUI", "NON"] });
  assert.deepEqual(DEFAULT_RULES.select, { required: true });
});

test("FIELD_RULES has field-specific overrides", () => {
  assert.deepEqual(FIELD_RULES["Onces Totales"], { unitSuffix: true });
  assert.deepEqual(FIELD_RULES["Compte Total"], { integer: true });
  assert.deepEqual(FIELD_RULES.Bonus2, { required: false });
  assert.deepEqual(FIELD_RULES.Bonus3, { required: false });
  assert.deepEqual(FIELD_RULES.Bonus4, { required: false });
});

test("getRules merges default and field-specific rules for text field", () => {
  const rules = getRules("EAN13", EMPTY);
  assert.equal(rules.required, true);
  assert.equal(rules.maxLength, 255);
  assert.equal(rules.number, undefined);
});

test("getRules marks Bonus fields as not required", () => {
  const bonus2 = getRules("Bonus2", EMPTY);
  assert.equal(bonus2.required, false);
  const bonus3 = getRules("Bonus3", EMPTY);
  assert.equal(bonus3.required, false);
  const bonus4 = getRules("Bonus4", EMPTY);
  assert.equal(bonus4.required, false);
});

test("getRules adds integer to Compte Total", () => {
  const rules = getRules("Compte Total", EMPTY);
  assert.equal(rules.integer, true);
  assert.equal(rules.number, true);
});

test("getRules adds unitSuffix to Onces Totales", () => {
  const rules = getRules("Onces Totales", EMPTY);
  assert.equal(rules.unitSuffix, true);
  assert.equal(rules.number, true);
});

test("validate returns error for empty required field", () => {
  const rules = { required: true };
  assert.equal(validate("", rules), "Champ obligatoire");
  assert.equal(validate("   ", { required: true }), "Champ obligatoire");
});

test("validate returns null for empty optional field", () => {
  const rules = { required: false };
  assert.equal(validate("", rules), null);
});

test("validate returns error for too long text", () => {
  const rules = { required: true, maxLength: 255 };
  assert.equal(validate("a".repeat(256), rules), "255 caractères maximum");
  assert.equal(validate("a".repeat(255), rules), null);
});

test("validate accepts valid yesno values", () => {
  const rules = { required: true, oneOf: ["OUI", "NON"] };
  assert.equal(validate("OUI", rules), null);
  assert.equal(validate("NON", rules), null);
});

test("validate rejects invalid yesno value", () => {
  const rules = { required: true, oneOf: ["OUI", "NON"] };
  assert.equal(validate("oui", rules), "Valeurs possibles : OUI, NON");
});

test("validate accepts valid numbers", () => {
  const rules = { required: true, number: true, min: 0 };
  assert.equal(validate("12", rules), null);
  assert.equal(validate("12,5", rules), null);
  assert.equal(validate("12.5", rules), null);
  assert.equal(validate("0", rules), null);
});

test("validate rejects negative numbers below min", () => {
  const rules = { required: true, number: true, min: 0 };
  assert.equal(validate("-1", rules), "Minimum : 0");
});

test("validate rejects non-numeric text", () => {
  const rules = { required: true, number: true };
  assert.equal(validate("abc", rules), "Nombre attendu (ex. 12,5)");
});

test("validate accepts unit suffix on Onces Totales", () => {
  const rules = { required: true, number: true, unitSuffix: true };
  assert.equal(validate("12 GR", rules), null);
  assert.equal(validate("12", rules), null);
  assert.equal(validate("12,5 GR", rules), null);
});

test("validate rejects non-numeric with unit suffix", () => {
  const rules = { required: true, number: true, unitSuffix: true };
  assert.equal(validate("abc GR", rules), "Nombre attendu, suivi éventuellement d'une unité (ex. 12 GR)");
});

test("validate requires integer when specified", () => {
  const rules = { required: true, number: true, integer: true, min: 1 };
  assert.equal(validate("1.5", rules), "Nombre entier attendu");
  assert.equal(validate("1", rules), null);
});

test("fieldType returns correct types", () => {
  assert.equal(fieldType("NEW NOM DE SPECIALITE"), "text");
  assert.equal(fieldType("EAN13"), "text");
  assert.equal(fieldType("BRAND"), "text");
  assert.equal(fieldType("Label"), "text");
  assert.equal(fieldType("Onces Totales"), "number");
  assert.equal(fieldType("Compte Total"), "number");
  assert.equal(fieldType("Compte Total De Paqt"), "number");
  assert.equal(fieldType("CODIFICATION AVEC PHOTO oui/non"), "yesno");
  assert.equal(fieldType("Dans le scope ?"), "yesno");
  assert.equal(fieldType("Type De Produit"), "select");
  assert.equal(fieldType("Additifs"), "select");
  assert.equal(fieldType("INFO GARNITURE"), "text");
});

test("getFieldOptions returns PRODUCT_TYPES for Type De Produit", () => {
  const options = getFieldOptions("Type De Produit", EMPTY);
  assert.ok(options.some(o => o.value === "SUBSTITUT CHOCOLAT & SPECIALITE CHOCOLAT"));
  assert.ok(options.some(o => o.value === "CHOCOLAT & SPECIALITE CHOCOLAT"));
});

test("getFieldOptions returns BIOLOGICAL_OPTIONS for Informations Bilgcls", () => {
  const options = getFieldOptions("Informations Bilgcls", EMPTY);
  assert.ok(options.some(o => o.value === "BIOLOGIQUE"));
  assert.ok(options.some(o => o.value === "NON BIOLOGIQUE"));
});

test("getFieldOptions for ECOLOGICAL uses ECOLOGICAL_OPTIONS", () => {
  const options = getFieldOptions("Info Ecologique", EMPTY);
  assert.ok(options.some(o => o.value === "ECOLOGIQUE"));
  assert.ok(options.some(o => o.value === "NON ECOLOGIQUE"));
});

test("getFieldOptions for FAIR uses FAIR_OPTIONS", () => {
  const options = getFieldOptions("Info Commerce Equtbl", EMPTY);
  assert.ok(options.some(o => o.value === "EQUITABLE"));
  assert.ok(options.some(o => o.value === "NON EQUITABLE"));
});

test("getFieldOptions for TYPE DE SPECIALITE depends on Type De Confiserie", () => {
  const optionsNone = getFieldOptions("TYPE DE SPECIALITE", { "Type De Confiserie": "" });
  assert.equal(optionsNone.length, 1);

  const optionsChocolatSpecialite = getFieldOptions("TYPE DE SPECIALITE", { "Type De Confiserie": "SPECIALITE CHOCOLAT" });
  assert.ok(optionsChocolatSpecialite.some(o => o.value === "ASSORTIMENT CHOCOLAT"));
  assert.ok(optionsChocolatSpecialite.some(o => o.value === "SPECIALITE CHOCOLAT"));

  const optionsMoulage = getFieldOptions("TYPE DE SPECIALITE", { "Type De Confiserie": "MOULAGE" });
  assert.ok(optionsMoulage.some(o => o.value === "ASSORTIMENT MOULAGE"));
});

test("getFieldOptions for Additifs returns correct choices", () => {
  const options = getFieldOptions("Additifs", EMPTY);
  assert.ok(options.some(o => o.value === "MULTI ADDITIFS"));
  assert.ok(options.some(o => o.value === "VALEUR INDISPONIBLE"));
  assert.ok(options.some(o => o.value === "SANS ADDITIF"));
  assert.ok(options.some(o => o.value === OTHER_OPTION));
});

// INFO GARNITURE est un champ ouvert (dictionnaire validé le 6/07/2026) : saisie libre avec suggestions.
test("INFO GARNITURE is free text with dictionary suggestions", () => {
  assert.deepEqual(getFieldOptions("INFO GARNITURE", { "Type De Confiserie": "MOULAGE" }).map(o => o.value), [""]);
  const suggestions = ALL_SUGGESTION_DICTIONARIES["INFO GARNITURE"];
  assert.ok(suggestions.includes("GARNI"));
  assert.ok(suggestions.includes("NON GARNI"));
});

test("getFieldOptions for Info Saison returns correct choices", () => {
  const options = getFieldOptions("Info Saison", EMPTY);
  assert.ok(options.some(o => o.value === "PERMANENT"));
  assert.ok(options.some(o => o.value === "SAISONNIER"));
  assert.ok(options.some(o => o.value === "PERMANENT/SAISONNIER"));
});

test("getFieldOptions for season shape depends on parent season value", () => {
  const optionsNoelShapeInactive = getFieldOptions("Info Forme Noel", { "Info Noel": "NON NOEL" });
  assert.ok(optionsNoelShapeInactive.some(o => o.value === "NON APPLICABLE"));

  const optionsNoelShapeActive = getFieldOptions("Info Forme Noel", { "Info Noel": "NOEL" });
  assert.ok(optionsNoelShapeActive.some(o => o.value === "VALEUR INDISPONIBLE"));
  assert.ok(optionsNoelShapeActive.some(o => o.value === "MULTIFORMES"));
  assert.ok(optionsNoelShapeActive.some(o => o.value === OTHER_OPTION));
});

test("getFieldOptions always includes placeholder", () => {
  const options = getFieldOptions("Type De Produit", EMPTY);
  assert.equal(options[0].value, "");
  assert.equal(options[0].label, "Sélectionner...");
});

test("emptyValues returns all fields with empty strings and DEFAULT_VALUES", () => {
  const values = emptyValues();
  for (const field of FIELDS) {
    assert.ok(field in values, `Field ${field} should be in emptyValues`);
  }
  assert.equal(values.Label, "SANS LABEL");
  assert.equal(values.Bonus1, "RP");
  assert.equal(values["INFO PARFUM"], "CHOCOLAT");
  assert.equal(values["TYPE DE SUBSTITUT"], "CHOVIVA");
  assert.equal(values.Localisation, "ETAGERE");
  assert.equal(values["Compte Total"], "1");
});

test("FIELDS contains all required fields", () => {
  assert.ok(FIELDS.includes("Dans le scope ?"));
  assert.ok(FIELDS.includes("NEW NOM DE SPECIALITE"));
  assert.ok(FIELDS.includes("EAN13"));
  assert.ok(FIELDS.includes("Label"));
  assert.ok(FIELDS.includes("Type De Produit"));
  assert.ok(FIELDS.includes("Type De Confiserie"));
  assert.ok(FIELDS.includes("Onces Totales"));
  assert.ok(FIELDS.includes("Compte Total"));
  assert.ok(FIELDS.includes("Compte Total De Paqt"));
  assert.equal(FIELDS.length, 52);
});

test("SEASONS has 6 season fields", () => {
  assert.equal(SEASONS.length, 6);
  assert.ok(SEASONS.find(s => s.field === "Info Noel"));
  assert.ok(SEASONS.find(s => s.field === "Info Paques"));
  assert.ok(SEASONS.find(s => s.field === "INFO AUTOMNE"));
  assert.ok(SEASONS.find(s => s.field === "Info HALLOWEEN"));
  assert.ok(SEASONS.find(s => s.field === "INFO SAINT VALENTIN"));
  assert.ok(SEASONS.find(s => s.field === "INFO FETE DES MERES"));
});

test("CONFISERY_TYPES contains expected values", () => {
  assert.ok(CONFISERY_TYPES.includes("SPECIALITE CHOCOLAT"));
  assert.ok(CONFISERY_TYPES.includes("CONFISERIE CHOCOLAT"));
  assert.ok(CONFISERY_TYPES.includes("MOULAGE"));
});

test("PRODUCT_TYPES contains expected values", () => {
  assert.ok(PRODUCT_TYPES.includes("SUBSTITUT CHOCOLAT & SPECIALITE CHOCOLAT"));
  assert.ok(PRODUCT_TYPES.includes("CHOCOLAT & SPECIALITE CHOCOLAT"));
});

test("requiresPluralVerification for INFO FOURRAGE always true", () => {
  assert.equal(requiresPluralVerification("INFO FOURRAGE", EMPTY), true);
});

test("requiresPluralVerification for Additifs only when custom", () => {
  assert.equal(requiresPluralVerification("Additifs", EMPTY), false);
  assert.equal(requiresPluralVerification("Additifs", { Additifs: true }), true);
});

test("requiresPluralVerification for other fields is false", () => {
  assert.equal(requiresPluralVerification("NOM", EMPTY), false);
  assert.equal(requiresPluralVerification("Label", EMPTY), false);
});

test("hasPluralWord detects words ending in S or X (uppercase)", () => {
  assert.equal(hasPluralWord("NOIX & AMANDE"), true);
  assert.equal(hasPluralWord("CHOUX"), true);
  assert.equal(hasPluralWord("CHOCOLAT BLANC"), false);
});

test("hasPluralWord ignores singular exceptions", () => {
  assert.equal(hasPluralWord("FRAIS"), false);
  assert.equal(hasPluralWord("ANIS"), false);
  assert.equal(hasPluralWord("CHOIX"), false);
});

test("hasPluralWord ignores prepositions DE and D", () => {
  assert.equal(hasPluralWord("DE"), false);
  assert.equal(hasPluralWord("D"), false);
});

test("validateAll returns errors for empty required fields", () => {
  const values = { NOM: "" };
  const errors = validateAll(values);
  assert.ok(errors["NOM"]);
  assert.equal(errors.NOM, "Champ obligatoire");
});

test("validateAll returns no errors for valid fields", () => {
  const values = { NOM: "CHOCCOLAT NOISETTE", EAN13: "3456789012345" };
  const errors = validateAll(values);
  assert.equal(Object.keys(errors).length, 0);
});

test("validateAll detects plural word requires verification", () => {
  const values = { "Additifs": "AMANDE & NOIX" };
  const errors = validateAll(values, { Additifs: true }, {});
  assert.ok(errors["Additifs"]);
  assert.equal(errors["Additifs"], "Pluralité vérifiée obligatoire");
});

test("validateAll passes when plural is verified", () => {
  const values = { "Additifs": "AMANDE & NOIX" };
  const errors = validateAll(values, { Additifs: true }, { Additifs: true });
  assert.equal(errors["Additifs"], undefined);
});

test("sortFreeText sorts alphabetically by initial", () => {
  assert.equal(sortFreeText("ZOEUF/BRIE"), "BRIE/ZOEUF");
  assert.equal(sortFreeText("NOIX & AMANDE"), "AMANDE&NOIX");
});

test("sortPerfume keeps CHOCOLAT prefix", () => {
  assert.equal(sortPerfume("CHOCOLAT BLANC/LAIT"), "CHOCOLAT BLANC/LAIT");
});

test("normalizeSeparators normalizes spaces around / and &", () => {
  assert.equal(normalizeSeparators("a/b&c"), "a / b & c");
  assert.equal(normalizeSeparators("a /b &  c"), "a / b & c");
  assert.equal(normalizeSeparators("CHOCOLAT BLANC"), "CHOCOLAT BLANC");
});

test("shouldSortFreeText respects SORT_EXCLUDED_FIELDS", () => {
  assert.equal(shouldSortFreeText("BRAND", EMPTY), false);
  assert.equal(shouldSortFreeText("NEW NOM DE SPECIALITE", EMPTY), false);
  assert.equal(shouldSortFreeText("LIBELLE PRODUIT", EMPTY), false);
  assert.equal(shouldSortFreeText("MAJOR BRAND", EMPTY), false);
});

test("shouldSortFreeText returns true for text fields", () => {
  assert.equal(shouldSortFreeText("NOM", EMPTY), true);
  assert.equal(shouldSortFreeText("EAN13", EMPTY), true);
});

test("shouldSortFreeText returns true for custom select fields", () => {
  assert.equal(shouldSortFreeText("Additifs", { Additifs: true }), true);
  assert.equal(shouldSortFreeText("Label", { Label: true }), true);
});

test("fieldId normalizes field names to valid HTML IDs", () => {
  assert.equal(fieldId("EAN13"), "f-ean13");
  assert.equal(fieldId("Type De Produit"), "f-type-de-produit");
  assert.equal(fieldId("INFO CREUX/PLEIN"), "f-info-creux-plein");
  assert.equal(fieldId("Dans le scope ?"), "f-dans-le-scope-");
});

test("SCOPE_FIELD has correct value", () => {
  assert.equal(SCOPE_FIELD, "Dans le scope ?");
});

test("OTHER_OPTION has correct value", () => {
  assert.equal(OTHER_OPTION, "__OTHER__");
});

test("DEFAULT_VALUES are applied correctly in emptyValues", () => {
  const defaults = emptyValues();
  assert.equal(defaults.Label, "SANS LABEL");
  assert.equal(defaults.Bonus1, "RP");
  assert.equal(defaults["INFO PARFUM"], "CHOCOLAT");
  assert.equal(defaults["TYPE DE SUBSTITUT"], "CHOVIVA");
  assert.equal(defaults.Localisation, "ETAGERE");
  assert.equal(defaults["Compte Total"], "1");
});

test("emptyValues has empty string for fields without defaults", () => {
  const defaults = emptyValues();
  assert.equal(defaults["NEW NOM DE SPECIALITE"], "");
  assert.equal(defaults.EAN13, "");
  assert.equal(defaults["Type De Produit"], "");
});

test("emptyValues includes SCOPE_FIELD", () => {
  const defaults = emptyValues();
  assert.ok(SCOPE_FIELD in defaults);
  assert.equal(defaults[SCOPE_FIELD], "");
});

test("Check Digit column is detected as EAN for backend filtering", () => {
  const headers = ["Product Name", "Check Digit", "Brand"];
  const eanField = headers.find(h => {
    const normalized = String(h).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return normalized === 'EAN' || normalized === 'EAN13' || normalized === 'EANS' || normalized === 'CHECKDIGIT';
  });
  assert.equal(eanField, "Check Digit");
});

test("EAN column detection recognizes EAN, EAN13, EANS, Check Digit", () => {
  const detectEan = (headers) => headers.find(h => {
    const normalized = String(h).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return normalized === 'EAN' || normalized === 'EAN13' || normalized === 'EANS' || normalized === 'CHECKDIGIT';
  });

  assert.equal(detectEan(["NOM", "EAN", "PRIX"]), "EAN");
  assert.equal(detectEan(["NOM", "EAN13", "PRIX"]), "EAN13");
  assert.equal(detectEan(["NOM", "Check Digit", "PRIX"]), "Check Digit");
  assert.equal(detectEan(["Product", "CODE", "PRIX"]), undefined);
});
