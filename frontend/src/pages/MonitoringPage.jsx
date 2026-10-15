import { useEffect, useState } from "react";

function MetricCard({ label, value, detail, tone = "" }) {
  return (
    <article className={`monitoring-metric${tone ? ` monitoring-metric--${tone}` : ""}`}>
      <span className="monitoring-metric__label">{label}</span>
      <strong className="monitoring-metric__value">{value}</strong>
      <small className="monitoring-metric__detail">{detail}</small>
    </article>
  );
}

export default function MonitoringPage({ storageMode }) {
  const [apiState, setApiState] = useState({ status: "checking", latencyMs: null });

  useEffect(() => {
    let active = true;
    let timer;
    const controller = new AbortController();

    async function checkApi() {
      const startedAt = performance.now();
      try {
        const response = await fetch("/api/v1/health", { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error("Health check failed");
        if (active) setApiState({ status: "online", latencyMs: Math.round(performance.now() - startedAt) });
      } catch (error) {
        if (active && error.name !== "AbortError") setApiState({ status: "offline", latencyMs: null });
      } finally {
        if (active) timer = window.setTimeout(checkApi, 30_000);
      }
    }

    checkApi();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const storageLabel = storageMode === "mongodb" ? "MongoDB" : "Indisponible";

  return (
    <main className="page-shell monitoring-page">
      <section className="hero-card monitoring-hero">
        <div>
          <p className="eyebrow">Observabilité</p>
          <h1>Monitoring</h1>
          <p>Vue d’ensemble du site, de la base de données et de la sécurité.</p>
        </div>
      </section>

      <section className="panel monitoring-section" aria-labelledby="monitoring-site-title">
        <div className="panel__header"><h2 id="monitoring-site-title">État du site</h2><span className={`monitoring-status monitoring-status--${apiState.status}`}><i />{apiState.status === "online" ? "API connectée" : apiState.status === "offline" ? "API inaccessible" : "Vérification…"}</span></div>
        <div className="monitoring-metrics">
          <MetricCard label="Latence API en direct" value={apiState.latencyMs == null ? "—" : `${apiState.latencyMs} ms`} detail="Dernière vérification" tone={apiState.status === "offline" ? "danger" : ""} />
        </div>
      </section>

      <section className="panel monitoring-section" aria-labelledby="monitoring-db-title">
        <div className="panel__header"><h2 id="monitoring-db-title">Base de données</h2><span className="monitoring-storage-mode">Stockage actif : {storageLabel}</span></div>
        <p>Les métriques de ressources et d’erreurs de la base ne sont pas collectées par cette application.</p>
      </section>

      <section className="panel monitoring-section" aria-labelledby="monitoring-security-title">
        <div className="panel__header"><h2 id="monitoring-security-title">Sécurité de l’application</h2></div>
        <p>Aucun scanner de vulnérabilités ni tableau de bord de sécurité n’est connecté. Cette page ne confirme pas l’absence de failles.</p>
      </section>
    </main>
  );
}
