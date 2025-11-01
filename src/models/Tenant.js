// backend/src/models/Tenant.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  method: { type: String }, // UPI / card / netbanking
  receiptNumber: { type: String },
  note: { type: String }
}, { _id: false });

const tenantSchema = new mongoose.Schema({
  tenantId: { type: String, unique: true }, // e.g. T001
  fullName: { type: String, required: true },
  gender: { type: String },
  idProofType: { type: String }, // Aadhaar, Voter ID...
  idProofNumber: { type: String },
  address: { type: String },
  phone: { 
          type: String,
          required: true,
          validate: {
            validator: function(v) {
              return /^[0-9]{10}$/.test(v);
            },
            message: props => `${props.value} is not a valid 10-digit phone number`
          }
        },
  email: { type: String, required: true },
  advancedAmount: { type: Number, default: 0 },
  rentAmount: { type: Number, default: 0 },
  lastPayment: {
    amount: { type: Number },
    date: { type: Date },
    receiptNumber: { type: String }
  },
  duePayment: {
    pendingAmount: { type: Number, default: 0 },
    dueDate: { type: Date }
  },
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' }, // current assigned room
  moveInDate: { type: Date, default: Date.now },
  moveOutDate: { type: Date },  // optional, can be set later
  numberOfPersons: { type: Number, required: true },
  payments: [paymentSchema],
  createdAt: { type: Date, default: Date.now }
});

// Auto-generate tenantId
tenantSchema.pre('save', async function (next) {
  try {
    if (this.isNew && !this.tenantId) {
      let unique = false;
      let newId;

      while (!unique) {
        // Generate random 4-digit ID (T1000–T9999)
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        newId = `T${randomNum}`;

        // Check for uniqueness
        const existing = await mongoose.models.Tenant.findOne({ tenantId: newId });
        if (!existing) unique = true;
      }

      this.tenantId = newId;
    }

    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Tenant', tenantSchema);
