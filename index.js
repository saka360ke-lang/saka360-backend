// index.js
// Saka360 Backend - WhatsApp → n8n → DB → WhatsApp

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const { Pool } = require("pg");

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ====== ENVIRONMENT VARIABLES ======
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  N8N_WEBHOOK_URL,
  DATABASE_URL,
  PORT
} = process.env;

// Debug env vars (without printing secrets)
const missing = [];
if (!TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
if (!TWILIO_WHATSAPP_NUMBER) missing.push("TWILIO_WHATSAPP_NUMBER");
if (!N8N_WEBHOOK_URL) missing.push("N8N_WEBHOOK_URL");
if (!DATABASE_URL) missing.push("DATABASE_URL");

if (missing.length) {
  console.warn("⚠️ Missing environment variables:", missing.join(", "));
} else {
  console.log("✅ All required environment variables are present.");
  console.log("Using TWILIO_WHATSAPP_NUMBER:", JSON.stringify(TWILIO_WHATSAPP_NUMBER));
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ====== POSTGRES SETUP ======
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // needed on many hosted DBs
  },
});

// Simple helper to test DB
async function testDb() {
  try {
    const result = await pool.query("SELECT NOW() as now");
    console.log("🗄️ Connected to Postgres. Time:", result.rows[0].now);
  } catch (err) {
    console.error("❌ Error connecting to Postgres:", err.message);
  }
}
testDb();

// Save fuel log (raw text for now)
async function saveFuelLog(userWhatsapp, messageText) {
  try {
    await pool.query(
      "INSERT INTO fuel_logs (user_whatsapp, message_text) VALUES ($1, $2)",
      [userWhatsapp, messageText]
    );
    console.log("📝 Saved fuel log to DB for:", userWhatsapp);
  } catch (err) {
    console.error("❌ Error saving fuel log:", err.message);
  }
}

// ====== HEALTH CHECK ======
app.get("/", (req, res) => {
  res.send("Saka360 backend is running ✅");
});

// ====== WHATSAPP INBOUND WEBHOOK (FROM TWILIO) ======
app.post("/whatsapp/inbound", async (req, res) => {
  try {
    const from = req.body.From;        // "whatsapp:+2547..."
    const to = req.body.To;            // your Twilio WhatsApp number
    const rawText = req.body.Body || "";
    const text = rawText.trim();

    console.log("📩 Incoming WhatsApp message:", { from, to, text });

    if (!text) {
      console.log("⚠️ Empty message body received from Twilio.");
      res.status(200).send("OK");
      return;
    }

    // ====== CALL n8n WEBHOOK ======
    let n8nResponseData = {};
    try {
      const n8nResponse = await axios.post(N8N_WEBHOOK_URL, {
        from,
        to,
        text
      });

      n8nResponseData = n8nResponse.data || {};
      console.log("🔁 N8N response data:", n8nResponseData);
    } catch (err) {
      console.error("❌ Error calling n8n webhook:", err.message);
    }

    // ====== IF MESSAGE IS FUEL, SAVE TO DB ======
    if (text.toLowerCase().startsWith("fuel")) {
      await saveFuelLog(from, text);
    }

    // ====== DETERMINE REPLY TEXT ======
    const replyText =
      (n8nResponseData && n8nResponseData.reply && String(n8nResponseData.reply).trim()) ||
      "Hi 👋, I’m Saka360. I received your message. Type 'fuel', 'service', 'repair' or 'report' to begin.";

    console.log("💬 Replying to user with:", replyText);

    // ====== SEND REPLY BACK VIA TWILIO ======
    try {
      await client.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: replyText
      });
    } catch (twilioErr) {
      console.error("❌ Error sending WhatsApp message via Twilio:", twilioErr.message);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error in /whatsapp/inbound route:", error.message);
    res.status(200).send("OK");
  }
});

// ====== START SERVER ======
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
  console.log(`🚀 Saka360 backend listening on port ${serverPort}`);
});
