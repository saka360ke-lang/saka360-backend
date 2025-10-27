// routes/chat.js
const express = require("express");
const router = express.Router();
const { chatComplete } = require("../utils/ai");

// POST /api/chat
router.post("/", async (req, res) => {
  try {
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing 'messages' (array of {role, content})" });
    }
    const result = await chatComplete(messages);
    res.json(result);
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "Chat failed", detail: err.message });
  }
});

module.exports = router;
