const mongoose = require('mongoose');

const buildingSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: { type: String, required: true },
  manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // optional manager
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Building', buildingSchema);
