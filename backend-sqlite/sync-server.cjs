const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { normalizeHeader, eanHeader } = require('./server.cjs');

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const computed = crypto.createHash('sha256').update(salt + password).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

const groupStatuses = ['NON ASSIGNE', 'EN COURS', 'SAISIE TERMINEE', 'VALIDEE'];

const publicUser = (u) => {
  const firstName = u.firstName ?? u.first_name ?? '';
  const lastName = u.lastName ?? u.last_name ?? '';
  return {
    id: String(u.id), login: u.login, firstName, lastName,
    fullName: u.fullName ?? u.full_name ?? `${firstName} ${lastName}`.trim(),
    role: u.role, active: Boolean(u.active), requiresProfileUpdate: Number(u.profile_completed ?? 1) === 0,
  };
};

function createSyncServer({ dataDir, host = process.env.SYNC_HOST || '0.0.0.0', port = Number(process.env.SYNC_PORT || 3002), tlsConfig = null, logger = console } = {}) {
  const storeDir = dataDir || process.env.CHOCOLAT_SYNC_DIR || path.join(process.env.PROGRAMDATA || require('node:os').homedir(), 'ChocolatBackofficeSync');
  fs.mkdirSync(storeDir, { recursive: true });
  const db = new Database(path.join(storeDir, 'chocolat-sync.sqlite3'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('AGENT','SUPERVISEUR','ADMIN')), salt TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, profile_completed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_rows (row_number INTEGER PRIMARY KEY, values_json TEXT NOT NULL, source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS source_workbooks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, file_type TEXT NOT NULL, imported_by INTEGER NOT NULL REFERENCES users(id), imported_at TEXT NOT NULL, sheet_count INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS treatments (source_row INTEGER PRIMARY KEY, current_data TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL, submitted_at TEXT, quality_feedback TEXT, source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS treatment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, source_row INTEGER NOT NULL, values_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL, submitted_at TEXT, quality_feedback TEXT, source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL, actor_role TEXT);
    CREATE INDEX IF NOT EXISTS idx_treatment_history_source_row ON treatment_history(source_row, updated_at DESC);
    CREATE TABLE IF NOT EXISTS distribution_groups (group_start INTEGER PRIMARY KEY, status TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_row INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
    CREATE TABLE IF NOT EXISTS catalog_sheets (sheet_name TEXT PRIMARY KEY, headers_json TEXT NOT NULL, rows_json TEXT NOT NULL, row_count INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, field_name TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_suggestions_field_value ON suggestions(field_name, value);
    CREATE INDEX IF NOT EXISTS idx_suggestions_value ON suggestions(value);
    CREATE INDEX IF NOT EXISTS idx_treatments_updated_at ON treatments(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_treatments_status_updated_at ON treatments(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, created_at DESC);
  `);

  const userColumns = db.pragma('table_info(users)');
  if (!userColumns.some((column) => column.name === 'profile_completed')) {
    db.exec('ALTER TABLE users ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 1');
  }

  const sourceRowsCols = db.pragma('table_info(source_rows)');
  if (!sourceRowsCols.some((c) => c.name === 'source_workbook_id')) {
    db.exec('ALTER TABLE source_rows ADD COLUMN source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL');
  }
  const treatmentsCols = db.pragma('table_info(treatments)');
  if (!treatmentsCols.some((c) => c.name === 'source_workbook_id')) {
    db.exec('ALTER TABLE treatments ADD COLUMN source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL');
  }
  const treatmentsCols2 = db.pragma('table_info(treatments)');
  if (!treatmentsCols2.some((c) => c.name === 'source_workbook_id')) {
    db.exec('ALTER TABLE treatments ADD COLUMN source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL');
  }
  const historyCols = db.pragma('table_info(treatment_history)');
  if (!historyCols.length) {
    db.exec(`CREATE TABLE treatment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, source_row INTEGER NOT NULL, values_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL, submitted_at TEXT, quality_feedback TEXT, source_workbook_id INTEGER REFERENCES source_workbooks(id) ON DELETE SET NULL, actor_role TEXT); CREATE INDEX idx_treatment_history_source_row ON treatment_history(source_row, updated_at DESC)`);
  }

  const now = () => new Date().toISOString();
  const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  let initialCredentials = null;
  if (userCount === 0) {
    const login = (process.env.AUTH_BOOTSTRAP_ADMIN_LOGIN || 'admin').trim().toLowerCase();
    const password = process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
    if (password.length < 12) throw new Error('AUTH_BOOTSTRAP_ADMIN_PASSWORD doit comporter au moins 12 caractères.');
    const secret = hash(password);
    db.prepare('INSERT INTO users(login,first_name,last_name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(login, 'ADMIN', 'ADMIN', 'ADMIN', secret.salt, secret.hash, now());
    initialCredentials = { login, password };
  }

  try {
    const dictionaries = require('./suggestionDictionaries.json');
    const seedCount = db.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
    if (seedCount === 0 && Object.keys(dictionaries).length > 0) {
      const seedInsert = db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?)');
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
  } catch (e) {
    logger?.warn?.('Dictionnaires de suggestions non disponibles au démarrage.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const ok = (res, data) => res.json({ success: true, data: data });
  const fail = (res, code, message) => res.status(code).json({ success: false, errors: [{ message }] });

  const syncAuthToken = process.env.SYNC_AUTH_TOKEN;
  const adminUser = db.prepare('SELECT * FROM users WHERE role=? AND active=1 ORDER BY id LIMIT 1').get('ADMIN') || { id: 0, login: 'sync', first_name: 'Sync', last_name: 'Bridge', role: 'ADMIN', active: 1, profile_completed: 1 };

  const sessionFor = (req) => {
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('chocolat_session='))?.slice('chocolat_session='.length);
    if (token) {
      const session = db.prepare('SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(
        crypto.createHash('sha256').update(decodeURIComponent(token)).digest('hex'),
        Date.now()
      );
      return session ? { session, user: session } : null;
    }
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice('Bearer '.length);
      if (syncAuthToken && crypto.timingSafeEqual(Buffer.from(bearerToken), Buffer.from(syncAuthToken))) {
        return { session: { csrf_hash: '' }, user: adminUser };
      }
      const session = db.prepare('SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(
        crypto.createHash('sha256').update(decodeURIComponent(bearerToken)).digest('hex'),
        Date.now()
      );
      return session ? { session, user: session } : null;
    }
    return null;
  };

  const auth = (req, res, next) => {
    const found = sessionFor(req);
    if (!found) return fail(res, 401, 'Session expirée. Connectez-vous à nouveau.');
    req.user = found.user;
    next();
  };

  const allow = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : fail(res, 403, 'Droits insuffisants.');

  const sseClients = new Set();

  const broadcast = (event, payload) => {
    const encoded = `event: ${event}\ndata: ${JSON.stringify(payload)}\nid: ${Date.now()}\n\n`;
    for (const client of sseClients) {
      if (!client.res.writableEnded) {
        client.res.write(encoded);
      } else {
        sseClients.delete(client);
      }
    }
  };

  app.post('/api/auth/login', (req, res) => {
    const login = String(req.body?.login || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!login || !password) return fail(res, 400, 'Login et mot de passe requis.');
    const user = db.prepare('SELECT * FROM users WHERE login=? AND active=1').get(login);
    if (!user || !verifyPassword(password, user.salt, user.password_hash)) return fail(res, 401, 'Identifiants incorrects.');
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES(?,?,?,?)')
      .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, csrf, Date.now() + 86400000);
    res.setHeader('Set-Cookie', `chocolat_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`);
    ok(res, { user: publicUser(user) });
  });

  app.get('/api/auth/me', auth, (req, res) => ok(res, publicUser(req.user)));

  app.get('/api/auth/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
    res.setHeader('Set-Cookie', 'chocolat_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    ok(res, {});
  });

  app.get('/api/v1/events', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`retry: 30000\n\n`);
    const client = { res, userId: req.user.id, role: req.user.role };
    sseClients.add(client);
    req.on('close', () => {
      sseClients.delete(client);
    });
  });

  app.get('/api/v1/health', auth, (req, res) => {
    const sourceRows = db.prepare('SELECT COUNT(*) n FROM source_rows').get().n;
    const treatments = db.prepare("SELECT COUNT(*) n FROM treatments WHERE status='SUBMITTED'").get().n;
    const suggestions = db.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
    const connected = sseClients.size;
    ok(res, { status: 'ok', storageMode: 'sqlite-sync', sourceRows, submittedTreatments: treatments, suggestions, connectedClients: connected });
  });

  app.get('/api/v1/users', auth, allow('ADMIN', 'SUPERVISEUR'), (req, res) => {
    ok(res, { users: db.prepare('SELECT * FROM users ORDER BY last_name,first_name').all().map(publicUser) });
  });

  const userByIdSync = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

  app.post('/api/v1/users', auth, allow('ADMIN', 'SUPERVISEUR'), (req, res) => {
    const b = req.body || {};
    const role = req.user.role === 'ADMIN' && ['AGENT', 'SUPERVISEUR', 'ADMIN'].includes(b.role) ? b.role : 'AGENT';
    const login = String(b.login || '').trim();
    const password = String(b.password || '');
    if (!login || !b.firstName || !b.lastName || password.length < 8) return fail(res, 400, 'Prénom, nom, login et mot de passe de 8 caractères minimum requis.');
    try {
      const h = hash(password);
      const out = db.prepare('INSERT INTO users(login,first_name,last_name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(login, b.firstName.trim(), b.lastName.trim(), role, h.salt, h.hash, now());
      broadcast('user-created', { ...publicUser(userByIdSync(out.lastInsertRowid)) });
      ok(res, { user: publicUser(userByIdSync(out.lastInsertRowid)) });
    } catch { fail(res, 409, 'Ce login est déjà utilisé.'); }
  });

  app.patch('/api/v1/users/:id', auth, allow('ADMIN'), (req, res) => {
    const current = userByIdSync(Number(req.params.id));
    if (!current) return fail(res, 404, 'Utilisateur introuvable.');
    const b = req.body || {};
    const role = ['AGENT', 'SUPERVISEUR', 'ADMIN'].includes(b.role) ? b.role : current.role;
    const login = String(b.login ?? current.login).trim();
    if (!login || !b.firstName || !b.lastName || (b.password && String(b.password).length < 8)) return fail(res, 400, 'Informations utilisateur invalides.');
    const secret = b.password ? hash(String(b.password)) : { salt: current.salt, hash: current.password_hash };
    try {
      db.prepare('UPDATE users SET login=?,first_name=?,last_name=?,role=?,salt=?,password_hash=?,profile_completed=1 WHERE id=?').run(login, b.firstName.trim(), b.lastName.trim(), role, secret.salt, secret.hash, current.id);
      broadcast('user-updated', { id: String(current.id), ...publicUser(userByIdSync(current.id)) });
      ok(res, { user: publicUser(userByIdSync(current.id)) });
    } catch { fail(res, 409, 'Ce login est déjà utilisé.'); }
  });

  app.delete('/api/v1/users/:id', auth, allow('ADMIN'), (req, res) => {
    if (Number(req.params.id) === req.user.id) return fail(res, 400, 'Vous ne pouvez pas supprimer votre propre compte.');
    db.prepare('DELETE FROM users WHERE id=?').run(Number(req.params.id));
    broadcast('user-deleted', { userId: String(req.params.id) });
    ok(res, {});
  });

  app.get('/api/v1/distribution-groups', auth, (req, res) => {
    ok(res, { groups: db.prepare('SELECT group_start AS groupStart, status FROM distribution_groups ORDER BY group_start').all() });
  });

  app.put('/api/v1/distribution-groups/:start/status', auth, allow('ADMIN', 'SUPERVISEUR'), (req, res) => {
    const start = Number(req.params.start);
    const status = String(req.body?.status || '');
    if (!Number.isInteger(start) || start < 1 || (start - 1) % 50 !== 0 || !groupStatuses.includes(status)) return fail(res, 400, 'Groupe ou statut invalide.');
    db.prepare('INSERT INTO distribution_groups(group_start,status,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(group_start) DO UPDATE SET status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(start, status, req.user.id, now());
    broadcast('distribution-group-updated', { groupStart: start, status, updatedBy: req.user.id });
    ok(res, { group: { groupStart: start, status } });
  });

  app.get('/api/source', auth, (req, res) => {
    const row = Number(req.query.row);
    const first = 2;
    const last = db.prepare('SELECT MAX(row_number) n FROM source_rows').get()?.n || 0;
    if (!Number.isInteger(row) || row < first || row > last + 1) return res.status(404).json({ error: `Ligne ${row} introuvable (${first} à ${last + 1})`, first, last: last + 1 });
    const source = db.prepare('SELECT values_json, source_workbook_id FROM source_rows WHERE row_number=?').get(row);
    if (!source) return res.status(404).json({ error: `Ligne ${row} introuvable (${first} à ${last + 1})`, first, last: last + 1 });
    const workbookName = source.source_workbook_id ? db.prepare('SELECT name FROM source_workbooks WHERE id=?').get(source.source_workbook_id)?.name || '' : null;
    res.json({ row, first, last: last + 1, values: JSON.parse(source.values_json), sourceWorkbookId: source.source_workbook_id, sourceWorkbookName: workbookName });
  });

  app.get('/api/v1/data/row/:row', auth, (req, res) => {
    const row = Number(req.params.row);
    const exists = db.prepare('SELECT 1 FROM source_rows WHERE row_number=?').get(row);
    if (!exists) return fail(res, 404, 'Ligne source introuvable.');
    const t = db.prepare('SELECT * FROM treatments WHERE source_row=?').get(row);
    const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!t) return ok(res, { treatment: null });
    const actor = userById(t.updated_by);
    ok(res, { treatment: { sourceRow: t.source_row, currentData: JSON.parse(t.current_data), status: t.status, currentVersion: t.version, lastUpdatedAt: t.updated_at, submittedAt: t.submitted_at, lastUpdatedBy: { actorId: String(t.updated_by), actorType: actor?.role === 'SUPERVISEUR' ? 'QC' : 'USER' }, qualityFeedback: t.quality_feedback ? JSON.parse(t.quality_feedback) : null, errors: [], sourceWorkbookId: t.source_workbook_id } });
  });

  app.post('/api/v1/data/sync', auth, (req, res) => {
    const row = Number(req.body?.sourceRow);
    const values = req.body?.values;
    if (!Number.isInteger(row) || row < 1 || !values || typeof values !== 'object' || Array.isArray(values)) return fail(res, 400, 'Ligne ou données invalides.');
    const sourceRowData = db.prepare('SELECT source_workbook_id FROM source_rows WHERE row_number=?').get(row);
    if (!sourceRowData) return fail(res, 404, 'Ligne source introuvable.');
    const groupStart = Math.floor((row - 2) / 50) * 50 + 1;
    const groupStatus = db.prepare('SELECT status FROM distribution_groups WHERE group_start=?').get(groupStart)?.status ?? 'NON ASSIGNE';
    if (groupStatus === 'NON ASSIGNE') return fail(res, 409, 'Ce bloc est NON ASSIGNE. Passez son statut à EN COURS avant toute saisie.');
    const previous = db.prepare('SELECT version FROM treatments WHERE source_row=?').get(row);
    const version = (previous?.version || 0) + 1;
    const submitted = Boolean(req.body.submit);
    const updatedAt = now();
    db.prepare(`INSERT INTO treatments(source_row,current_data,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_row) DO UPDATE SET current_data=excluded.current_data,status=excluded.status,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at,submitted_at=COALESCE(excluded.submitted_at,treatments.submitted_at),quality_feedback=NULL,source_workbook_id=excluded.source_workbook_id`).run(row, JSON.stringify(values), submitted ? 'SUBMITTED' : 'DRAFT', version, req.user.id, updatedAt, submitted ? now() : null, null, sourceRowData.source_workbook_id);
    db.prepare('INSERT INTO treatment_history(source_row,values_json,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id,actor_role) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row, JSON.stringify(values), submitted ? 'SUBMITTED' : 'DRAFT', version, req.user.id, updatedAt, submitted ? now() : null, null, sourceRowData.source_workbook_id, req.user.role);
    broadcast('treatment-updated', { sourceRow: row, status: submitted ? 'SUBMITTED' : 'DRAFT', version, updatedBy: req.user.id, sourceWorkbookId: sourceRowData.source_workbook_id });
    ok(res, { storageMode: 'sqlite-sync', version });
  });

  app.get('/api/v1/treatments/latest', auth, (req, res) => {
    const since = String(req.query.since || '');
    const rows = since
      ? db.prepare("SELECT source_row, current_data, status, version, updated_at, updated_by FROM treatments WHERE updated_at > ? ORDER BY updated_at LIMIT 500").all(since)
      : db.prepare("SELECT source_row, current_data, status, version, updated_at, updated_by FROM treatments ORDER BY updated_at DESC LIMIT 100").all();
    ok(res, { treatments: rows.map(t => ({ ...t, currentData: JSON.parse(t.current_data), updatedAt: t.updated_at, updatedBy: t.updated_by })) });
  });

  app.post('/api/v1/treatments/batch', auth, allow('ADMIN'), (req, res) => {
    const entries = req.body?.treatments;
    if (!Array.isArray(entries) || entries.length > 10000) return fail(res, 400, 'Données invalides.');
    const upsert = db.prepare('INSERT INTO treatments(source_row,current_data,status,version,updated_by,updated_at,submitted_at,source_workbook_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_row) DO UPDATE SET current_data=excluded.current_data,status=excluded.status,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at,submitted_at=COALESCE(excluded.submitted_at,treatments.submitted_at),source_workbook_id=excluded.source_workbook_id');
    const insertHistory = db.prepare('INSERT INTO treatment_history(source_row,values_json,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id,actor_role) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const count = db.transaction((items) => {
      let n = 0;
      for (const item of items) {
        if (typeof item.source_row !== 'number' || typeof item.current_data !== 'string') continue;
        upsert.run(item.source_row, item.current_data, item.status || 'DRAFT', item.version || 1, req.user.id, item.updated_at || now(), item.submitted_at || null, item.source_workbook_id || null);
        insertHistory.run(item.source_row, item.current_data, item.status || 'DRAFT', item.version || 1, req.user.id, item.updated_at || now(), item.submitted_at || null, null, item.source_workbook_id || null, req.user.role);
        n++;
        broadcast('treatment-updated', { sourceRow: item.source_row, status: item.status || 'DRAFT', version: item.version || 1, updatedBy: req.user.id, sourceWorkbookId: item.source_workbook_id || null });
      }
      return n;
    })(entries);
    ok(res, { imported: count });
  });

  app.get('/api/v1/quality/treatments', auth, (req, res) => {
    const page = Math.max(0, Number(req.query.page) || 0);
    const rows = req.user.role === 'AGENT'
      ? db.prepare("SELECT source_row FROM treatments WHERE status='SUBMITTED' AND updated_by=? ORDER BY updated_at DESC LIMIT 101 OFFSET ?").all(req.user.id, page * 100)
      : db.prepare("SELECT source_row FROM treatments WHERE status='SUBMITTED' ORDER BY updated_at DESC LIMIT 101 OFFSET ?").all(page * 100);
    const treatments = rows.slice(0, 100).map(x => {
      const t = db.prepare('SELECT * FROM treatments WHERE source_row=?').get(x.source_row);
      const actor = db.prepare('SELECT * FROM users WHERE id=?').get(t.updated_by);
      return { sourceRow: t.source_row, currentData: JSON.parse(t.current_data), status: t.status, currentVersion: t.version, lastUpdatedAt: t.updated_at, submittedAt: t.submitted_at, lastUpdatedBy: { actorId: String(t.updated_by), actorType: actor?.role === 'SUPERVISEUR' ? 'QC' : 'USER' }, qualityFeedback: t.quality_feedback ? JSON.parse(t.quality_feedback) : null, errors: [], sourceWorkbookId: t.source_workbook_id };
    });
    ok(res, { treatments, page, hasMore: rows.length > 100 });
  });

  app.get('/api/v1/treatment-history/:row', auth, (req, res) => {
    const row = Number(req.params.row);
    if (!Number.isInteger(row) || row < 1) return fail(res, 400, 'Ligne invalide.');
    const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const history = db.prepare('SELECT * FROM treatment_history WHERE source_row=? ORDER BY updated_at DESC, id DESC LIMIT 200').all(row);
    ok(res, { history: history.map(h => {
      const actor = userById(h.updated_by);
      return {
        id: h.id, sourceRow: h.source_row, values: JSON.parse(h.values_json), status: h.status, version: h.version, updatedAt: h.updated_at, submittedAt: h.submitted_at, qualityFeedback: h.quality_feedback ? JSON.parse(h.quality_feedback) : null, sourceWorkbookId: h.source_workbook_id,
        updatedBy: { actorId: String(h.updated_by), firstName: actor?.first_name ?? '', lastName: actor?.last_name ?? '', login: actor?.login ?? '', role: actor?.role ?? '', fullName: `${actor?.first_name ?? ''} ${actor?.last_name ?? ''}`.trim() || (actor?.login ?? ''), actorType: h.actor_role === 'SUPERVISEUR' || h.actor_role === 'ADMIN' ? 'QC' : 'USER' },
      };
    }) });
  });

  app.get('/api/v1/source-workbooks', auth, (req, res) => {
    ok(res, { workbooks: db.prepare('SELECT id, name, file_type, imported_at, sheet_count, row_count FROM source_workbooks ORDER BY imported_at DESC').all() });
  });

  app.post('/api/v1/quality/treatments/:row/return', auth, allow('ADMIN', 'SUPERVISEUR'), (req, res) => {
    const row = Number(req.params.row);
    const message = String(req.body?.message || '').trim();
    if (!message || message.length > 2000) return fail(res, 400, 'Le retour doit contenir de 1 à 2000 caractères.');
    const t = db.prepare('SELECT * FROM treatments WHERE source_row=?').get(row);
    if (!t) return fail(res, 404, 'Saisie introuvable.');
    const fb = { message, createdAt: now(), createdBy: publicUser(req.user) };
    db.prepare('UPDATE treatments SET quality_feedback=? WHERE source_row=?').run(JSON.stringify(fb), row);
    const agentUsers = db.prepare("SELECT id FROM users WHERE role='AGENT' AND active=1").all();
    const insertNotification = db.prepare('INSERT INTO notifications(user_id,source_row,message,created_at) VALUES(?,?,?,?)');
    const tx = db.transaction((items) => {
      for (const u of items) {
        insertNotification.run(u.id, row, message, now());
      }
    });
    tx(agentUsers);
    broadcast('quality-feedback-added', { sourceRow: row, message });
    ok(res, {});
  });

  app.get('/api/v1/notifications', auth, (req, res) => {
    const notifications = db.prepare('SELECT id,source_row,message,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id).map(n => ({ id: String(n.id), sourceRow: n.source_row, text: `Retour qualité — ligne ${n.source_row}`, message: n.message, date: n.created_at, link: `/distribution/groupe/${Math.floor((n.source_row - 1) / 50) * 50 + 1}/ligne/${n.source_row - 1}` }));
    ok(res, { notifications });
  });

  app.get('/api/v1/stats/summary', auth, (req, res) => {
    const validatedLines = db.prepare("SELECT COUNT(*) n FROM treatments WHERE status='SUBMITTED'").get().n;
    const returnsReceived = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get(req.user.id).n;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yesterdayProduction = db.prepare("SELECT COUNT(*) n FROM treatments WHERE status='SUBMITTED' AND substr(submitted_at,1,10)=?").get(yesterday).n;
    ok(res, { validatedLines, returnsReceived, connectedHours: 0, yesterdayProduction });
  });

  app.get('/api/v1/stats/agents', auth, (req, res) => {
    const from = String(req.query.from || '0000-01-01');
    const to = String(req.query.to || '9999-12-31');
    const dailyRows = req.user.role === 'AGENT'
      ? db.prepare("SELECT updated_by,substr(updated_at,1,10) AS date,SUM(CASE WHEN status='SUBMITTED' THEN 1 ELSE 0 END) AS validated,COUNT(*) AS total,SUM(CASE WHEN quality_feedback IS NOT NULL THEN 1 ELSE 0 END) AS returned FROM treatments WHERE substr(updated_at,1,10) BETWEEN ? AND ? AND updated_by=? GROUP BY updated_by,date ORDER BY date").all(from, to, req.user.id)
      : db.prepare("SELECT updated_by,substr(updated_at,1,10) AS date,SUM(CASE WHEN status='SUBMITTED' THEN 1 ELSE 0 END) AS validated,COUNT(*) AS total,SUM(CASE WHEN quality_feedback IS NOT NULL THEN 1 ELSE 0 END) AS returned FROM treatments WHERE substr(updated_at,1,10) BETWEEN ? AND ? GROUP BY updated_by,date ORDER BY date").all(from, to);
    const byAgent = new Map();
    for (const r of dailyRows) {
      if (!byAgent.has(r.updated_by)) byAgent.set(r.updated_by, []);
      byAgent.get(r.updated_by).push({ date: r.date, validatedLines: r.validated, correctedReturns: r.returned, total: r.total });
    }
    const agents = [...byAgent].map(([id, daily]) => {
      const u = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
      const days = daily.map(d => d.validatedLines);
      const validatedLines = days.reduce((a, b) => a + b, 0);
      const correctedReturns = daily.reduce((a, d) => a + d.correctedReturns, 0);
      const nonzero = daily.filter(d => d.validatedLines > 0);
      const bestDay = nonzero.reduce((a, d) => !a || d.validatedLines > a.validatedLines ? d : a, null);
      const lowestDay = nonzero.reduce((a, d) => !a || d.validatedLines < a.validatedLines ? d : a, null);
      return { ...u, actorId: u.id, agent: u.fullName, role: u.role, daily, validatedLines, correctedReturns, qualityPercent: validatedLines ? Math.round(100 * validatedLines / (validatedLines + correctedReturns)) : 0, averageDailyProductivity: nonzero.length ? Math.round(validatedLines / nonzero.length) : 0, bestDay, lowestDay };
    });
    ok(res, { agents });
  });

  app.get('/api/v1/suggestions', auth, (req, res) => {
    const field = String(req.query.field || '');
    const q = String(req.query.q || '').toLowerCase();
    if (q.length < 3) return ok(res, []);
    const results = db.prepare('SELECT DISTINCT value FROM suggestions WHERE field_name=? AND value LIKE ? ESCAPE "\\" ORDER BY value LIMIT 50')
      .all(field, '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
    ok(res, results.map(r => ({ word: r.value })));
  });

  app.get('/api/v1/suggestions/all', auth, allow('ADMIN'), (req, res) => {
    ok(res, { suggestions: db.prepare('SELECT field_name, value, created_at, updated_at FROM suggestions ORDER BY field_name, value').all() });
  });

  app.post('/api/v1/suggestions', auth, allow('ADMIN'), (req, res) => {
    const field = String(req.body?.field || '');
    const value = String(req.body?.value || '').trim();
    if (!field || !value || value.length > 10000) return fail(res, 400, 'Champ et valeur requis.');
    const existing = db.prepare('SELECT id FROM suggestions WHERE field_name=? AND value=?').get(field, value);
    if (existing) {
      db.prepare('UPDATE suggestions SET updated_at=? WHERE field_name=? AND value=?').run(now(), field, value);
      broadcast('suggestion-created', { field, value });
      ok(res, { created: false, field, value });
    } else {
      db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?)').run(field, value, now(), now());
      broadcast('suggestion-created', { field, value });
      ok(res, { created: true, field, value });
    }
  });

  app.post('/api/v1/suggestions/seed', auth, allow('ADMIN'), (req, res) => {
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || entries.length > 5000 || entries.some(e => !e || typeof e.fieldName !== 'string' || typeof e.value !== 'string' || e.value.length > 10000)) return fail(res, 400, 'Données de dictionnaire invalides.');
    const insert = db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?)');
    const upsert = db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
    let count = 0;
    db.transaction((items) => {
      for (const item of items) {
        const existing = db.prepare('SELECT id FROM suggestions WHERE field_name=? AND value=?').get(item.fieldName, item.value);
        if (existing) upsert.run(item.fieldName, item.value, now(), now());
        else insert.run(item.fieldName, item.value, now(), now());
        broadcast('suggestion-created', { field: item.fieldName, value: item.value });
        count++;
      }
    })(entries);
    ok(res, { inserted: count });
  });

  app.get('/api/v1/catalog/sheets', auth, (req, res) => {
    const sheets = db.prepare('SELECT sheet_name, row_count, headers_json FROM catalog_sheets ORDER BY rowid').all();
    ok(res, { sheets: sheets.map(s => ({ name: s.sheet_name, rowCount: s.row_count })) });
  });

  app.get('/api/v1/catalog/sheets/:sheetName', auth, (req, res) => {
    const sheet = db.prepare('SELECT * FROM catalog_sheets WHERE sheet_name=?').get(req.params.sheetName);
    if (!sheet) return fail(res, 404, 'Onglet introuvable.');
    const headers = JSON.parse(sheet.headers_json);
    ok(res, { headers, rows: JSON.parse(sheet.rows_json) });
  });

  app.get('/api/v1/catalog/search', auth, (req, res) => {
    const filter = String(req.query.ean || '').trim().toLowerCase();
    if (!filter) return ok(res, { sheets: [], total: 0 });
    const allSheets = db.prepare('SELECT sheet_name, headers_json, rows_json FROM catalog_sheets ORDER BY rowid').all();
    const combined = [];
    for (const sheet of allSheets) {
      const sheetHeaders = JSON.parse(sheet.headers_json);
      const allRows = JSON.parse(sheet.rows_json);
      const eanCol = eanHeader(sheetHeaders);
      if (!eanCol) continue;
      const matches = allRows.filter(row => String(row[eanCol] ?? '').toLowerCase().includes(filter));
      if (matches.length) {
        for (const row of matches) combined.push({ ...row, _sourceSheet: sheet.sheet_name });
      }
    }
    ok(res, { total: combined.length, rows: combined });
  });

  app.post('/api/v1/catalog/sheets/:sheetName', auth, allow('ADMIN'), (req, res) => {
    const name = req.params.sheetName;
    const { headers, rows } = req.body || {};
    if (!headers || !rows || !Array.isArray(rows) || rows.length > 100000) return fail(res, 400, 'Données invalides.');
    db.prepare('INSERT INTO catalog_sheets(sheet_name,headers_json,rows_json,row_count,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(sheet_name) DO UPDATE SET headers_json=excluded.headers_json,rows_json=excluded.rows_json,row_count=excluded.row_count,updated_at=excluded.updated_at').run(name, JSON.stringify(headers), JSON.stringify(rows), rows.length, now());
    broadcast('catalog-sheet-updated', { sheetName: name, rowCount: rows.length });
    ok(res, { sheetName: name, rows: rows.length });
  });

  app.post('/api/v1/source/import', auth, allow('ADMIN'), (req, res) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 100000) return fail(res, 400, 'Lignes invalides.');
    db.transaction(() => {
      db.prepare('DELETE FROM source_rows').run();
      const insert = db.prepare('INSERT INTO source_rows(row_number,values_json) VALUES(?,?)');
      rows.forEach((row, index) => insert.run(index + 2, JSON.stringify(row)));
    })();
    broadcast('source-imported', { rowCount: rows.length });
    ok(res, { rows: rows.length });
  });

  app.post('/api/v1/sync/receive', auth, allow('ADMIN', 'SUPERVISEUR'), (req, res) => {
    const data = req.body;
    if (!data || typeof data !== 'object') return fail(res, 400, 'Données de synchronisation invalides.');
    const tx = db.transaction(() => {
      if (data.eventType) {
        switch (data.eventType) {
          case 'treatment-updated': {
            if (typeof data.sourceRow !== 'number' || !data.values || typeof data.values !== 'object') return;
            const version = (data.version || 1);
            const row = data.sourceRow;
            const groupStart = Math.floor((row - 2) / 50) * 50 + 1;
            const groupStatus = db.prepare('SELECT status FROM distribution_groups WHERE group_start=?').get(groupStart)?.status ?? 'NON ASSIGNE';
            if (groupStatus === 'NON ASSIGNE') return;
            const userId = db.prepare('SELECT id FROM users WHERE login=?').get(data.syncUser || req.user.login)?.id || req.user.id;
            db.prepare(`INSERT INTO treatments(source_row,current_data,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_row) DO UPDATE SET current_data=excluded.current_data,status=excluded.status,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at,submitted_at=COALESCE(excluded.submitted_at,treatments.submitted_at),quality_feedback=NULL,source_workbook_id=excluded.source_workbook_id`).run(row, JSON.stringify(data.values), data.submit ? 'SUBMITTED' : 'DRAFT', version, userId, data.updatedAt || now(), data.submit ? now() : null, null, data.sourceWorkbookId || null);
            db.prepare('INSERT INTO treatment_history(source_row,values_json,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id,actor_role) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row, JSON.stringify(data.values), data.submit ? 'SUBMITTED' : 'DRAFT', version, userId, data.updatedAt || now(), data.submit ? now() : null, null, data.sourceWorkbookId || null, req.user.role);
            broadcast('treatment-updated', { sourceRow: row, status: data.submit ? 'SUBMITTED' : 'DRAFT', version, updatedBy: userId, sourceWorkbookId: data.sourceWorkbookId || null });
            return;
          }
          case 'distribution-group-updated': {
            if (!Number.isInteger(data.groupStart) || !groupStatuses.includes(data.status)) return;
            db.prepare('INSERT INTO distribution_groups(group_start,status,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(group_start) DO UPDATE SET status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(data.groupStart, data.status, data.updatedBy || req.user.id, data.updatedAt || now());
            broadcast('distribution-group-updated', { groupStart: data.groupStart, status: data.status });
            return;
          }
          case 'quality-feedback-added': {
            const row = data.sourceRow;
            const fb = { message: data.message, createdAt: data.createdAt || now(), createdBy: data.createdBy || publicUser(req.user) };
            db.prepare('UPDATE treatments SET quality_feedback=? WHERE source_row=?').run(JSON.stringify(fb), row);
            const agentUsers = db.prepare("SELECT id FROM users WHERE role='AGENT' AND active=1").all();
            const insertNotification = db.prepare('INSERT INTO notifications(user_id,source_row,message,created_at) VALUES(?,?,?,?)');
            for (const u of agentUsers) insertNotification.run(u.id, row, data.message, now());
            broadcast('quality-feedback-added', { sourceRow: row, message: data.message });
            return;
          }
          case 'suggestions-seeded': {
            return;
          }
          case 'source-imported': {
            if (!Array.isArray(data.rows)) return;
            if (data.sourceWorkbookId && data.workbookName) {
              const existing = db.prepare('SELECT id FROM source_workbooks WHERE id=?').get(data.sourceWorkbookId);
              if (!existing) db.prepare('INSERT INTO source_workbooks(id,name,file_type,imported_by,imported_at,sheet_count,row_count) VALUES(?,?,?,?,?,?,?)').run(data.sourceWorkbookId, data.workbookName, data.fileType || 'xlsx', data.importedBy || 1, data.importedAt || now(), data.sheetCount || 1, data.rows.length);
            }
            db.prepare('DELETE FROM source_rows').run();
            const insert = db.prepare('INSERT INTO source_rows(row_number,values_json,source_workbook_id) VALUES(?,?,?)');
            data.rows.forEach((row, index) => insert.run(index + 2, JSON.stringify(row), data.sourceWorkbookId || null));
            broadcast('source-imported', { rowCount: data.rows.length });
            return;
          }
          case 'catalog-synced': {
            if (!Array.isArray(data.sheets)) return;
            db.prepare('DELETE FROM catalog_sheets').run();
            const insert = db.prepare('INSERT INTO catalog_sheets(sheet_name,headers_json,rows_json,row_count,updated_at) VALUES(?,?,?,?,?)');
            data.sheets.forEach(sheet => insert.run(sheet.name, JSON.stringify(sheet.headers || Object.keys(sheet.rows[0] || {})), JSON.stringify(sheet.rows), sheet.rows.length, now()));
            broadcast('catalog-synced', { sheetCount: data.sheets.length });
            return;
          }
          case 'user-created': case 'user-updated': {
            if (!data.login || !data.firstName || !data.lastName) return;
            const existing = db.prepare('SELECT id FROM users WHERE login=?').get(data.login);
            if (data.eventType === 'user-created') {
              if (existing) return;
              const h = hash(data.password || crypto.randomBytes(18).toString('base64url'));
              const role = ['AGENT', 'SUPERVISEUR', 'ADMIN'].includes(data.role) ? data.role : 'AGENT';
              const out = db.prepare('INSERT INTO users(login,first_name,last_name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(data.login, data.firstName, data.lastName, role, h.salt, h.hash, now());
              broadcast('user-created', { ...publicUser(userByIdSync(out.lastInsertRowid)) });
            } else if (existing && String(existing.id) === data.id) {
              const role = ['AGENT', 'SUPERVISEUR', 'ADMIN'].includes(data.role) ? data.role : existing.role;
              db.prepare('UPDATE users SET login=?,first_name=?,last_name=?,role=? WHERE id=?').run(data.login, data.firstName, data.lastName, role, existing.id);
              broadcast('user-updated', { id: String(existing.id), ...publicUser(userByIdSync(existing.id)) });
            } else if (existing) {
              return;
            }
            return;
          }
          case 'user-deleted': {
            db.prepare('DELETE FROM users WHERE id=?').run(Number(data.userId));
            broadcast('user-deleted', { userId: data.userId });
            return;
          }
           case 'user-login': {
            if (!data.login || !data.firstName || !data.lastName) return;
            const existing = db.prepare('SELECT id FROM users WHERE login=?').get(data.login);
            const role = ['AGENT', 'SUPERVISEUR', 'ADMIN'].includes(data.role) ? data.role : 'AGENT';
            if (existing) {
              db.prepare('UPDATE users SET first_name=?,last_name=?,role=? WHERE login=?').run(data.firstName, data.lastName, role, data.login);
            } else {
              const h = hash(crypto.randomBytes(18).toString('base64url'));
              db.prepare('INSERT INTO users(login,first_name,last_name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(data.login, data.firstName, data.lastName, role, h.salt, h.hash, now());
            }
            return;
          }
          default:
            return;
        }
      }
      if (Array.isArray(data.suggestions)) {
        const insert = db.prepare('INSERT INTO suggestions(field_name,value,created_at,updated_at) VALUES(?,?,?,?)');
        for (const entry of data.suggestions) {
          if (typeof entry.fieldName !== 'string' || typeof entry.value !== 'string') continue;
          const existing = db.prepare('SELECT id FROM suggestions WHERE field_name=? AND value=?').get(entry.fieldName, entry.value);
          if (existing) {
            db.prepare('UPDATE suggestions SET updated_at=? WHERE field_name=? AND value=?').run(entry.updated_at || now(), entry.fieldName, entry.value);
          } else {
            insert.run(entry.fieldName, entry.value, now(), now());
          }
          broadcast('suggestion-created', { field: entry.fieldName, value: entry.value });
        }
      }
      if (Array.isArray(data.treatments)) {
        const upsert = db.prepare('INSERT INTO treatments(source_row,current_data,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_row) DO UPDATE SET current_data=excluded.current_data,status=excluded.status,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at,submitted_at=COALESCE(excluded.submitted_at,treatments.submitted_at),quality_feedback=excluded.quality_feedback,source_workbook_id=excluded.source_workbook_id');
        const userId = db.prepare('SELECT id FROM users WHERE login=?').get(data.syncUser || req.user.login)?.id || req.user.id;
        for (const t of data.treatments) {
          if (typeof t.source_row !== 'number' || typeof t.current_data !== 'string') continue;
          upsert.run(t.source_row, t.current_data, t.status, t.version || 1, t.updated_by || userId, t.updated_at || now(), t.submitted_at || null, t.quality_feedback || null, t.source_workbook_id || null);
          broadcast('treatment-updated', { sourceRow: t.source_row, status: t.status, version: t.version || 1, updatedBy: t.updated_by || userId, sourceWorkbookId: t.source_workbook_id || null });
        }
      }
      if (Array.isArray(data.treatmentHistory)) {
        const insertHistory = db.prepare('INSERT INTO treatment_history(source_row,values_json,status,version,updated_by,updated_at,submitted_at,quality_feedback,source_workbook_id,actor_role) VALUES(?,?,?,?,?,?,?,?,?,?)');
        for (const h of data.treatmentHistory) {
          if (typeof h.source_row !== 'number' || typeof h.values_json !== 'string') continue;
          insertHistory.run(h.source_row, h.values_json, h.status, h.version || 1, h.updated_by || req.user.id, h.updated_at || now(), h.submitted_at || null, h.quality_feedback || null, h.source_workbook_id || null, h.actor_role || null);
        }
      }
      if (data.sourceRows) {
        const rows = data.sourceRows;
        db.prepare('DELETE FROM source_rows').run();
        const insert = db.prepare('INSERT INTO source_rows(row_number,values_json,source_workbook_id) VALUES(?,?,?)');
        rows.forEach((row, index) => insert.run(index + 2, JSON.stringify(row.values || row), row.sourceWorkbookId || null));
        broadcast('source-imported', { rowCount: rows.length });
      }
      if (Array.isArray(data.sourceWorkbooks)) {
        const upsertWorkbook = db.prepare('INSERT INTO source_workbooks(id,name,file_type,imported_by,imported_at,sheet_count,row_count) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,file_type=excluded.file_type,imported_by=excluded.imported_by,imported_at=excluded.imported_at,sheet_count=excluded.sheet_count,row_count=excluded.row_count');
        for (const w of data.sourceWorkbooks) {
          if (typeof w.id !== 'number' || typeof w.name !== 'string') continue;
          upsertWorkbook.run(w.id, w.name, w.file_type || 'xlsx', w.imported_by || req.user.id, w.imported_at || now(), w.sheet_count || 0, w.row_count || 0);
        }
      }
      if (data.catalogSheets) {
        const sheets = data.catalogSheets;
        db.prepare('DELETE FROM catalog_sheets').run();
        const insert = db.prepare('INSERT INTO catalog_sheets(sheet_name,headers_json,rows_json,row_count,updated_at) VALUES(?,?,?,?,?)');
        sheets.forEach(sheet => insert.run(sheet.name, JSON.stringify(sheet.headers || Object.keys(sheet.rows[0] || {})), JSON.stringify(sheet.rows), sheet.rows.length, now()));
        broadcast('catalog-synced', { sheetCount: sheets.length });
      }
      if (Array.isArray(data.distributionGroups)) {
        const upsert = db.prepare('INSERT INTO distribution_groups(group_start,status,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(group_start) DO UPDATE SET status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at');
        for (const g of data.distributionGroups) {
          if (!Number.isInteger(g.groupStart) || !groupStatuses.includes(g.status)) continue;
          upsert.run(g.groupStart, g.status, g.updatedBy || req.user.id, g.updatedAt || now());
          broadcast('distribution-group-updated', { groupStart: g.groupStart, status: g.status });
        }
      }
      if (Array.isArray(data.notifications)) {
        const insert = db.prepare('INSERT INTO notifications(user_id,source_row,message,created_at) VALUES(?,?,?,?)');
        for (const n of data.notifications) {
          insert.run(n.userId || req.user.id, n.sourceRow, n.message, n.createdAt || now());
          broadcast('notification-created', { sourceRow: n.sourceRow, message: n.message });
        }
      }
    });
    tx();
    ok(res, { received: true });
  });

  app.get('/api/v1/sync/export', auth, allow('ADMIN'), (req, res) => {
    const suggestions = db.prepare('SELECT field_name as fieldName, value, created_at, updated_at FROM suggestions').all();
    const treatments = db.prepare('SELECT source_row, current_data, status, version, updated_by, updated_at, submitted_at, quality_feedback, source_workbook_id FROM treatments WHERE status=\'SUBMITTED\'').all();
    const sourceRows = db.prepare('SELECT row_number, values_json, source_workbook_id FROM source_rows ORDER BY row_number').all().map(r => ({ rowNumber: r.row_number, values: JSON.parse(r.values_json), sourceWorkbookId: r.source_workbook_id }));
    const catalogSheets = db.prepare('SELECT sheet_name, headers_json, rows_json, row_count FROM catalog_sheets').all().map(s => ({ name: s.sheet_name, headers: JSON.parse(s.headers_json), rows: JSON.parse(s.rows_json), rowCount: s.row_count }));
    const distributionGroups = db.prepare('SELECT group_start as groupStart, status, updated_by as updatedBy, updated_at as updatedAt FROM distribution_groups ORDER BY group_start').all();
    const allSuggestions = db.prepare('SELECT field_name as fieldName, value, created_at, updated_at FROM suggestions ORDER BY field_name, value').all();
    const sourceWorkbooks = db.prepare('SELECT id, name, file_type, imported_by, imported_at, sheet_count, row_count FROM source_workbooks ORDER BY imported_at DESC').all();
    const treatmentHistory = db.prepare('SELECT source_row, values_json, status, version, updated_by, updated_at, submitted_at, quality_feedback, source_workbook_id, actor_role FROM treatment_history ORDER BY updated_at DESC LIMIT 5000').all().map(h => ({ source_row: h.source_row, values_json: h.values_json, status: h.status, version: h.version, updated_by: h.updated_by, updated_at: h.updated_at, submitted_at: h.submitted_at, quality_feedback: h.quality_feedback, source_workbook_id: h.source_workbook_id, actor_role: h.actor_role }));
    ok(res, { suggestions: allSuggestions, treatments, sourceRows, catalogSheets, distributionGroups, sourceWorkbooks, treatmentHistory, exportedAt: now() });
  });

  app.use('/api', (req, res) => fail(res, 404, 'Route API introuvable.'));
  app.use((err, req, res, next) => { logger?.error?.('sync_server_error', err); fail(res, 500, 'Une erreur interne est survenue.'); });

  const server = tlsConfig
    ? https.createServer(tlsConfig, app).listen(port, host, () => logger.info?.(`Serveur de synchronisation prêt sur https://${host}:${port} — base SQLite partagée: ${storeDir}`))
    : http.createServer(app).listen(port, host, () => logger.info?.(`Serveur de synchronisation prêt sur http://${host}:${port} — base SQLite partagée: ${storeDir}`));

  return {
    app,
    server,
    db,
    host,
    port,
    initialCredentials,
    close: () => { server.close(); db.close(); },
  };
}

if (require.main === module) {
  require('./tlsTrust.cjs').trustCertificateAuthorities();
  const backend = createSyncServer();
  if (backend.initialCredentials) console.warn(`Compte administrateur initial — login : ${backend.initialCredentials.login} — mot de passe : ${backend.initialCredentials.password}`);
}

module.exports = { createSyncServer, normalizeHeader, eanHeader };
