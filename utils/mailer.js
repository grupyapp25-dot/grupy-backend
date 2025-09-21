// utils/mailer.js
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,         // opzionale: "true"/"false"
  MAIL_FROM,           // es. "no-reply@tuodominio.com"
  MAIL_NAME,           // es. "Grupy"
} = process.env;

const portNum = Number(SMTP_PORT);
const secure =
  String(SMTP_SECURE || (portNum === 465)).toLowerCase() === 'true' || portNum === 465;

let transporter;
if (SMTP_HOST && (SMTP_USER || !secure)) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: portNum,
    secure,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  console.log('📨 Mailer pronto: SMTP OK');
} else {
  // fallback: non invia davvero, ma stampa il messaggio in JSON per debug
  transporter = nodemailer.createTransport({ jsonTransport: true });
  console.log('📨 Mailer in modalità JSON (no SMTP env presenti)');
}

function normalizeRecipients(to) {
  if (!to) return [];
  if (Array.isArray(to)) {
    return to.map(x => String(x || '').trim()).filter(Boolean);
  }
  if (typeof to === 'string') {
    // accetta "a@b.com", "Nome <a@b.com>", liste separate da virgola o punto e virgola
    return to
      .split(/[;,]/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  if (typeof to === 'object' && to.address) {
    return [String(to.address).trim()];
  }
  return [];
}

async function sendMail({ to, subject, html, text }) {
  const normalizedTo = normalizeRecipients(to);
  const from = MAIL_FROM
    ? (MAIL_NAME ? `"${MAIL_NAME}" <${MAIL_FROM}>` : MAIL_FROM)
    : SMTP_USER;

  console.log('📧 sendMail() input:', { rawTo: to, normalizedTo, from, subject });

  if (!normalizedTo.length) {
    const err = new Error('No recipients defined (normalizedTo empty)');
    err.code = 'EENVELOPE';
    throw err;
  }

  const info = await transporter.sendMail({
    from,
    to: normalizedTo.join(', '),
    subject,
    text,
    html,
  });

  console.log('📧 sendMail() OK id:', info?.messageId || info);
  return info;
}

module.exports = { sendMail };
