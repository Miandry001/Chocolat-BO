import { useEffect, useMemo, useState } from "react";
import { useSyncEvents } from "../utils/syncEvents.js";

const EMPTY_PERFORMANCE = {
  validatedLines: 0,
  correctedReturns: 0,
  qualityPercent: null,
  averageDailyProductivity: 0,
  lowestDay: null,
  bestDay: null,
  daily: [],
};

function dateInNairobi(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function displayDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeZone: "Africa/Nairobi",
  }).format(new Date(`${value}T00:00:00+03:00`));
}

function downloadCsv(filename, rows) {
  const content = rows
    .map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(";"))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function QualityDonut({ value, validatedLines, correctedReturns }) {
  const quality = value ?? 0;
  return (
    <div className="quality-donut-wrap">
      <div
        className="quality-donut"
        style={{ "--quality-value": `${quality}%` }}
        role="img"
        aria-label={value == null ? "Aucune ligne validée, taux qualité non calculable" : `Qualité ${quality} pour cent`}
      >
        <div className="quality-donut__center">
          <strong>{value == null ? "—" : `${quality}%`}</strong>
          <span>qualité</span>
        </div>
      </div>
      <p className="quality-donut__caption">
        {validatedLines} ligne{validatedLines > 1 ? "s" : ""} validée{validatedLines > 1 ? "s" : ""} · {correctedReturns} retour{correctedReturns > 1 ? "s" : ""} rectifié{correctedReturns > 1 ? "s" : ""}
      </p>
    </div>
  );
}

function DailyProductivityChart({ daily }) {
  const visibleDays = daily.slice(-14);
  const peak = Math.max(1, ...visibleDays.map(({ validatedLines }) => validatedLines));
  if (!visibleDays.length) return <p className="statistics-empty">Aucune ligne validée sur cette période.</p>;

  return (
    <div className="productivity-chart" aria-label="Productivité journalière, 14 jours maximum">
      {visibleDays.map(({ date, validatedLines }) => (
        <div className="productivity-chart__day" key={date} title={`${displayDate(date)} : ${validatedLines} lignes`}>
          <span className="productivity-chart__value">{validatedLines}</span>
          <div className="productivity-chart__track">
            <span style={{ height: `${Math.max(4, (validatedLines / peak) * 100)}%` }} />
          </div>
          <span className="productivity-chart__date">{new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))}</span>
        </div>
      ))}
    </div>
  );
}

function KpiDetail({ agent, period, onBack }) {
  const performance = agent.performance;
  return (
    <section className="panel agent-kpi-detail" aria-labelledby="agent-kpi-title">
      <div className="panel__header">
        <div>
          {onBack && <button className="btn btn--ghost agent-kpi-back" type="button" onClick={onBack}>← Retour aux agents</button>}
          <p className="eyebrow">KPI agent · {period}</p>
          <h2 id="agent-kpi-title">{agent.fullName}</h2>
        </div>
      </div>

      <div className="agent-kpi-overview">
        <QualityDonut
          value={performance.qualityPercent}
          validatedLines={performance.validatedLines}
          correctedReturns={performance.correctedReturns}
        />
        <div className="agent-kpi-metrics">
          <article className="metric-card">
            <span>Lignes validées</span>
            <strong>{performance.validatedLines.toLocaleString("fr-FR")}</strong>
            <small>Soumissions initiales enregistrées</small>
          </article>
          <article className="metric-card">
            <span>Retours rectifiés</span>
            <strong>{performance.correctedReturns.toLocaleString("fr-FR")}</strong>
            <small>Comptés après renvoi de la ligne corrigée</small>
          </article>
          <article className="metric-card">
            <span>Productivité moyenne</span>
            <strong>{performance.averageDailyProductivity.toLocaleString("fr-FR")} / jour</strong>
            <small>Moyenne des jours avec validation</small>
          </article>
        </div>
      </div>

      <div className="agent-kpi-best-days">
        <article className="metric-card">
          <span>Jour le moins productif</span>
          <strong>{performance.lowestDay?.validatedLines ?? 0} ligne{performance.lowestDay?.validatedLines === 1 ? "" : "s"}</strong>
          <small>{displayDate(performance.lowestDay?.date)}</small>
        </article>
        <article className="metric-card">
          <span>Jour le plus performant</span>
          <strong>{performance.bestDay?.validatedLines ?? 0} ligne{performance.bestDay?.validatedLines === 1 ? "" : "s"}</strong>
          <small>{displayDate(performance.bestDay?.date)}</small>
        </article>
      </div>

      <div className="agent-kpi-chart-section">
        <h3>Productivité par jour</h3>
        <DailyProductivityChart daily={performance.daily} />
      </div>
    </section>
  );
}

export default function StatisticsPage({ users = [], user }) {
  const today = dateInNairobi(new Date());
  const monthAgo = new Date(`${today}T00:00:00+03:00`);
  monthAgo.setUTCDate(monthAgo.getUTCDate() - 29);
  const [startDate, setStartDate] = useState(dateInNairobi(monthAgo));
  const [endDate, setEndDate] = useState(today);
  const [appliedRange, setAppliedRange] = useState({ startDate: dateInNairobi(monthAgo), endDate: today });
  const [performanceByActor, setPerformanceByActor] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState(user?.role === "AGENT" ? String(user.id) : null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exportType, setExportType] = useState("excel");
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useSyncEvents("treatment-updated", () => setRefreshTrigger((t) => t + 1));

  useEffect(() => {
    if (user?.role === "AGENT") setSelectedAgentId(String(user.id));
  }, [user?.id, user?.role]);

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    let active = true;

    const load = async () => {
      if (active) setLoading(true);
      try {
        const query = new URLSearchParams({ from: appliedRange.startDate, to: appliedRange.endDate });
        const response = await fetch(`/api/v1/stats/agents?${query}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
        if (active) {
          setPerformanceByActor(body.data.agents ?? []);
          setError("");
        }
      } catch (loadError) {
        if (active && loadError.name !== "AbortError") setError(loadError.message || "Statistiques indisponibles");
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(load, 30_000);
        }
      }
    };

    load();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [appliedRange, refreshTrigger]);

  const agentProfiles = useMemo(() => {
    const profiles = user?.role === "AGENT"
      ? [users.find((candidate) => String(candidate.id) === String(user.id)) ?? user]
      : users.filter((candidate) => candidate.role === "AGENT");
    const performance = new Map(performanceByActor.map((entry) => [String(entry.actorId), entry]));
    return profiles.map((profile) => ({
      ...profile,
      fullName: profile.fullName || `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || profile.login || "Agent",
      performance: { ...EMPTY_PERFORMANCE, ...(performance.get(String(profile.id)) ?? {}) },
    }));
  }, [users, user, performanceByActor]);

  const selectedAgent = agentProfiles.find((agent) => String(agent.id) === String(selectedAgentId));
  const invalidRange = startDate > endDate;
  const period = `${displayDate(appliedRange.startDate)} – ${displayDate(appliedRange.endDate)}`;
  const canExport = user?.role === "ADMIN" || user?.role === "SUPERVISEUR";

  const applyRange = () => {
    if (!invalidRange) setAppliedRange({ startDate, endDate });
  };

  const exportReport = () => {
    const header = exportType === "powerbi"
      ? ["agent_id", "nom", "prenom", "date", "lignes_validees", "retours_rectifies"]
      : ["agent_id", "nom", "prenom", "periode", "lignes_validees", "retours_rectifies", "qualite_pct", "productivite_moyenne_jour", "jour_min", "jour_max"];
    const rows = agentProfiles.flatMap((agent) => {
      const days = exportType === "powerbi" ? agent.performance.daily : [null];
      return (days.length ? days : exportType === "powerbi" ? [{ date: "", validatedLines: 0, correctedReturns: 0 }] : [null]).map((day) => exportType === "powerbi" ? [
        agent.id,
        agent.lastName ?? "",
        agent.firstName ?? "",
        day.date,
        day.validatedLines,
        day.correctedReturns ?? 0,
      ] : [
        agent.id,
        agent.lastName ?? "",
        agent.firstName ?? "",
        `${appliedRange.startDate} → ${appliedRange.endDate}`,
        agent.performance.validatedLines,
        agent.performance.correctedReturns,
        agent.performance.qualityPercent ?? "",
        agent.performance.averageDailyProductivity,
        agent.performance.lowestDay?.date ?? "",
        agent.performance.bestDay?.date ?? "",
      ]);
    });
    const suffix = exportType === "powerbi" ? "power-bi" : "excel";
    downloadCsv(`kpi-agents-${suffix}.csv`, [header, ...rows]);
  };

  return (
    <main className="page-shell statistics-page">
      <section className="panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Production réelle</p>
            <h2>Statistiques de productivité</h2>
          </div>
          <div className="statistics-filters">
            <label className="field">
              <span>Date de début</span>
              <input className="control" type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label className="field">
              <span>Date de fin</span>
              <input className="control" type="date" value={endDate} min={startDate} max={today} onChange={(event) => setEndDate(event.target.value)} />
            </label>
            <button className="btn btn--primary" type="button" disabled={invalidRange || loading} onClick={applyRange}>Appliquer</button>
            {canExport && (
              <label className="field statistics-export-select">
                <span>Format d’export</span>
                <select className="control" value={exportType} onChange={(event) => setExportType(event.target.value)}>
                  <option value="excel">Excel (CSV)</option>
                  <option value="powerbi">Power BI (CSV)</option>
                </select>
              </label>
            )}
            {canExport && <button className="btn" type="button" disabled={loading || agentProfiles.length === 0} onClick={exportReport}>Télécharger</button>}
          </div>
        </div>
        <p className="statistics-period">Période affichée : {period} · actualisation automatique toutes les 30 secondes.</p>
        {invalidRange && <p className="source-error" role="alert">La date de début doit précéder la date de fin.</p>}
        {error && <p className="source-error" role="alert">Impossible de charger les KPI réels : {error}</p>}
      </section>

      {loading && <p role="status">Chargement des statistiques…</p>}
      {!loading && !error && user?.role !== "AGENT" && (
        <section className="panel">
          <div className="panel__header"><h2>Agents</h2><span>{agentProfiles.length} agent{agentProfiles.length === 1 ? "" : "s"}</span></div>
          {agentProfiles.length === 0 ? (
            <p className="statistics-empty">Aucun agent n’est créé dans le système.</p>
          ) : (
            <div className="statistics-agent-list">
              {agentProfiles.map((agent) => (
                <button
                  className={`statistics-agent-row${String(selectedAgentId) === String(agent.id) ? " is-selected" : ""}`}
                  key={agent.id}
                  type="button"
                  aria-pressed={String(selectedAgentId) === String(agent.id)}
                  onClick={() => setSelectedAgentId(String(agent.id))}
                >
                  <span className="statistics-agent-row__name">{agent.fullName}</span>
                  <span>{agent.performance.validatedLines} lignes · {agent.performance.correctedReturns} retours rectifiés</span>
                  <span className="statistics-agent-row__quality">{agent.performance.qualityPercent == null ? "—" : `${agent.performance.qualityPercent}%`}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {!loading && !error && selectedAgent && (
        <KpiDetail agent={selectedAgent} period={period} onBack={canExport ? () => setSelectedAgentId(null) : undefined} />
      )}
      {!loading && !error && !selectedAgent && canExport && agentProfiles.length > 0 && (
        <p className="statistics-empty">Choisis un agent pour ouvrir son KPI détaillé.</p>
      )}
    </main>
  );
}
