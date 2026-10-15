// Lance Chocolat Backoffice comme application web, sans Electron.
// Le backend Express sert l'interface React (frontend/dist) et l'API sur le même port :
// les autres postes ouvrent simplement http(s)://<ce-poste>:3001 dans leur navigateur.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

// Même lecture du .env que electron/main.js : les variables déjà définies gardent la priorité.
for (const configFile of [path.join(rootDir, '.env')]) {
  try {
    for (const line of fs.readFileSync(configFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      let value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
      if (match[1] === 'GOOGLE_CREDENTIALS' && !path.isAbsolute(value)) value = path.resolve(path.dirname(configFile), value);
      process.env[match[1]] = value;
    }
  } catch { /* .env facultatif */ }
}

const { createBackend } = require('../backend-sqlite/server.cjs');
const { startOneDriveBackup } = require('../backend-sqlite/onedriveBackup.cjs');
const { createSyncServer } = require('../backend-sqlite/sync-server.cjs');
const { trustCertificateAuthorities } = require('../backend-sqlite/tlsTrust.cjs');

// Par défaut, on reprend le dossier de données de l'ancienne application Electron
// pour conserver comptes, saisies et sources déjà importées.
const legacyUserData = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'chocolat-backoffice-electron')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'chocolat-backoffice-electron')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'chocolat-backoffice-electron');
const dataDir = process.env.CHOCOLAT_DATA_DIR || path.join(legacyUserData, 'database');
const frontendDir = path.join(rootDir, 'frontend', 'dist');

if (!fs.existsSync(path.join(frontendDir, 'index.html'))) {
  console.error('Interface introuvable : lancez d’abord « npm run build:frontend ».');
  process.exit(1);
}

let backend;
let syncServer;
let onedriveBackup;

function listening(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function stop() {
  try { onedriveBackup?.stop(); } catch {}
  backend?.close();
  syncServer?.close();
  process.exit(0);
}

async function main() {
  trustCertificateAuthorities();
  const syncEnabled = ['1', 'true'].includes(String(process.env.SYNC_ENABLED || '').toLowerCase());
  const syncTlsConfig = process.env.CHOCOLAT_TLS_CERT && process.env.CHOCOLAT_TLS_KEY
    ? { cert: fs.readFileSync(process.env.CHOCOLAT_TLS_CERT), key: fs.readFileSync(process.env.CHOCOLAT_TLS_KEY) }
    : null;

  if (syncEnabled) {
    // Le navigateur reçoit les événements temps réel via le backend (/api/v1/events) :
    // le serveur de synchronisation n'a plus besoin d'être exposé sur le réseau.
    const syncPort = Number(process.env.SYNC_PORT || 3002);
    syncServer = createSyncServer({
      dataDir: process.env.SYNC_DIR || path.join(legacyUserData, 'sync-db'),
      host: process.env.SYNC_HOST || '127.0.0.1',
      port: syncPort,
      tlsConfig: syncTlsConfig,
    });
    await listening(syncServer.server);
    process.env.SYNC_URL = `${syncTlsConfig ? 'https' : 'http'}://127.0.0.1:${syncPort}`;
    if (syncServer.initialCredentials) {
      console.warn(`Compte admin synchronisation — login : ${syncServer.initialCredentials.login} — mot de passe : ${syncServer.initialCredentials.password}`);
    }
  }

  const host = process.env.CHOCOLAT_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3001);
  backend = createBackend({ dataDir, frontendDir, host, port });
  await listening(backend.server);

  try {
    onedriveBackup = startOneDriveBackup({ db: backend.db, dataDir, logger: console });
  } catch (error) {
    console.error('Sauvegarde OneDrive non démarrée :', error.message || error);
  }

  if (backend.initialCredentials) {
    console.warn('\n=== Compte administrateur initial (affiché une seule fois) ===');
    console.warn(`Login : ${backend.initialCredentials.login}`);
    console.warn(`Mot de passe : ${backend.initialCredentials.password}\n`);
  }

  const protocol = backend.secure ? 'https' : 'http';
  console.info(`\nChocolat Backoffice est en ligne. Base SQLite : ${dataDir}`);
  console.info(`  Sur ce poste      : ${protocol}://localhost:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    for (const address of lanAddresses()) console.info(`  Depuis le réseau  : ${protocol}://${address}:${port}`);
  } else if (host !== '127.0.0.1' && host !== 'localhost') {
    console.info(`  Depuis le réseau  : ${protocol}://${host}:${port}`);
  } else {
    console.info('  (accès local uniquement : définissez CHOCOLAT_HOST=0.0.0.0 pour partager sur le réseau)');
  }
  console.info('Laissez cette fenêtre ouverte. Ctrl+C pour arrêter.\n');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Le port ${process.env.PORT || 3001} est déjà utilisé (l’application Electron est peut-être encore ouverte).`
    : `Démarrage impossible : ${error.message || error}`);
  try { onedriveBackup?.stop(); } catch {}
  backend?.close();
  syncServer?.close();
  process.exit(1);
});
