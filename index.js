// index.js
// Saka360 Backend - WhatsApp → n8n → WhatsApp

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ====== ENVIRONMENT VARIABLES ======
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER, // e.g. "whatsapp:+14155238886"
  N8N_WEBHOOK_URL,        // e.g. "https://your-n8n-url/webhook/saka360_inbound"
  PORT
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER || !N8N_WEBHOOK_URL) {
  console.warn("⚠️ Missing one or more required environment variables.");
  console.warn("Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, N8N_WEBHOOK_URL");
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ====== HEALTH CHECK ======
app.get("/", (req, res) => {
  res.send("Saka360 backend is running ✅");
});

// ====== WHATSAPP INBOUND WEBHOOK (FROM TWILIO) ======
app.post("/whatsapp/inbound", async (req, res) => {
  try {
    // Twilio sends From, To, Body for WhatsApp messages
    const from = req.body.From;        // "whatsapp:+2547..."
    const to = req.body.To;            // your Twilio WhatsApp number
    const rawText = req.body.Body || "";
    const text = rawText.trim();

    console.log("📩 Incoming WhatsApp message:", { from, to, text });

    // Safety: if we have no text, just acknowledge
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

    // ====== DETERMINE REPLY TEXT ======
    const replyText =
      (n8nResponseData && n8nResponseData.reply && String(n8nResponseData.reply).trim()) ||
      "Hi 👋, I’m Saka360. I received your message. Type 'fuel', 'service', 'repair' or 'report' to begin.";

    console.log("💬 Replying to user with:", replyText);
    

    // ====== SEND REPLY BACK VIA TWILIO ======
    console.log("TWILIO_WHATSAPP_NUMBER in code:", JSON.stringify(TWILIO_WHATSAPP_NUMBER));

    try {
      await client.messages.create({
        from: TWILIO_WHATSAPP_NUMBER, // e.g. "whatsapp:+14155238886"
        to: from,
        body: replyText
      });
    } catch (twilioErr) {
      console.error("❌ Error sending WhatsApp message via Twilio:", twilioErr.message);
    }

    // Always respond 200 to Twilio quickly
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error in /whatsapp/inbound route:", error.message);
    // Still respond 200 so Twilio does not keep retrying endlessly
    res.status(200).send("OK");
  }
});

// ====== START SERVER ======
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
  console.log(`🚀 Saka360 backend listening on port ${serverPort}`);
});
