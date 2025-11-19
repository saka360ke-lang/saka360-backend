// index.js
// Saka360 Backend - WhatsApp → (Fuel logic or n8n) → DB → WhatsApp

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

// Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ====== POSTGRES SETUP ======
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function testDb() {
  try {
    const result = await pool.query("SELECT NOW() as now");
    console.log("🗄️ Connected to Postgres. Time:", result.rows[0].now);
  } catch (err) {
    console.error("❌ Error connecting to Postgres:", err.message);
  }
}
testDb();

// ====== SMALL HELPERS ======

function parseNumber(text) {
  if (!text) return NaN;
  const cleaned = String(text).replace(/[^0-9.]/g, "");
  return parseFloat(cleaned);
}

async function getActiveFuelSession(userWhatsapp) {
  const result = await pool.query(
    `
    SELECT *
    FROM fuel_sessions
    WHERE user_whatsapp = $1
      AND is_completed = FALSE
    ORDER BY id DESC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  return result.rows[0] || null;
}

async function startFuelSession(userWhatsapp) {
  await pool.query(
    `
    INSERT INTO fuel_sessions (user_whatsapp, step, is_completed)
    VALUES ($1, 'ASK_TOTAL_COST', FALSE)
  `,
    [userWhatsapp]
  );

  return (
    "⛽ Let’s log fuel.\n" +
    "Please enter the *total fuel cost* in KES (numbers only, e.g. 8000)."
  );
}

async function updateFuelSessionStep(id, fields) {
  const sets = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = $${idx}`);
    values.push(val);
    idx++;
  }

  sets.push(`updated_at = NOW()`);

  const query = `
    UPDATE fuel_sessions
    SET ${sets.join(", ")}
    WHERE id = $${idx}
  `;
  values.push(id);

  await pool.query(query, values);
}

// Save structured fuel log
async function saveFuelLogFromSession(session) {
  // Cast to Number because Postgres returns NUMERIC as string
  const totalCost = Number(session.total_cost_numeric);
  const pricePerLiter = Number(session.price_per_liter_numeric);
  const odometer = Number(session.odometer_numeric);

  const liters =
    pricePerLiter && isFinite(pricePerLiter) && pricePerLiter > 0
      ? totalCost / pricePerLiter
      : null;

  await pool.query(
    `
    INSERT INTO fuel_logs (
      user_whatsapp,
      message_text,
      total_cost_numeric,
      price_per_liter_numeric,
      liters,
      odometer
    )
    VALUES ($1, $2, $3, $4, $5, $6)
  `,
    [
      session.user_whatsapp,
      `Fuel log: total=${totalCost}, price_per_liter=${pricePerLiter}, odometer=${odometer}`,
      totalCost,
      pricePerLiter,
      liters,
      odometer,
    ]
  );

  console.log("📝 Saved structured fuel log for:", session.user_whatsapp);

  return liters;
}

// Build simple fuel report (daily / weekly / monthly)
async function buildFuelReport(userWhatsapp) {
  // Total cost last 30 days
  const monthly = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '30 days'
  `,
    [userWhatsapp]
  );

  // Last 7 days
  const weekly = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '7 days'
  `,
    [userWhatsapp]
  );

  // Last 24 hours
  const daily = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '1 day'
  `,
    [userWhatsapp]
  );

  // Efficiency (use last 2 logs with odometer & liters)
  const effRes = await pool.query(
    `
    SELECT odometer, liters
    FROM fuel_logs
    WHERE user_whatsapp = $1
      AND odometer IS NOT NULL
      AND liters IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 2
  `,
    [userWhatsapp]
  );

  const monthTotal = Number(monthly.rows[0].total || 0);
  const weekTotal = Number(weekly.rows[0].total || 0);
  const dayTotal = Number(daily.rows[0].total || 0);

  let efficiencyText = "Not enough data yet to estimate l/km.";

  if (effRes.rows.length === 2) {
    const newer = effRes.rows[0];
    const older = effRes.rows[1];

    const distance = Number(newer.odometer) - Number(older.odometer);
    const liters = Number(newer.liters);

    if (distance > 0 && liters > 0) {
      const litersPerKm = liters / distance;
      efficiencyText = `Approx. *${litersPerKm.toFixed(
        3
      )} L/km* over last ${distance.toFixed(0)} km.`;
    }
  }

  return (
    "⛽ *Fuel Summary*\n\n" +
    `• Last 30 days: *${monthTotal.toFixed(2)} KES*\n` +
    `• Last 7 days: *${weekTotal.toFixed(2)} KES*\n` +
    `• Last 24 hours: *${dayTotal.toFixed(2)} KES*\n\n` +
    efficiencyText
  );
}

// ====== HEALTH CHECK ======
app.get("/", (req, res) => {
  res.send("Saka360 backend is running ✅");
});

// ====== MAIN WHATSAPP INBOUND HANDLER ======
app.post("/whatsapp/inbound", async (req, res) => {
  try {
    const from = req.body.From;        // "whatsapp:+2547..."
    const to = req.body.To;            // your Twilio WhatsApp number
    const rawText = req.body.Body || "";
    const text = rawText.trim();
    const lower = text.toLowerCase();

    console.log("📩 Incoming WhatsApp message:", { from, to, text });

    if (!text) {
      console.log("⚠️ Empty message body received from Twilio.");
      res.status(200).send("OK");
      return;
    }

    let replyText = "";

    // ====== 1) Check if user is in an active fuel session ======
    const activeSession = await getActiveFuelSession(from);

    if (activeSession) {
      // Handle the next step in the fuel flow
      replyText = await handleFuelSessionStep(activeSession, text);
    } else if (lower === "fuel") {
      // ====== 2) Start a new fuel session ======
      replyText = await startFuelSession(from);
    } else if (lower === "fuel report") {
      // ====== 3) Fuel report command ======
      replyText = await buildFuelReport(from);
    } else {
      // ====== 4) Default: send to n8n for general handling ======
      let n8nResponseData = {};
      try {
        const n8nResponse = await axios.post(N8N_WEBHOOK_URL, {
          from,
          to,
          text,
        });

        n8nResponseData = n8nResponse.data || {};
        console.log("🔁 N8N response data:", n8nResponseData);
      } catch (err) {
        console.error("❌ Error calling n8n webhook:", err.message);
      }

      replyText =
        (n8nResponseData &&
          n8nResponseData.reply &&
          String(n8nResponseData.reply).trim()) ||
        "Hi 👋, I’m Saka360. I received your message. Type 'fuel', 'service', 'repair' or 'report' to begin.";
    }

    console.log("💬 Replying to user with:", replyText);

    // ====== SEND REPLY BACK VIA TWILIO ======
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: replyText,
      });
    } catch (twilioErr) {
      console.error(
        "❌ Error sending WhatsApp message via Twilio:",
        twilioErr.message
      );
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error in /whatsapp/inbound route:", error.message);
    res.status(200).send("OK");
  }
});

// ====== FUEL SESSION STEP HANDLER ======
async function handleFuelSessionStep(session, incomingText) {
  const step = session.step;
  const userWhatsapp = session.user_whatsapp;
  const id = session.id;

  if (step === "ASK_TOTAL_COST") {
    const totalCost = parseNumber(incomingText);

    if (!totalCost || !isFinite(totalCost) || totalCost <= 0) {
      return "Please enter the *total fuel cost* in KES as numbers only (e.g. 8000).";
    }

    await updateFuelSessionStep(id, {
      total_cost_numeric: totalCost,
      step: "ASK_PRICE_PER_LITER",
    });

    return (
      "Got it ✅\n" +
      "Now, what is the *price per liter* in KES? (e.g. 200)"
    );
  }

  if (step === "ASK_PRICE_PER_LITER") {
    const pricePerLiter = parseNumber(incomingText);

    if (
      !pricePerLiter ||
      !isFinite(pricePerLiter) ||
      pricePerLiter <= 0
    ) {
      return "Please enter the *price per liter* in KES as numbers only (e.g. 200).";
    }

    await updateFuelSessionStep(id, {
      price_per_liter_numeric: pricePerLiter,
      step: "ASK_ODOMETER",
    });

    return (
      "Great ✅\n" +
      "Next, what is the *odometer reading* in km? (e.g. 123456)"
    );
  }

  if (step === "ASK_ODOMETER") {
    const odometer = parseNumber(incomingText);

    if (!odometer || !isFinite(odometer) || odometer <= 0) {
      return "Please enter the *odometer reading* in km as numbers only (e.g. 123456).";
    }

    // Update session with odometer & mark completed
    await updateFuelSessionStep(id, {
      odometer_numeric: odometer,
      is_completed: true,
      step: "DONE",
    });

    // Reload full session row (with updated fields)
    const result = await pool.query(
      "SELECT * FROM fuel_sessions WHERE id = $1",
      [id]
    );
    const updatedSession = result.rows[0];

   const liters = await saveFuelLogFromSession(updatedSession);

    // Cast values to numbers
    const totalCost = Number(updatedSession.total_cost_numeric);
    const pricePerLiter = Number(updatedSession.price_per_liter_numeric);
    const odoNum = Number(odometer);

  let summary =
    "✅ Fuel log saved.\n\n" +
    `• Total cost: *${totalCost.toFixed(2)} KES*\n` +
    `• Price per liter: *${pricePerLiter.toFixed(2)} KES*\n` +
    `• Odometer: *${odoNum.toFixed(0)} km*`;

  if (liters && isFinite(liters)) {
    const litersNum = Number(liters);
  if (isFinite(litersNum)) {
    summary += `\n• Liters (calculated): *${litersNum.toFixed(2)} L*`;
  }
}

summary +=
  "\n\nYou can type *fuel report* anytime to see your fuel cost summary and efficiency.";


    summary +=
      "\n\nYou can type *fuel report* anytime to see your fuel cost summary and efficiency.";

    return summary;
  }

  // Fallback: unknown step
  console.warn("⚠️ Unknown fuel session step:", step);
  await updateFuelSessionStep(id, { is_completed: true, step: "DONE" });
  return "Something went wrong with this fuel entry. Please type *fuel* to start again.";
}

// ====== START SERVER ======
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
  console.log(`🚀 Saka360 backend listening on port ${serverPort}`);
});
