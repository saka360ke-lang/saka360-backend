// index.js
require("dotenv").config();

const express = require("express");
const app = express();
app.use(express.json());

/* -----------------------------
 * 0) Minimal health first (safe)
 * ----------------------------- */
app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "OK" });
});

/* -----------------------------
 * 1) Database (shared pool)
 * ----------------------------- */
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Optional DB health (does not affect /api/health)
app.get("/api/health/db", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ db: "connected", time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ db: "error", error: e.message });
  }
});

/* ------------------------------------------------
 * 2) Infra helpers (Mailer + Twilio test endpoints)
 * ------------------------------------------------ */
const { verifySmtp } = require("./utils/mailer");

// Twilio (for test WhatsApp)
const twilio = require("twilio");
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. +14155238886 (NO "whatsapp:" here)
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured: missing TWILIO_ACCOUNT_SID/AUTH_TOKEN");
  }
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}
function toWhatsAppAddr(numE164) {
  return numE164.startsWith("whatsapp:") ? numE164 : `whatsapp:${numE164}`;
}
async function sendWhatsAppText(toE164, body) {
  if (!toE164) throw new Error("Missing 'to' (E.164 like +2547XXXXXXXX)");
  if (!TWILIO_FROM) throw new Error("Missing TWILIO_WHATSAPP_FROM");
  const client = getTwilioClient();
  return client.messages.create({
    from: toWhatsAppAddr(TWILIO_FROM),
    to: toWhatsAppAddr(toE164),
    body,
  });
}

// SMTP verify (quick infra check)
app.get("/api/email-verify", async (_req, res) => {
  try {
    const ok = await verifySmtp();
    res.json({ ok, message: "SMTP connection OK ✅" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "SMTP verification failed", detail: err.message });
  }
});

// WhatsApp test (POST { to: "+2547...", body?: "..." })
app.post("/api/test-whatsapp", async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' (E.164 like +2547XXXXXXXX)" });
    const msg = await sendWhatsAppText(to, body || "Hello 👋 This is a Saka360 WhatsApp test message ✅");
    res.json({ message: "WhatsApp sent ✅", sid: msg.sid, status: msg.status });
  } catch (err) {
    res.status(500).json({ error: "Failed to send WhatsApp", detail: err.message });
  }
});

/* -------------------------------------------
 * 3) Mount your real app routes (AFTER above)
 * ------------------------------------------- */
/*
  IMPORTANT
  - Your files exist as:
    routes/users.js
    routes/vehicles.js
    routes/fuel.js
    routes/service.js
    routes/documents.js
    routes/reminders.js
    routes/reports.js
    routes/testEmail.js  ← you said this file exists
  - Each of those files must export an Express Router:  module.exports = router;
  - Do NOT call them as functions here. Just require and app.use(...)
*/

// EXACT file names (case-sensitive!)
const usersRoutes     = require("./routes/users")(app);
const vehiclesRoutes  = require("./routes/vehicles");
const fuelRoutes      = require("./routes/fuel");
const serviceRoutes   = require("./routes/service");
const documentsRoutes = require("./routes/documents");
const remindersRoutes = require("./routes/reminders");
const reportsRoutes   = require("./routes/reports");
const testEmailRoutes = require("./routes/testEmail"); // file name exactly "testEmail.js"

// Optional routes: only mount if files actually exist in repo
let paymentsRoutes = null;
let affiliatesRoutes = null;
try { paymentsRoutes = require("./routes/payments"); } catch (_) {}
try { affiliatesRoutes = require("./routes/affiliates"); } catch (_) {}

app.use("/api/payments", paymentsRoutes);


// Mount with clear prefixes
app.use("/api/vehicles", vehiclesRoutes);
app.use("/api/fuel", fuelRoutes);
app.use("/api/service", serviceRoutes);
app.use("/api/docs", documentsRoutes);
app.use("/api/reminders", remindersRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api", testEmailRoutes); // exposes /api/test-email (POST), /api/test-template (POST)

/* -----------------------
 * 4) Cron (safe stub)
 * ----------------------- */
const cron = require("node-cron");
async function runExpiryCheck() {
  console.log("⏰ runExpiryCheck() stub called (plug in your real logic here).");
}
cron.schedule(
  "0 8 * * *",
  () => runExpiryCheck().catch((e) => console.error("runExpiryCheck error:", e)),
  { timezone: "Africa/Nairobi" }
);

/* -----------------------
 * 5) 404 fallback
 * ----------------------- */
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

/* -----------------------
 * 6) Start server
 * ----------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
