// routes/uploads.js
const express = require("express");
const router = express.Router();
const { signPutUrl, signGetUrl, publicUrl, deleteS3Object } = require("../utils/s3");

// helper to get shared pool from index.js
function getPool(req) {
  return req.app.get("pool");
}

// ----- Server-side limits (env-driven) -----
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "15", 10);
const ALLOWED_MIME_LIST = (process.env.ALLOWED_MIME_LIST || "application/pdf,image/jpeg,image/png")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// POST /api/uploads/sign-put  { key, contentType?, expiresIn?, sizeBytes? }
router.post("/sign-put", async (req, res) => {
  try {
    const { key, contentType, expiresIn, sizeBytes } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    // Validate size (if client passes it)
    if (sizeBytes && Number(sizeBytes) > MAX_UPLOAD_MB * 1024 * 1024) {
      return res.status(400).json({ error: `File too large. Max ${MAX_UPLOAD_MB} MB` });
    }

    // Validate content type if present
    if (contentType && ALLOWED_MIME_LIST.length && !ALLOWED_MIME_LIST.includes(contentType)) {
      return res.status(400).json({ error: `Disallowed content type. Allowed: ${ALLOWED_MIME_LIST.join(", ")}` });
    }

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

/**
 * POST /api/uploads/finalize
 * Body: { key, contentType?, sizeBytes?, label?, user_id? }
 * Saves/updates a record to the 'files' table after the client PUT to S3.
 */
router.post("/finalize", async (req, res) => {
  try {
    const { key, contentType = null, sizeBytes = null, label = null, user_id = null } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key'" });

    const pool = getPool(req);
    const bucket = process.env.S3_BUCKET;

    const q = await pool.query(
      `INSERT INTO files (user_id, bucket, s3_key, content_type, size_bytes, label)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (s3_key) DO UPDATE
         SET content_type = COALESCE(EXCLUDED.content_type, files.content_type),
             size_bytes   = COALESCE(EXCLUDED.size_bytes, files.size_bytes),
             label        = COALESCE(EXCLUDED.label, files.label)
       RETURNING id, user_id, bucket, s3_key, content_type, size_bytes, label, created_at`,
      [user_id, bucket, key, contentType, sizeBytes, label]
    );

    res.json({ ok: true, file: q.rows[0] });
  } catch (err) {
    console.error("uploads.finalize error:", err);
    res.status(500).json({ error: "Failed to save file record" });
  }
});

/**
 * POST /api/uploads/delete
 * Body: { key }
 * Deletes the object from S3 and removes the DB record.
 */
router.post("/delete", async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key'" });

    const pool = getPool(req);

    await deleteS3Object(key);
    await pool.query(`DELETE FROM files WHERE s3_key = $1`, [key]);

    res.json({ ok: true, message: "Deleted from S3 and DB", key });
  } catch (err) {
    console.error("uploads.delete error:", err);
    res.status(500).json({ error: "Failed to delete object" });
  }
});

module.exports = router;
