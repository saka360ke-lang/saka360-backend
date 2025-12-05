// index.js
// Saka360 Backend – WhatsApp → (Cars / Fuel / Service / Documents / Expense / Drivers / n8n AI) → DB → WhatsApp

// Optional local .env (Render overrides with dashboard env vars)
try {
  require("dotenv").config();
} catch (e) {
  // ignore if dotenv not available
}

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
  console.log("Using N8N_WEBHOOK_URL:", JSON.stringify(N8N_WEBHOOK_URL));
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

// Ensure chat_turns table exists for memory
async function ensureChatTurnsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_turns (
        id SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("🧠 chat_turns table is ready.");
  } catch (err) {
    console.error("❌ Error ensuring chat_turns table:", err.message);
  }
}
ensureChatTurnsTable();

// Ensure vehicle doc tables (idempotent + add missing columns)
async function ensureVehicleDocumentTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_documents (
        id              SERIAL PRIMARY KEY,
        vehicle_id      INTEGER NOT NULL,
        title           TEXT,
        cost            NUMERIC,
        expiry_date     DATE,
        notes           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE vehicle_documents
        ADD COLUMN IF NOT EXISTS vehicle_id INTEGER,
        ADD COLUMN IF NOT EXISTS title TEXT,
        ADD COLUMN IF NOT EXISTS cost NUMERIC,
        ADD COLUMN IF NOT EXISTS expiry_date DATE,
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_document_sessions (
        id              SERIAL PRIMARY KEY,
        user_whatsapp   TEXT NOT NULL,
        vehicle_id      INTEGER NOT NULL,
        step            TEXT NOT NULL,
        title           TEXT,
        cost            NUMERIC,
        expiry_date     DATE,
        notes           TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE vehicle_document_sessions
        ADD COLUMN IF NOT EXISTS user_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id INTEGER,
        ADD COLUMN IF NOT EXISTS step TEXT,
        ADD COLUMN IF NOT EXISTS title TEXT,
        ADD COLUMN IF NOT EXISTS cost NUMERIC,
        ADD COLUMN IF NOT EXISTS expiry_date DATE,
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    console.log("📄 vehicle_documents & vehicle_document_sessions tables are ready.");
  } catch (err) {
    console.error("❌ Error ensuring vehicle document tables:", err.message);
  }
}
ensureVehicleDocumentTables();

// Ensure personal_documents & personal_document_sessions tables
async function ensurePersonalDocumentsTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS personal_documents (
        id              SERIAL PRIMARY KEY,
        owner_whatsapp  TEXT NOT NULL,
        driver_whatsapp TEXT NOT NULL,
        driver_id       INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
        doc_title       TEXT NOT NULL,
        doc_type        TEXT,
        cost_amount     NUMERIC(12,2),
        currency        TEXT NOT NULL DEFAULT 'KES',
        expiry_date     DATE,
        notes           TEXT,
        reminder_id     INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS personal_document_sessions (
        id              SERIAL PRIMARY KEY,
        user_whatsapp   TEXT NOT NULL,
        step            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'ACTIVE',
        doc_title       TEXT,
        doc_type        TEXT,
        cost_amount     NUMERIC(12,2),
        expiry_date     DATE,
        notes           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("📄 personal_documents & personal_document_sessions tables are ready.");
  } catch (err) {
    console.error("❌ Error ensuring personal_documents tables:", err.message);
  }
}
ensurePersonalDocumentsTables();

// Ensure expense tables (logs + sessions)
async function ensureExpenseTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expense_logs (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER NOT NULL,
        driver_id     INTEGER,
        title         TEXT,
        amount        NUMERIC,
        odometer      INTEGER,
        notes         TEXT,
        message_text  TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expense_sessions (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER NOT NULL,
        step          TEXT NOT NULL,
        title         TEXT,
        amount        NUMERIC,
        odometer      INTEGER,
        notes         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("💸 expense_logs & expense_sessions tables are ready.");
  } catch (err) {
    console.error("❌ Error ensuring expense tables:", err.message);
  }
}
ensureExpenseTables();

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

// ====== DRIVER HELPERS ======

async function getUserDrivers(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM drivers
    WHERE owner_whatsapp = $1
      AND is_active = TRUE
    ORDER BY created_at ASC
  `,
    [userWhatsapp]
  );
  return res.rows;
}

function formatDriversList(drivers, withIndices = true) {
  if (!drivers || drivers.length === 0) {
    return "You don't have any drivers yet.";
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let text = "";
  drivers.forEach((d, index) => {
    const idx = index + 1;
    const name = d.full_name || "Driver";
    const licType = d.license_type || "n/a";
    const expDate = d.license_expiry_date
      ? new Date(d.license_expiry_date)
      : null;

    let statusIcon = "✅";
    let statusText = "";

    if (expDate) {
      expDate.setHours(0, 0, 0, 0);
      const diffDays = Math.round(
        (expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (diffDays < 0) {
        statusIcon = "❌";
        statusText = `licence expired ${Math.abs(diffDays)} day(s) ago`;
      } else if (diffDays <= 30) {
        statusIcon = "⚠️";
        statusText = `licence expires in ${diffDays} day(s)`;
      } else {
        statusIcon = "✅";
        statusText = `licence valid, ~${diffDays} day(s) left`;
      }
    } else {
      statusIcon = "⚠️";
      statusText = "no licence expiry date set";
    }

    const expStr = d.license_expiry_date
      ? String(d.license_expiry_date).slice(0, 10)
      : "n/a";

    const baseLine =
      `*${name}* – Type: *${licType}* (exp: ${expStr}) ` +
      `${statusIcon} ${statusText}`;

    if (withIndices) {
      text += `\n${idx}. ${baseLine}`;
    } else {
      text += `\n• ${baseLine}`;
    }
  });

  return text.trim();
}
// ADD DRIVER (owner → invite)
async function handleAddDriverCommand(ownerWhatsapp, fullText) {
  const base = "add driver";
  const lower = fullText.toLowerCase().trim();

  if (lower === base) {
    return (
      "Let's add a driver to your Saka360 account 👨‍✈️\n\n" +
      "Please send the details in *one line* using this format:\n" +
      "*add driver Full Name | 07XXXXXXXX*\n\n" +
      "Example:\n" +
      "*add driver David Njonjo | 0734852529*\n\n" +
      "After this, the driver will get a WhatsApp prompt to *accept* and add their *Main Driving Licence*."
    );
  }

  const detailsRaw = fullText.slice(base.length).trim();
  if (!detailsRaw) {
    return (
      "Please include the driver details after *add driver*.\n\n" +
      "Format:\n" +
      "*add driver Full Name | 07XXXXXXXX*\n\n" +
      "Example:\n" +
      "*add driver David Njonjo | 0734852529*"
    );
  }

  let parts = detailsRaw.split("|");
  if (parts.length === 1) {
    parts = detailsRaw.split(",");
  }
  parts = parts.map((p) => p.trim()).filter(Boolean);

  if (parts.length < 2) {
    return (
      "I need at least: *Name* and *Phone number*.\n\n" +
      "Format:\n" +
      "*add driver Full Name | 07XXXXXXXX*"
    );
  }

  const fullName = parts[0];
  const rawPhone = parts[1];

  if (!fullName) {
    return "Please provide the driver's *full name* as the first item.";
  }
  if (!rawPhone) {
    return "Please provide the driver's *phone number* as the second item (e.g. 07XXXXXXXX).";
  }

  function toWhatsAppNumber(phone) {
    const trimmed = phone.trim();
    if (trimmed.startsWith("whatsapp:")) return trimmed;
    if (trimmed.startsWith("+")) return `whatsapp:${trimmed}`;

    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 10 && digits.startsWith("0")) {
      return `whatsapp:+254${digits.slice(1)}`;
    }
    if (digits.length === 12 && digits.startsWith("254")) {
      return `whatsapp:+${digits}`;
    }
    return `whatsapp:+${digits}`;
  }

  const driverWhatsapp = toWhatsAppNumber(rawPhone);

  const existing = await pool.query(
    `
    SELECT id
    FROM drivers
    WHERE owner_whatsapp = $1
      AND driver_whatsapp = $2
      AND is_active = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `,
    [ownerWhatsapp, driverWhatsapp]
  );

  let driverRow;
  if (existing.rows.length > 0) {
    const driverId = existing.rows[0].id;
    const resUpdate = await pool.query(
      `
      UPDATE drivers
      SET full_name = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
      [fullName, driverId]
    );
    driverRow = resUpdate.rows[0];
  } else {
    const resInsert = await pool.query(
      `
      INSERT INTO drivers (
        owner_whatsapp,
        full_name,
        driver_whatsapp,
        license_type,
        license_expiry_date,
        is_active
      )
      VALUES ($1, $2, $3, NULL, NULL, TRUE)
      RETURNING *
    `,
      [ownerWhatsapp, fullName, driverWhatsapp]
    );
    driverRow = resInsert.rows[0];
  }

  try {
    if (DISABLE_TWILIO_SEND === "true") {
      console.log("🚫 Twilio send disabled, would invite driver:", {
        driverWhatsapp,
        fullName,
        ownerWhatsapp,
      });
    } else {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: driverWhatsapp,
        body:
          "Hi " +
          fullName +
          " 👋\n\n" +
          "You’ve been added as a driver in *Saka360* by *" +
          ownerWhatsapp +
          "*.\n\n" +
          "To accept and complete your driving licence compliance, reply here with:\n" +
          "*accept*\n\n" +
          "After you add your *Main Driving Licence* expiry date, you’ll be allowed to log *fuel*, *service* and *expenses* for vehicles assigned to you.",
      });
    }
  } catch (err) {
    console.error(
      "❌ Error sending driver invite WhatsApp message:",
      err.message
    );
  }

  return (
    "✅ Driver *" +
    fullName +
    "* added.\n\n" +
    "Invitation sent to: *" +
    driverWhatsapp.replace("whatsapp:", "") +
    "*\n\n" +
    "They must:\n" +
    "1️⃣ Reply *accept* from their WhatsApp (" +
    driverWhatsapp.replace("whatsapp:", "") +
    ")\n" +
    "2️⃣ Add their *Main Driving Licence* expiry with:\n" +
    "   *dl main 2026-01-01*\n\n" +
    "Once they add a valid Main DL, you’ll get a compliance notification and they’ll appear as *compliant* in your *driver report*."
  );
}

// DRIVER SIDE: accept invitation
async function handleDriverAccept(driverWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM drivers
    WHERE driver_whatsapp = $1
      AND is_active = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `,
    [driverWhatsapp]
  );

  if (res.rows.length === 0) {
    return (
      "I can't find any pending driver invitation for this WhatsApp number.\n\n" +
      "Ask your fleet owner to add you with:\n" +
      "*add driver Your Name | 07XXXXXXXX*"
    );
  }

  const driver = res.rows[0];
  const name = driver.full_name || "Driver";

  const hasMain =
    driver.license_type &&
    driver.license_type.toLowerCase().includes("main") &&
    driver.license_expiry_date;

  if (hasMain) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expDate = new Date(driver.license_expiry_date);
    expDate.setHours(0, 0, 0, 0);

    if (expDate.getTime() >= today.getTime()) {
      return (
        "Hi " +
        name +
        " 👋\n\n" +
        "You’re already *compliant* with a valid Main Driving Licence on file.\n\n" +
        "You can now log *fuel*, *service* and *expenses* for vehicles assigned to you (once your fleet owner connects your profile)."
      );
    }
  }

  return (
    "Hi " +
    name +
    " 👋\n\n" +
    "To complete your licence compliance, please send your *Main Driving Licence* expiry date.\n\n" +
    "Use this format:\n" +
    "*dl main 2026-01-01*\n\n" +
    "You must have a *valid Main DL* on Saka360 before you can log *fuel*, *service* or *expenses*."
  );
}

// DRIVER HELPER: find driver by WhatsApp
async function findDriverByWhatsapp(driverWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM drivers
    WHERE driver_whatsapp = $1
      AND is_active = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `,
    [driverWhatsapp]
  );
  return res.rows[0] || null;
}

/**
 * DRIVER: see my own licence status
 */
async function handleMyOwnLicenceStatus(driverWhatsapp) {
  const driver = await findDriverByWhatsapp(driverWhatsapp);

  if (!driver) {
    return (
      "I cannot find a driver profile linked to this WhatsApp number.\n\n" +
      "Ask your fleet owner to add you with:\n" +
      "*add driver Your Name | 07XXXXXXXX*"
    );
  }

  const name = driver.full_name || "Driver";
  const licType = driver.license_type || "not set";
  const expRaw = driver.license_expiry_date
    ? String(driver.license_expiry_date).slice(0, 10)
    : null;

  if (!licType || !expRaw) {
    return (
      "Hi " +
      name +
      " 👋\n\n" +
      "You do not have a *Main Driving Licence* expiry date on Saka360 yet.\n\n" +
      "To become compliant, send:\n" +
      "*dl main 2026-01-01*  (use your real expiry date)\n\n" +
      "After that your fleet owner can safely assign cars to you."
    );
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expDate = new Date(expRaw);
  expDate.setHours(0, 0, 0, 0);

  const diffDays = Math.round(
    (expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  let statusLine = "";
  let icon = "✅";

  if (diffDays < 0) {
    icon = "❌";
    statusLine = "Your licence *expired* " + Math.abs(diffDays) + " day(s) ago.";
  } else if (diffDays <= 30) {
    icon = "⚠️";
    statusLine =
      "Your licence is *expiring soon* in " + diffDays + " day(s).";
  } else {
    icon = "✅";
    statusLine =
      "Your licence is *valid* with about " + diffDays + " day(s) left.";
  }

  return (
    icon +
    " *Your licence status*\n\n" +
    "Name: *" +
    name +
    "*\n" +
    "Licence type: *" +
    licType +
    "*\n" +
    "Expiry date: *" +
    expRaw +
    "*\n\n" +
    statusLine +
    "\n\n" +
    "If this looks wrong, ask your fleet owner to review your details in Saka360."
  );
}

// DRIVER SIDE: add main driving licence
async function handleDriverLicenceCommand(driverWhatsapp, fullText) {
  const lower = fullText.toLowerCase().trim();

  const match = lower.match(/^dl\s+(\w+)\s+(\d{4}-\d{2}-\d{2})$/i);
  if (!match) {
    return (
      "To set your Main Driving Licence expiry, use:\n\n" +
      "*dl main 2026-01-01*\n\n" +
      "Example:\n" +
      "*dl main 2027-06-30*"
    );
  }

  const typeWord = match[1];
  const expiryText = match[2];

  if (typeWord !== "main") {
    return (
      "Right now Saka360 only tracks your *Main Driving Licence* for compliance.\n\n" +
      "Please send it as:\n" +
      "*dl main 2026-01-01*"
    );
  }

  const expDate = new Date(expiryText);
  if (isNaN(expDate.getTime())) {
    return "That expiry date doesn't look valid. Please use *YYYY-MM-DD* format (e.g. 2026-01-01).";
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expDate.setHours(0, 0, 0, 0);

  if (expDate.getTime() <= today.getTime()) {
    return (
      "Your *Main DL* must be *valid* for compliance (expiry must be in the future).\n\n" +
      "Please send a future date in *YYYY-MM-DD* format."
    );
  }

  const res = await pool.query(
    `
    SELECT *
    FROM drivers
    WHERE driver_whatsapp = $1
      AND is_active = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `,
    [driverWhatsapp]
  );

  if (res.rows.length === 0) {
    return (
      "I can't find any driver profile linked to this WhatsApp number.\n\n" +
      "Ask your fleet owner to add you with:\n" +
      "*add driver Your Name | 07XXXXXXXX*"
    );
  }

  const driver = res.rows[0];

  if (
    driver.license_type &&
    driver.license_type.toLowerCase().includes("main") &&
    driver.license_expiry_date
  ) {
    return (
      "Your *Main Driving Licence* is already on file and locked.\n\n" +
      "If it needs to be changed, ask your fleet owner or admin to update it from their side."
    );
  }

  const updatedRes = await pool.query(
    `
    UPDATE drivers
    SET license_type = $1,
        license_expiry_date = $2,
        updated_at = NOW()
    WHERE id = $3
    RETURNING *
  `,
    ["main licence", expiryText, driver.id]
  );

  const updated = updatedRes.rows[0];
  const name = updated.full_name || "Driver";

  const ownerWhatsapp = updated.owner_whatsapp;
  if (ownerWhatsapp) {
    try {
      if (DISABLE_TWILIO_SEND === "true") {
        console.log("🚫 Twilio send disabled, would notify owner:", {
          ownerWhatsapp,
          name,
          expiryText,
        });
      } else {
        await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_NUMBER,
          to: ownerWhatsapp,
          body:
            "✅ *Driver compliance update*\n\n" +
            "Driver: *" +
            name +
            "*\n" +
            "Main DL expiry: *" +
            expiryText +
            "*\n\n" +
            "This driver is now *Main DL compliant* and can be allowed to log *fuel*, *service* and *expenses* for vehicles you assign.",
        });
      }
    } catch (err) {
      console.error(
        "❌ Error sending compliance notification to owner:",
        err.message
      );
    }
  }

  return (
    "✅ Thanks " +
    name +
    ".\n\n" +
    "Your *Main Driving Licence* expiry has been set to *" +
    expiryText +
    "*.\n\n" +
    "You are now *licence compliant* on Saka360.\n" +
    "Your fleet owner can assign vehicles to you for logging *fuel*, *service* and *expenses*."
  );
}

async function handleMyDriversCommand(userWhatsapp) {
  const drivers = await getUserDrivers(userWhatsapp);
  if (drivers.length === 0) {
    return (
      "You don't have any drivers yet.\n\n" +
      "Add one with:\n" +
      "*add driver John Doe | 0712345678*"
    );
  }

  let text = "👨‍✈️ *Your drivers*:\n\n";
  text += formatDriversList(drivers, true);
  text +=
    "\n\nTo assign a driver to your *current vehicle*, reply with e.g. *assign driver 1*.";

  return text;
}

// Assign driver to CURRENT vehicle
async function handleAssignDriverCommand(userWhatsapp, fullText) {
  const match = fullText.match(/assign\s+driver\s+(\d+)/i);
  if (!match) {
    return (
      "To assign a driver, first see your drivers with *my drivers*.\n\n" +
      "Then reply with e.g. *assign driver 1* to assign driver 1 to your *current vehicle*."
    );
  }

  const index = parseInt(match[1], 10);
  if (!index || index < 1) {
    return "I couldn't understand that driver number. Please use a positive number like *1* or *2*.";
  }

  const vRes = await ensureCurrentVehicle(userWhatsapp);
  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with: *add vehicle KDA 123A*"
    );
  } else if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles. Please choose which one you want to set a driver for.\n\n" +
      listText +
      "\n\nReply with e.g. *switch to 1*, then send *assign driver 1* again."
    );
  }

  const vehicle = vRes.vehicle;

  const drivers = await getUserDrivers(userWhatsapp);
  if (drivers.length === 0) {
    return (
      "You don't have any drivers yet.\n\n" +
      "Add one with:\n" +
      "*add driver John Doe | 0712345678*"
    );
  }

  if (index > drivers.length) {
    return (
      "You only have *" +
      drivers.length +
      "* driver(s).\n\n" +
      "See them with *my drivers* and choose a valid number."
    );
  }

  const chosen = drivers[index - 1];

  await pool.query(
    `
    UPDATE vehicles
    SET driver_id = $1,
        updated_at = NOW()
    WHERE id = $2
  `,
    [chosen.id, vehicle.id]
  );

  const name = chosen.full_name || "Driver";
  const licType = chosen.license_type || "n/a";
  const exp = chosen.license_expiry_date
    ? String(chosen.license_expiry_date).slice(0, 10)
    : "n/a";

  return (
    "✅ Driver assigned.\n\n" +
    "Vehicle: *" +
    vehicle.registration +
    "*\n" +
    "Driver: *" +
    name +
    "*\n" +
    "Licence type: *" +
    licType +
    "* (exp: " +
    exp +
    ")\n\n" +
    "You can change driver any time with another *assign driver X*."
  );
}

// Driver licence compliance / report
async function buildDriverComplianceReport(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT id, full_name, license_type, license_expiry_date, driver_whatsapp, is_active
    FROM drivers
    WHERE owner_whatsapp = $1
      AND is_active = TRUE
    ORDER BY license_expiry_date ASC
  `,
    [userWhatsapp]
  );

  const drivers = res.rows;
  if (drivers.length === 0) {
    return (
      "You don't have any drivers yet.\n\n" +
      "Add one with:\n" +
      "*add driver John Doe | 0712345678*"
    );
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expired = [];
  const expiring = [];
  const ok = [];

  for (const d of drivers) {
    if (!d.license_expiry_date) {
      expired.push({ driver: d, diffDays: null });
      continue;
    }
    const expDate = new Date(d.license_expiry_date);
    expDate.setHours(0, 0, 0, 0);

    const diffDays = Math.round(
      (expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (diffDays < 0) {
      expired.push({ driver: d, diffDays });
    } else if (diffDays <= 30) {
      expiring.push({ driver: d, diffDays });
    } else {
      ok.push({ driver: d, diffDays });
    }
  }

  let text = "🚦 *Driver licence compliance overview*\n";

  if (expired.length > 0) {
    text += "\n❌ *Expired licences*:\n";
    for (const item of expired) {
      const d = item.driver;
      const name = d.full_name || "Driver";
      const licType = d.license_type || "n/a";
      const exp = d.license_expiry_date
        ? String(d.license_expiry_date).slice(0, 10)
        : "n/a";
      const days = item.diffDays !== null ? Math.abs(item.diffDays) : "?";
      const phone = d.driver_whatsapp || "no phone on file";
      text +=
        "\n• *" +
        name +
        "* – Type: *" +
        licType +
        "*, exp: " +
        exp +
        " (expired " +
        days +
        " day(s) ago) – " +
        phone;
    }
  } else {
    text += "\n❌ *Expired licences*: none 🎉";
  }

  if (expiring.length > 0) {
    text += "\n\n⚠️ *Expiring in next 30 days*:\n";
    for (const item of expiring) {
      const d = item.driver;
      const name = d.full_name || "Driver";
      const licType = d.license_type || "n/a";
      const exp = d.license_expiry_date
        ? String(d.license_expiry_date).slice(0, 10)
        : "n/a";
      const days = item.diffDays;
      const phone = d.driver_whatsapp || "no phone on file";
      text +=
        "\n• *" +
        name +
        "* – Type: *" +
        licType +
        "*, exp: " +
        exp +
        " (in " +
        days +
        " day(s)) – " +
        phone;
    }
  } else {
    text += "\n\n⚠️ *Expiring soon (30 days)*: none.";
  }

  if (ok.length > 0) {
    text += "\n\n✅ *Valid (>30 days left)*:\n";
    for (const item of ok) {
      const d = item.driver;
      const name = d.full_name || "Driver";
      const licType = d.license_type || "n/a";
      const exp = d.license_expiry_date
        ? String(d.license_expiry_date).slice(0, 10)
        : "n/a";
      const days = item.diffDays;
      const phone = d.driver_whatsapp || "no phone on file";
      text +=
        "\n• *" +
        name +
        "* – Type: *" +
        licType +
        "*, exp: " +
        exp +
        " (~" +
        days +
        " day(s) left) – " +
        phone;
    }
  } else {
    text += "\n\n✅ *Valid licences*: none yet.";
  }

  text +=
    "\n\nYou can add drivers with *add driver ...* and assign them with *assign driver X*.\n" +
    "Drivers must reply *accept* then *dl main YYYY-MM-DD* to be Main DL compliant.";

  return text;
}

// ====== FUEL SESSION HELPERS ======

async function getActiveFuelSession(userWhatsapp) {
  try {
    const res = await pool.query(
      `
      SELECT *
      FROM fuel_sessions
      WHERE user_whatsapp = $1
        AND step NOT IN ('completed', 'cancelled', 'error')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [userWhatsapp]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error("❌ Error fetching fuel_session:", err.message);
    return null;
  }
}

async function saveFuelSession(session) {
  try {
    await pool.query(
      `
      UPDATE fuel_sessions
      SET
        step = $2,
        total_cost = $3,
        price_per_litre = $4,
        litres = $5,
        station = $6,
        odometer = $7,
        notes = $8,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        session.id,
        session.step,
        session.total_cost != null ? session.total_cost : null,
        session.price_per_litre != null ? session.price_per_litre : null,
        session.litres != null ? session.litres : null,
        session.station || null,
        session.odometer != null ? session.odometer : null,
        session.notes || null,
      ]
    );
  } catch (err) {
    console.error("❌ Error saving fuel_session:", err.message);
  }
}

async function startFuelSession(userWhatsapp) {
  const vRes = await ensureCurrentVehicle(userWhatsapp);

  if (vRes.status === "NO_VEHICLES") {
    return {
      session: null,
      reply:
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*",
    };
  }

  if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return {
      session: null,
      reply:
        "You have multiple vehicles. Please choose which one you want to log fuel for.\n\n" +
        listText +
        "\n\nReply with e.g. *switch to 1*, then send *fuel* again.",
    };
  }

  const vehicle = vRes.vehicle;

  const insert = await pool.query(
    `
    INSERT INTO fuel_sessions (
      user_whatsapp,
      vehicle_id,
      step
    )
    VALUES ($1, $2, 'ask_total')
    RETURNING *
    `,
    [userWhatsapp, vehicle.id]
  );

  const session = insert.rows[0];

  const reply =
    "⛽ Let's log fuel for *" +
    vehicle.registration +
    "*.\n\n" +
    "How much did you pay in *total* for this refuel? (KES)\n" +
    "Example: *5400*";

  return { session, reply };
}

async function handleFuelSessionStep(session, incomingText) {
  const text = String(incomingText || "").trim();
  const lower = text.toLowerCase();

  if (["cancel", "stop", "reset"].includes(lower)) {
    session.step = "cancelled";
    await saveFuelSession(session);
    return (
      "✅ I’ve cancelled your fuel entry.\n" +
      "You can start again with *fuel*."
    );
  }

  let vehicleReg = "this vehicle";
  let driverId = null;
  try {
    const vRes = await pool.query(
      `SELECT registration, driver_id FROM vehicles WHERE id = $1`,
      [session.vehicle_id]
    );
    if (vRes.rows[0]) {
      if (vRes.rows[0].registration) {
        vehicleReg = vRes.rows[0].registration;
      }
      if (vRes.rows[0].driver_id) {
        driverId = vRes.rows[0].driver_id;
      }
    }
  } catch (err) {
    console.error("⚠️ Error fetching vehicle for fuel session:", err.message);
  }

  if (session.step === "ask_total") {
    const amount = parseNumber(text);
    if (isNaN(amount) || amount <= 0) {
      return "That amount doesn't look valid. Please send the *total fuel cost* in KES (e.g. *5400*).";
    }

    session.total_cost = amount;
    session.step = "ask_price";
    await saveFuelSession(session);

    return "What was the *price per litre*? (KES)\nExample: *180*";
  }

  if (session.step === "ask_price") {
    const price = parseNumber(text);
    if (isNaN(price) || price <= 0) {
      return "That price doesn't look valid. Please send the *price per litre* in KES (e.g. *180*).";
    }

    session.price_per_litre = price;
    if (session.total_cost != null && price > 0) {
      const litres = session.total_cost / price;
      session.litres = parseFloat(litres.toFixed(2));
    }

    session.step = "ask_station";
    await saveFuelSession(session);

    return (
      "Which station did you fuel at?\n" +
      "Example: *Shell Ngong Road*.\n" +
      "Reply *skip* to leave this blank."
    );
  }

  if (session.step === "ask_station") {
    if (lower === "skip") {
      session.station = null;
    } else {
      session.station = text;
    }

    session.step = "ask_odo";
    await saveFuelSession(session);

    return (
      "What was the *odometer reading* after this refuel?\n" +
      "Example: *123456*"
    );
  }

  if (session.step === "ask_odo") {
    const odoNum = parseNumber(text);
    if (isNaN(odoNum) || odoNum < 0) {
      return "That odometer value doesn't look valid. Please send a number like *123456*.";
    }

    session.odometer = Math.round(odoNum);
    session.step = "ask_notes";
    await saveFuelSession(session);

    return (
      "Any notes about this refuel?\n" +
      "Example: *full tank, Nairobi–Nakuru trip*.\n" +
      "Reply *skip* to leave notes blank."
    );
  }

  if (session.step === "ask_notes") {
    if (lower === "skip") {
      session.notes = null;
    } else {
      session.notes = text;
    }

    session.step = "confirm";
    await saveFuelSession(session);

    const totalStr =
      session.total_cost != null ? `*${session.total_cost}* KES` : "_not set_";
    const priceStr =
      session.price_per_litre != null
        ? `*${session.price_per_litre}* KES/L`
        : "_not set_";
    const litresStr =
      session.litres != null ? `*${session.litres}* L` : "_calculated later_";
    const stationStr = session.station ? session.station : "_not set_";
    const odoStr =
      session.odometer != null ? `*${session.odometer}*` : "_not set_";
    const notesStr = session.notes ? session.notes : "_none_";

    return (
      "Please confirm this fuel entry:\n\n" +
      "Vehicle: *" +
      vehicleReg +
      "*\n" +
      "Total cost: " +
      totalStr +
      "\n" +
      "Price per litre: " +
      priceStr +
      "\n" +
      "Litres (approx): " +
      litresStr +
      "\n" +
      "Station: *" +
      stationStr +
      "*\n" +
      "Odometer: " +
      odoStr +
      "\n" +
      "Notes: " +
      notesStr +
      "\n\n" +
      "Reply *YES* to save or *NO* to cancel."
    );
  }

  if (session.step === "confirm") {
    if (["yes", "y"].includes(lower)) {
      try {
        const messageText =
          "Fuel: total " +
          (session.total_cost || 0) +
          " KES, price " +
          (session.price_per_litre || 0) +
          " KES/L, litres " +
          (session.litres != null ? session.litres : "n/a") +
          ", station " +
          (session.station || "n/a") +
          ", odometer " +
          (session.odometer != null ? session.odometer : "n/a");

        await pool.query(
          `
          INSERT INTO fuel_logs (
            user_whatsapp,
            vehicle_id,
            driver_id,
            litres,
            total_cost,
            price_per_litre,
            station,
            odometer,
            notes,
            message_text
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            session.user_whatsapp,
            session.vehicle_id,
            driverId,
            session.litres != null ? session.litres : null,
            session.total_cost != null ? session.total_cost : null,
            session.price_per_litre != null ? session.price_per_litre : null,
            session.station || null,
            session.odometer != null ? session.odometer : null,
            session.notes || null,
            messageText,
          ]
        );

        session.step = "completed";
        await saveFuelSession(session);

        const totalStr =
          session.total_cost != null
            ? `*${session.total_cost}* KES`
            : "_not set_";
        const priceStr =
          session.price_per_litre != null
            ? `*${session.price_per_litre}* KES/L`
            : "_not set_";
        const litresStr =
          session.litres != null ? `*${session.litres}* L` : "_calculated_";
        const stationStr = session.station ? session.station : "_not set_";
        const odoStr =
          session.odometer != null ? `*${session.odometer}*` : "_not set_";
        const notesStr = session.notes ? session.notes : "_none_";

        return (
          "✅ Fuel entry saved.\n\n" +
          "Vehicle: *" +
          vehicleReg +
          "*\n" +
          "Total cost: " +
          totalStr +
          "\n" +
          "Price per litre: " +
          priceStr +
          "\n" +
          "Litres (approx): " +
          litresStr +
          "\n" +
          "Station: *" +
          stationStr +
          "*\n" +
          "Odometer: " +
          odoStr +
          "\n" +
          "Notes: " +
          notesStr +
          "\n\n" +
          "This will appear in your fuel and efficiency reports."
        );
      } catch (err) {
        console.error("❌ Error saving fuel log:", err.message);
        session.step = "error";
        await saveFuelSession(session);
        return (
          "Sorry, I couldn't save that fuel entry due to a system error.\n" +
          "Please try again later."
        );
      }
    }

    if (["no", "n"].includes(lower)) {
      session.step = "cancelled";
      await saveFuelSession(session);
      return (
        "Okay, I’ve *cancelled* that fuel entry.\n" +
        "You can start again with *fuel*."
      );
    }

    return 'Please reply with *YES* to save or *NO* to cancel this fuel entry.';
  }

  console.warn("⚠️ Fuel session in unknown step:", session.step);
  session.step = "error";
  await saveFuelSession(session);
  return (
    "Something went wrong with this fuel entry.\n" +
    "Please start again with *fuel*."
  );
}

// ====== SERVICE SESSION HELPERS ======
async function getActiveServiceSession(userWhatsapp) {
  try {
    const res = await pool.query(
      `
      SELECT *
      FROM service_sessions
      WHERE user_whatsapp = $1
        AND step NOT IN ('completed', 'cancelled', 'error')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [userWhatsapp]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error("❌ Error fetching service_session:", err.message);
    return null;
  }
}

async function saveServiceSession(session) {
  try {
    await pool.query(
      `
      UPDATE service_sessions
      SET
        step = $2,
        service_type = $3,
        labour_cost = $4,
        parts_cost = $5,
        total_cost = $6,
        garage = $7,
        odometer = $8,
        notes = $9,
        reminder_type = $10,
        reminder_value = $11,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        session.id,
        session.step,
        session.service_type || null,
        session.labour_cost != null ? session.labour_cost : null,
        session.parts_cost != null ? session.parts_cost : null,
        session.total_cost != null ? session.total_cost : null,
        session.garage || null,
        session.odometer != null ? session.odometer : null,
        session.notes || null,
        session.reminder_type || null,
        session.reminder_value || null,
      ]
    );
  } catch (err) {
    console.error("❌ Error saving service_session:", err.message);
  }
}

async function startServiceSession(userWhatsapp) {
  const vRes = await ensureCurrentVehicle(userWhatsapp);

  if (vRes.status === "NO_VEHICLES") {
    return {
      session: null,
      reply:
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*",
    };
  }

  if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return {
      session: null,
      reply:
        "You have multiple vehicles. Please choose which one you want to log a service for.\n\n" +
        listText +
        "\n\nReply with e.g. *switch to 1*, then send *service* again.",
    };
  }

  const vehicle = vRes.vehicle;

  const insert = await pool.query(
    `
    INSERT INTO service_sessions (
      user_whatsapp,
      vehicle_id,
      step
    )
    VALUES ($1, $2, 'ask_type')
    RETURNING *
    `,
    [userWhatsapp, vehicle.id]
  );

  const session = insert.rows[0];

  const reply =
    "🛠️ Let's log a service for *" +
    vehicle.registration +
    "*.\n" +
    "First, what kind of service was this?\n" +
    "For example: *major*, *minor*, *oil change*, *grease service*, *tyre rotation*...";

  return { session, reply };
}

async function handleServiceSessionStep(session, incomingText) {
  const text = String(incomingText || "").trim();
  const lower = text.toLowerCase();

  if (["cancel", "stop", "reset"].includes(lower)) {
    session.step = "cancelled";
    await saveServiceSession(session);
    return (
      "✅ I’ve cancelled your service entry.\n" +
      "You can start again with *service*."
    );
  }

  let vehicleReg = "this vehicle";
  let driverId = null;
  try {
    const vRes = await pool.query(
      `SELECT registration, driver_id FROM vehicles WHERE id = $1`,
      [session.vehicle_id]
    );
    if (vRes.rows[0]) {
      if (vRes.rows[0].registration) {
        vehicleReg = vRes.rows[0].registration;
      }
      if (vRes.rows[0].driver_id) {
        driverId = vRes.rows[0].driver_id;
      }
    }
  } catch (err) {
    console.error("⚠️ Error fetching vehicle for service session:", err.message);
  }

  if (session.step === "ask_type") {
    if (!text) {
      return (
        "What kind of service was this?\n" +
        "For example: *major*, *minor*, *oil change*, *grease service*, *tyre rotation*..."
      );
    }

    session.service_type = text;
    session.step = "ask_labour";
    await saveServiceSession(session);

    return (
      "Got it 👍\n" +
      "How much did you pay for *labour only*? (KES)\n" +
      "Example: *8500*"
    );
  }

  if (session.step === "ask_labour") {
    const labour = parseNumber(text);
    if (isNaN(labour) || labour < 0) {
      return "That labour amount doesn't look valid. Please send a number in KES (e.g. *8500*).";
    }

    session.labour_cost = labour;
    session.step = "ask_parts";
    await saveServiceSession(session);

    return (
      "Thanks.\n" +
      "Now how much did you pay for *parts/materials*? (KES)\n" +
      "Reply *0* if there were no parts."
    );
  }

  if (session.step === "ask_parts") {
    const parts = parseNumber(text);
    if (isNaN(parts) || parts < 0) {
      return "That parts amount doesn't look valid. Please send a number in KES (e.g. *12000*).";
    }

    session.parts_cost = parts;
    const labour = session.labour_cost || 0;
    session.total_cost = labour + parts;

    session.step = "ask_garage";
    await saveServiceSession(session);

    return (
      "Great.\n" +
      "Which garage or place did you service at?\n" +
      "Example: *Toyo Motors*, *Shell Ngong Road*.\n" +
      "Reply *skip* to leave this blank."
    );
  }

  if (session.step === "ask_garage") {
    if (lower === "skip") {
      session.garage = null;
    } else {
      session.garage = text;
    }

    session.step = "ask_odo";
    await saveServiceSession(session);

    return (
      "What was the *odometer reading* after the service?\n" +
      "Example: *145000*"
    );
  }

  if (session.step === "ask_odo") {
    const odoNum = parseNumber(text);
    if (isNaN(odoNum) || odoNum < 0) {
      return "That odometer value doesn't look valid. Please send a number like *145000*.";
    }

    session.odometer = Math.round(odoNum);
    session.step = "ask_notes";
    await saveServiceSession(session);

    return (
      "Any notes about what was done? (e.g. *changed oil & filters, rotated tyres*)\n" +
      "Reply *skip* to leave notes blank."
    );
  }

  if (session.step === "ask_notes") {
    if (lower === "skip") {
      session.notes = null;
    } else {
      session.notes = text;
    }

    session.step = "ask_reminder_type";
    await saveServiceSession(session);

    return (
      "Would you like a *reminder* for the next service?\n\n" +
      "Reply with one of:\n" +
      "• *none* – no reminder\n" +
      "• *km* – remind after a certain mileage (e.g. 5000 km)\n" +
      "• *date* – remind on a specific date (YYYY-MM-DD)"
    );
  }

  if (session.step === "ask_reminder_type") {
    if (["none", "no"].includes(lower)) {
      session.reminder_type = null;
      session.reminder_value = null;
      session.step = "confirm";
      await saveServiceSession(session);
    } else if (lower === "km") {
      session.reminder_type = "km";
      session.step = "ask_reminder_value";
      await saveServiceSession(session);
      return (
        "How many *km* until the next service reminder?\n" +
        "Example: *5000* (for 5,000 km from now)."
      );
    } else if (lower === "date") {
      session.reminder_type = "date";
      session.step = "ask_reminder_value";
      await saveServiceSession(session);
      return (
        "On which *date* should I remind you?\n" +
        "Use *YYYY-MM-DD* format (e.g. *2026-01-01*)."
      );
    } else {
      return (
        "I didn't understand that reminder type.\n\n" +
        "Reply:\n" +
        "• *none* – no reminder\n" +
        "• *km* – remind after a certain mileage\n" +
        "• *date* – remind on a specific date (YYYY-MM-DD)"
      );
    }
  }

  if (session.step === "ask_reminder_value") {
    if (session.reminder_type === "km") {
      const km = parseNumber(text);
      if (isNaN(km) || km <= 0) {
        return "That doesn't look like a valid km value. Please send a positive number (e.g. *5000*).";
      }

      session.reminder_value = String(Math.round(km));
      session.step = "confirm";
      await saveServiceSession(session);
    } else if (session.reminder_type === "date") {
      const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) {
        return (
          "That date doesn't look valid.\n" +
          "Please send in *YYYY-MM-DD* format (e.g. *2026-01-01*)."
        );
      }
      session.reminder_value = text;
      session.step = "confirm";
      await saveServiceSession(session);
    } else {
      session.reminder_type = null;
      session.reminder_value = null;
      session.step = "confirm";
      await saveServiceSession(session);
    }
  }

  if (session.step === "confirm") {
    const labourStr =
      session.labour_cost != null ? `*${session.labour_cost}* KES` : "_0_";
    const partsStr =
      session.parts_cost != null ? `*${session.parts_cost}* KES` : "_0_";
    const totalStr =
      session.total_cost != null ? `*${session.total_cost}* KES` : "_0_`;
    const garageStr = session.garage ? session.garage : "_not set_";
    const odoStr =
      session.odometer != null ? `*${session.odometer}*` : "_not set_";
    const notesStr = session.notes ? session.notes : "_none_";

    let reminderStr = "_none_";
    if (session.reminder_type === "km" && session.reminder_value) {
      reminderStr = "After *" + session.reminder_value + "* km";
    } else if (session.reminder_type === "date" && session.reminder_value) {
      reminderStr = "On *" + session.reminder_value + "*";
    }

    if (!["yes", "y", "no", "n"].includes(lower)) {
      return (
        "Please confirm this service entry:\n\n" +
        "Vehicle: *" +
        vehicleReg +
        "*\n" +
        "Service type: *" +
        session.service_type +
        "*\n" +
        "Labour: " +
        labourStr +
        "\n" +
        "Parts: " +
        partsStr +
        "\n" +
        "Total: " +
        totalStr +
        "\n" +
        "Garage: *" +
        garageStr +
        "*\n" +
        "Odometer: " +
        odoStr +
        "\n" +
        "Notes: " +
        notesStr +
        "\n" +
        "Reminder: " +
        reminderStr +
        "\n\n" +
        "Reply *YES* to save or *NO* to cancel."
      );
    }

    if (["no", "n"].includes(lower)) {
      session.step = "cancelled";
      await saveServiceSession(session);
      return (
        "Okay, I’ve *cancelled* that service entry.\n" +
        "You can start again with *service*."
      );
    }

    if (["yes", "y"].includes(lower)) {
      try {
        const messageText =
          "Service: " +
          (session.service_type || "n/a") +
          ", labour " +
          (session.labour_cost || 0) +
          " KES, parts " +
          (session.parts_cost || 0) +
          " KES, total " +
          (session.total_cost || 0) +
          " KES, garage " +
          (session.garage || "n/a") +
          ", odometer " +
          (session.odometer != null ? session.odometer : "n/a");

        await pool.query(
          `
          INSERT INTO service_logs (
            user_whatsapp,
            vehicle_id,
            driver_id,
            service_type,
            labour_cost,
            parts_cost,
            total_cost,
            garage,
            odometer,
            notes,
            reminder_type,
            reminder_value,
            message_text
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
            session.user_whatsapp,
            session.vehicle_id,
            driverId,
            session.service_type || null,
            session.labour_cost != null ? session.labour_cost : null,
            session.parts_cost != null ? session.parts_cost : null,
            session.total_cost != null ? session.total_cost : null,
            session.garage || null,
            session.odometer != null ? session.odometer : null,
            session.notes || null,
            session.reminder_type || null,
            session.reminder_value || null,
            messageText,
          ]
        );

        if (session.reminder_type && session.reminder_value) {
          try {
            if (session.reminder_type === "km") {
              await pool.query(
                `
                INSERT INTO reminders (
                  user_whatsapp,
                  vehicle_id,
                  reminder_type,
                  label,
                  due_odo,
                  is_done
                )
                VALUES ($1, $2, 'service_km', $3, $4, FALSE)
                `,
                [
                  session.user_whatsapp,
                  session.vehicle_id,
                  session.service_type || "Service",
                  session.reminder_value,
                ]
              );
            } else if (session.reminder_type === "date") {
              await pool.query(
                `
                INSERT INTO reminders (
                  user_whatsapp,
                  vehicle_id,
                  reminder_type,
                  label,
                  due_date,
                  is_done
                )
                VALUES ($1, $2, 'service_date', $3, $4, FALSE)
                `,
                [
                  session.user_whatsapp,
                  session.vehicle_id,
                  session.service_type || "Service",
                  session.reminder_value,
                ]
              );
            }
          } catch (err) {
            console.error("⚠️ Could not insert service reminder:", err.message);
          }
        }

        session.step = "completed";
        await saveServiceSession(session);

        return (
          "✅ Service entry saved.\n\n" +
          "Vehicle: *" +
          vehicleReg +
          "*\n" +
          "Service type: *" +
          session.service_type +
          "*\n" +
          "Labour: " +
          labourStr +
          "\n" +
          "Parts: " +
          partsStr +
          "\n" +
          "Total: " +
          totalStr +
          "\n" +
          "Garage: *" +
          garageStr +
          "*\n" +
          "Odometer: " +
          odoStr +
          "\n" +
          "Notes: " +
          notesStr +
          "\n" +
          "Reminder: " +
          reminderStr +
          "\n\n" +
          "This will appear in your service and compliance reports."
        );
      } catch (err) {
        console.error("❌ Error saving service log:", err.message);
        session.step = "error";
        await saveServiceSession(session);
        return (
          "Sorry, I couldn't save that service entry due to a system error.\n" +
          "Please try again later."
        );
      }
    }
  }

  console.warn("⚠️ Service session in unknown step:", session.step);
  session.step = "error";
  await saveServiceSession(session);
  return (
    "Something went wrong with this service entry.\n" +
    "Please start again with *service*."
  );
}


// ====== SERVICE SESSION HELPERS ====== (unchanged from your version – kept for brevity)
// ... [SERVICE helpers from your current file stay exactly as-is here]
// (Keep all: getActiveServiceSession, saveServiceSession, startServiceSession, handleServiceSessionStep)

// ====== VEHICLE DOCUMENT SESSION HELPERS ======
// ... [All vehicle document helpers exactly as in your current file]

// ====== PERSONAL DOCUMENT HELPERS ======
// ... [All personal document helpers exactly as in your current file]

// ====== EXPENSE SESSION HELPERS ======

async function getActiveExpenseSession(userWhatsapp) {
  try {
    const res = await pool.query(
      `
      SELECT *
      FROM expense_sessions
      WHERE user_whatsapp = $1
        AND step NOT IN ('completed', 'cancelled', 'error')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [userWhatsapp]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error("❌ Error fetching expense_session:", err.message);
    return null;
  }
}

async function saveExpenseSession(session) {
  try {
    await pool.query(
      `
      UPDATE expense_sessions
      SET
        step     = $2,
        title    = $3,
        amount   = $4,
        odometer = $5,
        notes    = $6,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        session.id,
        session.step,
        session.title || null,
        session.amount != null ? session.amount : null,
        session.odometer != null ? session.odometer : null,
        session.notes || null,
      ]
    );
  } catch (err) {
    console.error("❌ Error saving expense_session:", err.message);
  }
}

async function startExpenseSession(userWhatsapp) {
  const vRes = await ensureCurrentVehicle(userWhatsapp);

  if (vRes.status === "NO_VEHICLES") {
    return {
      session: null,
      reply:
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*",
    };
  }

  if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return {
      session: null,
      reply:
        "You have multiple vehicles. Please choose which one you want to log an expense for.\n\n" +
        listText +
        "\n\nReply with e.g. *switch to 1*, then send *expense* again.",
    };
  }

  const vehicle = vRes.vehicle;

  const insert = await pool.query(
    `
    INSERT INTO expense_sessions (
      user_whatsapp,
      vehicle_id,
      step
    )
    VALUES ($1, $2, 'ask_title')
    RETURNING *
    `,
    [userWhatsapp, vehicle.id]
  );

  const session = insert.rows[0];

  const reply =
    "💸 Let's log an expense for *" +
    vehicle.registration +
    "*.\n\n" +
    "What was this expense for?\n" +
    "Example: *Parking at Yaya*, *Tyres*, *Car wash*";

  return { session, reply };
}

async function handleExpenseSessionStep(session, incomingText) {
  const text = String(incomingText || "").trim();
  const lower = text.toLowerCase();

  if (["cancel", "stop", "reset"].includes(lower)) {
    session.step = "cancelled";
    await saveExpenseSession(session);
    return (
      "✅ I’ve cancelled your expense entry.\n" +
      "You can start again with *expense*."
    );
  }

  let vehicleReg = "this vehicle";
  let driverId = null;
  try {
    const vRes = await pool.query(
      `SELECT registration, driver_id FROM vehicles WHERE id = $1`,
      [session.vehicle_id]
    );
    if (vRes.rows[0]) {
      if (vRes.rows[0].registration) {
        vehicleReg = vRes.rows[0].registration;
      }
      if (vRes.rows[0].driver_id) {
        driverId = vRes.rows[0].driver_id;
      }
    }
  } catch (err) {
    console.error("⚠️ Error fetching vehicle for expense session:", err.message);
  }

  if (session.step === "ask_title") {
    if (!text) {
      return (
        "Please tell me what this expense was for.\n" +
        "Example: *Parking at Junction*, *Tyre repair*, *Car wash*"
      );
    }

    session.title = text;
    session.step = "ask_amount";
    await saveExpenseSession(session);

    return (
      "How much did you pay for this expense? (KES)\n" +
      "Example: *1500*"
    );
  }

  if (session.step === "ask_amount") {
    const amount = parseNumber(text);
    if (isNaN(amount) || amount <= 0) {
      return "That amount doesn't look valid. Please send a positive number like *1500*.";
    }

    session.amount = amount;
    session.step = "ask_odo";
    await saveExpenseSession(session);

    return (
      "What was the *odometer reading* when this expense happened?\n" +
      "Example: *145000*\n" +
      "Reply *skip* if the odometer is not relevant."
    );
  }

  if (session.step === "ask_odo") {
    if (lower === "skip") {
      session.odometer = null;
    } else {
      const odoNum = parseNumber(text);
      if (isNaN(odoNum) || odoNum < 0) {
        return "That odometer value doesn't look valid. Please send a number like *145000* or reply *skip*.";
      }
      session.odometer = Math.round(odoNum);
    }

    session.step = "ask_notes";
    await saveExpenseSession(session);

    return (
      "Any notes about this expense?\n" +
      "Example: *Parking for town meeting*, *New rear tyre*, etc.\n" +
      "Reply *skip* to leave notes blank."
    );
  }

  if (session.step === "ask_notes") {
    if (lower === "skip") {
      session.notes = null;
    } else {
      session.notes = text;
    }

    session.step = "confirm";
    await saveExpenseSession(session);

    const titleStr = session.title ? `*${session.title}*` : "_not set_";
    const amountStr =
      session.amount != null ? `*${session.amount}* KES` : "_not set_";
    const odoStr =
      session.odometer != null ? `*${session.odometer}*` : "_not set_";
    const notesStr = session.notes ? session.notes : "_none_";

    return (
      "Please confirm this expense entry:\n\n" +
      "Vehicle: *" +
      vehicleReg +
      "*\n" +
      "Title: " +
      titleStr +
      "\n" +
      "Amount: " +
      amountStr +
      "\n" +
      "Odometer: " +
      odoStr +
      "\n" +
      "Notes: " +
      notesStr +
      "\n\n" +
      "Reply *YES* to save or *NO* to cancel."
    );
  }

  if (session.step === "confirm") {
    if (["yes", "y"].includes(lower)) {
      try {
        const messageText =
          "Expense: " +
          (session.title || "n/a") +
          ", amount " +
          (session.amount || 0) +
          " KES, odometer " +
          (session.odometer != null ? session.odometer : "n/a");

        await pool.query(
          `
          INSERT INTO expense_logs (
            user_whatsapp,
            vehicle_id,
            driver_id,
            title,
            amount,
            odometer,
            notes,
            message_text
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            session.user_whatsapp,
            session.vehicle_id,
            driverId,
            session.title || null,
            session.amount != null ? session.amount : null,
            session.odometer != null ? session.odometer : null,
            session.notes || null,
            messageText,
          ]
        );

        session.step = "completed";
        await saveExpenseSession(session);

        const titleStr = session.title ? `*${session.title}*` : "_not set_";
        const amountStr =
          session.amount != null ? `*${session.amount}* KES` : "_not set_";
        const odoStr =
          session.odometer != null ? `*${session.odometer}*` : "_not set_";
        const notesStr = session.notes ? session.notes : "_none_";

        return (
          "✅ Expense entry saved.\n\n" +
          "Vehicle: *" +
          vehicleReg +
          "*\n" +
          "Title: " +
          titleStr +
          "\n" +
          "Amount: " +
          amountStr +
          "\n" +
          "Odometer: " +
          odoStr +
          "\n" +
          "Notes: " +
          notesStr +
          "\n\n" +
          "This will appear in your expense reports."
        );
      } catch (err) {
        console.error("❌ Error saving expense log:", err.message);
        session.step = "error";
        await saveExpenseSession(session);
        return (
          "Sorry, I couldn't save that expense entry due to a system error.\n" +
          "Please try again later."
        );
      }
    }

    if (["no", "n"].includes(lower)) {
      session.step = "cancelled";
      await saveExpenseSession(session);
      return (
        "Okay, I’ve *cancelled* that expense entry.\n" +
        "You can start again with *expense*."
      );
    }

    return 'Please reply with *YES* to save or *NO* to cancel this expense entry.';
  }

  console.warn("⚠️ Expense session in unknown step:", session.step);
  session.step = "error";
  await saveExpenseSession(session);
  return (
    "Something went wrong with this expense entry.\n" +
    "Please start again with *expense*."
  );
}
// ====== SIMPLE DELETE / EDIT PLACEHOLDERS ======
async function handleDeleteLastCommand(userWhatsapp, lower) {
  return (
    "Delete commands are not fully wired in this backend.\n" +
    "For now, you can start new logs with *fuel*, *service* or *expense*."
  );
}

async function handleEditLastCommand(userWhatsapp, fullText) {
  return (
    "Edit commands are not fully wired in this backend.\n" +
    "For now, you can correct entries by logging a new one."
  );
}

// ====== REPORTS ======

// REAL fuel report – current vehicle vs all vehicles
async function buildFuelReport(userWhatsapp, options = {}) {
  const allVehicles = !!options.allVehicles;

  let where = "user_whatsapp = $1";
  const params = [userWhatsapp];
  let heading = "";
  let vehicle = null;

  if (!allVehicles) {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "NO_VEHICLES") {
      return (
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*"
      );
    } else if (vRes.status === "NEED_SET_CURRENT") {
      const listText = formatVehiclesList(vRes.list, true);
      return (
        "You have multiple vehicles. Please choose which one you want a fuel report for.\n\n" +
        listText +
        "\n\nReply with e.g. *switch to 1*, then send *fuel report* again."
      );
    }
    vehicle = vRes.vehicle;
    where += " AND vehicle_id = $2";
    params.push(vehicle.id);
    heading = "📊 *Fuel summary – " + vehicle.registration + "*";
  } else {
    heading = "📊 *Fuel summary – all vehicles*";
  }

  const summaryRes = await pool.query(
    `
    SELECT
      COUNT(*)::BIGINT           AS count,
      COALESCE(SUM(total_cost), 0)    AS total_spend,
      COALESCE(SUM(litres), 0)       AS total_litres,
      MIN(created_at)            AS first_at,
      MAX(created_at)            AS last_at
    FROM fuel_logs
    WHERE ${where}
    `,
    params
  );

  const row = summaryRes.rows[0] || {};
  const count = parseInt(row.count || "0", 10);
  const totalSpend = parseFloat(row.total_spend || "0");
  const totalLitres = parseFloat(row.total_litres || "0");

  if (!count || count === 0) {
    if (allVehicles) {
      return (
        heading +
        "\n\nYou don't have any fuel logs yet.\n\n" +
        "Start with *fuel* to log your first refill."
      );
    }
    return (
      heading +
      "\n\nYou don't have any fuel logs for your *current vehicle* yet.\n\n" +
      "Start with *fuel* to log your first refill."
    );
  }

  const avgPerFill = totalSpend / count;
  const avgLitresPerFill = totalLitres > 0 ? totalLitres / count : 0;
  const avgPricePerLitre =
    totalLitres > 0 ? totalSpend / totalLitres : 0;

  const firstAt = row.first_at ? new Date(row.first_at) : null;
  const lastAt = row.last_at ? new Date(row.last_at) : null;

  const firstStr = firstAt ? firstAt.toISOString().slice(0, 10) : "n/a";
  const lastStr = lastAt ? lastAt.toISOString().slice(0, 10) : "n/a";

  const latestRes = await pool.query(
    `
    SELECT total_cost, litres, price_per_litre, station, odometer, created_at
    FROM fuel_logs
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT 5
    `,
    params
  );

  let text =
    heading +
    "\n\n" +
    "Period: *" +
    firstStr +
    "* → *" +
    lastStr +
    "*\n" +
    "Refills: *" +
    count +
    "*\n" +
    "Total spend: *" +
    totalSpend.toFixed(0) +
    "* KES\n" +
    "Total litres: *" +
    totalLitres.toFixed(1) +
    "* L\n" +
    "Avg per refill: *" +
    avgPerFill.toFixed(0) +
    "* KES\n" +
    "Avg litres/refill: *" +
    avgLitresPerFill.toFixed(1) +
    "* L\n" +
    "Avg price/litre: *" +
    avgPricePerLitre.toFixed(1) +
    "* KES\n";

  if (latestRes.rows.length > 0) {
    text += "\n⛽ *Last 5 refills*:";
    latestRes.rows.forEach((f) => {
      const d = f.created_at ? new Date(f.created_at) : null;
      const dStr = d ? d.toISOString().slice(0, 10) : "n/a";
      const amount = f.total_cost != null ? Number(f.total_cost) : 0;
      const litres = f.litres != null ? Number(f.litres) : 0;
      const station = f.station || "n/a";
      const odoStr =
        f.odometer != null ? ` @ *${f.odometer}* km` : "";

      text +=
        "\n• " +
        dStr +
        " – *" +
        amount.toFixed(0) +
        "* KES, *" +
        litres.toFixed(1) +
        "* L – " +
        station +
        odoStr;
    });
  }

  if (allVehicles) {
    const byVehicleRes = await pool.query(
      `
      SELECT v.registration,
             COALESCE(SUM(f.total_cost), 0) AS total_spend,
             COALESCE(SUM(f.litres), 0)     AS total_litres
      FROM fuel_logs f
      JOIN vehicles v ON v.id = f.vehicle_id
      WHERE f.user_whatsapp = $1
      GROUP BY v.registration
      ORDER BY total_spend DESC
      LIMIT 5
      `,
      [userWhatsapp]
    );

    if (byVehicleRes.rows.length > 0) {
      text += "\n\n🚗 *Top vehicles by fuel spend*:";
      byVehicleRes.rows.forEach((r) => {
        const reg = r.registration || "Vehicle";
        const t = r.total_spend != null ? Number(r.total_spend) : 0;
        const l = r.total_litres != null ? Number(r.total_litres) : 0;
        text +=
          "\n• *" +
          reg +
          "* – *" +
          t.toFixed(0) +
          "* KES, *" +
          l.toFixed(1) +
          "* L";
      });
    }
  }

  text +=
    "\n\nYou can log a new refill anytime with *fuel*.\n" +
    "Use *fuel report* for the current vehicle, or *fuel report all* for your whole fleet.";

  return text;
}

// REAL service report – current vehicle vs all vehicles
async function buildServiceReport(userWhatsapp, options = {}) {
  const allVehicles = !!options.allVehicles;

  let where = "user_whatsapp = $1";
  const params = [userWhatsapp];
  let heading = "";
  let vehicle = null;

  if (!allVehicles) {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "NO_VEHICLES") {
      return (
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*"
      );
    } else if (vRes.status === "NEED_SET_CURRENT") {
      const listText = formatVehiclesList(vRes.list, true);
      return (
        "You have multiple vehicles. Please choose which one you want a service report for.\n\n" +
        listText +
        "\n\nReply with e.g. *switch to 1*, then send *service report* again."
      );
    }
    vehicle = vRes.vehicle;
    where += " AND vehicle_id = $2";
    params.push(vehicle.id);
    heading = "📊 *Service summary – " + vehicle.registration + "*";
  } else {
    heading = "📊 *Service summary – all vehicles*";
  }

  // NOTE: this assumes your table is called service_logs and has a 'cost' column.
  // If your column is named differently (e.g. 'amount'), just change SUM(cost) accordingly.
  const summaryRes = await pool.query(
    `
    SELECT
      COUNT(*)::BIGINT        AS count,
      COALESCE(SUM(cost), 0)  AS total_cost,
      MIN(created_at)         AS first_at,
      MAX(created_at)         AS last_at
    FROM service_logs
    WHERE ${where}
    `,
    params
  );

  const row = summaryRes.rows[0] || {};
  const count = parseInt(row.count || "0", 10);
  const totalCost = parseFloat(row.total_cost || "0");

  if (!count || count === 0) {
    if (allVehicles) {
      return (
        heading +
        "\n\nYou don't have any service logs yet.\n\n" +
        "Start with *service* to log your first one."
      );
    }
    return (
      heading +
      "\n\nYou don't have any service logs for your *current vehicle* yet.\n\n" +
      "Start with *service* to log your first one."
    );
  }

  const avgPerService = totalCost / count;
  const firstAt = row.first_at ? new Date(row.first_at) : null;
  const lastAt = row.last_at ? new Date(row.last_at) : null;

  const firstStr = firstAt ? firstAt.toISOString().slice(0, 10) : "n/a";
  const lastStr = lastAt ? lastAt.toISOString().slice(0, 10) : "n/a";

  // NOTE: assumes columns service_type, cost, odometer exist.
  // If your names differ, tweak to match your table schema.
  const latestRes = await pool.query(
    `
    SELECT service_type, cost, odometer, created_at
    FROM service_logs
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT 5
    `,
    params
  );

  let text =
    heading +
    "\n\n" +
    "Period: *" +
    firstStr +
    "* → *" +
    lastStr +
    "*\n" +
    "Services: *" +
    count +
    "*\n" +
    "Total service cost: *" +
    totalCost.toFixed(0) +
    "* KES\n" +
    "Average per service: *" +
    avgPerService.toFixed(0) +
    "* KES\n";

  if (latestRes.rows.length > 0) {
    text += "\n🛠️ *Last 5 services*:";
    latestRes.rows.forEach((s) => {
      const d = s.created_at ? new Date(s.created_at) : null;
      const dStr = d ? d.toISOString().slice(0, 10) : "n/a";
      const type = s.service_type || "Service";
      const cost = s.cost != null ? Number(s.cost) : 0;
      const odoStr =
        s.odometer != null ? ` @ *${s.odometer}* km` : "";

      text +=
        "\n• " +
        dStr +
        " – *" +
        cost.toFixed(0) +
        "* KES – " +
        type +
        odoStr;
    });
  }

  if (allVehicles) {
    const byVehicleRes = await pool.query(
      `
      SELECT v.registration,
             COALESCE(SUM(s.cost), 0) AS total_cost
      FROM service_logs s
      JOIN vehicles v ON v.id = s.vehicle_id
      WHERE s.user_whatsapp = $1
      GROUP BY v.registration
      ORDER BY total_cost DESC
      LIMIT 5
      `,
      [userWhatsapp]
    );

    if (byVehicleRes.rows.length > 0) {
      text += "\n\n🚗 *Top vehicles by service cost*:";
      byVehicleRes.rows.forEach((r) => {
        const reg = r.registration || "Vehicle";
        const t = r.total_cost != null ? Number(r.total_cost) : 0;
        text +=
          "\n• *" +
          reg +
          "* – *" +
          t.toFixed(0) +
          "* KES total";
      });
    }
  }

  text +=
    "\n\nYou can log a new service anytime with *service*.\n" +
    "Use *service report* for the current vehicle, or *service report all* for your whole fleet.";

  return text;
}

// ====== AI FALLBACK → n8n ======
async function callN8nAi(from, text) {
  if (!N8N_WEBHOOK_URL) {
    console.warn("⚠️ No N8N_WEBHOOK_URL set – skipping AI call.");
    return null;
  }

  try {
    const payload = { from, text };
    console.log("🤖 Calling n8n AI webhook:", N8N_WEBHOOK_URL);
    console.log("🤖 Payload to n8n:", payload);

    const aiRes = await axios.post(N8N_WEBHOOK_URL, payload, {
      timeout: 10000,
    });

    console.log("🤖 Raw n8n AI response:", aiRes.status, aiRes.data);

    const data = aiRes.data;

    if (data && typeof data === "object") {
      if (typeof data.reply === "string" && data.reply.trim().length > 0) {
        return data.reply.trim();
      }
      if (typeof data.text === "string" && data.text.trim().length > 0) {
        return data.text.trim();
      }
      console.warn("⚠️ n8n AI object had no 'reply' or 'text' string.");
      return null;
    }

    if (typeof data === "string") {
      const str = data.trim();
      if (!str) return null;
      return str;
    }

    console.warn("⚠️ n8n AI response had no usable 'reply'/'text' string.");
    return null;
  } catch (err) {
    console.error("❌ Error calling n8n AI webhook:", err.message);
    return null;
  }
}

// ====== MEMORY LOGGING (chat_turns) ======
async function logChatTurn(userWhatsapp, role, message) {
  try {
    if (!userWhatsapp || !message) return;
    await pool.query(
      `
      INSERT INTO chat_turns (user_whatsapp, role, message)
      VALUES ($1, $2, $3)
    `,
      [userWhatsapp, role, message]
    );
  } catch (err) {
    console.error("❌ Error inserting into chat_turns:", err.message);
  }
}

// ====== GLOBAL SESSION CANCEL ======
async function cancelAllSessionsForUser(userWhatsapp) {
  try {
    await pool.query(
      `
      DELETE FROM fuel_sessions
      WHERE user_whatsapp = $1
      `,
      [userWhatsapp]
    );
  } catch (err) {
    console.error("⚠️ Could not delete fuel_sessions for user:", err.message);
  }

  try {
    await pool.query(
      `
      DELETE FROM service_sessions
      WHERE user_whatsapp = $1
      `,
      [userWhatsapp]
    );
  } catch (err) {
    console.error("⚠️ Could not delete service_sessions for user:", err.message);
  }

  try {
    await pool.query(
      `
      DELETE FROM expense_sessions
      WHERE user_whatsapp = $1
      `,
      [userWhatsapp]
    );
  } catch (err) {
    console.error("⚠️ Could not delete expense_sessions for user:", err.message);
  }

  try {
    await pool.query(
      `
      UPDATE vehicle_document_sessions
      SET status = 'cancelled',
          updated_at = NOW()
      WHERE user_whatsapp = $1
        AND status = 'active'
      `,
      [userWhatsapp]
    );
  } catch (err) {
    console.error(
      "⚠️ Could not cancel vehicle_document_sessions for user:",
      err.message
    );
  }

  try {
    await pool.query(
      `
      UPDATE personal_document_sessions
      SET status = 'CANCELLED',
          updated_at = NOW()
      WHERE user_whatsapp = $1
        AND status = 'ACTIVE'
      `,
      [userWhatsapp]
    );
  } catch (err) {
    console.error(
      "⚠️ Could not cancel personal_document_sessions for user:",
      err.message
    );
  }
}

// ====== HEALTH CHECK ======
app.get("/", (req, res) => {
  res.send("Saka360 backend is running ✅");
});

// ====== MAIN WHATSAPP HANDLER ======
app.post("/whatsapp/inbound", async (req, res) => {
  try {
    const from = req.body.From || req.body.from;
    const to = req.body.To || req.body.to || TWILIO_WHATSAPP_NUMBER;
    const rawText = req.body.Body || req.body.text || "";
    const text = String(rawText || "").trim();
    const lower = text.toLowerCase();

    console.log("📩 Incoming:", { from, text });

    if (!from) {
      console.warn("⚠️ Missing 'from' in inbound payload.");
      res.status(200).send("OK");
      return;
    }

    if (!text) {
      console.log("⚠️ Empty message body received from Twilio.");
      res.status(200).send("OK");
      return;
    }

    await logChatTurn(from, "user", text);

    if (["cancel", "stop", "reset"].includes(lower)) {
      await cancelAllSessionsForUser(from);
      const replyText =
        "✅ I’ve cancelled your current entry. You can start again with *fuel*, *service*, or *expense*.";
      await logChatTurn(from, "assistant", replyText);

      console.log("💬 Reply (global cancel):", replyText);

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
      return;
    }

    let replyText = "";

    // Active FUEL session
    const activeFuelSession = await getActiveFuelSession(from);
    if (activeFuelSession) {
      replyText = await handleFuelSessionStep(activeFuelSession, text);

      await logChatTurn(from, "assistant", replyText);
      console.log("💬 Reply (fuel session):", replyText);
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
      return;
    }

    // Active SERVICE session
    const activeServiceSession = await getActiveServiceSession(from);
    if (activeServiceSession) {
      replyText = await handleServiceSessionStep(activeServiceSession, text);

      await logChatTurn(from, "assistant", replyText);
      console.log("💬 Reply (service session):", replyText);
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
      return;
    }

    // Active EXPENSE session
    const activeExpenseSession = await getActiveExpenseSession(from);
    if (activeExpenseSession) {
      replyText = await handleExpenseSessionStep(activeExpenseSession, text);

      await logChatTurn(from, "assistant", replyText);
      console.log("💬 Reply (expense session):", replyText);
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
      return;
    }

    // Active VEHICLE DOCUMENT session
    const activeDocSession = await getActiveVehicleDocumentSession(from);
    if (activeDocSession) {
      replyText = await handleVehicleDocumentSessionStep(activeDocSession, text);

      await logChatTurn(from, "assistant", replyText);
      console.log("💬 Reply (vehicle document session):", replyText);
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
      return;
    }

    // Active PERSONAL DOCUMENT session
    const activePersonalDocSession = await getActivePersonalDocumentSession(
      from
    );
    if (activePersonalDocSession) {
      replyText = await handlePersonalDocumentSessionStep(
        activePersonalDocSession,
        from,
        text
      );

      await logChatTurn(from, "assistant", replyText);
      console.log("💬 Reply (personal document session):", replyText);
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
      return;
    }

    // NO ACTIVE SESSION → Command routing

    if (lower === "accept") {
      replyText = await handleDriverAccept(from);
    } else if (lower === "add") {
      replyText =
        "What would you like to add? ✏️\n\n" +
        "1. *Vehicle* – register a new vehicle\n" +
        "2. *Driver* – invite a driver to log for your vehicles\n" +
        "3. *Document* – add a vehicle document with cost & reminder\n\n" +
        "Reply with:\n" +
        "• *add vehicle* – I’ll guide you to add a vehicle\n" +
        "• *add driver* – I’ll guide you to invite a driver\n" +
        "• *add document* – I’ll help you log a vehicle document";
    } else if (lower === "start") {
      replyText =
        "Welcome to *Saka360* 👋\n" +
        "I help you track fuel, service, expenses and driver compliance for your vehicles.\n\n" +
        "Quick commands:\n" +
        "• *fuel* – log fuel step by step\n" +
        "• *service* – log a service step by step\n" +
        "• *document* – add a vehicle document & reminder\n" +
        "• *my document* – add a personal/driver document\n" +
        "• *expense* – log other costs (tyres, parking, repairs)\n" +
        "• *add vehicle* – register a vehicle\n" +
        "• *add driver* – invite a driver\n" +
        "• *report* – see fuel/service/expense & driver reports\n\n" +
        "You can type *help* anytime to see this again.";
    } else if (lower === "help") {
      replyText =
        "Here’s what I can do on *Saka360* 👇\n\n" +
        "• *fuel* – log a fuel refill step by step\n" +
        "• *service* – log a service with notes and reminders\n" +
        "• *document* – log vehicle documents with cost & expiry\n" +
        "• *my document* – log personal/driver documents (DL, PSV, TSV, etc.)\n" +
        "• *expense* – log other costs (tyres, parking, repairs)\n" +
        "• *add vehicle* – add a vehicle to your account\n" +
        "• *add driver* – invite a driver and track DL compliance\n" +
        "• *my vehicles* – see and switch current vehicle\n" +
        "• *my drivers* – see drivers and their licence status\n" +
        "• *assign driver 1* – assign driver 1 to your current vehicle\n" +
        "• *driver report* – driver licence compliance overview\n\n" +
        "You can also type normal questions like:\n" +
        "• *How do I log fuel?*\n" +
        "• *How do I add a fleet account?*\n" +
        "and I’ll explain.";
    } else if (lower.startsWith("add vehicle")) {
      replyText = await handleAddVehicleCommand(from, text);
    } else if (
      lower === "my vehicles" ||
      lower === "my vehicle" ||
      lower === "my cars" ||
      lower === "my car" ||
      lower === "cars" ||
      lower === "car"
    ) {
      replyText = await handleMyVehiclesCommand(from);
    } else if (lower.startsWith("switch")) {
      replyText = await handleSwitchVehicleCommand(from, text);
    } else if (lower.startsWith("add driver")) {
      replyText = await handleAddDriverCommand(from, text);
    } else if (lower === "my drivers" || lower === "drivers") {
      replyText = await handleMyDriversCommand(from);
    } else if (lower.startsWith("assign driver")) {
      replyText = await handleAssignDriverCommand(from, text);
    } else if (lower.startsWith("dl ")) {
      replyText = await handleDriverLicenceCommand(from, text);
    } else if (
      lower === "fuel" ||
      lower === "log fuel" ||
      lower === "fuel step-by-step" ||
      lower === "fuel step by step"
    ) {
      const { session, reply } = await startFuelSession(from);
      replyText = reply;
    } else if (
      lower === "service" ||
      lower === "log service" ||
      lower === "service step-by-step" ||
      lower === "service step by step"
    ) {
      const { session, reply } = await startServiceSession(from);
      replyText = reply;
    } else if (
      lower === "expense" ||
      lower === "log expense" ||
      lower === "expenses" ||
      lower === "log expenses"
    ) {
      const { session, reply } = await startExpenseSession(from);
      replyText = reply;
    } else if (
      lower === "my document" ||
      lower === "my documents" ||
      lower === "personal document" ||
      lower === "personal documents" ||
      lower === "add my document"
    ) {
      const { session, reply } = await startPersonalDocumentSession(from);
      replyText = reply;
    } else if (
      lower === "document" ||
      lower === "documents" ||
      lower === "add document" ||
      lower === "add documents" ||
      lower === "vehicle document" ||
      lower === "vehicle documents" ||
      lower === "insurance" ||
      lower === "inspection"
    ) {
      const { session, reply } = await startVehicleDocumentSession(from);
      replyText = reply;
    } else if (lower === "edit") {
      replyText =
        "To edit a record, you’ll soon be able to use commands like:\n" +
        "• *edit last fuel cost 9000*\n" +
        "• *edit last service notes changed oil filter*\n\n" +
        "(Editing is still being wired in this version.)";
    } else if (lower === "delete") {
      replyText =
        "To delete your last record, you’ll soon be able to use:\n" +
        "• *delete last fuel*\n" +
        "• *delete last service*\n" +
        "• *delete last expense*\n\n" +
        "(Deleting is still being wired in this version.)";
    } else if (lower.startsWith("delete last")) {
      replyText = await handleDeleteLastCommand(from, lower);
    } else if (lower.startsWith("edit last")) {
      replyText = await handleEditLastCommand(from, text);
    } else if (lower === "report" || lower.startsWith("report ")) {
      replyText =
        "I can show quick summaries for your data:\n\n" +
        "• *fuel report* – fuel spend & efficiency (current vehicle)\n" +
        "• *fuel report all* – fuel summary across all vehicles\n" +
        "• *service report* – service spend (current vehicle)\n" +
        "• *service report all* – service summary across all vehicles\n" +
        "• *expense report* – other expenses (current vehicle)\n" +
        "• *expense report all* – expenses across all vehicles\n" +
        "• *driver report* – driver licence compliance\n\n" +
        "Please choose one of those.";
    } else if (lower.startsWith("fuel report")) {
      const wantsAll = lower.includes("all");
      if (wantsAll) {
        replyText = await buildFuelReport(from, { allVehicles: true });
      } else {
        replyText = await buildFuelReport(from, {});
      }
    } else if (lower.startsWith("service report")) {
      const wantsAll = lower.includes("all");
      if (wantsAll) {
        replyText = await buildServiceReport(from, { allVehicles: true });
      } else {
        replyText = await buildServiceReport(from, {});
      }
    } else if (
      lower.startsWith("expense report") ||
      lower.startsWith("expenses report")
    ) {
      const wantsAll = lower.includes("all");
      if (wantsAll) {
        replyText = await buildExpenseReport(from, { allVehicles: true });
      } else {
        replyText = await buildExpenseReport(from, {});
      }
    } else if (
      lower === "driver report" ||
      lower === "drivers report" ||
      lower === "driver compliance" ||
      lower === "compliance" ||
      lower === "check licences" ||
      lower === "check licenses"
    ) {
      const driver = await findDriverByWhatsapp(from);
      if (driver) {
        replyText = await handleMyOwnLicenceStatus(from);
      } else {
        replyText = await buildDriverComplianceReport(from);
      }
    } else if (
      lower === "my licence" ||
      lower === "my license" ||
      lower === "my dl" ||
      lower === "licence" ||
      lower === "license"
    ) {
      replyText = await handleMyOwnLicenceStatus(from);
    } else {
      const aiReply = await callN8nAi(from, text);
      if (aiReply && typeof aiReply === "string" && aiReply.trim().length > 0) {
        replyText = aiReply.trim();
      } else {
        replyText =
          "Hi 👋 I’m Saka360. How can I help you with your vehicles and drivers today?";
      }
    }

    await logChatTurn(from, "assistant", replyText);

    console.log("💬 Reply:", replyText);

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

// ====== START SERVER ======
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
  console.log(`🚀 Saka360 backend listening on port ${serverPort}`);
});
