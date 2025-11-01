// backend/src/models/Bill.js
const mongoose = require("mongoose");

const chargeSchema = new mongoose.Schema({
  title: { type: String, required: true }, // e.g., Rent, Electricity, Discount
  amount: { type: Number, required: true }, // can be negative for discount
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ["Pending", "Paid", "Failed"],
    default: "Pending",
  },
  method: { type: String }, // e.g., Razorpay, Cash, Bank Transfer
  reference: { type: String }, // payment gateway reference ID
  paidAt: { type: Date },
}, { _id: false });

const totalsSchema = new mongoose.Schema({
  rent: { type: Number, default: 0 },
  electricity: { type: Number, default: 0 },
  processingFee: { type: Number, default: 0 },
  additionalAmount: { type: Number, default: 0 },
  discount: { type: Number, default: 0 }, // positive number representing discount value
}, { _id: false });

const billSchema = new mongoose.Schema(
  {
    tenant: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    room: { type: mongoose.Schema.Types.ObjectId, ref: "Room", required: true },
    building: { type: mongoose.Schema.Types.ObjectId, ref: "Building", required: true },

    // Keep billingMonth as string (format: "YYYY-MM" or "YYYY-MM-DD" depending on your app),
    // but store it consistently. Many front-end calls pass "YYYY-MM-01".
    billingMonth: { type: String, required: true },

    // line-item charges (keeps existing format)
    charges: { type: [chargeSchema], default: [] },

    // totals for aggregate/quick queries and reporting (new)
    totals: { type: totalsSchema, default: () => ({}) },

    // canonical total amount (sum after applying charges & discounts)
    totalAmount: { type: Number, required: true },

    // payment tracking
    paymentStatus: {
      type: String,
      enum: ["Not Paid", "Paid"],
      default: "Not Paid",
    },
    payment: { type: paymentSchema, default: () => ({}) },

    // generated PDF link (if you store on disk/S3) and online payment link
    pdfUrl: { type: String },        // optional: store generated PDF link
    paymentLink: { type: String },   // optional: store Razorpay/online payment link

    notes: { type: String },

    // Optional Razorpay fields for webhook verification / bookkeeping
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
  },
  { timestamps: true }
);

// Index to prevent duplicate bill for the same room+tenant+month
billSchema.index({ room: 1, tenant: 1, billingMonth: 1 }, { unique: true });

// Convenience: a compound index to quickly query unpaid bills by building/month
billSchema.index({ building: 1, billingMonth: 1, paymentStatus: 1 });

/**
 * Pre-validate hook:
 * - If `totals` is empty, try to compute from `charges` (common titles)
 * - If totalAmount is missing or 0, compute from charges
 * This keeps older data compatible and ensures totals are available for quick querying.
 */
billSchema.pre("validate", function (next) {
  try {
    // compute sum of charges
    const charges = Array.isArray(this.charges) ? this.charges : [];
    const sumCharges = charges.reduce((acc, c) => acc + Number(c.amount || 0), 0);

    // Derive totals from known charge titles if totals not provided explicitly
    if (!this.totals || Object.keys(this.totals).length === 0) {
      const t = {
        rent: 0,
        electricity: 0,
        processingFee: 0,
        additionalAmount: 0,
        discount: 0,
      };

      charges.forEach((c) => {
        const title = (c.title || "").toString().toLowerCase();
        const amt = Number(c.amount || 0);
        if (title.includes("rent")) t.rent += amt;
        else if (title.includes("electric")) t.electricity += amt;
        else if (title.includes("processing")) t.processingFee += amt;
        else if (title.includes("additional") || title.includes("maintenance")) t.additionalAmount += amt;
        else if (title.includes("discount")) t.discount += Math.abs(amt); // discounts stored negative in charges often
        else {
          // fallback: treat as additional
          t.additionalAmount += amt;
        }
      });

      // Ensure discount is positive number in totals
      if (t.discount < 0) t.discount = Math.abs(t.discount);

      this.totals = t;
    }

    // If totalAmount is not set or is NaN, derive from charges sum
    if (typeof this.totalAmount === "undefined" || this.totalAmount === null || Number.isNaN(Number(this.totalAmount))) {
      this.totalAmount = Math.round(sumCharges);
    } else {
      // ensure canonical totalAmount equals charges sum if they differ significantly (tolerance)
      const diff = Math.abs(Number(this.totalAmount) - sumCharges);
      if (diff >= 1) {
        // keep existing totalAmount but log (won't throw). If you prefer to overwrite, set it here.
        // this.totalAmount = Math.round(sumCharges);
      }
    }

    // Normalize paymentStatus based on payment object (if paidAt present)
    if (this.payment && this.payment.paidAt) {
      this.paymentStatus = (this.payment.status && this.payment.status === "Paid") || this.payment.status === "paid" ? "Paid" : this.paymentStatus;
    }

    next();
  } catch (err) {
    next(err);
  }
});

/**
 * toJSON transform - make API responses nicer.
 * Adds `isPaid` boolean and removes __v.
 */
billSchema.set("toJSON", {
  virtuals: true,
  transform(doc, ret) {
    delete ret.__v;
    ret.isPaid = ret.paymentStatus === "Paid" || (ret.payment && (ret.payment.status === "Paid" || ret.payment.status === "paid"));
    return ret;
  },
});

module.exports = mongoose.model("Bill", billSchema);
