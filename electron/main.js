const { app, BrowserWindow, dialog, shell, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('path');
const isDev = require('electron-is-dev');
const { createBackend } = require('../backend-sqlite/server.cjs');
const { startOneDriveBackup } = require('../backend-sqlite/onedriveBackup.cjs');
const { createSyncServer } = require('../backend-sqlite/sync-server.cjs');
const { loadTrustedCertificates, trustCertificateAuthorities, isTrustedCertificate } = require('../backend-sqlite/tlsTrust.cjs');

const envFile = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), '.env')
  : path.resolve(__dirname, '../.env');
for (const configFile of app.isPackaged ? [envFile] : [envFile, path.resolve(__dirname, '../frontend/.env'), path.resolve(__dirname, '../frontend/.env.local')]) {
  try {
    for (const line of fs.readFileSync(configFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      let value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
      if (match[1] === 'GOOGLE_CREDENTIALS' && !path.isAbsolute(value)) value = path.resolve(path.dirname(configFile), value);
      process.env[match[1]] = value;
    }
  } catch { /* .env is optional ; Windows env vars take priority. */ }
}

let mainWindow;
let catalogWindow;
let backend;
let syncServer;
let onedriveBackup = null;

const remoteServer = process.env.CHOCOLAT_SERVER_URL;
if (remoteServer) {
  const serverUrl = new URL(remoteServer);
  if (serverUrl.protocol !== 'https:' && serverUrl.protocol !== 'http:') throw new Error('CHOCOLAT_SERVER_URL must use HTTP or HTTPS.');
  if (serverUrl.protocol === 'http:' && !['1', 'true', 'yes'].includes(String(process.env.CHOCOLAT_ALLOW_INSECURE_LAN || '').toLowerCase())) {
    throw new Error('CHOCOLAT_SERVER_URL HTTP requis CHOCOLAT_ALLOW_INSECURE_LAN=1.');
  }
}

const syncEnabled = process.env.SYNC_ENABLED === '1' || process.env.SYNC_ENABLED === 'true';
  const syncUrl = process.env.SYNC_URL || 'https://127.0.0.1:3002';

  // TLS config for sync server (same certs as main backend)
  const syncTlsConfig = (process.env.CHOCOLAT_TLS_CERT && process.env.CHOCOLAT_TLS_KEY)
    ? { cert: fs.readFileSync(process.env.CHOCOLAT_TLS_CERT), key: fs.readFileSync(process.env.CHOCOLAT_TLS_KEY) }
    : null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, 'chocologo.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
    autoHideMenuBar: true,
  });
  const startUrl = getStartUrl();
  await mainWindow.loadURL(startUrl);
  if (isDev) mainWindow.webContents.openDevTools();
  
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function getStartUrl() {
  return remoteServer || (isDev
    ? 'http://localhost:5173'
    : `${backend.secure ? 'https' : 'http'}://${backend.secure ? 'localhost' : '127.0.0.1'}:${backend.server.address().port}`);
}

ipcMain.handle('catalog:open', async (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) throw new Error('Fenêtre principale non autorisée.');
  if (catalogWindow && !catalogWindow.isDestroyed()) {
    catalogWindow.show();
    catalogWindow.focus();
    return true;
  }
  catalogWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 800,
    minHeight: 550,
    icon: path.join(__dirname, 'chocologo.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
  });
  catalogWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  catalogWindow.on('closed', () => { catalogWindow = null; });
  await catalogWindow.loadURL(new URL('/catalogue', getStartUrl()).toString());
  return true;
});

ipcMain.handle('catalog:close', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  catalogWindow?.close();
  return true;
});

function stopBackend() {
  try { onedriveBackup?.stop(); } catch {}
  onedriveBackup = null;
  backend?.close();
  backend = null;
  syncServer?.close();
  syncServer = null;
}

// Certificats auto-signés / mkcert : seuls ceux signés par CHOCOLAT_TLS_CA ou identiques
// à CHOCOLAT_TLS_CERT sont acceptés, pour l'interface Electron comme pour Node.
function installCertificateTrust() {
  const trusted = loadTrustedCertificates();
  trustCertificateAuthorities();
  if (!trusted.authorities.length && !trusted.pinned.length) return;
  const ERR_CERT_AUTHORITY_INVALID = -202;
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.errorCode === ERR_CERT_AUTHORITY_INVALID && isTrustedCertificate(request.certificate.data, trusted)) return callback(0);
    callback(-3);
  });
}

app.whenReady().then(async () => {
  installCertificateTrust();
  if (!remoteServer && syncEnabled) {
    // Le backend lit SYNC_URL à sa création : il doit viser le serveur de synchronisation local.
    process.env.SYNC_URL = `${syncTlsConfig ? 'https' : 'http'}://127.0.0.1:${Number(process.env.SYNC_PORT || 3002)}`;
  }
  if (!remoteServer) {
    backend = createBackend({
      dataDir: process.env.CHOCOLAT_DATA_DIR || path.join(app.getPath('userData'), 'database'),
      frontendDir: path.join(__dirname, '../frontend/dist'),
      host: process.env.CHOCOLAT_HOST || '127.0.0.1',
      port: Number(process.env.PORT || 3001),
    });
    await new Promise((resolve, reject) => {
      if (backend.server.listening) return resolve();
      backend.server.once('listening', resolve);
      backend.server.once('error', reject);
    });
    try {
      onedriveBackup = startOneDriveBackup({
        db: backend.db,
        dataDir: process.env.CHOCOLAT_DATA_DIR || path.join(app.getPath('userData'), 'database'),
        logger: console,
      });
    } catch (error) {
      console.error('Sauvegarde OneDrive non démarrée :', error.message || error);
    }
    if (backend.initialCredentials) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Compte administrateur initial',
        message: `Login : ${backend.initialCredentials.login}\nMot de passe : ${backend.initialCredentials.password}`,
        detail: 'Notez ces identifiants maintenant. Ils ne seront plus affichés après cette première ouverture.',
        buttons: ['J’ai noté les identifiants'],
        noLink: true,
      });
    }
  }
  if (syncEnabled) {
    try {
      syncServer = createSyncServer({
        dataDir: process.env.SYNC_DIR || path.join(app.getPath('userData'), 'sync-db'),
        host: process.env.SYNC_HOST || '0.0.0.0',
        port: Number(process.env.SYNC_PORT || 3002),
        tlsConfig: syncTlsConfig,
      });
      await new Promise((resolve) => {
        if (syncServer.server.listening) return resolve();
        syncServer.server.once('listening', resolve);
      });
      if (syncServer.initialCredentials) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'Compte admin synchronisation',
          message: `Login : ${syncServer.initialCredentials.login}\nMot de passe : ${syncServer.initialCredentials.password}`,
          detail: 'Utilisez ces identifiants pour connecter d\'autres ordinateurs via SYNC_URL.',
          buttons: ['J’ai noté les identifiants'],
          noLink: true,
        });
      }
    } catch (error) {
      console.error('Échec du démarrage du serveur de synchronisation :', error);
    }
  }
  // Ensure correct sync URL for renderer.
  // A client workstation keeps its configured remote sync URL (when SYNC_ENABLED is
  // set) instead of being forced to localhost.
  if (remoteServer && syncEnabled && !process.env.SYNC_URL) {
    const remoteUrl = new URL(remoteServer);
    process.env.SYNC_URL = `${remoteUrl.protocol}//${remoteUrl.hostname}:${process.env.SYNC_PORT || 3002}`;
  }
  if (syncServer) {
    const protocol = syncTlsConfig ? 'https:' : 'http:';
    const port = syncServer.server.address()?.port || Number(process.env.SYNC_PORT || 3002);
    process.env.SYNC_URL = `${protocol}//127.0.0.1:${port}`;
  }
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await createWindow();
      } catch (error) {
        dialog.showErrorBox('Chargement impossible', error.message || 'La page de l’application n’a pas pu être chargée.');
      }
    }
  });
}).catch(async (error) => {
  console.error('Démarrage de ChocoLogic impossible :', error);
  const detail = error.code === 'EADDRINUSE'
    ? `Le port ${process.env.PORT || 3001} est déjà utilisé. Fermez l’autre instance de ChocoLogic puis réessayez.`
    : error.message || 'Le serveur local ou l’interface n’a pas pu démarrer.';
  await dialog.showMessageBox({
    type: 'error',
    title: 'Démarrage impossible',
    message: 'ChocoLogic n’a pas pu démarrer.',
    detail,
    buttons: ['Fermer'],
    noLink: true,
  });
  stopBackend();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopBackend);
