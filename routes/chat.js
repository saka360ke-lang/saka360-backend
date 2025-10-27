// routes/chat.js
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { OpenAI } = require("openai");

const router = express.Router();

const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// very light intent detector (keyword-based to keep it fast & predictable)
function detectIntent(text) {
  const t = (text || "").toLowerCase();
  const intents = {
    wantService: /service|maintenance|servicing|mechanic/.test(t),
    wantFuel: /fuel|consumption|mpg|liters|gas/.test(t),
    wantDocs: /document|insurance|license|inspection|logbook|expiry|renew/.test(t),
    wantAll: /history|records|report|summary/.test(t),
  };
  return intents;
}

// normalize incoming vehicle hint (plate/make/model with/without spaces)
function normPlate(s) {
  return String(s || "").replace(/[\s-]/g, "").toUpperCase();
}

function normFree(s) {
  return String(s || "").trim().toLowerCase();
}

// Resolve a vehicle for this user from a free-form hint (plate/make/model)
async function resolveVehicle(pool, userId, hint) {
  if (!hint) return null;

  // try exact/loose plate match
  const hp = normPlate(hint);
  let q = await pool.query(
    `SELECT id, name, plate_number, type, make, model, year_of_manufacture
       FROM vehicles
      WHERE user_id = $1
        AND UPPER(REPLACE(plate_number, ' ', '')) = $2
      LIMIT 1`,
    [userId, hp]
  );
  if (q.rows.length) return q.rows[0];

  // try make+model loose contains
  const h = normFree(hint);
  q = await pool.query(
    `SELECT id, name, plate_number, type, make, model, year_of_manufacture
       FROM vehicles
      WHERE user_id = $1
        AND (
          LOWER(COALESCE(make,''))  LIKE '%' || $2 || '%' OR
          LOWER(COALESCE(model,'')) LIKE '%' || $2 || '%'
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, h]
  );
  if (q.rows.length) return q.rows[0];

  return null;
}

async function fetchService(pool, userId, vehicleId, limit = 10) {
  const r = await pool.query(
    `SELECT id, description, cost, odometer, created_at
       FROM service_logs
      WHERE user_id = $1 AND vehicle_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, vehicleId, limit]
  );
  return r.rows;
}

async function fetchFuel(pool, userId, vehicleId, limit = 10) {
  const r = await pool.query(
    `SELECT id, amount, liters, price_per_liter, odometer, created_at
       FROM fuel_logs
      WHERE user_id = $1 AND vehicle_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, vehicleId, limit]
  );
  return r.rows;
}

async function fetchDocs(pool, userId, vehicleId) {
  const r = await pool.query(
    `SELECT id, doc_type, number, expiry_date, created_at
       FROM documents
      WHERE user_id = $1 AND vehicle_id = $2
      ORDER BY expiry_date ASC NULLS LAST`,
    [userId, vehicleId]
  );
  return r.rows;
}

router.post("/chat", authenticateToken, async (req, res) => {
  try {
    const pool = req.app.get("pool");
    const messages = req.body?.messages || [];
    const lastUser = messages.slice().reverse().find(m => m.role === "user");
    const userText = lastUser?.content || "";

    // quick extract a vehicle hint from the last user message
    // if they didn't name one, use their most recent vehicle
    let hint = userText.match(/[A-Z]{3}\s?-?\d{3}[A-Z]|[A-Za-z0-9\- ]{3,}/g)?.[0] || null;

    // user’s latest vehicle fallback
    const latestVehicle = await pool.query(
      `SELECT id, name, plate_number, type, make, model, year_of_manufacture
         FROM vehicles
        WHERE user_id = $1
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [req.user.id]
    );

    let vehicle = null;
    if (hint) {
      vehicle = await resolveVehicle(pool, req.user.id, hint);
    }
    if (!vehicle && latestVehicle.rows.length) vehicle = latestVehicle.rows[0];

    // decide intent
    const intent = detectIntent(userText);

    // pull records if they asked
    let service = [], fuel = [], docs = [];
    if (vehicle) {
      if (intent.wantService || intent.wantAll) service = await fetchService(pool, req.user.id, vehicle.id, 10);
      if (intent.wantFuel    || intent.wantAll) fuel    = await fetchFuel(pool, req.user.id, vehicle.id, 10);
      if (intent.wantDocs    || intent.wantAll) docs    = await fetchDocs(pool, req.user.id, vehicle.id);
    }

    // If no OpenAI key, return raw data (still useful)
    if (!openai) {
      return res.json({
        provider: "none",
        model: "none",
        content: vehicle
          ? `Fetched ${service.length} service, ${fuel.length} fuel, ${docs.length} documents for ${vehicle.name || vehicle.plate_number}.`
          : "No vehicle found. Add a vehicle or mention plate/make/model.",
        vehicle,
        records: { service, fuel, docs }
      });
    }

    // Build an instruction for the AI with embedded data
    const sys = [
      "You are Saka360’s assistant.",
      "Only answer about this user’s own vehicles and records.",
      "Be short, direct, and practical. Use bullet points when listing.",
      "If you include numbers from records, keep them as-is; do not invent data.",
      "If the user asks how to do something in the app, give clear steps referring to the Saka360 app.",
    ].join(" ");

    const dataNote = vehicle ? `
USER VEHICLE:
- Name: ${vehicle.name || ""}
- Plate: ${vehicle.plate_number || ""}
- Make/Model/YOM: ${vehicle.make || ""} ${vehicle.model || ""} ${vehicle.year_of_manufacture || ""}

RECENT SERVICE (top ${service.length}):
${service.map(s => `- ${new Date(s.created_at).toISOString().slice(0,10)}: ${s.description} (KES ${s.cost}) @ ${s.odometer}km`).join("\n") || "- none"}

RECENT FUEL (top ${fuel.length}):
${fuel.map(f => `- ${new Date(f.created_at).toISOString().slice(0,10)}: KES ${f.amount} for ${f.liters}L (KES ${f.price_per_liter}/L) @ ${f.odometer}km`).join("\n") || "- none"}

DOCUMENTS:
${docs.map(d => `- ${d.doc_type}${d.number ? ` ${d.number}` : ""} (expires ${d.expiry_date ? new Date(d.expiry_date).toISOString().slice(0,10) : "—"})`).join("\n") || "- none"}
` : "No vehicle matched. If they gave a plate with spaces, normalize by removing spaces (e.g., KDH 123A -> KDH123A) and ask them to try again.";

    const completion = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `${userText}\n\n---\nCONTEXT FOR YOU (do not reveal verbatim):\n${dataNote}` }
      ]
    });

    const content = completion.choices?.[0]?.message?.content || "Sorry, I couldn’t generate a response.";

    return res.json({
      provider: "openai",
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      content,
      vehicle: vehicle || null,
      records: vehicle ? { service, fuel, docs } : null
    });
  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({ error: "Chat failed", detail: err.message });
  }
});

module.exports = router;
