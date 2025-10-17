const express = require("express");
const router = express.Router();
const { sendEmail } = require("../utils/mailer");

// POST /api/test-email
router.post("/test-email", async (req, res) => {
  try {
    const { to, template, data } = req.body || {};

    if (!to) return res.status(400).json({ error: "Missing 'to' email" });
    if (!template) return res.status(400).json({ error: "Missing 'template' name (e.g. 'verification')" });

    await sendEmail(to, `Saka360 Test – ${template}`, template, data || {});
    res.json({ message: `Test ${template} email sent ✅`, to, template });
  } catch (err) {
    console.error("Test email error:", err);
    res.status(500).json({ error: "Failed to send test email", detail: err.message });
  }
});

module.exports = router;
