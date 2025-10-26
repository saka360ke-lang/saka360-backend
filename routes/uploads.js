// routes/uploads.js
const express = require("express");
const router = express.Router();
const { signPutUrl, signGetUrl, publicUrl } = require("../utils/s3");

/**
 * POST /api/uploads/sign-put
 * Body: { key, contentType?, expiresIn? }
 */
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

/**
 * POST /api/uploads/sign-get
 * Body: { key, expiresIn? }
 */
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

/**
 * GET /api/uploads/public-url?key=docs/test.pdf
 */
router.get("/public-url", (req, res) => {
  const { key } = req.query || {};
  if (!key) return res.status(400).json({ error: "Missing 'key' query" });
  return res.json({ url: publicUrl(key) });
});

/**
 * POST /api/uploads/finalize
 * Body: { key, contentType, sizeBytes, label?, user_id? }
 * Saves a DB record after a successful PUT to S3.
 */
router.post("/finalize", async (req, res) => {
  try {
    const { key, contentType, sizeBytes, label, user_id } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    const pool = req.app.get("pool");
    if (!pool) return res.status(500).json({ error: "DB pool not initialized" });

    const bucket = process.env.S3_BUCKET;
    if (!bucket) return res.status(500).json({ error: "S3_BUCKET env missing" });

    // Insert into 'files' (no schema prefix to avoid schema mismatch)
    const q = await pool.query(
      `INSERT INTO files (user_id, bucket, s3_key, content_type, size_bytes, label)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (s3_key) DO UPDATE
         SET content_type = EXCLUDED.content_type,
             size_bytes   = EXCLUDED.size_bytes,
             label        = COALESCE(EXCLUDED.label, files.label)
       RETURNING id, user_id, bucket, s3_key, content_type, size_bytes, label, created_at`,
      [user_id || null, bucket, key, contentType || null, sizeBytes || null, label || null]
    );

    return res.json({
      ok: true,
      file: q.rows[0],
      publicUrl: publicUrl(key)
    });
  } catch (err) {
    console.error("uploads.finalize error:", err);
    return res.status(500).json({ error: "Failed to save file record", detail: err.message });
  }
});

module.exports = router;
