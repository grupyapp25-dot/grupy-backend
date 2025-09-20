// db_pg.js — client Postgres con forzatura IPv4 via env DATABASE_HOST4
const { Pool } = require('pg');
const dns = require('dns').promises;
const https = require('https');

const connectionString = process.env.DATABASE_URL;
const hostOverride = process.env.DATABASE_HOST4 || ''; // <- NUOVO (env su Render)

// Parse minimale dell'URL (senza librerie extra)
function parsePgUrl(url) {
  // postgresql://user:pass@host:port/db?sslmode=require
  const m = url.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:/?]+):?(\d+)?\/([^?]+)(?:\?(.+))?$/i);
  if (!m) throw new Error('DATABASE_URL non valido');
  const [, user, password, host, port, database, query] = m;
  const params = new URLSearchParams(query || '');
  const sslmode = params.get('sslmode');
  return {
    user, password,
    host,
    port: port ? Number(port) : 5432,
    database,
    ssl: sslmode === 'require' || sslmode === 'verify-full' ? { rejectUnauthorized: false } : false
  };
}

function buildPoolConfig() {
  if (!connectionString) throw new Error('DATABASE_URL non impostata');
  const base = parsePgUrl(connectionString);

  // Se c’è un IPv4 forzato in env, usiamolo al posto del nome host
  if (hostOverride) {
    console.log('🌐 Using DATABASE_HOST4 override:', hostOverride);
    return {
      user: base.user,
      password: base.password,
      host: hostOverride,      // <-- Forziamo IPv4
      port: base.port,
      database: base.database,
      ssl: base.ssl,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    };
  }

  // Altrimenti config standard (potrebbe ricadere su IPv6 -> vedi soluzione robusta dopo)
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

module.exports = { pool, query, ping };
