// db_pg.js — client Postgres per Supabase (Render richiede SSL)
const { Pool } = require('pg');

// Prendi la connessione dalle env
let raw = process.env.DATABASE_URL || '';

const masked = raw ? raw.replace(/:[^@]+@/, ':****@') : '(undefined)';
console.log('🧪 db_pg.js sees DATABASE_URL =', masked);

// Normalizza: pg è più felice con lo schema "postgres://" invece di "postgresql://"
if (raw && raw.startsWith('postgresql://')) {
  raw = 'postgres://' + raw.slice('postgresql://'.length);
}

// (opzionale ma utile) Se la password contiene caratteri speciali (come @) e NON è url-encoded,
// puoi forzare l’encoding automaticamente. Nel tuo caso è già %40, quindi non dovrebbe servire.
// Lascio comunque il fix: se trovi un "@" PRIMA della @ del dominio, facciamo encode della password.
try {
  const u = new URL(raw);
  // Se nello username:password esiste un '@' non codificato, lo sistemiamo
  if (u.password && /@/.test(decodeURIComponent(u.password))) {
    u.password = encodeURIComponent(decodeURIComponent(u.password));
    raw = u.toString();
  }
} catch (_) {
  // Se raw non è un URL valido, lasciamo com’è; ci penserà il log del ping a dircelo
}

const pool = new Pool({
  connectionString: raw,
  // Render + Supabase: serve SSL
  ssl: { rejectUnauthorized: false },
});

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
