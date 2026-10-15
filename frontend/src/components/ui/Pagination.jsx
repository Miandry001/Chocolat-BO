import { useEffect, useState } from "react";

const SEARCH_DELAY_MS = 400;

/** Début du groupe qui contient l’index (groupes alignés : 1-50, 51-100…). */
const groupOf = (page, size) => Math.floor((page - 1) / size) * size + 1;

export function Pagination({ page, first = 1, last, onChange, disabled = false, groupSize = 50, label = "Page de distribution" }) {
  const [query, setQuery] = useState("");
  const [queryError, setQueryError] = useState(null);

  const firstGroup = groupOf(first, groupSize);
  const currentGroup = groupOf(page, groupSize);
  const groups = [];
  for (let start = firstGroup; start <= last; start += groupSize) {
    groups.push({ start, end: Math.min(start + groupSize - 1, last) });
  }

  const lines = [];
  for (let index = Math.max(currentGroup, first); index <= Math.min(currentGroup + groupSize - 1, last); index++) {
    lines.push(index);
  }

  const go = (p) => p !== page && p >= first && p <= last && onChange(p);

  function search(text) {
    if (!text.trim()) return setQueryError(null);
    const p = Number(text);
    if (!Number.isInteger(p) || p < first || p > last) return setQueryError(`Entre ${first} et ${last}`);
    setQueryError(null);
    go(p);
  }

  // Recherche dynamique : déclenchée quand l'utilisateur arrête de taper.
  useEffect(() => {
    const t = setTimeout(() => search(query), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (last < first) return null;

  return (
    <nav className="pagination" aria-label={label}>
      <p className="pagination__title">Page de distribution</p>
      <div className="pagination__hierarchy">
        <label className="pagination__select">
          <span>Groupe de lignes</span>
          <select
            className="control"
            value={currentGroup}
            onChange={(event) => go(Number(event.target.value))}
            disabled={disabled}
          >
            {groups.map(({ start, end }) => (
              <option key={start} value={start}>Ligne {start}-{end}</option>
            ))}
          </select>
        </label>
        <label className="pagination__select">
          <span>Ligne</span>
          <select
            className="control"
            value={page}
            onChange={(event) => go(Number(event.target.value))}
            disabled={disabled}
          >
            {lines.map((index) => (
              <option key={index} value={index}>Ligne {index}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="pagination__row">
        <label className="pagination__search">
          <span>Aller à l’index</span>
          <input
            className="control"
            inputMode="numeric"
            placeholder={`${first}–${last}`}
            value={query}
            aria-invalid={queryError ? true : undefined}
            onChange={(e) => setQuery(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && search(query)}
          />
        </label>
        <span className="pagination__info">
          {queryError ? <span className="pagination__error">{queryError}</span> : <>Index {page} sur {last} · ligne Sheets {page + 1}</>}
        </span>
      </div>
    </nav>
  );
}
