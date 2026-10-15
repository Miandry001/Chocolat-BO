import { useEffect, useMemo, useState } from "react";
import { useSyncEvents } from "../utils/syncEvents.js";

async function api(url, signal) {
  const response = await fetch(url, { credentials: "same-origin", signal });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
  return body.data;
}

export default function CatalogWindowPage() {
  const [sheets, setSheets] = useState([]);
  const [sheetName, setSheetName] = useState("");
  const [eanInput, setEanInput] = useState("");
  const [eanFilter, setEanFilter] = useState("");
  const [globalSearch, setGlobalSearch] = useState(false);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useSyncEvents("catalog-synced", () => setRefreshTrigger((t) => t + 1));
  useSyncEvents("catalog-sheet-updated", () => setRefreshTrigger((t) => t + 1));

  useEffect(() => {
    const controller = new AbortController();
    api("/api/v1/catalog/sheets", controller.signal)
      .then(({ sheets: available }) => {
        setSheets(available);
        setSheetName(available[0]?.name ?? "");
      })
      .catch((err) => { if (err.name !== "AbortError") setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshTrigger]);

  useEffect(() => {
    if (!sheetName && !globalSearch) return undefined;
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page) });
    if (eanFilter) query.set("ean", eanFilter);
    setLoading(true);
    setError("");
    const apiPath = globalSearch
      ? `/api/v1/catalog/search?${query}`
      : `/api/v1/catalog/sheets/${encodeURIComponent(sheetName)}?${query}`;
    api(apiPath, controller.signal)
      .then(setResult)
      .catch((err) => { if (err.name !== "AbortError") { setResult(null); setError(err.message); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sheetName, page, eanFilter, globalSearch, refreshTrigger]);

  const refreshSheets = async () => {
    setRefreshing(true);
    try {
      await api("/api/v1/catalog/sheets", new AbortController().signal);
      setSheetName(sheets[0]?.name ?? "");
    } catch (err) {
      setError(err.message || "Impossible de rafraîchir les onglets");
    } finally {
      setRefreshing(false);
    }
  };

  const pageCount = useMemo(() => Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 100))), [result]);
  const filterByEan = (event) => {
    event.preventDefault();
    const trimmed = eanInput.trim();
    if (!trimmed) return;
    setPage(0);
    setEanFilter(trimmed);
    setGlobalSearch(true);
  };
  const clearFilter = () => {
    setEanInput("");
    setEanFilter("");
    setPage(0);
    setGlobalSearch(false);
  };
  return (
    <main className="catalog-window">
      <header className="catalog-header">
        <div><p className="eyebrow">ChocoLogic</p><h1>Consultation des autres onglets</h1></div>
        <div className="catalog-actions">
          <button className="btn" type="button" onClick={refreshSheets} disabled={refreshing}>
            {refreshing ? "Actualisation…" : "Actualiser"}
          </button>
          <button className="btn" type="button" onClick={() => window.close()}>Fermer cette fenêtre</button>
        </div>
      </header>
      {!globalSearch && (
        <nav className="catalog-tabs" aria-label="Onglets du classeur">
          {sheets.map((sheet) => <button key={sheet.name} type="button" className={`catalog-tab${sheet.name === sheetName ? " is-active" : ""}`} aria-current={sheet.name === sheetName ? "page" : undefined} onClick={() => { setSheetName(sheet.name); setPage(0); }}>{sheet.name}<span>{sheet.rowCount}</span></button>)}
        </nav>
      )}
      <form className="catalog-filter" onSubmit={filterByEan}>
        <label className="field"><span>Filtrer par EAN</span><input className="control" value={eanInput} onChange={(event) => setEanInput(event.target.value)} placeholder="Saisir un EAN (recherche dans tous les onglets)" /></label>
        <button className="btn btn--primary" type="submit">Appliquer</button>
        {eanFilter && <button className="btn" type="button" onClick={clearFilter}>Effacer</button>}
        {globalSearch && eanFilter && <span className="catalog-mode-info">Recherche globale active (tous les onglets)</span>}
        {result && !globalSearch && <span className="catalog-count">{result.total} résultat{result.total > 1 ? "s" : ""}</span>}
        {result && globalSearch && <span className="catalog-count">{result.total} résultat{result.total > 1 ? "s" : ""} dans {sheets.length} onglet(s)</span>}
      </form>
      {error && <p className="source-error" role="alert">{error}</p>}
      {loading && <p role="status">Chargement…</p>}
      {!loading && !sheets.length && !error && <p>Aucun onglet secondaire importé. Importez à nouveau le classeur Excel pour les charger.</p>}
      {result && !error && (
        <>
          <div className="catalog-table-scroll">
            <table className="catalog-table">
              <thead>
                <tr>
                  {result.headers.map((header) => <th key={header}>{header}</th>)}
                  {globalSearch && <th>Source</th>}
                </tr>
              </thead>
              <tbody>
                {result.rows.length ? (
                  result.rows.map((row, index) => (
                    <tr key={`${index}-${row.Check_Digit ?? row.EAN13 ?? ""}`}>
                      {result.headers.map((header) => <td key={header}>{row[header] ?? ""}</td>)}
                      {globalSearch && <td>{row._sourceSheet ?? ""}</td>}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={result.headers.length + (globalSearch ? 1 : 0)} className="catalog-empty">
                      Aucune ligne ne correspond à ce filtre.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <footer className="catalog-pagination">
            <button className="btn" type="button" disabled={page <= 0 || loading} onClick={() => setPage((current) => current - 1)}>Précédent</button>
            <span>Page {page + 1} / {pageCount}</span>
            <button className="btn" type="button" disabled={page + 1 >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>Suivant</button>
          </footer>
        </>
      )}
    </main>
  );
}
