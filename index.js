// index.js
// Saka360 Backend - WhatsApp → (Vehicles / Fuel / Service / Expense / Drivers / n8n) → DB → WhatsApp

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

async function sendWhatsApp(to, body) {
  if (DISABLE_TWILIO_SEND === "true") {
    console.log("🚫 Twilio send disabled, would send:", { to, body });
    return;
  }
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
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
// ====== DRIVER HELPERS ======

// Fetch active drivers for this owner
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

// Format driver list (for WhatsApp display)
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

    const baseLine = `*${name}* – Type: *${licType}* (exp: ${expStr}) ${statusIcon} ${statusText}`;

    if (withIndices) {
      text += `\n${idx}. ${baseLine}`;
    } else {
      text += `\n• ${baseLine}`;
    }
  });

  return text.trim();
}

/**
 * ADD DRIVER (OWNER SIDE – INVITE)
 *
 * Usage:
 *   1) "add driver" → show instructions
 *   2) "add driver John Doe | 0712345678"
 */
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
    // Fallback: just prefix with whatsapp:
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
      await sendWhatsApp(driverWhatsapp,
        `Hi ${fullName} 👋\n\n` +
          `You’ve been added as a driver in *Saka360* by *${ownerWhatsapp}*.\n\n` +
          "To accept and complete your driving licence compliance, reply here with:\n" +
          "*accept*\n\n" +
          "After you add your *Main Driving Licence* expiry date, you’ll be allowed to log *fuel*, *service* and *expenses* for vehicles assigned to you.`
      );
    }
  } catch (err) {
    console.error(
      "❌ Error sending driver invite WhatsApp message:",
      err.message
    );
  }

  return (
    `✅ Driver *${fullName}* added.\n\n` +
    `Invitation sent to: *${driverWhatsapp.replace("whatsapp:", "")}*\n\n` +
    "They must:\n" +
    `1️⃣ Reply *accept* from their WhatsApp (${driverWhatsapp.replace(
      "whatsapp:",
      ""
    )})\n` +
    "2️⃣ Add their *Main Driving Licence* expiry with:\n" +
    "   *dl main 2026-01-01*\n\n" +
    "Once they add a valid Main DL, you’ll get a compliance notification and they’ll appear as *compliant* in your *driver report*."
  );
}

/**
 * DRIVER SIDE: accept invitation
 */
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
        `Hi ${name} 👋\n\n` +
        "You’re already *compliant* with a valid Main Driving Licence on file.\n\n" +
        "You can now log *fuel*, *service* and *expenses* for vehicles assigned to you (once your fleet owner connects your profile)."
      );
    }
  }

  return (
    `Hi ${name} 👋\n\n` +
    "To complete your licence compliance, please send your *Main Driving Licence* expiry date.\n\n" +
    "Use this format:\n" +
    "*dl main 2026-01-01*\n\n" +
    "You must have a *valid Main DL* on Saka360 before you can log *fuel*, *service* or *expenses*."
  );
}

/**
 * DRIVER SIDE: add main driving licence
 *
 * Usage:
 *   dl main 2026-01-01
 */
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

  const typeWord = match[1]; // main / psv / tsv ...
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

  // If there is an existing main licence, we "lock" it
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
      await sendWhatsApp(
        ownerWhatsapp,
        "✅ *Driver compliance update*\n\n" +
          `Driver: *${name}*\n` +
          `Main DL expiry: *${expiryText}*\n\n` +
          "This driver is now *Main DL compliant* and can be allowed to log *fuel*, *service* and *expenses* for vehicles you assign."
      );
    } catch (err) {
      console.error(
        "❌ Error sending compliance notification to owner:",
        err.message
      );
    }
  }

  return (
    `✅ Thanks ${name}.\n\n` +
    `Your *Main Driving Licence* expiry has been set to *${expiryText}*.\n\n` +
    "You are now *licence compliant* on Saka360.\n" +
    "Your fleet owner can assign vehicles to you for logging *fuel*, *service* and *expenses*."
  );
}

// List drivers
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
      `You only have *${drivers.length}* driver(s).\n\n` +
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
    `Vehicle: *${vehicle.registration}*\n` +
    `Driver: *${name}*\n` +
    `Licence type: *${licType}* (exp: ${exp})\n\n` +
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
      text += `\n• *${name}* – Type: *${licType}*, exp: ${exp} (expired ${days} day(s) ago) – ${phone}`;
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
      text += `\n• *${name}* – Type: *${licType}*, exp: ${exp} (in ${days} day(s)) – ${phone}`;
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
      text += `\n• *${name}* – Type: *${licType}*, exp: ${exp} (~${days} day(s) left) – ${phone}`;
    }
  } else {
    text += "\n\n✅ *Valid licences*: none yet.";
  }

  text +=
    "\n\nYou can add drivers with *add driver ...* and assign them with *assign driver X*.\nDrivers must reply *accept* then *dl main YYYY-MM-DD* to be Main DL compliant.";

  return text;
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

// per-vehicle / all-vehicles fuel report
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

// ====== SERVICE / EXPENSE HELPERS & SESSIONS ======
// (keeping same as your previous working version – omitted here for brevity)
// ⬇️ IMPORTANT: keep all your existing service_sessions, expense_sessions,
// edit/delete handlers, and reports exactly as they were. Nothing in those
// parts needs to change for the AI fix. ⬆️


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

    console.log("📩 Incoming:", { from, text });

    if (!text) {
      console.log("⚠️ Empty message body received from Twilio.");
      res.status(200).send("OK");
      return;
    }

    let reply = "";

    // 1) Hard commands and flows (do NOT go to AI)
    if (["cancel", "stop", "reset"].includes(lower)) {
      await cancelAllSessionsForUser(from);
      reply =
        "✅ I’ve cancelled your current entry. You can start again with *fuel*, *service*, or *expense*.";
    } else if (lower === "accept") {
      reply = await handleDriverAccept(from);
    } else if (lower === "add") {
      reply =
        "What would you like to add? ✏️\n\n" +
        "1. *Vehicle* – register a new vehicle\n" +
        "2. *Driver* – invite a driver to log for your vehicles\n\n" +
        "Reply with:\n" +
        "• *add vehicle* – I’ll guide you to add a vehicle\n" +
        "• *add driver* – I’ll guide you to invite a driver";
    } else if (lower.startsWith("add vehicle")) {
      reply = await handleAddVehicleCommand(from, text);
    } else if (lower === "my vehicles") {
      reply = await handleMyVehiclesCommand(from);
    } else if (lower.startsWith("switch")) {
      reply = await handleSwitchVehicleCommand(from, text);
    } else if (lower.startsWith("add driver")) {
      reply = await handleAddDriverCommand(from, text);
    } else if (lower === "my drivers" || lower === "drivers") {
      reply = await handleMyDriversCommand(from);
    } else if (lower.startsWith("assign driver")) {
      reply = await handleAssignDriverCommand(from, text);
    } else if (lower.startsWith("dl ")) {
      reply = await handleDriverLicenceCommand(from, text);
    } else if (lower === "report" || lower.startsWith("report ")) {
      reply =
        "I can show quick summaries for your data:\n\n" +
        "• *fuel report* – fuel spend & efficiency (current vehicle)\n" +
        "• *fuel report all* – fuel summary across all vehicles\n" +
        "• *service report* – service spend (current vehicle)\n" +
        "• *service report all* – service summary across all vehicles\n" +
        "• *expense report* – other expenses (current vehicle)\n" +
        "• *expense report all* – expenses across all vehicles\n" +
        "• *driver report* – driver licence compliance\n\n" +
        "Please choose one of those.";
    } else {
      // 2) Check active sessions first
      const activeFuelSession = await getActiveFuelSession(from);
      // (and similar for service/expense if you keep those blocks)

      if (activeFuelSession) {
        reply = await handleFuelSessionStep(activeFuelSession, text);
      } else if (lower === "fuel") {
        reply = await startFuelSession(from);
      } else if (lower === "fuel report" || lower.startsWith("fuel report")) {
        const wantsAll = lower.includes("all");
        if (wantsAll) {
          reply = await buildFuelReport(from, { allVehicles: true });
        } else {
          const vRes = await ensureCurrentVehicle(from);
          if (vRes.status === "NO_VEHICLES") {
            reply =
              "You don't have any vehicles yet.\n\n" +
              "Add one with: *add vehicle KDA 123A*";
          } else if (vRes.status === "NEED_SET_CURRENT") {
            const listText = formatVehiclesList(vRes.list, true);
            reply =
              "You have multiple vehicles. Please choose which one you want the report for.\n\n" +
              listText +
              "\n\nReply with e.g. *switch to 1*, then send *fuel report* again.";
          } else {
            const vehicle = vRes.vehicle;
            reply = await buildFuelReport(from, {
              vehicleId: vehicle.id,
              vehicleLabel: vehicle.registration,
            });
          }
        }
      } else if (lower === "start") {
        reply =
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
        reply =
          "Here’s what I can do for you 🚗\n\n" +
          "• *fuel* – log fuel for your current vehicle\n" +
          "• *service* – log service with cost, odometer & reminders\n" +
          "• *expense* – log other vehicle costs\n" +
          "• *add vehicle* – add a new vehicle to your account\n" +
          "• *add driver* – invite a driver and track licence compliance\n" +
          "• *my vehicles* – list your vehicles\n" +
          "• *my drivers* – list your drivers\n" +
          "• *report* – see summaries for fuel, service, expenses & drivers\n\n" +
          "If you’re not sure, just tell me what you want to track and I’ll guide you.";
      }
    }

    // 3) If still no reply, ask n8n AI
    if (!reply) {
      try {
        console.log("🤖 Calling n8n AI webhook:", N8N_WEBHOOK_URL);
        const aiRes = await axios.post(N8N_WEBHOOK_URL, { from, to, text });

        console.log("🤖 Raw n8n AI response:", aiRes.status, aiRes.data);

        let aiReply = null;
        const data = aiRes.data;

        if (typeof data === "string") {
          try {
            const parsed = JSON.parse(data);
            if (
              parsed &&
              typeof parsed.reply === "string" &&
              parsed.reply.trim()
            ) {
              aiReply = parsed.reply.trim();
            } else if (
              parsed &&
              typeof parsed.text === "string" &&
              parsed.text.trim()
            ) {
              aiReply = parsed.text.trim();
            }
          } catch (e) {
            console.warn("🤖 Could not JSON.parse AI string:", e.message);
            if (data.trim()) {
              aiReply = data.trim();
            }
          }
        } else if (data && typeof data === "object") {
          if (typeof data.reply === "string" && data.reply.trim()) {
            aiReply = data.reply.trim();
          } else if (typeof data.text === "string" && data.text.trim()) {
            aiReply = data.text.trim();
          }
        }

        if (aiReply) {
          reply = aiReply;
        } else {
          console.warn(
            "🤖 AI response missing 'reply'/'text', using generic reply."
          );
          reply = "Hi 👋 I’m Saka360. How can I help?";
        }
      } catch (err) {
        console.error("❌ AI/N8N error:", err.message);
        reply = "Hi 👋 I’m Saka360. How can I help?";
      }
    }

    console.log("💬 Sending reply:", reply);

    try {
      await sendWhatsApp(from, reply);
    } catch (err) {
      console.error("❌ Twilio send error:", err.message);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error in /whatsapp/inbound route:", error.message);
    res.status(200).send("OK");
  }
});

// ====== START SERVER ======
const serverPort = PORT || 10000;
app.listen(serverPort, () => {
  console.log(`🚀 Saka360 backend listening on port ${serverPort}`);
});
