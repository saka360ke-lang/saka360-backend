// ======================
// Core / Built-in
// ======================
const fs = require("fs");

// ======================
// Third-party Packages
// ======================
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const twilio = require("twilio");

// ======================
// AWS S3
// ======================
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// ======================
// Express App
// ======================
const app = express();
app.use(express.json());

// ======================
// Middleware
// ======================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Expecting "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: "Access denied. Token required." });
  }

  jwt.verify(token, process.env.JWT_SECRET || "supersecretkey", (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
}

// ======================
// Database
// ======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ======================
// Twilio WhatsApp Setup
// ======================
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+1415...'

function toWhatsAppAddr(num) {
  // Expect num in E.164, e.g. +2547XXXXXXXX
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

async function sendWhatsAppText(toNumberE164, body) {
  if (!toNumberE164 || !body) throw new Error("to and body required");
  const msg = await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: toWhatsAppAddr(toNumberE164),
    body,
  });
  console.log("📲 WhatsApp sent:", msg.sid, msg.status);
  return msg;
}

// Example: database connection (uses env var)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Simple test route
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: "OK", db: "connected", time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: "ERROR", message: err.message });
  }
});

// Simple GET test route for email (no authentication required)
app.get('/api/test-email', async (req, res) => {
  try {
    const sent = await sendEmail(
      "huguadventures@gmail.com",   // hardcoded test email
      "Saka360 Test Email",
      "Hello! 👋 This is a public test email from Saka360 backend."
    );

    if (sent) {
      res.json({ message: "Test email sent ✅" });
    } else {
      res.status(500).json({ error: "Failed to send test email" });
    }
  } catch (err) {
    console.error("Test email route error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Simple GET test route for WhatsApp (no authentication required)
app.get('/api/test-whatsapp', async (req, res) => {
  try {
    const testNumber = "+254720641985"; // replace with your WhatsApp number in E.164 format
    const msg = await sendWhatsAppText(
      testNumber,
      "Hello 👋 This is a public test WhatsApp message from Saka360 backend!"
    );

    res.json({ message: "WhatsApp sent ✅", sid: msg.sid, status: msg.status });
  } catch (err) {
    console.error("Test WhatsApp route error:", err);
    res.status(500).json({ error: "Failed to send WhatsApp", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
