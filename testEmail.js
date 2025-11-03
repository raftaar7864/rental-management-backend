require("dotenv").config();
const sendEmail = require("./sendEmail");

sendEmail({
  to: "raftaarsubrata@gmail.com",
  subject: "Hello from SendGrid",
  html: "<h2>It works! 🎉</h2>"
});

