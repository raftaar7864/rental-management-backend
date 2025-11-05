// backend/src/controllers/billController.js
const path = require("path");
const Bill = require("../models/Bill");
const Tenant = require("../models/Tenant");
const Room = require("../models/Room");
const Building = require("../models/Building");
const { createOrder } = require("../services/razorpayService");
const notificationService = require("../services/notificationService");

// AWS v3 S3 client (Cloudflare R2)
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// templates
const templates = require("../utils/notificationTemplete");

// unified pdf generator (returns Buffer)
const { generateBillPdf: generateBillPdfBuffer } = require("../utils/pdf");

// R2 config
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
const R2_REGION = process.env.R2_REGION || "auto";

if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_ENDPOINT) {
  console.warn("Cloudflare R2 not fully configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_ENDPOINT when deploying.");
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
    // You can add ACL or metadata if needed
  });
  await s3Client.send(cmd);
  // publicUrl pattern — may not be public; we still return it
  const publicUrl = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeURIComponent(key)}`;
  return { key, publicUrl };
}

// Get signed URL for private access
async function getSignedUrlForKey(key, expiresInSeconds = 60 * 60) {
  if (!key) throw new Error("R2 key is required for signed url");
  const getCmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  const url = await getSignedUrl(s3Client, getCmd, { expiresIn: expiresInSeconds });
  return url;
}

/* Generate PDF buffer and upload directly to R2.
   Returns: { key, publicUrl, signedUrl }
*/
async function generateAndUploadPdfToR2(bill) {
  if (!bill) throw new Error("Bill object is required to generate PDF");

  const buffer = await generateBillPdfBuffer(bill);
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new Error("PDF generator did not return a Buffer or Uint8Array");
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (!R2_BUCKET || !R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 not configured");
  }

  const filename = `bill_${bill._id}.pdf`;
  const key = `bills/${filename}`;

  await uploadPdfBufferToR2(buf, key);

  // signed URL for immediate use (5 minutes)
  const signedUrl = await getSignedUrlForKey(key, 60 * 5);

  // public url pattern (may or may not be publicly accessible)
  const publicUrl = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeURIComponent(key)}`;

  return { key, publicUrl, signedUrl };
}

/* -------------------- CRUD and PDF endpoints -------------------- */

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

exports.createBill = async (req, res) => {
  try {
    const { tenant, room, billingMonth, charges = [], totalAmount, totals = {}, notes, paymentLink } = req.body;

    // Respect explicit sendNotifications flag (default true)
    const shouldSendNotifications = typeof req.body.sendNotifications === "boolean" ? req.body.sendNotifications : true;

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

    // generate PDF and upload to R2 (do not fail creation if pdf/upload fails)
    let r2Result = null;
    try {
      r2Result = await generateAndUploadPdfToR2(populated);
      if (r2Result && r2Result.key) {
        populated.pdfKey = r2Result.key;
        populated.pdfUrl = r2Result.publicUrl; // convenience public url (may or may not be public)
        await populated.save();
      }
    } catch (pdfErr) {
      console.error("PDF generation/upload failed during createBill:", pdfErr);
    }

    // Notifications — only if explicitly allowed by frontend
    if (shouldSendNotifications) {
      try {
        const stamp = populated.createdAt ? new Date(populated.createdAt).getTime() : Date.now();
        const subject = templates.emailSubject(populated);
        const emailHtml = templates.emailHtml(populated, { stamp });
        const whatsappMsg = templates.whatsappBody(populated, { stamp });

        // Email
        if (populated.tenant?.email) {
          try {
            if (notificationService && typeof notificationService._sendBillEmailNow === "function") {
              await notificationService._sendBillEmailNow(populated, r2Result?.publicUrl || null, subject, emailHtml);
              console.log(`[EMAIL] Immediate create-email sent for bill ${populated._id} to ${populated.tenant.email}`);
            } else if (notificationService && typeof notificationService.sendBillEmail === "function") {
              await notificationService.sendBillEmail(populated, r2Result?.publicUrl || null, subject, emailHtml);
              console.log(`[EMAIL] Queued create-email for bill ${populated._id}`);
            } else {
              console.warn("[EMAIL] notificationService send function not available");
            }
          } catch (emailErr) {
            console.warn("[EMAIL] createBill: failed to send email:", emailErr?.message || emailErr);
          }
        }

        // WhatsApp
        if (populated.tenant?.phone) {
          try {
            if (notificationService && typeof notificationService.sendBillWhatsApp === "function") {
              await notificationService.sendBillWhatsApp(populated, r2Result?.publicUrl || null, whatsappMsg);
              console.log(`[WHATSAPP] createBill: WhatsApp sent for bill ${populated._id} to ${populated.tenant.phone}`);
            } else if (notificationService && typeof notificationService.sendWhatsApp === "function") {
              // fallback
              await notificationService.sendWhatsApp(populated, r2Result?.publicUrl || null, whatsappMsg);
              console.log(`[WHATSAPP] createBill: WhatsApp sent (fallback) for bill ${populated._id}`);
            } else {
              console.warn("[WHATSAPP] notificationService whatsapp function not available");
            }
          } catch (waErr) {
            console.warn("[WHATSAPP] createBill: failed to send WhatsApp:", waErr?.message || waErr);
          }
        }
      } catch (notifyErr) {
        console.warn("createBill: notification attempt failed:", notifyErr);
      }
    } else {
      console.log(`Notifications skipped for bill ${populated._id} (sendNotifications=false)`);
    }

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

    // Respect explicit sendNotifications flag (default true)
    const shouldSendNotifications = typeof data.sendNotifications === "boolean" ? data.sendNotifications : true;

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

    // Format month like "September, 2025" for message contexts (not strictly required)
    const formattedMonth = bill.billingMonth ? new Date(bill.billingMonth).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    }) : "-";

    // 1) Try to upload regenerated PDF to R2 (preferred). Fallback to disk-write if needed.
    let pdfPathOrUrl = null;
    try {
      const r2 = await generateAndUploadPdfToR2(bill);
      if (r2 && r2.key) {
        bill.pdfKey = r2.key;
        bill.pdfUrl = r2.publicUrl;
        await bill.save();
        pdfPathOrUrl = r2.publicUrl; // prefer public/signed url for sending
        console.log(`updateBill: uploaded PDF to R2 for bill ${bill._id}`);
      }
    } catch (r2Err) {
      console.warn("updateBill: R2 upload failed, will try disk write:", r2Err?.message || r2Err);
      try {
        if (typeof writeBillPdfToDisk === "function") {
          const diskPath = await writeBillPdfToDisk(bill);
          bill.pdfUrl = `/pdfs/${path.basename(diskPath)}`;
          await bill.save();
          pdfPathOrUrl = diskPath;
          console.log(`updateBill: wrote PDF to disk for bill ${bill._id}`);
        }
      } catch (diskErr) {
        console.error("updateBill: disk PDF write also failed:", diskErr?.message || diskErr);
      }
    }

    // 2) Send notifications if requested
    if (shouldSendNotifications) {
      try {
        const stamp = bill.createdAt ? new Date(bill.createdAt).getTime() : Date.now();

        const subject = templates.emailSubject(bill);
        const emailHtml = templates.emailHtml(bill, { stamp });
        const whatsappMsg = templates.whatsappBody(bill, { stamp });

        const tenantEmail = bill.tenant?.email;
        const tenantPhone = bill.tenant?.phone;

        // EMAIL (prefer immediate)
        if (tenantEmail) {
          try {
            if (notificationService && typeof notificationService._sendBillEmailNow === "function") {
              await notificationService._sendBillEmailNow(bill, pdfPathOrUrl, subject, emailHtml);
              console.log(`[EMAIL] Immediate update email sent for bill ${bill._id} to ${tenantEmail}`);
            } else if (notificationService && typeof notificationService.sendBillEmail === "function") {
              await notificationService.sendBillEmail(bill, pdfPathOrUrl, subject, emailHtml);
              console.log(`[EMAIL] Queued update email for bill ${bill._id} to ${tenantEmail}`);
            } else {
              console.warn("[EMAIL] notificationService email function not available");
            }
          } catch (emailErr) {
            console.warn(`[EMAIL] Failed to send update email for bill ${bill._id}:`, emailErr?.message || emailErr);
          }
        }

        // WHATSAPP
        if (tenantPhone) {
          try {
            if (notificationService && typeof notificationService.sendBillWhatsApp === "function") {
              await notificationService.sendBillWhatsApp(bill, pdfPathOrUrl, whatsappMsg);
              console.log(`[WHATSAPP] Update WhatsApp sent for bill ${bill._id} to ${tenantPhone}`);
            } else if (notificationService && typeof notificationService.sendWhatsApp === "function") {
              await notificationService.sendWhatsApp(bill, pdfPathOrUrl, whatsappMsg);
              console.log(`[WHATSAPP] Update WhatsApp (fallback) sent for bill ${bill._id}`);
            } else {
              console.warn("[WHATSAPP] notificationService WhatsApp function not available");
            }
          } catch (waErr) {
            console.warn(`[WHATSAPP] Failed to send update WhatsApp for bill ${bill._id}:`, waErr?.message || waErr);
          }
        }
      } catch (notifyErr) {
        console.warn("updateBill: notification attempt failed:", notifyErr);
      }
    } else {
      console.log(`Notifications skipped for bill ${bill._id} (sendNotifications=false)`);
    }

    return res.status(200).json({
      success: true,
      message: "Bill updated" + (shouldSendNotifications ? " and notifications attempted (if configured)" : " (notifications skipped)"),
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

    const paidStatus = (bill.paymentStatus || bill.status || "").toString().toLowerCase();
    if (paidStatus === "paid") {
      return res.status(400).json({ message: "Bill already paid" });
    }

    const order = await createOrder({
      amount: bill.totalAmount,
      currency: "INR",
      receipt: `bill_${bill._id}`,
      notes: { tenantId: String(bill.tenant) },
    });

    if (!order) {
      return res.status(503).json({ message: "Payment provider not configured" });
    }

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

exports.markPaidPublic = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentRef, paidAt, method, paymentId } = req.body;

    const bill = await Bill.findById(id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    if ((bill.paymentStatus || "").toString().toLowerCase() === "paid") {
      return res.status(400).json({ message: "Bill already marked as paid" });
    }

    bill.paymentStatus = "Paid";
    bill.payment = {
      status: "Paid",
      method: method || "Online",
      reference: paymentRef || paymentId || req.body.razorpay_payment_id || "",
      paidAt: paidAt ? new Date(paidAt) : new Date(),
    };
    if (paymentId) bill.razorpayPaymentId = paymentId;
    if (req.body.razorpay_payment_id) bill.razorpayPaymentId = req.body.razorpay_payment_id;

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

    // Regenerate PDF, upload to R2 and send notifications
    try {
      const r2 = await generateAndUploadPdfToR2(bill);
      if (r2 && r2.key) {
        bill.pdfKey = r2.key;
        bill.pdfUrl = r2.publicUrl;
      }
      await bill.save();

      try {
        if (notificationService && typeof notificationService._removePendingEmailsForBill === "function") {
          notificationService._removePendingEmailsForBill(bill._id);
        }
      } catch (remErr) {
        console.warn("markPaidPublic: failed to remove pending emails:", remErr);
      }

      const subject = templates.emailSubject(bill);
      const emailHtml = templates.emailHtml(bill);
      try {
        if (notificationService && typeof notificationService._sendBillEmailNow === "function") {
          await notificationService._sendBillEmailNow(bill, null, subject, emailHtml);
        } else if (notificationService && typeof notificationService.sendBillEmail === "function") {
          await notificationService.sendBillEmail(bill, null, subject, emailHtml);
        }
      } catch (emailErr) {
        console.warn("markPaidPublic: failed to send paid-email:", emailErr);
      }

      // WhatsApp via template
      try {
        const whatsappMsg = templates.whatsappBody(bill);
        if (notificationService && typeof notificationService.sendBillWhatsApp === "function" && bill.tenant?.phone) {
          await notificationService.sendBillWhatsApp(bill, null, whatsappMsg);
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

exports.generateBillPdf = async (req, res) => {
  try {
    const billId = req.params.id;
    const bill = await Bill.findById(billId)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    const r2 = await generateAndUploadPdfToR2(bill);
    if (r2 && r2.key) {
      bill.pdfKey = r2.key;
      bill.pdfUrl = r2.publicUrl;
    }
    await bill.save();

    return res.status(200).json({
      success: true,
      pdfUrl: bill.pdfUrl,
      message: "Bill PDF generated and uploaded successfully",
    });
  } catch (err) {
    console.error("generateBillPdf error:", err);
    res.status(500).json({
      message: "Failed to generate Bill PDF",
      error: err.message,
    });
  }
};

exports.getBillPdf = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    // If pdfKey exists, redirect to signed URL
    if (bill.pdfKey) {
      try {
        const url = await getSignedUrlForKey(bill.pdfKey, 60 * 5); // 5 minutes
        return res.redirect(url);
      } catch (err) {
        console.warn("getBillPdf: failed to get signed url, falling back to regenerate:", err);
        // fall through to regenerate
      }
    }

    // No pdfKey - generate+upload then redirect
    try {
      const r2 = await generateAndUploadPdfToR2(bill);
      if (r2 && r2.key) {
        bill.pdfKey = r2.key;
        bill.pdfUrl = r2.publicUrl;
        await bill.save();
        const url = await getSignedUrlForKey(r2.key, 60 * 5);
        return res.redirect(url);
      } else {
        return res.status(500).json({ message: "Failed to upload PDF to storage" });
      }
    } catch (genErr) {
      console.error("getBillPdf: PDF generation failed:", genErr);
      return res.status(500).json({ message: "Failed to generate PDF" });
    }
  } catch (err) {
    console.error("getBillPdf error:", err);
    return res.status(500).json({ message: "Failed to generate PDF" });
  }
};

/* Payments & markPaid handlers are kept mostly same but upload PDF after marking paid (see markPaid below) */

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

    // Record payment on tenant
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

    // Regenerate PDF, upload to R2 and send notifications
    try {
      const r2 = await generateAndUploadPdfToR2(bill);
      if (r2 && r2.key) {
        bill.pdfKey = r2.key;
        bill.pdfUrl = r2.publicUrl;
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
          await notificationService._sendBillEmailNow(bill, null, subject, emailHtml);
        } else if (notificationService && typeof notificationService.sendBillEmail === "function") {
          await notificationService.sendBillEmail(bill, null, subject, emailHtml);
        }
      } catch (emailErr) {
        console.warn("[EMAIL] Failed to send immediate paid-email for bill:", emailErr);
      }

      // Send WhatsApp
      try {
        const whatsappMsg = templates.whatsappBody(bill);
        if (bill.tenant?.phone) {
          await notificationService.sendBillWhatsApp(bill, null, whatsappMsg);
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

exports.resendBillNotifications = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    // Ensure PDF exists on R2 (generate/upload if missing)
    try {
      if (!bill.pdfKey) {
        const r2 = await generateAndUploadPdfToR2(bill);
        if (r2 && r2.key) {
          bill.pdfKey = r2.key;
          bill.pdfUrl = r2.publicUrl;
          await bill.save();
        }
      }
    } catch (genErr) {
      console.error("resend: PDF generation error:", genErr);
    }

    // Send via email (use template)
    try {
      const subject = templates.emailSubject(bill);
      const emailHtml = templates.emailHtml(bill);
      await notificationService.sendBillEmail(bill, null, subject, emailHtml);
    } catch (err) {
      console.error("resend: sendBillEmail error:", err && err.message ? err.message : err);
    }

    // Send via WhatsApp (use template)
    try {
      const whatsappMsg = templates.whatsappBody(bill);
      await notificationService.sendBillWhatsApp(bill, null, whatsappMsg);
    } catch (err) {
      console.error("resend: sendBillWhatsApp error:", err && err.message ? err.message : err);
    }

    res.json({ message: "Notifications resent (email/WhatsApp) if configured" });
  } catch (err) {
    console.error("resendBillNotifications error:", err);
    res.status(500).json({ message: "Failed to resend bill notifications" });
  }
};

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
