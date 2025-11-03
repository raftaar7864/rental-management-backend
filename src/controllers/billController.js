// backend/src/controllers/billController.js

const fs = require("fs");
const path = require("path");
const Bill = require("../models/Bill");
const Tenant = require("../models/Tenant");
const Room = require("../models/Room");
const Building = require("../models/Building");
const { createOrder } = require("../services/razorpayService");
const notificationService = require("../services/notificationService");
const PDFDocument = require("pdfkit");

// AWS v3 S3 client (S3-compatible) & presigner for Cloudflare R2
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// templates
const templates = require("../utils/notificationTemplete");

// unified pdf generator (returns Buffer)
const { generateBillPdf: generateBillPdfBuffer } = require("../utils/pdf");

// ensure pdf folder exists (for local dev / for notificationService attachments)
const PDF_DIR = path.join(__dirname, "../../pdfs");
fs.mkdirSync(PDF_DIR, { recursive: true });

/* -------------------- Cloudflare R2 Setup -------------------- */
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
const R2_REGION = process.env.R2_REGION || "auto";

if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_ENDPOINT) {
  console.warn("Cloudflare R2 not fully configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_ACCOUNT_ID / R2_ENDPOINT when deploying.");
}

const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: false,
});

// Upload buffer to R2
async function uploadPdfBufferToR2(buffer, key) {
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "application/pdf",
  });
  await s3Client.send(cmd);

  // publicUrl pattern — works only if bucket / routing is configured public in Cloudflare
  const publicUrl = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeURIComponent(key)}`;
  return { key, publicUrl };
}

// Get signed URL for private access
async function getSignedUrlForKey(key, expiresInSeconds = 60 * 60) {
  const getCmd = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  });
  const url = await getSignedUrl(s3Client, getCmd, { expiresIn: expiresInSeconds });
  return url;
}

/* ---------------- Helper: generate PDF Buffer and (1) write to disk (local) and (2) upload to R2 ----------------
   Returns: { filePath, r2: { key, publicUrl } }
   - We still write to disk so existing notificationService (which expects a file path) works unchanged.
   - We upload to R2 and save pdfKey/pdfUrl on the bill record where used.
*/
async function writeBillPdfToDiskAndUpload(bill) {
  if (!bill) throw new Error("Bill object is required to generate PDF");

  // Generate Buffer using your unified generator
  const buffer = await generateBillPdfBuffer(bill);
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new Error("PDF generator did not return a Buffer or Uint8Array");
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // Ensure local dir exists
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

  const filename = `bill_${bill._id}.pdf`;
  const filePath = path.join(PDF_DIR, filename);

  // Write local copy (overwrites existing)
  fs.writeFileSync(filePath, buf);

  let r2res = null;
  try {
    if (R2_BUCKET && R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
      const key = `bills/${filename}`;
      r2res = await uploadPdfBufferToR2(buf, key);
    } else {
      console.warn("Skipping R2 upload - R2 not configured");
    }
  } catch (r2Err) {
    console.error("Failed to upload PDF to R2:", r2Err);
    // continue — we still have local file for notifications
  }

  return { filePath, r2: r2res };
}

/* ---------------- CRUD ---------------- */
exports.getBills = async (req, res) => {
  try {
    const { tenant, room, month } = req.query;
    const q = {};
    if (tenant) q.tenant = tenant;
    if (room) q.room = room;
    if (month) {
      q.billingMonth = new RegExp(`^${month}`);
    }
    const bills = await Bill.find(q)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address")
      .sort({ billingMonth: -1, createdAt: -1 });
    res.json(bills);
  } catch (err) {
    console.error("getBills error:", err);
    res.status(500).json({ message: "Failed to fetch bills" });
  }
};

exports.getBill = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    res.json(bill);
  } catch (err) {
    console.error("getBill error:", err);
    res.status(500).json({ message: "Failed to fetch bill" });
  }
};

/* ---------------- Create ---------------- */
exports.createBill = async (req, res) => {
  try {
    const { tenant, room, billingMonth, charges = [], totalAmount, totals = {}, notes, paymentLink } = req.body;

    if (!tenant || !room || !billingMonth || typeof totalAmount === "undefined") {
      return res.status(400).json({ message: "tenant, room, billingMonth and totalAmount are required" });
    }

    const roomDoc = await Room.findById(room);
    if (!roomDoc) return res.status(404).json({ message: "Room not found" });
    const buildingDoc = await Building.findById(roomDoc.building);
    const tenantDoc = await Tenant.findById(tenant);
    if (!tenantDoc) return res.status(404).json({ message: "Tenant not found" });

    const exists = await Bill.findOne({ room, tenant, billingMonth });
    if (exists) {
      return res.status(409).json({ message: "Bill already exists for this tenant/room and month" });
    }

    const bill = new Bill({
      tenant,
      room,
      building: buildingDoc ? buildingDoc._id : roomDoc.building,
      billingMonth,
      charges,
      totals,
      totalAmount,
      notes,
      paymentLink,
      paymentStatus: "Not Paid",
    });

    await bill.save();

    const populated = await Bill.findById(bill._id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    // generate PDF async (don't fail creation if pdf fails)
    try {
      const { filePath, r2 } = await writeBillPdfToDiskAndUpload(populated);
      if (r2 && r2.key) {
        populated.pdfKey = r2.key;
        populated.pdfUrl = r2.publicUrl; // may be usable if you've configured public access; otherwise use signed URLs
      } else {
        // fall back to local-accessible path (for local dev)
        populated.pdfUrl = `/pdfs/${path.basename(filePath)}`;
      }
      await populated.save();
    } catch (pdfErr) {
      console.error("PDF generation failed during createBill:", pdfErr);
    }

    // notifications (do not fail creation if notifications fail)
    // NOTE: Keep notification code commented/enabled as before - this still expects a local file path.
    // If you want notifications to use the R2 public/signed url instead of local file, adapt notificationService accordingly.
    /*
    try {
      const pdfPath = path.join(PDF_DIR, `bill_${populated._id}.pdf`);
      if (populated.tenant?.email) await notificationService.sendBillEmail(populated, pdfPath);
      if (populated.tenant?.phone) await notificationService.sendBillWhatsApp(populated, pdfPath);
    } catch (notifyErr) {
      console.error("createBill notification error:", notifyErr);
    }
    */

    res.status(201).json(populated);
  } catch (err) {
    console.error("createBill error:", err);
    res.status(500).json({ message: "Failed to create bill" });
  }
};

/* ---------------- Update ---------------- */
exports.updateBill = async (req, res) => {
  try {
    const billId = req.params.id;
    const data = req.body;

    // Load and populate existing bill
    let bill = await Bill.findById(billId)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    // Merge allowed fields safely
    const allowed = [
      "charges",
      "totals",
      "totalAmount",
      "notes",
      "paymentLink",
      "paymentStatus",
      "razorpayOrderId",
      "razorpayPaymentId",
      "razorpaySignature",
    ];
    allowed.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(data, k)) bill[k] = data[k];
    });

    await bill.save();

    // Re-populate after saving
    bill = await Bill.findById(billId)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    // 1) Regenerate PDF (write local and upload to R2)
    try {
      const { filePath, r2 } = await writeBillPdfToDiskAndUpload(bill);
      if (r2 && r2.key) {
        bill.pdfKey = r2.key;
        bill.pdfUrl = r2.publicUrl;
      } else {
        bill.pdfUrl = `/pdfs/${path.basename(filePath)}`;
      }
      await bill.save();
    } catch (pdfErr) {
      console.error("PDF generation failed during updateBill:", pdfErr);
    }

    return res.status(200).json({
      success: true,
      message: "Bill updated",
      pdfUrl: bill.pdfUrl,
    });
  } catch (err) {
    console.error("updateBill error:", err);
    res.status(500).json({
      message: "Failed to update Bill",
      error: err.message,
    });
  }
};

exports.createPaymentOrderPublic = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: "Bill not found" });

    // Prevent creating order when already paid
    const paidStatus = (bill.paymentStatus || bill.status || "").toString().toLowerCase();
    if (paidStatus === "paid") {
      return res.status(400).json({ message: "Bill already paid" });
    }

    // createOrder is imported at top: const { createOrder } = require("../services/razorpayService");
    const order = await createOrder({
      amount: bill.totalAmount,
      currency: "INR",
      receipt: `bill_${bill._id}`,
      notes: { tenantId: String(bill.tenant) },
    });

    if (!order) {
      return res.status(503).json({ message: "Payment provider not configured" });
    }

    // store order id on bill (so webhook/verify can find it)
    bill.razorpayOrderId = order.id || order.order_id || (order && order);
    await bill.save();

    return res.json({
      orderId: order.id || order.order_id || null,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY || null,
      amount: bill.totalAmount,
    });
  } catch (err) {
    console.error("createPaymentOrderPublic error:", err);
    return res.status(500).json({ message: "Failed to create payment order" });
  }
};

/**
 * Public: mark bill as paid (no auth)
 * POST /api/bills/:id/mark-paid-public
 *
 * Expected body:
 *   { paymentRef?, paidAt?, method?, paymentId?, razorpay_payment_id? }
 *
 * This mirrors the admin markPaid flow but intentionally uses public endpoint name.
 */
exports.markPaidPublic = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentRef, paidAt, method, paymentId } = req.body;

    const bill = await Bill.findById(id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    // If already paid, return error (idempotency)
    if ((bill.paymentStatus || "").toString().toLowerCase() === "paid") {
      return res.status(400).json({ message: "Bill already marked as paid" });
    }

    // Update payment info
    bill.paymentStatus = "Paid";
    bill.payment = {
      status: "Paid",
      method: method || "Online",
      reference: paymentRef || paymentId || req.body.razorpay_payment_id || "",
      paidAt: paidAt ? new Date(paidAt) : new Date(),
    };
    if (paymentId) bill.razorpayPaymentId = paymentId;
    if (req.body.razorpay_payment_id) bill.razorpayPaymentId = req.body.razorpay_payment_id;

    // also update top-level fields for compatibility
    bill.razorpayOrderId = bill.razorpayOrderId || req.body.orderId || bill.razorpayOrderId;

    await bill.save();

    // Record payment on tenant (best-effort)
    try {
      const tenant = await Tenant.findById(bill.tenant._id || bill.tenant);
      if (tenant) {
        tenant.payments = tenant.payments || [];
        tenant.payments.push({
          amount: bill.totalAmount,
          date: bill.payment.paidAt,
          method: bill.payment.method,
          receiptNumber: bill.payment.reference || undefined,
          note: `Payment for bill ${bill._id}`,
        });

        tenant.lastPayment = {
          amount: bill.totalAmount,
          date: bill.payment.paidAt,
          receiptNumber: bill.payment.reference || undefined,
        };

        if (tenant.duePayment && typeof tenant.duePayment.pendingAmount === "number") {
          tenant.duePayment.pendingAmount = Math.max(0, tenant.duePayment.pendingAmount - bill.totalAmount);
          if (tenant.duePayment.pendingAmount === 0) tenant.duePayment.dueDate = null;
        }

        await tenant.save();
      }
    } catch (tErr) {
      console.error("markPaidPublic: failed to record payment on tenant:", tErr);
    }

    // Regenerate PDF and send immediate paid notifications (best-effort)
    try {
      const { filePath, r2 } = await writeBillPdfToDiskAndUpload(bill);

      if (r2 && r2.key) {
        bill.pdfKey = r2.key;
        bill.pdfUrl = r2.publicUrl;
      } else {
        bill.pdfUrl = `/pdfs/${path.basename(filePath)}`;
      }
      await bill.save();

      // try to remove any pending queued emails for this bill (if implemented)
      try {
        if (notificationService && typeof notificationService._removePendingEmailsForBill === "function") {
          notificationService._removePendingEmailsForBill(bill._id);
        }
      } catch (remErr) {
        console.warn("markPaidPublic: failed to remove pending emails:", remErr);
      }

      // Use templates for subject/message
      const subject = templates.emailSubject(bill);
      const emailHtml = templates.emailHtml(bill);
      try {
        if (notificationService && typeof notificationService._sendBillEmailNow === "function") {
          await notificationService._sendBillEmailNow(bill, filePath, subject, emailHtml);
        } else if (notificationService && typeof notificationService.sendBillEmail === "function") {
          // fallback to queued send
          await notificationService.sendBillEmail(bill, filePath, subject, emailHtml);
        }
      } catch (emailErr) {
        console.warn("markPaidPublic: failed to send paid-email:", emailErr);
      }

      // WhatsApp via template
      try {
        const whatsappMsg = templates.whatsappBody(bill);
        if (notificationService && typeof notificationService.sendBillWhatsApp === "function" && bill.tenant?.phone) {
          await notificationService.sendBillWhatsApp(bill, filePath, whatsappMsg);
        }
      } catch (waErr) {
        console.warn("markPaidPublic: failed to send WhatsApp:", waErr);
      }
    } catch (pdfErr) {
      console.error("markPaidPublic: PDF/notification error:", pdfErr);
    }

    return res.json({
      success: true,
      message: "Bill marked as paid (public), PDF regenerated, notifications attempted",
      pdfUrl: bill.pdfUrl,
    });
  } catch (err) {
    console.error("markPaidPublic error:", err);
    return res.status(500).json({ message: "Failed to mark bill as paid" });
  }
};

/* ---------------- Delete ---------------- */
exports.deleteBill = async (req, res) => {
  try {
    const bill = await Bill.findByIdAndDelete(req.params.id);
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    res.json({ message: "Bill deleted successfully" });
  } catch (err) {
    console.error("deleteBill error:", err);
    res.status(500).json({ message: "Failed to delete bill" });
  }
};

/* ---------------- Generate PDF (explicit endpoint) ---------------- */
exports.generateBillPdf = async (req, res) => {
  try {
    const billId = req.params.id;
    const bill = await Bill.findById(billId)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    const { filePath, r2 } = await writeBillPdfToDiskAndUpload(bill);

    if (r2 && r2.key) {
      bill.pdfKey = r2.key;
      bill.pdfUrl = r2.publicUrl;
    } else {
      bill.pdfUrl = `/pdfs/${path.basename(filePath)}`;
    }
    await bill.save();

    return res.status(200).json({
      success: true,
      pdfUrl: bill.pdfUrl,
      message: "Bill PDF generated successfully",
    });
  } catch (err) {
    console.error("generateBillPdf error:", err);
    res.status(500).json({
      message: "Failed to generate Bill PDF",
      error: err.message,
    });
  }
};

/* ---------------- Download PDF (serves from R2 if available, else generates) ---------------- */
exports.getBillPdf = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    // If R2 key exists, redirect to signed URL (preferred for production)
    if (bill.pdfKey) {
      try {
        const url = await getSignedUrlForKey(bill.pdfKey, 60 * 5); // 5 minutes
        return res.redirect(url);
      } catch (err) {
        console.warn("getBillPdf: failed to get signed url, falling back to generate/stream:", err);
        // continue to generate PDF buffer and stream
      }
    }

    // Otherwise generate fresh PDF buffer and stream it
    let pdfBuffer;
    try {
      pdfBuffer = await generateBillPdfBuffer(bill);
    } catch (genErr) {
      console.error("getBillPdf: PDF generation failed:", genErr);
      return res.status(500).json({ message: "Failed to generate PDF" });
    }

    if (!Buffer.isBuffer(pdfBuffer)) {
      console.error("getBillPdf: pdf generator did not return a Buffer");
      return res.status(500).json({ message: "Failed to generate PDF" });
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="bill_${bill._id}.pdf"`,
      "Content-Length": pdfBuffer.length,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    return res.send(pdfBuffer);
  } catch (err) {
    console.error("getBillPdf error:", err);
    return res.status(500).json({ message: "Failed to generate PDF" });
  }
};

/* ---------------- Payments ---------------- */
exports.createPaymentOrderForBill = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: "Bill not found" });

    const order = await createOrder({
      amount: bill.totalAmount,
      currency: "INR",
      receipt: `bill_${bill._id}`,
      notes: { tenantId: String(bill.tenant) },
    });

    bill.razorpayOrderId = order.id || order.order_id || order;
    await bill.save();

    res.json({
      orderId: order.id || order.order_id || null,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY || null,
      amount: bill.totalAmount,
    });
  } catch (err) {
    console.error("createPaymentOrderForBill error:", err);
    res.status(500).json({ message: "Failed to create payment order" });
  }
};

exports.markPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentRef, paidAt, method, paymentId } = req.body;

    let bill = await Bill.findById(id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    if (bill.paymentStatus === "Paid") {
      return res.status(400).json({ message: "Bill is already marked as Paid" });
    }

    // ✅ Update payment info
    bill.paymentStatus = "Paid";
    bill.payment = {
      status: "Paid",
      method: method || "UPI",
      reference: paymentRef || paymentId || req.body.razorpay_payment_id || "",
      paidAt: paidAt ? new Date(paidAt) : new Date(),
    };

    if (paymentId) bill.razorpayPaymentId = paymentId;
    if (req.body.razorpay_payment_id) bill.razorpayPaymentId = req.body.razorpay_payment_id;

    await bill.save();

    // ✅ Record payment on tenant
    try {
      const tenant = await Tenant.findById(bill.tenant._id  || bill.tenant.tenantId || bill.tenant );
      if (tenant) {
        tenant.payments = tenant.payments || [];
        tenant.payments.push({
          amount: bill.totalAmount,
          date: bill.payment.paidAt,
          method: bill.payment.method,
          receiptNumber: bill.payment.reference || undefined,
          note: `Payment for bill ${bill._id}`,
        });

        tenant.lastPayment = {
          amount: bill.totalAmount,
          date: bill.payment.paidAt,
          receiptNumber: bill.payment.reference || undefined,
        };

        if (tenant.duePayment && typeof tenant.duePayment.pendingAmount === "number") {
          tenant.duePayment.pendingAmount = Math.max(
            0,
            tenant.duePayment.pendingAmount - bill.totalAmount
          );
          if (tenant.duePayment.pendingAmount === 0)
            tenant.duePayment.dueDate = null;
        }

        await tenant.save();
      }
    } catch (tErr) {
      console.error("Failed to record payment on tenant:", tErr);
    }

    // ✅ Regenerate PDF, upload to R2 and send notifications
    try {
      const { filePath, r2 } = await writeBillPdfToDiskAndUpload(bill);
      if (r2 && r2.key) {
        bill.pdfKey = r2.key;
        bill.pdfUrl = r2.publicUrl;
      } else {
        bill.pdfUrl = `/pdfs/${path.basename(filePath)}`;
      }
      await bill.save();

      try {
        if (notificationService && typeof notificationService._removePendingEmailsForBill === "function") {
          notificationService._removePendingEmailsForBill(bill._id);
        }
      } catch (remErr) {
        console.warn("markPaid: failed to remove pending emails for bill:", remErr?.message || remErr);
      }

      // Send email
      const subject = templates.emailSubject(bill);
      const emailHtml = templates.emailHtml(bill);
      try {
        if (notificationService && typeof notificationService._sendBillEmailNow === "function") {
          await notificationService._sendBillEmailNow(bill, filePath, subject, emailHtml);
        } else if (notificationService && typeof notificationService.sendBillEmail === "function") {
          await notificationService.sendBillEmail(bill, filePath, subject, emailHtml);
        }
      } catch (emailErr) {
        console.warn("[EMAIL] Failed to send immediate paid-email for bill:", emailErr);
      }

      // Send WhatsApp
      try {
        const whatsappMsg = templates.whatsappBody(bill);
        if (bill.tenant?.phone) {
          await notificationService.sendBillWhatsApp(bill, filePath, whatsappMsg);
        }
      } catch (waErr) {
        console.warn("[WHATSAPP] Failed to send whatsapp for paid bill:", waErr);
      }

    } catch (pdfErr) {
      console.error("PDF generation / notification error after markPaid:", pdfErr);
    }

    res.json({
      success: true,
      message: "Bill marked as paid, PDF regenerated, notifications sent",
      pdfUrl: bill.pdfUrl,
    });
  } catch (err) {
    console.error("markPaid error:", err);
    res.status(500).json({
      message: "Failed to mark bill as paid",
      error: err.message,
    });
  }
};

/* ---------------- Resend Notifications ---------------- */
exports.resendBillNotifications = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    let filePath;
    try {
      const resObj = await writeBillPdfToDiskAndUpload(bill);
      filePath = resObj.filePath;
      if (resObj.r2 && resObj.r2.key) {
        bill.pdfKey = resObj.r2.key;
        bill.pdfUrl = resObj.r2.publicUrl;
      } else {
        bill.pdfUrl = `/pdfs/${path.basename(filePath)}`;
      }
      await bill.save();
    } catch (genErr) {
      console.error("resend: PDF generation error:", genErr);
    }

    // Send via email (use template)
    try {
      const subject = templates.emailSubject(bill);
      const emailHtml = templates.emailHtml(bill);
      await notificationService.sendBillEmail(bill, filePath, subject, emailHtml);
    } catch (err) {
      console.error("resend: sendBillEmail error:", err && err.message ? err.message : err);
    }

    // Send via WhatsApp (use template)
    try {
      const whatsappMsg = templates.whatsappBody(bill);
      await notificationService.sendBillWhatsApp(bill, filePath, whatsappMsg);
    } catch (err) {
      console.error("resend: sendBillWhatsApp error:", err && err.message ? err.message : err);
    }

    res.json({ message: "Notifications resent (email/WhatsApp) if configured" });
  } catch (err) {
    console.error("resendBillNotifications error:", err);
    res.status(500).json({ message: "Failed to resend bill notifications" });
  }
};

/* ---------------- Public lookup ---------------- */
exports.getBillsPublic = async (req, res) => {
  try {
    const { tenantId, roomNumber, month } = req.query;

    const q = {};
    if (month) {
      q.billingMonth = new RegExp(`^${month}`);
    }

    if (tenantId) {
      const tenant = await Tenant.findOne({ tenantId: tenantId.trim() });
      if (!tenant) return res.status(404).json({ message: "Tenant not found" });
      q.tenant = tenant._id;
    } else if (roomNumber) {
      const room = await Room.findOne({ number: roomNumber });
      if (!room) return res.status(404).json({ message: "Room not found" });
      q.room = room._id;
    } else {
      return res.status(400).json({ message: "tenantId is required" });
    }

    const bills = await Bill.find(q)
      .populate("tenant", "fullName tenantId")
      .populate("room", "number")
      .populate("building", "name address")
      .sort({ billingMonth: -1, createdAt: -1 });

    res.json(bills);
  } catch (err) {
    console.error("getBillsPublic error:", err);
    res.status(500).json({ message: "Failed to fetch bills" });
  }
};
