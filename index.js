// index.js
// Saka360 Backend - WhatsApp → (Vehicles / Fuel / Service / Expense / n8n) → DB → WhatsApp

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

// ====== VEHICLE HELPERS ======

async function getUserVehicles(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM vehicles
    WHERE owner_whatsapp = $1
      AND is_active = TRUE
    ORDER BY created_at ASC
  `,
    [userWhatsapp]
  );
  return res.rows;
}

async function getCurrentVehicle(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM vehicles
    WHERE owner_whatsapp = $1
      AND is_active = TRUE
      AND is_default = TRUE
    ORDER BY created_at ASC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  return res.rows[0] || null;
}

/**
 * Ensure we have a current vehicle for this user.
 * Returns:
 *  { status: "NO_VEHICLES" }
 *  { status: "NEED_SET_CURRENT", list: [vehicles...] }
 *  { status: "OK", vehicle, list }
 */
async function ensureCurrentVehicle(userWhatsapp) {
  const vehicles = await getUserVehicles(userWhatsapp);

  if (vehicles.length === 0) {
    return { status: "NO_VEHICLES" };
  }

  const current = vehicles.find((v) => v.is_default);
  if (current) {
    return { status: "OK", vehicle: current, list: vehicles };
  }

  // No default yet
  if (vehicles.length === 1) {
    // autoselect single vehicle
    const only = vehicles[0];
    await pool.query(
      `UPDATE vehicles SET is_default = TRUE WHERE id = $1`,
      [only.id]
    );
    only.is_default = true;
    return { status: "OK", vehicle: only, list: [only] };
  }

  // Multiple vehicles, user must choose
  return { status: "NEED_SET_CURRENT", list: vehicles };
}

function formatVehiclesList(vehicles, withIndices = true) {
  if (!vehicles || vehicles.length === 0) {
    return "You don't have any vehicles yet.";
  }

  let text = "";
  vehicles.forEach((v, index) => {
    const idx = index + 1;
    const reg = v.registration;
    const nick = v.nickname ? ` (${v.nickname})` : "";
    const mark = v.is_default ? " ✅ (current)" : "";
    if (withIndices) {
      text += `\n${idx}. *${reg}*${nick}${mark}`;
    } else {
      text += `\n• *${reg}*${nick}${mark}`;
    }
  });

  return text.trim();
}

async function handleAddVehicleCommand(userWhatsapp, fullText) {
  const base = "add vehicle";
  const lower = fullText.toLowerCase();

  if (lower === base) {
    return (
      "Let's add a vehicle to your Saka360 account 🚗\n\n" +
      "Please send your vehicle registration in this format:\n" +
      "*add vehicle KDA 123A*\n\n" +
      "Example: *add vehicle KCY 456B*"
    );
  }

  const regRaw = fullText.slice(base.length).trim();
  if (!regRaw) {
    return (
      "Please include the registration after *add vehicle*.\n\n" +
      "Example: *add vehicle KDA 123A*"
    );
  }

  const registration = regRaw.toUpperCase();

  // Check if vehicle already exists for this user
  const existing = await pool.query(
    `
    SELECT *
    FROM vehicles
    WHERE owner_whatsapp = $1
      AND registration = $2
      AND is_active = TRUE
  `,
    [userWhatsapp, registration]
  );

  if (existing.rows.length > 0) {
    const v = existing.rows[0];
    // If not default, make it default
    if (!v.is_default) {
      await pool.query(
        `
        UPDATE vehicles
        SET is_default = TRUE
        WHERE id = $1
      `,
        [v.id]
      );
      await pool.query(
        `
        UPDATE vehicles
        SET is_default = FALSE
        WHERE owner_whatsapp = $1
          AND id <> $2
      `,
        [userWhatsapp, v.id]
      );
    }
    return (
      `This vehicle *${registration}* is already on your account.\n` +
      "I’ve set it as your *current vehicle*.\n\n" +
      "You can now log with *fuel*, *service* or *expense*."
    );
  }

  // Insert new vehicle
  const inserted = await pool.query(
    `
    INSERT INTO vehicles (owner_whatsapp, registration, is_default, is_active)
    VALUES ($1, $2, FALSE, TRUE)
    RETURNING *
  `,
    [userWhatsapp, registration]
  );

  const newVehicle = inserted.rows[0];

  // If this is the first vehicle, set as default
  const allVehicles = await getUserVehicles(userWhatsapp);
  if (allVehicles.length === 1) {
    await pool.query(
      `UPDATE vehicles SET is_default = TRUE WHERE id = $1`,
      [newVehicle.id]
    );
    newVehicle.is_default = true;
    return (
      `✅ Vehicle *${registration}* added and set as your *current vehicle*.\n\n` +
      "You can now log:\n" +
      "• *fuel* – log fuel\n" +
      "• *service* – log service\n" +
      "• *expense* – log other vehicle expenses"
    );
  }

  // Multiple vehicles now; don't force as default
  return (
    `✅ Vehicle *${registration}* added.\n\n` +
    "To use it as your active vehicle, list your vehicles with *my vehicles* " +
    "then send e.g. *switch to 2*."
  );
}

async function handleMyVehiclesCommand(userWhatsapp) {
  const vehicles = await getUserVehicles(userWhatsapp);
  if (vehicles.length === 0) {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with:\n" +
      "*add vehicle KDA 123A*"
    );
  }

  let text = "🚗 *Your vehicles*:\n\n";
  text += formatVehiclesList(vehicles, true);
  text +=
    "\n\nTo change your current vehicle, reply with e.g. *switch to 1* or *switch to 2*.";

  return text;
}

async function handleSwitchVehicleCommand(userWhatsapp, fullText) {
  const lower = fullText.toLowerCase().trim();
  let rest = "";

  if (lower.startsWith("switch to")) {
    rest = fullText.slice("switch to".length).trim();
  } else if (lower.startsWith("switch")) {
    rest = fullText.slice("switch".length).trim();
  } else {
    return (
      "To switch your current vehicle, use:\n" +
      "*switch to 1* or *switch to 2*\n\n" +
      "First, see your list with *my vehicles*."
    );
  }

  const match = rest.match(/(\d+)/);
  if (!match) {
    return (
      "Please include the vehicle number to switch to.\n\n" +
      "Example: *switch to 1*\n" +
      "You can see the list with *my vehicles*."
    );
  }

  const index = parseInt(match[1], 10);
  if (!index || index < 1) {
    return "I couldn't understand that number. Please use a positive number like *1* or *2*.";
  }

  const vehicles = await getUserVehicles(userWhatsapp);
  if (vehicles.length === 0) {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with: *add vehicle KDA 123A*"
    );
  }

  if (index > vehicles.length) {
    return (
      `You only have *${vehicles.length}* vehicle(s).\n\n` +
      "See them with *my vehicles* and choose a valid number."
    );
  }

  const chosen = vehicles[index - 1];

  // Set chosen as default, unset others
  await pool.query(
    `
    UPDATE vehicles
    SET is_default = (id = $1)
    WHERE owner_whatsapp = $2
      AND is_active = TRUE
  `,
    [chosen.id, userWhatsapp]
  );

  const reg = chosen.registration;
  return (
    `✅ Okay, I’ll use *${reg}* as your *current vehicle*.\n\n` +
    "You can now log with *fuel*, *service*, or *expense*."
  );
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
  const vRes = await ensureCurrentVehicle(userWhatsapp);

  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one first with:\n" +
      "*add vehicle KDA 123A*\n\n" +
      "Then type *fuel* again to log fuel."
    );
  }

  if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles. Please choose which one you want to log for.\n\n" +
      listText +
      "\n\nReply with e.g. *switch to 1* or *switch to 2*, then type *fuel* again."
    );
  }

  const vehicle = vRes.vehicle;

  await pool.query(
    `
    INSERT INTO fuel_sessions (user_whatsapp, step, is_completed, vehicle_id)
    VALUES ($1, 'ASK_TOTAL_COST', FALSE, $2)
  `,
    [userWhatsapp, vehicle.id]
  );

  return (
    `⛽ Let’s log fuel for *${vehicle.registration}*.\n` +
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
  const vehicleId = session.vehicle_id || null;

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
      odometer,
      vehicle_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `,
    [
      session.user_whatsapp,
      `Fuel log: total=${totalCost}, price_per_liter=${pricePerLiter}, odometer=${odometer}`,
      totalCost,
      pricePerLiter,
      liters,
      odometer,
      vehicleId,
    ]
  );

  console.log("📝 Saved structured fuel log for:", session.user_whatsapp);

  return liters;
}

// NEW: per-vehicle / all-vehicles fuel report
async function buildFuelReport(userWhatsapp, options = {}) {
  const { vehicleId = null, vehicleLabel = null, allVehicles = false } = options;

  let title = "⛽ *Fuel Summary*";
  let where = "user_whatsapp = $1";
  const params = [userWhatsapp];

  if (!allVehicles && vehicleId) {
    title = `⛽ *Fuel Summary* – ${vehicleLabel || "this vehicle"}`;
    where += " AND vehicle_id = $2";
    params.push(vehicleId);
  } else if (!allVehicles) {
    title = "⛽ *Fuel Summary* (all vehicles)";
  } else {
    title = "⛽ *Fuel Summary* (all vehicles)";
  }

  const monthly = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '30 days'
  `,
    params
  );

  const weekly = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '7 days'
  `,
    params
  );

  const daily = await pool.query(
    `
    SELECT COALESCE(SUM(total_cost_numeric), 0) AS total
    FROM fuel_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '1 day'
  `,
    params
  );

  const effRes = await pool.query(
    `
    SELECT odometer, liters
    FROM fuel_logs
    WHERE ${where}
      AND odometer IS NOT NULL
      AND liters IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 2
  `,
    params
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

  let footer = "";
  if (allVehicles) {
    footer = "\n\n(Showing *all vehicles*.)";
  } else if (vehicleLabel) {
    footer = `\n\n(Showing vehicle *${vehicleLabel}*.)`;
  }

  return (
    `${title}\n\n` +
    `• Last 30 days: *${monthTotal.toFixed(2)} KES*\n` +
    `• Last 7 days: *${weekTotal.toFixed(2)} KES*\n` +
    `• Last 24 hours: *${dayTotal.toFixed(2)} KES*\n\n` +
    efficiencyText +
    footer
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
  const vRes = await ensureCurrentVehicle(userWhatsapp);

  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one first with:\n" +
      "*add vehicle KDA 123A*\n\n" +
      "Then type *service* again."
    );
  }

  if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles. Please choose which one you want to log service for.\n\n" +
      listText +
      "\n\nReply with e.g. *switch to 1* or *switch to 2*, then type *service* again."
    );
  }

  const vehicle = vRes.vehicle;

  await pool.query(
    `
    INSERT INTO service_sessions (user_whatsapp, step, is_completed, vehicle_id)
    VALUES ($1, 'ASK_SERVICE_TITLE', FALSE, $2)
  `,
    [userWhatsapp, vehicle.id]
  );

  return (
    `🔧 Let’s log a *service* for *${vehicle.registration}*.\n` +
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
  const vehicleId = session.vehicle_id || null;

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
      notes,
      vehicle_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      vehicleId,
    ]
  );

  console.log("📝 Saved service log for:", session.user_whatsapp);
}

// NEW: per-vehicle / all-vehicles service report
async function buildServiceReport(userWhatsapp, options = {}) {
  const { vehicleId = null, vehicleLabel = null, allVehicles = false } = options;

  let title = "🔧 *Service Summary*";
  let where = "user_whatsapp = $1";
  const params = [userWhatsapp];

  if (!allVehicles && vehicleId) {
    title = `🔧 *Service Summary* – ${vehicleLabel || "this vehicle"}`;
    where += " AND vehicle_id = $2";
    params.push(vehicleId);
  } else if (!allVehicles) {
    title = "🔧 *Service Summary* (all vehicles)";
  } else {
    title = "🔧 *Service Summary* (all vehicles)";
  }

  const monthly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM service_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '30 days'
  `,
    params
  );

  const weekly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM service_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '7 days'
  `,
    params
  );

  const daily = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM service_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '1 day'
  `,
    params
  );

  const lastServices = await pool.query(
    `
    SELECT title, cost_numeric, odometer_numeric, created_at, notes
    FROM service_logs
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT 3
  `,
    params
  );

  const m = monthly.rows[0];
  const w = weekly.rows[0];
  const d = daily.rows[0];

  let text =
    `${title}\n\n` +
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
  } else {
    text += "\nLast few services:\n";

    for (const row of lastServices.rows) {
      const titleRow = row.title || "Service";
      const cost = Number(row.cost_numeric || 0).toFixed(2);
      const odo = row.odometer_numeric
        ? Number(row.odometer_numeric).toFixed(0) + " km"
        : "n/a";
      const dateStr = row.created_at
        ? new Date(row.created_at).toISOString().slice(0, 10)
        : "";
      text += `\n• *${titleRow}* – ${cost} KES, ${odo} on ${dateStr}`;
      if (row.notes) {
        text += ` (Notes: ${row.notes})`;
      }
    }
  }

  if (allVehicles) {
    text += "\n\n(Showing *all vehicles*.)";
  } else if (vehicleLabel) {
    text += `\n\n(Showing vehicle *${vehicleLabel}*.)`;
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
  const vRes = await ensureCurrentVehicle(userWhatsapp);

  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one first with:\n" +
      "*add vehicle KDA 123A*\n\n" +
      "Then type *expense* again."
    );
  }

  if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles. Please choose which one you want to log expenses for.\n\n" +
      listText +
      "\n\nReply with e.g. *switch to 1* or *switch to 2*, then type *expense* again."
    );
  }

  const vehicle = vRes.vehicle;

  await pool.query(
    `
    INSERT INTO expense_sessions (user_whatsapp, step, is_completed, vehicle_id)
    VALUES ($1, 'ASK_EXPENSE_TITLE', FALSE, $2)
  `,
    [userWhatsapp, vehicle.id]
  );

  return (
    `💸 Let’s log an *expense* for *${vehicle.registration}*.\n` +
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
  const vehicleId = session.vehicle_id || null;

  await pool.query(
    `
    INSERT INTO expense_logs (
      user_whatsapp,
      title,
      cost_numeric,
      odometer_numeric,
      vehicle_id
    )
    VALUES ($1, $2, $3, $4, $5)
  `,
    [session.user_whatsapp, title, cost, odometer, vehicleId]
  );

  console.log("📝 Saved expense log for:", session.user_whatsapp);
}

// NEW: per-vehicle / all-vehicles expense report
async function buildExpenseReport(userWhatsapp, options = {}) {
  const { vehicleId = null, vehicleLabel = null, allVehicles = false } = options;

  let title = "💸 *Expense Summary*";
  let where = "user_whatsapp = $1";
  const params = [userWhatsapp];

  if (!allVehicles && vehicleId) {
    title = `💸 *Expense Summary* – ${vehicleLabel || "this vehicle"}`;
    where += " AND vehicle_id = $2";
    params.push(vehicleId);
  } else if (!allVehicles) {
    title = "💸 *Expense Summary* (all vehicles)";
  } else {
    title = "💸 *Expense Summary* (all vehicles)";
  }

  const monthly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM expense_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '30 days'
  `,
    params
  );

  const weekly = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM expense_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '7 days'
  `,
    params
  );

  const daily = await pool.query(
    `
    SELECT 
      COALESCE(SUM(cost_numeric), 0) AS total,
      COUNT(*) AS count
    FROM expense_logs
    WHERE ${where}
      AND created_at >= NOW() - INTERVAL '1 day'
  `,
    params
  );

  const lastExpenses = await pool.query(
    `
    SELECT title, cost_numeric, odometer_numeric, created_at
    FROM expense_logs
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT 3
  `,
    params
  );

  const m = monthly.rows[0];
  const w = weekly.rows[0];
  const d = daily.rows[0];

  let text =
    `${title}\n\n` +
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
  } else {
    text += "\nLast few expenses:\n";

    for (const row of lastExpenses.rows) {
      const titleRow = row.title || "Expense";
      const cost = Number(row.cost_numeric || 0).toFixed(2);
      const odo = row.odometer_numeric
        ? Number(row.odometer_numeric).toFixed(0) + " km"
        : "n/a";
      const dateStr = row.created_at
        ? new Date(row.created_at).toISOString().slice(0, 10)
        : "";

      text += `\n• *${titleRow}* – ${cost} KES, ${odo} on ${dateStr}`;
    }
  }

  if (allVehicles) {
    text += "\n\n(Showing *all vehicles*.)";
  } else if (vehicleLabel) {
    text += `\n\n(Showing vehicle *${vehicleLabel}*.)`;
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

  // If user just typed "edit last service" (no field/value), show summary + instructions
  if (!rest) {
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
      const title = log.title || "Service";
      const cost = Number(log.cost_numeric || 0).toFixed(2);
      const odo = log.odometer_numeric
        ? Number(log.odometer_numeric).toFixed(0) + " km"
        : "n/a";
      const notes = log.notes || "none";

      return (
        "Your last *service* record:\n\n" +
        `• Service: *${title}*\n` +
        `• Cost: *${cost} KES*\n` +
        `• Odometer: *${odo}*\n` +
        `• Notes: *${notes}*\n\n` +
        "You can edit: *cost*, *odometer*, *title*, *notes*.\n" +
        "Examples:\n" +
        "• *edit last service cost 5000*\n" +
        "• *edit last service odometer 180000*\n" +
        "• *edit last service title Timing belt change*\n" +
        "• *edit last service notes Mechanic James 0700xxxxxx*"
      );
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
      const total = Number(log.total_cost_numeric || 0).toFixed(2);
      const price = log.price_per_liter_numeric
        ? Number(log.price_per_liter_numeric).toFixed(2)
        : "n/a";
      const odo = log.odometer
        ? Number(log.odometer).toFixed(0) + " km"
        : "n/a";
      const liters =
        log.liters && isFinite(log.liters)
          ? Number(log.liters).toFixed(2) + " L"
          : "n/a";

      return (
        "Your last *fuel* record:\n\n" +
        `• Total cost: *${total} KES*\n` +
        `• Price per liter: *${price} KES*\n` +
        `• Odometer: *${odo}*\n` +
        `• Liters (calculated): *${liters}*\n\n` +
        "You can edit: *cost* / *total*, *price*, *odometer*.\n" +
        "Examples:\n" +
        "• *edit last fuel cost 9000*\n" +
        "• *edit last fuel price 210*\n" +
        "• *edit last fuel odometer 123456*"
      );
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
      const title = log.title || "Expense";
      const cost = Number(log.cost_numeric || 0).toFixed(2);
      const odo = log.odometer_numeric
        ? Number(log.odometer_numeric).toFixed(0) + " km"
        : "n/a";

      return (
        "Your last *expense* record:\n\n" +
        `• Expense: *${title}*\n` +
        `• Cost: *${cost} KES*\n` +
        `• Odometer: *${odo}*\n\n` +
        "You can edit: *cost*, *odometer*, *title*.\n" +
        "Examples:\n" +
        "• *edit last expense cost 1500*\n" +
        "• *edit last expense title Parking*\n" +
        "• *edit last expense odometer 180500*"
      );
    }
  }

  const parts = rest.split(/\s+/);
  const fieldWord = parts[0].toLowerCase();
  const newValueRaw = parts.slice(1).join(" ").trim();

  if (!newValueRaw) {
    return "Please provide a new value after the field. Example: *edit last service cost 5000*.";
  }

  // ------- SERVICE EDIT -------
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

    const setParts = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updates)) {
      setParts.push(`${k} = $${idx}`);
      values.push(v);
      idx++;
    }
    setParts.push(`updated_at = NOW()`);
    const query = `
      UPDATE service_logs
      SET ${setParts.join(", ")}
      WHERE id = $${idx}
    `;
    values.push(log.id);
    await pool.query(query, values);

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
      summary += `\n\nChanged: *${changedFieldText}* from *${oldValueText}* to *${newValueText}*.\n`;
    }

    return summary;
  }

  // ------- FUEL EDIT -------
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
      summary += `\n\nChanged: *${changedFieldText}* from *${oldValueText}* to *${newValueText}*.\n`;
    }

    return summary;
  }

  // ------- EXPENSE EDIT -------
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
    setParts.push(`updated_at = NOW()`);
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
      summary += `\n\nChanged: *${changedFieldText}* from *${oldValueText}* to *${newValueText}*.\n`;
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
    // VEHICLE COMMANDS
    else if (lower.startsWith("add vehicle")) {
      replyText = await handleAddVehicleCommand(from, text);
    } else if (lower === "my vehicles") {
      replyText = await handleMyVehiclesCommand(from);
    } else if (lower.startsWith("switch")) {
      replyText = await handleSwitchVehicleCommand(from, text);
    }
    // GLOBAL COMMAND: simple "edit" helper
    else if (lower === "edit") {
      replyText =
        "To edit a record, choose one of these:\n\n" +
        "• *edit last service* – edit your last service\n" +
        "• *edit last fuel* – edit your last fuel\n" +
        "• *edit last expense* – edit your last expense\n\n" +
        "After that, you can change a field, e.g.:\n" +
        "• *edit last service cost 5000*\n" +
        "• *edit last fuel price 210*";
    }
    // GLOBAL COMMAND: simple "delete" helper
    else if (lower === "delete") {
      replyText =
        "To delete your last record, choose one of:\n\n" +
        "• *delete last fuel*\n" +
        "• *delete last service*\n" +
        "• *delete last expense*";
    }
    // GLOBAL COMMAND: delete last ...
    else if (lower.startsWith("delete last")) {
      replyText = await handleDeleteLastCommand(from, lower);
    }
    // GLOBAL COMMAND: edit last ...
    else if (lower.startsWith("edit last")) {
      replyText = await handleEditLastCommand(from, text);
    }
    // REPORT COMMANDS: high-level guidance
    else if (lower === "report" || lower.startsWith("report ")) {
      replyText =
        "I can show quick summaries for your vehicle data:\n\n" +
        "• *fuel report* – fuel spend & efficiency\n" +
        "• *fuel report all* – all vehicles\n" +
        "• *service report* – service spend\n" +
        "• *service report all* – all vehicles\n" +
        "• *expense report* – other expenses\n" +
        "• *expense report all* – all vehicles\n\n" +
        "Please choose one of those.";
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
      } else if (lower === "fuel report" || lower.startsWith("fuel report")) {
        // fuel report / fuel report all
        const wantsAll = lower.includes("all");
        if (wantsAll) {
          replyText = await buildFuelReport(from, { allVehicles: true });
        } else {
          const vRes = await ensureCurrentVehicle(from);
          if (vRes.status === "NO_VEHICLES") {
            replyText =
              "You don't have any vehicles yet.\n\n" +
              "Add one with: *add vehicle KDA 123A*";
          } else if (vRes.status === "NEED_SET_CURRENT") {
            const listText = formatVehiclesList(vRes.list, true);
            replyText =
              "You have multiple vehicles. Please choose which one you want the report for.\n\n" +
              listText +
              "\n\nReply with e.g. *switch to 1*, then send *fuel report* again.";
          } else {
            const vehicle = vRes.vehicle;
            replyText = await buildFuelReport(from, {
              vehicleId: vehicle.id,
              vehicleLabel: vehicle.registration,
            });
          }
        }
      } else if (lower === "service") {
        replyText = await startServiceSession(from);
      } else if (
        lower === "service report" ||
        lower.startsWith("service report")
      ) {
        const wantsAll = lower.includes("all");
        if (wantsAll) {
          replyText = await buildServiceReport(from, { allVehicles: true });
        } else {
          const vRes = await ensureCurrentVehicle(from);
          if (vRes.status === "NO_VEHICLES") {
            replyText =
              "You don't have any vehicles yet.\n\n" +
              "Add one with: *add vehicle KDA 123A*";
          } else if (vRes.status === "NEED_SET_CURRENT") {
            const listText = formatVehiclesList(vRes.list, true);
            replyText =
              "You have multiple vehicles. Please choose which one you want the report for.\n\n" +
              listText +
              "\n\nReply with e.g. *switch to 1*, then send *service report* again.";
          } else {
            const vehicle = vRes.vehicle;
            replyText = await buildServiceReport(from, {
              vehicleId: vehicle.id,
              vehicleLabel: vehicle.registration,
            });
          }
        }
      } else if (lower === "expense" || lower === "expenses") {
        replyText = await startExpenseSession(from);
      } else if (
        lower === "expense report" ||
        lower === "expenses report" ||
        lower.startsWith("expense report") ||
        lower.startsWith("expenses report")
      ) {
        const wantsAll = lower.includes("all");
        if (wantsAll) {
          replyText = await buildExpenseReport(from, { allVehicles: true });
        } else {
          const vRes = await ensureCurrentVehicle(from);
          if (vRes.status === "NO_VEHICLES") {
            replyText =
              "You don't have any vehicles yet.\n\n" +
              "Add one with: *add vehicle KDA 123A*";
          } else if (vRes.status === "NEED_SET_CURRENT") {
            const listText = formatVehiclesList(vRes.list, true);
            replyText =
              "You have multiple vehicles. Please choose which one you want the report for.\n\n" +
              listText +
              "\n\nReply with e.g. *switch to 1*, then send *expense report* again.";
          } else {
            const vehicle = vRes.vehicle;
            replyText = await buildExpenseReport(from, {
              vehicleId: vehicle.id,
              vehicleLabel: vehicle.registration,
            });
          }
        }
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

    // Get vehicle registration if possible
    let vehicleText = "";
    if (updatedSession.vehicle_id) {
      const vRes = await pool.query(
        "SELECT registration FROM vehicles WHERE id = $1",
        [updatedSession.vehicle_id]
      );
      if (vRes.rows.length > 0) {
        vehicleText = `Vehicle: *${vRes.rows[0].registration}*\n`;
      }
    }

    let summary =
      "✅ Fuel log saved.\n\n" +
      (vehicleText ? vehicleText : "") +
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

      // vehicle text
      let vehicleText = "";
      if (updatedSession.vehicle_id) {
        const vRes = await pool.query(
          "SELECT registration FROM vehicles WHERE id = $1",
          [updatedSession.vehicle_id]
        );
        if (vRes.rows.length > 0) {
          vehicleText = `Vehicle: *${vRes.rows[0].registration}*\n`;
        }
      }

      let summary =
        "✅ Service log saved with *no reminder*.\n\n" +
        (vehicleText ? vehicleText : "") +
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

    let vehicleText = "";
    if (updatedSession.vehicle_id) {
      const vRes = await pool.query(
        "SELECT registration FROM vehicles WHERE id = $1",
        [updatedSession.vehicle_id]
      );
      if (vRes.rows.length > 0) {
        vehicleText = `Vehicle: *${vRes.rows[0].registration}*\n`;
      }
    }

    let summary =
      "✅ Service log saved with *date reminder*.\n\n" +
      (vehicleText ? vehicleText : "") +
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

    let vehicleText = "";
    if (updatedSession.vehicle_id) {
      const vRes = await pool.query(
        "SELECT registration FROM vehicles WHERE id = $1",
        [updatedSession.vehicle_id]
      );
      if (vRes.rows.length > 0) {
        vehicleText = `Vehicle: *${vRes.rows[0].registration}*\n`;
      }
    }

    let summary =
      "✅ Service log saved with *mileage reminder*.\n\n" +
      (vehicleText ? vehicleText : "") +
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

    let vehicleText = "";
    if (updatedSession.vehicle_id) {
      const vRes = await pool.query(
        "SELECT registration FROM vehicles WHERE id = $1",
        [updatedSession.vehicle_id]
      );
      if (vRes.rows.length > 0) {
        vehicleText = `Vehicle: *${vRes.rows[0].registration}*\n`;
      }
    }

    return (
      "✅ Expense log saved.\n\n" +
      (vehicleText ? vehicleText : "") +
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
