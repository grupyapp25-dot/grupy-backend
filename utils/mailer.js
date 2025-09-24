// utils/mailer.js
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,         // "true"/"false" (se non messo, deduciamo da porta)
  MAIL_FROM,           // es. no-reply@tuodominio.com  (puoi mettere "Nome <email>")
  MAIL_NAME = 'Grupy',
  MAIL_LOG = '1',      // 1 = log attivi, 0 = silenzioso
} = process.env;

const shouldLog = MAIL_LOG !== '0';

function toBool(v, def = false) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1','true','yes','y','on'].includes(s)) return true;
    if (['0','false','no','n','off'].includes(s)) return false;
  }
  return def;
}

const portNum = Number(SMTP_PORT);
const secure = toBool(SMTP_SECURE, portNum === 465);

let transporter;
if (SMTP_HOST && (SMTP_USER || !secure)) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: portNum,
    secure,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    connectionTimeout: 15000,
    socketTimeout: 15000,
  });
  if (shouldLog) console.log('📨 Mailer pronto: SMTP OK');
} else {
  transporter = nodemailer.createTransport({ jsonTransport: true });
  if (shouldLog) console.log('📨 Mailer in modalità JSON (SMTP non configurato)');
}

function normalizeRecipients(to) {
  if (!to) return [];
  if (Array.isArray(to)) return to.map(x => String(x||'').trim()).filter(Boolean);
  if (typeof to === 'string')
    return to.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  if (typeof to === 'object' && to.address) return [String(to.address).trim()];
  return [];
}

async function sendMail({ to, subject, html, text }) {
  const recipients = normalizeRecipients(to);
  const from = MAIL_FROM
    ? (MAIL_NAME ? `"${MAIL_NAME}" <${MAIL_FROM}>` : MAIL_FROM)
    : SMTP_USER;

  if (shouldLog) console.log('📧 sendMail() ->', { recipients, from, subject });

  if (!recipients.length) {
    const err = new Error('No recipients defined');
    err.code = 'EENVELOPE';
    throw err;
  }

  const info = await transporter.sendMail({
    from,
    to: recipients.join(', '),
    subject,
    text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
    html: html || undefined,
  });

  if (shouldLog) console.log('📧 sendMail() OK id:', info?.messageId || info);
  return info;
}

module.exports = { sendMail };
