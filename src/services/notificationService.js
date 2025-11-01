const nodemailer = require("nodemailer");
const path = require("path");
const Twilio = require("twilio");

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  FRONTEND_URL,
  BACKEND_URL,
  DEFAULT_COUNTRY_PREFIX,
} = process.env;

// ---------------- Config Setup ----------------
const smtpHost = SMTP_HOST?.trim();
const smtpPort = SMTP_PORT?.trim();
const smtpUser = SMTP_USER?.trim();
const smtpPass = SMTP_PASS?.trim();
const smtpSecure = SMTP_SECURE === "true";

const twilioAccountSid = TWILIO_ACCOUNT_SID?.trim();
const twilioAuthToken = TWILIO_AUTH_TOKEN?.trim();
const twilioFrom = TWILIO_WHATSAPP_FROM?.trim();

const backendBase = (process.env.BACKEND_URL || process.env.FRONTEND_URL || "http://localhost:5000").trim().replace(/\/$/, "");
const frontendBase = (process.env.FRONTEND_URL || process.env.BACKEND_URL || "http://localhost:3000").trim().replace(/\/$/, "");


// ---------------- Email setup ----------------
const emailConfigured = smtpHost && smtpPort && smtpUser && smtpPass;
if (!emailConfigured)
  console.warn("⚠️ Email config missing. Email notifications won't work.");

const transporter = emailConfigured
  ? nodemailer.createTransport({
      host: smtpHost,
      port: Number(smtpPort) || 587,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPass },
    })
  : null;

// ---------------- Twilio setup ----------------
const twilioConfigured = twilioAccountSid && twilioAuthToken && twilioFrom;
if (!twilioConfigured)
  console.warn("⚠️ Twilio config missing. WhatsApp notifications won't work.");

const twilioClient = twilioConfigured
  ? new Twilio(twilioAccountSid, twilioAuthToken)
  : null;

// ---------------- Email Queue ----------------
let emailQueue = [];
let emailProcessing = false;

function removePendingEmailsForBill(billId) {
  try {
    const idStr = billId?.toString ? billId.toString() : String(billId);
    emailQueue = emailQueue.filter((item) => {
      const qId =
        item?.bill?._id?.toString?.() || item?.bill?._id?.toString?.();
      return qId !== idStr;
    });
  } catch (err) {
    console.warn("removePendingEmailsForBill failed:", err?.message || err);
  }
}

async function processEmailQueue() {
  if (emailProcessing || emailQueue.length === 0) return;
  emailProcessing = true;

  const { bill, pdfPath, resolve, reject, subject, message } = emailQueue.shift();

  try {
    await sendBillEmailNow(bill, pdfPath, subject, message);
    resolve();
  } catch (err) {
    reject(err);
  }

  emailProcessing = false;
  if (emailQueue.length > 0) setTimeout(processEmailQueue, 500);
}

// ---------------- Helper: Normalize Links ----------------
function getBillLinks(bill) {
  const downloadLink = `${backendBase}/api/bills/${bill._id}/pdf`;

  // Always provide a valid frontend public payment URL
  let paymentLink = "";

  if (bill.paymentLink && /^https?:\/\//i.test(bill.paymentLink.trim())) {
    paymentLink = bill.paymentLink.trim();
  } else {
    // default: tenant payment public route
    paymentLink = `${frontendBase}/payment/public/${bill._id}`;
  }

  return { downloadLink, paymentLink };
}

// ---------------- Send Email ----------------
async function sendBillEmailNow(bill, pdfPath, subject, message) {
  if (!transporter) throw new Error("Email transporter not configured");

  const tenantEmail = bill.tenant?.email;
  if (!tenantEmail) {
    console.warn(`[EMAIL] No tenant email for bill ${bill._id}`);
    return;
  }

  try {
    const formattedMonth = new Date(bill.billingMonth).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });

    const isPaid = bill.paymentStatus === "Paid";
    const { downloadLink, paymentLink } = getBillLinks(bill);

    const tenantId = bill.tenant?.tenantId || "N/A";
    const roomNumber = bill.room?.number || "N/A";

    const paidInfo = isPaid
      ? `
        <p><strong>Status:</strong> PAID ✅</p><br>
        <p><strong>Reference:</strong> ${
          bill.payment?.reference || "N/A"
        }</p>
        <p><strong>Method:</strong> ${
          bill.payment?.method || "N/A"
        }</p>
        <strong>Paid At:</strong> ${
          bill.payment?.paidAt
            ? new Date(bill.payment.paidAt).toLocaleString()
            : "N/A"
        }</p>
      `
      : `<p><strong>Payment Status:</strong> Unpaid ❌</p>`;

    const payOnlineHtml = !isPaid
      ? `<p>
  <a href="${paymentLink}"
     style="background:#007bff;color:white;padding:8px 16px;
            border-radius:6px;text-decoration:none;">
     💳 Pay Now
  </a>
</p>`
      : "";

    const mailOptions = {
      from: smtpUser,
      to: tenantEmail,
      subject:
        subject ||
        `Rent Bill - ${formattedMonth} (${bill.building?.name || ""} Room ${roomNumber})`,
      html: `
        <p>Dear ${bill.tenant.fullName},</p>
        <p>Your rent bill for <strong>${formattedMonth}</strong> is ready.</p>
        <p><strong>Your ID:</strong> ${tenantId}<br>
        <strong>Room Number:</strong> ${roomNumber}</p>
        <ul>
          ${
            bill.charges
              ?.map((c) => `<li>${c.title}: ₹${c.amount}</li>`)
              .join("") || ""
          }
        </ul>
        <p><strong>Total: ₹${bill.totalAmount}</strong></p>
        ${paidInfo}
        <p>Download Bill: <a href="${downloadLink}">Download Bill</a></p>
        ${payOnlineHtml}
        <p>${message || "Thank you for staying with us."}</p>
      `,
      attachments: pdfPath
        ? [{ filename: `Bill_${bill._id}.pdf`, path: path.resolve(pdfPath) }]
        : [],
    };

    await transporter.sendMail(mailOptions);
    console.log(`[EMAIL] Bill sent to ${tenantEmail}`);
  } catch (err) {
    console.error(`[EMAIL] Failed to send bill to ${tenantEmail}:`, err.message);
    throw err;
  }
}

function sendBillEmail(bill, pdfPath, subject, message) {
  return new Promise((resolve, reject) => {
    emailQueue.push({ bill, pdfPath, resolve, reject, subject, message });
    processEmailQueue();
  });
}

// ---------------- WhatsApp ----------------
async function sendBillWhatsApp(bill, pdfPath, messageOverride) {
  const tenantPhoneRaw = bill.tenant?.phone;
  if (!tenantPhoneRaw) {
    console.warn(`[WHATSAPP] Skipped for bill ${bill._id}. Tenant phone missing`);
    return;
  }
  if (!twilioClient) {
    console.warn(`[WHATSAPP] Twilio client not configured.`);
    return;
  }

  let tenantPhone = tenantPhoneRaw.trim();
  if (!tenantPhone.startsWith("+")) {
    const prefix = DEFAULT_COUNTRY_PREFIX || "+91";
    tenantPhone = `${prefix}${tenantPhone}`;
  }

  const formattedMonth = new Date(bill.billingMonth).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const tenantId = bill.tenant?.tenantId || "N/A";
  const roomNumber = bill.room?.number || "N/A";
  const isPaid = bill.paymentStatus === "Paid";

  const { downloadLink, paymentLink } = getBillLinks(bill);

  const bodyMessage =
    messageOverride ||
    `Dear ${bill.tenant.fullName},
Your rent bill for ${formattedMonth} is ₹${bill.totalAmount}.

Your ID: ${tenantId}
Room Number: ${roomNumber}
Payment Status: ${isPaid ? "PAID ✅" : "Unpaid ❌"}
${isPaid ? `Payment Reference: ${bill.payment?.reference || "N/A"}\nPaid At: ${bill.payment?.paidAt ? new Date(bill.payment.paidAt).toLocaleString() : "N/A"}` : ""}
Download Bill: ${downloadLink}
${!isPaid ? `Pay Online: ${paymentLink}` : ""}`;

  try {
    const result = await twilioClient.messages.create({
      from: `whatsapp:${twilioFrom}`,
      to: `whatsapp:${tenantPhone}`,
      body: bodyMessage,
    });

    console.log(`[WHATSAPP] Bill sent to ${tenantPhone}. SID: ${result.sid}`);
    return result;
  } catch (err) {
    console.error(
      `[WHATSAPP] Failed to send bill to ${tenantPhone}:`,
      err?.message || err
    );
  }
}

// ---------------- Combined ----------------
async function sendBill(bill, pdfPath, subject, message) {
  await sendBillEmail(bill, pdfPath, subject, message);
  await sendBillWhatsApp(bill, pdfPath, message);
}

module.exports = {
  sendBill,
  sendBillEmail,
  sendBillWhatsApp,
  _sendBillEmailNow: sendBillEmailNow,
  _removePendingEmailsForBill: removePendingEmailsForBill,
};
