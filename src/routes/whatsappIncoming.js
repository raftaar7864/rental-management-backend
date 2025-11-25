const express = require("express");
const router = express.Router();

// IMPORTANT: Twilio sends URL-encoded data
router.post("/incoming", (req, res) => {
  const msg = req.body.Body?.trim().toLowerCase();
  const from = req.body.From;

  console.log("Tenant message:", msg, "from:", from);

  let reply = null;

if (["Hi","Hii", "hi", "hii", "hello", "hey"].includes(msg)) {
  reply =
    "👋 *Welcome to DB WELLNESS PVT LTD Rent Services*\n\n" +
    "Thank you for contacting us.\n\n" +
    "You will get your *monthly rental bill* and *payment receipt* here automatically every month.\n\n" +
    "For more inquiry, visit our portal or call this number +91 6291 161 002.\n";
}


  // If no reply, don't send anything
  if (!reply) {
    return res.send("<Response></Response>");
  }

  // Respond with TwiML
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

module.exports = router;



