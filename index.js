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

// ====== TABLE ENSURERS ======

// chat_turns – memory of conversation
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

// vehicle_documents + sessions
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
        ADD COLUMN IF NOT EXISTS user_whatsapp   TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id      INTEGER,
        ADD COLUMN IF NOT EXISTS step            TEXT,
        ADD COLUMN IF NOT EXISTS title           TEXT,
        ADD COLUMN IF NOT EXISTS cost            NUMERIC,
        ADD COLUMN IF NOT EXISTS expiry_date     DATE,
        ADD COLUMN IF NOT EXISTS notes           TEXT,
        ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    console.log("📄 vehicle_documents & vehicle_document_sessions tables are ready.");
  } catch (err) {
    console.error("❌ Error ensuring vehicle document tables:", err.message);
  }
}
ensureVehicleDocumentTables();

// personal_documents + sessions – FINAL version (with user_whatsapp)
async function ensurePersonalDocumentsTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS personal_documents (
        id              SERIAL PRIMARY KEY,
        user_whatsapp   TEXT NOT NULL,
        owner_whatsapp  TEXT,
        driver_whatsapp TEXT,
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
      ALTER TABLE personal_documents
        ADD COLUMN IF NOT EXISTS user_whatsapp   TEXT,
        ADD COLUMN IF NOT EXISTS owner_whatsapp  TEXT,
        ADD COLUMN IF NOT EXISTS driver_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS driver_id       INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS doc_title       TEXT,
        ADD COLUMN IF NOT EXISTS doc_type        TEXT,
        ADD COLUMN IF NOT EXISTS cost_amount     NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS currency        TEXT NOT NULL DEFAULT 'KES',
        ADD COLUMN IF NOT EXISTS expiry_date     DATE,
        ADD COLUMN IF NOT EXISTS notes           TEXT,
        ADD COLUMN IF NOT EXISTS reminder_id     INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
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

    await pool.query(`
      ALTER TABLE personal_document_sessions
        ADD COLUMN IF NOT EXISTS user_whatsapp   TEXT,
        ADD COLUMN IF NOT EXISTS step            TEXT,
        ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN IF NOT EXISTS doc_title       TEXT,
        ADD COLUMN IF NOT EXISTS doc_type        TEXT,
        ADD COLUMN IF NOT EXISTS cost_amount     NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS expiry_date     DATE,
        ADD COLUMN IF NOT EXISTS notes           TEXT,
        ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    console.log("📄 personal_documents & personal_document_sessions tables are ready.");
  } catch (err) {
    console.error("❌ Error ensuring personal_documents tables:", err.message);
  }
}
ensurePersonalDocumentsTables();

// expense_logs + sessions
async function ensureExpenseTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expense_logs (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER,
        driver_id     INTEGER,
        title         TEXT,
        amount        NUMERIC(12,2),
        odometer      NUMERIC,
        notes         TEXT,
        message_text  TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE expense_logs
        ADD COLUMN IF NOT EXISTS user_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id    INTEGER,
        ADD COLUMN IF NOT EXISTS driver_id     INTEGER,
        ADD COLUMN IF NOT EXISTS title         TEXT,
        ADD COLUMN IF NOT EXISTS amount        NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS odometer      NUMERIC,
        ADD COLUMN IF NOT EXISTS notes         TEXT,
        ADD COLUMN IF NOT EXISTS message_text  TEXT,
        ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expense_sessions (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER NOT NULL,
        step          TEXT NOT NULL,
        title         TEXT,
        amount        NUMERIC(12,2),
        odometer      NUMERIC,
        notes         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE expense_sessions
        ADD COLUMN IF NOT EXISTS user_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id    INTEGER,
        ADD COLUMN IF NOT EXISTS step          TEXT,
        ADD COLUMN IF NOT EXISTS title         TEXT,
        ADD COLUMN IF NOT EXISTS amount        NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS odometer      NUMERIC,
        ADD COLUMN IF NOT EXISTS notes         TEXT,
        ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
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

  // Split by "|" (preferred), fall back to "," if needed
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
    // Assume Kenyan 07XXXXXXXX
    if (digits.length === 10 && digits.startsWith("0")) {
      return `whatsapp:+254${digits.slice(1)}`;
    }
    if (digits.length === 12 && digits.startsWith("254")) {
      return `whatsapp:+${digits}`;
    }
    return `whatsapp:+${digits}`;
  }

  const driverWhatsapp = toWhatsAppNumber(rawPhone);

  // Upsert-ish: if same owner + driver_whatsapp exists, just update name
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

  // Notify driver via WhatsApp
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

  // Expect format: dl main YYYY-MM-DD
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
// ====== PART 4 / 4 – Fuel, Service, Expense, Documents, AI & Main Route ======

// ---------- FUEL & SERVICE TABLES ----------

async function ensureFuelTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fuel_logs (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER,
        driver_id     INTEGER,
        amount        NUMERIC(12,2),
        litres        NUMERIC(12,3),
        odometer      NUMERIC,
        station       TEXT,
        notes         TEXT,
        message_text  TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE fuel_logs
        ADD COLUMN IF NOT EXISTS user_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id    INTEGER,
        ADD COLUMN IF NOT EXISTS driver_id     INTEGER,
        ADD COLUMN IF NOT EXISTS amount        NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS litres        NUMERIC(12,3),
        ADD COLUMN IF NOT EXISTS odometer      NUMERIC,
        ADD COLUMN IF NOT EXISTS station       TEXT,
        ADD COLUMN IF NOT EXISTS notes         TEXT,
        ADD COLUMN IF NOT EXISTS message_text  TEXT,
        ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fuel_sessions (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER NOT NULL,
        step          TEXT NOT NULL,
        amount        NUMERIC(12,2),
        litres        NUMERIC(12,3),
        odometer      NUMERIC,
        station       TEXT,
        notes         TEXT,
        status        TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE fuel_sessions
        ADD COLUMN IF NOT EXISTS user_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id    INTEGER,
        ADD COLUMN IF NOT EXISTS step          TEXT,
        ADD COLUMN IF NOT EXISTS amount        NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS litres        NUMERIC(12,3),
        ADD COLUMN IF NOT EXISTS odometer      NUMERIC,
        ADD COLUMN IF NOT EXISTS station       TEXT,
        ADD COLUMN IF NOT EXISTS notes         TEXT,
        ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    console.log("⛽ fuel_logs & fuel_sessions tables are ready.");
  } catch (err) {
    console.error("❌ Error ensuring fuel tables:", err.message);
  }
}
ensureFuelTables();

async function ensureServiceTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_logs (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER,
        driver_id     INTEGER,
        service_type  TEXT,
        cost_amount   NUMERIC(12,2),
        odometer      NUMERIC,
        notes         TEXT,
        message_text  TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE service_logs
        ADD COLUMN IF NOT EXISTS user_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id    INTEGER,
        ADD COLUMN IF NOT EXISTS driver_id     INTEGER,
        ADD COLUMN IF NOT EXISTS service_type  TEXT,
        ADD COLUMN IF NOT EXISTS cost_amount   NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS odometer      NUMERIC,
        ADD COLUMN IF NOT EXISTS notes         TEXT,
        ADD COLUMN IF NOT EXISTS message_text  TEXT,
        ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_sessions (
        id            SERIAL PRIMARY KEY,
        user_whatsapp TEXT NOT NULL,
        vehicle_id    INTEGER NOT NULL,
        step          TEXT NOT NULL,
        service_type  TEXT,
        cost_amount   NUMERIC(12,2),
        odometer      NUMERIC,
        notes         TEXT,
        status        TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE service_sessions
        ADD COLUMN IF NOT EXISTS user_whatsapp TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_id    INTEGER,
        ADD COLUMN IF NOT EXISTS step          TEXT,
        ADD COLUMN IF NOT EXISTS service_type  TEXT,
        ADD COLUMN IF NOT EXISTS cost_amount   NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS odometer      NUMERIC,
        ADD COLUMN IF NOT EXISTS notes         TEXT,
        ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    console.log("🛠️ service_logs & service_sessions tables are ready.");
  } catch (err) {
    console.error("❌ Error ensuring service tables:", err.message);
  }
}
ensureServiceTables();

// ---------- SESSION HELPERS (FUEL / SERVICE / EXPENSE / PERSONAL DOC) ----------

async function getActiveFuelSession(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM fuel_sessions
    WHERE user_whatsapp = $1
      AND status = 'ACTIVE'
    ORDER BY id DESC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  return res.rows[0] || null;
}

async function getActiveServiceSession(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM service_sessions
    WHERE user_whatsapp = $1
      AND status = 'ACTIVE'
    ORDER BY id DESC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  return res.rows[0] || null;
}

async function getActiveExpenseSession(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM expense_sessions
    WHERE user_whatsapp = $1
    ORDER BY id DESC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  const s = res.rows[0];
  if (!s) return null;
  return s;
}

async function clearExpenseSession(userWhatsapp) {
  await pool.query(
    `
    DELETE FROM expense_sessions
    WHERE user_whatsapp = $1
  `,
    [userWhatsapp]
  );
}

async function getActivePersonalDocumentSession(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT *
    FROM personal_document_sessions
    WHERE user_whatsapp = $1
      AND status = 'ACTIVE'
    ORDER BY id DESC
    LIMIT 1
  `,
    [userWhatsapp]
  );
  return res.rows[0] || null;
}

async function clearPersonalDocumentSession(userWhatsapp) {
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
}

// Cancel all sessions of any type
async function clearAllSessions(userWhatsapp) {
  await Promise.all([
    clearPersonalDocumentSession(userWhatsapp),
    clearExpenseSession(userWhatsapp),
    pool.query(
      `
      UPDATE fuel_sessions
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE user_whatsapp = $1
        AND status = 'ACTIVE'
    `,
      [userWhatsapp]
    ),
    pool.query(
      `
      UPDATE service_sessions
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE user_whatsapp = $1
        AND status = 'ACTIVE'
    `,
      [userWhatsapp]
    ),
    pool.query(
      `
      UPDATE vehicle_document_sessions
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE user_whatsapp = $1
        AND status = 'active'
    `,
      [userWhatsapp]
    ),
  ]);
}

// ---------- FUEL FLOW ----------

async function handleFuelIntent(userWhatsapp) {
  const vRes = await ensureCurrentVehicle(userWhatsapp);
  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with:\n" +
      "*add vehicle KDA 123A*"
    );
  }
  if (vRes.status === "NEED_SET_CURRENT") {
    const list = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles.\n\n" +
      list +
      "\n\nSet one as current with *switch to 1* (for example), then send *fuel* again."
    );
  }

  const vehicle = vRes.vehicle;

  // Create new session
  await pool.query(
    `
    INSERT INTO fuel_sessions (user_whatsapp, vehicle_id, step)
    VALUES ($1, $2, 'amount')
  `,
    [userWhatsapp, vehicle.id]
  );

  return (
    "⛽ Let's log fuel for *" +
    vehicle.registration +
    "*.\n" +
    "How much did you pay for this fuel? (KES)\n" +
    "Example: *3000*"
  );
}

async function handleFuelSessionStep(userWhatsapp, text, session) {
  const lower = text.trim().toLowerCase();

  if (lower === "cancel") {
    await clearAllSessions(userWhatsapp);
    return (
      "✅ I’ve cancelled your current entry.\n" +
      "You can start again with *fuel*, *service*, or *expense*."
    );
  }

  if (session.step === "amount") {
    const amount = parseNumber(text);
    if (isNaN(amount) || amount <= 0) {
      return (
        "Please send the fuel *amount* in KES.\n" +
        "Example: *3000*"
      );
    }

    await pool.query(
      `
      UPDATE fuel_sessions
      SET amount = $1,
          step = 'litres',
          updated_at = NOW()
      WHERE id = $2
    `,
      [amount, session.id]
    );

    return (
      "How many *litres* did you buy?\n" +
      "Example: *25*\n\n" +
      "Reply *skip* if you're not sure."
    );
  }

  if (session.step === "litres") {
    let litres = null;
    if (lower !== "skip") {
      litres = parseNumber(text);
      if (isNaN(litres) || litres <= 0) {
        return (
          "Please send the litres as a number.\n" +
          "Example: *25*\n\n" +
          "Or reply *skip*."
        );
      }
    }

    await pool.query(
      `
      UPDATE fuel_sessions
      SET litres = $1,
          step = 'odometer',
          updated_at = NOW()
      WHERE id = $2
    `,
      [litres, session.id]
    );

    return (
      "What was the *odometer reading* at this fuel stop?\n" +
      "Example: *145000*\n\n" +
      "Reply *skip* if you don't want to record the odometer."
    );
  }

  if (session.step === "odometer") {
    let odometer = null;
    if (lower !== "skip") {
      odometer = parseNumber(text);
      if (isNaN(odometer) || odometer < 0) {
        return (
          "Please send the odometer reading as a number.\n" +
          "Example: *145000*\n\n" +
          "Or reply *skip*."
        );
      }
    }

    await pool.query(
      `
      UPDATE fuel_sessions
      SET odometer = $1,
          step = 'station',
          updated_at = NOW()
      WHERE id = $2
    `,
      [odometer, session.id]
    );

    return (
      "Where did you fuel? (station or place)\n" +
      "Example: *Shell Yaya* or *Total Mombasa Road*\n\n" +
      "Reply *skip* to leave blank."
    );
  }

  if (session.step === "station") {
    let station = null;
    if (lower !== "skip") {
      station = text.trim();
    }

    await pool.query(
      `
      UPDATE fuel_sessions
      SET station = $1,
          step = 'notes',
          updated_at = NOW()
      WHERE id = $2
    `,
      [station, session.id]
    );

    return (
      "Any notes about this fuel stop?\n" +
      "Example: *Full tank*, *after trip*, etc.\n\n" +
      "Reply *skip* to leave notes blank."
    );
  }

  if (session.step === "notes") {
    let notes = null;
    if (lower !== "skip") {
      notes = text.trim();
    }

    const res = await pool.query(
      `
      UPDATE fuel_sessions
      SET notes = $1,
          step = 'confirm',
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
      [notes, session.id]
    );

    const s = res.rows[0];
    const vRes = await pool.query(
      `SELECT registration FROM vehicles WHERE id = $1`,
      [s.vehicle_id]
    );
    const reg = vRes.rows[0] ? vRes.rows[0].registration : "your vehicle";

    const amount = s.amount || 0;
    const amountStr = Number(amount).toFixed(2);
    const litres = s.litres != null ? Number(s.litres).toFixed(2) : "n/a";
    const odo = s.odometer != null ? s.odometer : "n/a";
    const station = s.station || "n/a";
    const notesStr = s.notes || "n/a";

    return (
      "Please confirm this fuel entry:\n" +
      "Vehicle: *" + reg + "*\n" +
      "Amount: *" + amountStr + "* KES\n" +
      "Litres: *" + litres + "*\n" +
      "Odometer: *" + odo + "*\n" +
      "Station: *" + station + "*\n" +
      "Notes: " + notesStr + "\n\n" +
      "Reply *YES* to save or *NO* to cancel."
    );
  }

  if (session.step === "confirm") {
    if (lower === "yes") {
      // Load full latest session
      const res = await pool.query(
        `SELECT * FROM fuel_sessions WHERE id = $1`,
        [session.id]
      );
      const s = res.rows[0];

      try {
        await pool.query(
          `
          INSERT INTO fuel_logs (
            user_whatsapp,
            vehicle_id,
            driver_id,
            amount,
            litres,
            odometer,
            station,
            notes,
            message_text
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
          [
            s.user_whatsapp,
            s.vehicle_id,
            null,
            s.amount,
            s.litres,
            s.odometer,
            s.station,
            s.notes,
            null,
          ]
        );
      } catch (err) {
        console.error("❌ Error saving fuel log:", err.message);
        await pool.query(
          `UPDATE fuel_sessions SET status = 'ERROR', updated_at = NOW() WHERE id = $1`,
          [session.id]
        );
        return (
          "Sorry, I couldn't save that fuel entry due to a system error.\n" +
          "Please try again later."
        );
      }

      await pool.query(
        `
        UPDATE fuel_sessions
        SET status = 'DONE',
            updated_at = NOW()
        WHERE id = $1
      `,
        [session.id]
      );

      return "✅ Fuel entry saved.\nYou can log another one any time with *fuel*.";
    }

    if (lower === "no") {
      await pool.query(
        `
        UPDATE fuel_sessions
        SET status = 'CANCELLED',
            updated_at = NOW()
        WHERE id = $1
      `,
        [session.id]
      );
      return "Okay, I’ve cancelled that fuel entry.\nYou can start again with *fuel*.";
    }

    return "Please reply *YES* to save or *NO* to cancel this fuel entry.";
  }

  // Fallback
  return "Something went wrong in this fuel entry. Please start again with *fuel*.";
}

// ---------- SERVICE FLOW ----------

async function handleServiceIntent(userWhatsapp) {
  const vRes = await ensureCurrentVehicle(userWhatsapp);
  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with:\n" +
      "*add vehicle KDA 123A*"
    );
  }
  if (vRes.status === "NEED_SET_CURRENT") {
    const list = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles.\n\n" +
      list +
      "\n\nSet one as current with *switch to 1* (for example), then send *service* again."
    );
  }

  const vehicle = vRes.vehicle;

  await pool.query(
    `
    INSERT INTO service_sessions (user_whatsapp, vehicle_id, step)
    VALUES ($1, $2, 'type')
  `,
    [userWhatsapp, vehicle.id]
  );

  return (
    "🛠️ Let's log a service for *" +
    vehicle.registration +
    "*.\n" +
    "What type of service was this?\n" +
    "Examples: *Minor service*, *Major service*, *Brake pads*, etc."
  );
}

async function handleServiceSessionStep(userWhatsapp, text, session) {
  const lower = text.trim().toLowerCase();

  if (lower === "cancel") {
    await clearAllSessions(userWhatsapp);
    return (
      "✅ I’ve cancelled your current entry.\n" +
      "You can start again with *fuel*, *service*, or *expense*."
    );
  }

  if (session.step === "type") {
    const stype = text.trim();
    if (!stype) {
      return "Please describe the service, e.g. *Minor service*, *Brake pads*, etc.";
    }

    await pool.query(
      `
      UPDATE service_sessions
      SET service_type = $1,
          step = 'cost',
          updated_at = NOW()
      WHERE id = $2
    `,
      [stype, session.id]
    );

    return (
      "How much did this service cost? (KES)\n" +
      "Example: *8000*\n\n" +
      "Reply *0* if you don't want to record the cost."
    );
  }

  if (session.step === "cost") {
    const amount = parseNumber(text);
    if (isNaN(amount) || amount < 0) {
      return (
        "Please send the service cost in KES as a number.\n" +
        "Example: *8000*\n\n" +
        "Or *0* if you don't want to record the cost."
      );
    }

    await pool.query(
      `
      UPDATE service_sessions
      SET cost_amount = $1,
          step = 'odometer',
          updated_at = NOW()
      WHERE id = $2
    `,
      [amount, session.id]
    );

    return (
      "What was the *odometer reading* at this service?\n" +
      "Example: *150000*\n\n" +
      "Reply *skip* if you don't want to record the odometer."
    );
  }

  if (session.step === "odometer") {
    let odometer = null;
    if (lower !== "skip") {
      odometer = parseNumber(text);
      if (isNaN(odometer) || odometer < 0) {
        return (
          "Please send the odometer reading as a number.\n" +
          "Example: *150000*\n\n" +
          "Or reply *skip*."
        );
      }
    }

    await pool.query(
      `
      UPDATE service_sessions
      SET odometer = $1,
          step = 'notes',
          updated_at = NOW()
      WHERE id = $2
    `,
      [odometer, session.id]
    );

    return (
      "Any notes about this service?\n" +
      "Example: *Changed oil + filters*, *Front brake pads*, etc.\n\n" +
      "Reply *skip* to leave blank."
    );
  }

  if (session.step === "notes") {
    let notes = null;
    if (lower !== "skip") {
      notes = text.trim();
    }

    const res = await pool.query(
      `
      UPDATE service_sessions
      SET notes = $1,
          step = 'confirm',
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
      [notes, session.id]
    );

    const s = res.rows[0];
    const vRes = await pool.query(
      `SELECT registration FROM vehicles WHERE id = $1`,
      [s.vehicle_id]
    );
    const reg = vRes.rows[0] ? vRes.rows[0].registration : "your vehicle";

    const cost = s.cost_amount || 0;
    const costStr = Number(cost).toFixed(2);
    const odo = s.odometer != null ? s.odometer : "n/a";
    const notesStr = s.notes || "n/a";

    return (
      "Please confirm this service entry:\n" +
      "Vehicle: *" + reg + "*\n" +
      "Type: *" + (s.service_type || "Service") + "*\n" +
      "Cost: *" + costStr + "* KES\n" +
      "Odometer: *" + odo + "*\n" +
      "Notes: " + notesStr + "\n\n" +
      "Reply *YES* to save or *NO* to cancel."
    );
  }

  if (session.step === "confirm") {
    if (lower === "yes") {
      const res = await pool.query(
        `SELECT * FROM service_sessions WHERE id = $1`,
        [session.id]
      );
      const s = res.rows[0];

      try {
        await pool.query(
          `
          INSERT INTO service_logs (
            user_whatsapp,
            vehicle_id,
            driver_id,
            service_type,
            cost_amount,
            odometer,
            notes,
            message_text
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
          [
            s.user_whatsapp,
            s.vehicle_id,
            null,
            s.service_type,
            s.cost_amount,
            s.odometer,
            s.notes,
            null,
          ]
        );
      } catch (err) {
        console.error("❌ Error saving service log:", err.message);
        await pool.query(
          `UPDATE service_sessions SET status = 'ERROR', updated_at = NOW() WHERE id = $1`,
          [session.id]
        );
        return (
          "Sorry, I couldn't save that service entry due to a system error.\n" +
          "Please try again later."
        );
      }

      await pool.query(
        `
        UPDATE service_sessions
        SET status = 'DONE',
            updated_at = NOW()
        WHERE id = $1
      `,
        [session.id]
      );

      return "✅ Service entry saved.\nYou can log another one any time with *service*.";
    }

    if (lower === "no") {
      await pool.query(
        `
        UPDATE service_sessions
        SET status = 'CANCELLED',
            updated_at = NOW()
        WHERE id = $1
      `,
        [session.id]
      );
      return "Okay, I’ve cancelled that service entry.\nYou can start again with *service*.";
    }

    return "Please reply *YES* to save or *NO* to cancel this service entry.";
  }

  return "Something went wrong in this service entry. Please start again with *service*.";
}

// ---------- EXPENSE FLOW & REPORT ----------

async function handleExpenseIntent(userWhatsapp) {
  const vRes = await ensureCurrentVehicle(userWhatsapp);
  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with:\n" +
      "*add vehicle KDA 123A*"
    );
  }
  if (vRes.status === "NEED_SET_CURRENT") {
    const list = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles.\n\n" +
      list +
      "\n\nSet one as current with *switch to 1* (for example), then send *expense* again."
    );
  }

  const vehicle = vRes.vehicle;

  await pool.query(
    `
    INSERT INTO expense_sessions (user_whatsapp, vehicle_id, step)
    VALUES ($1, $2, 'title')
  `,
    [userWhatsapp, vehicle.id]
  );

  return (
    "💸 Let's log an expense for *" +
    vehicle.registration +
    "*.\n" +
    "What was this expense for?\n" +
    "Example: *Parking at Yaya*, *Tyres*, *Car wash*"
  );
}

async function handleExpenseSessionStep(userWhatsapp, text, session) {
  const lower = text.trim().toLowerCase();

  if (lower === "cancel") {
    await clearAllSessions(userWhatsapp);
    return (
      "✅ I’ve cancelled your current entry.\n" +
      "You can start again with *fuel*, *service*, or *expense*."
    );
  }

  if (session.step === "title") {
    const title = text.trim();
    if (!title) {
      return (
        "Please describe the expense.\n" +
        "Example: *Parking at Yaya*, *Tyres*, *Car wash*"
      );
    }

    await pool.query(
      `
      UPDATE expense_sessions
      SET title = $1,
          step = 'amount',
          updated_at = NOW()
      WHERE id = $2
    `,
      [title, session.id]
    );

    return (
      "How much did you pay for this expense? (KES)\n" +
      "Example: *1500*"
    );
  }

  if (session.step === "amount") {
    const amount = parseNumber(text);
    if (isNaN(amount) || amount <= 0) {
      return (
        "Please send the expense *amount* in KES.\n" +
        "Example: *1500*"
      );
    }

    await pool.query(
      `
      UPDATE expense_sessions
      SET amount = $1,
          step = 'odometer',
          updated_at = NOW()
      WHERE id = $2
    `,
      [amount, session.id]
    );

    return (
      "What was the *odometer reading* when this expense happened?\n" +
      "Example: *145000*\n\n" +
      "Reply *skip* if the odometer is not relevant."
    );
  }

  if (session.step === "odometer") {
    let odometer = null;
    if (lower !== "skip") {
      odometer = parseNumber(text);
      if (isNaN(odometer) || odometer < 0) {
        return (
          "Please send the odometer reading as a number.\n" +
          "Example: *145000*\n\n" +
          "Or reply *skip*."
        );
      }
    }

    await pool.query(
      `
      UPDATE expense_sessions
      SET odometer = $1,
          step = 'notes',
          updated_at = NOW()
      WHERE id = $2
    `,
      [odometer, session.id]
    );

    return (
      "Any notes about this expense?\n" +
      "Example: *Parking for town meeting*, *New rear tyre*, etc.\n\n" +
      "Reply *skip* to leave notes blank."
    );
  }

  if (session.step === "notes") {
    let notes = null;
    if (lower !== "skip") {
      notes = text.trim();
    }

    const res = await pool.query(
      `
      UPDATE expense_sessions
      SET notes = $1,
          step = 'confirm',
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
      [notes, session.id]
    );

    const s = res.rows[0];

    const vRes = await pool.query(
      `SELECT registration FROM vehicles WHERE id = $1`,
      [s.vehicle_id]
    );
    const reg = vRes.rows[0] ? vRes.rows[0].registration : "your vehicle";

    const amount = s.amount || 0;
    const amountStr = Number(amount).toFixed(2);
    const odo = s.odometer != null ? s.odometer : "n/a";
    const notesStr = s.notes || "n/a";

    return (
      "Please confirm this expense entry:\n" +
      "Vehicle: *" + reg + "*\n" +
      "Title: *" + (s.title || "Expense") + "*\n" +
      "Amount: *" + amountStr + "* KES\n" +
      "Odometer: *" + odo + "*\n" +
      "Notes: " + notesStr + "\n\n" +
      "Reply *YES* to save or *NO* to cancel."
    );
  }

  if (session.step === "confirm") {
    if (lower === "yes") {
      const res = await pool.query(
        `SELECT * FROM expense_sessions WHERE id = $1`,
        [session.id]
      );
      const s = res.rows[0];

      try {
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
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
          [
            s.user_whatsapp,
            s.vehicle_id,
            null,
            s.title,
            s.amount,
            s.odometer,
            s.notes,
            null,
          ]
        );
      } catch (err) {
        console.error("❌ Error saving expense log:", err.message);
        return (
          "Sorry, I couldn't save that expense entry due to a system error.\n" +
          "Please try again later."
        );
      }

      await clearExpenseSession(userWhatsapp);

      return "✅ Expense entry saved.\nYou can log another one any time with *expense*.";
    }

    if (lower === "no") {
      await clearExpenseSession(userWhatsapp);
      return "Okay, I’ve cancelled that expense entry.\nYou can start again with *expense*.";
    }

    return "Please reply *YES* to save or *NO* to cancel this expense entry.";
  }

  return "Something went wrong in this expense entry. Please start again with *expense*.";
}

async function buildExpenseReport(userWhatsapp, scope) {
  // scope: "vehicle" | "all"
  let whereClause = "user_whatsapp = $1";
  const params = [userWhatsapp];

  if (scope === "vehicle") {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "NO_VEHICLES") {
      return (
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*"
      );
    }
    if (vRes.status === "NEED_SET_CURRENT") {
      const list = formatVehiclesList(vRes.list, true);
      return (
        "You have multiple vehicles. Please set your current vehicle first.\n\n" +
        list +
        "\n\nUse *switch to 1* (for example), then send *expense report* again."
      );
    }
    const vehicle = vRes.vehicle;
    whereClause += " AND vehicle_id = $2";
    params.push(vehicle.id);
  }

  const statsSql = `
    SELECT
      COUNT(*)::INT AS cnt,
      COALESCE(SUM(amount),0)::NUMERIC(12,2) AS total,
      COALESCE(AVG(amount),0)::NUMERIC(12,2) AS avg,
      MIN(created_at) AS first_ts,
      MAX(created_at) AS last_ts
    FROM expense_logs
    WHERE ${whereClause}
  `;

  const statsRes = await pool.query(statsSql, params);
  const stats = statsRes.rows[0];

  if (!stats || stats.cnt === 0) {
    if (scope === "vehicle") {
      return (
        "You have no *expense* entries yet for your current vehicle.\n\n" +
        "Log one with *expense*."
      );
    }
    return (
      "You have no *expense* entries yet across your vehicles.\n\n" +
      "Log one with *expense*."
    );
  }

  const last5Sql = `
    SELECT
      e.*,
      v.registration
    FROM expense_logs e
    LEFT JOIN vehicles v
      ON v.id = e.vehicle_id
    WHERE ${whereClause}
    ORDER BY e.created_at DESC
    LIMIT 5
  `;

  const last5Res = await pool.query(last5Sql, params);
  const rows = last5Res.rows;

  let titleLine =
    scope === "vehicle"
      ? "💸 *Expense summary – current vehicle*"
      : "💸 *Expense summary – all vehicles*";

  if (scope === "vehicle") {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "OK" && vRes.vehicle) {
      titleLine =
        "💸 *Expense summary – " + vRes.vehicle.registration + "*";
    }
  }

  const periodStart = stats.first_ts
    ? String(stats.first_ts).slice(0, 10)
    : "-";
  const periodEnd = stats.last_ts ? String(stats.last_ts).slice(0, 10) : "-";
  const totalStr = Number(stats.total || 0).toFixed(2);
  const avgStr = Number(stats.avg || 0).toFixed(2);

  let text = titleLine + "\n";
  text +=
    "Period: *" +
    periodStart +
    "* → *" +
    periodEnd +
    "*\n" +
    "Expenses: *" +
    stats.cnt +
    "*\n" +
    "Total amount: *" +
    totalStr +
    "* KES\n" +
    "Average per expense: *" +
    avgStr +
    "* KES\n";

  text += "\n💸 *Last 5 expenses*:\n";
  for (const r of rows) {
    const d = r.created_at ? String(r.created_at).slice(0, 10) : "";
    const amtStr = Number(r.amount || 0).toFixed(2);
    const title = r.title || "Expense";
    const odo =
      r.odometer != null && r.odometer !== ""
        ? " @ *" + Number(r.odometer).toFixed(2) + "* km"
        : "";
    const reg = r.registration ? " – " + r.registration : "";
    text +=
      "• " +
      d +
      " – *" +
      amtStr +
      "* KES – " +
      title +
      odo +
      reg +
      "\n";
  }

  if (scope === "all") {
    const topSql = `
      SELECT
        v.registration,
        COALESCE(SUM(e.amount),0)::NUMERIC(12,2) AS total
      FROM expense_logs e
      LEFT JOIN vehicles v
        ON v.id = e.vehicle_id
      WHERE e.user_whatsapp = $1
      GROUP BY v.registration
      ORDER BY total DESC
      LIMIT 5
    `;
    const topRes = await pool.query(topSql, [userWhatsapp]);
    const tops = topRes.rows;

    if (tops.length > 0) {
      text += "\n🚗 *Top vehicles by other expenses*:\n";
      for (const t of tops) {
        const reg = t.registration || "Unassigned";
        const tStr = Number(t.total || 0).toFixed(2);
        text += "• *" + reg + "* – *" + tStr + "* KES total\n";
      }
    }
  }

  text +=
    "\nYou can log a new expense anytime with *expense*.\n" +
    "Use *expense report* for the current vehicle, or *expense report all* for your whole fleet.";

  return text;
}

// ---------- SERVICE REPORT ----------

async function buildServiceReport(userWhatsapp, scope) {
  let whereClause = "user_whatsapp = $1";
  const params = [userWhatsapp];

  if (scope === "vehicle") {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "NO_VEHICLES") {
      return (
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*"
      );
    }
    if (vRes.status === "NEED_SET_CURRENT") {
      const list = formatVehiclesList(vRes.list, true);
      return (
        "You have multiple vehicles. Please set your current vehicle first.\n\n" +
        list +
        "\n\nUse *switch to 1* (for example), then send *service report* again."
      );
    }
    const vehicle = vRes.vehicle;
    whereClause += " AND vehicle_id = $2";
    params.push(vehicle.id);
  }

  const statsSql = `
    SELECT
      COUNT(*)::INT AS cnt,
      COALESCE(SUM(cost_amount),0)::NUMERIC(12,2) AS total,
      COALESCE(AVG(cost_amount),0)::NUMERIC(12,2) AS avg,
      MIN(created_at) AS first_ts,
      MAX(created_at) AS last_ts
    FROM service_logs
    WHERE ${whereClause}
  `;
  const statsRes = await pool.query(statsSql, params);
  const stats = statsRes.rows[0];

  if (!stats || stats.cnt === 0) {
    if (scope === "vehicle") {
      return (
        "You have no *service* entries yet for your current vehicle.\n\n" +
        "Log one with *service*."
      );
    }
    return (
      "You have no *service* entries yet across your vehicles.\n\n" +
      "Log one with *service*."
    );
  }

  const last5Sql = `
    SELECT
      s.*,
      v.registration
    FROM service_logs s
    LEFT JOIN vehicles v
      ON v.id = s.vehicle_id
    WHERE ${whereClause}
    ORDER BY s.created_at DESC
    LIMIT 5
  `;
  const last5Res = await pool.query(last5Sql, params);
  const rows = last5Res.rows;

  let titleLine =
    scope === "vehicle"
      ? "📊 *Service summary – current vehicle*"
      : "📊 *Service summary – all vehicles*";

  if (scope === "vehicle") {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "OK" && vRes.vehicle) {
      titleLine = "📊 *Service summary – " + vRes.vehicle.registration + "*";
    }
  }

  const periodStart = stats.first_ts
    ? String(stats.first_ts).slice(0, 10)
    : "-";
  const periodEnd = stats.last_ts ? String(stats.last_ts).slice(0, 10) : "-";
  const totalStr = Number(stats.total || 0).toFixed(2);
  const avgStr = Number(stats.avg || 0).toFixed(2);

  let text = titleLine + "\n";
  text +=
    "Period: *" +
    periodStart +
    "* → *" +
    periodEnd +
    "*\n" +
    "Services: *" +
    stats.cnt +
    "*\n" +
    "Total service cost: *" +
    totalStr +
    "* KES\n" +
    "Average per service: *" +
    avgStr +
    "* KES\n";

  text += "\n🛠️ *Last 5 services*:\n";
  for (const r of rows) {
    const d = r.created_at ? String(r.created_at).slice(0, 10) : "";
    const amtStr = Number(r.cost_amount || 0).toFixed(2);
    const stype = r.service_type || "Service";
    const odo =
      r.odometer != null && r.odometer !== ""
        ? " @ *" + Number(r.odometer).toFixed(2) + "* km"
        : "";
    const reg = r.registration ? " – " + r.registration : "";
    text +=
      "• " +
      d +
      " – *" +
      amtStr +
      "* KES – " +
      stype +
      odo +
      reg +
      "\n";
  }

  text +=
    "\nYou can log a new service anytime with *service*.\n" +
    "Use *service report* for the current vehicle, or *service report all* for your whole fleet.";

  return text;
}

// ---------- FUEL REPORT ----------

async function buildFuelReport(userWhatsapp, scope) {
  let whereClause = "user_whatsapp = $1";
  const params = [userWhatsapp];

  if (scope === "vehicle") {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "NO_VEHICLES") {
      return (
        "You don't have any vehicles yet.\n\n" +
        "Add one with:\n" +
        "*add vehicle KDA 123A*"
      );
    }
    if (vRes.status === "NEED_SET_CURRENT") {
      const list = formatVehiclesList(vRes.list, true);
      return (
        "You have multiple vehicles. Please set your current vehicle first.\n\n" +
        list +
        "\n\nUse *switch to 1* (for example), then send *fuel report* again."
      );
    }
    const vehicle = vRes.vehicle;
    whereClause += " AND vehicle_id = $2";
    params.push(vehicle.id);
  }

  const statsSql = `
    SELECT
      COUNT(*)::INT AS cnt,
      COALESCE(SUM(amount),0)::NUMERIC(12,2) AS total,
      COALESCE(SUM(litres),0)::NUMERIC(12,3) AS total_litres,
      MIN(created_at) AS first_ts,
      MAX(created_at) AS last_ts
    FROM fuel_logs
    WHERE ${whereClause}
  `;
  const statsRes = await pool.query(statsSql, params);
  const stats = statsRes.rows[0];

  if (!stats || stats.cnt === 0) {
    if (scope === "vehicle") {
      return (
        "You have no *fuel* entries yet for your current vehicle.\n\n" +
        "Log one with *fuel*."
      );
    }
    return (
      "You have no *fuel* entries yet across your vehicles.\n\n" +
      "Log one with *fuel*."
    );
  }

  const last5Sql = `
    SELECT
      f.*,
      v.registration
    FROM fuel_logs f
    LEFT JOIN vehicles v
      ON v.id = f.vehicle_id
    WHERE ${whereClause}
    ORDER BY f.created_at DESC
    LIMIT 5
  `;
  const last5Res = await pool.query(last5Sql, params);
  const rows = last5Res.rows;

  let titleLine =
    scope === "vehicle"
      ? "⛽ *Fuel summary – current vehicle*"
      : "⛽ *Fuel summary – all vehicles*";

  if (scope === "vehicle") {
    const vRes = await ensureCurrentVehicle(userWhatsapp);
    if (vRes.status === "OK" && vRes.vehicle) {
      titleLine = "⛽ *Fuel summary – " + vRes.vehicle.registration + "*";
    }
  }

  const periodStart = stats.first_ts
    ? String(stats.first_ts).slice(0, 10)
    : "-";
  const periodEnd = stats.last_ts ? String(stats.last_ts).slice(0, 10) : "-";
  const totalStr = Number(stats.total || 0).toFixed(2);
  const totalLitres = Number(stats.total_litres || 0).toFixed(2);
  const avgPerFill =
    stats.cnt > 0
      ? Number((stats.total || 0) / stats.cnt).toFixed(2)
      : "0.00";

  let text = titleLine + "\n";
  text +=
    "Period: *" +
    periodStart +
    "* → *" +
    periodEnd +
    "*\n" +
    "Fuel stops: *" +
    stats.cnt +
    "*\n" +
    "Total fuel spend: *" +
    totalStr +
    "* KES\n" +
    "Total litres: *" +
    totalLitres +
    "*\n" +
    "Average spend per fuel stop: *" +
    avgPerFill +
    "* KES\n";

  text += "\n⛽ *Last 5 fuel entries*:\n";
  for (const r of rows) {
    const d = r.created_at ? String(r.created_at).slice(0, 10) : "";
    const amtStr = Number(r.amount || 0).toFixed(2);
    const litresStr =
      r.litres != null ? Number(r.litres).toFixed(2) + " L" : "n/a";
    const odo =
      r.odometer != null && r.odometer !== ""
        ? " @ *" + Number(r.odometer).toFixed(2) + "* km"
        : "";
    const station = r.station || "n/a";
    const reg = r.registration ? " – " + r.registration : "";
    text +=
      "• " +
      d +
      " – *" +
      amtStr +
      "* KES (" +
      litresStr +
      ") – " +
      station +
      odo +
      reg +
      "\n";
  }

  text +=
    "\nYou can log new fuel any time with *fuel*.\n" +
    "Use *fuel report* for the current vehicle, or *fuel report all* for your whole fleet.";

  return text;
}

// ---------- PERSONAL DOCUMENT FLOW ----------

async function handlePersonalDocumentIntent(userWhatsapp) {
  await clearPersonalDocumentSession(userWhatsapp);
  await pool.query(
    `
    INSERT INTO personal_document_sessions (user_whatsapp, step, status)
    VALUES ($1, 'title', 'ACTIVE')
  `,
    [userWhatsapp]
  );

  return (
    "📄 Let's add your *personal/driver document*.\n" +
    "What document is this?\n" +
    "Examples:\n" +
    "• *DL Main*\n" +
    "• *PSV Badge*\n" +
    "• *TSV Certificate*\n" +
    "• *ID card*"
  );
}

async function handlePersonalDocumentSessionStep(userWhatsapp, text, session) {
  const lower = text.trim().toLowerCase();

  if (lower === "cancel") {
    await clearPersonalDocumentSession(userWhatsapp);
    return (
      "✅ I’ve cancelled this personal document entry.\n" +
      "You can start again with *my document*."
    );
  }

  if (session.step === "title") {
    const title = text.trim();
    if (!title) {
      return (
        "Please give this document a name.\n" +
        "Examples: *DL Main*, *PSV Badge*, *TSV Certificate*"
      );
    }

    await pool.query(
      `
      UPDATE personal_document_sessions
      SET doc_title = $1,
          step = 'type',
          updated_at = NOW()
      WHERE id = $2
    `,
      [title, session.id]
    );

    return (
      "What *type/category* is this document?\n" +
      "Examples: *DL*, *PSV*, *TSV*, *Badge*, *ID*.\n" +
      "Reply *skip* if you want to leave this blank."
    );
  }

  if (session.step === "type") {
    let dtype = null;
    if (lower !== "skip") {
      dtype = text.trim();
    }

    await pool.query(
      `
      UPDATE personal_document_sessions
      SET doc_type = $1,
          step = 'cost',
          updated_at = NOW()
      WHERE id = $2
    `,
      [dtype, session.id]
    );

    return (
      "How much did you pay for this document? (KES)\n" +
      "Reply *0* if it was free or you don’t want to record the cost."
    );
  }

  if (session.step === "cost") {
    const amount = parseNumber(text);
    if (isNaN(amount) || amount < 0) {
      return (
        "Please send the cost as a number in KES.\n" +
        "Example: *3500* or *0*"
      );
    }

    await pool.query(
      `
      UPDATE personal_document_sessions
      SET cost_amount = $1,
          step = 'expiry',
          updated_at = NOW()
      WHERE id = $2
    `,
      [amount, session.id]
    );

    return (
      "When does this document *expire*?\n" +
      "Use *YYYY-MM-DD* format (e.g. *2026-01-01*).\n" +
      "Reply *skip* if there is *no expiry date*."
    );
  }

  if (session.step === "expiry") {
    let expiryDate = null;
    if (lower !== "skip") {
      const d = new Date(text.trim());
      if (isNaN(d.getTime())) {
        return (
          "I couldn't understand that date.\n" +
          "Please use *YYYY-MM-DD* format (e.g. *2026-01-01*),\n" +
          "or reply *skip* if there is no expiry."
        );
      }
      expiryDate = text.trim();
    }

    await pool.query(
      `
      UPDATE personal_document_sessions
      SET expiry_date = $1,
          step = 'notes',
          updated_at = NOW()
      WHERE id = $2
    `,
      [expiryDate, session.id]
    );

    return (
      "Any notes about this document?\n" +
      "Examples: *renew every year*, *for Nairobi only*, *attached to employer*, etc.\n" +
      "Reply *skip* to leave notes blank."
    );
  }

  if (session.step === "notes") {
    let notes = null;
    if (lower !== "skip") {
      notes = text.trim();
    }

    const res = await pool.query(
      `
      UPDATE personal_document_sessions
      SET notes = $1,
          step = 'confirm',
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
      [notes, session.id]
    );

    const s = res.rows[0];
    const costNum = s.cost_amount != null ? Number(s.cost_amount) : 0;
    const costStr = costNum.toFixed(2);
    const expStr = s.expiry_date
      ? new Date(s.expiry_date).toDateString()
      : "No expiry date";
    const notesStr = s.notes || "None";

    return (
      "Please confirm this personal document:\n" +
      "Title: *" +
      (s.doc_title || "Document") +
      "*\n" +
      "Type: *" +
      (s.doc_type || "n/a") +
      "*\n" +
      "Cost: *" +
      costStr +
      "* KES\n" +
      "Expiry: *" +
      expStr +
      "*\n" +
      "Notes: " +
      notesStr +
      "\n\n" +
      "Reply *YES* to save or *NO* to cancel."
    );
  }

  if (session.step === "confirm") {
    if (lower === "yes") {
      const res = await pool.query(
        `SELECT * FROM personal_document_sessions WHERE id = $1`,
        [session.id]
      );
      const s = res.rows[0];

      const costNum = s.cost_amount != null ? Number(s.cost_amount) : 0;

      try {
        // Save into personal_documents
        const insertRes = await pool.query(
          `
          INSERT INTO personal_documents (
            user_whatsapp,
            owner_whatsapp,
            driver_whatsapp,
            driver_id,
            doc_title,
            doc_type,
            cost_amount,
            currency,
            expiry_date,
            notes
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING *
        `,
          [
            userWhatsapp,
            userWhatsapp,
            null,
            null,
            s.doc_title,
            s.doc_type,
            costNum,
            "KES",
            s.expiry_date,
            s.notes,
          ]
        );

        const docRow = insertRes.rows[0];

        // Also log as an expense for reporting (if cost > 0)
        if (costNum > 0) {
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
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `,
            [
              userWhatsapp,
              null,
              null,
              "Document: " + (docRow.doc_title || "Document"),
              costNum,
              null,
              docRow.notes,
              null,
            ]
          );
        }
      } catch (err) {
        console.error("❌ Error saving personal document:", err.message);
        await pool.query(
          `
          UPDATE personal_document_sessions
          SET status = 'ERROR',
              updated_at = NOW()
          WHERE id = $1
        `,
          [session.id]
        );
        return (
          "Sorry, I couldn't save that document due to a system error.\n" +
          "Please try again later."
        );
      }

      await pool.query(
        `
        UPDATE personal_document_sessions
        SET status = 'DONE',
            updated_at = NOW()
        WHERE id = $1
      `,
        [session.id]
      );

      const costStr = costNum.toFixed(2);
      const expStr = s.expiry_date
        ? new Date(s.expiry_date).toDateString().slice(0, 10)
        : "No expiry";

      return (
        "✅ Personal document saved.\n" +
        "Title: *" +
        (s.doc_title || "Document") +
        "*\n" +
        "Type: *" +
        (s.doc_type || "n/a") +
        "*\n" +
        "Cost: *" +
        costStr +
        "* KES\n" +
        "Expiry: *" +
        expStr +
        "*\n" +
        "Notes: " +
        (s.notes || "None") +
        "\n\n" +
        "I’ll include this in your *personal compliance* and reminder summaries."
      );
    }

    if (lower === "no") {
      await pool.query(
        `
        UPDATE personal_document_sessions
        SET status = 'CANCELLED',
            updated_at = NOW()
        WHERE id = $1
      `,
        [session.id]
      );
      return (
        "Okay, I’ve cancelled that personal document entry.\n" +
        "You can start again any time with *my document*."
      );
    }

    return "Please reply *YES* to save or *NO* to cancel this personal document entry.";
  }

  return (
    "Something went wrong with this personal document.\n" +
    "Please start again with *my document*."
  );
}

// ---------- AI + MEMORY HELPERS ----------

async function saveChatTurn(userWhatsapp, role, message) {
  try {
    await pool.query(
      `
      INSERT INTO chat_turns (user_whatsapp, role, message)
      VALUES ($1, $2, $3)
    `,
      [userWhatsapp, role, message]
    );
  } catch (err) {
    console.error("❌ Error saving chat_turn:", err.message);
  }
}

async function callN8nAI(from, text) {
  try {
    console.log("🤖 Calling n8n AI webhook:", N8N_WEBHOOK_URL);
    const payload = { from, text };
    console.log("🤖 Payload to n8n:", payload);

    const response = await axios.post(N8N_WEBHOOK_URL, payload, {
      timeout: 10000,
    });

    const data = response.data || {};
    if (data.reply && typeof data.reply === "string") {
      return data.reply;
    }
    return null;
  } catch (err) {
    console.error("❌ Error calling n8n AI webhook:", err.message);
    return null;
  }
}

// ---------- WHATSAPP SEND WRAPPER ----------

async function sendWhatsAppMessage(to, body) {
  if (!to) {
    console.error("❌ No 'to' provided for WhatsApp message.");
    return;
  }

  if (DISABLE_TWILIO_SEND === "true") {
    console.log("🚫 Twilio send disabled. Would send WhatsApp message:", {
      to,
      body,
    });
    return;
  }

  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to,
      body,
    });
  } catch (err) {
    console.error("❌ Error sending WhatsApp message:", err.message);
  }
}

// ---------- MAIN INBOUND ROUTE ----------

app.post("/whatsapp/inbound", async (req, res) => {
  const from = req.body.From || req.body.from;
  const textRaw =
    req.body.Body || req.body.body || req.body.text || "";
  const text = (textRaw || "").trim();

  console.log("📩 Incoming:", { from, text });

  if (!from) {
    console.error("❌ Missing 'from' in incoming payload");
    return res.sendStatus(400);
  }

  if (!text) {
    await sendWhatsAppMessage(
      from,
      "Hi 👋 I’m Saka360. Send *help* to see what I can do."
    );
    return res.sendStatus(200);
  }

  const lower = text.toLowerCase();

  // Global cancel
  if (lower === "cancel" || lower === "stop") {
    await clearAllSessions(from);
    const reply =
      "✅ I’ve cancelled your current entry. You can start again with *fuel*, *service*, or *expense*.";
    console.log("💬 Reply (global cancel):", reply);
    await sendWhatsAppMessage(from, reply);
    await saveChatTurn(from, "user", text);
    await saveChatTurn(from, "assistant", reply);
    return res.sendStatus(200);
  }

  // Check active sessions (personal doc → expense → fuel → service)
  try {
    const personalSession = await getActivePersonalDocumentSession(from);
    if (personalSession) {
      const reply = await handlePersonalDocumentSessionStep(
        from,
        text,
        personalSession
      );
      console.log("💬 Reply (personal document session):", reply);
      await sendWhatsAppMessage(from, reply);
      await saveChatTurn(from, "user", text);
      await saveChatTurn(from, "assistant", reply);
      return res.sendStatus(200);
    }

    const expenseSession = await getActiveExpenseSession(from);
    if (expenseSession) {
      const reply = await handleExpenseSessionStep(
        from,
        text,
        expenseSession
      );
      console.log("💬 Reply (expense session):", reply);
      await sendWhatsAppMessage(from, reply);
      await saveChatTurn(from, "user", text);
      await saveChatTurn(from, "assistant", reply);
      return res.sendStatus(200);
    }

    const fuelSession = await getActiveFuelSession(from);
    if (fuelSession) {
      const reply = await handleFuelSessionStep(
        from,
        text,
        fuelSession
      );
      console.log("💬 Reply (fuel session):", reply);
      await sendWhatsAppMessage(from, reply);
      await saveChatTurn(from, "user", text);
      await saveChatTurn(from, "assistant", reply);
      return res.sendStatus(200);
    }

    const serviceSession = await getActiveServiceSession(from);
    if (serviceSession) {
      const reply = await handleServiceSessionStep(
        from,
        text,
        serviceSession
      );
      console.log("💬 Reply (service session):", reply);
      await sendWhatsAppMessage(from, reply);
      await saveChatTurn(from, "user", text);
      await saveChatTurn(from, "assistant", reply);
      return res.sendStatus(200);
    }
  } catch (err) {
    console.error("❌ Error in session routing:", err.message);
  }

  // No active sessions – interpret commands
  let reply = null;

  try {
    // Vehicle commands
    if (lower.startsWith("add vehicle")) {
      reply = await handleAddVehicleCommand(from, text);
    } else if (lower === "my vehicles") {
      reply = await handleMyVehiclesCommand(from);
    } else if (lower.startsWith("switch")) {
      reply = await handleSwitchVehicleCommand(from, text);
    }

    // Driver commands (owner side)
    else if (lower.startsWith("add driver")) {
      reply = await handleAddDriverCommand(from, text);
    } else if (lower === "my drivers") {
      reply = await handleMyDriversCommand(from);
    } else if (lower.startsWith("assign driver")) {
      reply = await handleAssignDriverCommand(from, text);
    } else if (lower === "driver report") {
      reply = await buildDriverComplianceReport(from);
    }

    // Driver commands (driver side)
    else if (lower === "accept") {
      reply = await handleDriverAccept(from);
    } else if (lower.startsWith("dl ")) {
      reply = await handleDriverLicenceCommand(from, text);
    } else if (lower === "my licence" || lower === "my license") {
      reply = await handleMyOwnLicenceStatus(from);
    }

    // Logging commands
    else if (lower === "fuel") {
      reply = await handleFuelIntent(from);
    } else if (lower === "service") {
      reply = await handleServiceIntent(from);
    } else if (lower === "expense") {
      reply = await handleExpenseIntent(from);
    } else if (
      lower === "my document" ||
      lower === "my documents"
    ) {
      reply = await handlePersonalDocumentIntent(from);
    }

    // Reports
    else if (lower === "fuel report") {
      reply = await buildFuelReport(from, "vehicle");
    } else if (lower === "fuel report all") {
      reply = await buildFuelReport(from, "all");
    } else if (lower === "service report") {
      reply = await buildServiceReport(from, "vehicle");
    } else if (lower === "service report all") {
      reply = await buildServiceReport(from, "all");
    } else if (lower === "expense report") {
      reply = await buildExpenseReport(from, "vehicle");
    } else if (lower === "expense report all") {
      reply = await buildExpenseReport(from, "all");
    } else if (lower === "report" || lower === "reports") {
      reply =
        "I can show quick summaries for your data:\n" +
        "• *fuel report* – fuel spend & efficiency (current vehicle)\n" +
        "• *fuel report all* – fuel summary across all vehicles\n" +
        "• *service report* – service spend (current vehicle)\n" +
        "• *service report all* – service summary across all vehicles\n" +
        "• *expense report* – other expenses (current vehicle)\n" +
        "• *expense report all* – expenses across all vehicles\n" +
        "• *driver report* – driver licence compliance\n" +
        "Please choose one of those.";
    }

    // Help
    else if (lower === "help" || lower === "menu") {
      reply =
        "Hi 👋 I’m Saka360. Here’s what I can do:\n\n" +
        "🚗 *Vehicles*\n" +
        "• *add vehicle KDA 123A* – add a car\n" +
        "• *my vehicles* – list your vehicles\n" +
        "• *switch to 1* – change current vehicle\n\n" +
        "⛽ *Fuel / Service / Expense*\n" +
        "• *fuel* – log fuel\n" +
        "• *service* – log service\n" +
        "• *expense* – log other expenses\n\n" +
        "📊 *Reports*\n" +
        "• *fuel report*, *fuel report all*\n" +
        "• *service report*, *service report all*\n" +
        "• *expense report*, *expense report all*\n" +
        "• *driver report*\n\n" +
        "👨‍✈️ *Drivers*\n" +
        "• *add driver Name | 07XXXXXXXX*\n" +
        "• *my drivers*\n" +
        "• *assign driver 1*\n\n" +
        "📄 *Documents*\n" +
        "• *my document* – add a personal/driver document\n\n" +
        "You can also type anything and I’ll try to understand it with AI. 😊";
    }
  } catch (err) {
    console.error("❌ Error in command handling:", err.message);
  }

  // If we have a direct reply, send it
  if (reply) {
    console.log("💬 Reply:", reply);
    await sendWhatsAppMessage(from, reply);
    await saveChatTurn(from, "user", text);
    await saveChatTurn(from, "assistant", reply);
    return res.sendStatus(200);
  }

  // Fallback to AI via n8n
  const aiReply = await callN8nAI(from, text);
  const finalReply =
    aiReply ||
    "Hi 👋 I’m Saka360. How can I help you with your vehicles and drivers today?";

  console.log("💬 Reply:", finalReply);
  await sendWhatsAppMessage(from, finalReply);
  await saveChatTurn(from, "user", text);
  await saveChatTurn(from, "assistant", finalReply);

  return res.sendStatus(200);
});

// ---------- ROOT & SERVER START ----------

app.get("/", (req, res) => {
  res.send("Saka360 backend is running.");
});

const port = PORT || 10000;
app.listen(port, () => {
  console.log("🚀 Saka360 backend listening on port", port);
});
