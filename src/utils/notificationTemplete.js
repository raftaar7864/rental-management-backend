// backend/src/utils/notificationTemplete.js
// Improved subjects + professional email body text with distinct headings for Created / Updated / Paid

const COMPANY_NAME = process.env.COMPANY_NAME || "Your Company";
const COMPANY_LOGO = process.env.COMPANY_LOGO_URL || "";
const COMPANY_BANK = process.env.COMPANY_BANK_DETAILS || "";
const COMPANY_GST = process.env.COMPANY_GST || "";
const DEFAULT_FROM = process.env.FROM_EMAIL || "no-reply@example.com";

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";

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
  const num = Number(n || 0);
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
    paymentLink: isPaid
      ? null
      : `${process.env.FRONTEND_URL?.replace(/\/$/, "")}/payment/public/${bill._id}?v=${s}`,
    stamp: s,
  };
}

/* ---------------- Subject helpers (distinct headings) ---------------- */
function subjectForType(bill, type) {
  const month = formattedMonth(bill);
  const room = safeRoomNumber(bill);
  if (type === "created") return `🆕 New Bill Generated • ${month} • Room ${room}`;
  if (type === "updated") return `✏️ Bill Updated • ${month} • Room ${room}`;
  // paid (default)
  return `✅ Payment Confirmed • ${month} • Room ${room}`;
}

// backwards-compatible emailSubject: optionally pass opts.type
function emailSubject(bill, opts = {}) {
  const type = opts.type || ((bill && (bill.paymentStatus || bill.status || "").toLowerCase() === "paid") ? "paid" : "created");
  return subjectForType(bill, type);
}

/* ---------------- Charges table ---------------- */
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

/* ---------------- Email body ----------------
   opts:
     - stamp: number
     - type: "created" | "updated" | "paid"
     - downloadLink/paymentLink may be provided explicitly
*/
function emailHtml(bill, opts = {}) {
  if (!bill) return "<p>Bill info missing</p>";

  const { downloadLink, paymentLink, stamp } = opts.downloadLink ? opts : defaultLinks(bill, opts.stamp || opts.stamp);
  const type = opts.type || ((bill && (bill.paymentStatus || bill.status || "").toLowerCase() === "paid") ? "paid" : "created");
  const month = formattedMonth(bill);
  const isPaid = type === "paid" || (bill && (bill.paymentStatus || bill.status || "").toLowerCase() === "paid");

  // Heading text variations
  let heading = "Invoice";
  let introText = `This is your monthly rent bill. We kindly request timely payment to ensure uninterrupted services.`;
  let footerNote = `If you have already paid, kindly ignore this notice or reply with payment details.`;

  if (type === "created") {
    heading = "New Invoice Generated";
    introText = `A new rent invoice has been generated for you. Please review the details below.`;
    footerNote = `If you have questions, reply to this email or contact support.`;
  } else if (type === "updated") {
    heading = "Invoice Updated";
    introText = `Your rent invoice has been updated. Please review the updated details.`;
    footerNote = `If you have already paid, please ignore or reply with payment details.`;
  } else if (isPaid || type === "paid") {
    heading = "Payment Confirmation";
    introText = `We are pleased to inform you that your rent payment has been successfully processed.`;
    footerNote = `Thank you for your cooperation. We truly appreciate your timely payment.`;
  }

  const paidInfo = isPaid
    ? `
    <p style="color:green;font-weight:bold;margin:4px 0;">✅ PAYMENT RECEIVED</p>
    <p style="margin:4px 0;"><strong>Ref:</strong> ${bill.payment?.reference || "N/A"}</p>
    <p style="margin:4px 0;"><strong>Method:</strong> ${bill.payment?.method || "N/A"}</p>
  `
    : `<p style="color:#c00;font-weight:bold;">❌ Payment Pending</p>`;

  const logoHtml = COMPANY_LOGO ? `<img src="${COMPANY_LOGO}" style="max-height:50px;">` : `<h2 style="margin:0;">${COMPANY_NAME}</h2>`;

  const paymentButton =
    !isPaid && paymentLink
      ? `
    <a href="" target="_blank"
      style="background:#28a745;color:#fff;text-decoration:none;
      padding:12px 22px;border-radius:6px;font-weight:bold;
      display:inline-block;margin-right:10px;">
      💳 Pay Now
    </a>`
      : "";

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

          <p>Your rent bill amount is <strong>${formatCurrency(bill.totalAmount)}</strong></p>

          ${paidInfo}

          ${chargesHtml(bill)}

          <div style="margin:20px 0;text-align:center;">
            ${paymentButton}
            <a href="${downloadLink}" target="_blank"
              style="background:#0d6efd;color:#fff;text-decoration:none;
              padding:12px 22px;border-radius:6px;font-weight:bold;
              display:inline-block;">
              📄 Download Bill
            </a>
          </div>

          ${COMPANY_BANK ? `<p><strong>Bank Details:</strong><br>${COMPANY_BANK}</p>` : ""}
          ${COMPANY_GST ? `<p><strong>GST:</strong> ${COMPANY_GST}</p>` : ""}

          <p style="font-size:12px;color:#666;margin-top:20px;">${footerNote}<br>
            For any help, reply to <a href="mailto:${DEFAULT_FROM}">${DEFAULT_FROM}</a>
          </p>

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

/* ---------------- WhatsApp body (same pattern, different heading) ---------------- */
function whatsappBody(bill, opts = {}) {
  if (!bill) return "Bill info missing";

  const { downloadLink, paymentLink } = opts.downloadLink ? opts : defaultLinks(bill, opts.stamp);
  const type = opts.type || ((bill && (bill.paymentStatus || bill.status || "").toLowerCase() === "paid") ? "paid" : "created");
  const month = formattedMonth(bill);
  const isPaid = type === "paid" || (bill && (bill.paymentStatus || bill.status || "").toLowerCase() === "paid");

  let intro = "";
  if (type === "created") intro = "generated.";
  else if (type === "updated") intro = "updated.";
  else intro = isPaid ? "paid successfully." : "📄 Invoice";

  let msg = ``;
  msg += `Dear ${bill.tenant?.fullName},\n`
  msg += `Your monthly rental bill for *${month}* has been ${intro}.\n\n`
  msg += `Your ID: *${bill.tenant?.tenantId}*\n`
  msg += `Room: *${safeRoomNumber(bill)}*\n`;
  msg += `Amount: *${formatCurrency(bill.totalAmount)}*\n\n`;

  if (isPaid) {
    msg += `Status: Paid ✅\n\n`;
    msg += `Ref: ${bill.payment?.reference || "N/A"}\n`;
  } else {
    msg += `Status: Unpaid ❌\n`;
    if (paymentLink) msg += `💳 Pay Here:\n\n\n`;
  }

  msg += `📄 Download Invoice:\n${downloadLink}\n\n\n`;
  msg += `*© DB WELLNESS PVT LTD*`;

  return msg;
}

/* ---------------- Convenience shaped objects (optional) ---------------- */
function billCreated(bill, stamp) {
  const s = stamp || Date.now();
  return {
    subject: subjectForType(bill, "created"),
    body: emailHtml(bill, { stamp: s, type: "created" }),
  };
}
function billUpdated(bill, stamp) {
  const s = stamp || Date.now();
  return {
    subject: subjectForType(bill, "updated"),
    body: emailHtml(bill, { stamp: s, type: "updated" }),
  };
}
function billPaid(bill, stamp) {
  const s = stamp || Date.now();
  return {
    subject: subjectForType(bill, "paid"),
    body: emailHtml(bill, { stamp: s, type: "paid" }),
  };
}

module.exports = {
  // main helpers used by controllers
  emailSubject, // (bill, opts?)
  emailHtml, // (bill, opts?)
  whatsappBody, // (bill, opts?)

  // convenience shaped objects if needed
  billCreated,
  billUpdated,
  billPaid,
};
