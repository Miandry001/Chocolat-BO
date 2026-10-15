import { useEffect, useState } from "react";
import { userErrorMessage } from "../utils/clientErrors.js";

/** Charge l'index de données `rowIndex` (en-têtes = index 0) depuis le Google Sheet. */
export function useSourceRow(rowIndex) {
  const [state, setState] = useState({ loading: true, error: null, first: 1, last: 0, values: null });

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));

    fetch(`/api/source?row=${rowIndex + 1}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw Object.assign(new Error(body.error ?? `Erreur ${res.status}`), body);
        setState({ loading: false, error: null, first: body.first - 1, last: body.last - 1, values: body.values, sourceWorkbookId: body.sourceWorkbookId, sourceWorkbookName: body.sourceWorkbookName });
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setState((s) => ({
          loading: false,
          error: userErrorMessage("source-row-load", e),
          first: e.first == null ? s.first : e.first - 1,
          last: e.last == null ? s.last : e.last - 1,
          values: null,
        }));
      });

    return () => ctrl.abort();
  }, [rowIndex]);

  return state;
}
