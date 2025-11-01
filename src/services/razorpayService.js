// backend/src/services/razorpayService.js
const Razorpay = require('razorpay');

const key_id = process.env.RAZORPAY_KEY_ID;
const key_secret = process.env.RAZORPAY_KEY_SECRET;

let razorpay = null;
if (key_id && key_secret) {
  razorpay = new Razorpay({ key_id, key_secret });
}

/**
 * Create a Razorpay order
 */
async function createOrder({ amount, receipt }) {
  if (!razorpay) return null;
  const options = {
    amount: Math.round(amount * 100),
    currency: 'INR',
    receipt: receipt || `rcpt_${Date.now()}`,
  };
  return razorpay.orders.create(options);
}

/**
 * Create a Razorpay payment link prefilled for UPI
 */
async function createPaymentLink({ amount, tenant, billId }) {
  if (!razorpay) return null;

  const options = {
    amount: Math.round(amount * 100),
    currency: 'INR',
    accept_partial: false,
    reference_id: billId ? `bill_${billId}` : `manual_${Date.now()}`,
    description: `Rent payment for bill ${billId || ''}`,
    customer: {
      name: tenant?.fullName || 'Tenant',
      email: tenant?.email || undefined,
      contact: tenant?.phone || undefined,
    },
    notify: {
      sms: true,
      email: true,
    },
    reminder_enable: true,
    notes: {
      billId: billId?.toString() || '',
      tenantId: tenant?._id?.toString() || '',
    },
    options: {
      checkout: {
        prefill: {
          method: 'upi',
          vpa: tenant?.vpa || '', // optional
        },
      },
    },
  };

  const link = await razorpay.paymentLink.create(options);
  return link;
}

module.exports = { createOrder, createPaymentLink };
