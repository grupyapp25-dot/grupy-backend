// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const multer = require('multer');
const fs = require('fs');

const { readDB, writeDB } = require('./db');
const dbpg = require('./db_pg');
const { sendMail } = require('./utils/mailer');

// --- CONFIG ---
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const BACKEND_PUBLIC_URL = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
const FRONTEND_LOGIN_URL =
  (process.env.FRONTEND_LOGIN_URL || '').replace(/\/$/, '') ||
  (PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/login` : '');

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true })); // importa anche form-urlencoded

// --- helpers ---
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

// --- base ---
app.get('/', (_req, res) => res.json({ ok: true, service: 'Grupy API' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/__version', (_req, res) => res.json({ build: 'server-v5', emailRoute: '/api/users/send-confirmation' }));

// --- db health (facoltativo) ---
app.get('/health/db', async (_req, res) => {
  try { res.json({ ok: true, db: (await dbpg.ping()) ? 'connected' : 'unknown' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- auth ---
app.post('/api/users/register', async (req, res) => {
  try {
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
        id: user.id,
        username: user.username,
        email: user.email,
        emailVerified: !!user.emailVerified,
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

// (utile per client)
app.get('/api/users/check-username', async (req, res) => {
  try {
    const username = String(req.query?.username || '').trim();
    if (!username) return res.json({ available: false });
    const db = await readDB();
    const exists = db.users.some(u => (u.username || '').toLowerCase() === username.toLowerCase());
    res.json({ available: !exists });
  } catch {
    res.json({ available: true });
  }
});

// --- EMAIL: invio conferma (SUPER difensiva + log) ---
app.post('/api/users/send-confirmation', async (req, res) => {
  try {
    const candidates = [
      req.body?.email,
      req.body?.address,
      req.headers['x-test-email'],
      req.query?.email,
      typeof req.body === 'string' ? req.body : '',
    ].filter(Boolean);

    console.log('📨 send-confirmation headers=', req.headers);
    try { console.log('📨 send-confirmation body=', JSON.stringify(req.body)); } catch { console.log('📨 send-confirmation body=[non-JSON]'); }
    console.log('📨 send-confirmation query=', req.query);

    const email = extractEmail(candidates.find(v => isValidEmail(v)) || '');
    console.log('📨 parsed email =', email || '(vuota)');

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

    console.log('📧 INVIO a:', email);
    const info = await sendMail({ to: email, subject, html, text });

    res.json({ ok: true, sent: true, messageId: info?.messageId, confirmUrl, emailUsed: email });
  } catch (e) {
    console.error('send-confirmation error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Mailer error' });
  }
});

// --- EMAIL: rotta di TEST manuale (comoda)
app.get('/dev/test-mail', async (req, res) => {
  try {
    const to = String(req.query.to || '').trim();
    if (!isValidEmail(to)) return res.status(400).json({ ok: false, error: 'to mancante o non valido' });
    const info = await sendMail({
      to,
      subject: 'Prova invio da Grupy',
      text: 'Test ok.',
      html: '<b>Test ok.</b>',
    });
    res.json({ ok: true, messageId: info?.messageId });
  } catch (e) {
    console.error('dev/test-mail error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- EMAIL: conferma + redirect al login
const confirmEmailHandler = async (req, res) => {
  const safeRedirect = () => {
    const base = (FRONTEND_LOGIN_URL || PUBLIC_APP_URL ? `${FRONTEND_LOGIN_URL || (PUBLIC_APP_URL + '/login')}` : getBackendBase(req));
    const u = new URL(base.startsWith('http') ? base : getBackendBase(req));
    u.searchParams.set('emailConfirmed', '1');
    return u.toString();
  };

  try {
    const { token } = req.query || {};
    if (!token) return res.redirect(302, safeRedirect().replace('emailConfirmed=1', 'emailConfirmed=0&reason=missing_token'));

    let decoded = '';
    try { decoded = Buffer.from(String(token), 'base64url').toString('utf8'); }
    catch { decoded = Buffer.from(String(token), 'base64').toString('utf8'); }

    let [email, ts] = decoded.split('|');
    ts = Number(ts || 0);
    const MAX_AGE = 3 * 24 * 60 * 60 * 1000;
    if (!email || !ts || (Date.now() - ts) > MAX_AGE) {
      return res.redirect(302, safeRedirect().replace('emailConfirmed=1', 'emailConfirmed=0&reason=expired'));
    }

    const db = await readDB();
    const user = db.users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase());
    if (!user) return res.redirect(302, safeRedirect().replace('emailConfirmed=1', 'emailConfirmed=0&reason=not_found'));

    user.emailVerified = true;
    await writeDB(db);
    return res.redirect(302, safeRedirect());
  } catch (e) {
    console.error('confirm-email error:', e);
    const base = (FRONTEND_LOGIN_URL || PUBLIC_APP_URL || '/').replace(/\/$/, '');
    const fallback = base.startsWith('http') ? `${base}?emailConfirmed=0&reason=server_error` : `${getBackendBase(req)}/?emailConfirmed=0&reason=server_error`;
    return res.redirect(302, fallback);
  }
};
app.get(['/api/users/confirm-email', '/confirm-email'], confirmEmailHandler);

// --- PROFILE/OTHERS (immutati) ---
app.get('/api/users/me', auth, async (req, res) => {
  try {
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
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore server' });
  }
});

// --- GROUPS/VOTES/UPLOAD (immutati) ---
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

// --- start ---
app.listen(PORT, () => {
  console.log(`✅ Server avviato su http://localhost:${PORT}`);
});
