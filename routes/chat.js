// routes/chat.js
/**
 * Vehicle-aware chat endpoint with robust error handling.
 * - Resolves vehicle by plate (space-insensitive), make, or model.
 * - Pulls a few recent logs.
 * - Calls OpenAI if configured; otherwise returns a clear JSON error.
 * - Never returns HTML error pages; always JSON.
 */
const express = require("express");
const router = express.Router();

const DEBUG_MODE = process.env.DEBUG_MODE === "1";

// Lazy load OpenAI so missing module won't crash require()
let OpenAILib = null;
try {
  OpenAILib = require("openai");
} catch (e) {
  console.error("[chat] openai module not found:", e.message);
}

const PROVIDER = process.env.LLM_PROVIDER || "openai";
const OPENAI_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;

function normalizePlate(input = "") {
  return String(input).toUpperCase().replace(/\s+/g, "");
}

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

async function resolveVehicle(pool, searchText) {
  let vehicle = null;

  const hasMake = await hasColumn(pool, "vehicles", "make");
  const hasModel = await hasColumn(pool, "vehicles", "model");
  const hasYom = await hasColumn(pool, "vehicles", "year_of_manufacture");

  const cols = [
    "id",
    "name",
    "plate_number",
    "type",
    hasMake ? "make" : "NULL AS make",
    hasModel ? "model" : "NULL AS model",
    hasYom ? "year_of_manufacture" : "NULL AS year_of_manufacture",
    "created_at",
  ].join(", ");

  if (searchText && searchText.trim().length > 0) {
    const raw = searchText.trim();
    const norm = normalizePlate(raw);

    // 1) Plate match (ignore spaces)
    const q1 = await pool.query(
      `SELECT ${cols}
         FROM vehicles
        WHERE REPLACE(UPPER(plate_number), ' ', '') = $1
        LIMIT 1`,
      [norm]
    );
    if (q1.rowCount > 0) return q1.rows[0];

    // 2) Make/Model LIKE if present
    if (hasMake || hasModel) {
      const like = `%${raw.toLowerCase()}%`;
      const q2 = await pool.query(
        `SELECT ${cols}
           FROM vehicles
          WHERE ($1::text <> '' AND ${hasMake ? "LOWER(make) LIKE $2" : "false"})
             OR ($1::text <> '' AND ${hasModel ? "LOWER(model) LIKE $2" : "false"})
          ORDER BY created_at DESC
          LIMIT 1`,
        [raw, like]
      );
      if (q2.rowCount > 0) return q2.rows[0];
    }
  }

  // 3) Fallback to most-recent vehicle
  const q3 = await pool.query(
    `SELECT ${cols}
       FROM vehicles
      ORDER BY created_at DESC
      LIMIT 1`
  );
  if (q3.rowCount > 0) vehicle = q3.rows[0];
  return vehicle;
}

async function getRecentService(pool, vehicleId, limit = 3) {
  try {
    const q = await pool.query(
      `SELECT id, description, cost, odometer, created_at
         FROM service_logs
        WHERE vehicle_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [vehicleId, limit]
    );
    return q.rows;
  } catch (e) {
    console.error("[chat] getRecentService error:", e.message);
    return [];
  }
}

async function getRecentFuel(pool, vehicleId, limit = 3) {
  try {
    const q = await pool.query(
      `SELECT id, amount, liters, price_per_liter, odometer, created_at
         FROM fuel_logs
        WHERE vehicle_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [vehicleId, limit]
    );
    return q.rows;
  } catch (e) {
    console.error("[chat] getRecentFuel error:", e.message);
    return [];
  }
}

function buildSystemPrompt() {
  return `
You are Saka360's vehicle assistant. Stay within vehicle maintenance and records for the user's vehicles.
- If the user mentions only a plate, make, or model, infer details from provided context.
- Be concise, practical, and specific.
- When giving maintenance intervals, say they are general guidelines; advise checking the owner's manual.
- If asked about using the app, give short, step-by-step instructions.
- If user asks outside scope, politely redirect to maintenance/records.`;
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
    const started = Date.now();
    try {
      // Validate messages
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
      if (!messages || messages.length === 0) {
        return res.status(400).json({ error: "Missing 'messages' array with at least one item." });
      }
      const lastUserMsg =
        [...messages].reverse().find((m) => m.role === "user")?.content || "";

      // Resolve vehicle via heuristic token
      const searchHint =
        String(lastUserMsg)
          .split(/[\s,.;:!?\n\r]+/)
          .filter((t) => /[A-Za-z0-9]/.test(t))
          .sort((a, b) => b.length - a.length)[0] || "";

      const vehicle = await resolveVehicle(pool, searchHint);
      const [serviceLogs, fuelLogs] = vehicle
        ? await Promise.all([
            getRecentService(pool, vehicle.id, 3),
            getRecentFuel(pool, vehicle.id, 3),
          ])
        : [[], []];

      const system = buildSystemPrompt();
      const context = buildVehicleContext(vehicle, serviceLogs, fuelLogs);

      // Provider / key checks
      if (PROVIDER !== "openai") {
        return res.status(500).json({
          error: "LLM provider not supported",
          detail: `PROVIDER=${PROVIDER}`,
        });
      }
      if (!OpenAILib) {
        return res.status(500).json({
          error: "LLM module missing",
          detail: "Install 'openai' in package.json",
        });
      }
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: "LLM not configured",
          detail: "Missing OPENAI_API_KEY (or LLM_API_KEY)",
        });
      }

      const client = new OpenAILib({ apiKey: OPENAI_API_KEY });

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

      let answer = "";
      try {
        const completion = await client.chat.completions.create({
          model: OPENAI_MODEL,
          temperature: 0.2,
          messages: llmMessages,
        });
        answer = completion.choices?.[0]?.message?.content?.trim() || "";
      } catch (e) {
        console.error("[chat] OpenAI error:", e.message);
        return res.status(502).json({
          error: "LLM call failed",
          detail: DEBUG_MODE ? e.message : "provider_error",
        });
      }

      const ms = Date.now() - started;
      return res.json({
        provider: "openai",
        model: OPENAI_MODEL,
        latency_ms: ms,
        content: answer || "I couldn't generate a response.",
        vehicle: vehicle || null,
      });
    } catch (err) {
      console.error("[chat] fatal error:", err);
      return res.status(500).json({
        error: "Chat failed",
        detail: DEBUG_MODE ? err.message : "internal_error",
      });
    }
  });

  app.use("/api", router);
};
