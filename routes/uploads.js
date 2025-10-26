// routes/uploads.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { signPutUrl, signGetUrl, publicUrl, safeDeleteObject } = require("../utils/s3");

/** Helpers */
function userPrefix(userId) {
  // all user uploads live under this prefix
  return `users/${userId}/`;
}
function ensureUserKey(userId, key) {
  const allowed = userPrefix(userId);
  if (!key || typeof key !== "string") throw new Error("Missing or invalid key");
  if (!key.startsWith(allowed)) {
    throw new Error(`Key must start with "${allowed}"`);
  }
}

/**
 * POST /api/uploads/sign-put
 * Body: { key, contentType?, contentDisposition?, expiresIn? }
 */
router.post("/sign-put", authenticateToken, async (req, res) => {
  try {
    const { key, contentType, contentDisposition, expiresIn } = req.body || {};
    ensureUserKey(req.user.id, key);

    const out = await signPutUrl({ key, contentType, contentDisposition, expiresIn });
    res.json({ method: "PUT", ...out });
  } catch (err) {
    console.error("sign-put error:", err);
    res.status(400).json({ error: err.message || "Failed to create PUT URL" });
  }
});

/**
 * POST /api/uploads/sign-get
 * Body: { key, expiresIn?, download?: boolean, filename?: string }
 */
router.post("/sign-get", authenticateToken, async (req, res) => {
  try {
    const { key, expiresIn, download, filename } = req.body || {};
    ensureUserKey(req.user.id, key);

    let contentDisposition;
    if (download) {
      contentDisposition = filename ? `attachment; filename="${filename}"` : "attachment";
    }

    const out = await signGetUrl({ key, expiresIn, contentDisposition });
    res.json(out);
  } catch (err) {
    console.error("sign-get error:", err);
    res.status(400).json({ error: err.message || "Failed to create GET URL" });
  }
});

/**
 * POST /api/uploads/finalize
 * Body: { key, contentType?, sizeBytes?, label? }
 * Saves a DB record tied to the current user.
 */
router.post("/finalize", authenticateToken, async (req, res) => {
  try {
    const pool = req.app.get("pool");
    const { key, contentType, sizeBytes, label } = req.body || {};
    ensureUserKey(req.user.id, key);

    const q = await pool.query(
      `INSERT INTO files (user_id, bucket, s3_key, content_type, size_bytes, label)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (s3_key) DO UPDATE
         SET user_id=$1, content_type=$4, size_bytes=$5, label=$6
       RETURNING *`,
      [
        req.user.id,
        process.env.S3_BUCKET,
        key,
        contentType || null,
        sizeBytes || null,
        label || null
      ]
    );

    res.json({ ok: true, file: q.rows[0], publicUrl: publicUrl(key) });
  } catch (err) {
    console.error("finalize error:", err);
    res.status(500).json({ error: "Failed to save file record", detail: err.message });
  }
});

/**
 * GET /api/uploads/my
 * Returns latest files for the current user.
 */
router.get("/my", authenticateToken, async (req, res) => {
  try {
    const pool = req.app.get("pool");
    const q = await pool.query(
      `SELECT id, s3_key, bucket, content_type, size_bytes, label, created_at
       FROM files
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    res.json({ files: q.rows });
  } catch (err) {
    console.error("my files error:", err);
    res.status(500).json({ error: "Failed to list files" });
  }
});

/**
 * DELETE /api/uploads/by-key
 * Body: { key }
 * Deletes the S3 object and the DB record (only if it belongs to the user).
 */
router.delete("/by-key", authenticateToken, async (req, res) => {
  try {
    const { key } = req.body || {};
    ensureUserKey(req.user.id, key);

    const pool = req.app.get("pool");

    // Ensure the record belongs to this user
    const check = await pool.query(
      `SELECT id FROM files WHERE s3_key=$1 AND user_id=$2 LIMIT 1`,
      [key, req.user.id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "File not found" });
    }

    // Best-effort delete in S3 (never throws at caller)
    await safeDeleteObject(key);

    // Delete DB record
    await pool.query(`DELETE FROM files WHERE s3_key=$1 AND user_id=$2`, [key, req.user.id]);

    res.json({ ok: true, deleted: key });
  } catch (err) {
    console.error("delete by-key error:", err);
    res.status(400).json({ error: err.message || "Failed to delete" });
  }
});

/**
 * GET /api/uploads/public-url?key=...
 * (Kept for convenience—still requires auth and enforces prefix)
 */
router.get("/public-url", authenticateToken, (req, res) => {
  try {
    const { key } = req.query || {};
    ensureUserKey(req.user.id, key);
    return res.json({ url: publicUrl(key) });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Invalid key" });
  }
});

module.exports = router;
