// index.js
// Saka360 Backend – WhatsApp → (Cars / Fuel / Service / Expense / Drivers / n8n AI) → DB → WhatsApp

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
  console.log("Using TWILIO_WHATSAPP_NUMBER:", JSON.stringify(TWILIO_WHATSAPP_NUMBER));
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
    `✅ Vehicle *${registration}* added.\n\n" +
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

  // Split by "|" (preferred), fall back to ","
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

  // Normalise phone → WhatsApp format
  function toWhatsAppNumber(phone) {
    const trimmed = phone.trim();
    if (trimmed.startsWith("whatsapp:")) return trimmed;
    if (trimmed.startsWith("+")) return `whatsapp:${trimmed}`;

    const digits = trimmed.replace(/\D/g, "");
    // Assume Kenyan numbers by default: 07XXXXXXXX
    if (digits.length === 10 && digits.startsWith("0")) {
      return `whatsapp:+254${digits.slice(1)}`;
    }
    if (digits.length === 12 && digits.startsWith("254")) {
      return `whatsapp:+${digits}`;
    }
    // Fallback: just prefix with whatsapp:+
    return `whatsapp:+${digits}`;
  }

  const driverWhatsapp = toWhatsAppNumber(rawPhone);

  // Upsert-ish: if same owner + same driver_whatsapp exists, just update name
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

  // Notify driver on WhatsApp to accept
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
    console.error("❌ Error sending driver invite WhatsApp message:", err.message);
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

  // If main DL already set and valid, they're already compliant
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

  // Find the driver record for this WhatsApp
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

  // If there is an existing main licence, locked
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

  // Update driver with main licence info
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

  // Notify owner that driver is now compliant
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

  // Ensure we have a current vehicle
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

  // Get drivers
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

// Show which drivers are assigned to which vehicles
async function handleDriverAssignmentsOverview(userWhatsapp) {
  const res = await pool.query(
    `
    SELECT
      v.registration,
      v.nickname,
      v.is_default,
      d.full_name AS driver_name,
      d.license_type,
      d.license_expiry_date
    FROM vehicles v
    LEFT JOIN drivers d
      ON v.driver_id = d.id
    WHERE v.owner_whatsapp = $1
      AND v.is_active = TRUE
    ORDER BY v.created_at ASC
    `,
    [userWhatsapp]
  );

  const rows = res.rows;
  if (rows.length === 0) {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with:\n" +
      "*add vehicle KDA 123A*"
    );
  }

  let text = "🚘 *Vehicle → Driver assignments*\n";
  rows.forEach((row, index) => {
    const idx = index + 1;
    const reg = row.registration;
    const nick = row.nickname ? ` (${row.nickname})` : "";
    const currentMark = row.is_default ? " ✅ (current)" : "";
    const driverName = row.driver_name || "no driver assigned";
    const licType = row.license_type || "n/a";
    const exp = row.license_expiry_date
      ? String(row.license_expiry_date).slice(0, 10)
      : "n/a";

    if (row.driver_name) {
      text +=
        `\n${idx}. *${reg}*${nick}${currentMark}\n` +
        `   Driver: *${driverName}* – ${licType} (exp: ${exp})`;
    } else {
      text +=
        `\n${idx}. *${reg}*${nick}${currentMark}\n` +
        `   Driver: *none assigned*`;
    }
  });

  text +=
    "\n\nYou can assign with *assign driver X* and soon unassign with *unassign driver* " +
    "for your current vehicle.";

  return text;
}

// Unassign driver from CURRENT vehicle
async function handleUnassignDriverCommand(userWhatsapp) {
  const vRes = await ensureCurrentVehicle(userWhatsapp);

  if (vRes.status === "NO_VEHICLES") {
    return (
      "You don't have any vehicles yet.\n\n" +
      "Add one with: *add vehicle KDA 123A*"
    );
  } else if (vRes.status === "NEED_SET_CURRENT") {
    const listText = formatVehiclesList(vRes.list, true);
    return (
      "You have multiple vehicles. Please choose which one you want as *current* first.\n\n" +
      listText +
      "\n\nReply with e.g. *switch to 1*, then send *unassign driver* again."
    );
  }

  const vehicle = vRes.vehicle;

  if (!vehicle.driver_id) {
    return (
      "Your current vehicle *" +
      vehicle.registration +
      "* does not have a driver assigned.\n\n" +
      "You can assign one with *assign driver X* after listing drivers with *my drivers*."
    );
  }

  await pool.query(
    `
    UPDATE vehicles
    SET driver_id = NULL,
        updated_at = NOW()
    WHERE id = $1
    `,
    [vehicle.id]
  );

  return (
    "✅ Driver unassigned from *" +
    vehicle.registration +
    "*.\n\n" +
    "You can assign a new driver later with *assign driver X*."
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

  // Expired
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

  // Expiring soon
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

  // OK
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

// ====== SIMPLE MOCKS FOR FUEL / SERVICE / EXPENSE (you can wire real flows later) ======

async function handleFuelSessionStep(session, incomingText) {
  return "Fuel session handling not yet fully implemented in this backend. For now, follow the guidance I send in chat.";
}

async function handleServiceSessionStep(session, incomingText) {
  return "Service session handling not yet fully implemented in this backend. For now, follow the guidance I send in chat.";
}

async function handleExpenseSessionStep(session, incomingText) {
  return "Expense session handling not yet fully implemented in this backend. For now, follow the guidance I send in chat.";
}

// ====== GLOBAL SESSION CANCEL (placeholder) ======
async function cancelAllSessionsForUser(userWhatsapp) {
  // If you use fuel_sessions / service_sessions / expense_sessions tables,
  // re-add UPDATE queries here.
  return;
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

// ====== SIMPLE REPORT PLACEHOLDERS FOR fuel / service / expense ======
async function buildFuelReport(userWhatsapp, options = {}) {
  return "Fuel report coming soon. For now I track fuel entries, but reporting is still being wired.";
}

async function buildServiceReport(userWhatsapp, options = {}) {
  return "Service report coming soon. For now I track service entries, but reporting is still being wired.";
}

async function buildExpenseReport(userWhatsapp, options = {}) {
  return "Expense report coming soon. For now I track expense entries, but reporting is still being wired.";
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

    // Case 1: axios already parsed JSON object
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

    // Case 2: n8n returned a plain string (possibly JSON)
    if (typeof data === "string") {
      const str = data.trim();
      if (!str) return null;

      // Try to parse as JSON first
      try {
        const maybe = JSON.parse(str);
        if (maybe && typeof maybe === "object") {
          if (typeof maybe.reply === "string" && maybe.reply.trim().length > 0) {
            return maybe.reply.trim();
          }
          if (typeof maybe.text === "string" && maybe.text.trim().length > 0) {
            return maybe.text.trim();
          }
        }
      } catch (e) {
        // not JSON, ignore
      }

      // Fallback: return raw string
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

// ====== HEALTH CHECK ======
app.get("/", (req, res) => {
  res.send("Saka360 backend is running ✅");
});

// ====== MAIN WHATSAPP HANDLER ======
app.post("/whatsapp/inbound", async (req, res) => {
  try {
    const from = req.body.From || req.body.from; // "whatsapp:+2547..."
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

    // Log user message into memory
    await logChatTurn(from, "user", text);

    let replyText = "";

    // GLOBAL COMMANDS: cancel / stop / reset
    if (["cancel", "stop", "reset"].includes(lower)) {
      await cancelAllSessionsForUser(from);
      replyText =
        "✅ I’ve cancelled your current entry. You can start again with *fuel*, *service*, or *expense*.";
    }
    // DRIVER: accept invitation
    else if (lower === "accept") {
      replyText = await handleDriverAccept(from);
    }
    // QUICK "add" helper – menu of things you can add
    else if (lower === "add") {
      replyText =
        "What would you like to add? ✏️\n\n" +
        "1. *Vehicle* – register a new vehicle\n" +
        "2. *Driver* – invite a driver to log for your vehicles\n\n" +
        "Reply with:\n" +
        "• *add vehicle* – I’ll guide you to add a vehicle\n" +
        "• *add driver* – I’ll guide you to invite a driver";
    }
    // START / HELP
    else if (lower === "start") {
      replyText =
        "Welcome to *Saka360* 👋\n" +
        "I help you track fuel, service, expenses and driver compliance for your vehicles.\n\n" +
        "Quick commands:\n" +
        "• *fuel* – log fuel\n" +
        "• *service* – log service\n" +
        "• *expense* – log other costs\n" +
        "• *add vehicle* – register a vehicle\n" +
        "• *add driver* – invite a driver\n" +
        "• *report* – see fuel/service/expense & driver reports\n\n" +
        "You can type *help* anytime to see this again.";
    } else if (lower === "help") {
      replyText =
        "Here’s what I can do on *Saka360* 👇\n\n" +
        "• *fuel* – log a fuel refill step by step\n" +
        "• *service* – log a service with notes and reminders\n" +
        "• *expense* – log other costs (tyres, parking, repairs)\n" +
        "• *add vehicle* – add a vehicle to your account\n" +
        "• *add driver* – invite a driver and track DL compliance\n" +
        "• *my vehicles* – see and switch current vehicle\n" +
        "• *my drivers* – see drivers and their licence status\n" +
        "• *assign driver 1* – assign driver 1 to your current vehicle\n" +
        "• *driver report* – see licence compliance overview\n\n" +
        "You can also type normal questions like:\n" +
        "• *How do I log fuel?*\n" +
        "• *How do I add a fleet account?*\n" +
        "and I’ll explain.";
    }
    // VEHICLE COMMANDS
    else if (lower.startsWith("add vehicle")) {
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
    }
    // DRIVER COMMANDS
    else if (lower.startsWith("add driver")) {
      replyText = await handleAddDriverCommand(from, text);
    } else if (lower === "my drivers" || lower === "drivers") {
      replyText = await handleMyDriversCommand(from);
    } else if (lower.startsWith("assign driver")) {
      replyText = await handleAssignDriverCommand(from, text);
    } else if (
      lower === "driver assignments" ||
      lower === "assignments" ||
      lower.includes("which car is assigned to a driver") ||
      lower.includes("see which car is assigned") ||
      (lower.includes("driver") && lower.includes("assigned") && lower.includes("car"))
    ) {
      // Owner/fleet view: which driver is on which car
      replyText = await handleDriverAssignmentsOverview(from);
    } else if (
      lower === "unassign driver" ||
      lower === "remove driver" ||
      (lower.includes("unassign") && lower.includes("driver"))
    ) {
      replyText = await handleUnassignDriverCommand(from);
    }
    // DRIVER LICENCE COMMAND
    else if (
      lower === "add license" ||
      lower === "add licence" ||
      lower.includes("add license") ||
      lower.includes("add licence")
    ) {
      replyText =
        "To add a driving licence on *Saka360*, the driver must send their *Main DL* expiry date from their own WhatsApp number.\n\n" +
        "Ask the driver to reply with:\n" +
        "*dl main 2026-01-01*  (use their real expiry date)\n\n" +
        "Once they add a valid Main DL, they’ll appear as *compliant* in your *driver report* and you can assign vehicles to them.";
    } else if (lower.startsWith("dl ")) {
      replyText = await handleDriverLicenceCommand(from, text);
    }
    // HIGH-LEVEL LOGGING SHORTCUTS (avoid generic n8n replies)
    else if (
      lower === "fuel" ||
      lower === "log fuel" ||
      lower.startsWith("fuel ") ||
      lower.startsWith("log fuel")
    ) {
      replyText =
        "⛽ *How to log fuel on Saka360*\n\n" +
        "1️⃣ Make sure the correct vehicle is selected with *my vehicles* and *switch to X*.\n" +
        "2️⃣ Then send your fuel details in one line like:\n" +
        "*fuel 30L | 180 per litre | 5400 total | Shell Ngong Road | odo 123456*\n\n" +
        "I’ll use this format to track your fuel entries per vehicle in upcoming versions.\n" +
        "You can also ask: *How do I log fuel step by step?*";
    } else if (
      lower === "service" ||
      lower === "log service" ||
      lower.startsWith("service ") ||
      lower.startsWith("log service")
    ) {
      replyText =
        "🛠️ *How to log a service on Saka360*\n\n" +
        "Use a one-line format like:\n" +
        "*service major | 8500 labour | 12000 parts | Toyo Motors | notes: changed oil & filters | odo 145000*\n\n" +
        "I’ll use this to keep a clear history of what was done on each vehicle.";
    } else if (
      lower === "expense" ||
      lower === "log expense" ||
      lower.startsWith("expense ") ||
      lower.startsWith("log expense")
    ) {
      replyText =
        "💸 *How to log an expense on Saka360*\n\n" +
        "Send a one-line entry like:\n" +
        "*expense tyres | 48000 | 4 new tyres | Sameer Park | odo 160000*\n\n" +
        "Expenses help you see total running costs per vehicle over time.";
    }
    // SIMPLE EDIT / DELETE HELPERS
    else if (lower === "edit") {
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
    }
    // HIGH-LEVEL REPORT HELP
    else if (lower === "report" || lower.startsWith("report ")) {
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
    }
    // SIMPLE REPORT COMMANDS (currently placeholder functions)
    else if (lower.startsWith("fuel report")) {
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
      // If this WhatsApp is a driver, show THEIR own licence status.
      const driver = await findDriverByWhatsapp(from);
      if (driver) {
        replyText = await handleMyOwnLicenceStatus(from);
      } else {
        // Treat as owner / fleet compliance overview
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
    }
    // GENERIC "step by step" help for logging
    else if (lower.includes("step by step")) {
      replyText =
        "Here’s how to log on *Saka360* step by step 👇\n\n" +
        "⛽ *Fuel logging step by step*\n" +
        "1️⃣ Make sure the correct vehicle is selected with *my vehicles* and *switch to X*.\n" +
        "2️⃣ At the pump, note: litres, price per litre, total cost, station name, and odometer.\n" +
        "3️⃣ Send everything in *one line* like:\n" +
        "   *fuel 30L | 180 per litre | 5400 total | Shell Ngong Road | odo 123456*\n\n" +
        "🛠️ *Service logging step by step*\n" +
        "1️⃣ Choose the vehicle (*my vehicles*, then *switch to X* if needed).\n" +
        "2️⃣ Note service type (minor, major), labour cost, parts cost, garage name, notes and odometer.\n" +
        "3️⃣ Send:\n" +
        "   *service major | 8500 labour | 12000 parts | Toyo Motors | notes: changed oil & filters | odo 145000*\n\n" +
        "💸 *Expense logging step by step*\n" +
        "1️⃣ Decide which vehicle the expense belongs to (same *my vehicles* logic).\n" +
        "2️⃣ Note type (tyres, parking, repair etc.), amount, description, vendor and odometer if relevant.\n" +
        "3️⃣ Send:\n" +
        "   *expense tyres | 48000 | 4 new tyres | Sameer Park | odo 160000*\n\n" +
        "In upcoming versions I’ll guide you through this interactively. For now, I use the one-line format above to keep your logs clean and consistent ✅.";
    }
    // REMINDERS / DOCUMENT REMINDERS (honest limitation)
    else if (
      lower === "add reminder" ||
      lower.includes("reminder") ||
      lower.includes("expiry date") ||
      lower.includes("expiration date")
    ) {
      replyText =
        "Right now *Saka360* automatically focuses on *Driving Licence* expiry reminders via the *driver report* and each driver’s DL status.\n\n" +
        "In upcoming versions you’ll also be able to store other documents (e.g. insurance, inspection, road licence) with reminder dates.\n\n" +
        "For now, you can use the *notes* field in your *service* or *expense* logs to tag important dates, and I’ll keep those tied to each vehicle.";
    }
    // FALLBACK → n8n AI
    else {
      // Fallback: send to n8n AI
      const aiReply = await callN8nAi(from, text);
      if (aiReply && typeof aiReply === "string" && aiReply.trim().length > 0) {
        replyText = aiReply.trim();
      } else {
        replyText =
          "Hi! 👋 I’m Saka360. I help you with vehicles, drivers, fuel, service, expenses and licence compliance. What would you like to do?";
      }
    }

    // ---- FORCE REPLY TO BE A STRING (FIXES JSON BEING SENT TO WHATSAPP) ----
    if (typeof replyText !== "string") {
      if (replyText && typeof replyText === "object") {
        replyText =
          replyText.reply ||
          replyText.text ||
          JSON.stringify(replyText, null, 2);
      } else {
        replyText = String(replyText);
      }
    }
    replyText = replyText.trim();
    // -----------------------------------------------------------------------

    // Log assistant reply into memory
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
