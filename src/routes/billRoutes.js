const express = require("express");
const router = express.Router();
const billController = require("../controllers/billController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

/**
 * ============================
 * Public / Tenant Routes
 * ============================
 */
// Tenant can fetch their bills by tenantId or roomNumber
router.get("/public", billController.getBillsPublic);

// Public payment endpoints (no auth) - these call billController public helpers
router.post("/:id/create-payment-order-public", billController.createPaymentOrderPublic);
router.post("/:id/mark-paid-public", billController.markPaidPublic);

/**
 * ============================
 * Admin / Manager Protected Routes
 * ============================
 */

// Get all bills
router.get("/", requireAuth, requireRole("admin", "manager"), billController.getBills);

// Get a single bill by ID
router.get("/:id", requireAuth, requireRole("admin", "manager"), billController.getBill);

// Create a new bill
router.post("/", requireAuth, requireRole("admin", "manager"), billController.createBill);

// Update a bill
router.put("/:id", requireAuth, requireRole("admin", "manager"), billController.updateBill);

// Delete a bill
router.delete("/:id", requireAuth, requireRole("admin"), billController.deleteBill);

// Download PDF for a bill (public access currently - keep if desired)
router.get("/:id/pdf", billController.getBillPdf);

// Create payment order for a bill (admin flow)
router.post("/:id/create-order", requireAuth, requireRole("admin", "manager"), billController.createPaymentOrderForBill);

// Generate PDF (admin)
router.post("/:id/generate-pdf", requireAuth, requireRole("admin", "manager"), billController.generateBillPdf);

// Mark bill as paid (admin/manager)
router.put("/:id/pay", billController.markPaid);

// Resend notifications via Email / WhatsApp (admin)
router.post("/:id/send", requireAuth, requireRole("admin", "manager"), billController.resendBillNotifications);

module.exports = router;
