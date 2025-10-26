// routes/uploads.js
const express = require("express");
const router = express.Router();
const { signPutUrl, signGetUrl, publicUrl } = require("../utils/s3");

// POST /api/uploads/sign-put  { key, contentType?, expiresIn? }
router.post("/sign-put", async (req, res) => {
  try {
    const { key, contentType, expiresIn } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    const out = await signPutUrl({ key, contentType, expiresIn });
    // out = { url, key, contentType, publicUrl }
    res.json({ method: "PUT", ...out });
  } catch (err) {
    console.error("sign-put error:", err);
    res.status(500).json({ error: "Failed to create PUT URL", detail: err.message });
  }
});

// POST /api/uploads/sign-get  { key, expiresIn? }
router.post("/sign-get", async (req, res) => {
  try {
    const { key, expiresIn } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    const out = await signGetUrl({ key, expiresIn });
    // out = { url, key, expiresInSec, method:"GET" }
    res.json(out);
  } catch (err) {
    console.error("sign-get error:", err);
    res.status(500).json({ error: "Failed to create GET URL", detail: err.message });
  }
});

// GET /api/uploads/public-url?key=docs/test.pdf
router.get("/public-url", (req, res) => {
  const { key } = req.query || {};
  if (!key) return res.status(400).json({ error: "Missing 'key' query" });
  return res.json({ url: publicUrl(key) });
});

module.exports = router;
