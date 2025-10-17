// routes/testEmail.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

// Existing SMTP-based mailer (uses nodemailer)
const { sendEmail } = require("../utils/mailer");

// Optional HTTP-based mailer (Mailtrap API; see utils/mailer_http.js below)
let sendEmailHTTP = null;
try {
  // Only required if you create utils/mailer_http.js
  ({ sendEmailHTTP } = require("../utils/mailer_http"));
} catch (_) {
  // leave null if not present
}

/**
 * GET /api/templates
 * Lists all available .hbs templates in /templates folder.
 */
router.get("/templates", async (_req, res) => {
  try {
    const templatesDir = path.join(__dirname, "..", "templates");
    const files = fs.readdirSync(templatesDir);
    const templates = files
      .filter((f) => f.toLowerCase().endsWith(".hbs"))
      .map((f) => f.replace(/\.hbs$/i, "")); // strip extension

    res.json({ count: templates.length, templates });
  } catch (err) {
    res.status(500).json({
      error: "Failed to read templates directory",
      detail: err.message,
    });
  }
});

/**
 * POST /api/test-email
 * Sends a templated email using your SMTP transport (utils/mailer.js).
 * Body: { "to": "you@example.com", "template": "verification", "data": { ... } }
 */
router.post("/test-email", async (req, res) => {
  try {
    const { to, template, data } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' email" });
    if (!template) return res.status(400).json({ error: "Missing 'template' name" });

    await sendEmail(to, `Saka360 Test – ${template}`, template, data || {});
    res.json({ message: `Test ${template} email sent ✅ (SMTP)`, to, template });
  } catch (err) {
    res.status(500).json({
      error: "Failed to send test email (SMTP)",
      detail: err.message,
      hint: "If you see ETIMEDOUT/CONN, try /api/test-email-http after adding utils/mailer_http.js",
    });
  }
});

/**
 * POST /api/test-email-http
 * Sends a templated email using Mailtrap's HTTPS API (no SMTP).
 * Body: { "to": "you@example.com", "template": "verification", "data": { ... } }
 */
router.post("/test-email-http", async (req, res) => {
  try {
    if (!sendEmailHTTP) {
      return res.status(501).json({
        error: "HTTP mailer not installed",
        detail: "Create utils/mailer_http.js and set MAILTRAP_API_TOKEN env",
      });
    }

    const { to, template, data } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' email" });
    if (!template) return res.status(400).json({ error: "Missing 'template' name" });

    await sendEmailHTTP(to, `Saka360 Test – ${template}`, template, data || {});
    res.json({ message: `Test ${template} email sent ✅ (HTTP API)`, to, template });
  } catch (err) {
    res.status(500).json({
      error: "Failed to send test email (HTTP API)",
      detail: err.message,
    });
  }
});

module.exports = router;
