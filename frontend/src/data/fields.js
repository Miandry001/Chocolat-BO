export const SCOPE_FIELD = "Dans le scope ?";

export const FIELDS = [
  SCOPE_FIELD,
  "CODIFICATION AVEC PHOTO oui/non",
  "EAN13", "Company", "Major Brand", "BRAND", "NEW NOM DE SPECIALITE", "Label", "Bonus1", "Bonus2", "Bonus3", "Bonus4",
  "Type De Produit", "Emballage", "INFO PARFUM", "Additifs", "INFO FOURRAGE",
  "Type De Confiserie", "TYPE DE SPECIALITE",
  "TYPE DE SUBSTITUT", "PRESENTATION", "INFO GARNITURE", "INFO DRAGEIFIE", "INFO CREUX/PLEIN", "INFO ATTACHE",
  "Libelle Produit", "Localisation", "Info Saison", "Info HALLOWEEN", "Info Noel", "Info Paques", "INFO AUTOMNE",
  "INFO SAINT VALENTIN", "INFO FETE DES MERES", "Info Forme Noel", "Info Forme Pâques", "Info Forme Permanent",
  "Info Forme Halloween", "INFO FORME AUTOMNE", "INFO FORME ST VALENTIN", "INFO FORME FETE DES MERES",
  "Info Sante Nature", "Extras", "Ethnique Info", "Informations Bilgcls", "Info Ecologique",
  "Info Commerce Equtbl", "Info Label", "Info Promotion", "Onces Totales", "Compte Total", "Compte Total De Paqt",
];

export const READONLY = [
  ["NOM KC", "Code catégorie client"],
  ["KEYCAT", "Catégorie clé produit"],
  ["UPC", "Identifiant code article d'origine"],
  ["State", "État de la ligne dans le système client"],
  ["System", "Métadonnée système d'origine"],
  ["Generation", "Version du flux client"],
  ["Vendor", "Nom du fournisseur"],
  ["Item", "Référence article fournisseur"],
  ["CONCATENER", ""],
];

export const PRODUCT_TYPES = [
  "SUBSTITUT CHOCOLAT & SPECIALITE CHOCOLAT",
  "CHOCOLAT & SPECIALITE CHOCOLAT",
];

export const CONFISERY_TYPES = ["SPECIALITE CHOCOLAT", "CONFISERIE CHOCOLAT", "MOULAGE"];

export const SEASONS = [
  { field: "Info Noel", name: "NOEL", shape: "Info Forme Noel", shapes: ["VALEUR INDISPONIBLE", "MULTIFORMES"] },
  { field: "Info Paques", name: "PAQUES", shape: "Info Forme Pâques", shapes: ["VALEUR INDISPONIBLE", "MULTIFORMES"] },
  { field: "INFO AUTOMNE", name: "AUTOMNE", shape: "INFO FORME AUTOMNE", shapes: ["VALEUR INDISPONIBLE"] },
  { field: "Info HALLOWEEN", name: "HALLOWEEN", shape: "Info Forme Halloween", shapes: ["VALEUR INDISPONIBLE", "MULTIFORMES"] },
  { field: "INFO SAINT VALENTIN", name: "SAINT VALENTIN", shape: "INFO FORME ST VALENTIN", shapes: ["VALEUR INDISPONIBLE", "MULTIFORMES"] },
  { field: "INFO FETE DES MERES", name: "FETES DES MERES", shape: "INFO FORME FETE DES MERES", shapes: ["VALEUR INDISPONIBLE", "MULTIFORMES"] },
];

export const DEFAULT_VALUES = {
  Label: "SANS LABEL",
  Bonus1: "RP",
  "INFO PARFUM": "CHOCOLAT",
  "TYPE DE SUBSTITUT": "CHOVIVA",
  Localisation: "ETAGERE",
  "Compte Total": "1",
  "INFO CREUX/PLEIN": "NON APPLICABLE",
};

export const OTHER_OPTION = "__OTHER__";

const BIOLOGICAL_OPTIONS = ["BIOLOGIQUE", "NON BIOLOGIQUE", "VALEUR INDISPONIBLE"];
const ECOLOGICAL_OPTIONS = ["ECOLOGIQUE", "NON ECOLOGIQUE", "VALEUR INDISPONIBLE"];
const FAIR_OPTIONS = ["EQUITABLE", "NON EQUITABLE", "VALEUR INDISPONIBLE"];

const placeholder = { value: "", label: "Sélectionner..." };
const otherOption = { value: OTHER_OPTION, label: "AUTRES (à renseigner)" };

export function getFieldOptions(name, values = {}) {
  let choices = [];
  if (name === "Type De Produit") choices = PRODUCT_TYPES;
  else if (name === "Informations Bilgcls") choices = BIOLOGICAL_OPTIONS;
  else if (name === "Info Ecologique") choices = ECOLOGICAL_OPTIONS;
  else if (name === "Info Commerce Equtbl") choices = FAIR_OPTIONS;
  else if (name === "TYPE DE SPECIALITE") {
    const confiserieType = values["Type De Confiserie"] ?? "";
    choices = [
      ...(confiserieType.includes("SPECIALITE CHOCOLAT") ? ["ASSORTIMENT CHOCOLAT", "SPECIALITE CHOCOLAT"] : []),
      ...(confiserieType.includes("CONFISERIE CHOCOLAT") ? ["ASSORTIMENT CONFISERIE CHOCOLAT", "CONFISERIE CHOCOLAT"] : []),
      ...(confiserieType.includes("MOULAGE") ? ["ASSORTIMENT MOULAGE"] : []),
    ];
  } else if (name === "TYPE DE SUBSTITUT") {
    const notApplicable = values["Type De Produit"] === PRODUCT_TYPES[1];
    choices = [
      { value: "CHOVIVA", label: "CHOVIVA", disabled: notApplicable },
      { ...otherOption, disabled: notApplicable },
      { value: "NON APPLICABLE", label: "NON APPLICABLE", disabled: !notApplicable },
    ];
  } else if (name === "Additifs") {
    choices = ["MULTI ADDITIFS", "VALEUR INDISPONIBLE", "SANS ADDITIF", OTHER_OPTION];
  } else if (name === "PRESENTATION") {
    choices = ["AVEC JOUET", "AVEC SURPRISE", "AVEC JOUET & SURPRISE", "AVEC RUBAN", "SANS JOUET/SURPRISE & SANS RUBAN"];
  } else if (name === "INFO DRAGEIFIE") {
    choices = [
      "DRAGEIFIE", "NON DRAGEIFIE", "DRAGEIFIE/NON DRAGEIFIE",
      "NON APPLICABLE", "VALEUR INDISPONIBLE",
    ];
  } else if (name === "INFO CREUX/PLEIN") {
    choices = ["CREUX", "PLEIN", "CREUX/PLEIN", "NON APPLICABLE"];
  } else if (name === "INFO ATTACHE") {
    choices = ["SANS ATTACHE", "AVEC ATTACHE", "VALEUR INDISPONIBLE"];
  } else if (name === "Info Saison") {
    choices = ["PERMANENT", "SAISONNIER", "PERMANENT/SAISONNIER"];
  } else if (name === "Info Forme Permanent") {
    choices = values["Info Saison"] === "SAISONNIER"
      ? ["NON APPLICABLE"]
      : ["VALEUR INDISPONIBLE", "MULTIFORMES", OTHER_OPTION];
  } else {
    const season = SEASONS.find(({ field, shape }) => field === name || shape === name);
    if (season && season.field === name) choices = [`NON ${season.name}`, season.name];
    if (season && season.shape === name) {
      choices = values[season.field] === `NON ${season.name}`
        ? ["NON APPLICABLE"]
        : [...season.shapes, OTHER_OPTION];
    }
  }

  return [placeholder, ...choices.map((choice) =>
    choice === OTHER_OPTION ? otherOption : typeof choice === "string" ? { value: choice, label: choice } : choice,
  )];
}

/** Type de contrôle à afficher pour un champ. */
export function fieldType(name) {
  if (["CODIFICATION AVEC PHOTO oui/non", SCOPE_FIELD].includes(name)) return "yesno";
  if (["Onces Totales", "Compte Total", "Compte Total De Paqt"].includes(name)) return "number";
  if ([
    "Type De Produit", "TYPE DE SPECIALITE", "TYPE DE SUBSTITUT",
    "Informations Bilgcls", "Info Ecologique", "Info Commerce Equtbl",
    "Additifs", "INFO DRAGEIFIE", "INFO CREUX/PLEIN", "INFO ATTACHE", "PRESENTATION",
    "Info Saison", "Info Forme Permanent", ...SEASONS.map(({ field }) => field), ...SEASONS.map(({ shape }) => shape),
  ].includes(name)) return "select";
  return "text";
}

export function isWide(name) {
  return false;
}

export const fieldId = (s) =>
  "f-" + s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const emptyValues = () => ({
  ...Object.fromEntries(FIELDS.map((k) => [k, ""])),
  ...DEFAULT_VALUES,
});
