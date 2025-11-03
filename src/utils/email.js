// backend/src/utils/email.js
require("dotenv").config();
const sgMail = require("@sendgrid/mail");

// Set API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendEmail(to, subject, text = "", html = "") {
  if (!to) return;

  const msg = {
    to,
    from: process.env.EMAIL_FROM, // MUST be your verified sender identity!
    subject,
    text,
    html,
  };

  try {
    const result = await sgMail.send(msg);
    console.log("✅ Email sent:", result[0].statusCode);
    return result;
  } catch (err) {
    console.error("❌ SendGrid Error:", err.response?.body || err.message);
    throw err;
  }
}

module.exports = { sendEmail };
