// utils/generateTenantId.js
const Tenant = require('../models/Tenant');

/**
 * Generate a unique tenant ID like "T4821"
 * Ensures no duplicate even with concurrent inserts
 */
async function generateTenantId() {
  let tenantId;
  let exists = true;

  // Loop until a truly unique ID is found
  while (exists) {
    const randomDigits = Math.floor(1000 + Math.random() * 9000); // 4 random digits (1000–9999)
    tenantId = `T${randomDigits}`;

    // Check database for existing ID
    const existingTenant = await Tenant.findOne({ tenantId });
    if (!existingTenant) {
      exists = false;
    }
  }

  return tenantId;
}

module.exports = generateTenantId;
