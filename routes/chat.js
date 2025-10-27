// routes/chat.js
/**
 * Vehicle-aware chat endpoint:
 * - Resolves vehicle by plate/make/model (plate matching ignores spaces)
 * - Uses ONLY columns that exist (no hard dependency on updated_at)
 * - Pulls a few recent service/fuel records when available
 * - Sends the user prompt + concise context to the LLM
 */
const express = require("express");
const router = express.Router();

let OpenAI;
try {
  OpenAI = require("openai");
} catch (_) {
  OpenAI = null;
}

const PROVIDER = process.env.LLM_PROVIDER || "openai";
const OPENAI_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;

function normalizePlate(input = "") {
  return String(input).toUpperCase().replace(/\s+/g, "");
}

// Check if a column exists on a table
async function hasColumn(pool, table, column) {
  const q = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column]
  );
  return q.rowCount > 0;
}

// Resolve a vehicle when user provides plate, make, or model (or nothing).
// Prefers exact plate (whitespace-insensitive), otherwise tries make/model LIKE.
async function resolveVehicle(pool, searchText) {
  let vehicle = null;

  const hasMake = await hasColumn(pool, "vehicles", "make");
  const hasModel = await hasColumn(pool, "vehicles", "model");
  const hasYom = await hasColumn(pool, "vehicles", "year_of_manufacture");

  // Build dynamic column list
  const cols = [
    "id",
    "name",
    "plate_number",
    "type",
    hasMake ? "make" : "NULL AS make",
    hasModel ? "model" : "NULL AS model",
    hasYom ? "year_of_manufacture" : "NULL AS year_of_manufacture",
    "created_at"
  ].join(", ");

  // If the user gave any text, attempt best-effort resolution:
  if (searchText && searchText.trim().length > 0) {
    const raw = searchText.trim();
    const norm = normalizePlate(raw);

    // 1) Try exact plate match ignoring spaces
    const q1 = await pool.query(
      `
      SELECT ${cols}
        FROM vehicles
       WHERE REPLACE(UPPER(plate_number), ' ', '') = $1
       LIMIT 1
      `,
      [norm]
    );
    if (q1.rowCount > 0) return q1.rows[0];

    // 2) Try make/model LIKE (only if columns exist)
    if (hasMake || hasModel) {
      const like = `%${raw.toLowerCase()}%`;
      const q2 = await pool.query(
        `
        SELECT ${cols}
          FROM vehicles
         WHERE ($1::text <> '' AND ${hasMake ? "LOWER(make) LIKE $2" : "false"})
            OR ($1::text <> '' AND ${hasModel ? "LOWER(model) LIKE $2" : "false"})
         ORDER BY created_at DESC
         LIMIT 1
        `,
        [raw, like]
      );
      if (q2.rowCount > 0) return q2.rows[0];
    }
  }

  // 3) Fall back to the most-recently created vehicle (if any)
  const q3 = await pool.query(
    `SELECT ${cols}
       FROM vehicles
      ORDER BY created_at DESC
      LIMIT 1`
  );
  if (q3.rowCount > 0) vehicle = q3.rows[0];

  return vehicle; // may be null
}

async function getRecentService(pool, vehicleId, limit = 3) {
  // Use created_at for ordering; do not assume updated_at exists.
  try {
    const q = await pool.query(
      `
      SELECT id, description, cost, odometer, created_at
        FROM service_logs
       WHERE vehicle_id = $1
       ORDER BY created_at DESC
       LIMIT $2
      `,
      [vehicleId, limit]
    );
    return q.rows;
  } catch {
    return [];
  }
}

async function getRecentFuel(pool, vehicleId, limit = 3) {
  try {
    const q = await pool.query(
      `
      SELECT id, amount, liters, price_per_liter, odometer, created_at
        FROM fuel_logs
       WHERE vehicle_id = $1
       ORDER BY created_at DESC
       LIMIT $2
      `,
      [vehicleId, limit]
    );
    return q.rows;
  } catch {
    return [];
  }
}

function buildSystemPrompt() {
  return `
You are Saka360's vehicle assistant. Strictly stay within vehicle maintenance and records for the user's vehicles. 
- If the user mentions only a plate, make, or model, infer the vehicle details from the provided context.
- Be concise, practical, and specific. 
- If you cite service intervals, clarify they are general guidelines and advise to check the owner's manual.
- If the user asks how to use the app, give short, step-by-step instructions.

When the question is outside vehicle maintenance/records, politely redirect back to the service's scope.`;
}

function buildVehicleContext(vehicle, serviceLogs, fuelLogs) {
  const v = vehicle
    ? `Vehicle:
- Name: ${vehicle.name || "-"}
- Plate: ${vehicle.plate_number || "-"}
- Type: ${vehicle.type || "-"}
- Make/Model/YOM: ${vehicle.make || "-"} / ${vehicle.model || "-"} / ${vehicle.year_of_manufacture || "-"}`
    : "No vehicle on file.";

  const s = serviceLogs.length
    ? `Recent service logs:
${serviceLogs
  .map(
    (r) =>
      `- ${new Date(r.created_at).toISOString().slice(0, 10)} | ${r.description || "Service"} | KES ${r.cost ?? "-"} | Odo ${r.odometer ?? "-"}`
  )
  .join("\n")}`
    : "No recent service logs.";

  const f = fuelLogs.length
    ? `Recent fuel logs:
${fuelLogs
  .map(
    (r) =>
      `- ${new Date(r.created_at).toISOString().slice(0, 10)} | Amount KES ${r.amount ?? "-"} | Liters ${r.liters ?? "-"} | Price/L ${r.price_per_liter ?? "-"} | Odo ${r.odometer ?? "-"}`
  )
  .join("\n")}`
    : "No recent fuel logs.";

  return `${v}\n\n${s}\n\n${f}`;
}

module.exports = (app) => {
  const pool = app.get("pool");

  router.post("/chat", async (req, res) => {
    try {
      if (!OpenAI || !OPENAI_API_KEY) {
        return res.status(500).json({ error: "LLM not configured" });
      }
      const client = new OpenAI({ apiKey: OPENAI_API_KEY });

      // Pull the last user message (or any provided messages array)
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const lastUserMsg =
        [...messages].reverse().find((m) => m.role === "user")?.content || "";

      // Try to infer a search hint (plate/make/model) from the last user message.
      // Very light heuristic: pick the longest token with letters/numbers.
      const searchHint =
        String(lastUserMsg)
          .split(/[\s,.;:!?\n\r]+/)
          .filter((t) => /[A-Za-z0-9]/.test(t))
          .sort((a, b) => b.length - a.length)[0] || "";

      // Resolve the vehicle (by plate/make/model or fallback)
      const vehicle = await resolveVehicle(pool, searchHint);

      // Fetch recent service/fuel logs if we have a vehicle
      const [serviceLogs, fuelLogs] = vehicle
        ? await Promise.all([
            getRecentService(pool, vehicle.id, 3),
            getRecentFuel(pool, vehicle.id, 3),
          ])
        : [[], []];

      // Build system + context
      const system = buildSystemPrompt();
      const context = buildVehicleContext(vehicle, serviceLogs, fuelLogs);

      // Compose final LLM messages
      const llmMessages = [
        { role: "system", content: system },
        {
          role: "user",
          content:
            `User question:\n${lastUserMsg}\n\n` +
            `Context (from DB):\n${context}\n\n` +
            `Rules:\n- Keep answers short and to the point.\n- Give steps for using the app when asked.\n- If maintenance intervals are described, say they are general guidelines.\n- Stay within vehicle maintenance/records scope.`
        }
      ];

      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: llmMessages
      });

      const answer = completion.choices?.[0]?.message?.content?.trim() || "I couldn't generate a response.";
      return res.json({
        provider: "openai",
        model: OPENAI_MODEL,
        content: answer,
        vehicle: vehicle || null
      });
    } catch (err) {
      console.error("chat error:", err);
      return res.status(500).json({ error: "Chat failed", detail: err.message });
    }
  });

  app.use("/api", router);
};
