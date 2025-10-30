// routes/chat.js
const express = require("express");
const router = express.Router();
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// normalize plate like "KDH 123A" -> "KDH123A"
function normPlate(s = "") {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// very light intent routing to influence prompts
function detectIntent(text) {
  const t = text.toLowerCase();
  if (/^(help|menu)$/.test(t)) return "help";
  if (/^add( |$)|add vehicle/.test(t)) return "add_vehicle";
  if (/delete vehicle/.test(t)) return "delete_vehicle";
  if (/service/.test(t)) return "service";
  if (/upload|document|insurance|logbook|inspection|sticker/.test(t)) return "upload";
  if (/reminder|reminders|settings/.test(t)) return "reminders";
  if (/register|sign ?up/.test(t)) return "register";
  if (/payment|subscribe|plan|package/.test(t)) return "payments";
  if (/affiliate|payout/.test(t)) return "affiliate";
  return "general";
}

function whatsappHelpBlock() {
  return [
    "On WhatsApp, you can:",
    "• add vehicle <plate> <make> <model> <year>",
    "• delete vehicle <plate>",
    "• my vehicles",
    "• set reminders email on|off whatsapp on|off days <N>",
    "• upload by sending a photo/PDF (caption with plate helps)",
    '• service <km> for <plate|make|model>',
  ].join("\n");
}

module.exports = (app) => {
  const pool = app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");

  router.post("/chat", async (req, res) => {
    try {
      const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const userMsg = msgs.find(m => m.role === "user")?.content?.toString() || "";
      const intent = detectIntent(userMsg);

      // Try to resolve a vehicle (by plate/make/model)
      let vehicle = null;
      if (userMsg.trim()) {
        const plateCandidate = normPlate(userMsg);
        const q = await pool.query(
          `SELECT id, name, plate_number, make, model, year_of_manufacture
             FROM vehicles
            WHERE UPPER(REGEXP_REPLACE(plate_number,'[^A-Za-z0-9]','','g')) = $1
               OR LOWER(make) = LOWER($2)
               OR LOWER(model) = LOWER($2)
            ORDER BY created_at ASC
            LIMIT 1`,
          [plateCandidate, userMsg.trim()]
        );
        if (q.rows.length) vehicle = q.rows[0];
      }

      // Build a very opinionated system message so answers guide WhatsApp actions
      const systemPrompt = [
        "You are Saka360 Assistant. Your job is to help vehicle owners use Saka360.",
        "CRITICAL RULES:",
        "- Keep answers short, clear, and practical.",
        "- ALWAYS end with a 'Do this on WhatsApp:' section listing EXACT commands the user can send.",
        "- Prefer WhatsApp flows over web UI steps.",
        "- If the user says only 'service' or 'add service log', tell them how to do it via WhatsApp commands.",
        "- For uploads: tell them to send a photo/PDF in the WhatsApp chat (caption with plate helps).",
        "- If a vehicle is identified, mention it (make/model/plate) briefly.",
        "- If an instruction needs the user’s plate, make, or model, explicitly show the command template.",
        "",
        "Saka360 WhatsApp commands:",
        "• add vehicle <plate> <make> <model> <year>",
        "• delete vehicle <plate>",
        "• my vehicles",
        "• set reminders email on|off whatsapp on|off days <N>",
        "• upload by sending a photo/PDF (caption with plate helps)",
        "• service <km> for <plate|make|model>",
        "",
        "Keep it friendly and concise.",
      ].join("\n");

      // Seed assistant with context about the detected vehicle (if any)
      const context = vehicle
        ? `Detected vehicle: ${vehicle.make || ""} ${vehicle.model || ""} (${vehicle.plate_number})`
        : "No specific vehicle matched.";

      // A tiny “intent hint” to make the LLM more directive
      const intentHint = `Intent: ${intent}`;

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: context },
        { role: "assistant", content: intentHint },
        ...msgs,
        {
          role: "assistant",
          content: "Remember to finish with 'Do this on WhatsApp:' and concrete commands."
        }
      ];

      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.3,
        messages
      });

      const content = completion.choices?.[0]?.message?.content || "Sorry, I couldn’t process that.";

      return res.json({
        provider: "openai",
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        content,
        vehicle: vehicle || null,
      });
    } catch (err) {
      console.error("chat error:", err);
      res.status(500).json({ error: "Server error", detail: err.message, path: "/api/chat" });
    }
  });

  return router;
};
