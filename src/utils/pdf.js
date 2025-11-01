// backend/src/utils/pdf.js
/**
 * PDF invoice generator.
 *
 * Exports:
 *   - generateBillPdf(bill)
 *   - generateBillPdfBeforePaid(bill)
 *   - generateBillPdfAfterPaid(bill)
 *   - formatCurrency
 *   - formatDateISO
 *
 * Notes:
 *   - Each generator returns a Promise<Buffer>.
 *   - QR code support is optional (uses 'qrcode' if available).
 *   - Uses PDFKit. Avoids writing to disk; callers should write buffer if needed.
 */

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

// optional qr code dependency
let QRCode = null;
try {
  // eslint-disable-next-line global-require
  QRCode = require("qrcode");
} catch (e) {
  QRCode = null;
}


/* ---------------- helpers ---------------- */
function safeNumber(val) {
  if (val === undefined || val === null) return 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function formatCurrency(val) {
  const n = safeNumber(val);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
  } catch {
    return `₹${n.toFixed(2)}`;
  }
}

function formatDateISO(d) {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toISOString().split("T")[0];
}

async function generateQrBuffer(text, size = 150) {
  if (!QRCode || !text) return null;
  try {
    const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: size });
    const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!match) return null;
    return Buffer.from(match[1], "base64");
  } catch (err) {
    return null;
  }
}

/* ---------------- watermark ---------------- */
/**
 * Draw a diagonal watermark on every page. Works with buffered PDFs.
 * doc must be a PDFDocument with pages already added (bufferedPageRange available).
 */
function drawWatermarkOverPages(doc, text, opts = {}) {
  const { fontSize = 96, opacity = 0.10, color = "gray", rotate = -35 } = opts;

  // if bufferedPageRange available (pdfkit when created without immediate write)
  const range = typeof doc.bufferedPageRange === "function" ? doc.bufferedPageRange() : null;
  const pageCount = range ? range.count : (doc.page ? 1 : 0);

  for (let i = 0; i < pageCount; i++) {
    if (typeof doc.switchToPage === "function") doc.switchToPage(i);

    const page = doc.page;
    if (!page) continue;
    const pw = page.width;
    const ph = page.height;

    doc.save();
    // center, rotate and print large text
    doc.translate(pw / 2, ph / 2);
    doc.rotate(rotate, { origin: [0, 0] });
    doc.font("Helvetica-Bold").fontSize(fontSize).opacity(opacity).fillColor(color);
    const tw = doc.widthOfString(text);
    const th = doc.currentLineHeight();
    doc.text(text, -tw / 2, -th / 2, { lineBreak: false });
    // restore
    doc.opacity(1).fillColor("black");
    doc.restore();
  }
}

/* ---------------- rendering primitives ---------------- */
function renderHeader(doc, bill, x = doc.page.margins.left, pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right, topY = doc.page.margins.top) {
  // company info/env fallback
  const logoEnv = process.env.COMPANY_LOGO_PATH || path.join(__dirname);
 // const companyName = process.env.COMPANY_NAME || (bill.building && bill.building.name) || "Rental Company";
 // const companyAddress = process.env.COMPANY_ADDRESS || (bill.building && bill.building.address) || "";

  const logoW = 80;

  const logoExists = (() => { try { return fs.existsSync(logoEnv); } catch { return false; } })();
  const textX = x + (logoExists ? logoW + 12 : 0);

  // Company name
 // doc.font("Helvetica-Bold").fontSize(16).text(companyName, textX, topY);
  doc.image(logoEnv, x, topY, { width: logoW, fit: [logoW, 60] });
 // doc.font("Helvetica").fontSize(8).text("DR. BISWAS GROUP OF COMPANIES", textX, topY + 20);

  // invoice box
  const invoiceW = 160;
  const invX = x + pageWidth - invoiceW;
  doc.save();
  try { doc.rect(invX, topY, invoiceW, 64).fillAndStroke("#f7fafc", "#e6eef6"); } catch (_) {}
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text("INVOICE", invX + 10, topY + 8);
  doc.font("Helvetica").fontSize(9).text(`Invoice #: ${String(bill._id).slice(-10)}`, invX + 10, topY + 28);
  const billingLabel = bill.billingMonth ? (new Date(bill.billingMonth).toLocaleString(undefined, { month: "long", year: "numeric" })) : "-";
  doc.text(`Billing for: ${billingLabel}`, invX + 10, topY + 42);
  doc.restore();
}

function renderTenantAndProperty(doc, bill, x = doc.page.margins.left, pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right, topY = doc.page.margins.top + 80) {
  const colGap = 12;
  const half = (pageWidth - colGap) / 2;
  const leftX = x;
  const rightX = x + half + colGap;

  doc.font("Helvetica-Bold").fontSize(11).text("Bill To", leftX, topY);
  doc.font("Helvetica").fontSize(10).text(bill.tenant?.fullName || "-", leftX, topY + 16);
  doc.font("Helvetica").fontSize(9).text(`Tenant ID: ${bill.tenant?.tenantId || (bill.tenant?._id ? String(bill.tenant._id) : "-")}`, leftX, topY + 36);
  if (bill.tenant?.phone) doc.text(`Phone: ${bill.tenant.phone}`, leftX, topY + 52);
  if (bill.tenant?.email) doc.text(`Email: ${bill.tenant.email}`, leftX, topY + 66);

  doc.font("Helvetica-Bold").fontSize(11).text("Property", rightX, topY);
  doc.font("Helvetica").fontSize(10).text(`Building: ${bill.building?.name || "-"}`, rightX, topY + 16, { width: half - 4 });
  doc.font("Helvetica").fontSize(10).text(`Address: ${bill.building?.address || "-"}`, rightX, topY + 34, { width: half - 4 });

  
  doc.text(`Room: ${bill.room?.number || bill.room?.roomNumber || "-"}`, rightX, topY + 60);
  const rentBase = safeNumber(bill.totals?.rent) || (Array.isArray(bill.charges) ? (bill.charges.find(c => (c.title || "").toLowerCase() === "rent") || {}).amount : 0);
  doc.text(`Rent Basis: ${(rentBase)}`, rightX, topY + 78);
}

/**
 * Draw a description/amount table and totals box.
 * Returns { endY, totalCalculated } where endY is the y coordinate after drawing.
 */
async function drawChargesAndTotals(doc, bill, startY = doc.y) {
  const leftX = doc.page.margins.left;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rightX = leftX + pageWidth;
  const amountCol = 120;
  const descCol = pageWidth - amountCol - 16;
  const rowH = 20;
  const padding = 8;
  const headerH = 28;

  // local formatter (keeps no currency symbol; uses grouping and two decimals)
  function formatCurrency(n) {
    if (n == null || Number.isNaN(Number(n))) return "-";
    return Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Build charges map (sum duplicates)
  const chargesArr = Array.isArray(bill.charges) ? bill.charges.slice() : [];
  const chargesMap = {};
  chargesArr.forEach(c => {
    const key = (c.title || "").toString().trim().toLowerCase();
    chargesMap[key] = (chargesMap[key] || 0) + safeNumber(c.amount);
  });

  // Preferred display order — NOTE: we will NOT include processing fee in the description rows
  const preferred = [
    { key: "rent", label: "Rent" },
    { key: "electricity", label: "Electricity" },
    { key: "additional amount", label: "Additional Charges" },
    { key: "discount", label: "Discount" },
    // processing fee intentionally NOT added to description rows
  ];

  // Build rows for Description/Amount table (skip processing fee keys)
  const rows = [];
  preferred.forEach(p => {
    if (chargesMap[p.key] !== undefined) rows.push({ desc: p.label, amt: chargesMap[p.key], key: p.key });
  });

  // Add other charges (exclude processing fee variants)
  chargesArr.forEach(c => {
    const key = (c.title || "").toString().trim().toLowerCase();
    if (key === "processing fee" || key === "processing fee 2%") return; // skip - only in summary
    if (!preferred.find(p => p.key === key)) rows.push({ desc: c.title || "Charge", amt: safeNumber(c.amount), key });
  });

  // previous balance is shown only in summary; do not add to rows
  const prevBal = safeNumber(bill.previousBalance ?? bill.totals?.previousBalance ?? 0);

  // ---------- draw header ----------
  let y = startY;
  const drawHeader = () => {
    doc.font("Helvetica-Bold").fontSize(11);
    try { doc.rect(leftX, y, pageWidth, headerH).fillAndStroke("#f3f6fb", "#e6eef6"); } catch (_) {}
    doc.fillColor("#111827").text("Description", leftX + padding, y + 8, { width: descCol, ellipsis: true });
    doc.text("Amount", rightX - 8 - amountCol + padding, y + 8, { width: amountCol - padding, align: "right" });
    y += headerH;
  };
  drawHeader();
  doc.font("Helvetica").fontSize(10).fillColor("#111827");

  // ---------- totals calculation ----------
  const discount = safeNumber(chargesMap["discount"] ?? 0);
  // processing fee retrieved from either key but NOT shown in the description table
  const processing = safeNumber(chargesMap["processing fee"] ?? chargesMap["processing fee 2%"] ?? 0);
  const gstPercent = safeNumber(bill.totals?.gstPercent ?? 0);

  // SUBTOTAL: sum of rows EXCLUDING discount (and processing is not present in rows)
  const subtotal = rows.reduce((s, r) => {
    if ((r.key || "").toString().toLowerCase() === "discount") return s;
    return s + safeNumber(r.amt);
  }, 0);

  // GST on (subtotal - discount)
  const gstAmt = gstPercent > 0 ? Math.round(((subtotal - discount) * gstPercent) / 100) : 0;

  // Total calculation: subtotal - discount + gst + processing + prevBal
  const totalCalc = Math.round(subtotal - discount + gstAmt + processing + prevBal);
  const totalFromBill = safeNumber(bill.totalAmount ?? totalCalc);

  // Build summary lines - processing is shown here only
  const summaryLines = [{ label: "Subtotal :", amt: subtotal }];
  if (discount !== 0) summaryLines.push({ label: "Discount :", amt: discount });
  if (gstAmt !== 0) summaryLines.push({ label: `GST (${gstPercent}%) :`, amt: gstAmt });
  if (processing !== 0) summaryLines.push({ label: "Processing Fee (2%) :", amt: processing });
  if (prevBal !== 0) summaryLines.push({ label: "Previous Balance :", amt: prevBal });

  const paymentStatus = (bill.paymentStatus || bill.status || "").toString().toLowerCase();
  const isPaid = paymentStatus === "paid";
  if (isPaid) {
    const amountPaid = safeNumber(bill.payment?.amount ?? bill.totalAmount ?? totalFromBill);
    summaryLines.push({ label: "Amount Paid :", amt: amountPaid, isPaid: true });
    summaryLines.push({ label: "Status : PAID", amt: null, isStatus: true });
  } else {
    summaryLines.push({ label: "Payable Amount :", amt: totalFromBill, isTotal: true });
  }

  // ---------- layout calculations ----------
  const titleH = 20;
  const lineH = 18;
  const summaryPaddingTop = 12;
  const summaryPaddingBottom = 12;
  const summaryLineCount = summaryLines.length;
  const totalsBoxHeight = summaryPaddingTop + titleH + (summaryLineCount * lineH) + summaryPaddingBottom;
  const footerReserve = 16;

  function ensureSpace(need) {
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    if (y + need > bottomLimit - footerReserve) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
    }
  }

  ensureSpace(rowH + totalsBoxHeight + 8);

  // ---------- draw description rows ----------
  for (const r of rows) {
    ensureSpace(rowH + totalsBoxHeight + 8);
    try { doc.rect(leftX, y, pageWidth, rowH).stroke("#eaeff4"); } catch (_) {}
    doc.text(r.desc, leftX + padding, y + 6, { width: descCol, ellipsis: true });

    const amtTextRow = (r.amt == null) ? "" : formatCurrency(r.amt);
    const amtLeft = rightX - amountCol + padding;
    const amtWidth = amountCol - padding;
    doc.text(amtTextRow, amtLeft - 8, y + 6, { width: amtWidth, align: "right" });

    y += rowH;
  }

  // ---------- separator and page check ----------
  let sepY = y + 8;
  if (sepY + totalsBoxHeight > doc.page.height - doc.page.margins.bottom - footerReserve) {
    doc.addPage();
    y = doc.page.margins.top;
    drawHeader();
    doc.font("Helvetica").fontSize(10).fillColor("#111827");
    sepY = y + 8;
  }
  try { doc.moveTo(leftX, sepY).lineTo(rightX, sepY).stroke("#e6eef6"); } catch (_) {}

  // ---------- totals box ----------
  const totalsW = Math.min(300, pageWidth * 0.45);
  const totalsX = rightX - totalsW;
  let ty = sepY + 12;

  try {
    doc.rect(totalsX, ty - 8, totalsW, titleH + (summaryLineCount * lineH) + summaryPaddingTop + summaryPaddingBottom).fillAndStroke("#ffffff", "#e6eef6");
  } catch (_) {}

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827").text("Summary", totalsX + 10, ty + 3);
  ty += titleH;
  doc.font("Helvetica").fontSize(10).fillColor("#111827");

  const amtLeftFinal = totalsX + 10;
  const amtWidthFinal = totalsW - 22;

  for (const s of summaryLines) {
    if (s.isStatus) {
      doc.fillColor("green").fontSize(10).text(s.label, totalsX + 10, ty, { width: amtWidthFinal, align: "left" });
      doc.fillColor("#111827").fontSize(10);
      ty += lineH;
      continue;
    }

    if (s.isTotal || s.isPaid) doc.font("Helvetica-Bold").fontSize(12);
    else doc.font("Helvetica").fontSize(10);

    const amtStr = (s.amt == null) ? "" : formatCurrency(s.amt);
    doc.text(s.label, totalsX + 10, ty, { width: amtWidthFinal });
    doc.text(amtStr, amtLeftFinal, ty, { width: amtWidthFinal, align: "right" });

    doc.font("Helvetica").fontSize(10).fillColor("#111827");
    ty += lineH;
  }

  const endY = Math.max(y, ty) + 18;
  return { endY, totalCalculated: totalFromBill };
}



/* ---------------- PDF formats (return Buffer) ---------------- */
async function generateBillPdfBeforePaid(bill) {
  if (!bill) throw new Error("Bill object is required");
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40, autoFirstPage: false, bufferPages: true });

      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      doc.addPage();
      const leftX = doc.page.margins.left;
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // header + tenant/property
      renderHeader(doc, bill, leftX, pageWidth, doc.page.margins.top - 6);
      renderTenantAndProperty(doc, bill, leftX, pageWidth, doc.page.margins.top + 82);

      // === add a QR for the bill (links to frontend bill view) ===
      try {
        const backendUrl = process.env.BACKEND_URL;
        const billLink = `${backendUrl}/api/bills/${bill._id}/pdf`;
        const qrSize = 70; // reduced size
        const qrBuf = await generateQrBuffer(billLink, qrSize).catch(() => null);
        if (qrBuf) {
          // center horizontally: leftX + (pageWidth/2) - (qrSize/2)
          const qrX = leftX + (pageWidth / 2) - (qrSize / 2);
          // place just below top margin (adjust vertical offset if needed)
          const qrY = doc.page.margins.top;
          try { doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize }); } catch (e) {
            console.warn("Failed to draw bill QR (before-paid):", e && e.message);
          }
        } else {
          console.warn("Bill QR not generated (before-paid) for link:", billLink);
        }
      } catch (e) {
        console.warn("Bill QR generation error (before-paid):", e && e.message);
      }

      // charges + totals
      const tableStart = doc.page.margins.top + 200;
      const { endY } = await drawChargesAndTotals(doc, bill, tableStart);

      // payment link & optional QR (existing logic kept)
      const paymentLink = bill.paymentLink || (bill.razorpayOrderId ? `${frontendUrl}/payment/public/${bill._id}` : null);

      let paymentY = endY + 8;
      if (paymentLink) {
        doc.font("Helvetica-Bold").fontSize(10).text("Pay Online:", leftX, paymentY);
        doc.font("Helvetica").fontSize(10).fillColor("blue").text(paymentLink, leftX + 72, paymentY, {
          link: paymentLink,
          underline: true,
          width: pageWidth - 220,
        });
        doc.fillColor("black");

        const qr = await generateQrBuffer(paymentLink, 160).catch(() => null);
        if (qr) {
          try {
            const qrX = leftX + pageWidth - 140;
            const qrY = paymentY - 6;
            doc.image(qr, qrX, qrY, { width: 120, height: 120 });
          } catch (_) {}
        }
        paymentY += 120;
      }

      // notes
      if (bill.notes) {
        const notesY = Math.max(paymentY, endY + 40);
        doc.font("Helvetica-Bold").fontSize(10).text("Notes:", leftX, notesY + 6);
        doc.font("Helvetica").fontSize(9).text(bill.notes, leftX, notesY + 22, { width: pageWidth });
      }

      // footer - bank/gst/terms
      const footerY = doc.page.height - doc.page.margins.bottom - 90;
      try { doc.moveTo(leftX, footerY - 12).lineTo(leftX + pageWidth, footerY - 12).stroke("#e6eef6"); } catch (_) {}
      const bank = process.env.COMPANY_BANK_DETAILS || "";
      if (bank) {
        doc.font("Helvetica-Bold").fontSize(9).text("Bank Details:", leftX, footerY);
        doc.font("Helvetica").fontSize(9).text(bank, leftX, footerY + 14, { width: pageWidth / 2 - 10 });
      }
      const gst = process.env.COMPANY_GST || "";
      if (gst) doc.font("Helvetica").fontSize(9).text(`GST: ${gst}`, leftX + pageWidth - 220, footerY);

      // combine company name and computer-generated notice as requested
      const footerNotice = `DR. BISWAS GROUP OF COMPANIES\nThis is a computer generated invoice and does not require a signature.`;
      doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(footerNotice, leftX + pageWidth - 250, footerY + 30, { width: 400 });

      // watermark: UNPAID
      drawWatermarkOverPages(doc, "UNPAID", { fontSize: 90, opacity: 0.10, rotate: -35 });

      doc.end();
    } catch (err) {
      return reject(err);
    }
  });
}


async function generateBillPdfAfterPaid(bill) {
  if (!bill) throw new Error("Bill object is required");
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40, autoFirstPage: false });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      doc.addPage();
      const leftX = doc.page.margins.left;
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      renderHeader(doc, bill, leftX, pageWidth, doc.page.margins.top - 6);
      renderTenantAndProperty(doc, bill, leftX, pageWidth, doc.page.margins.top + 82);

      const tableStart = doc.page.margins.top + 200;
      const { endY, totalCalculated } = await drawChargesAndTotals(doc, bill, tableStart);

      // payment details block
      let paidY = endY + 8;
      if (bill.payment) {
        doc.font("Helvetica-Bold").fontSize(10).fillColor("green").text("Payment Details:", leftX, paidY);
        doc.fillColor("black");
        doc.font("Helvetica").fontSize(10).text(`Paid At: ${formatDateISO(bill.payment.paidAt || bill.payment?.paidAt)}`, leftX, paidY + 18);
        doc.text(`Reference: ${bill.payment.reference || "-"}`, leftX, paidY + 36);
        doc.text(`Method: ${bill.payment.method || "-"}`, leftX, paidY + 54);
        paidY += 72;
      }
      try {
        const backendUrl = process.env.BACKEND_URL;
        const billLink = `${backendUrl}/api/bills/${bill._id}/pdf`;
        const qrSize = 70; // reduced size
        const qrBuf = await generateQrBuffer(billLink, qrSize).catch(() => null);
        if (qrBuf) {
          // center horizontally: leftX + (pageWidth/2) - (qrSize/2)
          const qrX = leftX + (pageWidth / 2) - (qrSize / 2);
          // place just below top margin (adjust vertical offset if needed)
          const qrY = doc.page.margins.top;
          try { doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize }); } catch (e) {
            console.warn("Failed to draw bill QR (before-paid):", e && e.message);
          }
        } else {
          console.warn("Bill QR not generated (before-paid) for link:", billLink);
        }
      } catch (e) {
        console.warn("Bill QR generation error (before-paid):", e && e.message);
      }
      // notes
      if (bill.notes) {
        const notesY = paidY + 8;
        doc.font("Helvetica-Bold").fontSize(10).text("Notes:", leftX, notesY);
        doc.font("Helvetica").fontSize(9).text(bill.notes, leftX, notesY + 16, { width: pageWidth });
      }

      // footer
      const footerY = doc.page.height - doc.page.margins.bottom - 90;
      try { doc.moveTo(leftX, footerY - 12).lineTo(leftX + pageWidth, footerY - 12).stroke("#e6eef6"); } catch (_) {}
      const bank = process.env.COMPANY_BANK_DETAILS || "";
      if (bank) {
        doc.font("Helvetica-Bold").fontSize(9).text("Bank Details:", leftX, footerY);
        doc.font("Helvetica").fontSize(9).text(bank, leftX, footerY + 14, { width: pageWidth / 2 - 10 });
      }
      const gst = process.env.COMPANY_GST || "";
      if (gst) doc.font("Helvetica").fontSize(9).text(`GST: ${gst}`, leftX + pageWidth - 220, footerY);

      // combined footer notice as requested
      const footerNotice = `DR. BISWAS GROUP OF COMPANIES\nThis is a computer generated invoice and does not require a signature.`;
      doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(footerNotice, leftX + pageWidth - 250, footerY + 20, { width: 400 });

      // watermark: PAID
      drawWatermarkOverPages(doc, "PAID", { fontSize: 96, opacity: 0.12, rotate: -35 });

      doc.end();
    } catch (err) {
      return reject(err);
    }
  });
}

/* ---------------- public selector ---------------- */
async function generateBillPdf(bill) {
  const status = (bill.paymentStatus || bill.status || "").toString().toLowerCase();
  const isPaid = status === "paid";
  if (isPaid) return generateBillPdfAfterPaid(bill);
  return generateBillPdfBeforePaid(bill);
}

module.exports = {
  generateBillPdf,
  generateBillPdfBeforePaid,
  generateBillPdfAfterPaid,
  formatCurrency,
  formatDateISO,
};
