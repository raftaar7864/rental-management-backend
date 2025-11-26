const express = require("express");
const router = express.Router();

/**
 * Twilio WhatsApp Incoming Webhook
 * Endpoint: POST /api/whatsapp/incoming
 * Content-Type: application/x-www-form-urlencoded
 */
router.post("/incoming", (req, res) => {
  const rawMsg = req.body.Body || "";
  const msg = rawMsg.trim().toLowerCase();
  const from = req.body.From;

  console.log("Tenant message:", rawMsg, "from:", from);

  let reply = null;

  // Greeting keywords
  const greetings = ["hi", "hii", "hello", "hey"];

  if (greetings.includes(msg)) {
  reply =
    "👋 *Welcome to DB WELLNESS PVT LTD Rent Services*\n\n" +
    "Thank you for contacting us.\n\n" +
    "You will get your *monthly rental bill* and *payment receipt* here automatically every month.\n\n" +
    "For more inquiry, visit our portal or call this number +91 6291 161 002.\n";
  }

  // If no reply → return empty TwiML (prevents Twilio error)
  if (!reply) {
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // Escape XML special chars
  const safeReply = reply
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Send TwiML Response
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${safeReply}</Message>
    </Response>
  `);
});

module.exports = router;
