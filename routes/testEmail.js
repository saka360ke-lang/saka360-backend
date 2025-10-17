const express = require("express");
const router = express.Router();
const { sendEmail } = require("../utils/mailer");

// test route
router.post("/test-email", async (req, res) => {
  try {
    const { to, template, data } = req.body;
    await sendEmail(to, `Saka360 Test – ${template}`, template, data);
    res.json({ message: `Test ${template} email sent ✅` });
  } catch (err) {
    res.status(500).json({ error: "Failed to send test email", detail: err.message });
  }
});

module.exports = router;
