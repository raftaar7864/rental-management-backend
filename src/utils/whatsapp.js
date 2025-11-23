const Twilio = require("twilio");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  TWILIO_TEMPLATE_SID,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
  console.warn("Twilio config missing. WhatsApp notifications will not work.");
}

const client =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

/**
 * Send a WhatsApp Template Message (HSM)
 */
async function sendWhatsAppTemplate(phone, variables = {}) {
  if (!phone || !client) return;

  try {
    const msg = await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${phone}`,
      contentSid: TWILIO_TEMPLATE_SID, 
      contentVariables: JSON.stringify(variables),
    });

    console.log(`[WHATSAPP] Template sent to ${phone}`);
    return msg;
  } catch (err) {
    console.error("sendWhatsAppTemplate error:", err);
    throw err;
  }
}

module.exports = { sendWhatsAppTemplate };
