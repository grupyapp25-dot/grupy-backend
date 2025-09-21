require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { readDB, writeDB } = require('./db');
const dbpg = require('./db_pg'); // client Postgres opzionale (health/info)

// ✨ NEW: mailer per invio email
const { sendMail } = require('./utils/mailer');

// --- DEBUG ENV (puoi rimuovere quando vuoi) ---
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

// ---------- HEALTH DB (Postgres) ----------
app.get('/health/db', async (req, res) => {
  try {
    const ok = await dbpg.ping();
    res.json({ ok: true, db: ok ? 'connected' : 'unknown' });
  } catch (e) {
    console.error('DB health error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Info DB Postgres
app.get('/health/db-info', async (req, res) => {
  try {
    const r = await dbpg.query('select now() as now, version() as pg');
    res.json({ ok: true, now: r.rows[0].now, version: r.rows[0].pg });
  } catch (e) {
    console.error('DB info error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- HEALTH DB FILE (JSON su FS) ----------
app.get('/health/db-file', async (_req, res) => {
  try {
    const db = await readDB();
    res.json({
      ok: true,
      usersCount: db.users.length,
      groupsCount: db.groups.length,
      profilesCount: Object.keys(db.profiles).length,
      postsCount: db.posts.length
    });
  } catch (e) {
    console.error('DB FILE health error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- AUTH ----------

// ✨ NEW: controllo disponibilità username
app.get('/api/users/check-username', async (req, res) => {
  try {
    const { username } = req.query || {};
    if (!username) return res.status(400).json({ available: false, error: 'username mancante' });
    const db = await readDB();
    const exists = db.users.some(u => u.username.toLowerCase() === String(username).toLowerCase());
    res.json({ available: !exists });
  } catch (e) {
    console.error('CHECK USERNAME error:', e);
    res.status(500).json({ available: true, error: 'server' });
  }
});

app.post('/api/users/register', async (req, res) => {
  try {
    const { username, password, email } = req.body || {};
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
      // ✨ NEW: memorizziamo anche l'email se fornita
      email: email || '',
      eta: '',
      citta: '',
      descrizione: '',
      profilePhoto: null,
      city: ''
    };
    db.users.push(user);

    if (!db.profiles[username]) {
      db.profiles[username] = {
        feedback: { up: 0, down: 0 },
        eventsAttended: 0,
        status: 'Nuovo utente'
      };
    }

    await writeDB(db);

    const token = signToken({ id: user.id, username: user.username });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email || '',
        profilePhoto: user.profilePhoto,
        city: user.city
      }
    });
  } catch (e) {
    console.error('REGISTER error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
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
        email: user.email || '',
        profilePhoto: user.profilePhoto,
        city: user.city,
        eta: user.eta || '',
        citta: user.citta || '',
        descrizione: user.descrizione || ''
      }
    });
  } catch (e) {
    console.error('LOGIN error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.get('/api/users/me', auth, async (req, res) => {
  try {
    const db = await readDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const profile = db.profiles[user.username] || { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };
    res.json({ user, profile });
  } catch (e) {
    console.error('ME error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// aggiorna dati profilo base (eta, citta, descrizione, profilePhoto url, city, email)
app.put('/api/users/me', auth, async (req, res) => {
  try {
    const { eta, citta, descrizione, profilePhoto, city, email } = req.body || {};
    const db = await readDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (eta !== undefined) user.eta = eta;
    if (citta !== undefined) user.citta = citta;
    if (descrizione !== undefined) user.descrizione = descrizione;
    if (profilePhoto !== undefined) user.profilePhoto = profilePhoto;
    if (city !== undefined) user.city = city;
    // ✨ NEW: permettiamo di salvare/aggiornare l'email
    if (email !== undefined) user.email = email;
    await writeDB(db);
    res.json({ ok: true, user });
  } catch (e) {
    console.error('UPDATE ME error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// ✨ NEW: invio email di conferma
app.post('/api/users/send-confirmation', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email mancante' });

    await sendMail({
      to: email,
      subject: 'Conferma la tua email - Grupy',
      text: 'Ciao! Abbiamo registrato il tuo account su Grupy. Controlla la tua casella email.',
      html: '<h2>Benvenuto in Grupy 🎉</h2><p>Abbiamo inviato una mail di conferma: controlla la tua casella di posta (anche spam).</p>',
    });

    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('send-confirmation error:', err);
    res.status(500).json({ ok: false, error: 'Invio email fallito' });
  }
});

// ---------- GROUPS ----------
app.get('/api/groups', auth, async (req, res) => {
  try {
    const db = await readDB();
    res.json(db.groups);
  } catch (e) {
    console.error('GET GROUPS error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups', auth, async (req, res) => {
  try {
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
  } catch (e) {
    console.error('CREATE GROUP error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/join', auth, async (req, res) => {
  try {
    const db = await readDB();
    const g = db.groups.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Gruppo non trovato' });
    if (g.participants.includes(req.user.username)) return res.json(g);
    if (g.participants.length >= g.maxParticipants) return res.status(400).json({ error: 'Gruppo completo' });
    g.participants.push(req.user.username);
    await writeDB(db);
    res.json(g);
  } catch (e) {
    console.error('JOIN GROUP error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/leave', auth, async (req, res) => {
  try {
    const db = await readDB();
    const g = db.groups.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Gruppo non trovato' });
    g.participants = g.participants.filter(u => u !== req.user.username);
    await writeDB(db);
    res.json(g);
  } catch (e) {
    console.error('LEAVE GROUP error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// ---------- NOTIFICATIONS ----------
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const db = await readDB();
    const mine = db.notifications
      .filter(n => n.user === req.user.username)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(mine);
  } catch (e) {
    console.error('GET NOTIFICATIONS error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/notifications/mark-read', auth, async (req, res) => {
  try {
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
  } catch (e) {
    console.error('MARK READ error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// ---------- VOTI post-evento ----------
app.post('/api/groups/:id/votes', auth, async (req, res) => {
  try {
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
  } catch (e) {
    console.error('VOTES error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// ---------- JOB: scadenza eventi + invio richieste voto ----------
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

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`✅ Server avviato su http://localhost:${PORT}`);
});
