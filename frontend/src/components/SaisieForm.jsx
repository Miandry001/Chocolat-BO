import { useEffect, useState } from "react";
import { Button, Field, Select, SuggestionInput, TextInput } from "./ui";
import {
  CONFISERY_TYPES, FIELDS, OTHER_OPTION, SCOPE_FIELD, SEASONS, emptyValues, fieldId, fieldType, getFieldOptions, isWide,
} from "../data/fields.js";
import {
  formatValue, getRules, hasPluralWord, requiresPluralVerification, validate, validateAll,
} from "../data/rules.js";
import { normalizeSeparators, shouldSortFreeText, sortFreeText, sortPerfume } from "../data/textRules.js";
import { ALL_SUGGESTION_DICTIONARIES as SUGGESTION_DICTIONARIES } from "../data/suggestionDictionaries.js";

/** Correspondance entre noms de colonnes dans les onglets catalogue et champs du formulaire. */
const CATALOG_TO_FIELD_MAP = {
  "NOM DE SPECIALITE": "NEW NOM DE SPECIALITE",
  "VARIETE PARFUM": "INFO PARFUM",
  "TYPE DE FOURRAGE": "INFO FOURRAGE",
  "SAISONNIER INFO": "Info Saison",
  "INFORMATIONS BILGCLS": "Informations Bilgcls",
  "INFO COMMERCE EQUTBL": "Info Commerce Equtbl",
};

const YESNO_OPTIONS = ["", "OUI", "NON"];
const PLURAL_FIELDS = ["Additifs", "INFO FOURRAGE"];

function FieldControl({ name, id, value, error, onChange, onBlur, values, isCustom, onCustomChange, disabled }) {
  const common = {
    id,
    name,
    value,
    disabled,
    required: getRules(name, values).required,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
    onChange: (event) => onChange(name, event.target.value),
    onBlur: () => onBlur(name),
  };
  switch (fieldType(name)) {
    case "yesno":
      return <Select options={YESNO_OPTIONS} {...common} />;
    case "select":
      return (
        <>
          <Select
            {...common}
            value={isCustom ? OTHER_OPTION : value}
            options={getFieldOptions(name, values)}
            onChange={(event) => {
              const selected = event.target.value;
              onCustomChange(name, selected === OTHER_OPTION);
              if (selected !== OTHER_OPTION) onChange(name, selected);
            }}
          />
          {isCustom && (
            <SuggestionInput
              id={`${id}-custom`}
              name={name}
              fieldName={name}
              value={value}
              disabled={disabled}
              required={getRules(name, values, { [name]: true }).required}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              placeholder="Saisir une valeur"
              staticSuggestions={SUGGESTION_DICTIONARIES[name]}
              onChange={(nextValue) => onChange(name, nextValue)}
              onBlur={() => onBlur(name)}
            />
          )}
        </>
      );
    case "number":
      return (
        <TextInput
          inputMode="decimal"
          type={name === "Onces Totales" ? "text" : undefined}
          {...common}
        />
      );
    default:
      return (
        <SuggestionInput
          {...common}
          fieldName={name}
           staticSuggestions={SUGGESTION_DICTIONARIES[name]}
          onChange={(nextValue) => onChange(name, nextValue)}
          onBlur={() => onBlur(name)}
        />
      );
  }
}

export function SaisieForm({ onSubmit, onDirty, disabled = false, clearValues = false, outOfScope = false, initialValues = {} }) {
  const defaults = () => ({ ...emptyValues(), ...initialValues });
  const getCustomFields = (values) => Object.fromEntries(
    FIELDS.filter((name) => fieldType(name) === "select")
      .filter((name) => values[name] && !getFieldOptions(name, values)
        .some((option) => !option.disabled && option.value === values[name]))
      .map((name) => [name, true]),
  );
  const [values, setValues] = useState(defaults);
  const [errors, setErrors] = useState({});
  const [customFields, setCustomFields] = useState(() => getCustomFields(defaults()));
  const [pluralVerified, setPluralVerified] = useState({});
  const [autoFilling, setAutoFilling] = useState(false);
  const [autoFillStatus, setAutoFillStatus] = useState("");

  useEffect(() => {
    const nextValues = clearValues
      ? Object.fromEntries(FIELDS.map((name) => [name, ""]))
      : defaults();
    setValues(nextValues);
    setErrors({});
    setCustomFields(getCustomFields(nextValues));
    setPluralVerified({});
  }, [clearValues, initialValues]);

  const setError = (name, error) =>
    setErrors(({ [name]: _, ...rest }) => (error ? { ...rest, [name]: error } : rest));

  const handleChange = (name, raw) => {
    onDirty?.();
    const value = name === "Onces Totales" && /^\s*\d+(?:[.,]\d+)?\s+$/.test(raw)
      ? `${raw.trim()} GR`
      : formatValue(raw);
    const updates = [name];
    if (name === "Type De Produit") updates.push("TYPE DE SUBSTITUT");
    if (name === "Type De Confiserie") updates.push("TYPE DE SPECIALITE", "INFO CREUX/PLEIN");
    if (name === "Info Saison") {
      updates.push("Info Forme Permanent");
      SEASONS.forEach(({ field, shape }) => updates.push(field, shape));
    }
    const changedSeason = SEASONS.find(({ field }) => field === name);
    if (changedSeason) {
      updates.push(changedSeason.shape);
      if (value === changedSeason.name && !SEASONS.some(({ field, name: seasonName }) => field !== name && values[field] === seasonName)) {
        SEASONS.filter(({ field }) => field !== name).forEach(({ field, shape }) => updates.push(field, shape));
      }
    }

    setValues((previous) => {
      const next = { ...previous, [name]: value };
      if (name === "Type De Produit") {
        next["TYPE DE SUBSTITUT"] = value === "SUBSTITUT CHOCOLAT & SPECIALITE CHOCOLAT"
          ? "CHOVIVA"
          : value === "CHOCOLAT & SPECIALITE CHOCOLAT" ? "NON APPLICABLE" : "";
      }
      if (name === "Type De Confiserie") {
        next["TYPE DE SPECIALITE"] = "";
        const isMoulage = value.includes("MOULAGE");
        next["INFO CREUX/PLEIN"] = isMoulage ? "" : "NON APPLICABLE";
      }
      if (name === "Info Saison") {
        next["Info Forme Permanent"] = value === "SAISONNIER" ? "NON APPLICABLE" : "";
        for (const season of SEASONS) {
          next[season.field] = value === "PERMANENT" ? `NON ${season.name}` : "";
          next[season.shape] = value === "PERMANENT" ? "NON APPLICABLE" : "";
        }
      }
      const season = SEASONS.find(({ field }) => field === name);
      if (season) {
        const firstSeasonSelection = value === season.name
          && !SEASONS.some(({ field, name: seasonName }) => field !== name && previous[field] === seasonName);
        if (firstSeasonSelection) {
          for (const other of SEASONS) {
            if (other.field !== name) {
              next[other.field] = `NON ${other.name}`;
              next[other.shape] = "NON APPLICABLE";
            }
          }
        }
        next[season.shape] = value === `NON ${season.name}` ? "NON APPLICABLE" : "";
      }
      return next;
    });

    if (name === "Type De Produit") setCustomFields((current) => ({ ...current, "TYPE DE SUBSTITUT": false }));
    if (name === "Type De Confiserie") {
      setCustomFields((current) => ({ ...current, "TYPE DE SPECIALITE": false }));
    }
    if (name === "Info Saison") {
      setCustomFields((current) => {
        const next = { ...current };
          next["Info Forme Permanent"] = false;
        SEASONS.forEach(({ shape }) => { next[shape] = false; });
        return next;
      });
    }
    if (PLURAL_FIELDS.includes(name)) setPluralVerified((current) => ({ ...current, [name]: false }));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !updates.includes(key))));
    if (errors[name]) setError(name, validate(value, getRules(name, values, customFields)));
  };

  const handleBlur = (name) => {
    let value = values[name] || "";
    const isFreeText = ["text", "textarea"].includes(fieldType(name)) || customFields[name];
    if (isFreeText) {
      if (shouldSortFreeText(name, customFields)) {
        value = name === "INFO PARFUM" ? sortPerfume(value) : sortFreeText(value);
      } else value = normalizeSeparators(value);
    }
    if (value !== values[name]) setValues((current) => ({ ...current, [name]: value }));
    setError(name, validate(value, getRules(name, values, customFields)));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const submittedValues = Object.fromEntries(Object.entries(values).map(([name, value]) => {
      const isFreeText = ["text", "textarea"].includes(fieldType(name)) || customFields[name];
      const isSorted = shouldSortFreeText(name, customFields);
      return [name, isFreeText && !isSorted ? normalizeSeparators(value) : value];
    }));
    for (const [name, value] of Object.entries(submittedValues)) {
      if (shouldSortFreeText(name, customFields)) {
        submittedValues[name] = name === "INFO PARFUM" ? sortPerfume(value) : sortFreeText(value);
      }
    }
    setValues(submittedValues);
    const formValues = Object.fromEntries(Object.entries(submittedValues).filter(([name]) => name !== SCOPE_FIELD));
    const found = validateAll(formValues, customFields, pluralVerified);
    setErrors(found);
    const first = FIELDS.find((name) => found[name]);
    if (first) {
      document.getElementById(fieldId(first))?.focus();
      return;
    }
    onSubmit?.(Object.fromEntries(Object.entries(formValues).map(([key, entry]) => [key, formatValue(entry.trim())])));
  };

  const handleReset = (event) => {
    event.preventDefault();
    onDirty?.();
    setValues(defaults());
    setErrors({});
    setCustomFields({});
    setPluralVerified({});
  };

  const handleAutoFill = async (event) => {
    event?.preventDefault?.();
    const ean = String(values.EAN13 || "").trim();
    if (!ean) {
      setAutoFillStatus("Saisissez d'abord l'EAN13.");
      return;
    }
    setAutoFilling(true);
    setAutoFillStatus("");
    onDirty?.();
    try {
      const response = await fetch(`/api/v1/catalog/lookup?ean=${encodeURIComponent(ean)}`, { credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
      const sourceRow = body.data.row || {};
      const normalizedSource = Object.fromEntries(
        Object.entries(sourceRow).map(([key, value]) => [
          String(key).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase(),
          value,
        ]),
      );
      const normalize = (name) => String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
      const nextValues = { ...values };
      for (const fieldName of FIELDS) {
        const normField = normalize(fieldName);
        // 1) essai correspondance directe
        let raw = normalizedSource[normField];
        // 2) essai via table de correspondance catalogue -> formulaire
        if (raw == null && CATALOG_TO_FIELD_MAP[normField]) {
          raw = normalizedSource[CATALOG_TO_FIELD_MAP[normField]];
        }
        if (raw != null) {
          nextValues[fieldName] = formatValue(String(raw));
        }
      }
      nextValues[SCOPE_FIELD] = values[SCOPE_FIELD] || "";
      const productType = nextValues["Type De Produit"] || "";
      if (productType === "SUBSTITUT CHOCOLAT & SPECIALITE CHOCOLAT") nextValues["TYPE DE SUBSTITUT"] = nextValues["TYPE DE SUBSTITUT"] || "CHOVIVA";
      else if (productType === "CHOCOLAT & SPECIALITE CHOCOLAT") nextValues["TYPE DE SUBSTITUT"] = "NON APPLICABLE";
      const confiserieType = nextValues["Type De Confiserie"] || "";
      if (confiserieType) {
        if (!nextValues["INFO CREUX/PLEIN"]) nextValues["INFO CREUX/PLEIN"] = confiserieType.includes("MOULAGE") ? "" : "NON APPLICABLE";
      }
      if (nextValues["Info Saison"] === "SAISONNIER" && !nextValues["Info Forme Permanent"]) nextValues["Info Forme Permanent"] = "NON APPLICABLE";
      setValues(nextValues);
      setCustomFields(getCustomFields(nextValues));
      setAutoFillStatus(`Données récupérées depuis l'onglet « ${body.data.sheetName} ».`);
    } catch (error) {
      setAutoFillStatus(error.message || "Remplissage automatique impossible.");
    } finally {
      setAutoFilling(false);
    }
  };

  return (
    <form
      className={`form-grid${outOfScope ? " form-grid--out-of-scope" : ""}`}
      autoComplete="off"
      noValidate
      aria-disabled={disabled || undefined}
      onSubmit={handleSubmit}
      onReset={handleReset}
    >
      {FIELDS.filter((name) => name !== SCOPE_FIELD).map((name) => {
        const id = fieldId(name);
        const hasPlurals = requiresPluralVerification(name, customFields) && hasPluralWord(values[name] || "");
        const rules = getRules(name, values, customFields);
        return (
          <Field key={name} id={id} label={name} wide={isWide(name)} required={rules.required} error={errors[name]}>
            <FieldControl
              name={name}
              id={id}
              value={values[name]}
              error={errors[name]}
              onChange={handleChange}
              onBlur={handleBlur}
              values={values}
              disabled={disabled}
              isCustom={Boolean(customFields[name])}
              onCustomChange={(field, enabled) => {
                onDirty?.();
                setCustomFields((current) => ({ ...current, [field]: enabled }));
                if (enabled) setValues((current) => ({ ...current, [field]: "" }));
                setPluralVerified((current) => ({ ...current, [field]: false }));
                setError(field, null);
              }}
            />
            {hasPlurals && (
              <>
                <p className="plural-warning" role="alert">Attention, il y a des mots qui sont saisis en pluriel</p>
                <label className="plural-check">
                  <input
                    type="checkbox"
                    checked={Boolean(pluralVerified[name])}
                    onChange={(event) => {
                      onDirty?.();
                      setPluralVerified((current) => ({ ...current, [name]: event.target.checked }));
                    }}
                    required
                    aria-invalid={errors[name] === "Pluralité vérifiée obligatoire" ? true : undefined}
                  />
                  Pluralité vérifiée
                </label>
              </>
            )}
          </Field>
        );
      })}
      {autoFillStatus && <p role="status">{autoFillStatus}</p>}
      <div className="form-actions">
        <Button type="button" disabled={disabled || autoFilling} onClick={handleAutoFill}>Remplir depuis le catalogue (EAN)</Button>
        <Button type="reset" disabled={disabled}>Effacer</Button>
        <Button type="submit" variant="primary" disabled={disabled}>Valider</Button>
      </div>
    </form>
  );
}
