// routes/chat.js
const express = require("express");
const router = express.Router();

// OpenAI client (uses OPENAI_API_KEY or fallback LLM_API_KEY)
let openai = null;
try {
  const { OpenAI } = require("openai");
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY,
  });
} catch (e) {
  console.warn("[chat] openai SDK not installed or misconfigured:", e.message);
}

// Cache whether optional columns exist (checked once, lazily)
let VEH_COL_CHECKED = false;
let HAS_MAKE = false;
let HAS_MODEL = false;
let HAS_YOM = false;         // year_of_manufacture
let HAS_CREATED_AT = false;
let HAS_UPDATED_AT = false;

function normalizePlate(s = "") {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function ensureVehicleColumns(pool) {
  if (VEH_COL_CHECKED) return;
  const wanted = [
    "make",
    "model",
    "year_of_manufacture",
    "created_at",
    "updated_at",
  ];
  const sql = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name='vehicles' AND column_name = ANY($1)
  `;
  try {
    const r = await pool.query(sql, [wanted]);
    const have = new Set(r.rows.map((x) => x.column_name));
    HAS_MAKE       = have.has("make");
    HAS_MODEL      = have.has("model");
    HAS_YOM        = have.has("year_of_manufacture");
    HAS_CREATED_AT = have.has("created_at");
    HAS_UPDATED_AT = have.has("updated_at");
  } catch (e) {
    console.error("[chat] column check failed:", e.message);
  } finally {
    VEH_COL_CHECKED = true;
  }
}

function buildVehicleSelect() {
  const cols = ["id", "name", "plate_number", "type"];
  if (HAS_MAKE) cols.push("make");
  if (HAS_MODEL) cols.push("model");
  if (HAS_YOM) cols.push("year_of_manufacture");
  return cols.join(", ");
}

function buildOrderBy() {
  // Build a safe ORDER BY that only uses existing columns
  const order = [];
  if (HAS_UPDATED_AT) order.push("updated_at DESC NULLS LAST");
  if (HAS_CREATED_AT) order.push("created_at DESC NULLS LAST");
  // Fallback to id if neither timestamp exists
  if (order.length === 0) order.push("id DESC");
  return "ORDER BY " + order.join(", ");
}

function extractMakeModelGuess(text) {
  const lower = (text || "").toLowerCase();
  const makes = [
    "toyota","nissan","honda","mazda","subaru","ford","isuzu",
    "mercedes","bmw","audi","vw","volkswagen","mitsubishi",
    "suzuki","hyundai","kia"
  ];
  const foundMake = makes.find(m => lower.includes(m));
  let model = null;
  if (foundMake) {
    const re = new RegExp(`${foundMake}\\s+([a-z0-9-]+)`, "i");
    const m = lower.match(re);
    if (m && m[1]) model = m[1];
  }
  return {
    make: foundMake ? foundMake[0].toUpperCase() + foundMake.slice(1) : null,
    model: model || null
  };
}

router.post("/chat", async (req, res) => {
  try {
    const pool = req.app.get("pool");
    if (!pool) {
      return res.status(500).json({
        error: "Server error",
        detail: "Pool not found on app; set app.set('pool', pool) in index.js",
        path: req.originalUrl,
      });
    }

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing 'messages' array" });
    }

    const userMsg = messages[messages.length - 1]?.content || "";
    await ensureVehicleColumns(pool);

    let vehicle = null;

    // 1) Try plate match first (normalize both sides)
    const plateGuess = normalizePlate(userMsg);
    if (plateGuess && plateGuess.length >= 5) {
      const sql = `
        SELECT ${buildVehicleSelect()}
        FROM vehicles
        WHERE regexp_replace(upper(plate_number),'[^A-Z0-9]','','g') = $1
        ${buildOrderBy()}
        LIMIT 1
      `;
      const r = await pool.query(sql, [plateGuess]);
      if (r.rows.length) vehicle = r.rows[0];
    }

    // 2) If no plate match, try make/model (only if those cols exist)
    if (!vehicle) {
      const { make, model } = extractMakeModelGuess(userMsg);
      if ((HAS_MAKE || HAS_MODEL) && (make || model)) {
        const where = [];
        const params = [];
        let p = 1;

        if (HAS_MAKE && make) {
          where.push(`LOWER(make) = LOWER($${p++})`);
          params.push(make);
        }
        if (HAS_MODEL && model) {
          where.push(`LOWER(model) = LOWER($${p++})`);
          params.push(model);
        }

        if (where.length) {
          const sql = `
            SELECT ${buildVehicleSelect()}
            FROM vehicles
            WHERE ${where.join(" AND ")}
            ${buildOrderBy()}
            LIMIT 1
          `;
          const r = await pool.query(sql, params);
          if (r.rows.length) vehicle = r.rows[0];
        }
      }
    }

    // 3) System prompt: keep scope narrow to Saka360 records usage
    const systemPrompt = [
      "You are Saka360’s vehicle maintenance assistant.",
      "Only answer questions related to the user's registered vehicles and maintenance/usage.",
      "Pull details from the user's vehicle profile when available (plate/make/model/year).",
      "Be brief and practical. Suggest next steps in the Saka360 app when relevant."
    ].join(" ");

    let vehicleContext = "No vehicle matched from the prompt.";
    if (vehicle) {
      vehicleContext =
        `Matched vehicle:\n` +
        `- Name: ${vehicle.name || "(n/a)"}\n` +
        `- Plate: ${vehicle.plate_number || "(n/a)"}\n` +
        `- Type: ${vehicle.type || "(n/a)"}\n` +
        (HAS_MAKE  ? `- Make: ${vehicle.make || "(n/a)"}\n` : "") +
        (HAS_MODEL ? `- Model: ${vehicle.model || "(n/a)"}\n` : "") +
        (HAS_YOM   ? `- Year: ${vehicle.year_of_manufacture ?? "(n/a)"}\n` : "");
    }

    // 4) Call OpenAI (if configured), else return a stub
    let content = "(LLM is not configured)";
    let provider = "stub";
    let model = "none";

    if (openai && (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY)) {
      provider = "openai";
      model = process.env.LLM_MODEL || "gpt-4o-mini";

      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "system", content: `Vehicle context:\n${vehicleContext}` },
          { role: "user", content: userMsg },
        ],
        temperature: 0.3,
      });

      content = completion.choices?.[0]?.message?.content?.trim() || "(no response)";
    } else {
      content = vehicle
        ? `You asked: "${userMsg}". Matched your vehicle ${vehicle?.name || ""} (${vehicle?.plate_number || ""}). Keep queries related to maintenance records, fuel, service, and documents.`
        : `You asked: "${userMsg}". I couldn't match a vehicle. Try including your plate (e.g., "KDH123A") or your make/model.`;
    }

    return res.json({
      provider,
      model,
      content,
      vehicle: vehicle || null,
    });
  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({
      error: "Server error",
      detail: process.env.DEBUG_MODE === "1" ? err?.message : undefined,
      path: req.originalUrl,
    });
  }
});

module.exports = router;
