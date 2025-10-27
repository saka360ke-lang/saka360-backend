const express = require("express");
const router = express.Router();
const { chatComplete } = require("../utils/ai");

router.post("/", async (req, res) => {
  try {
    const messages = req.body?.messages;
    if (!messages) return res.status(400).json({ error: "Missing messages" });

    const result = await chatComplete(messages);
    res.json(result);
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "Chat failed", detail: err.message });
  }
});

module.exports = router;
