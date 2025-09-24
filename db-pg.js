// db-pg.js — client Postgres con forzatura IPv4 + auto-schema
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const hostOverride = process.env.DATABASE_HOST4 || ''; // es. "34.xxx.xxx.xxx" per forzare IPv4

// Parse minimale dell'URL (postgresql://user:pass@host:port/db?sslmode=require)
function parsePgUrl(url) {
  const m = url.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:/?]+):?(\d+)?\/([^?]+)(?:\?(.+))?$/i);
  if (!m) throw new Error('DATABASE_URL non valido');
  const [, user, password, host, port, database, query] = m;
  const params = new URLSearchParams(query || '');
  const sslmode = (params.get('sslmode') || '').toLowerCase();
  const ssl =
    sslmode === 'require' || sslmode === 'verify-full'
      ? { rejectUnauthorized: false }
      : false;

  return { user, password, host, port: port ? Number(port) : 5432, database, ssl };
}

function buildPoolConfig() {
  if (!connectionString) throw new Error('DATABASE_URL non impostata');
  const base = parsePgUrl(connectionString);

  if (hostOverride) {
    console.log('🌐 Using DATABASE_HOST4 override:', hostOverride);
    return {
      user: base.user,
      password: base.password,
      host: hostOverride, // forza IPv4
      port: base.port,
      database: base.database,
      ssl: base.ssl,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    };
  }

  return {
    user: base.user,
    password: base.password,
    host: base.host,
    port: base.port,
    database: base.database,
    ssl: base.ssl,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  };
}

const pool = new Pool(buildPoolConfig());

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function ping() {
  const res = await query('select 1 as ok');
  return res.rows?.[0]?.ok === 1;
}

// Crea tabelle/indici se non esistono (idempotente)
async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      email_verified BOOLEAN DEFAULT FALSE,
      password_hash TEXT NOT NULL,
      eta TEXT,
      citta TEXT,
      descrizione TEXT,
      profile_photo TEXT,
      city TEXT
    );

    CREATE TABLE IF NOT EXISTS profiles (
      username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      feedback_up INTEGER DEFAULT 0,
      feedback_down INTEGER DEFAULT 0,
      events_attended INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Nuovo utente'
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      creator TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT NOT NULL,
      description TEXT NOT NULL,
      budget NUMERIC DEFAULT 0,
      max_participants INTEGER DEFAULT 10,
      cover_photo TEXT,
      location_lat DOUBLE PRECISION,
      location_lng DOUBLE PRECISION,
      attendance_processed BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS group_participants (
      group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
      username TEXT REFERENCES users(username) ON DELETE CASCADE,
      PRIMARY KEY (group_id, username)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY,
      user_to TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      group_id TEXT,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      read BOOLEAN DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_groups_created_at
      ON groups(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_notifications_user_to
      ON notifications(user_to, timestamp DESC);
  `);
}

module.exports = { pool, query, ping, ensureSchema };
