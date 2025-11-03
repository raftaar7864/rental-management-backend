// backend/src/services/notificationService.js
/**
 * Notification service
 * - Uses sendEmail(from ../utils/email) which should be your SendGrid helper
 * - WhatsApp via Twilio preferred, fallback to WhatsApp Cloud API
 * - Email queue with simple throttling
 *
 * Exports:
 *  - sendBill(bill, subject, message)
 *  - sendBillEmail(bill, pdfPath, subject, message) -> queued send
 *  - sendBillWhatsApp(bill, pdfPath, message) -> immediate
 *  - _sendBillEmailNow(bill, pdfPath, subject, message) -> immediate
 *  - _removePendingEmailsForBill(billId)
 *  - _config -> debug info
 */

const axios = require("axios");
const Twilio = require("twilio");
const templates = require("../utils/notificationTemplete");
const { sendEmail } = require("../utils/email"); // sendEmail(to, subject, text, html)
const path = require("path");
const fs = require("fs");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  WHATSAPP_CLOUD_API_TOKEN,
  WHATSAPP_PHONE_ID,
  FRONTEND_URL,
  BACKEND_URL,
  DEFAULT_COUNTRY_PREFIX,
} = process.env;

const backendBase = (BACKEND_URL || FRONTEND_URL || "http://localhost:5000").trim().replace(/\/$/, "");
const frontendBase = (FRONTEND_URL || BACKEND_URL || "http://localhost:3000").trim().replace(/\/$/, "");

// Twilio client if configured
let twilioClient = null;
const twilioConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM);
if (twilioConfigured) {
  try {
    twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("[WHATSAPP] Twilio configured");
  } catch (err) {
    console.warn("[WHATSAPP] Twilio init failed:", err && err.message ? err.message : err);
    twilioClient = null;
  }
} else {
  console.log("[WHATSAPP] Twilio not configured");
}

const waCloudConfigured = Boolean(WHATSAPP_CLOUD_API_TOKEN && WHATSAPP_PHONE_ID);
console.log(waCloudConfigured ? "[WHATSAPP] Cloud API configured" : "[WHATSAPP] Cloud API not configured");

// ---------------- Email queue ----------------
let emailQueue = [];
let emailProcessing = false;

/**
 * Normalize bill id (handles when queue item stored as bill object or billId)
 */
function _normalizeBillId(b) {
  try {
    if (!b) return null;
    if (b._id) return String(b._id);
    if (b.bill && b.bill._id) return String(b.bill._id);
    if (b.billId) return String(b.billId);
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove pending queued emails for a bill (used after payment)
 */
function _removePendingEmailsForBill(billId) {
  try {
    const idStr = billId?.toString ? billId.toString() : String(billId);
    emailQueue = emailQueue.filter((item) => {
      const qId = _normalizeBillId(item.bill) || (item.billId ? String(item.billId) : null);
      return qId !== idStr;
    });
    console.log(`[EMAIL] Removed pending queued emails for bill ${idStr}`);
  } catch (err) {
    console.warn("[EMAIL] _removePendingEmailsForBill failed:", err && err.message ? err.message : err);
  }
}

/**
 * Queue processor - sends emails one-by-one with small throttle
 */
async function processEmailQueue() {
  if (emailProcessing || emailQueue.length === 0) return;
  emailProcessing = true;

  const { bill, pdfPath, resolve, reject, subject, message } = emailQueue.shift();

  try {
    await _sendBillEmailNow(bill, pdfPath, subject, message);
    resolve && resolve();
  } catch (err) {
    reject && reject(err);
  }

  emailProcessing = false;
  if (emailQueue.length > 0) {
    // throttle for a brief interval (adjustable)
    setTimeout(processEmailQueue, 400);
  }
}

/* ---------------- Helper: build links ----------------
   Template already builds links using R2_PUBLIC_URL; this keeps same semantics.
*/
/* ---------------- Helper: build links ---------------- */
function getBillLinks(bill) {
  const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
  const stamp = bill?.updatedAt ? new Date(bill.updatedAt).getTime() : Date.now();

  // ✅ Always point to Cloudflare R2
  const downloadLink = `${R2_PUBLIC_URL}/bills/bill_${bill._id}.pdf?v=${stamp}`;

  const isPaid = (bill.paymentStatus || bill.status || "").toLowerCase() === "paid";
  const paymentLink = isPaid
    ? null
    : `${frontendBase}/payment/public/${bill._id}?v=${stamp}`;

  return { downloadLink, paymentLink, stamp };
}


/* ---------------- Email: immediate send ----------------
   - bill: populated bill object
   - pdfPath: optional local path (we do not attach by default; prefer link)
   - subject: override
   - message: override HTML
*/
async function _sendBillEmailNow(bill, pdfPath = null, subject = null, message = null) {
  // Use sendEmail util (SendGrid)
  if (typeof sendEmail !== "function") {
    const msg = "sendEmail util not available";
    console.warn("[EMAIL] " + msg);
    throw new Error(msg);
  }

  const tenantEmail = bill?.tenant?.email;
  if (!tenantEmail) {
    console.warn(`[EMAIL] No tenant email for bill ${bill?._id}`);
    return;
  }

  // ensure links included for templates (stamp)
  const { downloadLink, paymentLink, stamp } = getBillLinks(bill);

  const finalSubject = subject || templates.emailSubject(bill, { downloadLink, paymentLink, stamp });
  const finalHtml = message || templates.emailHtml(bill, { downloadLink, paymentLink, stamp });

  // Fallbacks to avoid SendGrid complaints
  const safeHtml = (typeof finalHtml === "string" && finalHtml.length > 0) ? finalHtml : `<p>Please view your bill: <a href="${downloadLink}">Download PDF</a></p>`;
  const safeText = `Your bill is available: ${downloadLink}` + (paymentLink ? `\nPay: ${paymentLink}` : "");

  try {
    console.log(`[EMAIL] Sending immediate email to ${tenantEmail} for bill ${bill._id}`);
    await sendEmail(tenantEmail, finalSubject, safeText, safeHtml);
    console.log(`[EMAIL] Sent immediate email to ${tenantEmail}`);
  } catch (err) {
    console.error("[EMAIL] Failed to send email:", err && (err.response?.body || err.message || err));
    throw err;
  }
}

/**
 * Public queued send
 * returns a Promise that resolves when queued item is sent
 */
function sendBillEmail(bill, pdfPath = null, subject = null, message = null) {
  return new Promise((resolve, reject) => {
    emailQueue.push({ bill, pdfPath, resolve, reject, subject, message });
    // start processor if idle
    setImmediate(processEmailQueue);
  });
}

/* ---------------- WhatsApp ----------------
   - Prefer Twilio (template text)
   - Fallback to WhatsApp Cloud API
*/
async function sendWhatsAppViaTwilio({ toPhone, text }) {
  if (!twilioClient) throw new Error("Twilio client not configured");
  if (!TWILIO_WHATSAPP_FROM) throw new Error("TWILIO_WHATSAPP_FROM not set");

  const from = `whatsapp:${TWILIO_WHATSAPP_FROM}`;
  const to = toPhone.startsWith("whatsapp:") ? toPhone : `whatsapp:${toPhone}`;

  const sent = await twilioClient.messages.create({
    from,
    to,
    body: text,
  });

  console.log(`[WHATSAPP][twilio] Sent to ${toPhone} (sid=${sent.sid || "n/a"})`);
  return sent;
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
 * sendBillWhatsApp(bill, pdfPath, messageOverride)
 * - messageOverride expected plain-text (if provided)
 */
async function sendBillWhatsApp(bill, pdfPath = null, messageOverride = null) {
  const tenantPhoneRaw = bill?.tenant?.phone;
  if (!tenantPhoneRaw) {
    console.warn(`[WHATSAPP] Skipped for bill ${bill?._id}. Tenant phone missing`);
    return;
  }

  let tenantPhone = tenantPhoneRaw.trim();
  if (!tenantPhone.startsWith("+")) {
    const prefix = DEFAULT_COUNTRY_PREFIX || "+91";
    tenantPhone = `${prefix}${tenantPhone}`;
  }

  // prepare links
  const { downloadLink, paymentLink, stamp } = getBillLinks(bill);
  const message = messageOverride || templates.whatsappBody(bill, { downloadLink, paymentLink, stamp });

  // Try Twilio first
  if (twilioClient) {
    try {
      return await sendWhatsAppViaTwilio({ toPhone: tenantPhone, text: message });
    } catch (err) {
      console.error("[WHATSAPP] Twilio send failed:", err && (err.message || err));
      // fallthrough
    }
  }

  // fallback to Cloud API
  if (waCloudConfigured) {
    try {
      return await sendWhatsAppViaCloud({ toPhone: tenantPhone, text: message });
    } catch (err) {
      console.error("[WHATSAPP] Cloud send failed:", err && (err.message || err));
      throw err;
    }
  }

  console.warn("[WHATSAPP] No provider configured (Twilio/Cloud). Skipped sending.");
  return;
}

/* ---------------- Combined helper ----------------
   sendBill: queue email + fire whatsapp (best-effort)
*/
async function sendBill(bill, pdfPath = null, subject = null, message = null) {
  // queue email (non-blocking) and attempt whatsapp
  try {
    sendBillEmail(bill, pdfPath, subject, message).catch((e) => {
      console.warn("[EMAIL] queued send failed:", e && e.message ? e.message : e);
    });
  } catch (e) {
    console.warn("[EMAIL] failed to queue email:", e && e.message ? e.message : e);
  }

  try {
    await sendBillWhatsApp(bill, pdfPath, message);
  } catch (e) {
    console.warn("[WHATSAPP] failed to send:", e && e.message ? e.message : e);
  }
}

// Exports
module.exports = {
  sendBill,
  sendBillEmail,
  sendBillWhatsApp,
  _sendBillEmailNow, // immediate send used in some controller flows
  _removePendingEmailsForBill,
  // expose config for debugging
  _config: {
    twilioConfigured,
    waCloudConfigured,
    backendBase,
    frontendBase,
  },
};
