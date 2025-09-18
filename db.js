// server/db.js
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, 'db.json');
const DB_FILE = process.env.DB_FILE || DEFAULT_PATH;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function readDB() {
  ensureDir(DB_FILE);
  if (!fs.existsSync(DB_FILE)) {
    const empty = { users: [], groups: [], notifications: [], posts: [], profiles: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { users: [], groups: [], notifications: [], posts: [], profiles: {} };
  }
}

async function writeDB(data) {
  ensureDir(DB_FILE);
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { readDB, writeDB };
