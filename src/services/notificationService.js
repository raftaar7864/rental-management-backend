// backend/src/services/notificationService.js
const nodemailer = require("nodemailer");
const path = require("path");
const axios = require("axios");
const Twilio = require("twilio");
const templates = require("../utils/notificationTemplete");

// env
const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
  FROM_EMAIL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  WHATSAPP_CLOUD_API_TOKEN,
  WHATSAPP_PHONE_ID,
  FRONTEND_URL,
  BACKEND_URL,
  DEFAULT_COUNTRY_PREFIX,
} = process.env;

// ---------------- Config Setup ----------------
const smtpHost = SMTP_HOST?.trim();
const smtpPort = SMTP_PORT?.trim();
const smtpUser = SMTP_USER?.trim();
const smtpPass = SMTP_PASS?.trim();
const smtpSecure = String(SMTP_SECURE || "false").toLowerCase() === "true";

const twilioAccountSid = TWILIO_ACCOUNT_SID?.trim();
const twilioAuthToken = TWILIO_AUTH_TOKEN?.trim();
const twilioFrom = TWILIO_WHATSAPP_FROM?.trim();

const backendBase = (BACKEND_URL || FRONTEND_URL || "http://localhost:5000").trim().replace(/\/$/, "");
const frontendBase = (FRONTEND_URL || BACKEND_URL || "http://localhost:3000").trim().replace(/\/$/, "");

// ---------------- Email setup ----------------
const emailConfigured = Boolean(smtpHost && smtpPort && smtpUser && smtpPass);
if (!emailConfigured) console.warn("⚠️ Email config missing. Email notifications won't work.");

const transporter = emailConfigured
  ? nodemailer.createTransport({
      host: smtpHost,
      port: Number(smtpPort) || 587,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPass },
    })
  : null;

if (transporter && typeof transporter.verify === "function") {
  transporter.verify().then(() => console.log("[EMAIL] SMTP transporter verified")).catch((err) => {
    console.warn("[EMAIL] SMTP transporter verification failed:", err && err.message ? err.message : err);
  });
}

// ---------------- Twilio / WhatsApp Cloud API setup ----------------
const twilioConfigured = Boolean(twilioAccountSid && twilioAuthToken && twilioFrom);
let twilioClient = null;
if (twilioConfigured) {
  try {
    twilioClient = new Twilio(twilioAccountSid, twilioAuthToken);
    console.log("[WHATSAPP] Twilio configured (will use Twilio for WhatsApp).");
  } catch (err) {
    console.warn("[WHATSAPP] Twilio client construction failed:", err && err.message ? err.message : err);
    twilioClient = null;
  }
} else {
  console.log("[WHATSAPP] Twilio not configured.");
}

const waCloudConfigured = Boolean(WHATSAPP_CLOUD_API_TOKEN && WHATSAPP_PHONE_ID);
if (waCloudConfigured) {
  console.log("[WHATSAPP] WhatsApp Cloud API configured (fallback available).");
} else {
  console.log("[WHATSAPP] WhatsApp Cloud API not configured.");
}

// ---------------- Email queue ----------------
let emailQueue = [];
let emailProcessing = false;

function _normalizeBillId(b) {
  try {
    return b?._id ? String(b._id) : b?.bill?._id ? String(b.bill._id) : null;
  } catch {
    return null;
  }
}

function _removePendingEmailsForBill(billId) {
  try {
    const idStr = billId?.toString ? billId.toString() : String(billId);
    emailQueue = emailQueue.filter((item) => {
      const qId = _normalizeBillId(item.bill) || (item.billId ? String(item.billId) : null);
      return qId !== idStr;
    });
    console.log(`[EMAIL] Removed pending queued emails for bill ${idStr}`);
  } catch (err) {
    console.warn("[EMAIL] removePendingEmailsForBill failed:", err && err.message ? err.message : err);
  }
}

async function processEmailQueue() {
  if (emailProcessing || emailQueue.length === 0) return;
  emailProcessing = true;

  const { bill, pdfPath, resolve, reject, subject, message } = emailQueue.shift();

  try {
    await sendBillEmailNow(bill, pdfPath, subject, message);
    resolve && resolve();
  } catch (err) {
    reject && reject(err);
  }

  emailProcessing = false;
  if (emailQueue.length > 0) {
    // throttle - 500ms between sends (tunable)
    setTimeout(processEmailQueue, 500);
  }
}

// ---------------- Helper: getBillLinks (versioned) ----------------
function getBillLinks(bill) {
  const stamp = (bill && bill.updatedAt) ? (new Date(bill.updatedAt)).getTime() : Date.now();
  const downloadLink = `${backendBase}/api/bills/${bill._id}/pdf?v=${stamp}`;
  const paymentLink = bill.paymentLink && /^https?:\/\//i.test(bill.paymentLink)
    ? bill.paymentLink
    : `${frontendBase}/payment/public/${bill._id}?v=${stamp}`;
  return { downloadLink, paymentLink, stamp };
}

// ---------------- Send Email (immediate) ----------------
/**
 * sendBillEmailNow(bill, pdfPath, subject, message)
 * - bill: Bill object (populated with tenant)
 * - pdfPath: optional local filesystem path to attach
 * - subject/message: optional override strings
 *
 * Behavior:
 * - If pdfPath provided -> attaches local file.
 * - Else if bill.pdfUrl present -> tries to download that URL and attach buffer.
 * - If attachment not available, still sends email with download link embedded in template.
 */
async function sendBillEmailNow(bill, pdfPath, subject, message) {
  if (!transporter) {
    const msg = "Email transporter not configured";
    console.warn("[EMAIL] " + msg);
    throw new Error(msg);
  }
  const tenantEmail = bill?.tenant?.email;
  if (!tenantEmail) {
    console.warn(`[EMAIL] No tenant email for bill ${bill?._id}`);
    return;
  }

  // prepare links for templates (and attach stamp)
  const { downloadLink, paymentLink, stamp } = getBillLinks(bill);

  // use templates if subject/message not provided
  const finalSubject = subject || templates.emailSubject(bill, { downloadLink, paymentLink, stamp });
  const finalHtml = message || templates.emailHtml(bill, { downloadLink, paymentLink, stamp });

  const from = FROM_EMAIL || smtpUser || process.env.FROM_EMAIL || "no-reply@example.com";

  // Build attachments array:
  // 1) If local pdfPath passed -> attach local file (existing behavior)
  // 2) Else if bill.pdfUrl exists -> try download and attach as buffer
  // 3) Else -> no attachment (email still contains downloadLink in HTML)
  let attachments = [];

  if (pdfPath) {
    // ensure resolved path
    attachments.push({ filename: `Bill_${bill._id}.pdf`, path: path.resolve(pdfPath) });
  } else if (bill && bill.pdfUrl) {
    try {
      // attempt to fetch PDF from the provided URL (supports signed URLs / R2 public URLs)
      const resp = await axios.get(bill.pdfUrl, {
        responseType: "arraybuffer",
        timeout: 15000, // 15s timeout
        maxContentLength: 50 * 1024 * 1024, // 50MB cap (tunable)
      });

      const contentType = resp.headers["content-type"] || "application/pdf";
      const buffer = Buffer.from(resp.data);

      // Only attach if we got a non-empty buffer
      if (buffer && buffer.length > 0) {
        attachments.push({
          filename: `Bill_${bill._id}.pdf`,
          content: buffer,
          contentType,
        });
        console.log(`[EMAIL] Attached PDF from remote URL for bill ${bill._id}`);
      } else {
        console.warn(`[EMAIL] Remote PDF fetch returned empty for bill ${bill._id}`);
      }
    } catch (err) {
      console.warn(`[EMAIL] Failed to fetch/attach remote PDF from bill.pdfUrl for bill ${bill._id}:`, err && err.message ? err.message : err);
      // continue without attachment; HTML still contains downloadLink
    }
  } else {
    // nothing to attach
  }

  const mailOptions = {
    from,
    to: tenantEmail,
    subject: finalSubject,
    html: finalHtml,
    attachments,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[EMAIL] Sent bill to ${tenantEmail} (messageId=${info && info.messageId ? info.messageId : "n/a"})`);
    return info;
  } catch (err) {
    console.error(`[EMAIL] Failed to send bill to ${tenantEmail}:`, err && err.message ? err.message : err);
    throw err;
  }
}

function sendBillEmail(bill, pdfPath, subject, message) {
  return new Promise((resolve, reject) => {
    emailQueue.push({ bill, pdfPath, resolve, reject, subject, message });
    // kick off processing (if not already)
    setImmediate(processEmailQueue);
  });
}

// ---------------- WhatsApp senders ----------------
async function sendWhatsAppViaTwilio({ toPhone, text }) {
  if (!twilioClient) throw new Error("Twilio client not configured");
  if (!twilioFrom) throw new Error("TWILIO_WHATSAPP_FROM is not set");

  const from = `whatsapp:${twilioFrom}`;
  const to = toPhone.startsWith("whatsapp:") ? toPhone : `whatsapp:${toPhone}`;

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
 * Public: sendBillWhatsApp(bill, pdfPath, messageOverride)
 * - If messageOverride not provided, uses templates.whatsappBody(bill)
 * - Includes downloadLink/paymentLink via getBillLinks
 */
async function sendBillWhatsApp(bill, pdfPath, messageOverride) {
  const tenantPhoneRaw = bill?.tenant?.phone;
  if (!tenantPhoneRaw) {
    console.warn(`[WHATSAPP] Skipped for bill ${bill?._id}. Tenant phone missing`);
    return;
  }

  let tenantPhone = tenantPhoneRaw.trim();
  if (!tenantPhone.startsWith("+")) {
    const prefix = DEFAULT_COUNTRY_PREFIX || "+91";
    // allow passing already formatted numbers with country code
    tenantPhone = `${prefix}${tenantPhone}`;
  }

  // prepare download/payment link and pass to template (so whatsapp template contains correct link)
  const { downloadLink, paymentLink, stamp } = getBillLinks(bill);
  const body = messageOverride || templates.whatsappBody(bill, { downloadLink, paymentLink, stamp });

  // Prefer Twilio, fallback to WhatsApp Cloud API
  if (twilioClient) {
    try {
      return await sendWhatsAppViaTwilio({ toPhone: tenantPhone, text: body });
    } catch (err) {
      console.error("[WHATSAPP] Twilio send failed:", err && err.message ? err.message : err);
      // fall through to cloud option if configured
    }
  }

  if (waCloudConfigured) {
    try {
      return await sendWhatsAppViaCloud({ toPhone: tenantPhone, text: body });
    } catch (err) {
      console.error("[WHATSAPP] Cloud API send failed:", err && err.message ? err.message : err);
      throw err;
    }
  }

  console.warn("[WHATSAPP] No provider configured (Twilio/WhatsApp Cloud). Skipped sending.");
  return;
}

// ---------------- Combined ----------------
async function sendBill(bill, pdfPath, subject, message) {
  // push email to queue and fire whatsapp (both best-effort)
  await sendBillEmail(bill, pdfPath, subject, message);
  await sendBillWhatsApp(bill, pdfPath, message);
}

module.exports = {
  sendBill,
  sendBillEmail,
  sendBillWhatsApp,
  _sendBillEmailNow: sendBillEmailNow,
  _removePendingEmailsForBill,
  // expose config for debugging
  _config: {
    emailConfigured,
    twilioConfigured,
    waCloudConfigured,
    backendBase,
    frontendBase,
  },
};
