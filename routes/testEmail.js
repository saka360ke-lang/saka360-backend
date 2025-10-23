// routes/testEmail.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const { sendEmail } = require("../utils/mailer");
const { authenticateToken, adminOnly } = require("../middleware/auth");

// Protect everything in this router with admin
router.use(authenticateToken, adminOnly);

// Helper to list available .hbs templates
router.get("/templates", async (_req, res) => {
  try {
    const dir = path.join(__dirname, "..", "templates");
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".hbs"));
    res.json({ templates: files });
  } catch (e) {
    res.status(500).json({ error: "Failed to list templates", detail: e.message });
  }
});

// Send a specific template
// Body: { to, template, data }
router.post("/test-template", async (req, res) => {
  try {
    const { to, template, data } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' email" });
    if (!template) return res.status(400).json({ error: "Missing 'template' name" });

    await sendEmail(to, `Saka360 Test – ${template}`, template, data || {});
    res.json({ message: `Test ${template} email sent ✅`, to, template });
  } catch (err) {
    res.status(500).json({ error: "Failed to send test email", detail: err.message });
  }
});

// (Optional) still allow plain-text test if you need it
router.post("/test-email", async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' email" });

    await sendEmail(to, "Saka360 Plain Test Email", null, body || "Hello! 👋 Saka360 backend plain test.");
    res.json({ message: "Plain test email sent ✅", to });
  } catch (err) {
    res.status(500).json({ error: "Failed to send test email", detail: err.message });
  }
});

module.exports = router;
