const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const ExcelJS = require('exceljs');
const { getOneDriveStatus } = require('./onedriveBackup.cjs');
function loadEnvFile(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      let value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
      if (match[1] === 'GOOGLE_CREDENTIALS' && !path.isAbsolute(value)) value = path.resolve(path.dirname(file), value);
      process.env[match[1]] = value;
    }
  } catch { /* configuration facultative */ }
}
loadEnvFile(path.resolve(__dirname, '../.env'));
loadEnvFile(path.resolve(__dirname, '../frontend/.env'));
loadEnvFile(path.resolve(__dirname, '../frontend/.env.local'));

const roles = ['AGENT', 'SUPERVISEUR', 'ADMIN'];
const groupStatuses = ['NON ASSIGNE', 'EN COURS', 'SAISIE TERMINEE', 'VALIDEE'];
const fields = ["Dans le scope ?", 'CODIFICATION AVEC PHOTO oui/non', 'EAN13', 'Company', 'Major Brand', 'BRAND', 'NEW NOM DE SPECIALITE', 'Label', 'Bonus1', 'Bonus2', 'Bonus3', 'Bonus4', 'Type De Produit', 'Emballage', 'INFO PARFUM', 'Additifs', 'INFO FOURRAGE', 'Type De Confiserie', 'TYPE DE SPECIALITE', 'TYPE DE SUBSTITUT', 'PRESENTATION', 'INFO GARNITURE', 'INFO DRAGEIFIE', 'INFO CREUX/PLEIN', 'INFO ATTACHE', 'Libelle Produit', 'Localisation', 'Info Saison', 'Info HALLOWEEN', 'Info Noel', 'Info Paques', 'INFO AUTOMNE', 'INFO SAINT VALENTIN', 'INFO FETE DES MERES', 'Info Forme Noel', 'Info Forme Pâques', 'Info Forme Permanent', 'Info Forme Halloween', 'INFO FORME AUTOMNE', 'INFO FORME ST VALENTIN', 'INFO FORME FETE DES MERES', 'Info Sante Nature', 'Extras', 'Ethnique Info', 'Informations Bilgcls', 'Info Ecologique', 'Info Commerce Equtbl', 'Info Label', 'Info Promotion', 'Onces Totales', 'Compte Total', 'Compte Total De Paqt'];
const publicUser = (u) => {
  const firstName = u.firstName ?? u.first_name ?? '';
  const lastName = u.lastName ?? u.last_name ?? '';
  return {
    id: String(u.id), login: u.login, firstName, lastName,
    fullName: u.fullName ?? u.full_name ?? `${firstName} ${lastName}`.trim(),
    role: u.role, active: Boolean(u.active), requiresProfileUpdate: Number(u.profile_completed ?? 1) === 0,
  };
};
const ok = (res, data) => res.json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, errors: [{ message }] });
const hash = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') });
function verify(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64);
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

const normalizeHeader = (header) => String(header).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const eanHeader = (headers) => headers.find(header => { const h = normalizeHeader(header); return h === 'EAN' || h === 'EAN13' || h === 'EANS' || h === 'CHECKDIGIT'; });

function createBackend({ dataDir, frontendDir, host = process.env.CHOCOLAT_HOST || '127.0.0.1', port = Number(process.env.PORT || 3001), logger = console } = {}) {
  const storeDir = dataDir || process.env.CHOCOLAT_DATA_DIR || path.join(process.env.PROGRAMDATA || require('node:os').homedir(), 'ChocolatBackoffice');
  fs.mkdirSync(storeDir, { recursive: true });
  const db = new Database(path.join(storeDir, 'chocolat.sqlite3'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('AGENT','SUPERVISEUR','ADMIN')), salt TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, profile_completed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_workbooks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, file_type TEXT NOT NULL, imported_by INTEGER NOT NULL REFERENCES users(id), imported_at TEXT NOT NULL, sheet_count INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS source_rows (row_number INTEGER PRIMARY KEY, values_json TEXT NOT NULL, source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS treatments (source_row INTEGER PRIMARY KEY, current_data TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL, submitted_at TEXT, quality_feedback TEXT, source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS distribution_groups (group_start INTEGER PRIMARY KEY, status TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_row INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
    CREATE TABLE IF NOT EXISTS catalog_sheets (sheet_name TEXT PRIMARY KEY, headers_json TEXT NOT NULL, rows_json TEXT NOT NULL, row_count INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog_import_sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expected_sheets TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog_import_staging (import_id TEXT NOT NULL REFERENCES catalog_import_sessions(id) ON DELETE CASCADE, sheet_name TEXT NOT NULL, headers_json TEXT NOT NULL, rows_json TEXT NOT NULL, row_count INTEGER NOT NULL, PRIMARY KEY(import_id,sheet_name));
    CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, field_name TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS treatment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, source_row INTEGER NOT NULL, values_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL, submitted_at TEXT, quality_feedback TEXT, source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL, actor_role TEXT);
  `);
  // Migrations for existing databases: add missing columns if missing
  const sourceRowsCols = db.pragma('table_info(source_rows)');
  if (!sourceRowsCols.some(c => c.name === 'source_workbook_id')) {
    db.exec('ALTER TABLE source_rows ADD COLUMN source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL');
  }
  const treatmentsCols = db.pragma('table_info(treatments)');
  if (!treatmentsCols.some(c => c.name === 'source_workbook_id')) {
    db.exec('ALTER TABLE treatments ADD COLUMN source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL');
  }
  const historyCols = db.pragma('table_info(treatment_history)');
  if (!historyCols.some(c => c.name === 'source_workbook_id')) {
    db.exec('ALTER TABLE treatment_history ADD COLUMN source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL');
  }
  if (!historyCols.some(c => c.name === 'actor_role')) {
    db.exec('ALTER TABLE treatment_history ADD COLUMN actor_role TEXT');
  }
  // Create indexes after migrations
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_suggestions_field_value ON suggestions(field_name, value);
    CREATE INDEX IF NOT EXISTS idx_source_rows_workbook ON source_rows(source_workbook_id);
    CREATE INDEX IF NOT EXISTS idx_treatments_workbook ON treatments(source_workbook_id);
    CREATE INDEX IF NOT EXISTS idx_treatment_history_source_row ON treatment_history(source_row, updated_at DESC);
  `);
  const now = () => new Date().toISOString();
  const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  let initialCredentials = null;
  if (!userCount) {
    const login = (process.env.AUTH_BOOTSTRAP_ADMIN_LOGIN || 'admin').trim().toLowerCase();
    const password = process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
    if (password.length < 12) throw new Error('AUTH_BOOTSTRAP_ADMIN_PASSWORD doit comporter au moins 12 caractères.');
    const secret = hash(password);
    db.prepare('INSERT INTO users(login,first_name,last_name,role,salt,password_hash,profile_completed,created_at) VALUES(?,?,?,?,?,?,0,?)')
      .run(login, 'ADMIN', 'ADMIN', 'ADMIN', secret.salt, secret.hash, now());
    initialCredentials = { login, password };
  } else {
    // Migration for existing databases: add profile_completed column if missing
    const userColumns = db.pragma('table_info(users)');
    if (!userColumns.some(column => column.name === 'profile_completed')) {
      db.exec('ALTER TABLE users ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 1');
      db.prepare("UPDATE users SET first_name='ADMIN',last_name='ADMIN',profile_completed=0 WHERE lower(login)='admin' AND role='ADMIN' AND first_name='Admin' AND last_name='Principal'").run();
    }
  }
   try {
     const dictionaries = require('./suggestionDictionaries.json');
     if (Object.keys(dictionaries).length > 0) {
       const seedInsert = db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?)');
       const seedCount = db.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
       if (seedCount === 0) {
         const insertMany = db.transaction((dicts) => {
           for (const [fieldName, values] of Object.entries(dicts)) {
             for (const value of values) {
               if (typeof value === 'string' && value.length > 0) {
                 seedInsert.run(fieldName, value.trim(), now(), now());
               }
             }
           }
         });
         insertMany(dictionaries);
       }
     }
   } catch (e) {
     if (process.env.NODE_ENV !== 'test') logger?.warn?.('Dictionnaires de suggestions non disponibles au démarrage.');
   }
   const app = express();
  app.disable('x-powered-by');
    const syncCspOrigins = [];
    try {
      if (process.env.SYNC_URL) {
        const syncOrigin = new URL(process.env.SYNC_URL).origin;
        syncCspOrigins.push(syncOrigin, syncOrigin.replace(/^http/, 'ws'));
      }
    } catch { /* SYNC_URL invalide : on garde les origines locales par défaut */ }
    app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:3002 http://localhost:3002 https://127.0.0.1:3002 https://localhost:3002 ws://127.0.0.1:3002 ws://localhost:3002 wss://127.0.0.1:3002 wss://localhost:3002" + (syncCspOrigins.length ? " " + syncCspOrigins.join(" ") : "")); next(); });
  app.use(express.json({ limit: '32mb' }));
  const loginAttempts = new Map();
  const sessionFor = (req) => {
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('chocolat_session='))?.slice('chocolat_session='.length);
    if (!token) return null;
    const session = db.prepare('SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(crypto.createHash('sha256').update(decodeURIComponent(token)).digest('hex'), Date.now());
    return session ? { session, user: session } : null;
  };
  const auth = (req, res, next) => {
    const found = sessionFor(req);
    if (!found) return fail(res, 401, 'Session expirée. Connectez-vous à nouveau.');
    req.user = found.user; req.session = found.session;
    const profileSetupAllowed = ['/api/v1/auth/me', '/api/v1/auth/profile', '/api/v1/auth/logout'].includes(req.path);
    if (Number(req.user.profile_completed) === 0 && !profileSetupAllowed) return fail(res, 428, 'Renseignez votre prénom et votre nom avant de continuer.');
    next();
  };
  const allow = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : fail(res, 403, 'Droits insuffisants.');
  const csrf = (req, res, next) => {
    const supplied = req.get('X-CSRF-Token') || '';
    const actual = crypto.createHash('sha256').update(supplied).digest();
    const expected = Buffer.from(req.session.csrf_hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? next() : fail(res, 403, 'Jeton de sécurité invalide.');
  };
  const protectedWrite = [auth, csrf];
  const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const allUsers = () => db.prepare('SELECT * FROM users ORDER BY last_name,first_name').all();
  const treatment = (row) => {
    const t = db.prepare('SELECT * FROM treatments WHERE source_row=?').get(row);
    if (!t) return null;
    const actor = userById(t.updated_by);
    const workbookName = t.source_workbook_id ? db.prepare('SELECT name FROM source_workbooks WHERE id=?').get(t.source_workbook_id)?.name || '' : '';
    return { sourceRow: t.source_row, currentData: JSON.parse(t.current_data), status: t.status, currentVersion: t.version, lastUpdatedAt: t.updated_at, submittedAt: t.submitted_at, lastUpdatedBy: { actorId: String(t.updated_by), actorType: actor?.role === 'SUPERVISEUR' ? 'QC' : 'USER' }, qualityFeedback: t.quality_feedback ? JSON.parse(t.quality_feedback) : null, errors: [], sourceWorkbookId: t.source_workbook_id, sourceWorkbookName: workbookName };
  };
  const sourceCount = () => db.prepare('SELECT COUNT(*) n FROM source_rows').get().n;
  const replaceSourceRows = (rows, fileName = 'Import CSV', fileType = 'csv') => {
    if (!Array.isArray(rows) || !rows.length || rows.length > 100_000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw Object.assign(new Error('Le classeur doit contenir des en-têtes et au moins une ligne de données.'), { statusCode: 400 });
    }
    const workbookResult = db.prepare('INSERT INTO source_workbooks(name,file_type,imported_by,imported_at,sheet_count,row_count) VALUES(?,?,?,?,?,?)').run(fileName, fileType, 1, now(), 1, rows.length);
    const sourceWorkbookId = workbookResult.lastInsertRowid;
    const insert = db.prepare('INSERT INTO source_rows(row_number,values_json,source_workbook_id) VALUES(?,?,?)');
    db.transaction(items => {
      db.prepare('DELETE FROM source_rows').run();
      items.forEach((values, index) => insert.run(index + 2, JSON.stringify(values), sourceWorkbookId));
    })(rows);
    return rows.length;
  };
  const rowsFromGrid = (grid) => {
    const [headerRow, ...dataRows] = grid ?? [];
    const headers = (headerRow ?? []).map(value => String(value ?? '').trim());
    if (!headers.length || headers.some(value => !value) || new Set(headers).size !== headers.length) {
      throw Object.assign(new Error('La première ligne de l’onglet doit contenir des en-têtes uniques et non vides.'), { statusCode: 400 });
    }
    const rows = dataRows
      .filter(row => row.some(value => String(value ?? '').trim()))
      .map(row => Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? '')])));
    if (!rows.length) throw Object.assign(new Error('Aucune ligne de données n’a été trouvée dans le classeur.'), { statusCode: 400 });
    return rows;
  };
  const parseCsvText = (text) => {
    const content = text.replace(/^\uFEFF/, '');
    const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
    const delimiter = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
    const grid = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < content.length; i += 1) {
      const char = content[i];
      if (char === '"' && quoted && content[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === delimiter && !quoted) { row.push(cell); cell = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && content[i + 1] === '\n') i += 1; row.push(cell); grid.push(row); row = []; cell = ''; }
      else cell += char;
    }
    if (cell || row.length) { row.push(cell); grid.push(row); }
    return rowsFromGrid(grid);
  };
  const normalizedSheetName = (name) => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const optionalRowsFromGrid = (grid) => {
    const populated = (grid ?? []).filter(row => Array.isArray(row) && row.some(value => String(value ?? '').trim()));
    return populated.length > 1 ? rowsFromGrid(grid) : null;
  };
  const sourceSheetFrom = (sheets, gid) => sheets.find(sheet => normalizedSheetName(sheet.name) === 'referent')
    ?? sheets.find(sheet => gid && String(sheet.id) === String(gid))
    ?? sheets[0];
  const workbookRowsFromExcel = (workbook) => workbook.worksheets.map((worksheet) => {
    const grid = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const width = Math.max(row.cellCount, row.actualCellCount);
      grid.push(Array.from({ length: width }, (_, index) => row.getCell(index + 1).text ?? String(row.getCell(index + 1).value ?? '')));
    });
    return { name: worksheet.name, id: worksheet.id, rows: optionalRowsFromGrid(grid) };
  }).filter(sheet => sheet.rows);
  const replaceWorkbookRows = (sourceRows, catalogSheets, fileName = 'Classeur importé', fileType = 'xlsx') => {
    if (!Array.isArray(sourceRows) || !sourceRows.length || sourceRows.length > 100_000 || sourceRows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw Object.assign(new Error('La feuille source doit contenir des lignes valides.'), { statusCode: 400 });
    }
    if (!Array.isArray(catalogSheets) || catalogSheets.length > 30 || catalogSheets.some(sheet => !sheet || typeof sheet.name !== 'string' || !sheet.name.trim() || sheet.name.length > 200 || !Array.isArray(sheet.rows) || !sheet.rows.length || sheet.rows.length > 100_000 || sheet.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) || new Set(catalogSheets.map(sheet => sheet.name)).size !== catalogSheets.length) {
      throw Object.assign(new Error('Les onglets secondaires du classeur sont invalides.'), { statusCode: 400 });
    }
    const normalizedSheets = catalogSheets.map(sheet => {
      const headers = Object.keys(sheet.rows[0]);
      if (!headers.length || sheet.rows.some(row => headers.some(header => !Object.hasOwn(row, header)))) {
        throw Object.assign(new Error(`Les colonnes de l’onglet « ${sheet.name} » sont invalides.`), { statusCode: 400 });
      }
      return { name: sheet.name, headers, rows: sheet.rows };
    });
    const workbookResult = db.prepare('INSERT INTO source_workbooks(name,file_type,imported_by,imported_at,sheet_count,row_count) VALUES(?,?,?,?,?,?)').run(fileName, fileType, 1, now(), normalizedSheets.length + 1, sourceRows.length);
    const sourceWorkbookId = workbookResult.lastInsertRowid;
    const save = db.transaction(() => {
      const insertRow = db.prepare('INSERT INTO source_rows(row_number,values_json,source_workbook_id) VALUES(?,?,?)');
      db.prepare('DELETE FROM source_rows').run();
      sourceRows.forEach((row, index) => insertRow.run(index + 2, JSON.stringify(row), sourceWorkbookId));
      db.prepare('DELETE FROM catalog_sheets').run();
      const insertSheet = db.prepare('INSERT INTO catalog_sheets(sheet_name,headers_json,rows_json,row_count,updated_at) VALUES(?,?,?,?,?)');
      normalizedSheets.forEach(sheet => insertSheet.run(sheet.name, JSON.stringify(sheet.headers), JSON.stringify(sheet.rows), sheet.rows.length, now()));
    });
    save();
    return { rows: sourceRows.length, sheets: normalizedSheets.length, sourceWorkbookId };
  };
  const importGoogleSheet = async (link) => {
    let sheetUrl;
    try { sheetUrl = new URL(String(link ?? '')); } catch { throw Object.assign(new Error('Saisissez un lien Google Sheets valide.'), { statusCode: 400 }); }
    const idMatch = sheetUrl.hostname === 'docs.google.com'
      ? sheetUrl.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)
      : null;
    if (!idMatch) throw Object.assign(new Error('Le lien doit pointer vers un document Google Sheets.'), { statusCode: 400 });
    const spreadsheetId = idMatch[1];
    const gid = sheetUrl.searchParams.get('gid') || sheetUrl.hash.match(/(?:^|[&#])gid=(\d+)/)?.[1];
    const credentials = process.env.GOOGLE_CREDENTIALS;
    if (credentials) {
      const keyFile = path.resolve(credentials);
      if (!fs.existsSync(keyFile)) throw Object.assign(new Error('Le fichier GOOGLE_CREDENTIALS est introuvable sur le poste serveur.'), { statusCode: 503 });
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
      const client = await auth.getClient();
      const metadata = await client.request({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
        params: { fields: 'sheets.properties' },
      });
      const sheets = (metadata.data.sheets ?? []).map(sheet => ({
        name: String(sheet.properties?.title ?? ''),
        id: sheet.properties?.sheetId,
      })).filter(sheet => sheet.name);
      const source = sourceSheetFrom(sheets, gid);
      if (!source) throw Object.assign(new Error('Le classeur Google Sheets ne contient aucun onglet.'), { statusCode: 404 });
      const withRows = [];
      for (const sheet of sheets) {
        const title = sheet.name.replace(/'/g, "''");
        const range = sheet === source && process.env.SHEET_RANGE
          ? process.env.SHEET_RANGE
          : `'${title}'!A:ZZ`;
        const result = await client.request({
          url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
          params: { valueRenderOption: 'FORMATTED_VALUE' },
        });
        const rows = optionalRowsFromGrid(result.data.values ?? []);
        if (rows) withRows.push({ ...sheet, rows });
      }
      const sourceRows = withRows.find(sheet => sheet.name === source.name)?.rows;
      if (!sourceRows) throw Object.assign(new Error('La feuille source ne contient aucune ligne de données.'), { statusCode: 400 });
      return { sourceRows, catalogSheets: withRows.filter(sheet => sheet.name !== source.name).map(({ name, rows }) => ({ name, rows })) };
    }
    const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
    exportUrl.searchParams.set('format', 'xlsx');
    const response = await fetch(exportUrl, { signal: AbortSignal.timeout(25_000), redirect: 'follow' });
    if (!response.ok) throw Object.assign(new Error('Google Sheets a refusé l’accès. Rendez le document accessible par lien ou configurez GOOGLE_CREDENTIALS sur le serveur.'), { statusCode: response.status === 404 ? 404 : 502 });
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 20 * 1024 * 1024) throw Object.assign(new Error('Le classeur dépasse la taille maximale autorisée de 20 Mo.'), { statusCode: 413 });
    const file = Buffer.from(await response.arrayBuffer());
    if (file.length > 20 * 1024 * 1024) throw Object.assign(new Error('Le classeur dépasse la taille maximale autorisée de 20 Mo.'), { statusCode: 413 });
    if (/<html[\s>]/i.test(file.subarray(0, 500).toString('utf8'))) throw Object.assign(new Error('Ce Google Sheet est privé. Partagez-le avec le compte de service ou autorisez l’accès par lien.'), { statusCode: 403 });
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(file); } catch { throw Object.assign(new Error('Google Sheets n’a pas fourni un classeur Excel valide.'), { statusCode: 502 }); }
    const sheets = workbookRowsFromExcel(workbook);
    const source = sourceSheetFrom(sheets, gid);
    if (!source) throw Object.assign(new Error('Le classeur Google Sheets ne contient aucune feuille source avec des données.'), { statusCode: 400 });
    return { sourceRows: source.rows, catalogSheets: sheets.filter(sheet => sheet.name !== source.name).map(({ name, rows }) => ({ name, rows })) };
  };

  const syncUrl = process.env.SYNC_URL;
  const syncAuthToken = process.env.SYNC_AUTH_TOKEN;
  // Navigateurs connectés en SSE sur /api/v1/events (mode web : même origine que l'API).
  const sseClients = new Set();
  const broadcastLocal = (eventType, payload) => {
    if (!sseClients.size) return;
    const { rows, sheets, ...light } = payload || {};
    if (Array.isArray(rows)) light.rowCount ??= rows.length;
    if (Array.isArray(sheets)) light.sheetCount ??= sheets.length;
    const encoded = `event: ${eventType}\ndata: ${JSON.stringify(light)}\nid: ${Date.now()}\n\n`;
    for (const res of sseClients) res.write(encoded);
  };
  const syncBridge = {
    push: null,
    _queue: [],
    _flushing: false,
    send(eventType, payload) {
      broadcastLocal(eventType, payload);
      if (!syncUrl || !syncAuthToken) return Promise.resolve();
      this._queue.push({ eventType, payload, ts: Date.now() });
      if (!this._flushing) {
        this._flushing = true;
        this._flush();
      }
      return Promise.resolve();
    },
    _headers() {
      return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${syncAuthToken}` };
    },
    async _flush() {
      while (this._queue.length > 0) {
        const item = this._queue.shift();
        try {
          await fetch(`${syncUrl}/api/v1/sync/receive`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({ eventType: item.eventType, ...item.payload }),
          });
        } catch (e) {
          this._queue.unshift(item);
          break;
        }
      }
      this._flushing = false;
    },
  };

  app.get('/api/v1/health', (req, res) => ok(res, { status: 'ok', storageMode: 'sqlite', sourceRows: sourceCount(), syncEnabled: Boolean(syncUrl), syncUrl: syncUrl || null }));
  app.post('/api/v1/auth/login', async (req, res) => {
    const ipKey = req.ip || 'local';
    const attempt = loginAttempts.get(ipKey) || { count: 0, since: Date.now() };
    if (Date.now() - attempt.since > 15 * 60_000) { attempt.count = 0; attempt.since = Date.now(); }
    if (attempt.count >= 10) return fail(res, 429, 'Trop de tentatives. Réessayez dans 15 minutes.');
    const login = String(req.body?.login || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE login=? AND active=1').get(login);
    if (!user || !verify(String(req.body?.password || ''), user.salt, user.password_hash)) { attempt.count++; loginAttempts.set(ipKey, attempt); return fail(res, 401, 'Identifiants incorrects.'); }
    loginAttempts.delete(ipKey);
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES(?,?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), user.id, crypto.createHash('sha256').update(csrfToken).digest('hex'), Date.now() + 12 * 60 * 60 * 1000);
    const secure = tlsConfig ? '; Secure' : '';
    res.setHeader('Set-Cookie', [`chocolat_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`, `chocolat_csrf=${encodeURIComponent(csrfToken)}; SameSite=Strict; Path=/; Max-Age=43200${secure}`]);
    let syncToken = null;
    if (syncUrl) {
      try {
        const syncResponse = await fetch(`${syncUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${syncAuthToken}` },
          body: JSON.stringify({ login: user.login, password: String(req.body?.password || '') }),
        });
        if (syncResponse.ok) {
          const setCookie = syncResponse.headers.get('set-cookie');
          if (setCookie) {
            const match = setCookie.match(/chocolat_session=([^;]+)/);
            if (match) syncToken = decodeURIComponent(match[1]);
          }
        } else if (syncAuthToken) {
          syncToken = syncAuthToken;
          try { await fetch(`${syncUrl}/api/v1/sync/receive`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${syncAuthToken}` }, body: JSON.stringify({ eventType: 'user-login', userId: String(user.id), login: user.login, firstName: user.first_name, lastName: user.last_name, role: user.role }) }); } catch { /* ignore */ }
        }
      } catch { /* sync login failure is non-fatal */ }
    }
    ok(res, { user: publicUser(user), syncToken });
  });
  app.get('/api/v1/auth/me', auth, (req, res) => ok(res, { user: publicUser(req.user) }));
  app.patch('/api/v1/auth/profile', ...protectedWrite, (req, res) => {
    const firstName = String(req.body?.firstName ?? '').trim();
    const lastName = String(req.body?.lastName ?? '').trim();
    if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) return fail(res, 400, 'Le prénom et le nom sont obligatoires (100 caractères maximum).');
    db.prepare('UPDATE users SET first_name=?,last_name=?,profile_completed=1 WHERE id=?').run(firstName, lastName, req.user.id);
    ok(res, { user: publicUser(userById(req.user.id)) });
  });
  app.post('/api/v1/auth/logout', ...protectedWrite, (req, res) => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash); res.setHeader('Set-Cookie', ['chocolat_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'chocolat_csrf=; SameSite=Strict; Path=/; Max-Age=0']); ok(res, {}); });
  app.get('/api/v1/users', auth, allow('ADMIN', 'SUPERVISEUR'), (req, res) => ok(res, { users: allUsers().map(publicUser) }));
  app.post('/api/v1/users', ...protectedWrite, allow('ADMIN','SUPERVISEUR'), (req, res) => {
    const b = req.body || {}; const role = req.user.role === 'ADMIN' && roles.includes(b.role) ? b.role : 'AGENT'; const login = String(b.login || '').trim(); const password = String(b.password || '');
    if (!login || !b.firstName || !b.lastName || password.length < 8) return fail(res, 400, 'Prénom, nom, login et mot de passe de 8 caractères minimum requis.');
     try { const h = hash(password); const out = db.prepare('INSERT INTO users(login,first_name,last_name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(login, b.firstName.trim(), b.lastName.trim(), role, h.salt, h.hash, now()); const savedUser = publicUser(userById(out.lastInsertRowid)); syncBridge.send('user-created', { ...savedUser }); return ok(res, { user: savedUser }); } catch { return fail(res, 409, 'Ce login est déjà utilisé.'); }
  });
  app.patch('/api/v1/users/:id', ...protectedWrite, allow('ADMIN'), (req, res) => {
    const current = userById(Number(req.params.id)); if (!current) return fail(res, 404, 'Utilisateur introuvable.');
    const b = req.body || {}; const role = roles.includes(b.role) ? b.role : current.role; const login = String(b.login ?? current.login).trim();
    if (!login || !b.firstName || !b.lastName || (b.password && String(b.password).length < 8)) return fail(res, 400, 'Informations utilisateur invalides.');
    const secret = b.password ? hash(String(b.password)) : { salt: current.salt, hash: current.password_hash };
     try { db.prepare('UPDATE users SET login=?,first_name=?,last_name=?,role=?,salt=?,password_hash=?,profile_completed=1 WHERE id=?').run(login,b.firstName.trim(),b.lastName.trim(),role,secret.salt,secret.hash,current.id); const updatedUser = publicUser(userById(current.id)); syncBridge.send('user-updated', { id: String(current.id), ...updatedUser }); ok(res,{user:updatedUser}); } catch { fail(res,409,'Ce login est déjà utilisé.'); }
  });
   app.delete('/api/v1/users/:id', ...protectedWrite, allow('ADMIN'), (req, res) => { if (Number(req.params.id) === req.user.id) return fail(res, 400, 'Vous ne pouvez pas supprimer votre propre compte.'); db.prepare('DELETE FROM users WHERE id=?').run(Number(req.params.id)); syncBridge.send('user-deleted', { userId: String(req.params.id) }); ok(res, {}); });
  app.get('/api/v1/data/row/:row', auth, (req, res) => { const row = Number(req.params.row); const source = db.prepare('SELECT values_json FROM source_rows WHERE row_number=?').get(row); if (!source) return fail(res, 404, 'Ligne source introuvable. Importez d’abord les données source.'); ok(res,{treatment:treatment(row)}); });
  app.post('/api/v1/data/sync', ...protectedWrite, (req, res) => {
    const row = Number(req.body?.sourceRow); const values = req.body?.values;
    if (!Number.isInteger(row) || row < 1 || !values || typeof values !== 'object' || Array.isArray(values)) return fail(res,400,'Ligne ou données invalides.');
    const sourceRowData = db.prepare('SELECT source_workbook_id FROM source_rows WHERE row_number=?').get(row);
    if (!sourceRowData) return fail(res,404,'Ligne source introuvable.');
    const groupStart = Math.floor((row - 2) / 50) * 50 + 1;
    const groupStatus = db.prepare('SELECT status FROM distribution_groups WHERE group_start=?').get(groupStart)?.status ?? 'NON ASSIGNE';
    if (groupStatus === 'NON ASSIGNE') return fail(res,409,'Ce bloc est NON ASSIGNE. Passez son statut à EN COURS avant toute saisie.');
    if (Object.keys(values).length > 100 || Object.keys(values).some(k => !fields.includes(k)) || Object.values(values).some(v => typeof v !== 'string' || v.length > 10000)) return fail(res,400,'Les champs transmis sont invalides.');
     const previous = db.prepare('SELECT version FROM treatments WHERE source_row=?').get(row); const version = (previous?.version || 0) + 1; const submitted = Boolean(req.body.submit); const old = treatment(row); const updatedAt = now();
     db.prepare(`INSERT INTO treatments(source_row,current_data,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_row) DO UPDATE SET current_data=excluded.current_data,status=excluded.status,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at,submitted_at=COALESCE(excluded.submitted_at,treatments.submitted_at),quality_feedback=NULL,source_workbook_id=excluded.source_workbook_id`).run(row,JSON.stringify(values),submitted?'SUBMITTED':'DRAFT',version,req.user.id,updatedAt,submitted?now():null,old?.qualityFeedback?JSON.stringify(old.qualityFeedback):null,sourceRowData.source_workbook_id);
     db.prepare('INSERT INTO treatment_history(source_row,values_json,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id,actor_role) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row,JSON.stringify(values),submitted?'SUBMITTED':'DRAFT',version,req.user.id,updatedAt,submitted?now():null,old?.qualityFeedback?JSON.stringify(old.qualityFeedback):null,sourceRowData.source_workbook_id,req.user.role);
     syncBridge.send('treatment-updated', { sourceRow: row, values, submit: submitted, version, userId: String(req.user.id), sourceWorkbookId: sourceRowData.source_workbook_id });
     syncBridge.send('treatment-history-added', { sourceRow: row, version, updatedAt, userId: String(req.user.id), userRole: req.user.role, sourceWorkbookId: sourceRowData.source_workbook_id });
     ok(res,{storageMode:'sqlite',version});
  });
  app.get('/api/v1/data/export', auth, allow('ADMIN','SUPERVISEUR'), (req,res) => ok(res,{treatments:db.prepare("SELECT source_row AS sourceRow,current_data AS currentData,updated_at AS updatedAt,updated_by AS updatedBy,status FROM treatments WHERE status='SUBMITTED' ORDER BY source_row").all().map(t=>({...t,currentData:JSON.parse(t.currentData)}))}));
  app.get('/api/v1/distribution-groups', auth, (req,res) => {
    const workbookId = Number(req.query.sourceWorkbookId);
    if (Number.isInteger(workbookId) && workbookId > 0) {
      const starts = [...new Set(db.prepare('SELECT source_row FROM treatments WHERE source_workbook_id=?').all(workbookId).map((row) => Math.floor((row.source_row - 2) / 50) * 50 + 1))];
      const statusByStart = new Map(db.prepare('SELECT group_start,status FROM distribution_groups').all().map((row) => [row.group_start, row.status]));
      const groups = starts.map((groupStart) => ({ groupStart, status: statusByStart.get(groupStart) ?? 'NON ASSIGNE' })).sort((a, b) => a.groupStart - b.groupStart);
      return ok(res, { groups });
    }
    ok(res,{groups:db.prepare('SELECT group_start AS groupStart,status FROM distribution_groups ORDER BY group_start').all()});
  });
  app.put('/api/v1/distribution-groups/:start/status', ...protectedWrite, (req,res) => { const start=Number(req.params.start); const status=String(req.body?.status||''); if (!Number.isInteger(start)||start<1||(start-1)%50!==0||!groupStatuses.includes(status)) return fail(res,400,'Groupe ou statut invalide.'); db.prepare('INSERT INTO distribution_groups(group_start,status,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(group_start) DO UPDATE SET status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(start,status,req.user.id,now()); syncBridge.send('distribution-group-updated', { groupStart: start, status, updatedBy: String(req.user.id) }); ok(res,{group:{groupStart:start,status}}); });
   app.get('/api/v1/quality/treatments', auth, (req,res) => { const page=Math.max(0,Number(req.query.page)||0); let workbookId = req.query.sourceWorkbookId ? Number(req.query.sourceWorkbookId) : null; if ((!workbookId || !(workbookId > 0)) && req.query.sourceWorkbookName) { const found = db.prepare('SELECT id FROM source_workbooks WHERE name=?').get(String(req.query.sourceWorkbookName).trim()); if (found) workbookId = found.id; } const workbookClause = (workbookId && workbookId > 0) ? ' AND source_workbook_id=?' : ''; const workbookParams = (workbookId && workbookId > 0) ? [workbookId] : []; const rows=req.user.role==='AGENT' ? db.prepare(`SELECT source_row FROM treatments WHERE status='SUBMITTED' AND updated_by=?${workbookClause} ORDER BY updated_at DESC LIMIT 101 OFFSET ?`).all(req.user.id,...workbookParams,page*100) : db.prepare(`SELECT source_row FROM treatments WHERE status='SUBMITTED'${workbookClause} ORDER BY updated_at DESC LIMIT 101 OFFSET ?`).all(...workbookParams,page*100); ok(res,{treatments:rows.slice(0,100).map(x=>treatment(x.source_row)),page,hasMore:rows.length>100}); });
   app.get('/api/v1/treatment-history/:row', auth, allow('ADMIN','SUPERVISEUR'), (req,res) => { const row=Number(req.params.row); if (!Number.isInteger(row)||row<1) return fail(res,400,'Ligne invalide.'); const history=db.prepare("SELECT h.*,u.first_name,u.last_name,u.login,u.role FROM treatment_history h JOIN users u ON u.id=h.updated_by WHERE h.source_row=? ORDER BY h.updated_at DESC, h.id DESC LIMIT 200").all(row); ok(res,{history:history.map(h=>({id:h.id,sourceRow:h.source_row,values:JSON.parse(h.values_json),status:h.status,version:h.version,updatedAt:h.updated_at,submittedAt:h.submitted_at,qualityFeedback:h.quality_feedback?JSON.parse(h.quality_feedback):null,sourceWorkbookId:h.source_workbook_id,updatedBy:{actorId:String(h.updated_by),firstName:h.first_name,lastName:h.last_name,login:h.login,role:h.role,fullName:`${h.first_name} ${h.last_name}`.trim()||h.login,actorType:h.actor_role==='SUPERVISEUR'||h.actor_role==='ADMIN'?'QC':'USER'}}))}); });
  app.post('/api/v1/quality/treatments/:row/return', ...protectedWrite, allow('ADMIN','SUPERVISEUR'), (req,res) => { const row=Number(req.params.row), message=String(req.body?.message||'').trim(); if (!message||message.length>2000) return fail(res,400,'Le retour doit contenir de 1 à 2000 caractères.'); const t=treatment(row); if (!t) return fail(res,404,'Saisie introuvable.'); const fb={message,createdAt:now(),createdBy:publicUser(req.user)}; db.prepare('UPDATE treatments SET quality_feedback=? WHERE source_row=?').run(JSON.stringify(fb),row); for(const u of db.prepare("SELECT id FROM users WHERE role='AGENT' AND active=1").all()) db.prepare('INSERT INTO notifications(user_id,source_row,message,created_at) VALUES(?,?,?,?)').run(u.id,row,message,now()); syncBridge.send('quality-feedback-added', { sourceRow: row, message, updatedBy: String(req.user.id) }); ok(res,{}); });
  app.get('/api/v1/notifications', auth, (req,res) => ok(res,{notifications:db.prepare('SELECT id,source_row,message,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id).map(n=>({id:String(n.id),sourceRow:n.source_row,text:`Retour qualité — ligne ${n.source_row}`,message:n.message,date:n.created_at,link:`/distribution/groupe/${Math.floor((n.source_row-1)/50)*50+1}/ligne/${n.source_row-1}`}))}));
  app.get('/api/v1/stats/summary', auth, (req,res) => { const validatedLines=db.prepare("SELECT COUNT(*) n FROM treatments WHERE status='SUBMITTED'").get().n; const returnsReceived=db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get(req.user.id).n; const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10); const yesterdayProduction=db.prepare("SELECT COUNT(*) n FROM treatments WHERE status='SUBMITTED' AND substr(submitted_at,1,10)=?").get(yesterday).n; ok(res,{validatedLines,returnsReceived,connectedHours:0,yesterdayProduction}); });
  app.get('/api/v1/stats/agents', auth, (req,res) => {
    const from=String(req.query.from||'0000-01-01'),to=String(req.query.to||'9999-12-31');
    const workbookId = Number(req.query.sourceWorkbookId);
    const workbookSql = Number.isInteger(workbookId) && workbookId > 0 ? ' AND source_workbook_id=?' : '';
    const dailyRows=req.user.role==='AGENT'
      ? db.prepare(`SELECT updated_by,substr(updated_at,1,10) AS date,SUM(CASE WHEN status='SUBMITTED' THEN 1 ELSE 0 END) AS validated,COUNT(*) AS total,SUM(CASE WHEN quality_feedback IS NOT NULL THEN 1 ELSE 0 END) AS returned FROM treatments WHERE substr(updated_at,1,10) BETWEEN ? AND ? AND updated_by=?${workbookSql} GROUP BY updated_by,date ORDER BY date`).all(...[from,to,req.user.id].concat(Number.isInteger(workbookId) && workbookId > 0 ? [workbookId] : []))
      : db.prepare(`SELECT updated_by,substr(updated_at,1,10) AS date,SUM(CASE WHEN status='SUBMITTED' THEN 1 ELSE 0 END) AS validated,COUNT(*) AS total,SUM(CASE WHEN quality_feedback IS NOT NULL THEN 1 ELSE 0 END) AS returned FROM treatments WHERE substr(updated_at,1,10) BETWEEN ? AND ?${workbookSql} GROUP BY updated_by,date ORDER BY date`).all(...[from,to].concat(Number.isInteger(workbookId) && workbookId > 0 ? [workbookId] : []));
    const byAgent=new Map();
    for(const r of dailyRows){if(!byAgent.has(r.updated_by))byAgent.set(r.updated_by,[]);byAgent.get(r.updated_by).push({date:r.date,validatedLines:r.validated,correctedReturns:r.returned,total:r.total});}
    const agents=[...byAgent].map(([id,daily])=>{const u=publicUser(userById(id)); const days=daily.map(d=>d.validatedLines); const validatedLines=days.reduce((a,b)=>a+b,0); const correctedReturns=daily.reduce((a,d)=>a+d.correctedReturns,0); const nonzero=daily.filter(d=>d.validatedLines>0); const bestDay=nonzero.reduce((a,d)=>!a||d.validatedLines>a.validatedLines?d:a,null); const lowestDay=nonzero.reduce((a,d)=>!a||d.validatedLines<a.validatedLines?d:a,null); return {...u,actorId:u.id,agent:u.fullName,role:u.role,daily,validatedLines,correctedReturns,qualityPercent:validatedLines?Math.round(100*validatedLines/(validatedLines+correctedReturns)):0,averageDailyProductivity:nonzero.length?Math.round(validatedLines/nonzero.length):0,bestDay,lowestDay};});
    ok(res,{agents});
  });
  app.get('/api/v1/suggestions', auth, (req,res) => {
    const field=String(req.query.field||''), q=String(req.query.q||'').toLowerCase();
    if(!fields.includes(field)||q.length<2)return ok(res,[]);
    const dictionaryResults = db.prepare('SELECT DISTINCT value FROM suggestions WHERE field_name=? AND value LIKE ? ESCAPE "\\" ORDER BY value LIMIT 50').all(field, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
    const treatmentResults = db.prepare('SELECT current_data FROM treatments WHERE status=\'SUBMITTED\' ORDER BY updated_at DESC LIMIT 1000').all().flatMap(x=>{try{return [JSON.parse(x.current_data)[field]]}catch{return []}}).filter(x=>typeof x==='string'&&x.toLowerCase().includes(q));
    ok(res,[...new Set([...dictionaryResults.map(r=>r.value),...treatmentResults])].slice(0,10).map(word=>({word})));
  });
   app.post('/api/v1/suggestions/seed', auth, allow('ADMIN'), (req,res) => {
    const entries=req.body?.entries;
    if(!Array.isArray(entries)||entries.length>5000||entries.some(e=>!e||typeof e.fieldName!=='string'||typeof e.value!=='string'||e.value.length>10000))return fail(res,400,'Données de dictionnaire invalides.');
    const upsert=db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
    const insert=db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?)');
    const count=db.transaction((items)=>{let n=0;for(const item of items){const existing=db.prepare('SELECT id FROM suggestions WHERE field_name=? AND value=?').get(item.fieldName,item.value);if(existing){upsert.run(item.fieldName,item.value,now(),now());}else{insert.run(item.fieldName,item.value,now(),now());}n++;}return n;})(entries);
    ok(res,{inserted:count.message?.changes||count});
    syncBridge.send('suggestions-seeded', { count });
  });
  app.get('/api/v1/suggestions/all', auth, allow('ADMIN'), (req,res) => {
    const suggestions=db.prepare('SELECT field_name,value,created_at,updated_at FROM suggestions ORDER BY field_name,value').all();
    ok(res,{suggestions});
  });
  app.get('/api/v1/onedrive/status', auth, allow('ADMIN'), (req,res) => ok(res, getOneDriveStatus()));
   app.post('/api/v1/sync/import', auth, allow('ADMIN'), (req,res) => {
     const data=req.body;
     if(!data || typeof data !== 'object') return fail(res,400,'Données de synchronisation invalides.');
     const transaction = db.transaction(() => {
       if(Array.isArray(data.sourceWorkbooks)){
         const upsertWorkbook = db.prepare('INSERT INTO source_workbooks(id,name,file_type,imported_by,imported_at,sheet_count,row_count) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,file_type=excluded.file_type,imported_by=excluded.imported_by,imported_at=excluded.imported_at,sheet_count=excluded.sheet_count,row_count=excluded.row_count');
         for(const w of data.sourceWorkbooks){
           if(typeof w.id !== 'number' || typeof w.name !== 'string') continue;
           upsertWorkbook.run(w.id, w.name, w.file_type || 'xlsx', w.imported_by || req.user.id, w.imported_at || now(), w.sheet_count || 0, w.row_count || 0);
         }
       }
       if(Array.isArray(data.suggestions)){
         const upsert = db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
         const insert = db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?)');
         for(const entry of data.suggestions){
           if(typeof entry.fieldName !== 'string' || typeof entry.value !== 'string') continue;
           const existing = db.prepare('SELECT id FROM suggestions WHERE field_name=? AND value=?').get(entry.fieldName, entry.value);
           if(existing){ upsert.run(entry.fieldName, entry.value, entry.created_at || now(), entry.updated_at || now()); }
           else { insert.run(entry.fieldName, entry.value, entry.created_at || now(), entry.updated_at || now()); }
         }
       }
       if(Array.isArray(data.treatments)){
         const upsertTreatment = db.prepare('INSERT INTO treatments(source_row,current_data,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_row) DO UPDATE SET current_data=excluded.current_data,status=excluded.status,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at,submitted_at=COALESCE(excluded.submitted_at,treatments.submitted_at),quality_feedback=excluded.quality_feedback,source_workbook_id=excluded.source_workbook_id');
         const userId = db.prepare('SELECT id FROM users WHERE login=?').get(data.syncUser || req.user.login)?.id || req.user.id;
         for(const t of data.treatments){
           if(typeof t.source_row !== 'number' || typeof t.current_data !== 'string') continue;
           upsertTreatment.run(t.source_row, t.current_data, t.status, t.version || 1, t.updated_by || userId, t.updated_at || now(), t.submitted_at || null, t.quality_feedback || null, t.source_workbook_id || null);
         }
       }
       if(Array.isArray(data.treatmentHistory)){
         const insertHistory = db.prepare('INSERT INTO treatment_history(source_row,values_json,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id,actor_role) VALUES(?,?,?,?,?,?,?,?,?,?)');
         for(const h of data.treatmentHistory){
           if(typeof h.source_row !== 'number' || typeof h.values_json !== 'string') continue;
           insertHistory.run(h.source_row, h.values_json, h.status, h.version || 1, h.updated_by || req.user.id, h.updated_at || now(), h.submitted_at || null, h.quality_feedback || null, h.source_workbook_id || null, h.actor_role || null);
         }
       }
     });
     transaction();
     ok(res,{imported: true});
   });
   app.get('/api/v1/sync/export', auth, allow('ADMIN'), (req,res) => {
     const suggestions = db.prepare('SELECT field_name as fieldName, value, created_at, updated_at FROM suggestions').all();
     const treatments = db.prepare('SELECT source_row, current_data, status, version, updated_by, updated_at, submitted_at, quality_feedback, source_workbook_id FROM treatments WHERE status=\'SUBMITTED\'').all();
     const sourceWorkbooks = db.prepare('SELECT id, name, file_type, imported_by, imported_at, sheet_count, row_count FROM source_workbooks ORDER BY imported_at DESC').all();
     const treatmentHistory = db.prepare('SELECT source_row, values_json, status, version, updated_by, updated_at, submitted_at, quality_feedback, source_workbook_id, actor_role FROM treatment_history ORDER BY updated_at DESC LIMIT 5000').all();
     ok(res,{suggestions, treatments, sourceWorkbooks, treatmentHistory, exportedAt: now()});
   });
  app.get('/api/source', auth, (req,res) => { const row=Number(req.query.row); const first=2,last=sourceCount()+1; if(!Number.isInteger(row)||row<first||row>last)return res.status(404).json({error:`Ligne ${row} introuvable (${first} à ${last})`,first,last}); const source=db.prepare('SELECT values_json, source_workbook_id FROM source_rows WHERE row_number=?').get(row); if(!source)return res.status(404).json({error:`Ligne ${row} introuvable (${first} à ${last})`,first,last}); const workbookName=source.source_workbook_id?db.prepare('SELECT name FROM source_workbooks WHERE id=?').get(source.source_workbook_id)?.name||'':null; res.json({row,first,last,values:JSON.parse(source.values_json),sourceWorkbookId:source.source_workbook_id,sourceWorkbookName:workbookName}); });
  app.post('/api/sheets/connect', ...protectedWrite, allow('ADMIN'), (req,res) => fail(res,503,'Import Google Sheets indisponible dans le mode local. Importez le fichier source au format CSV.'));
  app.post('/api/sheets/export', ...protectedWrite, allow('ADMIN','SUPERVISEUR'), async (req,res) => {
    if(req.query.format==='google-sheets')return fail(res,501,'La copie Google Sheets nécessite une configuration Google absente de ce paquet local.');
    const from=String(req.query.from||'0000-01-01'),to=String(req.query.to||'9999-12-31');
     const sourceWorkbookId = req.query.sourceWorkbookId ? Number(req.query.sourceWorkbookId) : null;
     const sourceWorkbookName = req.query.sourceWorkbookName ? String(req.query.sourceWorkbookName).trim() : null;
     let resolvedWorkbookId = sourceWorkbookId;
     if (!resolvedWorkbookId && sourceWorkbookName) {
       const wb = db.prepare('SELECT id FROM source_workbooks WHERE name=?').get(sourceWorkbookName);
       if (wb) resolvedWorkbookId = wb.id;
     }
     let candidates;
     if (resolvedWorkbookId) {
       candidates=db.prepare("SELECT * FROM treatments WHERE status='SUBMITTED' AND source_workbook_id=? AND substr(updated_at,1,10) BETWEEN ? AND ? ORDER BY source_row").all(resolvedWorkbookId,from,to);
     } else {
       candidates=db.prepare("SELECT * FROM treatments WHERE status='SUBMITTED' AND substr(updated_at,1,10) BETWEEN ? AND ? ORDER BY source_row").all(from,to);
     }
    const rows=candidates.filter(t=>{const u=userById(t.updated_by);return (!req.query.role||u?.role===req.query.role)&&(!req.query.agent||u?.full_name?.toLowerCase().includes(String(req.query.agent).toLowerCase())||`${u?.first_name} ${u?.last_name}`.toLowerCase().includes(String(req.query.agent).toLowerCase()));});
    const workbook=new ExcelJS.Workbook(); const sheet=workbook.addWorksheet('Saisies'); const headers=Object.keys(JSON.parse(db.prepare('SELECT values_json FROM source_rows ORDER BY row_number LIMIT 1').get()?.values_json||'{}'));
    sheet.addRow(['Ligne source','Classeur source',...headers,'Agent','Rôle','Date de validation']);
    for(const t of rows){
      const u=userById(t.updated_by), values=JSON.parse(t.current_data);
      const workbookName = t.source_workbook_id ? db.prepare('SELECT name FROM source_workbooks WHERE id=?').get(t.source_workbook_id)?.name || '' : '';
      sheet.addRow([t.source_row, workbookName, ...headers.map(h=>values[h]??''),`${u.first_name} ${u.last_name}`,u.role,t.submitted_at??t.updated_at]);
    }
    sheet.getRow(1).font={bold:true}; sheet.views=[{state:'frozen',ySplit:1}];
    const buffer=await workbook.xlsx.writeBuffer();
    const exportWorkbookName = resolvedWorkbookId ? db.prepare('SELECT name FROM source_workbooks WHERE id=?').get(resolvedWorkbookId)?.name || '' : '';
    const safeName = String(exportWorkbookName || '').trim().toLowerCase().replace(/[^a-z0-9àâäéèêëîïôöùûüç_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = safeName ? `${safeName}-terminee-${stamp}.xlsx` : `saisies-confiserie-${stamp}.xlsx`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${fileName}"`);res.setHeader('X-Exported-Rows',String(rows.length));res.send(Buffer.from(buffer));
  });
  app.get('/api/sheets/export', auth, allow('ADMIN','SUPERVISEUR'), (req,res) => fail(res,405,'Utilisez la méthode POST pour exporter.'));
  app.get('/api/v1/data/import-template', auth, allow('ADMIN'), (req,res)=>ok(res,{fields}));
  app.post('/api/v1/data/import', ...protectedWrite, allow('ADMIN'), (req,res)=>{ try { const rows = req.body?.rows; const fileName = req.body?.fileName || 'Import CSV'; const fileType = req.body?.fileType || 'csv'; const count = replaceSourceRows(rows, fileName, fileType); const workbookId = db.prepare('SELECT id FROM source_workbooks ORDER BY id DESC LIMIT 1').get()?.id; syncBridge.send('source-imported', { rowCount: count, rows, sourceWorkbookId: workbookId, workbookName: fileName, fileType: fileType }); ok(res,{rows: count}); } catch(error) { fail(res,error.statusCode||400,error.message||'Import impossible : vérifiez les colonnes et les lignes du fichier.'); } });
  app.post('/api/v1/data/import-google-sheet', ...protectedWrite, allow('ADMIN'), async (req,res)=>{ try { const workbook=await importGoogleSheet(req.body?.url); const result = replaceWorkbookRows(workbook.sourceRows, workbook.catalogSheets, 'Google Sheets', 'gsheet'); ok(res, result); } catch(error) { fail(res,error.statusCode||502,error.message||'Import Google Sheets impossible.'); } });
  app.post('/api/v1/data/import-workbook/start', ...protectedWrite, allow('ADMIN'), (req,res) => {
    const names = req.body?.sheetNames;
    if (!Array.isArray(names) || names.length > 30 || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 200) || new Set(names).size !== names.length) return fail(res,400,'Liste des onglets invalide.');
    db.prepare("DELETE FROM catalog_import_sessions WHERE created_at < ?").run(new Date(Date.now() - 86400000).toISOString());
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO catalog_import_sessions(id,user_id,expected_sheets,created_at) VALUES(?,?,?,?)').run(id,req.user.id,JSON.stringify(names),now());
    ok(res,{importId:id});
  });
  app.put('/api/v1/data/import-workbook/:id/sheet', ...protectedWrite, allow('ADMIN'), (req,res) => {
    const session = db.prepare('SELECT * FROM catalog_import_sessions WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
    if (!session) return fail(res,404,'Session d’import introuvable ou expirée.');
    const name = req.body?.sheetName;
    const rows = req.body?.rows;
    const expected = JSON.parse(session.expected_sheets);
    if (!expected.includes(name) || !Array.isArray(rows) || rows.length > 100000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return fail(res,400,'Onglet ou données invalides.');
    const headers = rows.length ? Object.keys(rows[0]) : [];
    if (!headers.length || rows.some(row => headers.some(header => !Object.hasOwn(row,header)))) return fail(res,400,'Les lignes de l’onglet doivent avoir les mêmes colonnes.');
    db.prepare('INSERT OR REPLACE INTO catalog_import_staging(import_id,sheet_name,headers_json,rows_json,row_count) VALUES(?,?,?,?,?)').run(session.id,name,JSON.stringify(headers),JSON.stringify(rows),rows.length);
    ok(res,{sheet:name,rows:rows.length});
  });
  app.post('/api/v1/data/import-workbook/:id/commit', ...protectedWrite, allow('ADMIN'), (req,res) => {
    try {
      const session = db.prepare('SELECT * FROM catalog_import_sessions WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
      if (!session) return fail(res,404,'Session d’import introuvable ou expirée.');
      const expected = JSON.parse(session.expected_sheets);
      const staged = db.prepare('SELECT * FROM catalog_import_staging WHERE import_id=? ORDER BY sheet_name').all(session.id);
      if (staged.length !== expected.length || expected.some(name => !staged.some(sheet => sheet.sheet_name === name))) return fail(res,400,'Tous les onglets secondaires ne sont pas encore importés.');
      const sourceRows = req.body?.sourceRows;
      if (!Array.isArray(sourceRows) || !sourceRows.length || sourceRows.length > 100000 || sourceRows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return fail(res,400,'La feuille source doit contenir des lignes valides.');
      const fileName = req.body?.fileName || req.body?.workbookName || 'Classeur importé';
      const fileType = req.body?.fileType || 'xlsx';
      const sheetCount = staged.length;
      const commit = db.transaction(() => {
        const workbookResult = db.prepare('INSERT INTO source_workbooks(name,file_type,imported_by,imported_at,sheet_count,row_count) VALUES(?,?,?,?,?,?)').run(fileName, fileType, req.user.id, now(), sheetCount, sourceRows.length);
        const newWorkbookId = workbookResult.lastInsertRowid;
        const insert = db.prepare('INSERT INTO source_rows(row_number,values_json,source_workbook_id) VALUES(?,?,?)');
        db.prepare('DELETE FROM source_rows').run();
        sourceRows.forEach((row,index) => insert.run(index + 2,JSON.stringify(row), newWorkbookId));
        db.prepare('DELETE FROM catalog_sheets').run();
        const insertSheet = db.prepare('INSERT INTO catalog_sheets(sheet_name,headers_json,rows_json,row_count,updated_at) VALUES(?,?,?,?,?)');
        staged.forEach(sheet => insertSheet.run(sheet.sheet_name,sheet.headers_json,sheet.rows_json,sheet.row_count,now()));
        db.prepare('DELETE FROM catalog_import_sessions WHERE id=?').run(session.id);
        return newWorkbookId;
      });
      const sourceWorkbookId = commit();
      syncBridge.send('source-imported', { rowCount: sourceRows.length, rows: sourceRows, sourceWorkbookId, workbookName: fileName, fileType: fileType });
      syncBridge.send('catalog-synced', { sheetCount: staged.length, sheets: staged.map(s => ({ name: s.sheet_name, headers: JSON.parse(s.headers_json), rows: JSON.parse(s.rows_json) })) });
      ok(res,{rows:sourceRows.length,sheets:staged.length});
    } catch(error) { fail(res,error.statusCode||400,error.message||'Import du classeur impossible.'); }
  });
  app.get('/api/v1/source-workbooks', auth, (req,res) => {
    const workbooks = db.prepare('SELECT id,name,file_type,imported_at,sheet_count,row_count FROM source_workbooks ORDER BY imported_at DESC').all();
    ok(res,{workbooks});
  });
  app.get('/api/v1/catalog/sheets', auth, (req,res) => {
    const sheets=db.prepare('SELECT sheet_name,row_count,headers_json FROM catalog_sheets ORDER BY rowid').all().map(sheet=>({name:sheet.sheet_name,rowCount:sheet.row_count,hasEan:Boolean(eanHeader(JSON.parse(sheet.headers_json)))}));
    ok(res,{sheets});
  });
  app.get('/api/v1/catalog/sheets/:sheetName', auth, (req,res) => {
    const sheet=db.prepare('SELECT * FROM catalog_sheets WHERE sheet_name=?').get(req.params.sheetName);
    if(!sheet)return fail(res,404,'Onglet introuvable.');
    const headers=JSON.parse(sheet.headers_json), allRows=JSON.parse(sheet.rows_json), ean=eanHeader(headers), filter=String(req.query.ean||'').trim().toLocaleLowerCase();
    if(filter&&!ean)return fail(res,400,'Cet onglet ne contient pas de colonne EAN/Check Digit filtrable.');
    const filtered=filter?allRows.filter(row=>String(row[ean]??'').toLocaleLowerCase().includes(filter)):allRows;
    const page=Math.max(0,Math.floor(Number(req.query.page)||0)),pageSize=100;
    ok(res,{sheetName:sheet.sheet_name,headers,total:filtered.length,page,pageSize,rows:filtered.slice(page*pageSize,(page+1)*pageSize)});
  });
  app.get('/api/v1/catalog/lookup', auth, (req,res) => {
    const eanQuery=String(req.query.ean||'').trim();
    if(!eanQuery)return fail(res,400,'EAN manquant.');
    const sheets=db.prepare('SELECT sheet_name,headers_json,rows_json FROM catalog_sheets ORDER BY rowid').all();
    for(const sheet of sheets){
      const headers=JSON.parse(sheet.headers_json), ean=eanHeader(headers);
      if(!ean) continue;
      const match=JSON.parse(sheet.rows_json).find((row)=>String(row[ean]??'').trim().toLocaleLowerCase()===eanQuery.toLocaleLowerCase());
      if(match) return ok(res,{sheetName:sheet.sheet_name,eanColumn:ean,row:match});
    }
    return fail(res,404,'Aucun produit trouvé pour cet EAN dans le catalogue.');
  });
  app.get('/api/v1/catalog/search', auth, (req,res) => {
    const filter=String(req.query.ean||'').trim().toLocaleLowerCase();
    if(!filter)return ok(res,{sheets:[],total:0,page:0,pageSize:100,headers:[]});
    const allSheets=db.prepare('SELECT sheet_name,headers_json,rows_json FROM catalog_sheets ORDER BY rowid').all();
    const combined=[];
    let headers=[];
    for(const sheet of allSheets){
      const sheetHeaders=JSON.parse(sheet.headers_json), allRows=JSON.parse(sheet.rows_json), ean=eanHeader(sheetHeaders);
      if(!ean)continue;
      const matches=allRows.filter(row=>String(row[ean]??'').toLocaleLowerCase().includes(filter));
      if(matches.length){
        if(headers.length===0)headers=sheetHeaders;
        for(const row of matches){combined.push({...row,_sourceSheet:sheet.sheet_name});}
      }
    }
    const page=Math.max(0,Math.floor(Number(req.query.page)||0)),pageSize=100;
    ok(res,{headers,total:combined.length,page,pageSize,rows:combined.slice(page*pageSize,(page+1)*pageSize)});
  });
  app.get('/api/v1/events', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
  });
  app.use('/api', (req,res)=>fail(res,404,'Route API introuvable.'));
  app.use(express.static(frontendDir, { index:false }));
  app.use((req,res,next)=>req.method==='GET' ? res.sendFile(path.join(frontendDir,'index.html'),err=>err&&next(err)) : next());
  app.use((err,req,res,next)=>{logger.error?.('API error',err);fail(res,500,'Une erreur interne est survenue.');});
  const allowInsecureLan = ['1', 'true', 'yes'].includes(String(process.env.CHOCOLAT_ALLOW_INSECURE_LAN || '').toLowerCase());
  const tlsConfig = host !== '127.0.0.1' && host !== 'localhost'
    ? (process.env.CHOCOLAT_TLS_CERT && process.env.CHOCOLAT_TLS_KEY
      ? { cert: fs.readFileSync(process.env.CHOCOLAT_TLS_CERT), key: fs.readFileSync(process.env.CHOCOLAT_TLS_KEY) }
      : allowInsecureLan
        ? null
        : (()=>{ throw new Error('Pour exposer le backend au réseau, configurez CHOCOLAT_TLS_CERT et CHOCOLAT_TLS_KEY (ou CHOCOLAT_ALLOW_INSECURE_LAN=1 sur un réseau de confiance).'); })())
    : null;
  if (!tlsConfig && host !== '127.0.0.1' && host !== 'localhost') {
    logger.warn?.('CHOCOLAT_ALLOW_INSECURE_LAN actif : le backend écoute en HTTP non chiffré sur le réseau. Logins et données circulent en clair.');
  }
  const server = tlsConfig
    ? https.createServer(tlsConfig, app).listen(port, host, () => logger.info?.(`Backend prêt sur https://${host}:${port} — base SQLite: ${storeDir}`))
    : app.listen(port, host, () => logger.info?.(`Backend local prêt sur http://${host}:${port} — base SQLite: ${storeDir}`));
  return {app,server,db,host,initialCredentials,secure:Boolean(tlsConfig),syncBridge,close:()=>{for(const client of sseClients)client.end();server.close();db.close();}};
}

if (require.main === module) {
  require('./tlsTrust.cjs').trustCertificateAuthorities();
  const backend = createBackend({ frontendDir: path.resolve(__dirname,'../frontend/dist') });
  if (backend.initialCredentials) console.warn(`Compte administrateur initial — login : ${backend.initialCredentials.login} — mot de passe : ${backend.initialCredentials.password}`);
}
module.exports={createBackend,normalizeHeader,eanHeader};
