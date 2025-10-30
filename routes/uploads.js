// routes/uploads.js
const express = require("express");
const router = express.Router();
const { signPutUrl, signGetUrl, publicUrl, deleteObjectSafe } = require("../utils/s3");

// --- helpers ---
function cleanKey(raw) {
  if (!raw) return null;
  let k = String(raw).trim();

  // If someone pasted a full URL, reject (we only want the key)
  if (/^https?:\/\//i.test(k)) return null;

  // Decode URL-encoded keys (docs%2Ffile.pdf -> docs/file.pdf)
  try { k = decodeURIComponent(k); } catch (_) {}
  // remove accidental leading slash
  if (k.startsWith("/")) k = k.slice(1);

  // very basic sanity: must contain at least one slash (folder/key)
  if (!k.includes("/")) return null;

  return k;
}

function toIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// -----------------------------
// 1) Sign PUT
// -----------------------------
router.post("/sign-put", async (req, res) => {
  try {
    const { key, contentType, expiresIn } = req.body || {};
    const cleaned = cleanKey(key);
    if (!cleaned) {
      return res.status(400).json({
        error: "Missing 'key' in body",
        hint: "Send JSON like { \"key\":\"docs/my.pdf\", \"contentType\":\"application/pdf\" }"
      });
    }

    const out = await signPutUrl({ key: cleaned, contentType, expiresIn });
    res.json({ method: "PUT", ...out });
  } catch (err) {
    console.error("sign-put error:", err);
    res.status(500).json({ error: "Failed to create PUT URL", detail: err.message });
  }
});

// -----------------------------
// 2) Sign GET
// -----------------------------
router.post("/sign-get", async (req, res) => {
  try {
    const { key, file_key, expiresIn } = req.body || {};
    const cleaned = cleanKey(file_key || key);
    if (!cleaned) {
      return res.status(400).json({
        error: "Missing 'key' in body",
        hint: "Send JSON like { \"key\":\"docs/my.pdf\" }"
      });
    }

    const out = await signGetUrl({ key: cleaned, expiresIn });
    res.json(out); // { url, key, expiresInSec, method:"GET" }
  } catch (err) {
    console.error("sign-get error:", err);
    res.status(500).json({ error: "Failed to create GET URL", detail: err.message });
  }
});

// -----------------------------
// 3) Finalize (DB record)
// -----------------------------
router.post("/finalize", async (req, res) => {
  try {
    const pool = req.app.get("pool");
    if (!pool) return res.status(500).json({ error: "DB pool not available" });

    const {
      file_key,     // preferred
      key,          // allowed fallback
      content_type,
      size_bytes,
      label,
      user_id
    } = req.body || {};

    const cleaned = cleanKey(file_key || key);
    if (!cleaned) {
      return res.status(400).json({
        error: "Missing or invalid key",
        hint: "Provide { \"file_key\":\"docs/your-file.pdf\" } (not a full URL)"
      });
    }

    const size = toIntOrNull(size_bytes);

    const BUCKET = process.env.S3_BUCKET;
    if (!BUCKET) return res.status(500).json({ error: "S3_BUCKET env not set" });

    const sql = `
      INSERT INTO files (user_id, bucket, s3_key, content_type, size_bytes, label)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (s3_key) DO UPDATE
      SET content_type = COALESCE(EXCLUDED.content_type, files.content_type),
          size_bytes   = COALESCE(EXCLUDED.size_bytes, files.size_bytes),
          label        = COALESCE(EXCLUDED.label, files.label)
      RETURNING id, user_id, bucket, s3_key, content_type, size_bytes, label, created_at
    `;

    const vals = [ user_id || null, BUCKET, cleaned, content_type || null, size, label || null ];
    const r = await pool.query(sql, vals);
    const file = r.rows[0];

    return res.json({
      ok: true,
      file,
      publicUrl: publicUrl(cleaned)
    });
  } catch (err) {
    console.error("uploads.finalize error:", err);
    res.status(500).json({ error: "Failed to save file record", detail: err.message });
  }
});

// -----------------------------
// 4) Optional: list recent files for quick checks
// -----------------------------
router.get("/files", async (req, res) => {
  try {
    const pool = req.app.get("pool");
    const r = await pool.query(
      `SELECT id, user_id, bucket, s3_key, content_type, size_bytes, label, created_at
       FROM files
       ORDER BY created_at DESC
       LIMIT 25`
    );
    res.json({ files: r.rows });
  } catch (err) {
    console.error("uploads.files error:", err);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// -----------------------------
// 5) Optional: delete by key (S3 + DB)
// -----------------------------
router.delete("/", async (req, res) => {
  try {
    const pool = req.app.get("pool");
    const { key, file_key } = req.body || {};
    const cleaned = cleanKey(file_key || key);
    if (!cleaned) return res.status(400).json({ error: "Missing or invalid key" });

    // Delete in S3 (best effort)
    await deleteObjectSafe(cleaned);

    // Delete in DB
    await pool.query(`DELETE FROM files WHERE s3_key = $1`, [cleaned]);

    res.json({ ok: true, deleted_key: cleaned });
  } catch (err) {
    console.error("uploads.delete error:", err);
    res.status(500).json({ error: "Failed to delete", detail: err.message });
  }
});

// DELETE /api/uploads?key=docs/test.pdf
router.delete("/", async (req, res) => {
  try {
    const pool = req.app.get("pool");
    const { key } = req.query || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' query" });

    // delete from S3 first (safe)
    const { deleteKeySafe } = require("../utils/s3");
    const del = await deleteKeySafe(key);

    // delete DB record (non-fatal if not found)
    await pool.query(`DELETE FROM files WHERE s3_key=$1`, [key]);

    res.json({ ok: true, s3: del });
  } catch (err) {
    console.error("uploads.delete error:", err);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

module.exports = router;
