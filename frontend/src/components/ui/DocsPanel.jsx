import { useEffect, useState } from "react";
import chocolatPdf from "../../../Docs/128 CHOCOLAT V2.pdf?url";
import reglePdf from "../../../Docs/Règle de traitement chocolat Circana.pdf?url";

const DOCS = [
  { id: "chocolat", label: "128 Chocolat V2", url: chocolatPdf },
  { id: "regle", label: "Règle de traitement Circana", url: reglePdf },
];

const DEFAULT_WIDTH = 560;
const MIN_WIDTH = 320;
const WIDTH_KEY = "saisie.docs.width";

const maxWidth = () => Math.max(Math.min(MIN_WIDTH, window.innerWidth), window.innerWidth - 240);
const clampWidth = (value) => Math.min(Math.max(value, Math.min(MIN_WIDTH, window.innerWidth)), maxWidth());

function savedWidth() {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * Documentation de saisie : panneau ancré à droite, ouvert/fermé par un bouton ou F1.
 * Sa largeur se règle en tirant le bord gauche (double-clic : agrandir / réduire).
 */
export function DocsPanel() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(DOCS[0].id);
  const [width, setWidth] = useState(savedWidth);
  const [resizing, setResizing] = useState(false);
  const doc = DOCS.find((d) => d.id === current);
  const shown = clampWidth(width);
  const wide = shown >= maxWidth();

  useEffect(() => {
    document.body.classList.toggle("docs-open", open);
    document.documentElement.style.setProperty("--docs-w", `${shown}px`);
    return () => {
      document.body.classList.remove("docs-open");
      document.documentElement.style.removeProperty("--docs-w");
    };
  }, [open, shown]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "F1") {
        e.preventDefault();
        setOpen((value) => !value);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // La documentation reste utilisable lorsque le stockage local est indisponible.
    }
  }, [width]);

  const startResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };

  const toggleWide = () => setWidth(clampWidth(wide ? DEFAULT_WIDTH : maxWidth()));

  if (!open) {
    return (
      <button type="button" className="docs-launcher" aria-label="Ouvrir les consignes de traitement (F1)" onClick={() => setOpen(true)}>
        Documentation <kbd>F1</kbd>
      </button>
    );
  }

  return (
    <aside className={`docs-panel${resizing ? " is-resizing" : ""}`} style={{ width: shown }} aria-label="Consignes de traitement">
      <span className="docs-resize"
        onPointerDown={startResize}
        onPointerMove={(event) => resizing && setWidth(clampWidth(window.innerWidth - event.clientX))}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setResizing(false);
        }}
        onPointerCancel={() => setResizing(false)}
        onDoubleClick={toggleWide}
        title="Tirer pour élargir · double-clic : agrandir / réduire" aria-hidden="true" />
      <div className="docs-head">
        <div className="docs-tabs" role="tablist" aria-label="Documents de consignes">
          {DOCS.map((d, index) => (
            <button key={d.id} id={`docs-tab-${d.id}`} type="button" role="tab" className="docs-tab" aria-selected={d.id === current}
              aria-controls="docs-content" tabIndex={d.id === current ? 0 : -1}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const nextIndex = event.key === "Home" ? 0
                  : event.key === "End" ? DOCS.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + DOCS.length) % DOCS.length;
                const nextDoc = DOCS[nextIndex];
                setCurrent(nextDoc.id);
                document.getElementById(`docs-tab-${nextDoc.id}`)?.focus();
              }}
              onClick={() => setCurrent(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
        <a className="docs-head__link" href={doc.url} target="_blank" rel="noreferrer">Nouvel onglet</a>
        <button type="button" className="docs-btn" onClick={toggleWide} aria-label={wide ? "Réduire" : "Agrandir"}
          title={wide ? "Réduire" : "Agrandir"}>
          {wide ? "⇥" : "⇤"}
        </button>
        <button type="button" className="docs-btn docs-close" aria-label="Fermer la documentation (F1)"
          title="Fermer (F1 / Échap)" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      <iframe id="docs-content" key={doc.id} className="docs-frame" title={doc.label}
        src={`${doc.url}#navpanes=0&view=FitH`} />
    </aside>
  );
}
