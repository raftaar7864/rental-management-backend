// backend/src/routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');


// If you protect some routes with auth, require the middleware here.
// const { requireAuth, requireRole } = require('../middleware/authMiddleware');

console.log('paymentController.verifyPayment type:', typeof paymentController.verifyPayment); // should print 'function'


router.post('/verify', paymentController.verifyPayment);


// Create Razorpay order for a bill (or generic amount)
router.post('/create-order', paymentController.createOrderForBill);

// Webhook endpoint for payment provider (should be raw-body friendly)
// Note: do NOT wrap the handler in parentheses (i.e. do NOT call it).
router.post('/webhook', paymentController.webhook);

// Optional: client or admin can call this to mark bill paid manually (body: { billId, paymentRef, paidAt })
router.post('/mark-paid', paymentController.markBillPaidManually);

router.post('/create-link', paymentController.createPaymentLinkForBill);

module.exports = router;
