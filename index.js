/************************************************************
 * SAKA360 BACKEND (STABLE CJS VERSION)
 * ----------------------------------------------------------
 * This version:
 *  - Has no ES Module conflicts
 *  - Fully compatible with Node 18–22
 *  - Sanitizes ALL outbound JSON to n8n
 *  - Handles fallback logic safely
 *  - Prevents Respond-to-Webhook JSON errors
 *************************************************************/

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ENVIRONMENT VARS
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  N8N_WEBHOOK_URL,
  DATABASE_URL,
  PORT,
} = process.env;

const DISABLE_TWILIO_SEND = process.env.DISABLE_TWILIO_SEND === "true";

// Twilio Client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// DB
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Quick uptime check
pool.query("SELECT NOW()").then(r =>
  console.log("🗄️ DB connected, time:", r.rows[0].now)
);

// Util numeric parser
function parseNumber(text) {
  if (!text) return NaN;
  return parseFloat(String(text).replace(/[^0-9.]/g, ""));
}

// ----------------------------
// VEHICLE HELPERS
// ----------------------------
async function getUserVehicles(wa) {
  const r = await pool.query(
    `SELECT * FROM vehicles WHERE owner_whatsapp=$1 AND is_active=TRUE ORDER BY created_at ASC`,
    [wa]
  );
  return r.rows;
}

async function getCurrentVehicle(wa) {
  const r = await pool.query(
    `SELECT * FROM vehicles WHERE owner_whatsapp=$1 AND is_default=TRUE AND is_active=TRUE LIMIT 1`,
    [wa]
  );
  return r.rows[0] || null;
}

async function ensureCurrentVehicle(wa) {
  const list = await getUserVehicles(wa);
  if (list.length === 0) return { status: "NO_VEHICLES" };

  const current = list.find(v => v.is_default);
  if (current) return { status: "OK", vehicle: current, list };

  if (list.length === 1) {
    await pool.query(`UPDATE vehicles SET is_default=TRUE WHERE id=$1`, [
      list[0].id,
    ]);
    return { status: "OK", vehicle: list[0], list };
  }

  return { status: "NEED_SET_CURRENT", list };
}

function formatVehiclesList(arr) {
  return arr
    .map(
      (v, i) =>
        `${i + 1}. *${v.registration}*${v.is_default ? " (current)" : ""}`
    )
    .join("\n");
}
/************************************************************
 * DRIVER HELPERS
 *************************************************************/

async function getUserDrivers(wa) {
  const r = await pool.query(
    `SELECT * FROM drivers WHERE owner_whatsapp=$1 AND is_active=TRUE ORDER BY created_at ASC`,
    [wa]
  );
  return r.rows;
}

function formatDriversList(arr) {
  return arr
    .map((d, i) => {
      const exp = d.license_expiry_date
        ? String(d.license_expiry_date).slice(0, 10)
        : "n/a";
      return `${i + 1}. *${d.full_name}* – ${d.license_type || "n/a"} (exp: ${exp})`;
    })
    .join("\n");
}

// Add Driver (simplified)
async function handleAddDriver(ownerWA, fullText) {
  const base = "add driver";
  const raw = fullText.slice(base.length).trim();

  if (!raw.includes("|"))
    return "Use: *add driver Full Name | 07XXXXXXXX*";

  const [name, phone] = raw.split("|").map(s => s.trim());
  if (!name || !phone) return "Invalid format. Try again.";

  const driverWA = normalizePhone(phone);

  await pool.query(
    `INSERT INTO drivers (owner_whatsapp, full_name, driver_whatsapp, is_active)
     VALUES ($1,$2,$3,TRUE)
     ON CONFLICT DO NOTHING`,
    [ownerWA, name, driverWA]
  );

  sendWA(driverWA, `Hi ${name}, you were added as a driver. Reply *accept* to continue.`);

  return `Driver *${name}* added.\nInvitation sent to: ${driverWA.replace("whatsapp:","")}`;
}

// Normalize phone
function normalizePhone(p) {
  const d = p.replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 10) return `whatsapp:+254${d.slice(1)}`;
  if (d.startsWith("254")) return `whatsapp:+${d}`;
  if (d.startsWith("+")) return `whatsapp:${d}`;
  return `whatsapp:+${d}`;
}

// ----------------------------
// CANCEL ALL SESSIONS
// ----------------------------
async function cancelAllSessions(wa) {
  await pool.query(
    `UPDATE fuel_sessions   SET is_completed=TRUE WHERE user_whatsapp=$1 AND is_completed=FALSE`,
    [wa]
  );
  await pool.query(
    `UPDATE service_sessions SET is_completed=TRUE WHERE user_whatsapp=$1 AND is_completed=FALSE`,
    [wa]
  );
  await pool.query(
    `UPDATE expense_sessions SET is_completed=TRUE WHERE user_whatsapp=$1 AND is_completed=FALSE`,
    [wa]
  );
}

// ----------------------------
// SAFE SEND
// ----------------------------
async function sendWA(to, message) {
  if (DISABLE_TWILIO_SEND) {
    console.log("🚫 Twilio send disabled:", message);
    return;
  }
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to,
      body: message,
    });
  } catch (e) {
    console.error("❌ Twilio send error:", e.message);
  }
}
/************************************************************
 * N8N CALLER (FULLY SANITIZED)
 *************************************************************/

async function callN8N(from, to, text) {
  try {
    const payload = {
      from: String(from || ""),
      to: String(to || ""),
      text: String(text || ""),
    };

    // NEVER send undefined
    for (const k in payload) {
      if (payload[k] === undefined || payload[k] === null) payload[k] = "";
    }

    const r = await axios.post(N8N_WEBHOOK_URL, payload, {
      timeout: 9500,
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    });

    if (!r.data) return null;
    if (typeof r.data.reply !== "string") return null;

    return r.data.reply.trim();
  } catch (err) {
    console.error("❌ N8N error:", err.message);
    return null;
  }
}
/************************************************************
 * MAIN WHATSAPP HANDLER
 *************************************************************/

app.post("/whatsapp/inbound", async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  const text = (req.body.Body || "").trim();
  const lower = text.toLowerCase();

  console.log("📩 Incoming:", { from, text });

  let reply = "";

  // HIGH-PRIORITY HARD LOGIC
  if (["cancel", "stop", "reset"].includes(lower)) {
    await cancelAllSessions(from);
    reply = "✅ Entry cancelled. Start again with *fuel*, *service*, or *expense*.";
  }

  else if (lower.startsWith("add driver")) {
    reply = await handleAddDriver(from, text);
  }

  // If still no reply → send to N8N
      // 2) Otherwise: send to AI via n8n
    // 2) Otherwise: send to AI via n8n
if (!reply) {
  if (!N8N_WEBHOOK_URL) {
    console.warn("⚠️ N8N_WEBHOOK_URL is NOT set. Skipping AI.");
    reply = "Hi 👋 I’m Saka360. How can I help?";
  } else {
    try {
      console.log("🤖 Calling n8n AI webhook:", N8N_WEBHOOK_URL);
      console.log("🤖 Payload to n8n:", { from, text });

      const aiRes = await axios.post(
        N8N_WEBHOOK_URL,
        { from, text },
        { timeout: 8000 }
      );

      console.log("🤖 Raw n8n AI response:", aiRes.status, aiRes.data);

      // FIX: n8n returns a STRING, convert to an object
      let data = aiRes.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (e) {
          console.error("❌ Could not parse AI JSON:", e.message);
          console.error("RAW n8n:", data);
          reply = "Hi 👋 I’m Saka360. How can I help?";
        }
      }

      if (data && typeof data.reply === "string" && data.reply.trim() !== "") {
        reply = data.reply.trim();
      } else if (data && typeof data.text === "string" && data.text.trim() !== "") {
        reply = data.text.trim();
      } else {
        console.warn("⚠️ AI response missing reply field. Using fallback.");
        reply = "Hi 👋 I’m Saka360. How can I help?";
      }
    } catch (err) {
      console.error("❌ AI/N8N error:", err.message);
      reply = "Hi 👋 I’m Saka360. How can I help?";
    }
  }
}
          const data = aiRes.data || {};
          let data = aiRes.data;

        // If n8n returned a string instead of an object, try to parse it
        if (typeof data === "string") {
          try {
            data = JSON.parse(data);
          } catch (e) {
            console.error("❌ Could not parse AI JSON:", e.message, "RAW:", data);
            reply = "Hi 👋 I’m Saka360. How can I help?";
          }
        }

        //detection
        if (typeof data.reply === "string" && data.reply.trim() !== "") {
        reply = data.reply.trim();
        } 

        } catch (err) {
          console.error("❌ AI/N8N error:", err.message);
          if (err.response) {
            console.error("❌ AI/N8N error status:", err.response.status);
            console.error("❌ AI/N8N error data:", err.response.data);
          }
          reply = "Hi 👋 I’m Saka360. How can I help?";
        }
      }
    }

    console.log("💬 Sending reply:", reply);


  console.log("💬 Reply:", reply);
  await sendWA(from, reply);

  res.status(200).send("OK");
});

/************************************************************
 * START SERVER
 *************************************************************/
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
  console.log(`🚀 Saka360 backend running on ${serverPort}`);
});
