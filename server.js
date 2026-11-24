require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const scrypt = promisify(crypto.scrypt);
const app = express();
const root = process.env.APP_ROOT || __dirname;
const dataDirectory = path.join(root, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });

const production = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
if (production && (!sessionSecret || Buffer.byteLength(sessionSecret) < 32)) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 bytes before starting in production.');
}
if (production && !process.env.APP_ORIGIN) {
  throw new Error('Set APP_ORIGIN (e.g. https://your-domain.example) before starting in production.');
}
const activeSessionSecret = sessionSecret || crypto.randomBytes(48).toString('base64url');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

const db = new Database(path.join(dataDirectory, 'margin.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS books (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL,
    chapters_json TEXT NOT NULL,
    progress_json TEXT NOT NULL DEFAULT '{"segmentIndex":0,"wordOffset":0,"scrollPercent":0}',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
`);

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (error) { callback(error); }
  }

  set(sid, value, callback = () => { }) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at')
        .run(sid, JSON.stringify(value), expiresAt);
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => { }) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => { }) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      workerSrc: ["'self'", 'blob:'],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  strictTransportSecurity: production ? undefined : false,
  permissionsPolicy: {
    features: {
      camera: [],
      microphone: [],
      geolocation: [],
    },
  },
}));
app.use(express.json({ limit: '24mb', strict: true }));
app.use(session({
  name: production ? '__Host-margin.sid' : 'margin.sid',
  secret: activeSessionSecret,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  },
}));

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  const host = req.get('host');
  const expected = (process.env.APP_ORIGIN || (host ? `${req.protocol}://${host}` : '')).replace(/\/$/, '');
  const reqOrigin = (origin || '').replace(/\/$/, '');
  if (!reqOrigin || !expected || reqOrigin !== expected) return res.status(403).json({ error: 'Request origin could not be verified.' });
  next();
}

function requireUser(req, res, next) {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Please sign in to continue.' });
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) {
    req.session.destroy(() => { });
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  req.user = user;
  next();
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a little and try again.' },
  skipSuccessfulRequests: true,
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many accounts created. Please wait and try again.' },
});

const DUMMY_SALT = Buffer.from('bWFyZ2luLWZha2Utc2FsdC1mb3ItdGltaW5nLXNhZmV0eQ', 'base64url');
const DUMMY_HASH = Buffer.alloc(64);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function passwordHash(password, salt) {
  return scrypt(password, salt, 64, SCRYPT_OPTIONS);
}

function validUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{1,22}[A-Za-z0-9]$/.test(username);
}

function validPassword(password) {
  const length = typeof password === 'string' ? Array.from(password).length : 0;
  return length >= 12 && length <= 128;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

app.get('/', (req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/app.js', (req, res) => res.type('application/javascript').sendFile(path.join(root, 'app.js')));
app.get('/styles.css', (req, res) => res.type('text/css').sendFile(path.join(root, 'styles.css')));
app.get('/vendor/jszip.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/jszip/dist/jszip.min.js')));
app.get('/vendor/pdf.mjs', (req, res) => res.sendFile(path.join(root, 'node_modules/pdfjs-dist/build/pdf.mjs')));
app.get('/vendor/pdf.worker.min.mjs', (req, res) => res.sendFile(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/logo.png', (req, res) => res.type('image/png').sendFile(path.join(root, 'logo.png')));

app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.session.userId) return res.json({ user: null });
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => { });
    return res.json({ user: null });
  }
  res.json({ user: { username: user.username } });
});

app.post('/api/auth/register', sameOrigin, registerLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = req.body.password;
    if (!validUsername(username)) return res.status(400).json({ error: 'Username must be 3–24 characters: letters, numbers, dot, dash, or underscore.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be between 12 and 128 characters.' });
    const salt = crypto.randomBytes(16);
    const hash = await passwordHash(password, salt);
    let result;
    try {
      result = db.prepare('INSERT INTO users (username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(username, salt.toString('base64url'), hash.toString('base64url'), Date.now());
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That username is already in use.' });
      throw error;
    }
    await regenerateSession(req);
    req.session.userId = Number(result.lastInsertRowid);
    req.session.username = username;
    req.session.save(error => error ? next(error) : res.status(201).json({ user: { username } }));
  } catch (error) { next(error); }
});

app.post('/api/auth/login', sameOrigin, authLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!validUsername(username) || !password || Array.from(password).length > 128) return res.status(400).json({ error: 'Enter a valid username and password.' });
    const user = db.prepare('SELECT id, username, password_salt, password_hash FROM users WHERE username = ? COLLATE NOCASE').get(username);
    const salt = user ? Buffer.from(user.password_salt, 'base64url') : DUMMY_SALT;
    const expected = user ? Buffer.from(user.password_hash, 'base64url') : DUMMY_HASH;
    const actual = await passwordHash(password, salt);
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!user || !matches) return res.status(401).json({ error: 'Invalid username or password.' });
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.save(error => error ? next(error) : res.json({ user: { username: user.username } }));
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', sameOrigin, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie(production ? '__Host-margin.sid' : 'margin.sid', { httpOnly: true, secure: production, sameSite: 'strict', path: '/' });
    res.status(204).end();
  });
});

app.get('/api/books', requireUser, (req, res, next) => {
  try {
    const row = db.prepare('SELECT title, author, format, chapters_json, progress_json FROM books WHERE user_id = ?').get(req.user.id);
    res.set('Cache-Control', 'no-store');
    if (!row) return res.json({ book: null });
    let chapters, progress;
    try {
      chapters = JSON.parse(row.chapters_json);
      progress = JSON.parse(row.progress_json);
    } catch (parseError) {
      console.error(`Book for user ${req.user.id} has corrupt JSON:`, parseError);
      return res.status(500).json({ error: 'This book could not be loaded. Please re-upload.' });
    }
    res.json({ book: { title: row.title, author: row.author, format: row.format, chapters, progress } });
  } catch (error) { next(error); }
});

app.put('/api/books', sameOrigin, requireUser, (req, res) => {
  const { title, author = '', format, chapters } = req.body || {};
  const allowedFormats = new Set(['epub', 'pdf', 'txt', 'md']);
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 240) return res.status(400).json({ error: 'Book title is required.' });
  if (typeof author !== 'string' || author.trim().length > 240) return res.status(400).json({ error: 'Book author is too long.' });
  if (!allowedFormats.has(format) || !Array.isArray(chapters) || chapters.length < 1 || chapters.length > 1500) return res.status(400).json({ error: 'Book format or chapter data is invalid.' });
  let textBytes = 0;
  for (const chapter of chapters) {
    if (!chapter || typeof chapter.title !== 'string' || chapter.title.length > 400 || typeof chapter.text !== 'string') return res.status(400).json({ error: 'Book text is invalid.' });
    textBytes += Buffer.byteLength(chapter.text, 'utf8');
    if (textBytes > 14 * 1024 * 1024) return res.status(413).json({ error: 'Extracted book text is larger than 14 MB.' });
  }
  const json = JSON.stringify(chapters);
  db.prepare(`INSERT INTO books (user_id, title, author, format, chapters_json, progress_json, updated_at)
    VALUES (?, ?, ?, ?, ?, '{"segmentIndex":0,"wordOffset":0,"scrollPercent":0}', ?)
    ON CONFLICT(user_id) DO UPDATE SET title = excluded.title, author = excluded.author, format = excluded.format,
    chapters_json = excluded.chapters_json, progress_json = excluded.progress_json, updated_at = excluded.updated_at`)
    .run(req.user.id, title.trim(), author.trim(), format, json, Date.now());
  res.status(201).json({ ok: true });
});

app.delete('/api/books', sameOrigin, requireUser, (req, res) => {
  db.prepare('DELETE FROM books WHERE user_id = ?').run(req.user.id);
  res.status(204).end();
});

app.put('/api/progress', sameOrigin, requireUser, (req, res) => {
  const { segmentIndex, wordOffset, scrollPercent } = req.body || {};
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 1000000 ||
    !Number.isSafeInteger(wordOffset) || wordOffset < 0 || wordOffset > 100000 ||
    typeof scrollPercent !== 'number' || !Number.isFinite(scrollPercent) || scrollPercent < 0 || scrollPercent > 100) {
    return res.status(400).json({ error: 'Reading position is invalid.' });
  }
  const result = db.prepare('UPDATE books SET progress_json = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify({ segmentIndex, wordOffset, scrollPercent }), Date.now(), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'There is no uploaded book to save progress for.' });
  res.status(204).end();
});

setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()); } catch (error) { console.error('Session cleanup failed:', error); }
}, 60 * 60 * 1000).unref();

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && Object.hasOwn(error, 'body')) return res.status(400).json({ error: 'Request body is not valid JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  console.error('Request failed:', error);
  res.status(500).json({ error: 'The request could not be completed.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => console.log(`Margin is listening on http://${host}:${port}`));
  const shutdown = () => {
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
module.exports = app;
