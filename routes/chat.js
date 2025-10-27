// routes/chat.js
const express = require("express");
const router = express.Router();

// Optional: only load OpenAI when we actually need it
let OpenAI = null;
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY && !process.env.LLM_API_KEY) {
    const err = new Error("LLM not configured: set OPENAI_API_KEY (or LLM_API_KEY)");
    err.status = 500;
    throw err;
  }
  if (!OpenAI) {
    // Lazy import so missing package errors are clearer here
    OpenAI = require("openai");
  }
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  return new OpenAI({ apiKey });
}

// --- helpers ---------------------------------------------------
const MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

/** remove spaces/dashes & uppercase: "KDH 123A" -> "KDH123A" */
function normalizePlate(p) {
  return String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** quick heuristic to detect plate-like string */
function looksLikePlate(s) {
  return /[A-Z]/i.test(s) && /[0-9]/.test(s);
}

/** try to find a vehicle from a free-form query */
async function pickVehicleFromQuery(pool, userId, userText) {
  const qText = (userText || "").trim();

  // Try plate match first (normalize both sides)
  if (looksLikePlate(qText)) {
    const norm = normalizePlate(qText);
    const byPlate = await pool.query(
      `SELECT id, name, type, plate_number, make, model, year_of_manufacture
         FROM vehicles
        WHERE user_id = $1
          AND UPPER(REGEXP_REPLACE(plate_number, '[^A-Z0-9]', '', 'g')) = $2
        LIMIT 1`,
      [userId, norm]
    );
    if (byPlate.rows.length) return byPlate.rows[0];
  }

  // Try make/model keywords (very simple fuzzy-ish search)
  const words = qText.split(/\s+/).filter(Boolean);
  if (words.length) {
    const like = `%${words.join("%")}%`;
    const byMakeModel = await pool.query(
      `SELECT id, name, type, plate_number, make, model, year_of_manufacture
         FROM vehicles
        WHERE user_id = $1
          AND (
            (make  IS NOT NULL AND make  ILIKE $2) OR
            (model IS NOT NULL AND model ILIKE $2) OR
            (name  IS NOT NULL AND name  ILIKE $2)
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, like]
    );
    if (byMakeModel.rows.length) return byMakeModel.rows[0];
  }

  return null;
}

/** build the strict system prompt */
function buildSystemPrompt(vehicle) {
  const vtxt = vehicle
    ? `Vehicle in focus:
- Plate: ${vehicle.plate_number || "N/A"}
- Name: ${vehicle.name || "N/A"}
- Make/Model/Year: ${vehicle.make || "?"} / ${vehicle.model || "?"} / ${vehicle.year_of_manufacture || "?"}
- Type: ${vehicle.type || "N/A"}`
    : `No specific vehicle resolved yet. Ask a clarifying question about plate / make / model if needed.`;

  return [
    "You are Saka360’s maintenance assistant.",
    "Only answer questions about the user’s vehicles and maintenance on this app.",
    "Be brief, practical, and action-oriented. Use bullet points when helpful.",
    "If the user asks about features/workflows, explain how to do it inside this app (not general web).",
    "Never provide random web answers. If external facts are needed, keep it generic and short.",
    vtxt,
  ].join("\n\n");
}

/** compose chat to OpenAI */
async function llmRespond(openai, systemPrompt, userMessages) {
  const { choices } = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...userMessages.map(m => ({ role: m.role, content: m.content }))
    ],
    temperature: 0.3,
  });
  return choices?.[0]?.message?.content?.trim() || "Sorry, I couldn’t draft a reply.";
}

// --- route -----------------------------------------------------
module.exports = (app) => {
  const pool = app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");

  /**
   * POST /api/chat
   * Body: { messages: [{role, content}], vehicle_hint?: string, dry?: boolean }
   * - Add `?dry=1` or body.dry=true to bypass LLM and just echo the resolved vehicle & parsed intent.
   * - Set DEBUG_MODE=1 to include error details in JSON on failure.
   */
  router.post("/", async (req, res) => {
    try {
      const { messages, vehicle_hint, dry } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Provide messages: [{role, content}, ...]" });
      }

      // For now, use a fixed demo user (replace with authenticateToken and req.user.id in prod)
      const userId = req.user?.id || 1;

      // Try to lock onto a vehicle:
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content || "";
      let vehicle = null;

      // 1) Direct hint (plate/make/model)
      if (vehicle_hint) {
        vehicle =
          (await pickVehicleFromQuery(pool, userId, vehicle_hint)) ||
          (await pickVehicleFromQuery(pool, userId, lastUserMsg));
      } else {
        // 2) Infer from the last user message
        vehicle = await pickVehicleFromQuery(pool, userId, lastUserMsg);
      }

      // DRY RUN mode for diagnostics (no LLM call)
      const isDry = Boolean(dry) || req.query.dry === "1";
      if (isDry) {
        return res.json({
          dry: true,
          resolved_vehicle: vehicle,
          note: vehicle
            ? "Vehicle resolved. Real mode would now ask the LLM with this context."
            : "No vehicle resolved. In real mode the assistant would ask a clarifying question.",
        });
      }

      // Real LLM call
      const openai = getOpenAI();
      const systemPrompt = buildSystemPrompt(vehicle);
      const text = await llmRespond(openai, systemPrompt, messages);

      return res.json({
        provider: "openai",
        model: MODEL,
        content: text,
        vehicle: vehicle || null
      });
    } catch (err) {
      console.error("chat error:", err);
      return res.status(500).json({
        error: "Server error",
        detail: process.env.DEBUG_MODE === "1" ? (err?.message || String(err)) : undefined
      });
    }
  });

  app.use("/api/chat", router);
};
