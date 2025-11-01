const Twilio = require("twilio");

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
  console.warn("Twilio config missing. WhatsApp notifications will not work.");
}

const client = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

async function sendWhatsApp(phone, text) {
  if (!phone || !client) return;
  try {
    const msg = await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${phone}`,
      body: text,
    });
    console.log(`[WHATSAPP] Sent to ${phone}: ${text}`);
    return msg;
  } catch (err) {
    console.error("sendWhatsApp error:", err);
    throw err;
  }
}

module.exports = { sendWhatsApp };
