// db_pg.js — client Postgres per Supabase (Render richiede SSL)
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

// Log di debug: mostra solo un’anteprima e maschera la password
if (!connectionString) {
  console.error('❌ DATABASE_URL non impostata nelle env vars');
} else {
  const masked = connectionString.replace(/:[^@]+@/, ':****@');
  console.log('🧪 db_pg.js sees DATABASE_URL =', masked);
}

const pool = new Pool({
  connectionString,
  // Per Supabase su Render serve SSL; rejectUnauthorized:false evita problemi di CA
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
    console.error('❌ DB ping error:', e.message || e);
    if (e.code) console.error('PG code:', e.code);
    if (e.detail) console.error('PG detail:', e.detail);
    if (e.hint) console.error('PG hint:', e.hint);
    throw e; // Rilancia per farlo propagare all’endpoint
  }
}

module.exports = { pool, query, ping };
