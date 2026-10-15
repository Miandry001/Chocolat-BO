import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useSyncEvents, useSyncConnection, setSyncToken, fetchSync } from "./utils/syncEvents.js";
import { openCatalogWindow, closeCatalogWindow } from "./config.js";
import {
  DistributionGroupPage,
  DistributionHomePage,
  DistributionLinePage,
  NotFoundPage,
} from "./pages/DistributionPages.jsx";
import MonitoringPage from "./pages/MonitoringPage.jsx";
import StatisticsPage from "./pages/StatisticsPage.jsx";
import CatalogWindowPage from "./pages/CatalogWindowPage.jsx";
import { DocsPanel } from "./components/ui/DocsPanel.jsx";
import { userErrorMessage } from "./utils/clientErrors.js";
import { buildFilteredAgentRows } from "./utils/agentStatistics.js";

function readCookie(name) {
  const prefix = `${name}=`;
  const entry = document.cookie.split(";").map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ";" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (char === '"' && quoted && clean[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && clean[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() ?? []).map((value) => value.trim());
  if (!headers.length || headers.some((value) => !value) || new Set(headers).size !== headers.length) {
    throw new Error("La première ligne doit contenir des en-têtes uniques et non vides.");
  }
  return rows.filter((values) => values.some((value) => value.trim())).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function rowsToObjects(rows) {
  const rawHeaders = (rows.shift() ?? []).map((value) => String(value ?? "").trim());
  const width = rows.reduce((max, row) => Math.max(max, row.length), rawHeaders.length);
  const headers = [];
  const seen = new Set();

  for (let index = 0; index < width; index += 1) {
    let header = rawHeaders[index] ?? "";
    const hasData = rows.some((row) => String(row[index] ?? "").trim() !== "");
    if (!header && !hasData) continue;
    if (!header) header = `COLONNE_${index + 1}`;
    if (seen.has(header)) {
      throw new Error(`L’en-tête « ${header} » apparaît plusieurs fois. Renommez les colonnes en double puis réessayez.`);
    }
    seen.add(header);
    headers.push({ name: header, index });
  }

  if (!headers.length) {
    throw new Error("Aucun en-tête exploitable n’a été trouvé sur la première ligne de l’onglet.");
  }

  return rows
    .filter((values) => values.some((value) => String(value ?? "").trim()))
    .map((values) => Object.fromEntries(headers.map(({ name, index }) => [name, String(values[index] ?? "").trim()])));
}

async function parseXlsx(file) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets.find((sheet) =>
    sheet.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === "referent",
  ) ?? workbook.worksheets[0];
  if (!worksheet) throw new Error("Le classeur ne contient aucun onglet.");
  const parseSheet = (sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      rows.push(Array.from({ length: row.cellCount }, (_, index) => row.getCell(index + 1).text ?? ""));
    });
    if (!rows.length) return [];
    return rowsToObjects(rows);
  };
  const sourceRows = parseSheet(worksheet);
  if (!sourceRows.length) throw new Error("Le fichier ne contient aucune ligne de données.");
  const catalogSheets = workbook.worksheets
    .filter((sheet) => sheet.id !== worksheet.id)
    .map((sheet) => ({ name: sheet.name, rows: parseSheet(sheet) }))
    .filter((sheet) => sheet.rows.length > 0);
  return { sourceRows, catalogSheets };
}

async function authenticatedFetch(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.method && !["GET", "HEAD", "OPTIONS"].includes(options.method.toUpperCase())) {
    headers.set("X-CSRF-Token", readCookie("chocolat_csrf"));
  }
  return fetch(url, { ...options, headers, credentials: "same-origin" });
}

function getRoleLabel(role) {
  if (role === "SUPERVISEUR") return "Superviseur";
  if (role === "ADMIN") return "Admin";
  return "Agent";
}

function getRoleOptions() {
  return ["", "AGENT", "SUPERVISEUR", "ADMIN"];
}

function formatEAT(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Africa/Nairobi",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function formatDateInput(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getNavigation(role) {
  const base = [
    { to: "/accueil", label: "Accueil" },
    { to: "/distribution", label: "Distribution" },
    { to: "/statistiques", label: "Statistiques" },
    { to: "/qualite", label: "Contrôle Qualité" },
    { to: "/catalogue", label: "Catalogue" },
  ];

  if (role === "SUPERVISEUR" || role === "ADMIN") {
    base.push({ to: "/donnees", label: "Données" });
  }

  if (role === "ADMIN") {
    base.push({ to: "/utilisateurs", label: "Gestion utilisateurs" });
    base.push({ to: "/connexion-sheet", label: "Données source" });
    base.push({ to: "/monitoring", label: "Monitoring" });
  } else if (role === "SUPERVISEUR") {
    base.push({ to: "/utilisateurs", label: "Gestion utilisateurs" });
  }

  return base;
}

function NotificationBell({ notifications, error }) {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (ref.current && !ref.current.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="notification" ref={ref}>
      <button className="notification__button" type="button" aria-label="Notifications" onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true">🔔</span>
        {notifications.length > 0 && <span className="notification__badge">{notifications.length}</span>}
      </button>
      {open && (
        <div className="notification__panel" role="dialog" aria-label="Notifications">
          <div className="notification__header">Notifications</div>
          {error ? (
            <p className="notification__empty" role="alert">{error}</p>
          ) : notifications.length === 0 ? (
            <p className="notification__empty">Aucune notification.</p>
          ) : (
            <ul className="notification__list">
              {notifications.map((item) => (
                <li key={item.id} className="notification__item">
                  <div className="notification__meta">
                    <button
                      className="notification__title"
                      type="button"
                      aria-expanded={expandedId === item.id}
                      onClick={() => setExpandedId((current) => current === item.id ? null : item.id)}
                    >
                      {item.text}
                    </button>
                    <span>{new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Nairobi" }).format(new Date(item.date))}</span>
                  </div>
                  {expandedId === item.id && <p className="notification__message">{item.message}</p>}
                  <Link to={item.link} onClick={() => setOpen(false)}>Accéder à la ligne concernée</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AppShell({ user, notifications, notificationError, onLogout, children }) {
  const [now, setNow] = useState(new Date());
  const navItems = useMemo(() => getNavigation(user.role), [user.role]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="app-shell wrap">
      <header className="topbar">
        <Link className="brand-link" to="/accueil" aria-label="ChocoLogic, accueil">
          <img src="/chocologo.png" alt="" />
        </Link>
        <nav className="main-nav" aria-label="Navigation principale">
          {navItems.map(({ to, label }) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "is-active" : "") }>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar__tools">
          <NotificationBell notifications={notifications} error={notificationError} />
          <button className="btn btn--ghost" type="button" onClick={() => openCatalogWindow().catch(() => {})}>
            Afficher les onglets
          </button>
          <button className="btn btn--ghost" type="button" onClick={onLogout}>Déconnexion</button>
        </div>
      </header>

      <div className="clock-block" aria-live="polite">
        <span className="clock-block__label">Heure actuelle</span>
        <strong>{formatEAT(now)}</strong>
      </div>

      {children}
      <DocsPanel />
    </div>
  );
}

function getSummaryCards(summary) {
  const validatedLines = summary?.validatedLines ?? 0;
  const returnsReceived = summary?.returnsReceived ?? 0;
  const connectedHours = summary?.connectedHours ?? 0;
  const yesterdayProduction = summary?.yesterdayProduction ?? 0;
  return [
    { label: "Lignes validées", value: validatedLines.toLocaleString("fr-FR"), trend: "Soumissions enregistrées" },
    { label: "Retours reçus", value: returnsReceived.toLocaleString("fr-FR"), trend: "Retours CQ enregistrés" },
    { label: "Temps moyen connecté", value: `${connectedHours}h`, trend: connectedHours ? "Mesuré" : "Non mesuré" },
    { label: "Production J-1", value: yesterdayProduction.toLocaleString("fr-FR"), trend: "Soumissions de la veille" },
  ];
}

function HomePage({ user, storageMode }) {
  const fullName = user.fullName?.trim() || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.login;
  const [summary, setSummary] = useState({ validatedLines: 0, returnsReceived: 0, connectedHours: 0, yesterdayProduction: 0 });
  const [summaryError, setSummaryError] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useSyncEvents("treatment-updated", () => setRefreshTrigger((t) => t + 1));
  useSyncEvents("quality-feedback-added", () => setRefreshTrigger((t) => t + 1));

  useEffect(() => {
    let active = true;
    const loadSummary = async () => {
      try {
        const response = await fetch("/api/v1/stats/summary");
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error("Résumé indisponible");
        if (active) {
          setSummary(body.data);
          setSummaryError(false);
        }
      } catch {
        if (active) setSummaryError(true);
      }
    };
    loadSummary();
    const timer = window.setInterval(loadSummary, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshTrigger]);

  const summaryCards = getSummaryCards(summary);

  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">Bienvenue</p>
        <h1>Bienvenue, {fullName}</h1>
        <p>Rôle : {getRoleLabel(user.role)}</p>
      </section>

      <section className="panel">
        <div className="panel__header">
          <h2>Suivi de production</h2>
        </div>
        <p className="summary-source" role={summaryError ? "alert" : "status"}>
          {summaryError
            ? "Indicateurs indisponibles : impossible de lire les enregistrements réels."
            : storageMode === "sqlite"
              ? "Production suivie depuis la base SQLite de ce serveur."
              : storageMode === "mongodb"
                ? "Production suivie depuis MongoDB."
              : storageMode === "memory"
                ? "Stockage mémoire temporaire : les données ne sont pas persistantes."
                : "Connexion au stockage en cours…"}
        </p>
        <div className="kpi-grid">
          {summaryCards.map((item) => (
            <div key={item.label} className="metric-card">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.trend}</small>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function QualityPage({ users = [], user }) {
  const navigate = useNavigate();
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [feedbackByRow, setFeedbackByRow] = useState({});
  const [sendingRow, setSendingRow] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [expandedHistory, setExpandedHistory] = useState({});
  const [historyByRow, setHistoryByRow] = useState({});
  const [historyLoading, setHistoryLoading] = useState({});

  useSyncEvents("treatment-updated", () => setRefreshTrigger((t) => t + 1));
  useSyncEvents("quality-feedback-added", () => setRefreshTrigger((t) => t + 1));
  const [filters, setFilters] = useState({
    query: "",
    firstName: "",
    lastName: "",
    role: "",
    startDate: "",
    endDate: "",
    sourceWorkbookId: "",
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [sourceWorkbooks, setSourceWorkbooks] = useState([]);

  const loadTreatments = async (requestedPage = 0, append = false, workbookId) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const activeWorkbookId = workbookId ?? appliedFilters.sourceWorkbookId;
      const query = new URLSearchParams({ page: String(requestedPage) });
      if (activeWorkbookId) query.set("sourceWorkbookId", activeWorkbookId);
      const response = await fetch(`/api/v1/quality/treatments?${query}`, { credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
      }
      setTreatments((current) => append ? [...current, ...(body.data.treatments ?? [])] : body.data.treatments ?? []);
      setPage(body.data.page);
      setHasMore(body.data.hasMore);
      setError("");
    } catch (loadError) {
      setError(loadError.message || "Impossible de charger les lignes à contrôler.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

   useEffect(() => { loadTreatments(0, false, appliedFilters.sourceWorkbookId); }, [refreshTrigger, appliedFilters.sourceWorkbookId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/source-workbooks", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        if (body.success) setSourceWorkbooks(body.data.workbooks ?? []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [refreshTrigger]);

  const rows = useMemo(() => {
    const usersById = new Map(users.map((entry) => [String(entry.id), entry]));
    const needle = appliedFilters.query.trim().toLowerCase();
    const workbooksById = new Map(sourceWorkbooks.map((entry) => [String(entry.id), entry.name]));
    return treatments.map((treatment) => {
      const line = treatment.sourceRow - 1;
      const agentId = String(treatment.lastUpdatedBy?.actorId ?? "");
      const agent = usersById.get(agentId);
      const values = treatment.currentData ?? {};
      const updatedAt = treatment.lastUpdatedAt ? new Date(treatment.lastUpdatedAt) : null;
      const workbookName = treatment.sourceWorkbookName ?? workbooksById.get(String(treatment.sourceWorkbookId ?? "")) ?? "";
      return {
        ...treatment,
        id: `${treatment.sourceRow}`,
        line,
        block: `Lignes ${Math.floor((line - 1) / 50) * 50 + 1}-${Math.floor((line - 1) / 50) * 50 + 50}`,
        ean: values.EAN13 ?? "",
        product: values["Libelle Produit"] ?? values.NOM ?? "",
        speciality: values["NEW NOM DE SPECIALITE"] ?? "",
        firstName: agent?.firstName ?? "Agent",
        lastName: agent?.lastName ?? "",
        agent: agent?.fullName ?? agent?.login ?? agentId,
        role: agent?.role ?? (treatment.lastUpdatedBy?.actorType === "QC" ? "SUPERVISEUR" : "AGENT"),
        date: updatedAt ? formatDateInput(updatedAt) : "",
        time: updatedAt ? new Intl.DateTimeFormat("fr-FR", { timeStyle: "short", timeZone: "Africa/Nairobi" }).format(updatedAt) : "",
        workbookName,
      };
    }).filter((row) => {
      const matchesQuery = needle === "" || [row.agent, row.product, row.speciality, row.ean, row.block, row.workbookName].join(" ").toLowerCase().includes(needle);
      const matchesFirstName = !appliedFilters.firstName || row.firstName.toLowerCase().includes(appliedFilters.firstName.trim().toLowerCase());
      const matchesLastName = !appliedFilters.lastName || row.lastName.toLowerCase().includes(appliedFilters.lastName.trim().toLowerCase());
      const matchesRole = !appliedFilters.role || row.role === appliedFilters.role;
      const matchesStart = !appliedFilters.startDate || row.date >= appliedFilters.startDate;
      const matchesEnd = !appliedFilters.endDate || row.date <= appliedFilters.endDate;
      const matchesWorkbook = !appliedFilters.sourceWorkbookId || String(row.sourceWorkbookId ?? "") === String(appliedFilters.sourceWorkbookId);
      return matchesQuery && matchesFirstName && matchesLastName && matchesRole && matchesStart && matchesEnd && matchesWorkbook;
    });
  }, [treatments, users, appliedFilters, sourceWorkbooks]);

  const handleSendReturn = (row) => {
    const groupStart = Math.floor((row.line - 1) / 50) * 50 + 1;
    navigate(`/distribution/groupe/${groupStart}/ligne/${row.line}`);
  };

  const handleApplyFilters = () => setAppliedFilters(filters);
  const sendFeedback = async (row) => {
    const message = (feedbackByRow[row.sourceRow] ?? "").trim();
    if (!message) {
      setError("Saisis le retour à transmettre à l’agent.");
      return;
    }
    setSendingRow(row.sourceRow);
    setError("");
    try {
      const response = await authenticatedFetch(`/api/v1/quality/treatments/${row.sourceRow}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
      }
      setFeedbackByRow((current) => ({ ...current, [row.sourceRow]: "" }));
      await loadTreatments();
    } catch (sendError) {
      setError(sendError.message || "Impossible d’envoyer le retour.");
    } finally {
       setSendingRow(null);
     }
   };

  const toggleHistory = async (row) => {
    const sourceRow = row.sourceRow;
    const isExpanded = Boolean(expandedHistory[sourceRow]);
    if (isExpanded) {
      setExpandedHistory((current) => { const next = { ...current }; delete next[sourceRow]; return next; });
      return;
    }
    setExpandedHistory((current) => ({ ...current, [sourceRow]: true }));
    if (!historyByRow[sourceRow]) {
      setHistoryLoading((current) => ({ ...current, [sourceRow]: true }));
      try {
        const response = await fetch(`/api/v1/treatment-history/${sourceRow}`, { credentials: "same-origin" });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
        const usersById = new Map(users.map((entry) => [String(entry.id), entry]));
        setHistoryByRow((current) => ({ ...current, [sourceRow]: (body.data.history ?? []).map((h) => {
          const profile = usersById.get(String(h.updatedBy?.actorId ?? ""));
          const roleLabel = profile?.role ? getRoleLabel(profile.role) : (h.updatedBy?.role ? getRoleLabel(h.updatedBy.role) : "");
          return {
            ...h,
            agentName: profile?.fullName ?? h.updatedBy?.fullName ?? ((`${h.updatedBy?.firstName ?? ""} ${h.updatedBy?.lastName ?? ""}`.trim() || h.updatedBy?.login) || String(h.updatedBy?.actorId ?? "")),
            roleLabel,
            actorTypeLabel: h.updatedBy?.actorType === "QC" ? "Contrôle Qualité" : "Agent",
          };
        }) }));
      } catch (historyError) {
        setError(historyError.message || "Impossible de charger l'historique.");
      } finally {
        setHistoryLoading((current) => { const next = { ...current }; delete next[sourceRow]; return next; });
      }
    }
  };

  return (
    <main className="page-shell">
      <section className="panel">
        <div className="panel__header panel__header--stacked">
          <h2>Page de Contrôle Qualité</h2>
          <div className="toolbar toolbar--wide">
            <input
              className="control"
              type="search"
              placeholder="Nom, prénom, produit, rôle, EAN..."
              value={filters.query}
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            />
            <input
              className="control"
              type="text"
              placeholder="Prénom"
              value={filters.firstName}
              onChange={(event) => setFilters((current) => ({ ...current, firstName: event.target.value }))}
            />
            <input
              className="control"
              type="text"
              placeholder="Nom"
              value={filters.lastName}
              onChange={(event) => setFilters((current) => ({ ...current, lastName: event.target.value }))}
            />
            <select
              className="control"
              value={filters.role}
              onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value }))}
            >
              <option value="">Tous les rôles</option>
              <option value="AGENT">Agent</option>
              <option value="SUPERVISEUR">Superviseur</option>
              <option value="ADMIN">Admin</option>
            </select>
            <input
              className="control"
              type="date"
              value={filters.startDate}
              onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
            />
            <input
              className="control"
              type="date"
              value={filters.endDate}
              onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
            />
            <select
              className="control"
              aria-label="Nom donnée source"
              value={filters.sourceWorkbookId}
              onChange={(event) => setFilters((current) => ({ ...current, sourceWorkbookId: event.target.value }))}
            >
              <option value="">Toutes données sources</option>
              {sourceWorkbooks.map((wb) => <option key={wb.id} value={wb.id}>{wb.name}</option>)}
            </select>
            <button className="btn btn--primary" type="button" onClick={handleApplyFilters}>Appliquer le filtre</button>
          </div>
        </div>

        {error && <p className="source-error" role="alert">{error}</p>}
        {loading && <p role="status">Chargement des lignes soumises…</p>}
        <div className="quality-list">
          {rows.map((row) => (
            <div key={row.id} className="quality-item">
              <div className="quality-item__top">
                <span>{row.block}</span>
                <span>Ligne {row.line}</span>
              </div>
              <div className="quality-item__meta">
                <span>EAN13 : {row.ean}</span>
                <span>Produit : {row.product}</span>
                <span>Spécialité : {row.speciality}</span>
              </div>
              <div className="quality-item__meta">
                <span>{row.date} {row.time}</span>
                <span>Agent : {row.agent}</span>
                <span>Rôle : {getRoleLabel(row.role)}</span>
              </div>
              {row.workbookName && (
                <div className="quality-item__meta">
                  <span>Donnée source : {row.workbookName}</span>
                </div>
              )}
              {row.errors.length > 0 && (
                <ul className="quality-item__errors">
                  {row.errors.map((validationError, index) => (
                    <li key={`${validationError.field}-${index}`}>{validationError.field}: {validationError.message}</li>
                  ))}
                </ul>
              )}
              {(user?.role === "ADMIN" || user?.role === "SUPERVISEUR") && (
                <label className="quality-item__comment">
                  <span>Retours et correction</span>
                  <textarea
                    className="control"
                    value={feedbackByRow[row.sourceRow] ?? ""}
                    onChange={(event) => setFeedbackByRow((current) => ({ ...current, [row.sourceRow]: event.target.value }))}
                    maxLength={2000}
                    placeholder="Saisir un retour…"
                  />
                </label>
              )}
               <div className="quality-item__actions">
                 <button className="btn" type="button" onClick={() => toggleHistory(row)}>
                   {expandedHistory[row.sourceRow] ? "Masquer l'historique" : "Afficher l'historique"}
                 </button>
                 {(user?.role === "ADMIN" || user?.role === "SUPERVISEUR") && <button
                   className="btn btn--primary quality-item__send"
                   type="button"
                   disabled={sendingRow === row.sourceRow || !(feedbackByRow[row.sourceRow] ?? "").trim()}
                   onClick={() => sendFeedback(row)}
                 >
                   {sendingRow === row.sourceRow ? "Envoi…" : "Envoyer le retour"}
                 </button>}
                 <button className="btn" type="button" onClick={() => handleSendReturn(row)}>Ouvrir la ligne</button>
               </div>
               {expandedHistory[row.sourceRow] && (
                 <div className="quality-history">
                   {historyLoading[row.sourceRow] && <p className="quality-history__loading" role="status">Chargement de l'historique…</p>}
                   {!historyLoading[row.sourceRow] && !historyByRow[row.sourceRow] && (
                     <p className="quality-history__empty">Aucun historique disponible.</p>
                   )}
                   {!historyLoading[row.sourceRow] && historyByRow[row.sourceRow] && (
                     <ul className="quality-history__list">
                       {historyByRow[row.sourceRow].map((entry, idx) => (
                         <li key={idx} className="quality-history__item">
                           <span className="quality-history__version">v{entry.version}</span>
                           <span className="quality-history__agent">{entry.agentName}</span>
                           <span className="quality-history__role">{entry.actorTypeLabel} ({entry.roleLabel || "—"})</span>
                           <span className="quality-history__date">{entry.updatedAt ? new Date(entry.updatedAt).toISOString().slice(0, 10) : ""}</span>
                           <span className="quality-history__time">{entry.updatedAt ? new Intl.DateTimeFormat("fr-FR", { timeStyle: "short", timeZone: "Africa/Nairobi" }).format(new Date(entry.updatedAt)) : ""}</span>
                           <span className="quality-history__status">{entry.status === "SUBMITTED" ? "Validée" : entry.status === "DRAFT" ? "Brouillon" : entry.status}</span>
                         </li>
                       ))}
                     </ul>
                   )}
                 </div>
                )}
              </div>
            ))}
          {!loading && !error && rows.length === 0 && (
            <p className="statistics-empty">Aucune ligne soumise ne correspond aux filtres.</p>
          )}
          {!loading && hasMore && (
            <button className="btn" type="button" disabled={loadingMore} onClick={() => loadTreatments(page + 1, true)}>
              {loadingMore ? "Chargement…" : "Charger les 100 lignes suivantes"}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

function DataPage({ users = [] }) {
  const [filters, setFilters] = useState(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    return { startDate: formatDateInput(start), endDate: formatDateInput(end), role: "", agent: "", sourceWorkbookId: "" };
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [performance, setPerformance] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exportFormat, setExportFormat] = useState("excel");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportResult, setExportResult] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [sourceWorkbooks, setSourceWorkbooks] = useState([]);

  useSyncEvents("treatment-updated", () => setRefreshTrigger((t) => t + 1));
  useSyncEvents("source-imported", () => setRefreshTrigger((t) => t + 1));

  const exportSubmittedData = async () => {
    setExporting(true);
    setExportError("");
    setExportResult(null);
    try {
      const query = new URLSearchParams({ format: exportFormat });
      if (appliedFilters.startDate) query.set("from", appliedFilters.startDate);
      if (appliedFilters.endDate) query.set("to", appliedFilters.endDate);
      if (appliedFilters.role) query.set("role", appliedFilters.role);
      if (appliedFilters.agent.trim()) query.set("agent", appliedFilters.agent.trim());
      if (appliedFilters.sourceWorkbookId) query.set("sourceWorkbookId", appliedFilters.sourceWorkbookId);
      const response = await authenticatedFetch(`/api/sheets/export?${query}`, {
        method: "POST",
      });
      if (!response.ok) {
        let details = `Erreur ${response.status}`;
        try {
          const body = await response.json();
          details = body.error ?? body.errors?.[0]?.message ?? details;
        } catch {
          // The generic client message is still displayed when the response isn't JSON.
        }
        throw new Error(details);
      }

      if (exportFormat === "google-sheets") {
        const body = await response.json();
        if (typeof body.url !== "string") throw new Error("Le lien de la copie Google Sheets est absent.");
        setExportResult({ url: body.url, count: body.count });
      } else {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const workbookName = sourceWorkbooks.find((wb) => String(wb.id) === String(appliedFilters.sourceWorkbookId))?.name ?? "";
        const safeName = workbookName.trim().toLowerCase().replace(/[^a-z0-9àâäéèêëîïôöùûüç_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
        link.download = safeName
          ? `${safeName}-terminee-${formatDateInput(new Date())}.xlsx`
          : `saisies-confiserie-${formatDateInput(new Date())}.xlsx`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        setExportResult({ count: Number(response.headers.get("X-Exported-Rows") ?? 0), downloaded: true, workbookName });
      }
    } catch (exportFailure) {
      setExportError(userErrorMessage("submitted-data-export", exportFailure));
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const query = new URLSearchParams();
        if (appliedFilters.startDate) query.set("from", appliedFilters.startDate);
        if (appliedFilters.endDate) query.set("to", appliedFilters.endDate);
        if (appliedFilters.sourceWorkbookId) query.set("sourceWorkbookId", appliedFilters.sourceWorkbookId);
        const response = await fetch(`/api/v1/stats/agents?${query}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.success) {
          throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
        }
        setPerformance(body.data.agents ?? []);
        setError("");
      } catch (loadError) {
        if (loadError.name !== "AbortError") setError(userErrorMessage("agent-statistics-load", loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    const loadWorkbooks = async () => {
      try {
        const response = await fetch("/api/v1/source-workbooks", { credentials: "same-origin", signal: controller.signal });
        const body = await response.json();
        if (response.ok && body.success) setSourceWorkbooks(body.data.workbooks ?? []);
      } catch {
        if (!controller.signal.aborted) setSourceWorkbooks([]);
      }
    };

    load();
    loadWorkbooks();
    return () => controller.abort();
   }, [appliedFilters.startDate, appliedFilters.endDate, appliedFilters.sourceWorkbookId, refreshTrigger]);

  const filteredRows = useMemo(
    () => buildFilteredAgentRows(performance, users, appliedFilters),
    [performance, users, appliedFilters.role, appliedFilters.agent],
  );
  const invalidRange = filters.startDate && filters.endDate && filters.startDate > filters.endDate;

  return (
    <main className="page-shell">
      <section className="panel">
        <div className="panel__header panel__header--stacked">
          <h2>Page de Données</h2>
          <section className="data-export">
            <div>
              <h3>Exporter les saisies filtrées</h3>
              <p>L’export en format Excel (.xlsx) est actuellement disponible.</p>
            </div>
            <div className="toolbar data-export__controls">
              <label className="data-export__format">
                <span>Format d'extraction</span>
                <select className="control" value={exportFormat} onChange={(event) => setExportFormat(event.target.value)}>
                  <option value="excel">Fichier Excel (.xlsx)</option>
                </select>
              </label>
              <label className="data-export__workbook">
                <span>Nom donnée source (classeur)</span>
                <select className="control" value={appliedFilters.sourceWorkbookId} onChange={(event) => {
                  const next = event.target.value;
                  setAppliedFilters((current) => ({ ...current, sourceWorkbookId: next }));
                  setFilters((current) => ({ ...current, sourceWorkbookId: next }));
                }}>
                  <option value="">Tous les fichiers</option>
                  {sourceWorkbooks.map((wb) => <option key={wb.id} value={wb.id}>{wb.name}</option>)}
                </select>
              </label>
              <button className="btn btn--primary" type="button" disabled={exporting} onClick={exportSubmittedData}>
                {exporting ? "Preparation de l'export…" : "Exporter les saisies"}
              </button>
            </div>
            {exportError && <p className="source-error" role="alert">{exportError}</p>}
            {exportResult?.downloaded && (
              <p className="data-export__success" role="status">Le fichier Excel{exportResult.workbookName ? ` « ${exportResult.workbookName} » terminée` : ""} a été téléchargé ({exportResult.count} lignes filtrées).</p>
            )}
            {exportResult?.url && (
              <p className="data-export__success" role="status">
                Copie Google Sheets créée ({exportResult.count} lignes filtrées). Son accès dépend des autorisations du dossier Google Drive de destination.{" "}
                <a href={exportResult.url} target="_blank" rel="noreferrer">Ouvrir la copie</a>
              </p>
            )}
          </section>
          <div className="toolbar toolbar--wide">
            <input
              className="control"
              type="date"
              value={filters.startDate}
              onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
            />
            <input
              className="control"
              type="date"
              value={filters.endDate}
              onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
            />
            <select
              className="control"
              value={filters.role}
              onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value }))}
            >
              <option value="">Tous les rôles</option>
              <option value="AGENT">Agent</option>
              <option value="SUPERVISEUR">Superviseur</option>
              <option value="ADMIN">Admin</option>
            </select>
            <input
              className="control"
              type="text"
              value={filters.agent}
              onChange={(event) => setFilters((current) => ({ ...current, agent: event.target.value }))}
            />
            <select
              className="control"
              aria-label="Nom donnée source"
              value={filters.sourceWorkbookId}
              onChange={(event) => setFilters((current) => ({ ...current, sourceWorkbookId: event.target.value }))}
            >
              <option value="">Toutes données sources</option>
              {sourceWorkbooks.map((wb) => <option key={wb.id} value={wb.id}>{wb.name}</option>)}
            </select>
            <button className="btn btn--primary" type="button" disabled={Boolean(invalidRange)} onClick={() => setAppliedFilters(filters)}>Appliquer le filtre</button>
          </div>
        </div>

        <h3 className="data-section-title">Statistiques par agent</h3>
        {error && <p className="source-error" role="alert">{error}</p>}
        {invalidRange && <p className="source-error" role="alert">La date de début doit précéder la date de fin.</p>}
        {loading && <p role="status">Chargement des données…</p>}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Lignes validées</th>
                <th>Retours rectifiés</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.agentId}>
                  <td>{row.agent}</td>
                  <td>{row.lines}</td>
                  <td>{row.returns}</td>
                </tr>
              ))}
              {!loading && !error && filteredRows.length === 0 && (
                <tr><td colSpan="3">Aucune donnée ne correspond aux filtres.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function UserManagementPage({ users, setUsers, currentUser }) {
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const filteredUsers = users.filter((user) => `${user.firstName} ${user.lastName}`.toLowerCase().includes(search.toLowerCase()));

  const handleDelete = async (user) => {
    const confirmed = window.confirm(`Voulez-vous vraiment supprimer ${user.fullName} ?`);
    if (!confirmed) return;
    try {
      const response = await authenticatedFetch(`/api/v1/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? "Suppression refusée");
      setUsers((current) => current.filter((item) => String(item.id) !== String(user.id)));
    } catch (deleteError) { setError(deleteError.message); }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const userValues = {
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      login: form.get("login"),
      password: form.get("password"),
      role: form.get("role"),
    };
    try {
      setError("");
      const response = await authenticatedFetch(selectedUser ? `/api/v1/users/${encodeURIComponent(selectedUser.id)}` : "/api/v1/users", {
        method: selectedUser ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(userValues),
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? "Enregistrement refusé");
      const savedUser = body.data.user;
      setUsers((current) => selectedUser
        ? current.map((item) => String(item.id) === String(savedUser.id) ? savedUser : item)
        : [...current, savedUser]);
      setSelectedUser(null);
      setShowForm(false);
      formElement.reset();
    } catch (saveError) { setError(saveError.message); }
  };

  return (
    <main className="page-shell">
      <section className="panel">
        <div className="panel__header panel__header--stacked">
          <h2>Gestion des Utilisateurs</h2>
          <div className="toolbar">
            <input
              className="control"
              type="search"
              placeholder="Rechercher un utilisateur"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button className="btn btn--primary" type="button" onClick={() => {
              setSelectedUser(null);
              setShowForm(true);
            }}>
              Ajouter un nouvel utilisateur
            </button>
          </div>
        </div>
        {error && <p className="source-error" role="alert">{error}</p>}

        <div className="user-list">
          {filteredUsers.map((user) => (
            <div key={user.id} className="user-card">
              {currentUser.role === "ADMIN" ? (
                <button type="button" className="user-link" onClick={() => {
                  setSelectedUser(user);
                  setShowForm(true);
                }}>
                  {user.fullName}
                </button>
              ) : <strong>{user.fullName}</strong>}
              <div className="user-card__meta">
                <span>{getRoleLabel(user.role)}</span>
                <span>{user.login}</span>
              </div>
              {currentUser.role === "ADMIN" && <button className="btn btn--danger" type="button" onClick={() => handleDelete(user)}>Supprimer</button>}
            </div>
          ))}
        </div>
      </section>

      {showForm && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>{selectedUser ? "Modifier l’utilisateur" : "Ajouter un utilisateur"}</h3>
            <form onSubmit={handleSave} className="form-grid">
              <label className="field">
                <span>Nom</span>
                <input name="lastName" className="control" defaultValue={selectedUser?.lastName ?? ""} required />
              </label>
              <label className="field">
                <span>Prénom</span>
                <input name="firstName" className="control" defaultValue={selectedUser?.firstName ?? ""} required />
              </label>
              <label className="field">
                <span>Login</span>
                <input name="login" className="control" defaultValue={selectedUser?.login ?? ""} required />
              </label>
              <label className="field">
                <span>Mot de passe{selectedUser ? " (vide pour conserver l’actuel)" : ""}</span>
                <input
                  name="password"
                  className="control"
                  type="password"
                  autoComplete="new-password"
                  placeholder={selectedUser ? "Saisir un nouveau mot de passe" : ""}
                  minLength={8}
                  required={!selectedUser}
                />
              </label>
              <label className="field">
                <span>Rôle</span>
                <select name="role" className="control" defaultValue={selectedUser?.role ?? "AGENT"}>
                  <option value="AGENT">Agent</option>
                  {currentUser.role === "ADMIN" && <>
                    <option value="SUPERVISEUR">Superviseur</option>
                    <option value="ADMIN">Admin</option>
                  </>}
                </select>
              </label>
              <div className="form-actions">
                <button className="btn" type="button" onClick={() => setShowForm(false)}>Annuler</button>
                <button className="btn btn--primary" type="submit">{selectedUser ? "Modifier" : "Ajouter"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

function GoogleSheetConnectionPage() {
  const [sourceFile, setSourceFile] = useState(null);
  const [sheetUrl, setSheetUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState(null);

  const importRows = async (rows, catalogSheets = null, fileName = "Classeur importé", fileType = "xlsx") => {
    if (!rows.length) throw new Error("Le fichier ne contient aucune ligne de données.");
    if (catalogSheets) {
      const start = await authenticatedFetch("/api/v1/data/import-workbook/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetNames: catalogSheets.map((sheet) => sheet.name) }),
      });
      const startBody = await start.json();
      if (!start.ok || !startBody.success) throw new Error(startBody.errors?.[0]?.message ?? `Erreur ${start.status}`);
      const importId = startBody.data.importId;
      try {
        for (const sheet of catalogSheets) {
          const response = await authenticatedFetch(`/api/v1/data/import-workbook/${encodeURIComponent(importId)}/sheet`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sheetName: sheet.name, rows: sheet.rows }),
          });
          const body = await response.json();
          if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
        }
        const commit = await authenticatedFetch(`/api/v1/data/import-workbook/${encodeURIComponent(importId)}/commit`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceRows: rows, fileName, fileType }),
        });
        const body = await commit.json();
        if (!commit.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${commit.status}`);
        setImportStatus({ success: true, message: `${body.data.rows} lignes source et ${body.data.sheets} onglet(s) secondaire(s) importés dans le stockage partagé.` });
      } catch (error) {
        throw error;
      }
      return;
    }
    const response = await authenticatedFetch("/api/v1/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, fileName, fileType }),
    });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
    setImportStatus({ success: true, message: `${body.data.rows} lignes source importées dans le stockage partagé.` });
  };

  const handleFileImport = async (event) => {
    event.preventDefault();
    if (!sourceFile) return;
    setImporting(true);
    setImportStatus(null);
    try {
      const extension = sourceFile.name.toLowerCase().split(".").pop();
      if (!['xlsx', 'csv'].includes(extension)) throw new Error("Choisissez un fichier .xlsx ou .csv.");
      const isXlsx = extension === "xlsx";
      const parsed = isXlsx
        ? await parseXlsx(sourceFile)
        : parseCsv(await sourceFile.text());
      const baseName = sourceFile.name.replace(/\.[^.]+$/, "").trim() || sourceFile.name;
      await importRows(isXlsx ? parsed.sourceRows : parsed, isXlsx ? parsed.catalogSheets : null, baseName, isXlsx ? "xlsx" : "csv");
    } catch (error) {
      setImportStatus({ success: false, message: error.message || "Import impossible." });
    } finally { setImporting(false); }
  };

  const handleGoogleImport = async (event) => {
    event.preventDefault();
    setImporting(true);
    setImportStatus(null);
    try {
      const response = await authenticatedFetch("/api/v1/data/import-google-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sheetUrl }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
      setImportStatus({ success: true, message: `${body.data.rows} lignes importées depuis Google Sheets dans le stockage partagé.` });
    } catch (error) {
      setImportStatus({ success: false, message: error.message || "Import Google Sheets impossible." });
    } finally { setImporting(false); }
  };

  return (
    <main className="page-shell">
      <section className="panel">
        <h2>Données source</h2>
        <p>Importez un classeur Excel ou un Google Sheet. Les lignes seront stockées dans la base partagée par les utilisateurs de ce serveur.</p>
        <form className="sheet-connection-form" onSubmit={handleFileImport}>
          <label className="field">
            <span>Fichier Excel .xlsx ou CSV</span>
            <input className="control" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => setSourceFile(event.target.files?.[0] ?? null)} required />
          </label>
          <button className="btn btn--primary" type="submit" disabled={!sourceFile || importing}>
            {importing ? "Import en cours…" : "Importer le fichier"}
          </button>
        </form>
        <form className="sheet-connection-form" onSubmit={handleGoogleImport}>
          <label className="field">
            <span>Lien Google Sheets</span>
            <input className="control" type="url" value={sheetUrl} onChange={(event) => setSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." required />
          </label>
          <button className="btn btn--primary" type="submit" disabled={!sheetUrl.trim() || importing}>
            {importing ? "Import en cours…" : "Importer depuis Google Sheets"}
          </button>
        </form>
        {importStatus && <p className={importStatus.success ? "sheet-connection-success" : "source-error"} role={importStatus.success ? "status" : "alert"}>{importStatus.message}</p>}
        <p className="sheet-connection-note">La première ligne de l’onglet doit contenir les noms de colonnes, notamment EAN13 et NOM. L’import remplace le jeu de lignes source actuel ; les saisies et comptes utilisateurs restent conservés. Un Google Sheet privé doit être partagé avec le compte de service configuré sur le serveur ; un document accessible à toute personne disposant du lien peut être importé sans compte de service.</p>
      </section>
    </main>
  );
}

function ProfileSetupPage({ user, onComplete }) {
  const [firstName, setFirstName] = useState(user.firstName || "ADMIN");
  const [lastName, setLastName] = useState(user.lastName || "ADMIN");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const response = await authenticatedFetch("/api/v1/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
      onComplete(body.data.user);
    } catch (profileError) {
      setError(profileError.message || "Impossible d’enregistrer le profil.");
    } finally { setSaving(false); }
  };

  return (
    <main className="login-page">
      <section className="login-card">
        <img className="login-logo" src="/chocologo.png" alt="ChocoLogic — Backoffice de traitement de données" />
        <h1>Bienvenue, {user.firstName || "ADMIN"} {user.lastName || "ADMIN"}</h1>
        <p>Pour terminer la première connexion, confirmez votre prénom et votre nom.</p>
        <form onSubmit={handleSubmit} className="login-form">
          <label className="field">
            <span>Prénom</span>
            <input className="control" value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={100} required autoFocus />
          </label>
          <label className="field">
            <span>Nom</span>
            <input className="control" value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={100} required />
          </label>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="btn btn--primary" type="submit" disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer et continuer"}</button>
        </form>
      </section>
    </main>
  );
}

function LoginPage({ onLogin }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ login, password }),
      });
      let body;
      try {
        body = await response.json();
      } catch {
        if (response.status >= 500) {
          throw new Error("Le service local est indisponible. Vérifiez que l’application serveur est ouverte.");
        }
        throw new Error("Le service de connexion a renvoyé une réponse invalide. Réessaie.");
      }
      if (!response.ok || !body.success) {
        throw new Error(body.errors?.[0]?.message ?? "Connexion refusée");
      }
      onLogin(body.data.user, body.data.syncToken);
    } catch (loginError) {
      setError(loginError instanceof TypeError
        ? "Impossible de joindre le service de connexion. Vérifiez que le backend est démarré."
        : loginError.message || "Connexion impossible. Réessaie.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-card">
        <img className="login-logo" src="/chocologo.png" alt="ChocoLogic — Backoffice de traitement de données" />
        <h1>Connexion</h1>
        <form onSubmit={handleSubmit} className="login-form">
          <label className="field">
            <span>Login</span>
            <input className="control" type="text" value={login} onChange={(event) => setLogin(event.target.value)} required />
          </label>
          <label className="field">
            <span>Mot de passe</span>
            <input className="control" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <p className="field-error">{error}</p>}
          <button className="btn btn--primary" type="submit" disabled={submitting}>{submitting ? "Connexion…" : "Se connecter"}</button>
        </form>
      </div>
    </main>
  );
}

function Application() {
  const location = useLocation();
  const catalogOpenedForUser = useRef(null);
  const [storageMode, setStorageMode] = useState("checking");
  const [users, setUsers] = useState([]);
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [notifications, setNotifications] = useState([]);
  const [notificationError, setNotificationError] = useState("");
  const [dataVersion, setDataVersion] = useState(0);
  const [syncTokenValue, setSyncTokenValue] = useState(null);
  useSyncConnection(syncTokenValue);

useEffect(() => {
    if (!user?.id || authChecking) return;
    if (catalogOpenedForUser.current === user.id) return;
    catalogOpenedForUser.current = user.id;
    window.electron?.openCatalogWindow?.().catch((error) => console.error("Ouverture de la fenêtre des onglets impossible :", error));
  }, [user?.id, authChecking]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/health", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error("API indisponible");
        setStorageMode(body.data.storageMode);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setStorageMode("unavailable");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/auth/me", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json();
        return body.success ? body.data.user : null;
      })
      .then((authenticatedUser) => {
        if (controller.signal.aborted) return;
        setUser(authenticatedUser);
        if (authenticatedUser?.requiresProfileUpdate) {
          setUsers([authenticatedUser]);
        } else if (authenticatedUser && ["ADMIN", "SUPERVISEUR"].includes(authenticatedUser.role)) {
          return fetch("/api/v1/users", { credentials: "same-origin", signal: controller.signal })
            .then((response) => response.json())
            .then((body) => { if (body.success) setUsers(body.data.users); });
        }
        setUsers(authenticatedUser ? [authenticatedUser] : []);
      })
      .catch((error) => { if (error.name !== "AbortError") setUser(null); })
      .finally(() => { if (!controller.signal.aborted) setAuthChecking(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!user?.id || user.requiresProfileUpdate || !["ADMIN", "SUPERVISEUR"].includes(user.role)) return;
    fetch("/api/v1/users", { credentials: "same-origin" })
      .then((response) => response.json())
      .then((body) => { if (body.success) setUsers(body.data.users); })
      .catch(() => {});
  }, [user?.id, user?.role, dataVersion]);

  useEffect(() => {
    if (!user?.id || user.requiresProfileUpdate) {
      setNotifications([]);
      setNotificationError("");
      return undefined;
    }

    const controller = new AbortController();
    const loadNotifications = async () => {
      try {
        const response = await fetch("/api/v1/notifications", {
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok || !body.success) {
          throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
        }
        setNotifications(body.data.notifications ?? []);
        setNotificationError("");
      } catch (error) {
        if (error.name !== "AbortError") {
          setNotificationError(userErrorMessage("notifications-load", error));
        }
      }
    };

    loadNotifications();
    const interval = window.setInterval(loadNotifications, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [user?.id, user?.requiresProfileUpdate, dataVersion]);

  const saveDraft = async (sourceIndex, values, submit = false) => {
    const sourceRow = sourceIndex + 1;
    const response = await authenticatedFetch("/api/v1/data/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRow, values, submit }),
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
    }

    setStorageMode(body.data.storageMode);
    const storageLabel = body.data.storageMode === "sqlite"
      ? "SQLite"
      : body.data.storageMode === "mongodb"
      ? "MongoDB"
      : body.data.storageMode === "memory"
        ? "la mémoire temporaire (données non persistantes)"
        : "un stockage non identifié";
    const action = submit ? "Saisie validée" : "Brouillon";
    return `${action} de l’index ${sourceIndex} (ligne ${sourceRow} du Google Sheet) enregistré (version ${body.data.version}) dans ${storageLabel}.`;
  };

  const saveDistributionGroupStatus = async (groupStart, status) => {
    const response = await authenticatedFetch(`/api/v1/distribution-groups/${groupStart}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
    }
    return body.data.group;
  };

  const loadDistributionGroupStatuses = useCallback(async ({ signal, sourceWorkbookId } = {}) => {
    const query = sourceWorkbookId ? `?sourceWorkbookId=${encodeURIComponent(sourceWorkbookId)}` : "";
    const response = await authenticatedFetch(`/api/v1/distribution-groups${query}`, { signal });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(body.errors?.[0]?.message ?? `Erreur ${response.status}`);
    }
    return body.data.groups;
  }, []);

  const handleLogout = async () => {
    try {
      const response = await authenticatedFetch("/api/v1/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Déconnexion refusée par le serveur");
    } catch {
      window.alert("La déconnexion n’a pas pu être confirmée par le serveur. Réessaie lorsque la connexion sera rétablie.");
      return;
    }
    setUser(null);
    setSyncToken(null);
    setSyncTokenValue(null);
    catalogOpenedForUser.current = null;
    closeCatalogWindow();
    setUsers([]);
    setNotifications([]);
  };

  const handleLogin = async (authenticatedUser, syncTokenValue) => {
    setUser(authenticatedUser);
    if (syncTokenValue) {
      setSyncToken(syncTokenValue);
      setSyncTokenValue(syncTokenValue);
    }
    if (authenticatedUser.requiresProfileUpdate) {
      setUsers([authenticatedUser]);
    } else if (["ADMIN", "SUPERVISEUR"].includes(authenticatedUser.role)) {
      try {
        const response = await fetch("/api/v1/users", { credentials: "same-origin" });
        const body = await response.json();
        if (body.success) setUsers(body.data.users);
      } catch { setUsers([]); }
    } else setUsers([authenticatedUser]);
  };

  const handleProfileComplete = async (updatedUser) => {
    setUser(updatedUser);
    if (["ADMIN", "SUPERVISEUR"].includes(updatedUser.role)) {
      try {
        const response = await fetch("/api/v1/users", { credentials: "same-origin" });
        const body = await response.json();
        if (body.success) {
          setUsers(body.data.users);
          return;
        }
      } catch { /* Le profil est enregistré ; la liste pourra être rechargée plus tard. */ }
    }
    setUsers([updatedUser]);
  };

  const renderAuthenticatedRoutes = () => (
    <>
      <Route path="/" element={<Navigate to="/accueil" replace />} />
      <Route path="/login" element={<Navigate to="/accueil" replace />} />
      <Route path="/catalogue" element={<CatalogWindowPage />} />
      <Route path="/accueil" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><HomePage user={user} storageMode={storageMode} /></AppShell>} />
      <Route path="/distribution" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><DistributionHomePage onLoadGroupStatuses={loadDistributionGroupStatuses} onSaveGroupStatus={saveDistributionGroupStatus} /></AppShell>} />
      <Route path="/distribution/groupe/:groupStart" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><DistributionGroupPage /></AppShell>} />
      <Route path="/distribution/groupe/:groupStart/ligne/:index" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><DistributionLinePage storageMode={storageMode} onSave={saveDraft} /></AppShell>} />
      <Route path="/qualite" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><QualityPage users={users} user={user} /></AppShell>} />
      <Route path="/statistiques" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><StatisticsPage users={users} user={user} /></AppShell>} />
      {(user.role === "SUPERVISEUR" || user.role === "ADMIN") && (
        <>
          <Route path="/donnees" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><DataPage users={users} /></AppShell>} />
        </>
      )}
      {(user.role === "ADMIN" || user.role === "SUPERVISEUR") && (
        <Route path="/utilisateurs" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><UserManagementPage users={users} setUsers={setUsers} currentUser={user} /></AppShell>} />
      )}
      {user.role === "ADMIN" && (
        <>
          <Route path="/connexion-sheet" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><GoogleSheetConnectionPage /></AppShell>} />
          <Route path="/monitoring" element={<AppShell user={user} notifications={notifications} notificationError={notificationError} onLogout={handleLogout}><MonitoringPage storageMode={storageMode} /></AppShell>} />
        </>
      )}
      <Route path="*" element={<Navigate to="/accueil" replace />} />
    </>
  );

  if (authChecking) return <main className="login-page"><p role="status">Vérification de la session…</p></main>;
  if (user?.requiresProfileUpdate) return <ProfileSetupPage user={user} onComplete={handleProfileComplete} />;

  return (
    <div className="wrap">
      <Routes>
        {!user ? (
          <>
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="/login" element={<LoginPage onLogin={handleLogin} />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </>
        ) : renderAuthenticatedRoutes()}
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Application />
    </BrowserRouter>
  );
}
