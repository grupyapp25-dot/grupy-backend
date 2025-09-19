// db.js
const fs = require('fs').promises;
const path = require('path');

// Usa /tmp su Render, altrimenti locale db.json
const DATA_FILE = process.env.DATA_FILE || (
  process.env.RENDER ? '/tmp/db.json' : path.join(__dirname, 'db.json')
);

// Struttura iniziale del “DB”
const INITIAL_DB = {
  users: [],
  groups: [],
  notifications: [],
  profiles: {},   // { [username]: { feedback:{up,down}, eventsAttended, status } }
  posts: []       // feed locale (foto/testi) se usi anche questa parte
};

async function ensureFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    // se non esiste, crealo con contenuto iniziale
    await fs.writeFile(DATA_FILE, JSON.stringify(INITIAL_DB, null, 2), 'utf8');
  }
}

async function readDB() {
  await ensureFile();
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const json = JSON.parse(raw);
    // fallback in caso di file vuoto o corrotto
    return {
      users: Array.isArray(json.users) ? json.users : [],
      groups: Array.isArray(json.groups) ? json.groups : [],
      notifications: Array.isArray(json.notifications) ? json.notifications : [],
      profiles: typeof json.profiles === 'object' && json.profiles ? json.profiles : {},
      posts: Array.isArray(json.posts) ? json.posts : []
    };
  } catch (e) {
    // se parse fallisce, riparti pulito
    await fs.writeFile(DATA_FILE, JSON.stringify(INITIAL_DB, null, 2), 'utf8');
    return { ...INITIAL_DB };
  }
}

async function writeDB(db) {
  const safe = {
    users: Array.isArray(db.users) ? db.users : [],
    groups: Array.isArray(db.groups) ? db.groups : [],
    notifications: Array.isArray(db.notifications) ? db.notifications : [],
    profiles: typeof db.profiles === 'object' && db.profiles ? db.profiles : {},
    posts: Array.isArray(db.posts) ? db.posts : []
  };
  await fs.writeFile(DATA_FILE, JSON.stringify(safe, null, 2), 'utf8');
}

module.exports = { readDB, writeDB, DATA_FILE };
