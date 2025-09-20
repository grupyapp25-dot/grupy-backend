// db_pg.js — client Postgres per Supabase (Render richiede SSL)
const { Pool } = require('pg');

let raw = process.env.DATABASE_URL || '';

if (!raw) {
  console.error('❌ DATABASE_URL non impostata nelle env vars');
}

// Log mascherato (solo diagnostica)
const masked = raw ? raw.replace(/:[^@]+@/, ':****@') : '(undefined)';
console.log('🧪 db_pg.js sees DATABASE_URL =', masked);

// 1) Normalizza schema: "postgresql://" -> "postgres://"
if (raw && raw.startsWith('postgresql://')) {
  raw = 'postgres://' + raw.slice('postgresql://'.length);
}

let cfg;
try {
  // 2) Parsiamo noi l’URL in modo robusto
  const u = new URL(raw);

  // Nota: pathname è tipo "/postgres" -> togliamo lo slash iniziale
  const database = u.pathname ? u.pathname.replace(/^\//, '') : undefined;

  cfg = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    // 3) SSL per Render+Supabase
    ssl: { rejectUnauthorized: false },
  };
} catch (e) {
  console.error('❌ DATABASE_URL non è un URL valido:', e.message || e);
  // Metto una cfg che fallirà subito ma con errore chiaro
  cfg = { host: 'invalid', database: 'invalid', user: 'invalid', password: 'invalid' };
}

// (log mini utile per debugging — senza password)
console.log('🧪 PG config:', {
  host: cfg.host,
  port: cfg.port,
  database: cfg.database,
  user: cfg.user ? '(present)' : '(empty)',
  ssl: cfg.ssl ? 'on' : 'off',
});

const pool = new Pool(cfg);

// Helper generico per query
async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// Ping usato da /health/db
async function ping() {
  try {
    const res = await query('select 1 as ok');
    return res.rows?.[0]?.ok === 1;
  } catch (e) {
    console.error('❌ DB ping error:', e && e.message ? e.message : e);
    if (e && e.code) console.error('PG code:', e.code);
    if (e && e.detail) console.error('PG detail:', e.detail);
    if (e && e.hint) console.error('PG hint:', e.hint);
    throw e;
  }
}

module.exports = { pool, query, ping };
