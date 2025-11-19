const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ENV variables (on Render)
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  N8N_WEBHOOK_URL,
  PORT
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Health check
app.get("/", (req, res) => {
  res.send("Saka360 backend is running ✅");
});

// Twilio WhatsApp webhook (incoming messages)
app.post("/whatsapp/inbound", async (req, res) => {
  try {
    const from = req.body.From;
    const to = req.body.To;
    const text = req.body.Body || "";

    console.log("Incoming WhatsApp:", { from, to, text });

    const n8nResponse = await axios.post(process.env.N8N_WEBHOOK_URL, {
      from,
      to,
      text,
    });

    console.log("N8N response data:", n8nResponse.data);  // 👈 ADD THIS

    const replyText =
      (n8nResponse.data && n8nResponse.data.reply) ||
      "Hi 👋, this is Saka360. I received your message.";

    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: replyText,
    });

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error in /whatsapp/inbound:", error.message);
    res.status(200).send("OK");
  }
});

    // 1) Send to n8n for processing
    const n8nResponse = await axios.post(N8N_WEBHOOK_URL, {
      from,
      to,
      text
    });

    const replyText =
      (n8nResponse.data && n8nResponse.data.reply) ||
      "Hi 👋, this is Saka360. I received your message.";

    // 2) Send reply back via Twilio
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER, // e.g. "whatsapp:+14155238886"
      to: from,
      body: replyText
    });

    // Twilio needs a 200 OK, no TwiML if you reply with REST API
    res.status(200).send("OK");
  } catch (error) {
    console.error("Error in /whatsapp/inbound:", error.message);
    res.status(200).send("OK");
  }
});

const serverPort = PORT || 3000;
app.listen(serverPort, () => {
  console.log(`Server listening on port ${serverPort}`);
});
