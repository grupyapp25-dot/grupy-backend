// db.js — storage JSON robusto su file (funziona anche su Render - FS effimero)
const fs = require('fs');
const path = require('path');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DB_DIR, 'db.json');

const DEFAULT_DB = {
  users: [],
  groups: [],
  notifications: [],
  profiles: {},
  posts: []
};

function ensureDirFile() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    }
  } catch (e) {
    console.error('❌ Impossibile creare DB file:', e);
    throw e;
  }
}

function safeHydrate(obj) {
  const d = obj && typeof obj === 'object' ? obj : {};
  return {
    users: Array.isArray(d.users) ? d.users : [],
    groups: Array.isArray(d.groups) ? d.groups : [],
    notifications: Array.isArray(d.notifications) ? d.notifications : [],
    profiles: d.profiles && typeof d.profiles === 'object' ? d.profiles : {},
    posts: Array.isArray(d.posts) ? d.posts : []
  };
}

async function readDB() {
  ensureDirFile();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    if (!raw || raw.trim() === '') {
      // file vuoto -> reset
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
      return { ...DEFAULT_DB };
    }
    const parsed = JSON.parse(raw);
    return safeHydrate(parsed);
  } catch (e) {
    // file corrotto -> resetta e riparti pulito
    console.error('⚠️  DB JSON corrotto; reset:', e.message);
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    return { ...DEFAULT_DB };
  }
}

async function writeDB(db) {
  ensureDirFile();
  const data = safeHydrate(db);
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  return true;
}

module.exports = { readDB, writeDB, DB_DIR, DB_FILE };
