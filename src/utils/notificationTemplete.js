// backend/src/utils/notificationTemplete.js
// Email templates + WhatsApp variables for Twilio Content SID

const COMPANY_NAME = process.env.COMPANY_NAME || "Your Company";
const COMPANY_LOGO = process.env.COMPANY_LOGO_URL || "";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "") || "";
const FRONTEND_URL = process.env.FRONTEND_URL?.replace(/\/$/, "") || "";

/* -----------------------------------------------------
   BASIC HELPERS
------------------------------------------------------ */
function safeRoomNumber(bill) {
  return bill?.room?.number || "N/A";
}

function formattedMonth(bill) {
  if (!bill?.billingMonth) return "-";
  return new Date(bill.billingMonth).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function formatCurrency(n) {
  const num = Number(n ?? 0);
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `₹${num.toFixed(2)}`;
  }
}

function defaultLinks(bill, stamp) {
  const s = stamp || Date.now();
  const isPaid = (bill.paymentStatus || bill.status || "").toLowerCase() === "paid";

  return {
    downloadLink: `${R2_PUBLIC_URL}/bills/bill_${bill._id}.pdf?v=${s}`,
    paymentLink: isPaid ? "" : `${FRONTEND_URL}/payment/public/${bill._id}?v=${s}`,
    stamp: s,
    isPaid,
  };
}

/* -----------------------------------------------------
   SUBJECT LINES
------------------------------------------------------ */
function subjectForType(bill, type) {
  const month = formattedMonth(bill);
  const room = safeRoomNumber(bill);

  if (type === "created") return `🆕 New Bill • ${month} • Room ${room}`;
  if (type === "updated") return `✏️ Updated Bill • ${month} • Room ${room}`;
  return `✅ Payment Confirmed • ${month} • Room ${room}`;
}

function emailSubject(bill, opts = {}) {
  const status = (bill.paymentStatus || bill.status || "").toLowerCase();
  const type = opts.type || (status === "paid" ? "paid" : "created");
  return subjectForType(bill, type);
}

/* -----------------------------------------------------
   CHARGES TABLE (EMAIL ONLY)
------------------------------------------------------ */
function chargesHtml(bill) {
  if (!Array.isArray(bill.charges) || bill.charges.length === 0) return "";
  return `
    <table width="100%" style="border-collapse:collapse;margin-top:8px;background:#fafafa;">
      ${bill.charges
        .map(
          (c) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${c.title || "Charge"}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${formatCurrency(c.amount)}</td>
      </tr>`
        )
        .join("")}
    </table>
  `;
}

/* -----------------------------------------------------
   EMAIL HTML BODY
------------------------------------------------------ */
function emailHtml(bill, opts = {}) {
  if (!bill) return "<p>Bill info missing</p>";

  const { downloadLink, paymentLink, isPaid } = opts.downloadLink ? opts : defaultLinks(bill, opts.stamp);

  const status = (bill.paymentStatus || bill.status || "").toLowerCase();
  const type = opts.type || (status === "paid" ? "paid" : "created");

  const month = formattedMonth(bill);

  const heading =
    type === "created"
      ? "New Invoice Generated"
      : type === "updated"
      ? "Invoice Updated"
      : "Payment Confirmation";

  const introText =
    type === "created"
      ? "A new rent invoice has been generated."
      : type === "updated"
      ? "Your rent invoice has been updated."
      : "Your payment has been successfully received.";

  const logoHtml = COMPANY_LOGO
    ? `<img src="${COMPANY_LOGO}" style="max-height:50px;">`
    : `<h2 style="margin:0;">${COMPANY_NAME}</h2>`;

  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f5;padding:20px;font-family:Arial,sans-serif;">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" width="100%" 
        style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;
        box-shadow:0 4px 12px rgba(0,0,0,0.08);">

        <tr>
          <td style="background:#0d6efd;padding:18px;text-align:center;color:white;">
            ${logoHtml}
          </td>
        </tr>

        <tr><td style="padding:24px;color:#222;font-size:15px;">
          <h3 style="margin:0 0 12px;">${heading} • ${month}</h3>

          <p><strong>Dear ${bill.tenant?.fullName || "Tenant"}</strong>,<br>${introText}</p>

          <p>Your rent amount is <strong>${formatCurrency(bill.totalAmount)}</strong></p>

          ${chargesHtml(bill)}

          <div style="margin:20px 0;text-align:center;">
            ${!isPaid && paymentLink
              ? `<a href="${paymentLink}" target="_blank"
              style="background:#28a745;color:#fff;text-decoration:none;
              padding:12px 22px;border-radius:6px;font-weight:bold;
              display:inline-block;margin-right:10px;">
              💳 Pay Now
            </a>`
              : ""}
            <a href="${downloadLink}" target="_blank"
              style="background:#0d6efd;color:#fff;text-decoration:none;
              padding:12px 22px;border-radius:6px;font-weight:bold;
              display:inline-block;">
              📄 Download Bill
            </a>
          </div>

        </td></tr>

        <tr>
          <td style="background:#0d6efd;padding:12px;text-align:center;font-size:12px;color:#fff;">
            © ${new Date().getFullYear()} ${COMPANY_NAME}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
  `;
}

/* -----------------------------------------------------
   WHATSAPP VARIABLES (Twilio Content SID)
------------------------------------------------------ */
function whatsappBody(bill) {
  if (!bill) return {};

  const { downloadLink, paymentLink, isPaid } = defaultLinks(bill);

  // Determine bill status text
  const billStatus = isPaid ? "Status: Paid ✅" : "Status: Not Paid ❌";

  // Determine action (Generated / Updated / Paid Successfully)
  let actionText = "generated";
  if ((bill.paymentStatus || bill.status || "").toLowerCase() === "paid") actionText = "paid successfully";
  else if (bill.updatedAt && bill.createdAt && new Date(bill.updatedAt) - new Date(bill.createdAt) > 2000) actionText = "updated";

  // Map variables safely
  return {
    "1": String(bill.tenant?.fullName || "-"),
    "2": String(formattedMonth(bill) || "-"),
    "3": String(actionText),
    "4": String(bill.tenant?.tenantId || "-"),
    "5": String(safeRoomNumber(bill)),
    "6": String(bill.totalAmount ?? "-"),
    "7": String(billStatus),
    "8": isPaid ? "-" : String(paymentLink),
    "9": String(downloadLink),
  };
}

/* -----------------------------------------------------
   EXPORTS
------------------------------------------------------ */
module.exports = {
  emailSubject,
  emailHtml,
  whatsappBody,

  // utility functions
  formattedMonth,
  safeRoomNumber,
  defaultLinks,
};
