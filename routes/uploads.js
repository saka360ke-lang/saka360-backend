// routes/uploads.js
const express = require("express");
const router = express.Router();

const {
  debugAws,
  getPresignedGetUrl,
  getPresignedPutUrl,
} = require("../utils/s3");

// --- Debug your AWS env quickly ---
router.get("/debug/aws", (_req, res) => {
  try {
    return res.json(debugAws());
  } catch (err) {
    return res.status(500).json({ error: "Debug failed", detail: err.message });
  }
});

// --- POST: create presigned GET URL ---
router.post("/sign-get", async (req, res) => {
  try {
    const { key, expiresInSec = 300 } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    const url = await getPresignedGetUrl({ key, expiresInSec: Number(expiresInSec) });
    return res.json({ method: "GET", key, expiresInSec: Number(expiresInSec), url });
  } catch (err) {
    console.error("sign-get error:", err);
    return res.status(500).json({ error: "Failed to create GET URL", detail: err.message });
  }
});

// --- POST: create presigned PUT URL ---
router.post("/sign-put", async (req, res) => {
  try {
    const { key, contentType = "application/octet-stream", expiresInSec = 300 } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    const url = await getPresignedPutUrl({
      key,
      contentType: String(contentType),
      expiresInSec: Number(expiresInSec),
    });
    return res.json({ method: "PUT", key, contentType, expiresInSec: Number(expiresInSec), url });
  } catch (err) {
    console.error("sign-put error:", err);
    return res.status(500).json({ error: "Failed to create PUT URL", detail: err.message });
  }
});

// --- (Optional) Convenience GET versions so you can test in a browser ---
router.get("/sign-get", async (req, res) => {
  try {
    const key = (req.query.key || "").toString().trim();
    const expiresInSec = parseInt(req.query.expiresInSec || "300", 10);
    if (!key) return res.status(400).json({ error: "Missing ?key=..." });

    const url = await getPresignedGetUrl({ key, expiresInSec });
    return res.json({ method: "GET", key, expiresInSec, url });
  } catch (err) {
    console.error("sign-get (GET) error:", err);
    return res.status(500).json({ error: "Failed to sign GET", detail: err.message });
  }
});

router.get("/sign-put", async (req, res) => {
  try {
    const key = (req.query.key || "").toString().trim();
    const contentType = (req.query.contentType || "application/octet-stream").toString();
    const expiresInSec = parseInt(req.query.expiresInSec || "300", 10);
    if (!key) return res.status(400).json({ error: "Missing ?key=..." });

    const url = await getPresignedPutUrl({ key, contentType, expiresInSec });
    return res.json({ method: "PUT", key, contentType, expiresInSec, url });
  } catch (err) {
    console.error("sign-put (GET) error:", err);
    return res.status(500).json({ error: "Failed to sign PUT", detail: err.message });
  }
});

module.exports = router;
