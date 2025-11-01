// backend/src/utils/notifications.js
// Robust notification helper supporting SMTP (nodemailer) and WhatsApp via
// Twilio or WhatsApp Cloud API (Graph API). Includes a throttled email queue.

const nodemailer = require("nodemailer");
const axios = require("axios");
const Twilio = require("twilio");
const path = require("path");
const fs = require("fs");

// Environment variables (common names used in your project)
const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_EMAIL,
  // Twilio (optional)
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  // WhatsApp Cloud API (optional)
  WHATSAPP_CLOUD_API_TOKEN,
  WHATSAPP_PHONE_ID,
  // Helpful URL for building links in messages
  FRONTEND_URL,
} = process.env;

// --- Diagnostics (startup) ---
console.log("---- NotificationService env check ----");
console.log("SMTP_HOST:", !!SMTP_HOST, SMTP_HOST ? SMTP_HOST : "");
console.log("SMTP_PORT:", !!SMTP_PORT, SMTP_PORT ? SMTP_PORT : "");
console.log("SMTP_USER:", !!SMTP_USER, SMTP_USER ? (SMTP_USER.length > 6 ? `${SMTP_USER.slice(0,5)}...` : SMTP_USER) : "");
console.log("SMTP_PASS:", !!SMTP_PASS);
console.log("TWILIO_ACCOUNT_SID:", !!TWILIO_ACCOUNT_SID, TWILIO_ACCOUNT_SID ? `${TWILIO_ACCOUNT_SID.slice(0,8)}...` : "");
console.log("TWILIO_AUTH_TOKEN:", !!TWILIO_AUTH_TOKEN);
console.log("TWILIO_WHATSAPP_FROM:", !!TWILIO_WHATSAPP_FROM, TWILIO_WHATSAPP_FROM || "");
console.log("WHATSAPP_CLOUD_API_TOKEN:", !!WHATSAPP_CLOUD_API_TOKEN);
console.log("WHATSAPP_PHONE_ID:", !!WHATSAPP_PHONE_ID, WHATSAPP_PHONE_ID || "");
console.log("FROM_EMAIL:", !!FROM_EMAIL, FROM_EMAIL || SMTP_USER || "");
console.log("---------------------------------------");

// --- Email transporter (nodemailer) setup ---
const emailConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;
if (emailConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: (String(process.env.SMTP_SECURE || "false").toLowerCase() === "true"), // true for 465
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  // optional: verify transporter at startup (non-blocking)
  transporter.verify().then(() => {
    console.log("[EMAIL] SMTP transporter verified");
  }).catch((err) => {
    console.warn("[EMAIL] SMTP transporter verification failed:", err && err.message ? err.message : err);
  });
} else {
  console.warn("⚠️ Email config missing or incomplete. Email notifications will not work.");
}

// --- Twilio setup (optional) ---
const twilioConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM);
let twilioClient = null;
if (twilioConfigured) {
  try {
    twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("[WHATSAPP] Twilio configured (will use Twilio for WhatsApp).");
  } catch (err) {
    console.warn("[WHATSAPP] Failed to construct Twilio client:", err && err.message ? err.message : err);
    twilioClient = null;
  }
} else {
  console.log("[WHATSAPP] Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_FROM missing).");
}

// --- WhatsApp Cloud API (Facebook Graph) setup (optional) ---
const waCloudConfigured = Boolean(WHATSAPP_CLOUD_API_TOKEN && WHATSAPP_PHONE_ID);
if (waCloudConfigured) {
  console.log("[WHATSAPP] WhatsApp Cloud API configured (will use as fallback if Twilio not present).");
} else {
  console.log("[WHATSAPP] WhatsApp Cloud API not configured (WHATSAPP_CLOUD_API_TOKEN/WHATSAPP_PHONE_ID missing).");
}

// --- Email throttling queue ---
// Simple FIFO queue with 1 email/sec delay between sends.
// Avoids rate-limit errors (Mailtrap / low-tier SMTP).
let emailQueue = [];
let emailProcessing = false;

async function processEmailQueue() {
  if (emailProcessing || emailQueue.length === 0) return;
  emailProcessing = true;

  const item = emailQueue.shift();
  const { to, subject, html, text, attachments, resolve, reject } = item;

  try {
    await sendEmailNow({ to, subject, html, text, attachments });
    resolve && resolve();
  } catch (err) {
    reject && reject(err);
  }

  emailProcessing = false;
  if (emailQueue.length > 0) {
    // wait 1s between emails (tunable)
    setTimeout(processEmailQueue, 1000);
  }
}

async function sendEmailNow({ to, subject, html, text, attachments = [] }) {
  if (!transporter) {
    const msg = "Email transporter not configured";
    console.warn("[EMAIL] " + msg);
    throw new Error(msg);
  }
  if (!to) {
    throw new Error("No recipient (to) provided to sendEmailNow");
  }

  const from = FROM_EMAIL || SMTP_USER;
  const mailOptions = {
    from,
    to,
    subject: subject || "Notification",
    html: html || (text ? `<pre>${text}</pre>` : "<p></p>"),
    attachments: attachments || [],
  };

  // nodemailer returns info object
  const info = await transporter.sendMail(mailOptions);
  console.log(`[EMAIL] Sent to ${to} (messageId=${info.messageId || "n/a"})`);
  return info;
}

/**
 * Throttled public function to send email.
 * Usage: await sendEmail({ to, subject, html, text, attachments })
 */
function sendEmail({ to, subject, html, text, attachments = [] } = {}) {
  return new Promise((resolve, reject) => {
    if (!emailConfigured) {
      console.warn("[EMAIL] Skipped - SMTP not configured");
      return resolve(); // don't reject — caller may choose to ignore absence
    }
    emailQueue.push({ to, subject, html, text, attachments, resolve, reject });
    // start processing (if not already)
    setImmediate(processEmailQueue);
  });
}

// --- WhatsApp senders ---
// Prefer Twilio if configured; else fall back to WhatsApp Cloud API
async function sendWhatsAppViaTwilio({ toPhone, text }) {
  if (!twilioClient) throw new Error("Twilio client not configured");
  if (!TWILIO_WHATSAPP_FROM) throw new Error("TWILIO_WHATSAPP_FROM is not set");

  // Twilio expects E.164 phone numbers (with country code). Prefix with 'whatsapp:' as required
  const from = `whatsapp:${TWILIO_WHATSAPP_FROM}`;
  const to = (String(toPhone).startsWith("whatsapp:") ? toPhone : `whatsapp:${toPhone}`);

  const message = await twilioClient.messages.create({
    from,
    to,
    body: text,
  });

  console.log(`[WHATSAPP][twilio] Sent to ${toPhone} (sid=${message.sid || "n/a"})`);
  return message;
}

async function sendWhatsAppViaCloud({ toPhone, text }) {
  if (!WHATSAPP_CLOUD_API_TOKEN || !WHATSAPP_PHONE_ID) throw new Error("WhatsApp Cloud API not configured");
  const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toPhone,
    text: { body: text },
  };
  const res = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_CLOUD_API_TOKEN}` },
  });
  console.log(`[WHATSAPP][cloud] Sent to ${toPhone} (status=${res.status})`);
  return res.data;
}

/**
 * Public function: sendWhatsApp({ phone, text })
 * - chooses Twilio first if configured, else WhatsApp Cloud API if configured.
 * - if neither configured, resolves but logs a warning.
 */
async function sendWhatsApp({ phone, text } = {}) {
  if (!phone) {
    console.warn("[WHATSAPP] Missing recipient phone; skipping.");
    return;
  }

  if (twilioClient) {
    try {
      return await sendWhatsAppViaTwilio({ toPhone: phone, text });
    } catch (err) {
      console.error("[WHATSAPP] Twilio send failed:", err && err.message ? err.message : err);
      // fall through to cloud API if configured
    }
  }

  if (waCloudConfigured) {
    try {
      return await sendWhatsAppViaCloud({ toPhone: phone, text });
    } catch (err) {
      console.error("[WHATSAPP] WhatsApp Cloud send failed:", err && err.message ? err.message : err);
      throw err;
    }
  }

  console.warn("[WHATSAPP] No provider configured (Twilio/WhatsApp Cloud). Skipped sending.");
  return;
}

// Export functions
module.exports = {
  sendEmail,
  sendEmailNow, // exported for internal/rare use
  sendWhatsApp,
  // expose a small helper to inspect configuration in runtime
  _config: {
    emailConfigured,
    twilioConfigured,
    waCloudConfigured,
  }
};
