// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');

const { pool, ensureSchema } = require('./db-pg');       // <-- Postgres
const { sendMail } = require('./utils/mailer');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

const rawCors = String(process.env.CORS_ORIGIN || '').trim();
const ALLOWED_ORIGINS = rawCors ? rawCors.split(',').map(s => s.trim()).filter(Boolean) : [];

const BACKEND_PUBLIC_URL = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
const FRONTEND_LOGIN_URL =
  (process.env.FRONTEND_LOGIN_URL || '').replace(/\/$/, '') ||
  (PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/login` : '');
const APP_SCHEME = (process.env.APP_SCHEME || 'grupy://login').replace(/\/$/, '');
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || '';

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
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }
}

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
function getSchemePrefix(s = APP_SCHEME) {
  const i = s.indexOf('://');
  return i === -1 ? 'grupy://' : s.slice(0, i + 3);
}
const APP_SCHEME_PREFIX = getSchemePrefix(APP_SCHEME);

// ---------- Avvio: crea schema se manca ----------
ensureSchema()
  .then(() => console.log('🗄️  Postgres schema OK'))
  .catch((e) => { console.error('Schema init error:', e); process.exit(1); });

// ---------- base ----------
app.get('/', (_req, res) => res.json({ ok: true, service: 'Grupy API (pg)' }));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});
app.get('/__version', (_req, res) =>
  res.json({
    build: 'server-pg-v1',
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
    const { username, password, email } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username e password richiesti' });

    const exist = await pool.query('SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (exist.rowCount > 0) return res.status(409).json({ error: 'Username già in uso' });

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(`
      INSERT INTO users (id, username, email, email_verified, password_hash, eta, citta, descrizione, profile_photo, city)
      VALUES ($1,$2,$3,false,$4,'','','',NULL,'')
    `, [id, username, email || '', passwordHash]);

    await pool.query(`
      INSERT INTO profiles (username, feedback_up, feedback_down, events_attended, status)
      VALUES ($1,0,0,0,'Nuovo utente')
      ON CONFLICT (username) DO NOTHING
    `, [username]);

    const token = signToken({ id, username });
    res.json({ token, user: { id, username, email: email || '', profilePhoto: null, city: '' } });
  } catch (e) {
    console.error('REGISTER error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username e password richiesti' });

    const r = await pool.query(`
      SELECT id, username, email, email_verified, password_hash, profile_photo, city, eta, citta, descrizione
      FROM users WHERE LOWER(username)=LOWER($1)
    `, [username]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'Credenziali non valide' });

    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });

    const token = signToken({ id: u.id, username: u.username });
    res.json({
      token,
      user: {
        id: u.id, username: u.username, email: u.email,
        emailVerified: !!u.email_verified, profilePhoto: u.profile_photo, city: u.city,
        eta: u.eta || '', citta: u.citta || '', descrizione: u.descrizione || ''
      }
    });
  } catch (e) {
    console.error('LOGIN error:', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.get('/api/users/me', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, username, email, email_verified, profile_photo, city, eta, citta, descrizione
      FROM users WHERE id=$1
    `, [req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const u = r.rows[0];

    const p = await pool.query(`SELECT feedback_up, feedback_down, events_attended, status FROM profiles WHERE username=$1`, [u.username]);
    const profile = p.rowCount
      ? { feedback: { up: p.rows[0].feedback_up, down: p.rows[0].feedback_down }, eventsAttended: p.rows[0].events_attended, status: p.rows[0].status }
      : { feedback: { up: 0, down: 0 }, eventsAttended: 0, status: 'Nuovo utente' };

    res.json({ user: {
      id: u.id, username: u.username, email: u.email, emailVerified: !!u.email_verified,
      profilePhoto: u.profile_photo, city: u.city, eta: u.eta || '', citta: u.citta || '',
      descrizione: u.descrizione || ''
    }, profile });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.put('/api/users/me', auth, async (req, res) => {
  try {
    const { eta, citta, descrizione, profilePhoto, city, email } = req.body || {};
    const r = await pool.query(`SELECT id, username FROM users WHERE id=$1`, [req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    await pool.query(`
      UPDATE users SET
        eta = COALESCE($2, eta),
        citta = COALESCE($3, citta),
        descrizione = COALESCE($4, descrizione),
        profile_photo = COALESCE($5, profile_photo),
        city = COALESCE($6, city),
        email = CASE WHEN $7 IS NOT NULL THEN $7 ELSE email END
      WHERE id=$1
    `, [req.user.id, eta ?? null, citta ?? null, descrizione ?? null, profilePhoto ?? null, city ?? null, (email && isValidEmail(email)) ? email : null]);

    const r2 = await pool.query(`SELECT id, username, email, email_verified, profile_photo, city, eta, citta, descrizione FROM users WHERE id=$1`, [req.user.id]);
    res.json({ ok: true, user: r2.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.get('/api/users/check-username', async (req, res) => {
  try {
    const username = String(req.query?.username || '').trim();
    if (!username) return res.json({ available: false });
    const r = await pool.query(`SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)`, [username]);
    res.json({ available: r.rowCount === 0 });
  } catch {
    res.json({ available: true });
  }
});

// ---------- Email confirm ----------
app.post('/api/users/send-confirmation', async (req, res) => {
  try {
    const candidates = [
      req.body?.email,
      req.body?.address,
      req.headers['x-test-email'],
      req.query?.email,
      typeof req.body === 'string' ? req.body : '',
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
  const webLoginUrl = webBase && /^https?:\/\//.test(webBase)
    ? `${webBase}` : `${getBackendBase(req)}/`;

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

    const r = await pool.query(`UPDATE users SET email_verified=true WHERE LOWER(email)=LOWER($1) RETURNING username`, [email]);
    if (r.rowCount === 0) return res.redirect(302, mkWebWith({ emailConfirmed: 0, reason: 'not_found' }));

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

    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    const r = await pool.query(`UPDATE users SET password_hash=$2 WHERE LOWER(email)=LOWER($1) RETURNING id`, [email, passwordHash]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Utente non trovato' });

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
function pickGroupForClient(row, participants) {
  return {
    id: row.id,
    creator: row.creator,
    createdAt: row.created_at,
    name: row.name,
    category: row.category,
    date: row.date,
    time: row.time,
    city: row.city,
    address: row.address,
    description: row.description,
    budget: Number(row.budget || 0),
    maxParticipants: row.max_participants,
    coverPhoto: row.cover_photo || null,
    participants: participants || [],
    location: (row.location_lat != null && row.location_lng != null)
      ? { lat: Number(row.location_lat), lng: Number(row.location_lng) }
      : null,
    hasExpired: computeHasExpired(row),
    attendanceProcessed: !!row.attendance_processed,
    voteRequestsSent: {},
  };
}

/**
 * Sweep che invia notifiche di voto per i gruppi scaduti e non ancora processati.
 * - crea notifica 'vote_request' per ogni partecipante
 * - marca attendance_processed=true sul gruppo
 */
async function sweepVoteRequestsIfNeeded() {
  const gr = await pool.query(`SELECT * FROM groups WHERE attendance_processed=false`);
  if (gr.rowCount === 0) return;

  const candidates = gr.rows.filter(row => computeHasExpired(row));
  if (candidates.length === 0) return;

  for (const g of candidates) {
    // partecipanti del gruppo
    const pr = await pool.query(
      `SELECT username FROM group_participants WHERE group_id=$1`,
      [g.id]
    );
    const participants = pr.rows.map(r => r.username);

    // invia notifica a TUTTI i partecipanti
    const now = new Date();
    for (const u of participants) {
      await pool.query(`
        INSERT INTO notifications (id, user_to, type, message, group_id, timestamp, read)
        VALUES ($1,$2,'vote_request',$3,$4,$5,false)
      `, [uuidv4(), u, `Dai un feedback ai partecipanti del gruppo "${g.name}"`, g.id, now]);
    }

    // marca processato
    await pool.query(`UPDATE groups SET attendance_processed=true WHERE id=$1`, [g.id]);
  }
}

app.get('/api/groups', auth, async (_req, res) => {
  try {
    // 1) Sweep prima di rispondere
    await sweepVoteRequestsIfNeeded();

    // 2) Risposta gruppi
    const r = await pool.query(`SELECT * FROM groups ORDER BY created_at DESC`);
    const rows = r.rows;

    // carica partecipanti in blocco
    const ids = rows.map(x => x.id);
    let partMap = {};
    if (ids.length) {
      const pr = await pool.query(`
        SELECT group_id, username FROM group_participants WHERE group_id = ANY($1::text[])
      `, [ids]);
      pr.rows.forEach(p => {
        if (!partMap[p.group_id]) partMap[p.group_id] = [];
        partMap[p.group_id].push(p.username);
      });
    }

    const out = rows.map(g => pickGroupForClient(g, partMap[g.id] || []));
    res.json(out);
  } catch (e) {
    console.error('GET /api/groups', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups', auth, async (req, res) => {
  try {
    const {
      name, category, date, time, city, address, description,
      budget = 0, maxParticipants = 10, coverPhoto = null, location = null,
    } = req.body || {};
    if (!name || !category || !date || !time || !city || !address || !description) {
      return res.status(400).json({ error: 'Campi richiesti mancanti' });
    }

    const id = Date.now().toString();
    await pool.query(`
      INSERT INTO groups
      (id, creator, created_at, name, category, date, time, city, address, description,
       budget, max_participants, cover_photo, location_lat, location_lng, attendance_processed)
      VALUES
      ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false)
    `, [
      id, req.user.username, name, category, date, time, city, address, description,
      Number(budget) || 0, Number(maxParticipants) || 10, coverPhoto,
      location?.lat ?? null, location?.lng ?? null
    ]);

    await pool.query(`
      INSERT INTO group_participants (group_id, username) VALUES ($1,$2)
      ON CONFLICT DO NOTHING
    `, [id, req.user.username]);

    await pool.query(`
      INSERT INTO notifications (id, user_to, type, message, group_id, timestamp, read)
      VALUES ($1,$2,'info',$3,$4, now(), false)
    `, [uuidv4(), req.user.username, `Hai creato il gruppo "${name}"`, id]);

    const row = (await pool.query(`SELECT * FROM groups WHERE id=$1`, [id])).rows[0];
    const out = pickGroupForClient(row, [req.user.username]);
    res.status(201).json(out);
  } catch (e) {
    console.error('POST /api/groups', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/join', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const gr = await pool.query(`SELECT * FROM groups WHERE id=$1`, [id]);
    if (gr.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const g = gr.rows[0];

    const pr = await pool.query(`SELECT COUNT(*)::int AS c FROM group_participants WHERE group_id=$1`, [id]);
    const count = pr.rows[0].c || 0;
    if (count >= (g.max_participants || 10)) {
      return res.status(400).json({ error: 'Gruppo completo' });
    }

    await pool.query(`
      INSERT INTO group_participants (group_id, username) VALUES ($1,$2)
      ON CONFLICT DO NOTHING
    `, [id, req.user.username]);

    if (req.user.username !== g.creator) {
      await pool.query(`
        INSERT INTO notifications (id, user_to, type, message, group_id, timestamp, read)
        VALUES ($1,$2,'info',$3,$4, now(), false)
      `, [uuidv4(), g.creator, `${req.user.username} si è unito al tuo gruppo "${g.name}"`, g.id]);
    }

    const participants = (await pool.query(`SELECT username FROM group_participants WHERE group_id=$1`, [id])).rows.map(r => r.username);
    res.json({ ok: true, group: pickGroupForClient(g, participants) });
  } catch (e) {
    console.error('JOIN group', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/leave', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const gr = await pool.query(`SELECT * FROM groups WHERE id=$1`, [id]);
    if (gr.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const g = gr.rows[0];

    if (g.creator === req.user.username) {
      return res.status(400).json({ error: 'Il creatore non può lasciare il proprio gruppo' });
    }

    await pool.query(`DELETE FROM group_participants WHERE group_id=$1 AND username=$2`, [id, req.user.username]);
    const participants = (await pool.query(`SELECT username FROM group_participants WHERE group_id=$1`, [id])).rows.map(r => r.username);
    res.json({ ok: true, group: pickGroupForClient(g, participants) });
  } catch (e) {
    console.error('LEAVE group', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/remove-participant', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username richiesto' });

    const gr = await pool.query(`SELECT * FROM groups WHERE id=$1`, [id]);
    if (gr.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const g = gr.rows[0];

    if (g.creator !== req.user.username) {
      return res.status(403).json({ error: 'Solo il creatore può rimuovere partecipanti' });
    }
    if (username === g.creator) {
      return res.status(400).json({ error: 'Non puoi rimuovere il creatore' });
    }

    const pr = await pool.query(`SELECT feedback_down FROM profiles WHERE username=$1`, [username]);
    const down = pr.rowCount ? (pr.rows[0].feedback_down || 0) : 0;
    if (down <= 0) return res.status(400).json({ error: 'Il partecipante non ha feedback negativo' });

    await pool.query(`DELETE FROM group_participants WHERE group_id=$1 AND username=$2`, [id, username]);
    await pool.query(`
      INSERT INTO notifications (id, user_to, type, message, group_id, timestamp, read)
      VALUES ($1,$2,'info',$3,$4, now(), false)
    `, [uuidv4(), username, `Sei stato rimosso dal gruppo "${g.name}"`, id]);

    const participants = (await pool.query(`SELECT username FROM group_participants WHERE group_id=$1`, [id])).rows.map(r => r.username);
    res.json({ ok: true, group: pickGroupForClient(g, participants) });
  } catch (e) {
    console.error('REMOVE participant', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/groups/:id/votes', auth, async (req, res) => {
  try {
    const { votes = {} } = req.body || {};
    for (const [target, val] of Object.entries(votes)) {
      if (!target || target === req.user.username) continue;
      const v = Number(val);
      if (v !== 1 && v !== -1) continue;

      await pool.query(`
        INSERT INTO profiles (username, feedback_up, feedback_down, events_attended, status)
        VALUES ($1,0,0,0,'Nuovo utente')
        ON CONFLICT (username) DO NOTHING
      `, [target]);

      if (v === 1) {
        await pool.query(`UPDATE profiles SET feedback_up = feedback_up + 1 WHERE username=$1`, [target]);
      } else {
        await pool.query(`UPDATE profiles SET feedback_down = feedback_down + 1 WHERE username=$1`, [target]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('VOTES', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

/**
 * NUOVO: notifica chat agli altri partecipanti
 * body: { preview?: string }
 */
app.post('/api/groups/:id/chat-notify', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { preview = '' } = req.body || {};
    const gr = await pool.query(`SELECT * FROM groups WHERE id=$1`, [id]);
    if (gr.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const g = gr.rows[0];

    const pr = await pool.query(`SELECT username FROM group_participants WHERE group_id=$1`, [id]);
    const others = pr.rows.map(r => r.username).filter(u => u !== req.user.username);

    const now = new Date();
    for (const u of others) {
      await pool.query(`
        INSERT INTO notifications (id, user_to, type, message, group_id, timestamp, read)
        VALUES ($1,$2,'info',$3,$4,$5,false)
      `, [uuidv4(), u, `${req.user.username}: ${preview || 'Nuovo messaggio'} in "${g.name}"`, g.id, now]);
    }
    res.json({ ok: true, notified: others.length });
  } catch (e) {
    console.error('chat-notify', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// ---------- NOTIFICATIONS ----------
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, user_to AS "user", type, message, group_id AS "groupId", timestamp, read
      FROM notifications WHERE user_to=$1 ORDER BY timestamp DESC
    `, [req.user.username]);

    const rows = r.rows;

    // arricchisci con participants[] e groupData per notifiche legate a gruppi
    const groupIds = [...new Set(rows.map(x => x.groupId).filter(Boolean))];
    let groupsMap = {};
    let partMap = {};

    if (groupIds.length) {
      const gr = await pool.query(`SELECT * FROM groups WHERE id = ANY($1::text[])`, [groupIds]);
      gr.rows.forEach(g => { groupsMap[g.id] = g; });

      const pr = await pool.query(`SELECT group_id, username FROM group_participants WHERE group_id = ANY($1::text[])`, [groupIds]);
      pr.rows.forEach(p => {
        if (!partMap[p.group_id]) partMap[p.group_id] = [];
        partMap[p.group_id].push(p.username);
      });
    }

    const enriched = rows.map(n => {
      if (!n.groupId || !groupsMap[n.groupId]) return n;
      const g = groupsMap[n.groupId];
      const participants = partMap[n.groupId] || [];
      return {
        ...n,
        participants,
        groupData: pickGroupForClient(g, participants), // struttura già compatibile col client
      };
    });

    res.json(enriched);
  } catch (e) {
    console.error('/api/notifications', e);
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

app.post('/api/notifications/mark-read', auth, async (req, res) => {
  try {
    const { id, all } = req.body || {};
    if (all) {
      await pool.query(`UPDATE notifications SET read=true WHERE user_to=$1`, [req.user.username]);
    } else if (id) {
      await pool.query(`UPDATE notifications SET read=true WHERE user_to=$1 AND id=$2`, [req.user.username, id]);
    }
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
const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
app.use('/uploads', express.static(UPLOAD_DIR));
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`✅ Server avviato su http://localhost:${PORT}`);
});
