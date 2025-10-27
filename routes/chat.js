// routes/chat.js
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { chatComplete } = require("../utils/ai");

// Helper: simple scope check against allowed keywords
function isInScope(userMessagesText, allowedKeywords) {
  if (!allowedKeywords || allowedKeywords.length === 0) return false;
  const hay = ` ${userMessagesText.toLowerCase()} `;
  return allowedKeywords.some(k => hay.includes(` ${k.toLowerCase()} `));
}

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool"); // shared DB pool from index.js

  /**
   * POST /api/chat
   * Body: { messages: [{role:'user'|'system'|'assistant', content:'...'}] }
   * Auth: Bearer token required
   * Scope: limited to user's vehicle make/model (and vehicle names if provided)
   */
  router.post("/", authenticateToken, async (req, res) => {
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Missing 'messages' (array of {role, content})" });
      }

      // 1) Load user's vehicles (make/model/name) as scope
      const { rows } = await pool.query(
        `SELECT id, name, make, model, plate_number
           FROM vehicles
          WHERE user_id = $1
          ORDER BY created_at ASC`,
        [req.user.id]
      );

      if (rows.length === 0) {
        return res.status(400).json({
          error: "No vehicles found",
          detail: "Add at least one vehicle (make/model) before using the assistant."
        });
      }

      // Build allowed keywords list (make, model, name, plate if present)
      const allowed = [];
      for (const v of rows) {
        if (v.make) allowed.push(String(v.make));
        if (v.model) allowed.push(String(v.model));
        if (v.name) allowed.push(String(v.name));
        if (v.plate_number) allowed.push(String(v.plate_number));
        // also combined "make model"
        if (v.make && v.model) allowed.push(`${v.make} ${v.model}`);
      }

      // 2) Hard scope check: block if user prompt doesn’t reference any allowed keyword
      const userText = messages
        .filter(m => m.role === "user")
        .map(m => m.content || "")
        .join(" ");
      if (!isInScope(userText, allowed)) {
        return res.status(400).json({
          error: "Out-of-scope",
          detail: "Ask only about your vehicles (make/model/name/plate).",
          allowed_examples: allowed.slice(0, 12) // hint without leaking full list if huge
        });
      }

      // 3) Add a system message that *enforces* scope inside the LLM as well
      const scopeSystemPrompt = [
        "You are Saka360’s vehicle records assistant.",
        "Only answer questions directly related to the user’s vehicles listed below.",
        "If the question is outside this scope (e.g., general topics, cars they do not own), refuse and say:",
        `"I can only help with the vehicles on your account. Please mention the make/model, name or plate from your garage."`,
        "",
        "Allowed vehicles (keywords):",
        ...allowed.map(k => `- ${k}`)
      ].join("\n");

      const scopedMessages = [
        { role: "system", content: scopeSystemPrompt },
        ...messages
      ];

      // 4) Call LLM
      const result = await chatComplete(scopedMessages, {
        temperature: 0.2,
        max_tokens: 600
      });

      return res.json({
        provider: result.provider,
        model: result.model || undefined,
        content: result.content,
        scope: { allowed_count: allowed.length } // small debug aid
      });
    } catch (err) {
      console.error("chat (scoped) error:", err);
      return res.status(500).json({ error: "Chat failed", detail: err.message });
    }
  });

  // Mount under /api/chat
  app.use("/api/chat", router);
};
