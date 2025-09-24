// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');

const { readDB, writeDB } = require('./db');
const { sendMail } = require('./utils/mailer');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

// CORS
const rawCors = String(process.env.CORS_ORIGIN || '').trim();
const ALLOWED_ORIGINS = rawCors ? rawCors.split(',').map(s => s.trim()).filter(Boolean) : [];

// URL pubblici / bridge
const BACKEND_PUBLIC_URL = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
const FRONTEND_LOGIN_URL =
  (process.env.FRONTEND_LOGIN_URL || '').replace(/\/$/, '') ||
  (PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/login` : '');
const APP_SCHEME = (process.env.APP_SCHEME || 'grupy://login').replace(/\/$/, '');
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || '';

function getSchemePrefix(s = APP_SCHEME) {
  const i = s.indexOf('://');
  if (i === -1) return 'grupy://';
  return s.slice(0, i + 3);
}
const APP_SCHEME_PREFIX = getSchemePrefix(APP_SCHEME);

const app = express();

// --------- CORS robusto ---------
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
    try {
      const { host: reqHost, protocol: reqProto } = new URL(origin);
      const ok = ALLOWED_ORIGINS.some(allowed => {
        const u = new URL(allowed);
        const allowedHost = u.host;
        const allowedProto = u.protocol;
        if (reqProto === allowedProto && reqHost === allowedHost) return true;
        const isSubdomain = reqHost.endsWith(`.${allowedHost}`);
        return reqProto === allowedProto && isSubdomain;
      });
      return ok ? callback(null, true) : callback(new Error('Not allowed by CORS'));
    } catch {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- utils ----------
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const extractEmail = (any) => {
  const s = String(any || '').trim();
  const m = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : '';
};
const getBackendBase = (req) =>
  (BACKEND_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// deep link / device detection
function detectPlatform(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  return 'web';
}
function makeAndroidIntent(deepLink, fallbackUrl) {
  const encodedFallback = encodeURIComponent(fallbackUrl);
  if (!ANDROID_PACKAGE) return deepLink;
  const scheme = deepLink.split('://')[0];
  return (
    `intent://${deepLink.replace(/^.*?:\/\//,'')}` +
    `#Intent;scheme=${scheme};package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodedFallback};end`
  );
}

// ---------- bootstrap DB ----------
async function ensureDbShape() {
  const db = await readDB();
  db.users = Array.isArray(db.users) ? db.users : [];
  db.profiles = db.profiles && typeof db.profiles === 'object' ? db.profiles : {};
  db.groups = Array.isArray(db.groups) ? db.groups : [];
  db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
  await writeDB(db);
  return db;
}

// ---------- base ----------
app.get('/', (_req, res) => res.json({ ok: true, service: 'Grupy API' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/__version', (_req, res) =>
  res.json({
    build: 'server-groups-v1',   // <— cambia qui quando redeployi
    emailRoute: '/api/users/send-confirmation',
    resetRoute: '/reset-password',
    openApp: '/open-app',
    frontendLogin: FRONTEND_LOGIN_URL || '(unset)',
    appScheme: APP_SCHEME,
    schemePrefix: APP_SCHEME_PREFIX,
  })
);

// ---------- AUTH ----------
app.post('/api/users/register', async (req, res) => {
  try {
    await ensureDbShape();
    const { username, password, email } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username e password richiesti' });

    const db = await readDB();
    if (db.users.find(u => (u.username || '').toLowerCase() === String(username).toLowerCase())) {
      return res.status(409).json({ error: 'Username già in uso' });
    }
    const user = {
      id: uuidv4(),
      username,
      email: email || '',
      emailVerified: false,
      passwordHash: await bcrypt.hash(password, 10),
      eta: '', citta: '', descrizione: '', profilePhoto: null, city: ''
    };
    db.users.push(user);
    if (!db.profiles[username]) {
      db.profiles[username] = { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };
    }
    await writeDB(db);

    const token = signToken({ id: user.id, username: user.username });
    res.json({ token, user: { id: user.id, username, email: user.email, profilePhoto: user.profilePhoto, city: user.city } });
  } catch (e) {
    console.error('REGISTER error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    await ensureDbShape();
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username e password richiesti' });

    const db = await readDB();
    const user = db.users.find(u => (u.username || '').toLowerCase() === String(username).toLowerCase());
    if (!user) return res.status(401).json({ error: 'Credenziali non valide' });

    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });

    const token = signToken({ id: user.id, username: user.username });
    res.json({
      token,
      user: {
        id: user.id, username: user.username, email: user.email,
        emailVerified: !!user.emailVerified, profilePhoto: user.profilePhoto, city: user.city,
        eta: user.eta || '', citta: user.citta || '', descrizione: user.descrizione || ''
      }
    });
  } catch (e) {
    console.error('LOGIN error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.get('/api/users/me', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const db = await readDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const profile = db.profiles[user.username] || { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };
    res.json({ user, profile });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.put('/api/users/me', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const { eta, citta, descrizione, profilePhoto, city, email } = req.body || {};
    const db = await readDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (eta !== undefined) user.eta = eta;
    if (citta !== undefined) user.citta = citta;
    if (descrizione !== undefined) user.descrizione = descrizione;
    if (profilePhoto !== undefined) user.profilePhoto = profilePhoto;
    if (city !== undefined) user.city = city;
    if (email !== undefined && isValidEmail(email)) user.email = email;
    await writeDB(db);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.get('/api/users/check-username', async (req, res) => {
  try {
    await ensureDbShape();
    const username = String(req.query?.username || '').trim();
    if (!username) return res.json({ available: false });
    const db = await readDB();
    const exists = db.users.some(u => (u.username || '').toLowerCase() === username.toLowerCase());
    res.json({ available: !exists });
  } catch {
    res.json({ available: true });
  }
});

// ---------- Email confirm ----------
app.post('/api/users/send-confirmation', async (req, res) => {
  try {
    await ensureDbShape();
    const candidates = [
      req.body?.email, req.body?.address, req.headers['x-test-email'],
      req.query?.email, typeof req.body === 'string' ? req.body : '',
    ].filter(Boolean);

    const email = extractEmail(candidates.find(v => isValidEmail(v)) || '');
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: 'email non valida o assente nel body' });
    }

    const base = getBackendBase(req);
    const token = Buffer.from(`${email}|${Date.now()}`, 'utf8').toString('base64url');
    const confirmUrl = `${base}/confirm-email?token=${encodeURIComponent(token)}`;

    const subject = 'Conferma il tuo indirizzo email';
    const html = `
      <div style="font-family:system-ui,Arial,sans-serif;line-height:1.4;max-width:520px">
        <h2>Ciao!</h2>
        <p>Per completare la verifica clicca il bottone qui sotto:</p>
        <p style="margin:20px 0">
          <a href="${confirmUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">
            Conferma email
          </a>
        </p>
        <p style="font-size:13px;color:#555">Oppure copia e incolla questo link nel browser:</p>
        <p style="word-break:break-all;font-size:13px"><a href="${confirmUrl}">${confirmUrl}</a></p>
      </div>`;
    const text = `Conferma la tua email aprendo questo link: ${confirmUrl}`;

    const info = await sendMail({ to: email, subject, html, text });
    res.json({ ok: true, sent: true, messageId: info?.messageId, confirmUrl, emailUsed: email });
  } catch (e) {
    console.error('send-confirmation error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Mailer error' });
  }
});

// open-app bridge
app.get('/open-app', (req, res) => {
  const to = String(req.query.to || '').trim();
  const fallback = String(req.query.fallback || '').trim();
  const delayMs = Number(req.query.delay || 1200);
  const safeTo = to || APP_SCHEME;
  const safeFallback = fallback || (FRONTEND_LOGIN_URL || '/');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apri l'app…</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;line-height:1.45}</style></head><body><h3>Aprendo l’app…</h3><p>Se non si apre, <a id="open" href="${safeTo}">tappa qui</a>.</p><p>Oppure <a href="${safeFallback}">vai al sito</a>.</p><script>(function(){var to=${JSON.stringify(safeTo)};var fb=${JSON.stringify(safeFallback)};try{window.location.href=to;}catch(e){}setTimeout(function(){window.location.replace(fb);},${delayMs});})();</script></body></html>`);
});

// confirm-email redirector
const confirmEmailHandler = async (req, res) => {
  const webBase =
    (FRONTEND_LOGIN_URL || (PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/login` : '')).replace(/\/$/, '');
  const webLoginUrl = webBase && /^https?:\/\//.test(webBase) ? `${webBase}` : `${getBackendBase(req)}/`;

  const mkWebWith = (qs) => {
    const url = new URL(webLoginUrl);
    for (const [k, v] of Object.entries(qs || {})) url.searchParams.set(k, String(v));
    return url.toString();
  };

  try {
    const { token } = req.query || {};
    if (!token) return res.redirect(302, mkWebWith({ emailConfirmed: 0, reason: 'missing_token' }));

    let decoded = '';
    try { decoded = Buffer.from(String(token), 'base64url').toString('utf8'); }
    catch { decoded = Buffer.from(String(token), 'base64').toString('utf8'); }

    let [email, ts] = decoded.split('|');
    ts = Number(ts || 0);
    const MAX_AGE = 3 * 24 * 60 * 60 * 1000;
    if (!email || !ts || (Date.now() - ts) > MAX_AGE) {
      return res.redirect(302, mkWebWith({ emailConfirmed: 0, reason: 'expired' }));
    }

    const db = await readDB();
    const user = db.users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase());
    if (!user) return res.redirect(302, mkWebWith({ emailConfirmed: 0, reason: 'not_found' }));
    user.emailVerified = true;
    await writeDB(db);

    const platform = detectPlatform(req);
    const deepLink = `${APP_SCHEME}?emailConfirmed=1`;

    if (platform === 'android') {
      const intentUrl = makeAndroidIntent(deepLink, mkWebWith({ emailConfirmed: 1 }));
      return res.redirect(302, intentUrl);
    }
    if (platform === 'ios') {
      const bridge = `${getBackendBase(req)}/open-app?to=${encodeURIComponent(deepLink)}&fallback=${encodeURIComponent(mkWebWith({ emailConfirmed: 1 }))}`;
      return res.redirect(302, bridge);
    }
    return res.redirect(302, mkWebWith({ emailConfirmed: 1 }));
  } catch (e) {
    console.error('confirm-email error:', e);
    return res.redirect(302, '/');
  }
};
app.get(['/api/users/confirm-email', '/confirm-email'], confirmEmailHandler);

// ---------- Password reset ----------
app.post('/api/users/password/request', async (req, res) => {
  try {
    await ensureDbShape();
    const email = extractEmail(req.body?.email || '');
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Email non valida' });

    const token = Buffer.from(`${email}|${Date.now()}`, 'utf8').toString('base64url');
    const base = getBackendBase(req);
    const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;

    try {
      await sendMail({
        to: email,
        subject: 'Reimposta la tua password',
        text: `Apri questo link per reimpostare la password: ${resetUrl}`,
        html: `<p>Clicca per reimpostare la password:</p>
               <p><a href="${resetUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Reimposta password</a></p>
               <p>Oppure copia/incolla: <br><a href="${resetUrl}">${resetUrl}</a></p>`,
      });
      return res.json({ ok: true });
    } catch (mailErr) {
      console.warn('Mailer non configurato o errore invio:', mailErr?.message);
      return res.json({ ok: true, devResetUrl: resetUrl });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/users/password/reset', async (req, res) => {
  try {
    await ensureDbShape();
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Token o password non validi' });
    }
    let decoded = '';
    try { decoded = Buffer.from(String(token), 'base64url').toString('utf8'); }
    catch { decoded = Buffer.from(String(token), 'base64').toString('utf8'); }
    let [email, ts] = decoded.split('|');
    ts = Number(ts || 0);
    if (!email || !ts || (Date.now() - ts) > (24 * 60 * 60 * 1000)) {
      return res.status(400).json({ error: 'Token scaduto o non valido' });
    }

    const db = await readDB();
    const user = db.users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase());
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });

    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// Bridge: /reset-password → deep link app (grupy://forgot?token=...)
app.get('/reset-password', (req, res) => {
  try {
    const token = String(req.query?.token || '').trim();
    if (!token) return res.status(400).send('Missing token');

    const deepLink = `${APP_SCHEME_PREFIX}forgot?token=${encodeURIComponent(token)}`;
    const fallbackWeb =
      (FRONTEND_LOGIN_URL || (PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/login` : '')) ||
      `${getBackendBase(req)}/`;

    const platform = detectPlatform(req);
    if (platform === 'android') {
      const intentUrl = makeAndroidIntent(deepLink, fallbackWeb);
      return res.redirect(302, intentUrl);
    }
    if (platform === 'ios') {
      const bridge = `${getBackendBase(req)}/open-app?to=${encodeURIComponent(deepLink)}&fallback=${encodeURIComponent(fallbackWeb)}`;
      return res.redirect(302, bridge);
    }
    return res.redirect(302, fallbackWeb);
  } catch {
    return res.status(400).send('Invalid reset link');
  }
});

// ---------- GROUPS & NOTIFICATIONS ----------
function computeHasExpired(g) {
  if (!g?.date || !g?.time) return false;
  const ts = Date.parse(`${g.date}T${g.time}:00`);
  if (Number.isNaN(ts)) return false;
  return Date.now() > ts;
}
function pickGroupForClient(g) {
  return {
    id: g.id, creator: g.creator, createdAt: g.createdAt,
    name: g.name, category: g.category, date: g.date, time: g.time,
    city: g.city, address: g.address, description: g.description,
    budget: g.budget, maxParticipants: g.maxParticipants,
    coverPhoto: g.coverPhoto || null, participants: g.participants || [],
    location: g.location || null, hasExpired: computeHasExpired(g),
    attendanceProcessed: !!g.attendanceProcessed, voteRequestsSent: g.voteRequestsSent || {},
  };
}

app.get('/api/groups', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const db = await readDB();
    const list = (db.groups || [])
      .map(pickGroupForClient)
      .sort((a,b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const {
      name, category, date, time, city, address, description,
      budget = 0, maxParticipants = 10, coverPhoto = null, location = null,
    } = req.body || {};

    if (!name || !category || !date || !time || !city || !address || !description) {
      return res.status(400).json({ error: 'Campi richiesti mancanti' });
    }

    const db = await readDB();
    const g = {
      id: Date.now().toString(),
      creator: req.user.username,
      createdAt: new Date().toISOString(),
      name, category, date, time, city, address, description,
      budget: Number(budget) || 0,
      maxParticipants: Number(maxParticipants) || 10,
      coverPhoto,
      participants: [req.user.username],
      location,
      attendanceProcessed: false,
      voteRequestsSent: {},
    };
    db.groups.unshift(g);

    db.notifications.unshift({
      id: uuidv4(),
      user: req.user.username,
      type: 'info',
      message: `Hai creato il gruppo "${name}"`,
      groupId: g.id,
      timestamp: new Date().toISOString(),
      read: false,
    });

    await writeDB(db);
    res.status(201).json(pickGroupForClient(g));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/join', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const db = await readDB();
    const g = db.groups.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (!Array.isArray(g.participants)) g.participants = [];
    if (!g.participants.includes(req.user.username)) {
      if (g.participants.length >= (g.maxParticipants || 10)) {
        return res.status(400).json({ error: 'Gruppo completo' });
      }
      g.participants.push(req.user.username);
    }

    if (req.user.username !== g.creator) {
      db.notifications.unshift({
        id: uuidv4(),
        user: g.creator,
        type: 'info',
        message: `${req.user.username} si è unito al tuo gruppo "${g.name}"`,
        groupId: g.id,
        timestamp: new Date().toISOString(),
        read: false,
      });
    }

    await writeDB(db);
    res.json({ ok: true, group: pickGroupForClient(g) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/leave', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const db = await readDB();
    const g = db.groups.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Group not found' });

    if (g.creator === req.user.username) {
      return res.status(400).json({ error: 'Il creatore non può lasciare il proprio gruppo' });
    }
    g.participants = (g.participants || []).filter(u => u !== req.user.username);

    await writeDB(db);
    res.json({ ok: true, group: pickGroupForClient(g) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/remove-participant', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username richiesto' });

    const db = await readDB();
    const g = db.groups.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (g.creator !== req.user.username) {
      return res.status(403).json({ error: 'Solo il creatore può rimuovere partecipanti' });
    }
    if (username === g.creator) {
      return res.status(400).json({ error: 'Non puoi rimuovere il creatore' });
    }

    const down = db.profiles?.[username]?.feedback?.down || 0;
    if (down <= 0) {
      return res.status(400).json({ error: 'Il partecipante non ha feedback negativo' });
    }

    g.participants = (g.participants || []).filter(u => u !== username);
    db.notifications.unshift({
      id: uuidv4(),
      user: username,
      type: 'info',
      message: `Sei stato rimosso dal gruppo "${g.name}"`,
      groupId: g.id,
      timestamp: new Date().toISOString(),
      read: false,
    });

    await writeDB(db);
    res.json({ ok: true, group: pickGroupForClient(g) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/votes', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const { votes = {} } = req.body || {};
    const db = await readDB();
    const g = db.groups.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Group not found' });

    Object.entries(votes).forEach(([target, val]) => {
      if (!target || target === req.user.username) return;
      const v = Number(val);
      if (v !== 1 && v !== -1) return;
      if (!db.profiles[target]) {
        db.profiles[target] = { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };
      }
      if (v === 1) db.profiles[target].feedback.up = (db.profiles[target].feedback.up || 0) + 1;
      if (v === -1) db.profiles[target].feedback.down = (db.profiles[target].feedback.down || 0) + 1;
    });

    await writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// ---------- NOTIFICATIONS ----------
app.get('/api/notifications', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const db = await readDB();
    const mine = (db.notifications || []).filter(n => n.user === req.user.username)
      .sort((a,b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
    res.json(mine);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/notifications/mark-read', auth, async (req, res) => {
  try {
    await ensureDbShape();
    const { id, all } = req.body || {};
    const db = await readDB();
    db.notifications = (db.notifications || []).map(n => {
      if (n.user !== req.user.username) return n;
      if (all) return { ...n, read: true };
      if (id && n.id === id) return { ...n, read: true };
      return n;
    });
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// ---------- UPLOAD ----------
const UPLOAD_DIR = '/tmp/uploads';
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  },
});
const upload = multer({ storage: multerStorage });
app.use('/uploads', express.static(UPLOAD_DIR));
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`✅ Server avviato su http://localhost:${PORT}`);
});
