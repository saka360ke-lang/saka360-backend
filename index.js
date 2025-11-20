// index.js
// Saka360 Backend - WhatsApp → (Fuel / Service / Expense or n8n) → DB → WhatsApp

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
  PORT,
} = process.env;

const DISABLE_TWILIO_SEND = process.env.DISABLE_TWILIO_SEND;

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
  console.log(
    "Using TWILIO_WHATSAPP_NUMBER:",
    JSON.stringify(TWILIO_WHATSAPP_NUMBER)
  );
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ====== POSTGRES ======
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

// ====== GENERIC HELPERS ======
function parseNumber(text) {
  if (!text) return NaN;
  const cleaned = String(text).replace(/[^0-9.]/g, "");
  return parseFloat(cleaned);
}

// ====== FUEL HELPERS ======
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

async function saveFuelLogFromSession(session) {
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

async function buildFuelReport(userWhatsapp) {
  const monthly = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '30 days'
  `,
    [userWhatsapp]
  );

  const weekly = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '7 days'
  `,
    [userWhatsapp]
  );

  const daily = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '1 day'
  `,
    [userWhatsapp]
  );

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

// ====== SERVICE HELPERS (with notes) ======
async function getActiveServiceSession(userWhatsapp) {
  const result = await pool.query(
    `
    SELECT *
    FROM service_sessions
    WHERE user_whatsapp = $1
      AND is_completed = FALSE
    ORDER BY id DESC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  return result.rows[0] || null;
}

async function startServiceSession(userWhatsapp) {
  await pool.query(
    `
    INSERT INTO service_sessions (user_whatsapp, step, is_completed)
    VALUES ($1, 'ASK_SERVICE_TITLE', FALSE)
  `,
    [userWhatsapp]
  );

  return (
    "🔧 Let’s log a *service*.\n" +
    "What is the service? (e.g. Oil change, Timing belt, Turbo service)"
  );
}

async function updateServiceSessionStep(id, fields) {
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
    UPDATE service_sessions
    SET ${sets.join(", ")}
    WHERE id = $${idx}
  `;
  values.push(id);

  await pool.query(query, values);
}

async function saveServiceLogFromSession(session) {
  const title = session.title || "Service";
  const cost = Number(session.cost_numeric);
  const odometer = Number(session.odometer_numeric);
  const reminderType = session.reminder_type || "none";
  const reminderDateText = session.reminder_date_text || null;
  const reminderOdometer = session.reminder_odometer
    ? Number(session.reminder_odometer)
    : null;
  const notes = session.notes || null;

  await pool.query(
    `
    INSERT INTO service_logs (
      user_whatsapp,
      title,
      cost_numeric,
      odometer_numeric,
      reminder_type,
      reminder_date_text,
      reminder_odometer,
      notes
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `,
    [
      session.user_whatsapp,
      title,
      cost,
      odometer || null,
      reminderType,
      reminderDateText,
      reminderOdometer,
      notes,
    ]
  );

  console.log("📝 Saved service log for:", session.user_whatsapp);
}

async function buildServiceReport(userWhatsapp) {
  const monthly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM service_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '30 days'
  `,
    [userWhatsapp]
  );

  const weekly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM service_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '7 days'
  `,
    [userWhatsapp]
  );

  const daily = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM service_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '1 day'
  `,
    [userWhatsapp]
  );

  const lastServices = await pool.query(
    `
    SELECT title, cost_numeric, odometer_numeric, created_at
    FROM service_logs
    WHERE user_whatsapp = $1
    ORDER BY created_at DESC
    LIMIT 3
  `,
    [userWhatsapp]
  );

  const m = monthly.rows[0];
  const w = weekly.rows[0];
  const d = daily.rows[0];

  let text =
    "🔧 *Service Summary*\n\n" +
    `• Last 30 days: *${Number(m.total || 0).toFixed(
      2
    )} KES* across *${m.count}* services\n` +
    `• Last 7 days: *${Number(w.total || 0).toFixed(
      2
    )} KES* across *${w.count}* services\n` +
    `• Last 24 hours: *${Number(d.total || 0).toFixed(
      2
    )} KES* across *${d.count}* services\n`;

  if (lastServices.rows.length === 0) {
    text +=
      "\nNo service records found yet. Type *service* to log your first one.";
    return text;
  }

  text += "\nLast few services:\n";

  for (const row of lastServices.rows) {
    const title = row.title || "Service";
    const cost = Number(row.cost_numeric || 0).toFixed(2);
    const odo = row.odometer_numeric
      ? Number(row.odometer_numeric).toFixed(0) + " km"
      : "n/a";
    const dateStr = row.created_at
      ? new Date(row.created_at).toISOString().slice(0, 10)
      : "";

    text += `\n• *${title}* – ${cost} KES, ${odo} on ${dateStr}`;
  }

  return text;
}

// ====== EXPENSE HELPERS ======
async function getActiveExpenseSession(userWhatsapp) {
  const result = await pool.query(
    `
    SELECT *
    FROM expense_sessions
    WHERE user_whatsapp = $1
      AND is_completed = FALSE
    ORDER BY id DESC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  return result.rows[0] || null;
}

async function startExpenseSession(userWhatsapp) {
  await pool.query(
    `
    INSERT INTO expense_sessions (user_whatsapp, step, is_completed)
    VALUES ($1, 'ASK_EXPENSE_TITLE', FALSE)
  `,
    [userWhatsapp]
  );

  return (
    "💸 Let’s log an *expense*.\n" +
    "What is the expense for? (e.g. Puncture, Paint job, Parts, Parking)"
  );
}

async function updateExpenseSessionStep(id, fields) {
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
    UPDATE expense_sessions
    SET ${sets.join(", ")}
    WHERE id = $${idx}
  `;
  values.push(id);

  await pool.query(query, values);
}

async function saveExpenseLogFromSession(session) {
  const title = session.title || "Expense";
  const cost = Number(session.cost_numeric);
  const odometer = session.odometer_numeric
    ? Number(session.odometer_numeric)
    : null;

  await pool.query(
    `
    INSERT INTO expense_logs (
      user_whatsapp,
      title,
      cost_numeric,
      odometer_numeric
    )
    VALUES ($1, $2, $3, $4)
  `,
    [session.user_whatsapp, title, cost, odometer]
  );

  console.log("📝 Saved expense log for:", session.user_whatsapp);
}

async function buildExpenseReport(userWhatsapp) {
  const monthly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM expense_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '30 days'
  `,
    [userWhatsapp]
  );

  const weekly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM expense_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '7 days'
  `,
    [userWhatsapp]
  );

  const daily = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM expense_logs
    WHERE user_whatsapp = $1
      AND created_at >= NOW() - INTERVAL '1 day'
  `,
    [userWhatsapp]
  );

  const lastExpenses = await pool.query(
    `
    SELECT title, cost_numeric, odometer_numeric, created_at
    FROM expense_logs
    WHERE user_whatsapp = $1
    ORDER BY created_at DESC
    LIMIT 3
  `,
    [userWhatsapp]
  );

  const m = monthly.rows[0];
  const w = weekly.rows[0];
  const d = daily.rows[0];

  let text =
    "💸 *Expense Summary*\n\n" +
    `• Last 30 days: *${Number(m.total || 0).toFixed(
      2
    )} KES* across *${m.count}* expenses\n` +
    `• Last 7 days: *${Number(w.total || 0).toFixed(
      2
    )} KES* across *${w.count}* expenses\n` +
    `• Last 24 hours: *${Number(d.total || 0).toFixed(
      2
    )} KES* across *${d.count}* expenses\n`;

  if (lastExpenses.rows.length === 0) {
    text +=
      "\nNo expense records found yet. Type *expense* to log your first one.";
    return text;
  }

  text += "\nLast few expenses:\n";

  for (const row of lastExpenses.rows) {
    const title = row.title || "Expense";
    const cost = Number(row.cost_numeric || 0).toFixed(2);
    const odo = row.odometer_numeric
      ? Number(row.odometer_numeric).toFixed(0) + " km"
      : "n/a";
    const dateStr = row.created_at
      ? new Date(row.created_at).toISOString().slice(0, 10)
      : "";

    text += `\n• *${title}* – ${cost} KES, ${odo} on ${dateStr}`;
  }

  return text;
}

// ====== GLOBAL SESSION CANCEL ======
async function cancelAllSessionsForUser(userWhatsapp) {
  await pool.query(
    `
    UPDATE fuel_sessions
    SET is_completed = TRUE
    WHERE user_whatsapp = $1
      AND is_completed = FALSE
  `,
    [userWhatsapp]
  );

  await pool.query(
    `
    UPDATE service_sessions
    SET is_completed = TRUE
    WHERE user_whatsapp = $1
      AND is_completed = FALSE
  `,
    [userWhatsapp]
  );

  await pool.query(
    `
    UPDATE expense_sessions
    SET is_completed = TRUE
    WHERE user_whatsapp = $1
      AND is_completed = FALSE
  `,
    [userWhatsapp]
  );
}

// ====== DELETE LAST RECORD ======
async function handleDeleteLastCommand(userWhatsapp, lower) {
  let type = null;
  if (lower.includes("service")) type = "service";
  else if (lower.includes("fuel")) type = "fuel";
  else if (lower.includes("expense")) type = "expense";

  if (!type) {
    return (
      "Please specify what to delete:\n" +
      "• *delete last fuel*\n" +
      "• *delete last service*\n" +
      "• *delete last expense*"
    );
  }

  if (type === "service") {
    const res = await pool.query(
      `
      SELECT id, title, cost_numeric, odometer_numeric
      FROM service_logs
      WHERE user_whatsapp = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [userWhatsapp]
    );

    if (res.rows.length === 0) {
      return "You don't have any *service* records to delete.";
    }

    const row = res.rows[0];
    await pool.query(`DELETE FROM service_logs WHERE id = $1`, [row.id]);

    const title = row.title || "Service";
    const cost = Number(row.cost_numeric || 0).toFixed(2);
    const odo = row.odometer_numeric
      ? Number(row.odometer_numeric).toFixed(0) + " km"
      : "n/a";

    return (
      "✅ Deleted your last *service* record:\n\n" +
      `• Service: *${title}*\n` +
      `• Cost: *${cost} KES*\n` +
      `• Odometer: *${odo}*`
    );
  }

  if (type === "fuel") {
    const res = await pool.query(
      `
      SELECT id, total_cost_numeric, price_per_liter_numeric, odometer
      FROM fuel_logs
      WHERE user_whatsapp = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [userWhatsapp]
    );

    if (res.rows.length === 0) {
      return "You don't have any *fuel* records to delete.";
    }

    const row = res.rows[0];
    await pool.query(`DELETE FROM fuel_logs WHERE id = $1`, [row.id]);

    const total = Number(row.total_cost_numeric || 0).toFixed(2);
    const price = row.price_per_liter_numeric
      ? Number(row.price_per_liter_numeric).toFixed(2)
      : "n/a";
    const odo = row.odometer
      ? Number(row.odometer).toFixed(0) + " km"
      : "n/a";

    return (
      "✅ Deleted your last *fuel* record:\n\n" +
      `• Total cost: *${total} KES*\n` +
      `• Price per liter: *${price} KES*\n` +
      `• Odometer: *${odo}*`
    );
  }

  if (type === "expense") {
    const res = await pool.query(
      `
      SELECT id, title, cost_numeric, odometer_numeric
      FROM expense_logs
      WHERE user_whatsapp = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [userWhatsapp]
    );

    if (res.rows.length === 0) {
      return "You don't have any *expense* records to delete.";
    }

    const row = res.rows[0];
    await pool.query(`DELETE FROM expense_logs WHERE id = $1`, [row.id]);

    const title = row.title || "Expense";
    const cost = Number(row.cost_numeric || 0).toFixed(2);
    const odo = row.odometer_numeric
      ? Number(row.odometer_numeric).toFixed(0) + " km"
      : "n/a";

    return (
      "✅ Deleted your last *expense* record:\n\n" +
      `• Expense: *${title}*\n` +
      `• Cost: *${cost} KES*\n` +
      `• Odometer: *${odo}*`
    );
  }

  return "I couldn't detect what to delete. Please use *delete last fuel*, *delete last service*, or *delete last expense*.";
}

// ====== EDIT LAST RECORD ======
async function handleEditLastCommand(userWhatsapp, fullText) {
  const lower = fullText.toLowerCase().trim();

  let type = null;
  let base = null;

  if (lower.startsWith("edit last service")) {
    type = "service";
    base = "edit last service";
  } else if (lower.startsWith("edit last fuel")) {
    type = "fuel";
    base = "edit last fuel";
  } else if (lower.startsWith("edit last expense")) {
    type = "expense";
    base = "edit last expense";
  } else {
    return (
      "To edit, please use:\n" +
      "• *edit last service cost 5000*\n" +
      "• *edit last fuel price 210*\n" +
      "• *edit last expense odometer 180500*"
    );
  }

  const rest = fullText.slice(base.length).trim();
  if (!rest) {
    if (type === "service") {
      return (
        "Please specify what to edit.\n\nExamples:\n" +
        "• *edit last service cost 5000*\n" +
        "• *edit last service odometer 180000*\n" +
        "• *edit last service title Timing belt change*\n" +
        "• *edit last service notes Mechanic James 0700xxxxxx*"
      );
    }
    if (type === "fuel") {
      return (
        "Please specify what to edit.\n\nExamples:\n" +
        "• *edit last fuel cost 9000*\n" +
        "• *edit last fuel price 210*\n" +
        "• *edit last fuel odometer 123456*"
      );
    }
    return (
      "Please specify what to edit.\n\nExamples:\n" +
      "• *edit last expense cost 1500*\n" +
      "• *edit last expense title Parking*\n" +
      "• *edit last expense odometer 180500*"
    );
  }

  const parts = rest.split(/\s+/);
  const fieldWord = parts[0].toLowerCase();
  const newValueRaw = parts.slice(1).join(" ").trim();

  if (!newValueRaw) {
    return "Please provide a new value after the field. Example: *edit last service cost 5000*.";
  }

  if (type === "service") {
    const res = await pool.query(
      `
      SELECT *
      FROM service_logs
      WHERE user_whatsapp = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [userWhatsapp]
    );

    if (res.rows.length === 0) {
      return "You don't have any *service* records to edit.";
    }

    const log = res.rows[0];
    let updates = {};
    let changedFieldText = "";
    let newValueText = "";
    let oldValueText = "";

    if (fieldWord === "cost") {
      const cost = parseNumber(newValueRaw);
      if (!cost || !isFinite(cost) || cost <= 0) {
        return "Please provide a valid cost in KES (numbers only).";
      }
      updates.cost_numeric = cost;
      changedFieldText = "Cost";
      newValueText = `${cost.toFixed(2)} KES`;
      const old = Number(log.cost_numeric || 0);
      oldValueText = `${old.toFixed(2)} KES`;
    } else if (["odometer", "km", "mileage"].includes(fieldWord)) {
      const odo = parseNumber(newValueRaw);
      if (!odo || !isFinite(odo) || odo <= 0) {
        return "Please provide a valid odometer in km (numbers only).";
      }
      updates.odometer_numeric = odo;
      changedFieldText = "Odometer";
      newValueText = `${odo.toFixed(0)} km`;
      const old = Number(log.odometer_numeric || 0);
      oldValueText = `${old.toFixed(0)} km`;
    } else if (fieldWord === "title" || fieldWord === "service") {
      updates.title = newValueRaw;
      changedFieldText = "Service title";
      newValueText = newValueRaw;
      oldValueText = log.title || "";
    } else if (fieldWord === "notes") {
      updates.notes = newValueRaw;
      changedFieldText = "Notes";
      newValueText = newValueRaw;
      oldValueText = log.notes || "";
    } else {
      return (
        "You can edit the following for the last *service*:\n" +
        "• *cost*\n" +
        "• *odometer* / *km* / *mileage*\n" +
        "• *title*\n" +
        "• *notes*\n\n" +
        "Example: *edit last service cost 5000*"
      );
    }

    // Build UPDATE query
    const setParts = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updates)) {
      setParts.push(`${k} = $${idx}`);
      values.push(v);
      idx++;
    }
    setParts.push(`updated_at = NOW()`); // If you have this column
    const query = `
      UPDATE service_logs
      SET ${setParts.join(", ")}
      WHERE id = $${idx}
    `;
    values.push(log.id);
    await pool.query(query, values);

    // Get updated row
    const refreshed = await pool.query(
      "SELECT * FROM service_logs WHERE id = $1",
      [log.id]
    );
    const updated = refreshed.rows[0];

    const title = updated.title || "Service";
    const costNum = Number(updated.cost_numeric || 0);
    const odoNum = updated.odometer_numeric
      ? Number(updated.odometer_numeric)
      : null;
    const notes = updated.notes || null;

    let summary =
      "✅ Updated your last *service* record.\n\n" +
      `• Service: *${title}*\n` +
      `• Cost: *${costNum.toFixed(2)} KES*\n` +
      `• Odometer: *${
        odoNum ? odoNum.toFixed(0) + " km" : "n/a"
      }*`;

    if (notes) {
      summary += `\n• Notes: *${notes}*`;
    }

    if (changedFieldText) {
      summary += `\n\nChanged: *${changedFieldText}* from *${oldValueText}* to *${newValueText}*.`;
    }

    return summary;
  }

  if (type === "fuel") {
    const res = await pool.query(
      `
      SELECT *
      FROM fuel_logs
      WHERE user_whatsapp = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [userWhatsapp]
    );

    if (res.rows.length === 0) {
      return "You don't have any *fuel* records to edit.";
    }

    const log = res.rows[0];
    let total = Number(log.total_cost_numeric || 0);
    let price = Number(log.price_per_liter_numeric || 0);
    let odo = log.odometer ? Number(log.odometer) : null;

    let changedFieldText = "";
    let newValueText = "";
    let oldValueText = "";

    if (["cost", "total", "amount"].includes(fieldWord)) {
      const newTotal = parseNumber(newValueRaw);
      if (!newTotal || !isFinite(newTotal) || newTotal <= 0) {
        return "Please provide a valid total fuel cost in KES (numbers only).";
      }
      oldValueText = `${total.toFixed(2)} KES`;
      total = newTotal;
      changedFieldText = "Total cost";
      newValueText = `${total.toFixed(2)} KES`;
    } else if (["price", "liter", "perliter", "per_liter"].includes(fieldWord)) {
      const newPrice = parseNumber(newValueRaw);
      if (!newPrice || !isFinite(newPrice) || newPrice <= 0) {
        return "Please provide a valid price per liter in KES (numbers only).";
      }
      oldValueText = `${price.toFixed(2)} KES`;
      price = newPrice;
      changedFieldText = "Price per liter";
      newValueText = `${price.toFixed(2)} KES`;
    } else if (["odometer", "km", "mileage"].includes(fieldWord)) {
      const newOdo = parseNumber(newValueRaw);
      if (!newOdo || !isFinite(newOdo) || newOdo <= 0) {
        return "Please provide a valid odometer in km (numbers only).";
      }
      oldValueText = odo ? `${odo.toFixed(0)} km` : "n/a";
      odo = newOdo;
      changedFieldText = "Odometer";
      newValueText = `${odo.toFixed(0)} km`;
    } else {
      return (
        "You can edit the following for the last *fuel* record:\n" +
        "• *cost* / *total* / *amount*\n" +
        "• *price* (per liter)\n" +
        "• *odometer* / *km* / *mileage*\n\n" +
        "Example: *edit last fuel cost 9000*"
      );
    }

    // Recalculate liters if we have both total and price
    let liters = null;
    if (price > 0 && total > 0) {
      liters = total / price;
    }

    await pool.query(
      `
      UPDATE fuel_logs
      SET total_cost_numeric = $1,
          price_per_liter_numeric = $2,
          liters = $3,
          odometer = $4
      WHERE id = $5
    `,
      [total, price, liters, odo, log.id]
    );

    const refreshed = await pool.query(
      "SELECT * FROM fuel_logs WHERE id = $1",
      [log.id]
    );
    const updated = refreshed.rows[0];

    const totalStr = Number(updated.total_cost_numeric || 0).toFixed(2);
    const priceStr = updated.price_per_liter_numeric
      ? Number(updated.price_per_liter_numeric).toFixed(2)
      : "n/a";
    const odoStr = updated.odometer
      ? Number(updated.odometer).toFixed(0) + " km"
      : "n/a";
    const litersStr =
      updated.liters && isFinite(updated.liters)
        ? Number(updated.liters).toFixed(2) + " L"
        : "n/a";

    let summary =
      "✅ Updated your last *fuel* record.\n\n" +
      `• Total cost: *${totalStr} KES*\n` +
      `• Price per liter: *${priceStr} KES*\n` +
      `• Odometer: *${odoStr}*\n` +
      `• Liters (calculated): *${litersStr}*`;

    if (changedFieldText) {
      summary += `\n\nChanged: *${changedFieldText}* from *${oldValueText}* to *${newValueText}*.`;
    }

    return summary;
  }

  if (type === "expense") {
    const res = await pool.query(
      `
      SELECT *
      FROM expense_logs
      WHERE user_whatsapp = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [userWhatsapp]
    );

    if (res.rows.length === 0) {
      return "You don't have any *expense* records to edit.";
    }

    const log = res.rows[0];
    let updates = {};
    let changedFieldText = "";
    let newValueText = "";
    let oldValueText = "";

    if (fieldWord === "cost" || fieldWord === "amount") {
      const cost = parseNumber(newValueRaw);
      if (!cost || !isFinite(cost) || cost <= 0) {
        return "Please provide a valid expense amount in KES (numbers only).";
      }
      updates.cost_numeric = cost;
      changedFieldText = "Cost";
      newValueText = `${cost.toFixed(2)} KES`;
      const old = Number(log.cost_numeric || 0);
      oldValueText = `${old.toFixed(2)} KES`;
    } else if (["odometer", "km", "mileage"].includes(fieldWord)) {
      const odo = parseNumber(newValueRaw);
      if (!odo || !isFinite(odo) || odo <= 0) {
        return "Please provide a valid odometer in km (numbers only).";
      }
      updates.odometer_numeric = odo;
      changedFieldText = "Odometer";
      newValueText = `${odo.toFixed(0)} km`;
      const old = Number(log.odometer_numeric || 0);
      oldValueText = `${old.toFixed(0)} km`;
    } else if (fieldWord === "title" || fieldWord === "expense") {
      updates.title = newValueRaw;
      changedFieldText = "Expense title";
      newValueText = newValueRaw;
      oldValueText = log.title || "";
    } else {
      return (
        "You can edit the following for the last *expense* record:\n" +
        "• *cost* / *amount*\n" +
        "• *odometer* / *km* / *mileage*\n" +
        "• *title*\n\n" +
        "Example: *edit last expense cost 1500*"
      );
    }

    const setParts = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updates)) {
      setParts.push(`${k} = $${idx}`);
      values.push(v);
      idx++;
    }
    setParts.push(`updated_at = NOW()`); // if column exists
    const query = `
      UPDATE expense_logs
      SET ${setParts.join(", ")}
      WHERE id = $${idx}
    `;
    values.push(log.id);
    await pool.query(query, values);

    const refreshed = await pool.query(
      "SELECT * FROM expense_logs WHERE id = $1",
      [log.id]
    );
    const updated = refreshed.rows[0];

    const title = updated.title || "Expense";
    const costNum = Number(updated.cost_numeric || 0);
    const odoNum = updated.odometer_numeric
      ? Number(updated.odometer_numeric)
      : null;

    let summary =
      "✅ Updated your last *expense* record.\n\n" +
      `• Expense: *${title}*\n` +
      `• Cost: *${costNum.toFixed(2)} KES*\n` +
      `• Odometer: *${
        odoNum ? odoNum.toFixed(0) + " km" : "n/a"
      }*`;

    if (changedFieldText) {
      summary += `\n\nChanged: *${changedFieldText}* from *${oldValueText}* to *${newValueText}*.`;
    }

    return summary;
  }

  return "I couldn't detect what to edit. Please use *edit last service ...*, *edit last fuel ...*, or *edit last expense ...*.";
}

// ====== HEALTH CHECK ======
app.get("/", (req, res) => {
  res.send("Saka360 backend is running ✅");
});

// ====== MAIN WHATSAPP HANDLER ======
app.post("/whatsapp/inbound", async (req, res) => {
  try {
    const from = req.body.From; // "whatsapp:+2547..."
    const to = req.body.To; // your Twilio WA number
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

    // GLOBAL COMMANDS: cancel / stop / reset
    if (["cancel", "stop", "reset"].includes(lower)) {
      await cancelAllSessionsForUser(from);
      replyText =
        "✅ I’ve cancelled your current entry. You can start again with *fuel*, *service*, or *expense*.";
    }
    // GLOBAL COMMAND: delete last ...
    else if (lower.startsWith("delete last")) {
      replyText = await handleDeleteLastCommand(from, lower);
    }
    // GLOBAL COMMAND: edit last ...
    else if (lower.startsWith("edit last")) {
      replyText = await handleEditLastCommand(from, text);
    } else {
      // 1) Active sessions first
      const activeFuelSession = await getActiveFuelSession(from);
      const activeServiceSession = await getActiveServiceSession(from);
      const activeExpenseSession = await getActiveExpenseSession(from);

      if (activeFuelSession) {
        replyText = await handleFuelSessionStep(activeFuelSession, text);
      } else if (activeServiceSession) {
        replyText = await handleServiceSessionStep(activeServiceSession, text);
      } else if (activeExpenseSession) {
        replyText = await handleExpenseSessionStep(activeExpenseSession, text);
      } else if (lower === "fuel") {
        replyText = await startFuelSession(from);
      } else if (lower === "fuel report") {
        replyText = await buildFuelReport(from);
      } else if (lower === "service") {
        replyText = await startServiceSession(from);
      } else if (lower === "service report") {
        replyText = await buildServiceReport(from);
      } else if (lower === "expense" || lower === "expenses") {
        replyText = await startExpenseSession(from);
      } else if (lower === "expense report" || lower === "expenses report") {
        replyText = await buildExpenseReport(from);
      } else {
        // 2) No session, no local command → send to n8n
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
          "Hi 👋, I’m Saka360. I received your message. Type *fuel*, *service*, or *expense* to log something.";
      }
    }

    console.log("💬 Replying to user with:", replyText);

    try {
      if (DISABLE_TWILIO_SEND === "true") {
        console.log("🚫 Twilio send disabled by DISABLE_TWILIO_SEND env.");
      } else {
        await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_NUMBER,
          to: from,
          body: replyText,
        });
      }
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

// ====== FUEL SESSION HANDLER ======
async function handleFuelSessionStep(session, incomingText) {
  const step = session.step;
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

    if (!pricePerLiter || !isFinite(pricePerLiter) || pricePerLiter <= 0) {
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

    await updateFuelSessionStep(id, {
      odometer_numeric: odometer,
      is_completed: true,
      step: "DONE",
    });

    const result = await pool.query(
      "SELECT * FROM fuel_sessions WHERE id = $1",
      [id]
    );
    const updatedSession = result.rows[0];

    const liters = await saveFuelLogFromSession(updatedSession);

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

    return summary;
  }

  console.warn("⚠️ Unknown fuel session step:", step);
  await updateFuelSessionStep(id, { is_completed: true, step: "DONE" });
  return "Something went wrong with this fuel entry. Please type *fuel* to start again.";
}

// ====== SERVICE SESSION HANDLER (WITH NOTES) ======
async function handleServiceSessionStep(session, incomingText) {
  const step = session.step;
  const id = session.id;

  if (step === "ASK_SERVICE_TITLE") {
    const title = incomingText.trim();
    if (!title) {
      return "Please enter a short *service title* (e.g. Oil change, Timing belt, Turbo service).";
    }

    await updateServiceSessionStep(id, {
      title,
      step: "ASK_SERVICE_COST",
    });

    return (
      `Service: *${title}*.\n` +
      "What is the *service cost* in KES? (e.g. 5000)"
    );
  }

  if (step === "ASK_SERVICE_COST") {
    const cost = parseNumber(incomingText);
    if (!cost || !isFinite(cost) || cost <= 0) {
      return "Please enter the *service cost* in KES as numbers only (e.g. 5000).";
    }

    await updateServiceSessionStep(id, {
      cost_numeric: cost,
      step: "ASK_SERVICE_ODOMETER",
    });

    return (
      "Got it ✅\n" +
      "What is the *odometer reading* in km at the time of service? (e.g. 180000)"
    );
  }

  if (step === "ASK_SERVICE_ODOMETER") {
    const odometer = parseNumber(incomingText);
    if (!odometer || !isFinite(odometer) || odometer <= 0) {
      return "Please enter the *odometer reading* in km as numbers only (e.g. 180000).";
    }

    await updateServiceSessionStep(id, {
      odometer_numeric: odometer,
      step: "ASK_SERVICE_NOTES",
    });

    return (
      "Optional 📝\n" +
      "You can add any *notes* about this service.\n\n" +
      "Examples:\n" +
      "• Mechanic: John 0722123456\n" +
      "• Service center: Toyota Ngong Road\n" +
      "• Notes: used OEM oil filter\n\n" +
      "If you don't want to add notes, reply with *skip*."
    );
  }

  if (step === "ASK_SERVICE_NOTES") {
    let notes = incomingText.trim();
    if (notes.toLowerCase() === "skip") {
      notes = null;
    }

    await updateServiceSessionStep(id, {
      notes,
      step: "ASK_SERVICE_REMINDER_TYPE",
    });

    return (
      "Do you want a *reminder* for this service?\n\n" +
      "Reply with:\n" +
      "• *date* – reminder by date\n" +
      "• *km* – reminder by next mileage\n" +
      "• *none* – no reminder"
    );
  }

  if (step === "ASK_SERVICE_REMINDER_TYPE") {
    const lower = incomingText.toLowerCase();

    if (lower === "none" || lower === "no") {
      await updateServiceSessionStep(id, {
        reminder_type: "none",
        is_completed: true,
        step: "DONE",
      });

      const result = await pool.query(
        "SELECT * FROM service_sessions WHERE id = $1",
        [id]
      );
      const updatedSession = result.rows[0];
      await saveServiceLogFromSession(updatedSession);

      const title = updatedSession.title || "Service";
      const cost = Number(updatedSession.cost_numeric);
      const odo = Number(updatedSession.odometer_numeric);
      const notes = updatedSession.notes;

      let summary =
        "✅ Service log saved with *no reminder*.\n\n" +
        `• Service: *${title}*\n` +
        `• Cost: *${cost.toFixed(2)} KES*\n` +
        `• Odometer: *${odo.toFixed(0)} km*`;

      if (notes) {
        summary += `\n• Notes: *${notes}*`;
      }

      return summary;
    }

    if (lower === "date") {
      await updateServiceSessionStep(id, {
        reminder_type: "date",
        step: "ASK_SERVICE_REMINDER_DATE",
      });

      return (
        "Okay ✅ reminder by *date*.\n" +
        "Please enter the reminder date in format *YYYY-MM-DD* (e.g. 2025-03-10)."
      );
    }

    if (lower === "km" || lower === "mileage") {
      await updateServiceSessionStep(id, {
        reminder_type: "km",
        step: "ASK_SERVICE_REMINDER_ODOMETER",
      });

      return (
        "Okay ✅ reminder by *next mileage*.\n" +
        "Please enter the *odometer (km)* when you want the reminder (e.g. 200000)."
      );
    }

    return (
      "Please reply with *date*, *km* or *none* to set the reminder type."
    );
  }

  if (step === "ASK_SERVICE_REMINDER_DATE") {
    const dateText = incomingText.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
      return "Please enter the date in *YYYY-MM-DD* format (e.g. 2025-03-10).";
    }

    await updateServiceSessionStep(id, {
      reminder_date_text: dateText,
      is_completed: true,
      step: "DONE",
    });

    const result = await pool.query(
      "SELECT * FROM service_sessions WHERE id = $1",
      [id]
    );
    const updatedSession = result.rows[0];
    await saveServiceLogFromSession(updatedSession);

    const title = updatedSession.title || "Service";
    const cost = Number(updatedSession.cost_numeric);
    const odo = Number(updatedSession.odometer_numeric);
    const notes = updatedSession.notes;

    let summary =
      "✅ Service log saved with *date reminder*.\n\n" +
      `• Service: *${title}*\n` +
      `• Cost: *${cost.toFixed(2)} KES*\n` +
      `• Odometer: *${odo.toFixed(0)} km*\n` +
      `• Reminder date: *${dateText}*`;

    if (notes) {
      summary += `\n• Notes: *${notes}*`;
    }

    return summary;
  }

  if (step === "ASK_SERVICE_REMINDER_ODOMETER") {
    const remOdo = parseNumber(incomingText);
    if (!remOdo || !isFinite(remOdo) || remOdo <= 0) {
      return "Please enter the *odometer (km)* as numbers only (e.g. 200000).";
    }

    await updateServiceSessionStep(id, {
      reminder_odometer: remOdo,
      is_completed: true,
      step: "DONE",
    });

    const result = await pool.query(
      "SELECT * FROM service_sessions WHERE id = $1",
      [id]
    );
    const updatedSession = result.rows[0];
    await saveServiceLogFromSession(updatedSession);

    const title = updatedSession.title || "Service";
    const cost = Number(updatedSession.cost_numeric);
    const odo = Number(updatedSession.odometer_numeric);
    const notes = updatedSession.notes;

    let summary =
      "✅ Service log saved with *mileage reminder*.\n\n" +
      `• Service: *${title}*\n` +
      `• Cost: *${cost.toFixed(2)} KES*\n` +
      `• Odometer: *${odo.toFixed(0)} km*\n` +
      `• Next reminder at: *${remOdo.toFixed(0)} km*`;

    if (notes) {
      summary += `\n• Notes: *${notes}*`;
    }

    return summary;
  }

  console.warn("⚠️ Unknown service session step:", step);
  await updateServiceSessionStep(id, { is_completed: true, step: "DONE" });
  return "Something went wrong with this service entry. Please type *service* to start again.";
}

// ====== EXPENSE SESSION HANDLER ======
async function handleExpenseSessionStep(session, incomingText) {
  const step = session.step;
  const id = session.id;

  if (step === "ASK_EXPENSE_TITLE") {
    const title = incomingText.trim();
    if (!title) {
      return "Please enter a short *expense title* (e.g. Puncture, Paint job, Parking, Parts).";
    }

    await updateExpenseSessionStep(id, {
      title,
      step: "ASK_EXPENSE_COST",
    });

    return (
      `Expense: *${title}*.\n` +
      "What is the *expense amount* in KES? (e.g. 1500)"
    );
  }

  if (step === "ASK_EXPENSE_COST") {
    const cost = parseNumber(incomingText);
    if (!cost || !isFinite(cost) || cost <= 0) {
      return "Please enter the *expense amount* in KES as numbers only (e.g. 1500).";
    }

    await updateExpenseSessionStep(id, {
      cost_numeric: cost,
      step: "ASK_EXPENSE_ODOMETER",
    });

    return (
      "Got it ✅\n" +
      "What is the *odometer reading* in km? (e.g. 180500). If you don't know, you can use the last known value."
    );
  }

  if (step === "ASK_EXPENSE_ODOMETER") {
    const odometer = parseNumber(incomingText);
    if (!odometer || !isFinite(odometer) || odometer <= 0) {
      return "Please enter the *odometer reading* in km as numbers only (e.g. 180500).";
    }

    await updateExpenseSessionStep(id, {
      odometer_numeric: odometer,
      is_completed: true,
      step: "DONE",
    });

    const result = await pool.query(
      "SELECT * FROM expense_sessions WHERE id = $1",
      [id]
    );
    const updatedSession = result.rows[0];
    await saveExpenseLogFromSession(updatedSession);

    const title = updatedSession.title || "Expense";
    const cost = Number(updatedSession.cost_numeric);
    const odo = Number(updatedSession.odometer_numeric);

    return (
      "✅ Expense log saved.\n\n" +
      `• Expense: *${title}*\n` +
      `• Cost: *${cost.toFixed(2)} KES*\n` +
      `• Odometer: *${odo.toFixed(0)} km*`
    );
  }

  console.warn("⚠️ Unknown expense session step:", step);
  await updateExpenseSessionStep(id, { is_completed: true, step: "DONE" });
  return "Something went wrong with this expense entry. Please type *expense* to start again.";
}

// ====== START SERVER ======
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
  console.log(`🚀 Saka360 backend listening on port ${serverPort}`);
});
