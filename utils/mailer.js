// utils/mailer.js
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
} = process.env;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465, // 465 = SSL
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

async function sendMail({ to, subject, html, text }) {
  return transporter.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to,
    subject,
    html,
    text,
  });
}

module.exports = { sendMail };
