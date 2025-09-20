// db_pg.js — client Postgres per Supabase (Render richiede SSL)
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
// Per Supabase su Render: serve SSL con rejectUnauthorized:false
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// comodo helper
async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

async function ping() {
  // una query banalissima
  const res = await query('select 1 as ok');
  return res.rows[0].ok === 1;
}

module.exports = { pool, query, ping };
