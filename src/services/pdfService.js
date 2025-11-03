/**************************************************************************
 * Unified PDF Service
 * - Always uploads PDFs to Cloudflare R2 (no local storage)
 * - Stores bill.pdfUrl with signed/public access reference
 * - Returns the bill.pdfUrl every time
 **************************************************************************/
const Bill = require("../models/Bill");
const { generateBillPdf } = require("../utils/pdf");
const savePdfToR2 = require("../utils/r2Upload"); // ✅ NEW helper

async function loadAndPopulateBill(billId) {
  const doc = await Bill.findById(billId)
    .populate("tenant")
    .populate({
      path: "room",
      populate: { path: "building" },
    })
    .lean({ virtuals: true });

  if (!doc) throw new Error(`Bill not found: ${billId}`);
  return doc;
}

/**
 * generateBillPDF
 * @param {string|object} billIdOrObject
 * @param {object} opts
 *    - forceWrite: if false → returns buffer only (no upload)
 *
 * @returns {Promise<string|Buffer>}
 */
async function generateBillPDF(billIdOrObject, opts = {}) {
  const { forceWrite = true } = opts;

  if (!billIdOrObject) throw new Error("billIdOrObject missing!");

  // Load bill details if only ID was provided
  const bill =
    typeof billIdOrObject === "string" || typeof billIdOrObject === "number"
      ? await loadAndPopulateBill(String(billIdOrObject))
      : billIdOrObject;

  // ✅ Generate unified buffer PDF
  const pdfBuffer = await generateBillPdf(bill);

  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error("❌ PDF generator failed — no buffer returned");
  }

  // ForceWrite: upload to R2 + save URL into Bill
  if (forceWrite) {
    const filename = `bill-${bill._id}.pdf`;

    // ✅ Upload to R2 (direct Cloudflare)
    const pdfUrl = await savePdfToR2(filename, pdfBuffer);

    if (!pdfUrl) throw new Error("❌ Failed uploading PDF to R2");

    // ✅ Save into DB if needed
    if (bill?._id) {
      await Bill.findByIdAndUpdate(bill._id, { pdfUrl }, { new: true });
    }

    console.log(`✅ Bill PDF uploaded → ${pdfUrl}`);
    return pdfUrl;
  }

  // No upload — return raw PDF (streaming cases)
  return pdfBuffer;
}

module.exports = {
  generateBillPDF,
};
