// backend/src/services/pdfService.js
/**
 * Centralized PDF service for bills.
 *
 * Public API:
 *   - generateBillPDF(billIdOrObject, opts = {}) -> Promise<string|Buffer>
 *       - if opts.forceWrite === true (default) -> returns absolute file path (string)
 *       - if opts.forceWrite === false -> returns Buffer (useful for streaming)
 *
 * opts:
 *   - mode: (kept for API compatibility but ignored) "auto"|"beforePaid"|"afterPaid"
 *   - forceWrite: boolean (default true)
 *
 * Behavior:
 *   - If billIdOrObject is a string -> loads Bill, populates tenant/room/building.
 *   - Uses ../utils/pdf.js generator to create the PDF Buffer (single unified generator).
 *   - Writes the buffer to backend/bills/bill_<id>.pdf when forceWrite === true.
 */

const path = require("path");
const fs = require("fs");
const fsPromises = fs.promises;
const Bill = require("../models/Bill");

// unified generator
const { generateBillPdf } = require("../utils/pdf");

const BILLS_DIR = path.join(__dirname, "../../bills");

async function ensureBillsDir() {
  try {
    if (!fs.existsSync(BILLS_DIR)) {
      await fsPromises.mkdir(BILLS_DIR, { recursive: true });
    }
  } catch (err) {
    throw new Error(`Failed to ensure bills directory (${BILLS_DIR}): ${err.message}`);
  }
}

async function loadAndPopulateBill(billId) {
  if (!billId) throw new Error("billId is required");
  const doc = await Bill.findById(billId)
    .populate("tenant")
    .populate({
      path: "room",
      populate: { path: "building" },
    })
    .populate("building")
    .lean({ virtuals: true });

  if (!doc) throw new Error(`Bill not found: ${billId}`);
  return doc;
}

/**
 * Generate PDF for a bill (by id or already-populated object).
 *
 * @param {string|object} billIdOrObject - Mongo bill _id or populated bill object
 * @param {object} opts
 *    - mode: (ignored) "auto"|"beforePaid"|"afterPaid"    // kept for compatibility
 *    - forceWrite: boolean (default true). If false, returns Buffer.
 *
 * @returns {Promise<string|Buffer>} filePath (when forceWrite=true) or Buffer (when forceWrite=false)
 */
async function generateBillPDF(billIdOrObject, opts = {}) {
  const { forceWrite = true } = opts;

  if (!billIdOrObject) throw new Error("billIdOrObject is required");

  let billObj;
  if (typeof billIdOrObject === "string" || typeof billIdOrObject === "number") {
    billObj = await loadAndPopulateBill(String(billIdOrObject));
  } else if (typeof billIdOrObject === "object") {
    billObj = billIdOrObject;
  } else {
    throw new Error("Invalid billIdOrObject argument");
  }

  // Use unified generator
  let pdfBuffer;
  try {
    pdfBuffer = await generateBillPdf(billObj);
  } catch (err) {
    throw new Error(`PDF generation failed for bill ${billObj._id || billObj.id || "unknown"}: ${err.message}`);
  }

  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error("PDF generator did not return a Buffer");
  }

  if (!forceWrite) {
    return pdfBuffer;
  }

  try {
    await ensureBillsDir();
    const filename = `bill_${billObj._id || billObj.id}.pdf`;
    const filePath = path.join(BILLS_DIR, filename);
    await fsPromises.writeFile(filePath, pdfBuffer);
    return filePath;
  } catch (err) {
    throw new Error(`Failed to write PDF for bill ${billObj._id || billObj.id}: ${err.message}`);
  }
}

module.exports = {
  generateBillPDF,
  ensureBillsDir,
};
