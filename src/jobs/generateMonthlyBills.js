// backend/src/jobs/generateMonthlyBills.js
const cron = require('node-cron');
const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const Bill = require('../models/Bill');

const { sendEmail } = require('../utils/email');
const { sendWhatsApp } = require('../utils/whatsapp');

// helper: tenant active check
function isActiveTenant(tenant) {
  if (!tenant) return false;
  if (!tenant.moveOutDate) return true;
  return new Date(tenant.moveOutDate) > new Date();
}

// Normalize a JS Date to month-start
function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

// Build bills for the provided targetMonthDate (Date within the target month)
async function buildBillsForMonth(targetMonthDate) {
  const billingMonthStart = monthStart(targetMonthDate);
  const year = billingMonthStart.getFullYear();
  const month = billingMonthStart.getMonth();

  // default due date: 7th of the month at 23:59:59 (customize as needed)
  const dueDate = new Date(year, month, 7, 23, 59, 59);

  const created = [];

  // fetch all rooms with tenant refs
  const rooms = await Room.find().populate('tenants');

  for (const room of rooms) {
    // gather tenant docs (populated) and filter active ones
    let tenantDocs = (room.tenants || []).filter(isActiveTenant);

    // if tenants were ObjectIds (not populated), fetch them
    if (tenantDocs.length === 0 && (room.tenants || []).length) {
      // fetch tenant docs explicitly
      const ids = room.tenants.map(t => t._id ? t._id : t);
      tenantDocs = await Tenant.find({ _id: { $in: ids } });
      tenantDocs = tenantDocs.filter(isActiveTenant);
    }

    if (!tenantDocs.length) continue; // nothing to bill

    // Room-level amounts
    const roomRent = Number(room.monthlyRent || 0);
    const roomAddCharges = (room.additionalCharges || []).map(c => ({
      title: c.title || 'Additional Charge',
      amount: Number(c.amount || 0),
      note: c.note || ''
    }));

    const totalExtras = roomAddCharges.reduce((s, c) => s + c.amount, 0);

    // split equally among active tenants
    const perTenantRent = roomRent / tenantDocs.length;
    const perTenantExtras = totalExtras / tenantDocs.length;

    for (const tenant of tenantDocs) {
      // ensure no duplicate for this tenant+month
      const exists = await Bill.findOne({ tenant: tenant._id, billingMonth: billingMonthStart });
      if (exists) {
        created.push({ tenant: tenant._id, skipped: true });
        continue;
      }

      const charges = [
        { title: 'Room Rent', amount: Number(perTenantRent || 0) },
        ...roomAddCharges.map(c => ({ title: c.title, amount: Number(c.amount / tenantDocs.length || 0), note: c.note }))
      ];

      const total = charges.reduce((s, c) => s + Number(c.amount || 0), 0);

      const bill = await Bill.create({
        tenant: tenant._id,
        room: room._id,
        billingMonth: billingMonthStart,
        charges,
        totalAmount: total,
        dueDate
      });

      created.push({ bill: bill._id, tenant: tenant._id, skipped: false });

      // Async notifications (do not block)
      (async () => {
        try {
          const monthName = billingMonthStart.toLocaleString('default', { month: 'long', year: 'numeric' });
          const subject = `Rent bill for ${monthName}`;
          const text = `Hello ${tenant.fullName || ''}, your bill for ${monthName} is ₹${total.toFixed(2)} due by ${dueDate.toISOString().split('T')[0]}.`;
          if (tenant.email) await sendEmail(tenant.email, subject, text);
          if (tenant.phone) await sendWhatsApp(tenant.phone, text);
        } catch (notifyErr) {
          console.error('Bill notification error:', notifyErr);
        }
      })();
    }
  }

  return created;
}

// Scheduler: 1st of month at 00:05 server time
function scheduleMonthlyBilling() {
  cron.schedule('5 0 1 * *', async () => {
    console.log('Monthly billing job starting:', new Date().toISOString());
    try {
      const now = new Date();
      const result = await buildBillsForMonth(now);
      console.log('Monthly billing job finished. items:', result.length);
    } catch (err) {
      console.error('Monthly billing job error:', err);
    }
  }, {
    scheduled: true
    // , timezone: 'Asia/Kolkata' // uncomment to enforce timezone
  });

  console.log('Monthly billing scheduler registered.');
}

// manual runner for tests: runOnceForMonth(2025, 10) => October 2025
async function runOnceForMonth(year, month) {
  const target = new Date(year, month - 1, 1);
  return buildBillsForMonth(target);
}

module.exports = { scheduleMonthlyBilling, runOnceForMonth, buildBillsForMonth };
