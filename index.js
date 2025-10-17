// index.js
require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");

const cron = require("node-cron");

// ---------- Create app FIRST ----------
const app = express();
app.use(express.json());

// ---------- Database (shared pool) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
app.set("pool", pool); // optional: lets routes read with req.app.get("pool")
require('./routes/fuel')(app);
require('./routes/service')(app);
require('./routes/documents')(app);
require('./routes/reminders')(app);


/**
 * ----------------------------------------------------
 * 1) Minimal health routes (kept FIRST and super safe)
 * ----------------------------------------------------
 * These should never crash even if DB/Twilio/SMTP are misconfigured.
 */
app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "OK" });
});

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
const PDFDocument = require("pdfkit");
const fs = require("fs"); // optional for local PDF saving

// Mailer utils (you created utils/mailer.js)
const { sendEmail, verifySmtp } = require("./utils/mailer");

// Twilio (WhatsApp) — lazy-init to avoid startup crash if env is missing
const twilio = require("twilio");
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. +14155238886 (NO "whatsapp:" prefix)

function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured: missing TWILIO_ACCOUNT_SID/AUTH_TOKEN");
  }
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function toWhatsAppAddr(numE164) {
  // expects +2547XXXXXXX
  return numE164.startsWith("whatsapp:") ? numE164 : `whatsapp:${numE164}`;
}

async function sendWhatsAppText(toE164, body) {
  if (!toE164) throw new Error("Missing 'to' in E.164 format (e.g., +2547XXXXXXX)");
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
 * Simple endpoints to validate infra quickly.
 */
// Verify SMTP connectivity
app.get("/api/email-verify", async (_req, res) => {
  try {
    const ok = await verifySmtp();
    res.json({ ok, message: "SMTP connection OK ✅" });
  } catch (err) {
    console.error("SMTP verify error:", err);
    res.status(500).json({ ok: false, error: "SMTP verification failed", detail: err.message });
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
    res.status(500).json({ error: "Failed to send test email", detail: err.message });
  }
});

// Test WhatsApp message (Twilio Sandbox or approved number)
app.post("/api/test-whatsapp", async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' (E.164 like +2547XXXXXXXX)" });
    const msg = await sendWhatsAppText(to, body || "Hello 👋 This is a Saka360 WhatsApp test message ✅");
    res.json({ message: "WhatsApp sent ✅", sid: msg.sid, status: msg.status });
  } catch (err) {
    console.error("Test WhatsApp error:", err);
    res.status(500).json({ error: "Failed to send WhatsApp", detail: err.message });
  }
});

/**
 * ----------------------------------------------------
 * 4) REAL APP ROUTES (IMPORTS then MOUNT)
 * ----------------------------------------------------
 * IMPORTANT: require() FIRST, then app.use(...)
 * Your route files should export an Express Router.
 */
const usersRoutes     = require("./routes/users");
const vehiclesRoutes  = require("./routes/vehicles");
const fuelRoutes      = require("./routes/fuel");
const serviceRoutes   = require("./routes/service");
const documentsRoutes = require("./routes/documents");
const remindersRoutes = require("./routes/reminders");
const reportsRoutes   = require("./routes/reports");
const testEmailRoutes = require("./routes/testemail"); // if you keep extra test routes here

// Optional routes (only mount if files exist)
let paymentsRoutes = null;
let affiliatesRoutes = null;
try { paymentsRoutes = require("./routes/payments"); } catch (_) {}
try { affiliatesRoutes = require("./routes/affiliates"); } catch (_) {}

// Mount (after imports)
app.use("/api/users", usersRoutes);
app.use("/api/vehicles", vehiclesRoutes);
app.use("/api/fuel", fuelRoutes);
app.use("/api/service", serviceRoutes);
app.use("/api/docs", documentsRoutes);
app.use("/api/reminders", remindersRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api", testEmailRoutes); // exposes /api/test-email, /api/email-verify, etc.
if (paymentsRoutes)  app.use("/api/payments", paymentsRoutes);
if (affiliatesRoutes) app.use("/api/affiliates", affiliatesRoutes);

/**
 * ----------------------------------------------------
 * 5) CRON — safe stub
 * ----------------------------------------------------
 */
async function runExpiryCheck() {
  console.log("⏰ runExpiryCheck() stub called (plug in your real logic here).");
}
// Run daily at 08:00 Africa/Nairobi
cron.schedule(
  "0 8 * * *",
  () => runExpiryCheck().catch((e) => console.error("runExpiryCheck error:", e)),
  { timezone: "Africa/Nairobi" }
);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
