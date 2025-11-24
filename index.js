// =====================================================
//  SAKA360 BACKEND (PART 1 OF 3)
//  Setup, Environment, Database, Utility Helpers
// =====================================================

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const { Pool } = require("pg");

require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// -------------------- ENV --------------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  N8N_WEBHOOK_URL,
  DATABASE_URL,
  PORT
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER || !N8N_WEBHOOK_URL || !DATABASE_URL) {
  console.error("❌ Missing environment variables");
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// -------------------- POSTGRES --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("🗄️ PostgreSQL connected successfully"))
  .catch(err => console.error("❌ PostgreSQL connection error:", err.message));

// -------------------- HELPERS --------------------
function parseNumber(text) {
  if (!text) return NaN;
  const cleaned = String(text).replace(/[^0-9.]/g, "");
  return parseFloat(cleaned);
}

async function query(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.error("❌ DB ERROR:", err.message);
    throw err;
  }
}

function sendWhatsApp(to, body) {
  return twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body
  });
}

// -------------------- SESSION GETTERS --------------------
async function getActiveFuelSession(phone) {
  const r = await query(
    `SELECT * FROM fuel_sessions WHERE user_whatsapp=$1 AND is_completed=false ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  return r.rows[0] || null;
}

async function getActiveServiceSession(phone) {
  const r = await query(
    `SELECT * FROM service_sessions WHERE user_whatsapp=$1 AND is_completed=false ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  return r.rows[0] || null;
}

async function getActiveExpenseSession(phone) {
  const r = await query(
    `SELECT * FROM expense_sessions WHERE user_whatsapp=$1 AND is_completed=false ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  return r.rows[0] || null;
}

async function getActiveDriverSession(phone) {
  const r = await query(
    `SELECT * FROM driver_sessions WHERE user_whatsapp=$1 AND is_completed=false ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  return r.rows[0] || null;
}

async function getActiveVehicleSession(phone) {
  const r = await query(
    `SELECT * FROM vehicle_sessions WHERE user_whatsapp=$1 AND is_completed=false ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  return r.rows[0] || null;
}
// =====================================================
//  SAKA360 BACKEND (PART 2 OF 3)
//  Session Engines for Fuel, Service, Expense, Vehicle, Driver
// =====================================================

// -------------------- FUEL --------------------
async function startFuelSession(phone) {
  await query(
    `INSERT INTO fuel_sessions (user_whatsapp, step, is_completed) VALUES ($1,'ASK_TOTAL_COST',false)`,
    [phone]
  );

  return "⛽ Let’s log fuel.\nWhat is the *total fuel cost* in KES?";
}

async function updateFuelSession(id, fields) {
  const set = [];
  const vals = [];
  let i = 1;

  Object.entries(fields).forEach(([key, val]) => {
    set.push(`${key}=$${i}`);
    vals.push(val);
    i++;
  });

  await query(
    `UPDATE fuel_sessions SET ${set.join(",")}, updated_at=NOW() WHERE id=$${i}`,
    [...vals, id]
  );
}

async function saveFuel(session) {
  const liters = session.price_per_liter_numeric > 0
    ? session.total_cost_numeric / session.price_per_liter_numeric
    : null;

  await query(
    `INSERT INTO fuel_logs (user_whatsapp, total_cost_numeric, price_per_liter_numeric, liters, odometer, vehicle_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      session.user_whatsapp,
      session.total_cost_numeric,
      session.price_per_liter_numeric,
      liters,
      session.odometer_numeric,
      session.vehicle_id
    ]
  );

  return liters;
}

async function handleFuelSession(session, incoming) {
  const step = session.step;
  const id = session.id;

  if (step === "ASK_TOTAL_COST") {
    const cost = parseNumber(incoming);
    if (!cost) return "Please send a valid total fuel cost.";
    await updateFuelSession(id, { total_cost_numeric: cost, step: "ASK_PRICE" });
    return "👍 What is the *price per liter* in KES?";
  }

  if (step === "ASK_PRICE") {
    const price = parseNumber(incoming);
    if (!price) return "Please send a valid price per liter.";
    await updateFuelSession(id, { price_per_liter_numeric: price, step: "ASK_ODO" });
    return "Great! What is the *odometer reading* (km)?";
  }

  if (step === "ASK_ODO") {
    const odo = parseNumber(incoming);
    if (!odo) return "Send a valid odometer number.";
    await updateFuelSession(id, {
      odometer_numeric: odo,
      is_completed: true,
      step: "DONE"
    });

    const s = await query(`SELECT * FROM fuel_sessions WHERE id=$1`, [id]);
    const liters = await saveFuel(s.rows[0]);

    return (
      "✅ Fuel saved.\n" +
      `• Total: ${s.rows[0].total_cost_numeric} KES\n` +
      `• Price per liter: ${s.rows[0].price_per_liter_numeric} KES\n` +
      `• Odometer: ${odo} km\n` +
      (liters ? `• Liters: ${liters.toFixed(2)}\n` : "") +
      "\nType *fuel report* anytime."
    );
  }

  return "❌ Unknown fuel step. Type *fuel* again.";
}

// -------------------- SERVICE --------------------
async function startServiceSession(phone, vehicleId) {
  await query(
    `INSERT INTO service_sessions (user_whatsapp, vehicle_id, step, is_completed)
     VALUES ($1,$2,'ASK_TITLE',false)`,
    [phone, vehicleId]
  );

  return "🔧 What service are you logging? (e.g. Oil change)";
}

async function updateServiceSession(id, fields) {
  const set = [];
  const vals = [];
  let i = 1;

  Object.entries(fields).forEach(([key, val]) => {
    set.push(`${key}=$${i}`);
    vals.push(val);
    i++;
  });

  await query(
    `UPDATE service_sessions SET ${set.join(",")}, updated_at=NOW() WHERE id=$${i}`,
    [...vals, id]
  );
}

async function saveService(session) {
  await query(
    `INSERT INTO service_logs (user_whatsapp, vehicle_id, title, cost_numeric, odometer_numeric, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      session.user_whatsapp,
      session.vehicle_id,
      session.title,
      session.cost_numeric,
      session.odometer_numeric,
      session.notes
    ]
  );
}

async function handleServiceSession(session, incoming) {
  const id = session.id;

  if (session.step === "ASK_TITLE") {
    await updateServiceSession(id, { title: incoming.trim(), step: "ASK_COST" });
    return "What is the *service cost* in KES?";
  }

  if (session.step === "ASK_COST") {
    const cost = parseNumber(incoming);
    if (!cost) return "Send a valid cost.";
    await updateServiceSession(id, { cost_numeric: cost, step: "ASK_ODO" });
    return "Odometer reading (km)?";
  }

  if (session.step === "ASK_ODO") {
    const odo = parseNumber(incoming);
    if (!odo) return "Send a valid odometer reading.";
    await updateServiceSession(id, { odometer_numeric: odo, step: "ASK_NOTES" });
    return "Any notes? Type them, or send *skip*.";
  }

  if (session.step === "ASK_NOTES") {
    const notes = incoming.toLowerCase() === "skip" ? null : incoming.trim();
    await updateServiceSession(id, { notes, is_completed: true, step: "DONE" });

    const s = await query(`SELECT * FROM service_sessions WHERE id=$1`, [id]);
    await saveService(s.rows[0]);

    return (
      "✅ Service saved.\n" +
      `• ${s.rows[0].title}\n` +
      `• ${s.rows[0].cost_numeric} KES\n` +
      `• ${s.rows[0].odometer_numeric} km\n` +
      (notes ? `• Notes: ${notes}` : "")
    );
  }

  return "❌ Unknown service step.";
}

// -------------------- EXPENSE --------------------
async function startExpenseSession(phone, vehicleId) {
  await query(
    `INSERT INTO expense_sessions (user_whatsapp, vehicle_id, step, is_completed)
     VALUES ($1,$2,'ASK_TITLE',false)`,
    [phone, vehicleId]
  );

  return "💸 What expense do you want to log?";
}

async function updateExpenseSession(id, fields) {
  const set = [];
  const vals = [];
  let i = 1;

  Object.entries(fields).forEach(([key, val]) => {
    set.push(`${key}=$${i}`);
    vals.push(val);
    i++;
  });

  await query(
    `UPDATE expense_sessions SET ${set.join(",")}, updated_at=NOW() WHERE id=$${i}`,
    [...vals, id]
  );
}

async function saveExpense(session) {
  await query(
    `INSERT INTO expense_logs (user_whatsapp, vehicle_id, title, cost_numeric, odometer_numeric)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      session.user_whatsapp,
      session.vehicle_id,
      session.title,
      session.cost_numeric,
      session.odometer_numeric
    ]
  );
}

async function handleExpenseSession(session, incoming) {
  const id = session.id;

  if (session.step === "ASK_TITLE") {
    await updateExpenseSession(id, { title: incoming.trim(), step: "ASK_COST" });
    return "How much did it cost (KES)?";
  }

  if (session.step === "ASK_COST") {
    const cost = parseNumber(incoming);
    if (!cost) return "Send a valid cost.";
    await updateExpenseSession(id, { cost_numeric: cost, step: "ASK_ODO" });
    return "Odometer reading (km)?";
  }

  if (session.step === "ASK_ODO") {
    const odo = parseNumber(incoming);
    if (!odo) return "Send a valid odometer number.";
    await updateExpenseSession(id, { odometer_numeric: odo, is_completed: true, step: "DONE" });

    const s = await query(`SELECT * FROM expense_sessions WHERE id=$1`, [id]);
    await saveExpense(s.rows[0]);

    return (
      "✅ Expense saved.\n" +
      `• ${s.rows[0].title}\n` +
      `• ${s.rows[0].cost_numeric} KES\n` +
      `• ${s.rows[0].odometer_numeric} km`
    );
  }

  return "❌ Unknown expense step.";
}
// =====================================================
//  SAKA360 BACKEND (PART 3 OF 3)
//  Routing, AI Gateway, WhatsApp Send
// =====================================================

app.get("/", (req, res) => {
  res.send("Saka360 backend is running 🎉");
});

// -------------------- MAIN WHATSAPP ROUTE --------------------
app.post("/whatsapp/inbound", async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  const text = (req.body.Body || "").trim();

  console.log("📩 Incoming WhatsApp message:", { from, to, text });

  let reply = null;

  // 1️⃣ CHECK ACTIVE SESSIONS FIRST
  const fuel = await getActiveFuelSession(from);
  const service = await getActiveServiceSession(from);
  const expense = await getActiveExpenseSession(from);

  if (fuel) reply = await handleFuelSession(fuel, text);
  else if (service) reply = await handleServiceSession(service, text);
  else if (expense) reply = await handleExpenseSession(expense, text);

  // 2️⃣ NO SESSION → Check local commands
  else if (text.toLowerCase() === "fuel") reply = await startFuelSession(from);
  else if (text.toLowerCase() === "service") {
    const vehicleId = null; // simplified in this clean build
    reply = await startServiceSession(from, vehicleId);
  }
  else if (text.toLowerCase() === "expense") {
    const vehicleId = null;
    reply = await startExpenseSession(from, vehicleId);
  }

  // 3️⃣ OTHERWISE → SEND TO AI THROUGH N8N
  if (!reply) {
    try {
      const aiRes = await axios.post(N8N_WEBHOOK_URL, {
        from,
        to,
        text
      });

      if (aiRes.data && aiRes.data.reply) {
        reply = aiRes.data.reply;
      } else {
        reply = "I’m here to help. What would you like to do?";
      }
    } catch (err) {
      console.error("❌ AI/N8N error:", err.message);
      reply = "I’m here to help. What would you like to do?";
    }
  }

  console.log("💬 Sending reply:", reply);

  try {
    await sendWhatsApp(from, reply);
  } catch (err) {
    console.error("❌ Twilio send error:", err.message);
  }

  res.status(200).send("OK");
});

// -------------------- START SERVER --------------------
const serverPort = PORT || 3000;
app.listen(serverPort, () =>
  console.log(`🚀 Saka360 backend running on port ${serverPort}`)
);
