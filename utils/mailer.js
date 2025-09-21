// utils/mailer.js
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
} = process.env;

const transporter = nodemailer.createTransport(
  SMTP_HOST
    ? {
        host: SMTP_HOST,
        port: Number(SMTP_PORT),
        secure: Number(SMTP_PORT) === 465, // 465 = SSL
        auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      }
    : {
        // fallback generico (es. Gmail con OAuth/App Password non gestito qui)
        // meglio sempre configurare SMTP_HOST/PORT/USER/PASS su Render
        service: 'gmail',
        auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      }
);

async function sendMail({ to, subject, html, text }) {
  if (!to) throw new Error('Missing recipient "to"');
  const info = await transporter.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to,
    subject,
    html,
    text,
  });
  return info;
}

module.exports = { sendMail };
