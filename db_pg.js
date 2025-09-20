// db_pg.js — client Postgres per Supabase (forza IPv4 su Render)
const { Pool } = require('pg');
const dns = require('dns');

// Leggiamo la DATABASE_URL e facciamo un piccolo mask solo per i log
const raw = process.env.DATABASE_URL || '';
const masked = raw
  ? raw.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/, '$1****$2')
  : '(undefined)';
console.log('🧪 db_pg.js sees DATABASE_URL =', masked);

// Parser robusto per DATABASE_URL
function parseDbUrl(dbUrl) {
  try {
    const u = new URL(dbUrl); // es: postgresql://user:pass@host:5432/db?sslmode=require

    // NOTA: la spec corretta del protocollo è "postgresql:" o "postgres:"
    if (!/^postgres(ql)?:$/.test(u.protocol)) {
      throw new Error('Protocollo non postgres/postgresql');
    }

    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      database: u.pathname ? u.pathname.replace(/^\//, '') : 'postgres',
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      ssl: (u.searchParams.get('sslmode') || '').toLowerCase() === 'require',
    };
  } catch (e) {
    console.error('❌ DATABASE_URL non è un URL valido:', e.message);
    return null;
  }
}

const parsed = parseDbUrl(raw);
console.log('🧪 PG config:', {
  host: parsed?.host || 'invalid',
  port: parsed?.port,
  database: parsed?.database || 'invalid',
  user: parsed?.user ? '(present)' : '(missing)',
  ssl: parsed?.ssl ? 'on' : 'off',
});

let pool;

// Costruiamo il Pool **forzando IPv4**
async function buildPool() {
  if (!parsed) throw new Error('DATABASE_URL non valida');

  let ipv4Host = parsed.host;

  try {
    // Risolviamo a IPv4 (A record)
    const addrs = await new Promise((resolve, reject) =>
      dns.resolve4(parsed.host, (err, addresses) => (err ? reject(err) : resolve(addresses)))
    );
    if (Array.isArray(addrs) && addrs.length > 0) {
      ipv4Host = addrs[0];
      console.log(`🌐 DNS resolve4(${parsed.host}) -> ${ipv4Host}`);
    } else {
      console.warn(`⚠️  Nessun A-record IPv4 per ${parsed.host}, uso hostname come fallback`);
    }
  } catch (e) {
    console.warn(`⚠️  resolve4 fallita per ${parsed.host}: ${e.message}. Uso hostname come fallback`);
  }

  pool = new Pool({
    host: ipv4Host,                 // IPv4 forzato
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    ssl: parsed.ssl ? { rejectUnauthorized: false } : false,
    // timeouts più “sicuri”
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    max: 5,
  });

  // test connessione immediato per fallire presto se c'è un problema
  const client = await pool.connect();
  client.release();
  console.log('✅ Pool Postgres pronto');
}

// Helper generico per query
async function query(text, params) {
  if (!pool) await buildPool();
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
    console.error('❌ DB ping error:', e);
    if (e.code) console.error('PG code:', e.code);
    throw e;
  }
}

module.exports = { pool: () => pool, query, ping };
