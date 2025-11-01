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

// unified pdf generator (returns Buffer)
const { generateBillPdf: generateBillPdfBuffer } = require("../utils/pdf");


// ensure pdf folder exists
const PDF_DIR = path.join(__dirname, "../../pdfs");
fs.mkdirSync(PDF_DIR, { recursive: true });

/**
 * Helper: generate PDF Buffer using unified generator and write to disk.
 * Returns absolute file path.
 */
async function writeBillPdfToDisk(bill) {
  if (!bill) throw new Error("Bill object is required to generate PDF");

  // Ensure the bill is populated with tenant/room/building where possible.
  // Caller should pass in a populated bill (we still guard below).
  const populatedBill = bill;

  // Generate Buffer
  const buffer = await generateBillPdfBuffer(populatedBill);

  if (!Buffer.isBuffer(buffer)) {
    throw new Error("PDF generator did not return a Buffer");
  }

  // Ensure dir exists
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

  const filename = `bill_${populatedBill._id}.pdf`;
  const filePath = path.join(PDF_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  return filePath;
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
      const pdfPath = await writeBillPdfToDisk(populated);
      populated.pdfUrl = `/pdfs/${path.basename(pdfPath)}`;
      await populated.save();
    } catch (pdfErr) {
      console.error("PDF generation failed during createBill:", pdfErr);
    }

    // notifications (don't fail creation if notifications fail)
    try {
      const pdfPath = path.join(PDF_DIR, `bill_${populated._id}.pdf`);
      if (populated.tenant?.email) await notificationService.sendBillEmail(populated, pdfPath);
      if (populated.tenant?.phone) await notificationService.sendBillWhatsApp(populated, pdfPath);
    } catch (notifyErr) {
      console.error("createBill notification error:", notifyErr);
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

    // Format month like "September, 2025"
    const formattedMonth = new Date(bill.billingMonth).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });

    // 1) Regenerate PDF
    let pdfPath = "";
    try {
      pdfPath = await writeBillPdfToDisk(bill);
      bill.pdfUrl = `/pdfs/${path.basename(pdfPath)}`;
      await bill.save();
    } catch (pdfErr) {
      console.error("PDF generation failed during updateBill:", pdfErr);
    }

    return res.status(200).json({
      success: true,
      message: "Bill updated and notifications sent (if configured)",
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
      const pdfPath = await writeBillPdfToDisk(bill);
      bill.pdfUrl = `/pdfs/${path.basename(pdfPath)}`;
      await bill.save();

      // try to remove any pending queued emails for this bill (if implemented)
      try {
        if (notificationService && typeof notificationService._removePendingEmailsForBill === "function") {
          notificationService._removePendingEmailsForBill(bill._id);
        }
      } catch (remErr) {
        console.warn("markPaidPublic: failed to remove pending emails:", remErr);
      }

      // immediate paid email (bypass queue)
      const frontendBase = process.env.FRONTEND_URL || "http://localhost:3000";
      const downloadLink = `${frontendBase}/api/bills/${bill._id}/pdf`;

      const formattedMonth = new Date(bill.billingMonth).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });

      // Attempt to send immediate paid email (notificationService exposes _sendBillEmailNow)
      try {
        const subject = `✅ Payment Confirmation - ${formattedMonth}`;
        const emailHtml =``;
        if (notificationService && typeof notificationService._sendBillEmailNow === "function") {
          await notificationService._sendBillEmailNow(bill, pdfPath, subject, emailHtml);
        } else if (notificationService && typeof notificationService.sendBillEmail === "function") {
          // fallback to queued send
          await notificationService.sendBillEmail(bill, pdfPath, subject, emailHtml);
        }
      } catch (emailErr) {
        console.warn("markPaidPublic: failed to send paid-email:", emailErr);
      }

      // WhatsApp summary (best-effort)
      try {
        const whatsappMsg = [
          `✅ Payment Successful!`,
          ``,
          `Your ID: ${bill.tenant?.tenantId || "N/A"}`,
          `Room: ${bill.room?.number || "N/A"}`,
          `Building: ${bill.building?.name || "N/A"}`,
          ``,
          `Month: ${formattedMonth}`,
          `Amount: ₹${bill.totalAmount}`,
          `Method: ${bill.payment.method || "N/A"}`,
          `Reference: ${bill.payment.reference || "N/A"}`,
          `Paid At: ${bill.payment.paidAt ? bill.payment.paidAt.toLocaleString() : "N/A"}`,
          ``,
          `Download paid bill: ${downloadLink}`,
          ``,
          `Thank you!`,
        ].join("\n");

        if (notificationService && typeof notificationService.sendBillWhatsApp === "function" && bill.tenant?.phone) {
          await notificationService.sendBillWhatsApp(bill, pdfPath, whatsappMsg);
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

    const pdfPath = await writeBillPdfToDisk(bill);
    bill.pdfUrl = `/pdfs/${path.basename(pdfPath)}`;
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

/* ---------------- Download PDF ---------------- */
exports.getBillPdf = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate("tenant", "fullName tenantId email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    const pdfPath = path.join(PDF_DIR, `bill_${bill._id}.pdf`);

    // if file doesn't exist, generate synchronously (so user gets fresh PDF)
    if (!fs.existsSync(pdfPath)) {
      try {
        await writeBillPdfToDisk(bill);
      } catch (genErr) {
        console.error("generateBillPdf error (getBillPdf):", genErr);
        return res.status(500).json({ message: "Failed to generate PDF" });
      }
    }

    return res.download(pdfPath);
  } catch (err) {
    console.error("getBillPdf error:", err);
    res.status(500).json({ message: "Failed to generate PDF" });
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

    // ✅ Regenerate PDF and send notifications
    try {
      const pdfPath = await writeBillPdfToDisk(bill);
      bill.pdfUrl = `/pdfs/${path.basename(pdfPath)}`;
      await bill.save();

      const frontendBase = process.env.FRONTEND_URL || "http://localhost:3000";
      const downloadLink = `${frontendBase}/api/bills/${bill._id}/pdf`;

      const formattedMonth = new Date(bill.billingMonth).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });


      try {
        notificationService._removePendingEmailsForBill(bill._id);
      } catch (remErr) {
        console.warn("Failed to remove pending emails for bill:", remErr?.message || remErr);
      }

      const tenantName = bill.tenant?.fullName || "Tenant";
      const tenantId = bill.tenant?.tenantId || "N/A";
      const roomNumber = bill.room?.number || "N/A";

      // ===== 📧 EMAIL MESSAGE =====
      const subject = `✅ Payment Confirmation - ${formattedMonth}`;
      const emailHtml = `
        <p>Thank you for your timely payment.</p>
        <hr/>
        <small>This is an automated email. Please do not reply.</small>
      `;
      // Send email immediately (bypass queue)
      try {
        await notificationService._sendBillEmailNow(bill, pdfPath, subject, emailHtml);
        console.log(`[EMAIL] Immediate paid-email sent for bill ${bill._id}`);
      } catch (emailErr) {
        console.warn(`[EMAIL] Failed to send immediate paid-email for bill ${bill._id}:`, emailErr?.message || emailErr);
      }


      // ===== 💬 WHATSAPP MESSAGE =====
      const whatsappMsg = [
        `✅ *Payment Successful!*`,
        ``,
        `*Your ID:* ${tenantId}`,
        `*Room:* ${roomNumber}`,
        `*Building:* ${bill.building?.name || "N/A"}`,
        ``,
        `*Month:* ${formattedMonth}`,
        `*Amount:* ₹${bill.totalAmount}`,
        `*Method:* ${bill.payment.method}`,
        `*Reference:* ${bill.payment.reference || "N/A"}`,
        `*Paid At:* ${bill.payment.paidAt.toLocaleString()}`,
        ``,
        `Download your paid bill:`,
        `${downloadLink}`,
        ``,
        `Thank you for your payment!`,
      ].join("\n");

      if (bill.tenant?.phone) {
        await notificationService.sendBillWhatsApp(bill, pdfPath, whatsappMsg);
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
      .populate("tenant", "fullName tenantID email phone")
      .populate("room", "number")
      .populate("building", "name address");

    if (!bill) return res.status(404).json({ message: "Bill not found" });

    let pdfPath;
    try {
      pdfPath = await writeBillPdfToDisk(bill);
      bill.pdfPath = pdfPath;
      bill.pdfUrl = `/pdfs/${path.basename(pdfPath)}`;
      await bill.save();
    } catch (genErr) {
      console.error("resend: PDF generation error:", genErr);
    }

    // Send via email
    try {
      await notificationService.sendBillEmail(bill, pdfPath);
    } catch (err) {
      console.error("resend: sendBillEmail error:", err && err.message ? err.message : err);
    }

    // Send via WhatsApp
    try {
      await notificationService.sendBillWhatsApp(bill, pdfPath);
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
      return res.status(400).json({ message: "tenantId or roomNumber is required" });
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
