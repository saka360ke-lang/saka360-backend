// index.js
// Saka360 Backend - WhatsApp → (Vehicles / Fuel / Service / Expense / Drivers / n8n) → DB → WhatsApp

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const axios = require("axios");

const app = express();

// Twilio usually sends x-www-form-urlencoded payloads.
// We also support JSON in case you front this with something else.
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ----- Postgres pool -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined,
});

// ----- Helpers -----

/**
 * Normalize incoming WhatsApp payload from Twilio (or similar)
 */
function normalizeIncoming(req) {
  const payload = req.body || {};

  // Try common fields – adjust if your provider uses different keys
  const text =
    (payload.Body || payload.message || payload.text || "").toString().trim();
  const from = (payload.From || payload.from || "").toString();
  const to = (payload.To || payload.to || "").toString();

  return {
    text,
    from,
    to,
    raw: payload,
  };
}

/**
 * Basic phone normalizer (Kenya-focused)
 * Examples:
 *   0720123456 -> +254720123456
 *   720123456 -> +254720123456
 *   +254720123456 -> +254720123456
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/\s+/g, "");

  // Remove "whatsapp:" prefix if present
  p = p.replace(/^whatsapp:/i, "");

  // Already in international format
  if (p.startsWith("+")) return p;

  // 07XXXXXXXX -> +2547XXXXXXXX
  if (p.startsWith("07") && p.length === 10) {
    return "+254" + p.slice(1);
  }

  // 7XXXXXXXX -> +2547XXXXXXXX
  if (p.startsWith("7") && p.length === 9) {
    return "+254" + p;
  }

  return p; // fallback – don't over-normalize
}

/**
 * Respond back to WhatsApp (Twilio-style XML)
 */
function sendWhatsAppReply(res, message) {
  res.set("Content-Type", "text/xml");
  const xml = `<Response><Message>${message}</Message></Response>`;
  res.send(xml);
}

/**
 * Optional: push events to n8n workflow to keep index.js clean.
 * Set N8N_WEBHOOK_URL in .env to activate.
 */
async function sendToN8N(eventName, payload) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return; // silently skip if not configured

  try {
    await axios.post(url, {
      event: eventName,
      payload,
    });
  } catch (err) {
    console.error("❌ Failed to send event to n8n:", err.message);
  }
}

// ----- Command handlers -----

/**
 * Handle: "add driver Full Name | 07XXXXXXX"
 * No license_number is collected.
 * We only store: owner_phone, full_name, phone_number, license_type, license_expiry
 */
async function handleAddDriver(ctx) {
  const { text, from } = ctx;

  // Remove the command prefix
  const withoutCmd = text.replace(/^add\s+driver/i, "").trim();
  if (!withoutCmd) {
    return (
      "Please send driver details like this:\n" +
      "add driver Full Name | 07XXXXXXXX"
    );
  }

  const parts = withoutCmd.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    return (
      "I didn't catch that.\nUse this format:\n" +
      "add driver Full Name | 07XXXXXXXX"
    );
  }

  const fullName = parts[0];
  const phoneRaw = parts[1];

  const ownerPhone = normalizePhone(from);
  const driverPhone = normalizePhone(phoneRaw);

  if (!driverPhone) {
    return "The phone number looks invalid. Please try again (07XXXXXXXX).";
  }

  // For now we don't collect license_type or expiry via WhatsApp.
  // You can later extend the command like:
  //   add driver Name | 07XXX | Class BCE | 2028-12-31
  const licenseType = null;
  const licenseExpiry = null;

  // Insert or update driver (no license_number column)
  const sql = `
    INSERT INTO drivers (owner_phone, full_name, phone_number, license_type, license_expiry)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (owner_phone, phone_number) DO UPDATE
      SET full_name = EXCLUDED.full_name,
          license_type = COALESCE(EXCLUDED.license_type, drivers.license_type),
          license_expiry = COALESCE(EXCLUDED.license_expiry, drivers.license_expiry)
    RETURNING id;
  `;

  const params = [
    ownerPhone,
    fullName,
    driverPhone,
    licenseType,
    licenseExpiry,
  ];

  const result = await pool.query(sql, params);
  const driverId = result.rows[0].id;

  // Notify n8n (optional) for extra workflows: emails, Google Sheets, etc.
  await sendToN8N("driver_created_or_updated", {
    driver_id: driverId,
    owner_phone: ownerPhone,
    full_name: fullName,
    phone_number: driverPhone,
    license_type: licenseType,
    license_expiry: licenseExpiry,
  });

  return `✅ Driver saved:\n${fullName} (${driverPhone})`;
}

/**
 * Simple HELP / MENU text
 */
function buildHelpText() {
  return [
    "🚐 Saka360 Vehicle Assistant",
    "",
    "You can send commands like:",
    "• add driver John Doe | 07XXXXXXXX",
    "",
    "More commands (vehicles, fuel, service, expenses) can be added later.",
  ].join("\n");
}

/**
 * Router that decides which command to run based on message text
 */
async function routeCommand(ctx) {
  const text = ctx.text.trim();
  const lower = text.toLowerCase();

  if (!text) {
    return "Hi 👋, please type HELP to see available commands.";
  }

  if (
    ["help", "menu", "hi", "hello", "start"].includes(
      lower.replace(/[^a-z]/g, "")
    )
  ) {
    return buildHelpText();
  }

  if (lower.startsWith("add driver")) {
    return await handleAddDriver(ctx);
  }

  // TODO: future commands
  // if (lower.startsWith("add vehicle")) { ... }
  // if (lower.startsWith("log fuel")) { ... }

  return (
    "❓ I didn't recognize that command.\n" +
    "Type HELP to see what I can do."
  );
}

// ----- Routes -----

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Saka360 backend" });
});

// WhatsApp inbound webhook
app.post("/whatsapp/inbound", async (req, res) => {
  console.log("📩 Incoming WhatsApp message:", JSON.stringify(req.body, null, 2));

  try {
    const ctx = normalizeIncoming(req);

    if (!ctx.text) {
      console.warn("⚠️ No text in incoming message");
    }

    const reply = await routeCommand(ctx);
    sendWhatsAppReply(res, reply);
  } catch (err) {
    console.error("❌ Error in /whatsapp/inbound route:", err);

    if (!res.headersSent) {
      try {
        sendWhatsAppReply(
          res,
          "⚠️ Sorry, something went wrong on our side. Please try again."
        );
      } catch (err2) {
        console.error("❌ Failed to send error reply:", err2);
        res.status(500).end();
      }
    }
  }
});

// ----- Start server -----

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Saka360 backend listening on port ${PORT}`);
});
