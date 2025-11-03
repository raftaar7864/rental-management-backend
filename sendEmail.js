const sgMail = require("@sendgrid/mail");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const sendEmail = async ({ to, subject, html }) => {
  const msg = {
    to,
    from: process.env.FROM_EMAIL,
    subject,
    html
  };

  try {
    await sgMail.send(msg);
    console.log("✅ Email sent successfully!");
    return true;
  } catch (error) {
    console.error("❌ Email Failed:", error.response?.body || error.message);
    return false;
  }
};

module.exports = sendEmail;
