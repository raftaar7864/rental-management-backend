// backend/src/routes/contactRoutes.js
const express = require("express");
const sgMail = require("@sendgrid/mail");
const fetch = require("node-fetch"); // Only needed if Node < 18, safe to import anyway

const router = express.Router();

// --- Configure SendGrid ---
if (!process.env.SENDGRID_API_KEY) {
  console.warn("[contactRoutes] SENDGRID_API_KEY not set - emails will fail");
} else {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// --- Helper to escape HTML ---
function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// --- Verify reCAPTCHA token ---
async function verifyRecaptcha(token, remoteIp) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    console.warn("[contactRoutes] RECAPTCHA_SECRET_KEY not set - skipping verification (NOT safe for production)");
    return { success: true };
  }

  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);
    if (remoteIp) params.append("remoteip", remoteIp);

    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      body: params,
    });

    const data = await response.json();
    return data;
  } catch (err) {
    console.error("[contactRoutes] reCAPTCHA verify error:", err);
    return { success: false, error: err?.message || String(err) };
  }
}

// --- POST /api/contact ---
router.post("/", async (req, res) => {
  try {
    const { name, email, message, recaptchaToken } = req.body || {};

    if (!name || !email || !message || !recaptchaToken) {
      return res
        .status(400)
        .json({ message: "All fields (name, email, message, recaptchaToken) are required." });
    }

    // --- Verify reCAPTCHA before sending ---
    const ip = req.ip || req.headers["x-forwarded-for"] || null;
    const verification = await verifyRecaptcha(recaptchaToken, ip);

    if (!verification?.success) {
      console.error("[contactRoutes] reCAPTCHA verification failed:", verification);
      return res.status(403).json({ message: "reCAPTCHA verification failed. Please try again." });
    }

    // Optional: if using reCAPTCHA v3, you can check score threshold
    if (verification.score && verification.score < 0.3) {
      console.warn("[contactRoutes] Low reCAPTCHA score:", verification.score);
      return res.status(403).json({ message: "reCAPTCHA score too low. Submission blocked." });
    }

    // --- Prepare and send email via SendGrid ---
    const toAddr = process.env.CONTACT_RECEIVER;
    if (!toAddr) {
      console.error("[contactRoutes] CONTACT_RECEIVER not configured in env");
      return res.status(500).json({ message: "Server not configured to send emails." });
    }

    const fromAddr = process.env.EMAIL_FROM || toAddr;

    const htmlBody = `
      <h3>New contact message</h3>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <hr/>
      <p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>
      <hr/>
      <p style="font-size:0.8em;color:#666;">reCAPTCHA result: ${escapeHtml(
        JSON.stringify(verification)
      )}</p>
    `;

    const msg = {
      to: toAddr,
      from: fromAddr,
      subject: `Contact form: ${name}`,
      html: htmlBody,
      replyTo: email,
    };

    const response = await sgMail.send(msg);
    console.log(
      "[contactRoutes] SendGrid response:",
      response && response[0] && response[0].statusCode ? response[0].statusCode : response
    );

    return res.json({ message: "Email sent successfully." });
  } catch (err) {
    console.error("[contactRoutes] error sending mail:", err);
    if (err?.response?.body) console.error("[contactRoutes] sendgrid body:", err.response.body);
    const message = err?.message || "Failed to send message.";
    return res.status(500).json({ message: "Failed to send message.", error: message });
  }
});

module.exports = router;
