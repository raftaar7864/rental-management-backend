// backend/src/utils/email.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true' || false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// sendEmail(to, subject, text, html)
async function sendEmail(to, subject, text, html) {
  if (!to) return;
  const mail = {
    from: process.env.EMAIL_FROM || (process.env.SMTP_USER || 'no-reply@example.com'),
    to,
    subject,
    text,
    html
  };
  try {
    const info = await transporter.sendMail(mail);
    console.log('Email sent:', info.messageId);
    return info;
  } catch (err) {
    console.error('sendEmail error:', err);
    throw err;
  }
}

module.exports = { sendEmail };
