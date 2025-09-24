// utils/mailer.js
const nodemailer = require('nodemailer');

const MAIL_PROVIDER = (process.env.MAIL_PROVIDER || 'smtp').toLowerCase();
// mittente predefinito; puoi sovrascriverlo passando `from` a sendMail(...)
const DEFAULT_FROM = process.env.FROM_EMAIL || 'no-reply@grupy.app';

// ========== Provider: SMTP (consigliato se hai credenziali) ==========
async function sendWithSMTP({ to, subject, text, html, from }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true'; // true = 465

  if (!host || !user || !pass) {
    throw new Error('SMTP non configurato: imposta SMTP_HOST, SMTP_USER, SMTP_PASS (e SMTP_PORT/SMTP_SECURE se necessari).');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from: from || DEFAULT_FROM,
    to,
    subject,
    text,
    html,
  });

  return { messageId: info.messageId };
}

// ========== Provider: Resend ==========
async function sendWithResend({ to, subject, text, html, from }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY mancante.');
  const { Resend } = require('resend');
  const resend = new Resend(key);
  const resp = await resend.emails.send({
    from: from || DEFAULT_FROM,
    to,
    subject,
    text,
    html,
  });
  if (resp.error) throw new Error(resp.error.message || 'Errore Resend');
  return { messageId: resp.data?.id || 'resend' };
}

// ========== Provider: SendGrid ==========
async function sendWithSendGrid({ to, subject, text, html, from }) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SENDGRID_API_KEY mancante.');
  const sg = require('@sendgrid/mail');
  sg.setApiKey(key);
  const [resp] = await sg.send({
    to,
    from: from || DEFAULT_FROM,
    subject,
    text,
    html,
  });
  return { messageId: resp?.headers?.['x-message-id'] || 'sendgrid' };
}

// ========== Dispatcher ==========
async function sendMail({ to, subject, text, html, from }) {
  const payload = { to, subject, text, html, from };
  const prov = MAIL_PROVIDER;
  if (!to) throw new Error('Campo "to" obbligatorio in sendMail');

  if (prov === 'smtp') return sendWithSMTP(payload);
  if (prov === 'resend') return sendWithResend(payload);
  if (prov === 'sendgrid') return sendWithSendGrid(payload);

  // fallback: SMTP
  return sendWithSMTP(payload);
}

module.exports = { sendMail };
