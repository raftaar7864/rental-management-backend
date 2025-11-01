// backend/src/models/Room.js
const mongoose = require('mongoose');

// Counter schema for auto-increment roomId (R001...)
const counterSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

const tenantHistorySchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  tenantId: { type: String },      // snapshot of tenantId (eg T001)
  fullName: { type: String },      // snapshot of name
  bookingDate: { type: Date },
  leavingDate: { type: Date, default: null }
}, { _id: false });

const roomSchema = new mongoose.Schema({
  roomId: { type: String, unique: true },
  number: { type: String, required: true },
  roomNumber: { type: String }, // compatibility
  building: { type: mongoose.Schema.Types.ObjectId, ref: 'Building', required: true },
  tenants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }],
  tenantHistory: [tenantHistorySchema],
  isBooked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  rentAmount: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Rent' }],
  additionalCharges: [{ title: String, amount: Number, note: String }]

});

// Keep existing unique index on building + roomNumber
roomSchema.index({ building: 1, roomNumber: 1 }, { unique: true });

// Pre-save: generate roomId and sync roomNumber
roomSchema.pre('save', async function (next) {
  try {
    if (this.isNew) {
      const counter = await Counter.findOneAndUpdate(
        { name: 'roomId' },
        { $inc: { value: 1 } },
        { new: true, upsert: true }
      );
      const seqNum = String(counter.value).padStart(3, '0');
      this.roomId = `R${seqNum}`;
    }
    if (!this.roomNumber && this.number) this.roomNumber = this.number;
    else if (this.number && this.roomNumber !== this.number) this.roomNumber = this.number;
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Room', roomSchema);
