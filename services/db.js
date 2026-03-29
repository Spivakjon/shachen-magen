// services/db.js — SQLite database for שכן מגן
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use persistent volume on Railway (/persist), fallback to local data/
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'shachen-magen.db');

const db = Database(DB_PATH, { verbose: null });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS hosts (
    _id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone            TEXT UNIQUE NOT NULL,
    name             TEXT NOT NULL,
    address          TEXT NOT NULL,
    city             TEXT DEFAULT 'תל מונד',
    neighborhood     TEXT,
    lat              REAL,
    lng              REAL,
    floor            INTEGER DEFAULT 0,
    capacity         INTEGER DEFAULT 4,
    accessibility    INTEGER DEFAULT 0,
    notes            TEXT DEFAULT '',
    status           TEXT DEFAULT 'manual',
    is_approved      INTEGER DEFAULT 1,
    is_active        INTEGER DEFAULT 0,
    verified_phone   INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    _id              INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id      TEXT UNIQUE,
    alert_type       TEXT NOT NULL DEFAULT 'missiles',
    cities           TEXT NOT NULL,
    time_to_shelter  INTEGER DEFAULT 90,
    started_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ended_at         TEXT,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS shelter_activations (
    _id              INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id          INTEGER NOT NULL REFERENCES hosts(_id),
    alert_id         INTEGER REFERENCES alerts(_id),
    activation_type  TEXT DEFAULT 'manual',
    seekers_count    INTEGER DEFAULT 0,
    activated_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    deactivated_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS seeker_events (
    _id              INTEGER PRIMARY KEY AUTOINCREMENT,
    activation_id    INTEGER REFERENCES shelter_activations(_id),
    host_id          INTEGER REFERENCES hosts(_id),
    event_type       TEXT NOT NULL,
    seeker_lat       REAL,
    seeker_lng       REAL,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    _id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone            TEXT NOT NULL,
    code             TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    used             INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    _id              INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id          INTEGER REFERENCES hosts(_id),
    endpoint         TEXT UNIQUE NOT NULL,
    keys_p256dh      TEXT NOT NULL,
    keys_auth        TEXT NOT NULL,
    user_agent       TEXT,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS cities (
    _id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT UNIQUE NOT NULL,
    name_en          TEXT,
    lat              REAL,
    lng              REAL,
    time_to_shelter  INTEGER DEFAULT 90,
    is_active        INTEGER DEFAULT 1,
    hosts_count      INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key              TEXT PRIMARY KEY,
    value            TEXT,
    updated_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_hosts_city ON hosts(city);
  CREATE INDEX IF NOT EXISTS idx_hosts_active ON hosts(is_active);
  CREATE INDEX IF NOT EXISTS idx_hosts_location ON hosts(lat, lng);
  CREATE INDEX IF NOT EXISTS idx_alerts_started ON alerts(started_at);
  CREATE INDEX IF NOT EXISTS idx_activations_host ON shelter_activations(host_id);
  CREATE INDEX IF NOT EXISTS idx_activations_alert ON shelter_activations(alert_id);
  CREATE INDEX IF NOT EXISTS idx_push_host ON push_subscriptions(host_id);
`);

// ─── Helpers ───
export function getSqliteDb() { return db; }

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value);
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

// ─── Async query wrapper (for shared-dashboard compatibility) ───
export async function sqliteQuery(sql, params = []) {
  let sqliteSQL = sql;
  if (params.length > 0 && sql.includes('$')) {
    sqliteSQL = sql.replace(/\$(\d+)/g, '?');
  }
  const trimmed = sqliteSQL.trim().toUpperCase();
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
    const stmt = db.prepare(sqliteSQL);
    return { rows: stmt.all(...params) };
  }
  const stmt = db.prepare(sqliteSQL);
  const result = stmt.run(...params);
  return { rows: [], rowCount: result.changes };
}

export default db;
