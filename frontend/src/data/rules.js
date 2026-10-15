import { fieldType, getFieldOptions } from "./fields.js";

/** Règles appliquées par défaut à chaque champ, selon son type. */
export const DEFAULT_RULES = {
  text: { required: true, maxLength: 255 },
  textarea: { required: true, maxLength: 2000 },
  number: { required: true, maxLength: 20, number: true, min: 0 },
  yesno: { required: true, oneOf: ["OUI", "NON"] },
  select: { required: true },
};

const SINGULAR_EXCEPTIONS = new Set(["ANIS", "BIS", "MAIS", "PLUS", "SANS", "CHOIX", "PRIX", "TAUX", "FRAIS"]);

export function requiresPluralVerification(name, customFields = {}) {
  return name === "INFO FOURRAGE" || (name === "Additifs" && Boolean(customFields.Additifs));
}

export function hasPluralWord(value = "") {
  const words = value.match(/[A-ZÀ-ÖØ-Þ]+(?:'[A-ZÀ-ÖØ-Þ]+)?/g) || [];
  return words.some((word) => {
    const normalized = word.replaceAll("'", "");
    if (["DE", "D"].includes(normalized) || SINGULAR_EXCEPTIONS.has(normalized)) return false;
    return /(?:S|X)$/.test(normalized);
  });
}

/** Surcharges champ par champ (fusionnées avec les règles par défaut). */
export const FIELD_RULES = {
  "Onces Totales": { unitSuffix: true },
  "Compte Total": { integer: true },
  Bonus2: { required: false },
  Bonus3: { required: false },
  Bonus4: { required: false },
};

export function getRules(name, values = {}, customFields = {}) {
  const rules = { ...DEFAULT_RULES[fieldType(name)], ...FIELD_RULES[name] };
  if (fieldType(name) === "select" && !customFields[name]) {
    rules.oneOf = getFieldOptions(name, values)
      .filter(({ disabled }) => !disabled)
      .map(({ value }) => value)
      .filter((value) => value && value !== "__OTHER__");
  }
  return rules;
}

/** Mise en forme appliquée à toutes les réponses : majuscules, sans accents. */
export const formatValue = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .toUpperCase();

const parseNumber =(s) => Number(s.replace(",", "."));

/** Renvoie un message d'erreur, ou null si la valeur respecte les règles. */
export function validate(value, rules) {
  const v = value.trim();

  if (!v) return rules.required ? "Champ obligatoire" : null;

  if (rules.maxLength && v.length > rules.maxLength)
    return `${rules.maxLength} caractères maximum`;

  if (rules.number) {
    const match = rules.unitSuffix
      ? /^(-?\d+(?:[.,]\d+)?)(?:\s+[A-Z]+(?:\s+[A-Z]+)*)?$/.exec(v)
      : /^(-?\d+(?:[.,]\d+)?)$/.exec(v);
    if (!match) {
      return rules.unitSuffix
        ? "Nombre attendu, suivi éventuellement d'une unité (ex. 12 GR)"
        : "Nombre attendu (ex. 12,5)";
    }
    const n = parseNumber(match[1]);
    if (rules.integer && !Number.isInteger(n)) return "Nombre entier attendu";
    if (rules.min != null && n < rules.min) return `Minimum : ${rules.min}`;
    if (rules.max != null && n > rules.max) return `Maximum : ${rules.max}`;
  }

  if (rules.oneOf && !rules.oneOf.includes(v))
    return `Valeurs possibles : ${rules.oneOf.join(", ")}`;

  return null;
}

/** Valide toutes les valeurs ; renvoie { nomDuChamp: message } pour les champs en erreur. */
export function validateAll(values, customFields = {}, pluralVerified = {}) {
  const errors = {};
  for (const [name, value] of Object.entries(values)) {
    const error = validate(value, getRules(name, values, customFields));
    if (error) errors[name] = error;
    else if (requiresPluralVerification(name, customFields) && hasPluralWord(value) && !pluralVerified[name]) {
      errors[name] = "Pluralité vérifiée obligatoire";
    }
  }
  return errors;
}
