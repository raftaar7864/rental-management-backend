// backend/scripts/migrate_set_building_manager.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Building = require('../src/models/Building');

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGO_URI missing in .env');
  process.exit(1);
}

mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  try {
    const managers = await User.find({ role: 'manager', building: { $exists: true, $ne: null } });
    for (const m of managers) {
      const bId = m.building;
      if (!bId) continue;
      const b = await Building.findById(bId);
      if (!b) {
        console.warn('Building not found for manager', m._id, bId);
        continue;
      }
      if (!b.manager || b.manager.toString() !== m._id.toString()) {
        b.manager = m._id;
        await b.save();
        console.log(`Set building ${b._id} manager => ${m._id}`);
      }
    }
    console.log('Migration done');
  } catch (err) {
    console.error('Migration error', err);
  } finally {
    mongoose.disconnect();
  }
}).catch(err => {
  console.error('Mongo connect failed', err);
});
