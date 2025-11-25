const express = require("express");
const router = express.Router();

// IMPORTANT: Twilio sends URL-encoded data
router.post("/incoming", (req, res) => {
  const msg = req.body.Body?.trim().toLowerCase();
  const from = req.body.From;

  console.log("Tenant message:", msg, "from:", from);

  let reply = null;

  // If tenant sends "hi", "hii", "hello"
if (["Hi","Hii", "hi", "hii", "hello", "hey"].includes(msg)) {
  reply =
    "👋 *Welcome to Doctor Biswas Medicare Rent Services*\n\n" +
    "Thank you for contacting us.\n\n" +
    "You will get your *monthly rental bill* and *payment receipt* here automatically every month.\n\n" +
    "For more inquiry, visit our portal:\n" +
    "https://rentalmanagement.drbiswas.co.in/\n\n";
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
