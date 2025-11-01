// backend/src/controllers/paymentController.js
// Safer payment controller that uses the lazy razorpayService.createOrder
const Bill = require('../models/Bill');
const Payment = require('../models/Payment') || null; // optional model
const Tenant = require('../models/Tenant');
const { createOrder, createPaymentLink } = require('../services/razorpayService');
const crypto = require('crypto');

// Optional services (only used if available)
let pdfService = null;
let notificationService = null;
try {
  pdfService = require('../services/pdfService');
} catch (e) {
  // ignore if not present
}
try {
  notificationService = require('../services/notificationService');
} catch (e) {
  // ignore if not present
}



exports.createPaymentLinkForBill = async (req, res) => {
  try {
    const { billId } = req.body;
    if (!billId) {
      return res.status(400).json({ message: 'billId is required' });
    }

    const bill = await Bill.findById(billId).populate('tenant');
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }

    const tenant = bill.tenant || {};

    const link = await createPaymentLink({
      amount: bill.totalAmount,
      tenant,
      billId,
    });

    if (!link) {
      return res.status(503).json({
        message: 'Razorpay not configured. Please check API keys in .env',
      });
    }

    // Store the link in bill
    bill.paymentLink = link.short_url;
    bill.paymentRef = link.id;
    await bill.save();

    // Optionally send via WhatsApp or Email
    try {
      if (notificationService?.sendPaymentLink) {
        await notificationService.sendPaymentLink(tenant, link.short_url);
      }
    } catch (notifyErr) {
      console.error('Error sending payment link:', notifyErr);
    }

    res.json({
      message: 'Payment link created successfully',
      link: link.short_url,
      billId: bill._id,
      status: link.status,
    });
  } catch (err) {
    console.error('createPaymentLinkForBill error:', err);
    res.status(500).json({ message: 'Failed to create payment link' });
  }
};

// POST /api/payments/create-order (or /api/bills/:id/create-order used previously)
// creates a razorpay order for a specific bill or for a generic amount
exports.createOrderForBill = async (req, res) => {
  try {
    const { billId, amount } = req.body;

    // If billId provided, prefer that to fetch amount from DB
    let orderTargetAmount = amount;
    let bill = null;
    if (billId) {
      bill = await Bill.findById(billId);
      if (!bill) return res.status(404).json({ message: 'Bill not found' });
      orderTargetAmount = bill.totalAmount;
    }

    if (!orderTargetAmount || Number(orderTargetAmount) <= 0) {
      return res.status(400).json({ message: 'amount is required and must be > 0' });
    }

    const order = await createOrder({ amount: orderTargetAmount, receipt: billId ? `bill_${billId}` : `manual_${Date.now()}` });

    if (!order) {
      // createOrder returns null when Razorpay keys are not configured
      return res.status(503).json({
        message: 'Payment provider not configured. Please configure Razorpay keys in backend .env (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET).'
      });
    }

    // If we created order for a bill, store the order id on the bill
    if (bill) {
      bill.paymentRef = order.id;
      bill.paymentLink = `https://checkout.razorpay.com/v1/checkout.js?order_id=${order.id}`;
      await bill.save();
    }

    return res.json({
      orderId: order.id,
      amount: Number(order.amount) / 100,
      currency: order.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || null
    });
  } catch (err) {
    console.error('createOrderForBill error:', err);
    return res.status(500).json({ message: err.message || 'Server error' });
  }
};

/**
 * POST /api/payments/verify
 * Verify razorpay payment signature and mark bill paid.
 * Expected body: { billId?, orderId, paymentId, signature, amountPaid? }
 */
exports.verifyPayment = async (req, res) => {
  try {
    const { billId, orderId, paymentId, signature, amountPaid } = req.body;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ success: false, message: 'orderId, paymentId and signature are required' });
    }

    // Build hmac for order_id|payment_id
    const hmacBody = `${orderId}|${paymentId}`;
    const secret = process.env.RAZORPAY_KEY_SECRET || '';

    if (!secret) {
      console.warn('verifyPayment: RAZORPAY_KEY_SECRET not configured.');
      return res.status(500).json({ success: false, message: 'Payment verification not possible (server misconfigured).' });
    }

    const expectedSignature = crypto.createHmac('sha256', secret).update(hmacBody).digest('hex');

    if (expectedSignature !== signature) {
      console.warn('Razorpay signature mismatch', { orderId, paymentId, signature, expectedSignature });
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // Signature valid — update bill and tenant
    let bill = null;
    if (billId) {
      bill = await Bill.findById(billId);
    }
    // fallback: find by stored order id (paymentRef stored earlier as order id)
    if (!bill && orderId) {
      bill = await Bill.findOne({ paymentRef: orderId });
    }

    if (!bill) {
      // Payment verified but bill not found. Respond success but warn.
      console.warn('verifyPayment: no bill found for', { billId, orderId, paymentId });
      return res.json({ success: true, message: 'Payment verified but bill not found', orderId, paymentId });
    }

    // Update bill fields
    bill.status = 'paid';
    bill.paymentRef = paymentId; // store razorpay payment id as paymentRef (you can keep order id elsewhere)
    bill.paidAt = new Date();
    bill.paymentDetails = bill.paymentDetails || {};
    bill.paymentDetails.razorpay = {
      orderId,
      paymentId,
      signature,
      amountPaid: amountPaid ?? bill.totalAmount
    };
    bill.paymentStatus = 'Paid';
    await bill.save();

    // Record in tenant history if tenant exists
    try {
      const tenant = await Tenant.findById(bill.tenant);
      if (tenant) {
        tenant.payments = tenant.payments || [];
        tenant.payments.push({
          amount: amountPaid ?? bill.totalAmount,
          date: new Date(),
          method: 'razorpay',
          receiptNumber: paymentId,
          note: `Payment for bill ${bill._id}`,
        });
        tenant.lastPayment = { amount: amountPaid ?? bill.totalAmount, date: new Date(), receiptNumber: paymentId };
        await tenant.save();
      }
    } catch (pErr) {
      console.error('Failed to append payment to tenant in verifyPayment:', pErr);
    }

    // Optionally generate PDF receipt & notify tenant/manager (best-effort)
    try {
      if (pdfService && typeof pdfService.generateReceipt === 'function') {
        // generateReceipt can be async and return path or buffer — adapt to your implementation
        await pdfService.generateReceipt(bill);
      }
      if (notificationService && typeof notificationService.sendPaymentNotification === 'function') {
        // Example: sendPaymentNotification(toTenantOrManager, bill) — adapt per your service API
        await notificationService.sendPaymentNotification(bill);
      }
    } catch (notifyErr) {
      console.error('Failed to generate/send receipt (verifyPayment):', notifyErr);
    }

    return res.json({ success: true, message: 'Payment verified and bill updated', billId: bill._id });
  } catch (err) {
    console.error('verifyPayment error:', err);
    return res.status(500).json({ success: false, message: 'Server error during payment verification' });
  }
};

// POST /api/payments/webhook
// Example webhook handler to accept razorpay webhooks and mark bill as paid
// Make sure you configure webhook secret and verify signature if you want security.
// This handler expects the raw body to be available as req.rawBody (you already set express.json verify)
exports.webhook = async (req, res) => {
  try {
    // Basic logging for incoming webhook
    const raw = req.rawBody ? req.rawBody.toString() : null;
    const event = req.body;

    console.log('Received payment webhook event:', event && event.event ? event.event : 'unknown');

    // Optional: verify webhook signature if RAZORPAY_WEBHOOK_SECRET provided
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (webhookSecret) {
      const signatureHeader = req.headers['x-razorpay-signature'] || req.headers['X-Razorpay-Signature'];
      if (!signatureHeader) {
        console.warn('webhook: missing x-razorpay-signature header');
        return res.status(400).json({ ok: false, message: 'Missing signature' });
      }
      const expected = crypto.createHmac('sha256', webhookSecret).update(raw || '').digest('hex');
      if (signatureHeader !== expected) {
        console.warn('webhook signature mismatch', { signatureHeader, expected });
        return res.status(400).json({ ok: false, message: 'Invalid webhook signature' });
      }
    }

    // Example: handle payment.captured or payment.authorized
    if (event && event.event === 'payment.captured') {
      const paymentEntity = event.payload?.payment?.entity;
      const razorpayPaymentId = paymentEntity?.id;
      const razorpayOrderId = paymentEntity?.order_id;
      const amount = (paymentEntity?.amount || 0) / 100;

      // Try to find a bill with matching paymentRef (order id stored earlier)
      let bill = null;
      if (razorpayOrderId) {
        bill = await Bill.findOne({ paymentRef: razorpayOrderId });
      }

      // As a fallback, if webhook contains note or metadata identifying the bill, you could parse it.
      // Mark bill as paid and record tenant payment
      if (bill) {
        bill.status = 'paid';
        bill.paymentRef = razorpayPaymentId || bill.paymentRef;
        bill.paidAt = new Date();
        bill.paymentDetails = bill.paymentDetails || {};
        bill.paymentDetails.razorpay = {
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          webhook: true,
          rawPayload: paymentEntity,
        };
        bill.paymentStatus = 'Paid';
        await bill.save();

        try {
          const tenant = await Tenant.findById(bill.tenant);
          if (tenant) {
            tenant.payments = tenant.payments || [];
            tenant.payments.push({
              amount,
              date: new Date(),
              method: 'razorpay',
              receiptNumber: razorpayPaymentId,
              note: `Payment via webhook for bill ${bill._id}`
            });
            tenant.lastPayment = { amount, date: new Date(), receiptNumber: razorpayPaymentId };
            await tenant.save();
          }
        } catch (pErr) {
          console.error('Failed to record payment on tenant (webhook):', pErr);
        }

        // Optionally notify / generate receipt (best-effort)
        try {
          if (pdfService && typeof pdfService.generateReceipt === 'function') {
            await pdfService.generateReceipt(bill);
          }
          if (notificationService && typeof notificationService.sendPaymentNotification === 'function') {
            await notificationService.sendPaymentNotification(bill);
          }
        } catch (notifyErr) {
          console.error('Failed to generate/send receipt (webhook):', notifyErr);
        }
      } else {
        console.warn('Webhook: no matching bill found for order id', razorpayOrderId);
      }
    }

    // Respond 200 to acknowledge receipt
    res.json({ ok: true });
  } catch (err) {
    console.error('payment webhook error:', err);
    res.status(500).json({ message: 'Webhook processing error' });
  }
};

// POST /api/payments/mark-paid - alternative endpoint to mark bill paid from client/server
exports.markBillPaidManually = async (req, res) => {
  try {
    const { billId, paymentRef, paidAt, method } = req.body;
    if (!billId) return res.status(400).json({ message: 'billId is required' });

    const bill = await Bill.findById(billId);
    if (!bill) return res.status(404).json({ message: 'Bill not found' });

    bill.status = 'paid';
    bill.paymentRef = paymentRef || bill.paymentRef;
    bill.paidAt = paidAt ? new Date(paidAt) : new Date();
    await bill.save();

    // record in tenant
    try {
      const tenant = await Tenant.findById(bill.tenant);
      if (tenant) {
        tenant.payments = tenant.payments || [];
        tenant.payments.push({
          amount: bill.totalAmount,
          date: bill.paidAt,
          method: method || 'manual',
          receiptNumber: paymentRef
        });
        tenant.lastPayment = { amount: bill.totalAmount, date: bill.paidAt, receiptNumber: paymentRef || undefined };
        await tenant.save();
      }
    } catch (pErr) {
      console.error('Failed to record payment on tenant (manual):', pErr);
    }

    res.json({ message: 'Bill marked paid', bill });
  } catch (err) {
    console.error('markBillPaidManually error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};
