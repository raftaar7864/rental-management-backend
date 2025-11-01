// backend/src/models/Payment.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  amount: Number,
  method: String,
  razorpayPaymentId: String,
  razorpayOrderId: String,
  status: { type: String, enum: ['pending','paid','failed'], default: 'pending' },
  month: String,
  createdAt: { type: Date, default: Date.now },
  receiptNo: String
});

module.exports = mongoose.model('Payment', paymentSchema);
