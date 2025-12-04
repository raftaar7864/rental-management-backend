// backend/src/services/notificationService.js
/**
 * Notification service
 * - Email via sendEmail (../utils/email)
 * - WhatsApp via Twilio Template (contentSid)
 * - Email queue with simple throttling
 *
 * Exports:
 *  - sendBill(bill, pdfPath, subject, message)
 *  - sendBillEmail(bill, pdfPath, subject, message)
 *  - sendBillWhatsApp(bill, pdfPath)
 *  - _sendBillEmailNow(bill, pdfPath, subject, message)
 *  - _removePendingEmailsForBill(billId)
 *  - _config -> debug info
 */

const Twilio = require("twilio");
const templates = require("../utils/notificationTemplete");
const { sendEmail } = require("../utils/email");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  TWILIO_TEMPLATE_SID,
  FRONTEND_URL,
  BACKEND_URL,
  DEFAULT_COUNTRY_PREFIX,
} = process.env;

const backendBase = (BACKEND_URL || FRONTEND_URL || "http://localhost:5000").trim().replace(/\/$/, "");
const frontendBase = (FRONTEND_URL || BACKEND_URL || "http://localhost:3000").trim().replace(/\/$/, "");

// Twilio client if configured
let twilioClient = null;
const twilioConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM && TWILIO_TEMPLATE_SID);
if (twilioConfigured) {
  try {
    twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("[WHATSAPP] Twilio configured");
  } catch (err) {
    console.warn("[WHATSAPP] Twilio init failed:", err?.message || err);
    twilioClient = null;
  }
} else {
  console.log("[WHATSAPP] Twilio not fully configured");
}

// ---------------- Email queue ----------------
let emailQueue = [];
let emailProcessing = false;

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

function _removePendingEmailsForBill(billId) {
  try {
    const idStr = billId?.toString ? billId.toString() : String(billId);
    emailQueue = emailQueue.filter((item) => {
      const qId = _normalizeBillId(item.bill) || (item.billId ? String(item.billId) : null);
      return qId !== idStr;
    });
    console.log(`[EMAIL] Removed pending queued emails for bill ${idStr}`);
  } catch (err) {
    console.warn("[EMAIL] _removePendingEmailsForBill failed:", err?.message || err);
  }
}

async function processEmailQueue() {
  if (emailProcessing || emailQueue.length === 0) return;
  emailProcessing = true;

  const { bill, pdfPath, resolve, reject, subject, message } = emailQueue.shift();

  try {
    await _sendBillEmailNow(bill, pdfPath, subject, message);
    resolve?.();
  } catch (err) {
    reject?.(err);
  }

  emailProcessing = false;
  if (emailQueue.length > 0) {
    setTimeout(processEmailQueue, 400);
  }
}

function getBillLinks(bill) {
  const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
  const stamp = bill?.updatedAt ? new Date(bill.updatedAt).getTime() : Date.now();
  const downloadLink = `${R2_PUBLIC_URL}/bills/bill_${bill._id}.pdf?v=${stamp}`;
  const isPaid = (bill.paymentStatus || bill.status || "").toLowerCase() === "paid";
  const paymentLink = isPaid ? "" : `${frontendBase}/payment/public/${bill._id}?v=${stamp}`;
  return { downloadLink, paymentLink, stamp, isPaid };
}

// ---------------- Email ----------------
async function _sendBillEmailNow(bill, pdfPath = null, subject = null, message = null) {
  if (typeof sendEmail !== "function") {
    throw new Error("sendEmail util not available");
  }

  const tenantEmail = bill?.tenant?.email;
  if (!tenantEmail) return console.warn(`[EMAIL] No tenant email for bill ${bill?._id}`);

  const { downloadLink, paymentLink, stamp } = getBillLinks(bill);

  const finalSubject = subject || templates.emailSubject(bill, { downloadLink, paymentLink, stamp });
  const finalHtml = message || templates.emailHtml(bill, { downloadLink, paymentLink, stamp });
  const safeHtml = finalHtml || `<p>Please view your bill: <a href="${downloadLink}">Download PDF</a></p>`;
  const safeText = `Your bill is available: ${downloadLink}` + (paymentLink ? `\nPay: ${paymentLink}` : "");

  try {
    console.log(`[EMAIL] Sending immediate email to ${tenantEmail} for bill ${bill._id}`);
    await sendEmail(tenantEmail, finalSubject, safeText, safeHtml);
    console.log(`[EMAIL] Sent immediate email to ${tenantEmail}`);
  } catch (err) {
    console.error("[EMAIL] Failed to send email:", err?.response?.body || err?.message || err);
    throw err;
  }
}

function sendBillEmail(bill, pdfPath = null, subject = null, message = null) {
  return new Promise((resolve, reject) => {
    emailQueue.push({ bill, pdfPath, resolve, reject, subject, message });
    setImmediate(processEmailQueue);
  });
}

// ---------------- WhatsApp ----------------
function formattedMonth(bill) {
  if (!bill?.billingMonth) return "-";
  return new Date(bill.billingMonth).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function safeRoomNumber(bill) {
  return bill?.room?.number || "N/A";
}

function getActionText(bill) {
  const status = (bill.paymentStatus || bill.status || "").toLowerCase();
  if (status === "paid") return "Paid Successfully";

  // If bill has updatedAt > createdAt → updated
  if (bill.createdAt && bill.updatedAt) {
    if (new Date(bill.updatedAt).getTime() - new Date(bill.createdAt).getTime() > 2000) {
      return "Updated";
    }
  }

  return "Generated";
}

async function sendBillWhatsApp(bill) {
  if (!twilioClient) {
    console.warn("[WHATSAPP] Twilio client not configured");
    return;
  }

  const tenantPhoneRaw = bill?.tenant?.phone;
  if (!tenantPhoneRaw) {
    console.warn(`[WHATSAPP] Skipped for bill ${bill?._id}. Tenant phone missing`);
    return;
  }

  let tenantPhone = tenantPhoneRaw.trim();
  if (!tenantPhone.startsWith("+")) {
    tenantPhone = `${DEFAULT_COUNTRY_PREFIX || "+91"}${tenantPhone}`;
  }

  const { downloadLink, paymentLink, isPaid } = getBillLinks(bill);
  const billStatus = isPaid ? "Status: Paid ✅" : "Status: Not Paid ❌";
  const actionText = getActionText(bill); 
  // ----------------------------------------
  const variables = {
    "1": String(bill.tenant?.fullName || "-"),
    "2": String(formattedMonth(bill) || "-"),
    "3": String(actionText || "-"),
    "4": String(bill.tenant?.tenantId || "-"),
    "5": String(safeRoomNumber(bill) || "-"),
    "6": String(bill.totalAmount ?? "-"),
    "7": String(billStatus || "-"),
    "8": String(isPaid ? "-" : paymentLink || "-"),
    "9": String(downloadLink || "-")
  };


  const payload = {
    from: `whatsapp:${TWILIO_WHATSAPP_FROM}`,
    to: `whatsapp:${tenantPhone}`,
    contentSid: process.env.TWILIO_TEMPLATE_SID,
    contentVariables: JSON.stringify(variables)
  };

  try {
    const res = await twilioClient.messages.create(payload);
    console.log(`[WHATSAPP] Sent WhatsApp to ${tenantPhone} (SID: ${res.sid})`);
    return res;
  } catch (err) {
    console.error("[WHATSAPP] Failed to send template:", err?.message || err);
    throw err;
  }
}

// ---------------- Combined helper ----------------
async function sendBill(bill, pdfPath = null, subject = null, message = null) {
  try {
    sendBillEmail(bill, pdfPath, subject, message).catch(e => {
      console.warn("[EMAIL] queued send failed:", e?.message || e);
    });
  } catch (e) {
    console.warn("[EMAIL] failed to queue email:", e?.message || e);
  }

  try {
    await sendBillWhatsApp(bill, pdfPath);
  } catch (e) {
    console.warn("[WHATSAPP] failed to send:", e?.message || e);
  }
}

// ---------------- Exports ----------------
module.exports = {
  sendBill,
  sendBillEmail,
  sendBillWhatsApp,
  _sendBillEmailNow,
  _removePendingEmailsForBill,
  _config: {
    twilioConfigured,
    backendBase,
    frontendBase,
  },
};
