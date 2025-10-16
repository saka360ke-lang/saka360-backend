// index.js
require("dotenv").config();

const express = require("express");
const app = express();
app.use(express.json());

app.use("/api/payments", paymentRoutes);
app.use("/api/affiliates", affiliateRoutes);


/**
 * ----------------------------------------------------
 * 1) Minimal health routes (kept FIRST and super safe)
 * ----------------------------------------------------
 * These should never crash even if other services (DB, S3, Twilio) are misconfigured.
 */
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "OK" });
});

/**
 * Optional DB health (won’t affect Render health checks)
 * If DATABASE_URL is missing/invalid, this route may fail, but /api/health remains OK.
 */
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.get("/api/health/db", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ db: "connected", time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ db: "error", error: e.message });
  }
});

/**
 * ----------------------------------------------------
 * 2) Dependencies & helpers (loaded after health)
 * ----------------------------------------------------
 */
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const paymentRoutes = require("./routes/payments");
const affiliateRoutes = require("./routes/affiliates");
const PDFDocument = require("pdfkit");
const fs = require("fs"); // useful for local PDF saving

// Mailer (Hostinger SMTP) — you already created utils/mailer.js
const { sendEmail, verifySmtp } = require("./utils/mailer");

// Twilio (WhatsApp) — lazy-init pattern to avoid startup crashes when env vars missing
const twilio = require("twilio");

function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured: missing TWILIO_ACCOUNT_SID/AUTH_TOKEN");
  }
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. +14155238886 (no "whatsapp:" here)

function toWhatsAppAddr(numE164) {
  // numE164 must be like +2547XXXXXXX; Twilio wants "whatsapp:+2547..."
  return numE164.startsWith("whatsapp:") ? numE164 : `whatsapp:${numE164}`;
}

async function sendWhatsAppText(toE164, body) {
  if (!toE164) throw new Error("Missing recipient 'toE164'");
  if (!TWILIO_FROM) throw new Error("Missing TWILIO_WHATSAPP_FROM");
  const client = getTwilioClient();
  return client.messages.create({
    from: toWhatsAppAddr(TWILIO_FROM),
    to: toWhatsAppAddr(toE164),
    body,
  });
}

function fmtDate(d) {
  const dt = new Date(d);
  return dt.toLocaleDateString("en-KE", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * ----------------------------------------------------
 * 3) TEST ROUTES (email + WhatsApp)
 * ----------------------------------------------------
 * Keep these simple to validate infra quickly.
 */

// Verify SMTP connectivity
app.get("/api/email-verify", async (_req, res) => {
  try {
    const ok = await verifySmtp();
    res.json({ ok, message: "SMTP connection OK ✅" });
  } catch (err) {
    console.error("SMTP verify error:", err);
    res.status(500).json({
      ok: false,
      error: "SMTP verification failed",
      detail: err.message,
    });
  }
});

// Test plain email (no template)
app.get("/api/test-email", async (_req, res) => {
  try {
    const to = "huguadventures@gmail.com"; // your test inbox
    await sendEmail(
      to,
      "Saka360 Plain Test Email",
      null, // templateName = null → send plain text
      "Hello! 👋 This is a public test email from Saka360 backend."
    );
    res.json({ message: "Plain test email sent ✅", to });
  } catch (err) {
    console.error("Test email error:", err);
    res.status(500).json({
      error: "Failed to send test email",
      detail: err.message,
    });
  }
});

// Test WhatsApp message (uses Twilio Sandbox)
app.post("/api/test-whatsapp", async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to) {
      return res.status(400).json({ error: "Missing 'to' in body. Use E.164 like +2547XXXXXXXX" });
    }
    const msg = await sendWhatsAppText(to, body || "Hello 👋 This is a Saka360 WhatsApp test message ✅");
    res.json({ message: "WhatsApp sent ✅", sid: msg.sid, status: msg.status });
  } catch (err) {
    console.error("Test WhatsApp error:", err);
    res.status(500).json({
      error: "Failed to send WhatsApp",
      detail: err.message,
    });
  }
});

/**
 * ----------------------------------------------------
 * 4) YOUR REAL APP ROUTES (mount after tests)
 * ----------------------------------------------------
 * Keep router files defining paths WITHOUT the /api prefix inside them.
 * Example: usersRouter.post("/users/login", ...)
 * Then mount as app.use("/api", usersRouter)
 */

// Example placeholder: you would require and mount your routers like below
// const usersRouter = require("./routes/users");
// const fuelRouter = require("./routes/fuel");
// const serviceRouter = require("./routes/service");
// const documentsRouter = require("./routes/documents");
// const remindersRouter = require("./routes/reminders");
// const reportsRouter = require("./routes/reports");

// app.use("/api", usersRouter);
// app.use("/api", fuelRouter);
// app.use("/api", serviceRouter);
// app.use("/api", documentsRouter);
// app.use("/api", remindersRouter);
// app.use("/api", reportsRouter);

/**
 * ----------------------------------------------------
 * 5) CRON — safe default (won’t crash if function missing)
 * ----------------------------------------------------
 * If you already implemented runExpiryCheck elsewhere, keep it imported.
 * For now, we provide a safe stub so the app won’t crash.
 */
async function runExpiryCheck() {
  console.log("⏰ runExpiryCheck() stub called (implement real logic later).");
}
// Every day at 08:00 Africa/Nairobi
cron.schedule(
  "0 8 * * *",
  () => {
    runExpiryCheck().catch((e) => console.error("runExpiryCheck error:", e));
  },
  { timezone: "Africa/Nairobi" }
);

/**
 * ----------------------------------------------------
 * 6) Start the server (Render binds PORT)
 * ----------------------------------------------------
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
