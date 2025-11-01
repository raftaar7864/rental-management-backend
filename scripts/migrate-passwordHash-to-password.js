// backend/src/scripts/migrate-passwordHash-to-password.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function migrate() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI not set in .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to MongoDB');

  const users = await User.find({ passwordHash: { $exists: true } });
  console.log(`Found ${users.length} users with passwordHash`);
  for (const u of users) {
    // Skip if password already exists
    if (u.password) {
      console.log(`Skipping ${u.email} (already has password)`);
      continue;
    }
    u.password = u.passwordHash;
    u.passwordHash = undefined;
    await u.save();
    console.log(`Migrated ${u.email}`);
  }

  await mongoose.disconnect();
  console.log('Migration complete');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration error', err);
  process.exit(1);
});
