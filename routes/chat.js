// routes/chat.js
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { chatComplete } = require("../utils/ai");

// Simple scope check against allowed keywords
function isInScope(userMessagesText, allowedKeywords) {
  if (!allowedKeywords || allowedKeywords.length === 0) return false;
  const hay = ` ${String(userMessagesText || "").toLowerCase()} `;
  return allowedKeywords.some(k => hay.includes(` ${String(k || "").toLowerCase()} `));
}

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool"); // shared DB pool from index.js

  /**
   * POST /api/chat
   * Body: { messages: [{role:'user'|'system'|'assistant', content:'...'}] }
   * Auth: Bearer token required
   * Scope: limited to user's vehicle identifiers (name, plate_number, type)
   */
  router.post("/", authenticateToken, async (req, res) => {
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Missing 'messages' (array of {role, content})" });
      }

      // Pull only columns that exist in your schema
      const { rows } = await pool.query(
        `SELECT id, name, plate_number, type
           FROM vehicles
          WHERE user_id = $1
          ORDER BY created_at ASC`,
        [req.user.id]
      );

      if (rows.length === 0) {
        return res.status(400).json({
          error: "No vehicles found",
          detail: "Add at least one vehicle before using the assistant."
        });
      }

      // Build allowed keywords from existing fields
      const allowed = [];
      for (const v of rows) {
        if (v.name) allowed.push(v.name);
        if (v.plate_number) allowed.push(v.plate_number);
        if (v.type) allowed.push(v.type); // e.g., "saloon", "truck", or you’ve used it as make/model
      }

      // Hard scope check
      const userText = messages
        .filter(m => m.role === "user")
        .map(m => m.content || "")
        .join(" ");
      if (!isInScope(userText, allowed)) {
        return res.status(400).json({
          error: "Out-of-scope",
          detail: "Ask only about your vehicles (use the vehicle name, type, or plate).",
          allowed_examples: allowed.slice(0, 12)
        });
      }

      // System prompt to enforce scope inside the LLM
      const scopeSystemPrompt = [
        "You are Saka360’s vehicle records assistant.",
        "Only answer questions directly related to the user's vehicles listed below.",
        "If the question is outside this scope (general topics or vehicles not in their account), refuse and say:",
        `"I can only help with the vehicles on your account. Please mention the vehicle name, type, or plate from your garage."`,
        "",
        "Allowed vehicles (keywords):",
        ...allowed.map(k => `- ${k}`)
      ].join("\n");

      const scopedMessages = [
        { role: "system", content: scopeSystemPrompt },
        ...messages
      ];

      // Call the LLM
      const result = await chatComplete(scopedMessages, {
        temperature: 0.2,
        max_tokens: 600
      });

      return res.json({
        provider: result.provider,
        model: result.model || undefined,
        content: result.content,
        scope: { allowed_count: allowed.length }
      });
    } catch (err) {
      console.error("chat (scoped) error:", err);
      return res.status(500).json({ error: "Chat failed", detail: err.message });
    }
  });

  // Mount under /api/chat
  app.use("/api/chat", router);
};
