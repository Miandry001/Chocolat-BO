import { GoogleAuth } from "google-auth-library";
import { buildFilledExcelWorkbook, EXCEL_MIME_TYPE } from "./excelExport.js";
import {
  buildSubmittedValueUpdates,
  getUnselectedRowRanges,
  sheetNameFromRange,
} from "./sheetExport.js";

const CACHE_MS = 30_000;

function spreadsheetIdFromUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Saisissez un lien Google Sheets valide."), { statusCode: 400 });
  }

  const match = url.hostname === "docs.google.com"
    ? url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)
    : null;
  if (!match) throw Object.assign(new Error("Le lien doit pointer vers un fichier Google Sheets."), { statusCode: 400 });
  return match[1];
}

function readCookie(req, name) {
  const prefix = `${name}=`;
  const entry = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  try { return entry ? decodeURIComponent(entry.slice(prefix.length)) : ""; }
  catch { return ""; }
}

async function authorizeApiRequest(req, res, server, { mutate = false, returnIdentity = false, authApiTarget, appOrigin } = {}) {
  const authService = server.config.custom?.authService;
  if (!authService && !authApiTarget) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "Service d’authentification indisponible." }));
    return false;
  }
  let identity = null;
  let authServiceUnavailable = false;
  if (authService) {
    identity = await authService.authenticate(readCookie(req, "chocolat_session"));
  } else {
    try {
      const response = await fetch(new URL("/api/v1/auth/me", authApiTarget), {
        headers: { cookie: req.headers.cookie ?? "" },
        signal: AbortSignal.timeout(3_000),
      });
      const body = response.ok ? await response.json() : null;
      identity = body?.success ? body.data?.user : null;
      authServiceUnavailable = !response.ok && response.status !== 401;
    } catch { authServiceUnavailable = true; }
  }
  if (!identity) {
    res.statusCode = authServiceUnavailable ? 503 : 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: authServiceUnavailable
      ? "Service d’authentification indisponible. Vérifiez API_TARGET et le démarrage du backend."
      : "Session absente, expirée ou révoquée." }));
    return false;
  }
  if (!mutate) return returnIdentity ? identity : true;

  const forwardedProtocol = req.headers["x-forwarded-proto"]?.split(",", 1)[0]?.trim();
  const requestProtocol = forwardedProtocol || (req.socket.encrypted ? "https" : "http");
  const expectedOrigin = (appOrigin ?? process.env.APP_ORIGIN)?.replace(/\/$/, "")
    ?? `${requestProtocol}://${req.headers.host}`;
  const csrfCookie = readCookie(req, "chocolat_csrf");
  const csrfHeader = req.headers["x-csrf-token"];
  if (req.headers.origin !== expectedOrigin || !csrfCookie || typeof csrfHeader !== "string" || csrfCookie !== csrfHeader) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "Origine ou jeton CSRF invalide." }));
    return false;
  }
  return returnIdentity ? identity : true;
}

/**
 * Plugin Vite qui lit les lignes source et produit des copies remplies côté serveur.
 * Les identifiants du compte de service ne sont jamais envoyés au navigateur.
 *
 * Réponse : { row, first, last, values: { "<en-tête de colonne>": "<valeur>" } }
 * `row` est le numéro de ligne tel qu'affiché dans Google Sheets (la ligne 1 contient les en-têtes).
 */
export function sheetsPlugin({ keyFile, sheetId, range, authApiTarget, appOrigin, driveFolderId }) {
  const auth = new GoogleAuth({
    keyFile,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  let activeSheetId = sheetId;
  let cache = null;

  async function loadSheet(targetSheetId = activeSheetId) {
    if (cache?.sheetId === targetSheetId && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const client = await auth.getClient();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${targetSheetId}/values/${encodeURIComponent(range)}`;
    const res = await client.request({ url, params: { valueRenderOption: "FORMATTED_VALUE" } });
    return res.data.values ?? [];
  }

  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end(JSON.stringify(body));
  }

  function sendBinary(res, body, filename, rowCount) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", body.length);
    res.setHeader("X-Exported-Rows", String(rowCount));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end(body);
  }

  async function listExportTreatments(req, server, filters) {
    const localRepository = server.config.custom?.listExportTreatments;
    if (localRepository) return localRepository(filters);
    if (!authApiTarget) throw new Error("Le service de données est indisponible pour l’export.");

    const exportUrl = new URL("/api/v1/data/export", authApiTarget);
    for (const [key, value] of Object.entries(filters)) {
      if (value) exportUrl.searchParams.set(key, value);
    }
    const response = await fetch(exportUrl, {
      headers: { cookie: req.headers.cookie ?? "" },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw Object.assign(new Error(body.errors?.[0]?.message ?? "La récupération des saisies a échoué."), {
        statusCode: response.status,
      });
    }
    return body.data.treatments ?? [];
  }

  async function createFilledCopy(treatments, server) {
    if (!activeSheetId) throw new Error("Aucun fichier source Google Sheets n’est configuré.");
    if (!driveFolderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID doit désigner le dossier du Drive partagé pour les exports.");
    const rows = await loadSheet();
    const updates = buildSubmittedValueUpdates(rows, treatments, range);
    const requiredColumnCount = updates.reduce((count, { range: updateRange }) => {
      const columnName = updateRange.slice(updateRange.lastIndexOf("!") + 1).match(/^([A-Z]+)/)?.[1];
      if (!columnName) return count;
      const column = [...columnName].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      return Math.max(count, column);
    }, 0);

    const client = await auth.getClient();
    const copyResponse = await client.request({
      url: `https://www.googleapis.com/drive/v3/files/${activeSheetId}/copy`,
      method: "POST",
      params: { fields: "id,name,webViewLink", supportsAllDrives: true },
      data: {
        name: `Saisies confiserie - ${new Date().toISOString().slice(0, 10)}`,
        parents: [driveFolderId],
      },
    });
    const copy = copyResponse.data;
    if (!copy?.id) throw new Error("Google Drive n’a pas retourné l’identifiant de la copie.");

    try {
      const metadataResponse = await client.request({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${copy.id}`,
        params: { fields: "sheets(properties(sheetId,title,gridProperties(columnCount)))" },
      });
      const targetTitle = sheetNameFromRange(range).replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
      const sheets = metadataResponse.data.sheets ?? [];
      const targetSheet = sheets.find(({ properties }) => properties.title === targetTitle);
      if (!targetSheet?.properties?.sheetId) throw new Error(`L’onglet « ${targetTitle} » est absent de la copie.`);
      const currentColumnCount = targetSheet.properties.gridProperties?.columnCount ?? 0;
      if (requiredColumnCount > currentColumnCount) {
        await client.request({
          url: `https://sheets.googleapis.com/v4/spreadsheets/${copy.id}:batchUpdate`,
          method: "POST",
          data: { requests: [{
            appendDimension: {
              sheetId: targetSheet.properties.sheetId,
              dimension: "COLUMNS",
              length: requiredColumnCount - currentColumnCount,
            },
          }] },
        });
      }
      for (let offset = 0; offset < updates.length; offset += 1_000) {
        await client.request({
          url: `https://sheets.googleapis.com/v4/spreadsheets/${copy.id}/values:batchUpdate`,
          method: "POST",
          params: { valueInputOption: "RAW" },
          data: { data: updates.slice(offset, offset + 1_000) },
        });
      }
      const requests = getUnselectedRowRanges(rows, treatments).map(({ startRow, count }) => ({
        deleteDimension: {
          range: {
            sheetId: targetSheet.properties.sheetId,
            dimension: "ROWS",
            startIndex: startRow - 1,
            endIndex: startRow - 1 + count,
          },
        },
      }));
      requests.push(...sheets
        .filter(({ properties }) => properties.sheetId !== targetSheet.properties.sheetId)
        .map(({ properties }) => ({ deleteSheet: { sheetId: properties.sheetId } })));
      if (requests.length) {
        await client.request({
          url: `https://sheets.googleapis.com/v4/spreadsheets/${copy.id}:batchUpdate`,
          method: "POST",
          data: { requests },
        });
      }
      return { client, copy };
    } catch (error) {
      try {
        await client.request({
          url: `https://www.googleapis.com/drive/v3/files/${copy.id}`,
          method: "DELETE",
          params: { supportsAllDrives: true },
        });
      } catch (cleanupError) {
        server.config.logger.error("[sheets-export] Suppression de la copie incomplète.", { error: cleanupError });
      }
      throw error;
    }
  }

  async function handle(req, res, next, server) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/sheets/connect" && req.method === "POST") {
      const identity = await authorizeApiRequest(req, res, server, {
        mutate: true,
        returnIdentity: true,
        authApiTarget,
        appOrigin,
      });
      if (!identity) return;
      if (identity.role !== "ADMIN") return send(res, 403, { error: "Une erreur est survenue!" });
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8_192) throw Object.assign(new Error("Requête trop volumineuse."), { statusCode: 413 });
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw Object.assign(new Error("Corps JSON invalide."), { statusCode: 400 });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)
          || typeof body.url !== "string" || body.url.length > 2_048) {
          throw Object.assign(new Error("Lien Google Sheets invalide."), { statusCode: 400 });
        }
        const nextSheetId = spreadsheetIdFromUrl(body.url);
        const rows = await loadSheet(nextSheetId);
        if (!rows.length || !rows[0]?.length) {
          throw Object.assign(new Error("Le fichier est accessible, mais ne contient pas d’en-têtes dans la plage configurée."), { statusCode: 422 });
        }
        activeSheetId = nextSheetId;
        cache = { sheetId: nextSheetId, at: Date.now(), rows };
        return send(res, 200, { connected: true, first: 2, last: rows.length, rowCount: Math.max(0, rows.length - 1) });
      } catch (error) {
        const status = error.statusCode ?? error.response?.status ?? 500;
        const message = error.statusCode
          ? error.message
          : status === 401 || status === 403 || status === 404
            ? "Accès au classeur refusé ou fichier introuvable."
            : "Connexion Google Sheets indisponible.";
        return send(res, status, { error: message });
      }
    }

    if (url.pathname === "/api/sheets/export" && req.method === "POST") {
      const identity = await authorizeApiRequest(req, res, server, {
        mutate: true,
        returnIdentity: true,
        authApiTarget,
        appOrigin,
      });
      if (!identity) return;
      if (!["ADMIN", "SUPERVISEUR"].includes(identity.role)) {
        return send(res, 403, { error: "Une erreur est survenue!" });
      }

      let copy;
      let client;
      try {
        const format = url.searchParams.get("format");
        if (!["excel", "google-sheets"].includes(format)) {
          return send(res, 400, { error: "Une erreur est survenue!" });
        }
        const filters = Object.fromEntries(["from", "to", "role", "agent"]
          .map((key) => [key, url.searchParams.get(key) ?? ""]));
        const treatments = await listExportTreatments(req, server, filters);

        if (format === "excel") {
          client = await auth.getClient();
          const sourceFile = await client.request({
            url: `https://www.googleapis.com/drive/v3/files/${activeSheetId}/export`,
            params: { mimeType: EXCEL_MIME_TYPE },
            responseType: "arraybuffer",
          });
          const workbook = await buildFilledExcelWorkbook(
            Buffer.from(sourceFile.data),
            await loadSheet(),
            treatments,
            range,
          );
          const filename = `saisies-confiserie-${new Date().toISOString().slice(0, 10)}.xlsx`;
          return sendBinary(res, workbook, filename, treatments.length);
        }

        ({ client, copy } = await createFilledCopy(treatments, server));

        if (format === "google-sheets") {
          return send(res, 200, {
            url: copy.webViewLink ?? `https://docs.google.com/spreadsheets/d/${copy.id}/edit`,
            count: treatments.length,
          });
        }
      } catch (error) {
        const upstreamStatus = error.response?.status ?? error.statusCode;
        server.config.logger.error(
          `[sheets-export] Export échoué${upstreamStatus ? ` (HTTP ${upstreamStatus})` : ""}: ${error.message ?? String(error)}`,
        );
        if (client && copy?.id) {
          try {
            await client.request({
              url: `https://www.googleapis.com/drive/v3/files/${copy.id}`,
              method: "DELETE",
              params: { supportsAllDrives: true },
            });
          } catch (cleanupError) {
            server.config.logger.error("[sheets-export] Nettoyage de la copie échoué.", { error: cleanupError });
          }
        }
        const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 502;
        return send(res, status, { error: "Une erreur est survenue!" });
      }
    }

    if (url.pathname !== "/api/source" || req.method !== "GET") return next();
    if (!await authorizeApiRequest(req, res, server, { authApiTarget, appOrigin })) return;

    if (!activeSheetId) return send(res, 500, { error: "SHEET_ID manquant dans le fichier .env" });

    try {
      const [headers = [], ...data] = await loadSheet();
      // Numérotation identique à Google Sheets : la ligne 1 contient les en-têtes, les données vont de 2 à last.
      const first = 2;
      const last = data.length + 1;
      const row = Number(url.searchParams.get("row") ?? first);
      if (!Number.isInteger(row) || row < first || row > last)
        return send(res, 404, { error: `Ligne ${row} introuvable (${first} à ${last})`, first, last });

      const cells = data[row - first];
      const values = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
      send(res, 200, { row, first, last, values });
    } catch (e) {
      send(res, e.response?.status ?? 500, { error: "Lecture Google Sheets indisponible." });
    }
  }

  return {
    name: "sheets-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => handle(req, res, next, server));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => handle(req, res, next, server));
    },
  };
}
