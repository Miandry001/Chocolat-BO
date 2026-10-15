import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { SaisieForm } from "../components/SaisieForm.jsx";
import { SourceTable } from "../components/SourceTable.jsx";
import { Field, Section, Select } from "../components/ui";
import { FIELDS, SCOPE_FIELD, fieldId } from "../data/fields.js";
import { useSourceRow } from "../data/useSourceRow.js";
import { userErrorMessage } from "../utils/clientErrors.js";
import { useSyncEvents } from "../utils/syncEvents.js";

const GROUP_SIZE = 50;
const GROUP_STATUSES = ["NON ASSIGNE", "EN COURS", "SAISIE TERMINEE", "VALIDEE"];

function groupStatusClass(status) {
  if (status === "NON ASSIGNE") return "is-unassigned";
  if (status === "SAISIE TERMINEE") return "is-complete";
  if (status === "VALIDEE" || status === "VALIDE") return "is-approved";
  return "is-in-progress";
}

function useGroupStatus(groupStart, enabled) {
  const [state, setState] = useState({ loading: enabled, status: null, error: null });

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, status: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ loading: true, status: null, error: null });
    fetch("/api/v1/distribution-groups", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) {
          throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
        }
        const group = (body.data.groups ?? []).find((item) => Number(item.groupStart) === groupStart);
        setState({ loading: false, status: group?.status ?? "NON ASSIGNE", error: null });
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setState({ loading: false, status: null, error: userErrorMessage("distribution-group-status-load", error) });
        }
      });
    return () => controller.abort();
  }, [groupStart, enabled]);

  return state;
}

function GroupNotAssigned({ groupStart }) {
  return (
    <main className="distribution-page">
      <h2 className="distribution-heading">Bloc {groupStart} — non assigné</h2>
      <p className="distribution-access-notice" role="alert">
        Ce bloc est verrouillé. Passez son statut à « EN COURS » sur la page de distribution pour accéder à ses lignes.
      </p>
      <Link className="btn btn--primary" to="/distribution">Retour aux blocs</Link>
    </main>
  );
}

function sourceValue(values, field) {
  const normalize = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const key = normalize(field);
  const match = Object.keys(values || {}).find((name) => normalize(name) === key);
  return match ? values[match] : "";
}

function Breadcrumbs({ items }) {
  return (
    <nav className="distribution-breadcrumbs" aria-label="Fil d’Ariane">
      {items.map((item, index) => (
        <span key={item.label}>
          {index > 0 && <span className="distribution-breadcrumbs__separator" aria-hidden="true">/</span>}
          {item.to ? <Link to={item.to}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

function LinePagination({ index, groupStart, groupEnd, last }) {
  const navigate = useNavigate();
  const goToLine = (target) => {
    const targetGroup = Math.floor((target - 1) / GROUP_SIZE) * GROUP_SIZE + 1;
    navigate(`/distribution/groupe/${targetGroup}/ligne/${target}`);
  };
  const lineOptions = Array.from({ length: groupEnd - groupStart + 1 }, (_, offset) => groupStart + offset)
    .map((line) => ({ value: line, label: `Ligne ${line}` }));

  return (
    <nav className="line-pager" aria-label="Navigation entre les lignes">
      <button
        className="line-pager__button"
        type="button"
        aria-label="Ligne précédente"
        title="Ligne précédente"
        disabled={index <= 1}
        onClick={() => goToLine(index - 1)}
      >
        ‹
      </button>
      <label className="line-pager__select">
        <span>Aller à une ligne</span>
        <Select
          value={index}
          options={lineOptions}
          onChange={(event) => goToLine(Number(event.target.value))}
        />
      </label>
      <span className="line-pager__count">{index} / {last}</span>
      <button
        className="line-pager__button"
        type="button"
        aria-label="Ligne suivante"
        title="Ligne suivante"
        disabled={index >= last}
        onClick={() => goToLine(index + 1)}
      >
        ›
      </button>
    </nav>
  );
}

function NotFoundPage() {
  return (
    <main className="distribution-page">
      <h2 className="distribution-heading">Page introuvable</h2>
      <Link to="/distribution">Retour à la distribution</Link>
    </main>
  );
}

export function DistributionHomePage({ onLoadGroupStatuses, onSaveGroupStatus }) {
  const { loading, error, last, sourceWorkbookName } = useSourceRow(1);
  const groupCount = Math.ceil(last / GROUP_SIZE);
  const [groupStatuses, setGroupStatuses] = useState({});
  const [selectedStatuses, setSelectedStatuses] = useState({});
  const [statusErrors, setStatusErrors] = useState({});
  const [savingGroup, setSavingGroup] = useState(null);
  const [statusFilter, setStatusFilter] = useState("TOUS");
  const [statusesLoading, setStatusesLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [workbookFilter, setWorkbookFilter] = useState("");
  const [sourceWorkbooks, setSourceWorkbooks] = useState([]);

  useSyncEvents("distribution-group-updated", () => setRefreshTrigger((t) => t + 1));
  useSyncEvents("source-imported", () => setRefreshTrigger((t) => t + 1));

   useEffect(() => {
    const controller = new AbortController();
    onLoadGroupStatuses({ signal: controller.signal, sourceWorkbookId: workbookFilter || undefined })
      .then((groups) => {
        const statuses = Object.fromEntries(groups.map(({ groupStart, status }) => [
          groupStart,
          status === "VALIDE" ? "VALIDEE" : status,
        ]));
        setGroupStatuses(statuses);
        setSelectedStatuses(statuses);
      })
      .catch((loadError) => {
        if (loadError.name !== "AbortError") {
          setStatusErrors({ load: userErrorMessage("distribution-group-status-load", loadError) });
        }
      })
      .finally(() => setStatusesLoading(false));
    fetch("/api/v1/source-workbooks", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        if (body.success) setSourceWorkbooks(body.data.workbooks ?? []);
      })
      .catch(() => {});
    return () => controller.abort();
   }, [onLoadGroupStatuses, refreshTrigger, workbookFilter]);

   const saveGroupStatus = async (groupStart) => {
    setSavingGroup(groupStart);
    setStatusErrors((current) => ({ ...current, [groupStart]: "" }));
    try {
      const nextStatus = selectedStatuses[groupStart] ?? groupStatuses[groupStart] ?? GROUP_STATUSES[0];
      if (groupStatuses[groupStart] === "NON ASSIGNE" && nextStatus !== "EN COURS") {
        throw new Error("Un bloc non assigné doit d’abord passer au statut EN COURS.");
      }
      const group = await onSaveGroupStatus(groupStart, nextStatus);
      setGroupStatuses((current) => ({ ...current, [groupStart]: group.status }));
      setSelectedStatuses((current) => ({ ...current, [groupStart]: group.status }));
    } catch (saveError) {
      const message = userErrorMessage("distribution-group-status-save", saveError);
      setStatusErrors((current) => ({ ...current, [groupStart]: message }));
    } finally {
      setSavingGroup(null);
    }
};

  if (last === 0) return (
    <main className="distribution-page">
      <section className="empty-state">
        <h2>Aucune donnée source importée</h2>
        <p>Importez d'abord un fichier source (Excel/CSV) via <strong>Données → Importer</strong> pour pouvoir configurer la distribution.</p>
        <Link to="/donnees" className="btn btn--primary">Aller à l'import</Link>
      </section>
    </main>
  );

  return (
    <main className="distribution-page">
      <h2 className="distribution-heading">Page de distribution</h2>
      {sourceWorkbookName && (
        <p className="distribution-workbook-name" role="status">Fichier source actuel : <strong>{sourceWorkbookName}</strong></p>
      )}
      {sourceWorkbooks.length > 0 && (
        <label className="distribution-workbook-filter">
          <span>Nom donnée source (classeur)</span>
          <select className="control" aria-label="Nom donnée source" value={workbookFilter} onChange={(event) => setWorkbookFilter(event.target.value)}>
            <option value="">Toutes données sources</option>
            {sourceWorkbooks.map((wb) => <option key={wb.id} value={wb.id}>{wb.name}</option>)}
          </select>
        </label>
      )}
      <label className="distribution-status-filter">
        <span>Filtrer les blocs par statut</span>
        <select className="control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="TOUS">Tous les statuts</option>
          {GROUP_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </label>
      {error && <p className="source-error" role="alert">{error}</p>}
      {statusErrors.load && <p className="source-error" role="alert">{statusErrors.load}</p>}
      {loading ? (
        <p role="status">Chargement des groupes…</p>
      ) : (
        <nav className="distribution-group-grid" aria-label="Groupes de lignes">
          {Array.from({ length: groupCount }, (_, index) => {
            const start = index * GROUP_SIZE + 1;
            const end = Math.min(start + GROUP_SIZE - 1, last);
            const status = groupStatuses[start] ?? "NON ASSIGNE";
            const showAllStatusesForWorkbook = workbookFilter !== "" && statusFilter === "TOUS";
            if (!showAllStatusesForWorkbook && statusFilter !== "TOUS" && statusFilter !== status) return null;
            return (
              <section className={`distribution-group-card ${groupStatusClass(status)}`} key={start}>
                {status === "NON ASSIGNE" || statusesLoading ? (
                  <div className="distribution-group-card__link is-disabled" aria-disabled="true">
                    <span className="distribution-group-link__title">Ligne {start}-{end}</span>
                    <span>{end - start + 1} lignes</span>
                    <span className="distribution-group-card__status">{statusesLoading ? "Chargement du statut…" : "NON ASSIGNE — accès bloqué"}</span>
                  </div>
                ) : (
                  <Link className="distribution-group-card__link" to={`/distribution/groupe/${start}`}>
                    <span className="distribution-group-link__title">Ligne {start}-{end}</span>
                    <span>{end - start + 1} lignes</span>
                    <span className="distribution-group-card__status">{status}</span>
                  </Link>
                )}
                <label className="distribution-group-card__control">
                  <span>Statut du bloc</span>
                  <select
                    className="control"
                    value={selectedStatuses[start] ?? status}
                    disabled={statusesLoading || savingGroup === start}
                    onChange={(event) => setSelectedStatuses((current) => ({ ...current, [start]: event.target.value }))}
                  >
                    {GROUP_STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <button className="btn distribution-group-card__save" type="button" disabled={statusesLoading || savingGroup === start} onClick={() => saveGroupStatus(start)}>
                  {savingGroup === start ? "Enregistrement…" : "Changer le statut"}
                </button>
                {statusErrors[start] && <p className="source-error" role="alert">{statusErrors[start]}</p>}
              </section>
            );
          })}
        </nav>
      )}
      {!loading && !statusesLoading && groupCount > 0 && !Array.from({ length: groupCount }, (_, index) => {
        const start = index * GROUP_SIZE + 1;
        const status = groupStatuses[start] ?? "NON ASSIGNE";
        const showAllStatusesForWorkbook = workbookFilter !== "" && statusFilter === "TOUS";
        return showAllStatusesForWorkbook || statusFilter === "TOUS" || statusFilter === status;
      }).some(Boolean) && <p role="status">Aucun bloc ne correspond à ce critère.</p>}
    </main>
  );
}

export function DistributionGroupPage() {
  const { groupStart: rawStart } = useParams();
  const groupStart = Number(rawStart);
  const validGroup = Number.isInteger(groupStart) && groupStart >= 1 && (groupStart - 1) % GROUP_SIZE === 0;
  const { loading, error, last } = useSourceRow(validGroup ? groupStart : 1);
  const groupAccess = useGroupStatus(groupStart, validGroup);

  if (!validGroup) return <NotFoundPage />;
  if (groupAccess.loading) return <p role="status">Vérification du statut du bloc…</p>;
  if (groupAccess.error) return <main className="distribution-page"><p className="source-error" role="alert">{groupAccess.error}</p><Link to="/distribution">Retour aux blocs</Link></main>;
  if (groupAccess.status === "NON ASSIGNE") return <GroupNotAssigned groupStart={groupStart} />;
  const groupEnd = Math.min(groupStart + GROUP_SIZE - 1, last);
  const indices = Array.from(
    { length: Math.max(0, groupEnd - groupStart + 1) },
    (_, offset) => groupStart + offset,
  );

  return (
    <main className="distribution-page">
      <Breadcrumbs items={[{ label: "Page de distribution", to: "/distribution" }, { label: `Ligne ${groupStart}-${groupEnd}` }]} />
      <h2 className="distribution-heading">Ligne {groupStart}-{groupEnd}</h2>
      {error && <p className="source-error" role="alert">{error}</p>}
      {loading ? (
        <p role="status">Chargement du groupe…</p>
      ) : indices.length === 0 ? (
        <NotFoundPage />
      ) : (
        <nav className="distribution-line-grid" aria-label={`Lignes ${groupStart} à ${groupEnd}`}>
          {indices.map((index) => (
            <Link className="distribution-line-link" key={index} to={`/distribution/groupe/${groupStart}/ligne/${index}`}>
              Ligne {index}
            </Link>
          ))}
        </nav>
      )}
    </main>
  );
}

export function DistributionLinePage({ storageMode, onSave }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { groupStart: rawStart, index: rawIndex } = useParams();
  const groupStart = Number(rawStart);
  const index = Number(rawIndex);
  const validGroup = Number.isInteger(groupStart) && groupStart >= 1 && (groupStart - 1) % GROUP_SIZE === 0;
  const validIndex = Number.isInteger(index) && index >= groupStart && index < groupStart + GROUP_SIZE;
  const validRoute = validGroup && validIndex;
  const source = useSourceRow(validRoute ? index : 1);
  const groupAccess = useGroupStatus(groupStart, validRoute);
  const [savedTreatment, setSavedTreatment] = useState({ loading: true, error: null, treatment: null });
  const [treatmentReload, setTreatmentReload] = useState(0);
  const [saveResult, setSaveResult] = useState(null);
  const [savedLineNotice, setSavedLineNotice] = useState(location.state?.savedLineNotice ?? null);
  const [scope, setScope] = useState("");
  const [scopeSaving, setScopeSaving] = useState(false);
  const [outOfScopeSaved, setOutOfScopeSaved] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useSyncEvents("treatment-updated", (data) => {
    if (data.sourceRow === index + 1) {
      setRefreshTrigger((t) => t + 1);
    }
  });

  useEffect(() => {
    setSaveResult(null);
    setSavedLineNotice(location.state?.savedLineNotice ?? null);
    setScope("");
    setScopeSaving(false);
    setOutOfScopeSaved(false);
  }, [index]);

  useEffect(() => {
    if (!validRoute) return undefined;
    const controller = new AbortController();
    setSavedTreatment({ loading: true, error: null, treatment: null });
    fetch(`/api/v1/data/row/${index + 1}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) {
          throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
        }
        const treatment = body.data.treatment;
        setSavedTreatment({ loading: false, error: null, treatment });
        if (treatment) setScope(treatment.currentData[SCOPE_FIELD] || "OUI");
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setSavedTreatment({
            loading: false,
            error: userErrorMessage("saved-treatment-load", error),
            treatment: null,
          });
        }
      });
    return () => controller.abort();
  }, [index, treatmentReload, validRoute, refreshTrigger]);

  const initialValues = useMemo(() => ({
    EAN13: sourceValue(source.values, "EAN13"),
    Company: sourceValue(source.values, "Company"),
    ...(savedTreatment.treatment?.currentData ?? {}),
  }), [source.values, savedTreatment.treatment]);

if (!validRoute) return <NotFoundPage />;
  if (groupAccess.loading) return <p role="status">Vérification du statut du bloc…</p>;
  if (groupAccess.error) return <main className="distribution-page"><p className="source-error" role="alert">{groupAccess.error}</p><Link to="/distribution">Retour aux blocs</Link></main>;
  if (groupAccess.status === "NON ASSIGNE") return <GroupNotAssigned groupStart={groupStart} />;
  if (source.loading) return <p role="status">Chargement de la ligne {index}…</p>;
  if (source.error) return <p className="source-error" role="alert">{source.error}</p>;
  if (source.last === 0) return (
    <main className="distribution-page">
      <section className="empty-state">
        <h2>Aucune donnée source importée</h2>
        <p>Importez d'abord un fichier source (Excel/CSV) via <strong>Données → Importer</strong> pour pouvoir saisir les lignes.</p>
        <Link to="/donnees" className="btn btn--primary">Aller à l'import</Link>
      </section>
    </main>
  );
  if (index > source.last) return <NotFoundPage />;

  const groupEnd = Math.min(groupStart + GROUP_SIZE - 1, source.last);
  const saveOutOfScope = async () => {
    setScopeSaving(true);
    setOutOfScopeSaved(false);
    setSaveResult({ message: "Enregistrement de la ligne hors scope…" });
    const blankValues = Object.fromEntries(FIELDS.map((name) => [name, ""]));
    blankValues[SCOPE_FIELD] = "NON";
    try {
      setSaveResult({ message: await onSave(index, blankValues) });
      setOutOfScopeSaved(true);
    } catch (error) {
      setSaveResult({ error: true, message: userErrorMessage("out-of-scope-save", error) });
    } finally {
      setScopeSaving(false);
    }
  };

  const handleScopeChange = (event) => {
    const selected = event.target.value;
    setScope(selected);
    setSaveResult(null);
    setOutOfScopeSaved(false);
    if (selected === "NON") saveOutOfScope();
  };

  const nextIndex = index + 1;
  const nextGroupStart = Math.floor((nextIndex - 1) / GROUP_SIZE) * GROUP_SIZE + 1;
  const handleSave = async (values) => {
    setSaveResult({ message: "Validation de la saisie…" });
    try {
      await onSave(index, { ...values, [SCOPE_FIELD]: "OUI" }, true);
      const notice = { index, groupStart };
      setSaveResult(null);
      if (nextIndex <= source.last) {
        navigate(`/distribution/groupe/${nextGroupStart}/ligne/${nextIndex}`, { state: { savedLineNotice: notice } });
      } else {
        setSavedLineNotice(notice);
      }
    } catch (error) {
      setSaveResult({ error: true, message: userErrorMessage("treatment-submit", error) });
    }
  };

  const handleFormChange = () => {
    setSaveResult(null);
    setSavedLineNotice(null);
  };
  const lineSaved = scope === "NON"
    ? outOfScopeSaved
    : scope === "OUI" && savedLineNotice?.index === index;

  return (
    <main className="distribution-page">
      <Breadcrumbs items={[
        { label: "Page de distribution", to: "/distribution" },
        { label: `Ligne ${groupStart}-${groupEnd}`, to: `/distribution/groupe/${groupStart}` },
        { label: `Ligne ${index}` },
      ]} />
      <LinePagination index={index} groupStart={groupStart} groupEnd={groupEnd} last={source.last} />
      <h2 className="distribution-heading">Ligne {index}</h2>
      <div className="layout">
        <Section title="Données source — lecture seule" sticky>
          <SourceTable values={source.values} />
        </Section>
        <Section title="Saisie">
          <p role="status">
            {storageMode === "mongodb"
              ? "Stockage actif : MongoDB."
              : storageMode === "memory"
                ? "Stockage mémoire temporaire : les données ne sont pas persistantes."
                : storageMode === "unavailable"
                  ? "Stockage indisponible : impossible de vérifier l’API."
                  : "Vérification du stockage…"}
          </p>
          {saveResult && <p role={saveResult.error ? "alert" : "status"}>{saveResult.message}</p>}
          {savedLineNotice && (
            <div className="line-saved-alert" role="status">
              <span className="line-saved-alert__icon" aria-hidden="true">✓</span>
              <span>
                La ligne{" "}
                <Link to={`/distribution/groupe/${savedLineNotice.groupStart}/ligne/${savedLineNotice.index}`}>
                  {savedLineNotice.index}
                </Link>{" "}
                a bien été saisie.
              </span>
            </div>
          )}
          {savedTreatment.loading && <p role="status">Chargement de la saisie enregistrée…</p>}
          {savedTreatment.error && <p role="alert">{savedTreatment.error}</p>}
          {savedTreatment.error && (
            <button className="btn" type="button" onClick={() => setTreatmentReload((attempt) => attempt + 1)}>
              Réessayer le chargement
            </button>
          )}
          {savedTreatment.treatment && (
            <p role="status">
              Données enregistrées — statut {savedTreatment.treatment.status}, version {savedTreatment.treatment.currentVersion}.
            </p>
          )}
          {savedTreatment.treatment?.qualityFeedback?.message && (
            <div className="quality-feedback" role="alert">
              <strong>Retour du contrôle qualité</strong>
              <p>{savedTreatment.treatment.qualityFeedback.message}</p>
            </div>
          )}
          <div className="scope-decision">
            <Field id={fieldId(SCOPE_FIELD)} label="Est-ce que cette ligne est dans le scope ?" required>
              <Select
                id={fieldId(SCOPE_FIELD)}
                name={SCOPE_FIELD}
                value={scope}
                options={["", "OUI", "NON"]}
                onChange={handleScopeChange}
                disabled={scopeSaving}
                required
              />
            </Field>
            {scope === "NON" && lineSaved && nextIndex <= source.last && (
              <Link className="btn btn--primary distribution-next" to={`/distribution/groupe/${nextGroupStart}/ligne/${nextIndex}`}>
                Ligne suivante
              </Link>
            )}
            {lineSaved && nextIndex > source.last && (
              <p role="status">Fin de la distribution.</p>
            )}
            {scope === "NON" && saveResult?.error && (
              <button className="btn" type="button" disabled={scopeSaving} onClick={saveOutOfScope}>
                Réessayer l’enregistrement
              </button>
            )}
          </div>
            {!savedTreatment.loading && <SaisieForm
            key={index}
            onSubmit={handleSave}
            onDirty={handleFormChange}
            disabled={scope !== "OUI"}
            clearValues={scope === "NON"}
            outOfScope={scope === "NON"}
            initialValues={initialValues}
          />}
        </Section>
      </div>
    </main>
  );
}

export { NotFoundPage };
