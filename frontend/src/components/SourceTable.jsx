import { DataTable } from "./ui";
import { READONLY } from "../data/fields.js";

/** Compare les en-têtes sans tenir compte de la casse, des accents ni des espaces. */
const key = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Valeur de la colonne du Sheet dont l'en-tête correspond à l'attribut, ou undefined si absente. */
function lookup(values, attribute) {
  const k = key(attribute);
  const header = Object.keys(values).find((h) => key(h) === k);
  return header === undefined ? undefined : values[header];
}

export function SourceTable({ values }) {
  const rows = READONLY.map(([attribute, description]) => {
    const value = values ? lookup(values, attribute) : undefined;
    return [
      <span title={description || undefined}>{attribute}</span>,
      value === undefined ? <span className="cell-empty">{values ? "colonne absente" : "…"}</span> : value,
    ];
  });

  return (
    <>
      <div>
        <DataTable columns={["Attribut", "Valeur"]} rows={rows} />
      </div>
    </>
  );
}
