// Sauvegarde automatique de la base SQLite vers OneDrive (Microsoft Graph).
// Envoi toutes les ONEDRIVE_INTERVAL_MS millisecondes (60 000 ms par défaut).
// Le compte Microsoft sera configuré plus tard via ONEDRIVE_CLIENT_ID +
// ONEDRIVE_REFRESH_TOKEN (voir `npm run onedrive:login` et .env.example).
// Tant que ce n'est pas configuré, le module reste inactif et ne bloque rien.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GRAPH_SCOPE = 'Files.ReadWrite offline_access';
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024; // multiple de 320 Kio exigé par Graph

const status = {
  enabled: false,
  configured: false,
  running: false,
  intervalMs: 60_000,
  lastRun: null,
  lastSuccess: null,
  lastError: null,
  lastBytes: 0,
  lastFile: null,
  uploads: 0,
};

function readConfig(dataDir) {
  const tokenStore = process.env.ONEDRIVE_TOKEN_STORE
    || (dataDir ? path.join(dataDir, 'onedrive-token.json') : null);
  let storedRefreshToken = '';
  if (!process.env.ONEDRIVE_REFRESH_TOKEN && tokenStore) {
    try {
      storedRefreshToken = JSON.parse(fs.readFileSync(tokenStore, 'utf8')).refresh_token || '';
    } catch { /* pas encore de jeton enregistré */ }
  }
  return {
    enabled: ['1', 'true', 'yes'].includes(String(process.env.ONEDRIVE_ENABLED || '').toLowerCase()),
    clientId: String(process.env.ONEDRIVE_CLIENT_ID || '').trim(),
    tenant: String(process.env.ONEDRIVE_TENANT || process.env.ONEDRIVE_TENANT_ID || 'common').trim() || 'common',
    refreshToken: String(process.env.ONEDRIVE_REFRESH_TOKEN || storedRefreshToken).trim(),
    folder: String(process.env.ONEDRIVE_FOLDER || 'ChocolatBackoffice').trim() || 'ChocolatBackoffice',
    filename: String(process.env.ONEDRIVE_FILENAME || 'chocolat.sqlite3').trim() || 'chocolat.sqlite3',
    intervalMs: Math.max(15_000, Number(process.env.ONEDRIVE_INTERVAL_MS || 60_000) || 60_000),
    tokenStore,
  };
}

function persistRefreshToken(tokenStore, refreshToken, logger) {
  if (!tokenStore || !refreshToken) return;
  try {
    fs.mkdirSync(path.dirname(tokenStore), { recursive: true });
    fs.writeFileSync(tokenStore, JSON.stringify({ refresh_token: refreshToken, updated_at: new Date().toISOString() }));
  } catch (error) {
    logger?.warn?.('Sauvegarde du jeton OneDrive impossible : ' + (error.message || error));
  }
}

async function fetchAccessToken(config, logger) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    scope: GRAPH_SCOPE,
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Authentification OneDrive refusée (${response.status}). ${details.slice(0, 200)}`.trim());
  }
  const body = await response.json();
  if (!body.access_token) throw new Error('OneDrive : jeton d’accès absent de la réponse Microsoft.');
  if (body.refresh_token && body.refresh_token !== config.refreshToken) {
    config.refreshToken = body.refresh_token;
    persistRefreshToken(config.tokenStore, body.refresh_token, logger);
  }
  return body.access_token;
}

async function uploadSimple(accessToken, remotePath, buffer) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${remotePath}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
    body: buffer,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Envoi OneDrive refusé (${response.status}).`);
}

async function uploadResumable(accessToken, remotePath, buffer) {
  const sessionResponse = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${remotePath}:/createUploadSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!sessionResponse.ok) throw new Error(`Session d’envoi OneDrive refusée (${sessionResponse.status}).`);
  const { uploadUrl } = await sessionResponse.json();
  if (!uploadUrl) throw new Error('OneDrive : URL de session d’envoi absente.');
  for (let offset = 0; offset < buffer.length; offset += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, buffer.length);
    const chunkResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(end - offset),
        'Content-Range': `bytes ${offset}-${end - 1}/${buffer.length}`,
      },
      body: buffer.subarray(offset, end),
      signal: AbortSignal.timeout(120_000),
    });
    if (![200, 201, 202].includes(chunkResponse.status)) {
      throw new Error(`Fragment OneDrive refusé (${chunkResponse.status}).`);
    }
  }
}

async function backupOnce(db, dataDir, logger) {
  const config = readConfig(dataDir);
  status.enabled = config.enabled;
  status.configured = Boolean(config.clientId && config.refreshToken);
  status.intervalMs = config.intervalMs;
  if (!config.enabled || status.running) return status;
  status.running = true;
  status.lastRun = new Date().toISOString();
  try {
    if (!config.clientId || !config.refreshToken) {
      throw new Error('OneDrive non configuré : renseignez ONEDRIVE_CLIENT_ID et ONEDRIVE_REFRESH_TOKEN (voir `npm run onedrive:login`).');
    }
    const source = dataDir ? path.join(dataDir, 'chocolat.sqlite3') : null;
    if (!source || !fs.existsSync(source)) throw new Error('Base SQLite introuvable pour la sauvegarde OneDrive.');
    try { db?.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* base possiblement fermée : on envoie le fichier tel quel */ }
    const snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chocolat-onedrive-')), config.filename);
    fs.copyFileSync(source, snapshot);
    const buffer = fs.readFileSync(snapshot);
    try { fs.rmSync(path.dirname(snapshot), { recursive: true, force: true }); } catch {}
    const accessToken = await fetchAccessToken(config, logger);
    const remotePath = `${config.folder.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(config.filename)}`;
    if (buffer.length <= SIMPLE_UPLOAD_MAX_BYTES) await uploadSimple(accessToken, remotePath, buffer);
    else await uploadResumable(accessToken, remotePath, buffer);
    status.uploads += 1;
    status.lastSuccess = new Date().toISOString();
    status.lastBytes = buffer.length;
    status.lastFile = `${config.folder}/${config.filename}`;
    status.lastError = null;
    logger?.info?.(`Sauvegarde OneDrive envoyée (${buffer.length} octets vers ${status.lastFile}).`);
  } catch (error) {
    status.lastError = error.message || String(error);
    logger?.warn?.('Sauvegarde OneDrive impossible : ' + status.lastError);
  } finally {
    status.running = false;
  }
  return { ...status };
}

function startOneDriveBackup({ db, dataDir, logger = console } = {}) {
  const config = readConfig(dataDir);
  status.enabled = config.enabled;
  status.configured = Boolean(config.clientId && config.refreshToken);
  status.intervalMs = config.intervalMs;
  if (!config.enabled) {
    logger?.info?.('Sauvegarde OneDrive désactivée (ONEDRIVE_ENABLED différent de 1).');
    return { stop() {}, runNow: () => backupOnce(db, dataDir, logger), getStatus: getOneDriveStatus };
  }
  if (!status.configured) {
    logger?.warn?.('Sauvegarde OneDrive activée mais compte Microsoft non configuré : aucun envoi tant que ONEDRIVE_CLIENT_ID et ONEDRIVE_REFRESH_TOKEN ne sont pas renseignés.');
  }
  const timer = setInterval(() => { backupOnce(db, dataDir, logger).catch(() => {}); }, config.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const firstRun = setTimeout(() => { backupOnce(db, dataDir, logger).catch(() => {}); }, 5_000);
  if (typeof firstRun.unref === 'function') firstRun.unref();
  logger?.info?.(`Sauvegarde OneDrive planifiée toutes les ${Math.round(config.intervalMs / 1000)} s.`);
  return {
    stop() { clearInterval(timer); clearTimeout(firstRun); },
    runNow: () => backupOnce(db, dataDir, logger),
    getStatus: getOneDriveStatus,
  };
}

function getOneDriveStatus() {
  return { ...status };
}

module.exports = { startOneDriveBackup, runOneDriveBackup: backupOnce, getOneDriveStatus };
