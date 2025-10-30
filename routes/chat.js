// routes/chat.js
const express = require("express");
const router = express.Router();
const OpenAI = require("openai");

// Use OPENAI (or GEMINI/ANTHROPIC). We default to OPENAI.
const PROVIDER = process.env.LLM_PROVIDER || "OPENAI";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function normalizePlate(input) {
  if (!input) return null;
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// Try to find a vehicle by (plate OR make OR model). Plate is normalized.
async function findVehicle(pool, query) {
  const plateNorm = normalizePlate(query);
  // We’ll look by plate first, then make/model fuzzy
  const sql = `
    WITH v AS (
      SELECT id, name, plate_number, type, make, model, year_of_manufacture
      FROM public.vehicles
    )
    SELECT *
    FROM v
    WHERE
      ($1::text IS NOT NULL AND replace(upper(plate_number), ' ', '') = $1)
      OR (make ILIKE $2)
      OR (model ILIKE $3)
    ORDER BY id DESC
    LIMIT 1;
  `;
  const params = [
    plateNorm,                      // $1 normalized plate
    `%${query}%`,                   // $2 make fuzzy
    `%${query}%`,                   // $3 model fuzzy
  ];
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
}

// Build a grounded system prompt that limits scope
function buildSystemPrompt(vehicle, orgName = "Saka360") {
  const base = `
You are the ${orgName} assistant. You ONLY answer questions related to vehicle record management for the user's own vehicles in their account: service, fuel, documents, reminders, subscriptions, app usage and help.
Do not act as a general search engine. Be concise and actionable.
If the user asks for records or uploads, instruct them how to do it via the Saka360 app or WhatsApp workflow.
`;

  if (!vehicle) return base;

  return `${base}

Focus vehicle (if relevant to the user's question):
- Plate: ${vehicle.plate_number || "N/A"}
- Make: ${vehicle.make || "N/A"}
- Model: ${vehicle.model || "N/A"}
- Year: ${vehicle.year_of_manufacture || "N/A"}

If the user only gave part of the info (e.g., plate or make only), infer the rest from the DB result above. Keep answers short and to-the-point.`;
}

router.post("/chat", async (req, res) => {
  try {
    // IMPORTANT: pull pool from req.app (since this file exports a Router)
    const pool = req.app.get("pool");
    if (!pool) {
      return res.status(500).json({
        error: "Server error",
        detail: "Pool not found on app; set app.set('pool', pool) in index.js",
        path: "/api/chat",
      });
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: "messages[] required" });
    }

    // naive “query string” from latest user message
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const queryText = (lastUser?.content || "").trim();

    // If the user mentioned a plate/make/model fragment, try fetch a vehicle
    let vehicle = null;
    if (queryText) {
      vehicle = await findVehicle(pool, queryText);
    }

    const system = buildSystemPrompt(vehicle, "Saka360");

    // Provider: OpenAI
    if (PROVIDER === "OPENAI") {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const chatMessages = [
        { role: "system", content: system },
        ...messages,
      ];
      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: chatMessages,
        temperature: 0.3,
      });

      const content = completion.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";
      return res.json({
        provider: "openai",
        model: OPENAI_MODEL,
        content,
        vehicle: vehicle || null,
      });
    }

    // If you add other providers later, branch here.
    return res.status(500).json({ error: "LLM provider not configured" });
  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({
      error: "Server error",
      detail: process.env.DEBUG_MODE === "1" ? (err?.message || String(err)) : undefined,
      path: "/api/chat",
    });
  }
});

module.exports = router;
