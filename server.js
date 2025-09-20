require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { readDB, writeDB } = require('./db');
const dbpg = require('./db_pg'); // <— nuovo

// --- DEBUG ENV (rimuovi dopo la diagnosi) ---
const rawConn = process.env.DATABASE_URL || '';
const maskedConn = rawConn
  ? rawConn.replace(/:[^@]+@/, ':****@').slice(0, 120) + (rawConn.length > 120 ? '…' : '')
  : '(undefined)';
console.log('🔧 DATABASE_URL at startup =', maskedConn);


const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '5mb' }));

// ---------- utils ----------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}



function computeStatus(profile) {
  const attended = profile.eventsAttended || 0;
  const up = profile.feedback?.up || 0;
  const down = profile.feedback?.down || 0;
  const total = up + down;
  const pct = total > 0 ? Math.round((up / total) * 100) : 0;
  if (attended > 10 && pct >= 80) return 'Utente esperto';
  if (attended > 5) return 'Utente puntuale';
  return 'Nuovo utente';
}

// ---------- base ----------
app.get('/', (req, res) => res.json({ ok: true, service: 'Grupy API' }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/env-check', (req, res) => {
  const raw = process.env.DATABASE_URL || '';
  const masked = raw ? raw.replace(/:[^@]+@/, ':****@') : '(undefined)';
  res.json({ has_DATABASE_URL: !!raw, DATABASE_URL_preview: masked });
});

// ---------- AUTH ----------
app.post('/api/users/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username e password richiesti' });

  const db = await readDB();
  if (db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase())) {
    return res.status(409).json({ error: 'Username già in uso' });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    passwordHash: hash,
    eta: '',
    citta: '',
    descrizione: '',
    profilePhoto: null,
    city: ''
  };
  db.users.push(user);

  // profilo aggregato feedback
  if (!db.profiles[username]) {
    db.profiles[username] = {
      feedback: { up: 0, down: 0 },
      eventsAttended: 0,
      status: 'Nuovo utente'
    };
  }

  await writeDB(db);

  const token = signToken({ id: user.id, username: user.username });
  res.json({ token, user: { id: user.id, username: user.username, profilePhoto: user.profilePhoto, city: user.city } });
});

app.post('/api/users/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username e password richiesti' });

  const db = await readDB();
  const user = db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });

  const ok = await bcrypt.compare(password, user.passwordHash || '');
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });

  const token = signToken({ id: user.id, username: user.username });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      profilePhoto: user.profilePhoto,
      city: user.city,
      eta: user.eta || '',
      citta: user.citta || '',
      descrizione: user.descrizione || ''
    }
  });
});

app.get('/api/users/me', auth, async (req, res) => {
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const profile = db.profiles[user.username] || { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };
  res.json({ user, profile });
});

// aggiorna dati profilo base (eta, citta, descrizione, profilePhoto url)
app.put('/api/users/me', auth, async (req, res) => {
  const { eta, citta, descrizione, profilePhoto, city } = req.body || {};
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (eta !== undefined) user.eta = eta;
  if (citta !== undefined) user.citta = citta;
  if (descrizione !== undefined) user.descrizione = descrizione;
  if (profilePhoto !== undefined) user.profilePhoto = profilePhoto;
  if (city !== undefined) user.city = city;
  await writeDB(db);
  res.json({ ok: true, user });
});

// ---------- GROUPS ----------
app.get('/api/groups', auth, async (req, res) => {
  const db = await readDB();
  res.json(db.groups);
});

app.post('/api/groups', auth, async (req, res) => {
  const { name, category, date, time, city, address, description, budget, maxParticipants, coverPhoto, location } = req.body || {};
  if (!name || !category || !date || !time || !city || !address || !description || budget === undefined || !maxParticipants || !location) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  }
  const db = await readDB();
  const group = {
    id: uuidv4(),
    name, category, date, time, city, address, description,
    budget: Number(budget),
    maxParticipants: Number(maxParticipants),
    coverPhoto: coverPhoto || null,
    location,
    creator: req.user.username,
    participants: [req.user.username],
    createdAt: new Date().toISOString(),
    attendanceProcessed: false,
    voteRequestsSent: {}, // { [username]: true }
    hasExpired: false
  };
  db.groups.push(group);
  await writeDB(db);
  res.json(group);
});

app.post('/api/groups/:id/join', auth, async (req, res) => {
  const db = await readDB();
  const g = db.groups.find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Gruppo non trovato' });
  if (g.participants.includes(req.user.username)) return res.json(g);
  if (g.participants.length >= g.maxParticipants) return res.status(400).json({ error: 'Gruppo completo' });
  g.participants.push(req.user.username);
  await writeDB(db);
  res.json(g);
});

app.post('/api/groups/:id/leave', auth, async (req, res) => {
  const db = await readDB();
  const g = db.groups.find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Gruppo non trovato' });
  g.participants = g.participants.filter(u => u !== req.user.username);
  await writeDB(db);
  res.json(g);
});

// ---------- NOTIFICATIONS ----------
app.get('/api/notifications', auth, async (req, res) => {
  const db = await readDB();
  const mine = db.notifications
    .filter(n => n.user === req.user.username)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(mine);
});

app.post('/api/notifications/mark-read', auth, async (req, res) => {
  const { id, all } = req.body || {};
  const db = await readDB();
  if (all) {
    db.notifications.forEach(n => {
      if (n.user === req.user.username) n.read = true;
    });
  } else if (id) {
    const n = db.notifications.find(n => n.id === id && n.user === req.user.username);
    if (n) n.read = true;
  }
  await writeDB(db);
  res.json({ ok: true });
});

// ---------- VOTI post-evento ----------
app.post('/api/groups/:id/votes', auth, async (req, res) => {
  // body: { votes: { [username]: -1|0|1 }, imageUrl?: string }
  const { votes = {}, imageUrl } = req.body || {};
  const db = await readDB();
  const g = db.groups.find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Gruppo non trovato' });

  // aggiorna feedback per ciascun utente votato
  Object.entries(votes).forEach(([name, val]) => {
    if (!db.profiles[name]) {
      db.profiles[name] = { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };
    }
    if (val === 1) db.profiles[name].feedback.up += 1;
    if (val === -1) db.profiles[name].feedback.down += 1;
    db.profiles[name].status = computeStatus(db.profiles[name]);
  });

  // se c'è una foto, crea un post (semplice)
  if (imageUrl) {
    db.posts.push({
      id: uuidv4(),
      type: 'photo',
      text: `Foto evento: ${g.name}`,
      image: imageUrl,
      likes: 0,
      likedBy: [],
      comments: [],
      username: req.user.username,
      createdAt: new Date().toISOString()
    });
  }

  await writeDB(db);
  res.json({ ok: true });
});

// ---------- JOB: scadenza eventi + invio richieste voto ----------
// Ogni 5 minuti controlla i gruppi scaduti -> dopo 24h invia notifica "vote_request" a chi non l'ha ancora ricevuta.
cron.schedule('*/5 * * * *', async () => {
  const db = await readDB();
  const now = new Date();

  for (const g of db.groups) {
    const eventDate = new Date(`${g.date}T${g.time}:00`);
    // aggiorna hasExpired
    g.hasExpired = eventDate < now;

    // appena passata la data: incrementa partecipazioni (una volta sola)
    if (!g.attendanceProcessed && now > eventDate) {
      g.attendanceProcessed = true;
      g.participants.forEach(name => {
        if (!db.profiles[name]) {
          db.profiles[name] = { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };
        }
        db.profiles[name].eventsAttended = (db.profiles[name].eventsAttended || 0) + 1;
        db.profiles[name].status = computeStatus(db.profiles[name]);
      });
    }

    // dopo 24 ore manda le notifiche di voto (una per utente)
    const msDiff = now - eventDate;
    if (msDiff >= 24 * 60 * 60 * 1000) {
      g.voteRequestsSent = g.voteRequestsSent || {};
      for (const p of g.participants) {
        if (!g.voteRequestsSent[p]) {
          db.notifications.push({
            id: uuidv4(),
            user: p,
            type: 'vote_request',
            message: `Vota i partecipanti di "${g.name}" e carica una foto dell'evento`,
            groupId: g.id,
            groupData: {
              id: g.id,
              name: g.name,
              date: g.date,
              time: g.time,
              city: g.city,
              address: g.address
            },
            read: false,
            timestamp: new Date().toISOString()
          });
          g.voteRequestsSent[p] = true;
        }
      }
    }
  }

  await writeDB(db);
  console.log('🕒 job: controllo eventi e notifiche voto OK');
});
app.get('/health/db', async (req, res) => {
  try {
    const ok = await dbpg.ping();
    res.json({ ok: true, db: ok ? 'connected' : 'unknown' });
  } catch (e) {
    console.error('DB health error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// --- subito sotto gli altri endpoint /health
app.get('/health/db-info', async (req, res) => {
  try {
    const r = await dbpg.query('select now() as now, version() as pg');
    res.json({ ok: true, now: r.rows[0].now, version: r.rows[0].pg });
  } catch (e) {
    console.error('DB info error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`✅ Server avviato su http://localhost:${PORT}`);
});
// === UPLOAD IMMAGINI (Render: storage effimero in /tmp) ===
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = '/tmp/uploads';
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  },
});
const upload = multer({ storage });

// Servi i file caricati
app.use('/uploads', express.static(UPLOAD_DIR));

// Endpoint di upload (campo "file")
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

