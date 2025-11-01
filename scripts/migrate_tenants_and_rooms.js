/**
 * migrate_tenants_and_rooms.js
 *
 * Safe migration script for:
 * 1) Backfilling tenant.tenantId (T001...) for existing tenants
 * 2) Ensuring Room.tenants arrays contain current tenant ObjectIds
 * 3) Building Room.tenantHistory entries from Tenant.moveInDate/moveOutDate
 * 4) Correcting Room.isOccupied
 *
 * Usage:
 *   - Ensure your backend/.env has correct MONGO_URI (or set MONGO_URI env var)
 *   - Run a dry-run first:
 *       node migrate_tenants_and_rooms.js --dry
 *   - If dry-run output looks good, run for real:
 *       node migrate_tenants_and_rooms.js
 *
 * IMPORTANT:
 *  - Always backup DB before running on production.
 *  - Script is idempotent: re-running won't create duplicate tenantIds or duplicate history entries.
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: '../.env' }); // adjust path if running from different cwd
const Tenant = require('../src/models/Tenant');
const Room = require('../src/models/Room');

// Connect
const MONGO_URI = process.env.MONGO_URI || process.env.DB_URI || 'mongodb://127.0.0.1:27017/test';
if (!MONGO_URI) {
  console.error('MONGO_URI not set. Set it in .env or as env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to MongoDB');

  const dryRun = process.argv.includes('--dry');
  console.log('Dry run:', dryRun);

  // Ensure TenantCounter exists (we will use or create a counter doc named 'tenantId')
  const TenantCounter = mongoose.model(
    'TenantCounter',
    new mongoose.Schema({ name: { type: String, unique: true }, value: { type: Number, default: 0 } }),
    'tenantcounters' // collection name
  );

  // Use the Tenant model's collection name if different
  // We will fetch tenants that don't have tenantId or have null/empty
  const tenantsMissing = await Tenant.find({ $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }] }).sort({ createdAt: 1 });
  console.log(`Found ${tenantsMissing.length} tenants missing tenantId`);

  // Get or create counter doc
  let counter = await TenantCounter.findOne({ name: 'tenantId' });
  if (!counter) {
    // determine current max numeric tenantId existing to avoid collisions
    const allTenants = await Tenant.find({ tenantId: { $exists: true, $ne: null, $ne: '' } }).select('tenantId');
    let maxVal = 0;
    allTenants.forEach(t => {
      const match = String(t.tenantId).match(/^T0*([0-9]+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!Number.isNaN(num) && num > maxVal) maxVal = num;
      }
    });
    counter = new TenantCounter({ name: 'tenantId', value: maxVal });
    if (!dryRun) await counter.save();
    console.log('Initialized TenantCounter with value', counter.value);
  } else {
    console.log('TenantCounter current value:', counter.value);
  }

  // Assign tenantIds sequentially
  for (const tenant of tenantsMissing) {
    // compute next value
    counter.value += 1;
    const seq = String(counter.value).padStart(3, '0');
    const newId = `T${seq}`;

    console.log(`Assigning ${tenant._id} => ${newId} (current tenantId: ${tenant.tenantId})`);
    if (!dryRun) {
      tenant.tenantId = newId;
      await tenant.save();
      await counter.save();
    }
  }

  // After tenantId pass, ensure Room.tenants arrays and tenantHistory
  const allRooms = await Room.find({});
  console.log(`Processing ${allRooms.length} rooms to sync tenants and tenantHistory`);

  for (const room of allRooms) {
    // Build desired tenants array: all tenants that reference this room and have no moveOutDate
    const tenantsForRoom = await Tenant.find({ room: room._id }).select('_id tenantId fullName moveInDate moveOutDate').sort({ moveInDate: 1 });

    const desiredTenantIds = tenantsForRoom.map(t => t._id.toString());
    const currentTenantIds = (room.tenants || []).map(id => id.toString());

    // compute additions and removals
    const toAdd = desiredTenantIds.filter(id => !currentTenantIds.includes(id));
    const toRemove = currentTenantIds.filter(id => !desiredTenantIds.includes(id));

    if (toAdd.length || toRemove.length) {
      console.log(`Room ${room._id} (${room.number || room.roomNumber}): toAdd=${toAdd.length}, toRemove=${toRemove.length}`);
      if (!dryRun) {
        // update room.tenants to be the desired (preserve order)
        room.tenants = tenantsForRoom.map(t => t._id);
      }
    } else {
      console.log(`Room ${room._id} (${room.number || room.roomNumber}): tenants already in sync`);
    }

    // Build tenantHistory entries from tenantsForRoom if missing
    // For each tenant, ensure a history entry exists (match by tenant._id)
    room.tenantHistory = room.tenantHistory || [];
    const historyMap = new Map(room.tenantHistory.map(h => [String(h.tenant), h])); // tenantId -> entry

    let historyChanged = false;
    for (const t of tenantsForRoom) {
      const tid = String(t._id);
      const existing = historyMap.get(tid);
      // If existing entry missing, add snapshot
      if (!existing) {
        const newHist = {
          tenant: t._id,
          tenantId: t.tenantId || null,
          fullName: t.fullName || null,
          bookingDate: t.moveInDate || null,
          leavingDate: t.moveOutDate || null
        };
        console.log(`Room ${room._id}: adding tenantHistory for tenant ${t.tenantId || t._id}`);
        room.tenantHistory.push(newHist);
        historyChanged = true;
      } else {
        // sync booking/leaving dates if missing
        let updated = false;
        if (!existing.bookingDate && t.moveInDate) { existing.bookingDate = t.moveInDate; updated = true; }
        if (!existing.leavingDate && t.moveOutDate) { existing.leavingDate = t.moveOutDate; updated = true; }
        if (updated) {
          console.log(`Room ${room._id}: updated tenantHistory dates for ${t.tenantId || t._id}`);
          historyChanged = true;
        }
      }
    }

    // Optionally remove history entries for tenants that no longer exist — leaving them preserves history; we won't delete
    // Update isOccupied based on tenants that have no moveOutDate
    const currentlyPresent = tenantsForRoom.filter(t => !t.moveOutDate);
    const shouldBeOccupied = currentlyPresent.length > 0;
    if (room.isOccupied !== shouldBeOccupied) {
      console.log(`Room ${room._id}: isOccupied will change ${room.isOccupied} => ${shouldBeOccupied}`);
      if (!dryRun) room.isOccupied = shouldBeOccupied;
    }

    if ((!dryRun) && (toAdd.length || toRemove.length || historyChanged || room.isOccupied !== shouldBeOccupied)) {
      await room.save();
      console.log(`Room ${room._id} saved`);
    }
  }

  if (!dryRun) {
    // Ensure counter persisted
    await TenantCounter.findOneAndUpdate({ name: 'tenantId' }, { value: counter.value }, { upsert: true });
    console.log('TenantCounter updated to', counter.value);
  } else {
    console.log('Dry-run complete. No changes were made.');
  }

  console.log('Migration finished.');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
