// backend/src/utils/notificationTemplete.js
// Centralized templates for emails and WhatsApp messages used by notificationService.
//
// Exported helpers:
//   emailSubject(bill, opts) -> string
//   emailHtml(bill, opts) -> string (HTML)
//   whatsappBody(bill, opts) -> string (plain text)
//
// opts may contain { downloadLink, paymentLink, stamp, extraMessage }

const COMPANY_NAME = process.env.COMPANY_NAME || "Your Company";
const COMPANY_LOGO = process.env.COMPANY_LOGO_URL || ""; // absolute URL if available
const COMPANY_BANK = process.env.COMPANY_BANK_DETAILS || "";
const COMPANY_GST = process.env.COMPANY_GST || "";
const DEFAULT_FROM = process.env.FROM_EMAIL || process.env.SMTP_USER || "no-reply@example.com";

function safe(fn, fallback = "-") {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function safeTenantId(bill) {
  const t = bill && bill.tenant;
  if (!t) return "N/A";
  return t.tenantId || (t._id ? String(t._id) : "N/A");
}

function safeRoomNumber(bill) {
  return bill?.room?.number || "N/A";
}

function formattedMonth(bill) {
  try {
    if (!bill || !bill.billingMonth) return "-";
    return new Date(bill.billingMonth).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } catch {
    return "-";
  }
}

function formatCurrency(n) {
  const num = Number(n || 0);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(num);
  } catch {
    return `₹${num.toFixed(2)}`;
  }
}

function defaultLinks(bill, stamp) {
  const s = stamp || (bill && bill.updatedAt ? (new Date(bill.updatedAt)).getTime() : Date.now());
  const backend = (process.env.BACKEND_URL || "http://localhost:5000").replace(/\/$/, "");
  const frontend = (process.env.FRONTEND_URL || backend).replace(/\/$/, "");
  return {
    downloadLink: `${backend}/api/bills/${bill._id}/pdf?v=${s}`,
    paymentLink: bill.paymentLink && /^https?:\/\//i.test(bill.paymentLink) ? bill.paymentLink : `${frontend}/payment/public/${bill._id}?v=${s}`,
    stamp: s,
  };
}

function emailSubject(bill, opts = {}) {
  const month = formattedMonth(bill);
  return opts.subject || `Rent Bill • ${month} • ${bill.building?.name || COMPANY_NAME} • Room ${safeRoomNumber(bill)}`;
}

function chargesHtml(bill) {
  if (!Array.isArray(bill.charges) || bill.charges.length === 0) return "";
  const rows = bill.charges.map(c => `<tr>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;">${c.title || "Charge"}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${formatCurrency(c.amount)}</td>
  </tr>`).join("");
  return `
    <table width="100%" style="border-collapse:collapse;margin-top:6px;">
      ${rows}
    </table>
  `;
}

function emailHtml(bill, opts = {}) {
  if (!bill) return "<p>Bill information not available</p>";
  const { downloadLink, paymentLink, stamp } = opts.downloadLink ? { downloadLink: opts.downloadLink, paymentLink: opts.paymentLink, stamp: opts.stamp } : defaultLinks(bill, opts.stamp);
  const month = formattedMonth(bill);
  const tenantId = safeTenantId(bill);
  const roomNumber = safeRoomNumber(bill);
  const isPaid = (bill.paymentStatus || bill.status || "").toString().toLowerCase() === "paid";
  const paidInfo = isPaid
    ? `<p style="margin:8px 0;"><strong>Status:</strong> <span style="color:green">PAID ✅</span></p>
       <p style="margin:4px 0;"><strong>Reference:</strong> ${bill.payment?.reference || "N/A"}</p>
       <p style="margin:4px 0;"><strong>Method:</strong> ${bill.payment?.method || "N/A"}</p>
       <p style="margin:4px 0;"><strong>Paid At:</strong> ${bill.payment?.paidAt ? new Date(bill.payment.paidAt).toLocaleString() : "N/A"}</p>`
    : `<p style="margin:8px 0;"><strong>Payment Status:</strong> <span style="color:#c00">Unpaid ❌</span></p>`;

  const payOnlineHtml = !isPaid ? `<p style="margin:12px 0;">
    <a href="${paymentLink}" style="display:inline-block;background:#007bff;color:white;padding:10px 18px;border-radius:6px;text-decoration:none;">💳 Pay Now</a>
  </p>` : "";

  const logoHtml = COMPANY_LOGO ? `<img src="${COMPANY_LOGO}" alt="${COMPANY_NAME}" style="max-height:48px;display:block;margin-bottom:8px;">` : `<h2 style="margin:0 0 8px 0;">${COMPANY_NAME}</h2>`;

  const bankHtml = COMPANY_BANK ? `<p style="margin:8px 0;"><strong>Bank details:</strong><br/>${COMPANY_BANK}</p>` : "";
  const gstHtml = COMPANY_GST ? `<p style="margin:4px 0;"><strong>GST:</strong> ${COMPANY_GST}</p>` : "";

  const notesHtml = bill.notes ? `<p style="margin:8px 0;"><strong>Notes:</strong> ${bill.notes}</p>` : "";

  const chargesTable = chargesHtml(bill);

  return `
  <div style="font-family: Arial, Helvetica, sans-serif; color:#111; line-height:1.4; max-width:680px; margin:0 auto; padding:18px;">
    <div style="display:flex; align-items:center; gap:12px;">
      <div style="flex:0 0 auto;">${logoHtml}</div>
      <div style="flex:1;">
        <div style="font-size:14px;color:#6b7280;">${COMPANY_NAME}</div>
        <div style="font-weight:600;font-size:16px;">Invoice • ${month}</div>
      </div>
    </div>

    <hr style="border:none;border-top:1px solid #eee;margin:12px 0;"/>

    <p style="margin:6px 0;">Dear <strong>${bill.tenant?.fullName || "Tenant"}</strong>,</p>
    <p style="margin:6px 0;">Your rent bill for <strong>${month}</strong> is ready.</p>

    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:8px;">
      <div style="flex:1;min-width:200px;">
        <p style="margin:6px 0;"><strong>Your ID:</strong> ${tenantId}</p>
        <p style="margin:6px 0;"><strong>Room:</strong> ${roomNumber}</p>
      </div>
      <div style="flex:1;min-width:200px;">
        <p style="margin:6px 0;"><strong>Total:</strong> ${formatCurrency(bill.totalAmount)}</p>
        ${isPaid ? `<p style="margin:6px 0;color:green;font-weight:600;">PAID</p>` : ""}
      </div>
    </div>

    ${chargesTable}
    ${paidInfo}
    ${payOnlineHtml}

    <p style="margin:8px 0;">Download Bill: <a href="${downloadLink}">Download PDF</a></p>

    ${notesHtml}

    ${bankHtml}
    ${gstHtml}

    <hr style="border:none;border-top:1px solid #f0f0f0;margin:16px 0;"/>

    <p style="color:#6b7280;font-size:13px;margin:6px 0;">This is an automated message from ${COMPANY_NAME}. For support, reply to ${DEFAULT_FROM}.</p>
  </div>
  `;
}

function whatsappBody(bill, opts = {}) {
  if (!bill) return "Bill information not available";
  const { downloadLink, paymentLink, stamp } = opts.downloadLink ? { downloadLink: opts.downloadLink, paymentLink: opts.paymentLink, stamp: opts.stamp } : defaultLinks(bill, opts.stamp);
  const month = formattedMonth(bill);
  const tenantId = safeTenantId(bill);
  const roomNumber = safeRoomNumber(bill);
  const isPaid = (bill.paymentStatus || bill.status || "").toString().toLowerCase() === "paid";

  const paidLines = isPaid
    ? `Payment Status: PAID ✅
Reference: ${bill.payment?.reference || "N/A"}
Method: ${bill.payment?.method || "N/A"}
Paid At: ${bill.payment?.paidAt ? new Date(bill.payment.paidAt).toLocaleString() : "N/A"}`
    : `Payment Status: Unpaid ❌
Pay Online: ${paymentLink}`;

  const lines = [
    `Dear ${bill.tenant?.fullName || "Tenant"},`,
    `Your rent bill for ${month} is ${formatCurrency(bill.totalAmount)}.`,
    ``,
    `Your ID: ${tenantId}`,
    `Room: ${roomNumber}`,
    ``,
    paidLines,
    ``,
    `Download Bill: ${downloadLink}`,
    ``,
    `Thank you!`,
  ];

  if (opts.extraMessage) lines.push("", opts.extraMessage);

  return lines.join("\n");
}

module.exports = {
  emailSubject,
  emailHtml,
  whatsappBody,
};
