// index.js
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const PDFDocument = require("pdfkit");
const fs = require("fs"); // useful for local PDF saving

// ========== TWILIO SETUP ==========
const twilio = require("twilio");
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendWhatsAppText(to, body) {
  return twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    to: `whatsapp:${to}`,
    body
  });
}

// ========== MAILER SETUP ==========
const { sendEmail, verifySmtp } = require("./utils/mailer");

// ========== DATABASE ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ========== EXPRESS APP ==========
const app = express();
app.use(express.json());

// ----- Twilio (WhatsApp) -----
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM; // plain number e.g. +14155238886

function toWhatsAppAddr(numE164) {
  // numE164 must be like +2547xxxxxxx
  return numE164.startsWith('whatsapp:') ? numE164 : `whatsapp:${numE164}`;
}

async function sendWhatsAppText(toE164, body) {
  if (!toE164) throw new Error('Missing recipient');
  if (!TWILIO_FROM) throw new Error('Missing TWILIO_WHATSAPP_FROM');

  const msg = await twilioClient.messages.create({
    from: toWhatsAppAddr(TWILIO_FROM),
    to: toWhatsAppAddr(toE164),
    body
  });
  return msg;
}

function fmtDate(d) {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-KE', { year:'numeric', month:'short', day:'numeric' });
}




// =================================
//           TEST ROUTES
// =================================

// 1) Verify SMTP connectivity
app.get("/api/email-verify", async (req, res) => {
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

// 2) Test plain email (no template required)
app.get("/api/test-email", async (req, res) => {
  try {
    const to = "huguadventures@gmail.com"; // your test inbox
    await sendEmail(
      to,
      "Saka360 Plain Test Email",
      null, // null = no template
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

// 3) Test WhatsApp message
app.get("/api/test-whatsapp", async (req, res) => {
  try {
    const to = "+254720641985"; // replace with your verified WhatsApp number
    const msg = await sendWhatsAppText(
      to,
      "Hello 👋 This is a Saka360 WhatsApp test message ✅"
    );
    res.json({ message: "WhatsApp sent ✅", sid: msg.sid });
  } catch (err) {
    console.error("Test WhatsApp error:", err);
    res.status(500).json({
      error: "Failed to send WhatsApp",
      detail: err.message,
    });
  }
});

// =================================
// Continue with your existing routes here
// (users, fuel, service, docs, reminders, reports, etc.)
// =================================


// Every day at 08:00 Africa/Nairobi
cron.schedule('0 8 * * *', () => {
  runExpiryCheck();
}, { timezone: 'Africa/Nairobi' });


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
