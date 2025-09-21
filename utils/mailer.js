// utils/mailer.js
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  FROM_EMAIL,
  MAIL_FROM, // fallback
} = process.env;

let transporter = null;

function buildTransporter() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn('✉️  Mailer disabilitato: variabili SMTP mancanti.');
    return null;
  }
  const t = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // 465 = SSL
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // Prova connessione (non blocca l’avvio)
  t.verify()
    .then(() => console.log('📨 Mailer pronto: SMTP OK'))
    .catch(err => console.warn('⚠️  Mailer verify fallita:', err?.message));

  return t;
}

function getTransporter() {
  if (!transporter) transporter = buildTransporter();
  return transporter;
}

async function sendMail(to, subject, html, text) {
  const t = getTransporter();
  if (!t) throw new Error('Mailer non configurato (mancano variabili SMTP)');
  return t.sendMail({
    from: FROM_EMAIL || MAIL_FROM || SMTP_USER,
    to,
    subject,
    html,
    text,
  });
}

async function sendConfirmationEmail(to, confirmUrl) {
  const subject = 'Conferma la tua email su Grupy';
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#222">
      <h2>Benvenuto/a su Grupy!</h2>
      <p>Per completare la registrazione, conferma il tuo indirizzo email cliccando il bottone:</p>
      <p><a href="${confirmUrl}" style="display:inline-block;background:#4A90E2;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Conferma email</a></p>
      <p>Oppure incolla questo link nel browser:<br/><code>${confirmUrl}</code></p>
      <p style="margin-top:24px;color:#666">Se non hai creato tu l’account, ignora questa mail.</p>
    </div>`;
  return sendMail(to, subject, html);
}

module.exports = { sendMail, sendConfirmationEmail };
