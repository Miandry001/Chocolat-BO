import LABEL_REFERENCES from "../../data/labelReferences";

const POSITIVE = {
  biologique: "BIOLOGIQUE",
  equitable: "EQUITABLE",
  ecologique: "ECOLOGIQUE",
  vegetal: "OUI"
};

export function calculateLabelInformation(selectedLabels = []) {
  const names = Array.isArray(selectedLabels)
    ? selectedLabels.filter(Boolean)
    : [];

  if (names.length === 0) {
    return { infoBiologique: "", infoEquitable: "", infoEcologique: "", infoVegetal: "" };
  }

  const normalized = new Set(names.map(v => String(v).trim().toUpperCase()));
  const data = LABEL_REFERENCES.filter(item => normalized.has(item.label.trim().toUpperCase()));

  if (data.length !== normalized.size) {
    const known = new Set(data.map(x => x.label.trim().toUpperCase()));
    const unknown = [...normalized].filter(x => !known.has(x));
    throw new Error(`Label(s) inconnu(s): ${unknown.join(", ")}`);
  }

  return {
    infoBiologique: data.some(x => x.biologique === POSITIVE.biologique) ? "BIOLOGIQUE" : "NON BIOLOGIQUE",
    infoEquitable: data.some(x => x.equitable === POSITIVE.equitable) ? "EQUITABLE" : "NON EQUITABLE",
    infoEcologique: data.some(x => x.ecologique === POSITIVE.ecologique) ? "ECOLOGIQUE" : "NON ECOLOGIQUE",
    infoVegetal: data.some(x => x.vegetal === POSITIVE.vegetal) ? "VEGETAL" : "NON VEGETAL"
  };
}
