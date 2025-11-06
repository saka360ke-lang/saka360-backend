// routes/uploads.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { planGuard } = require("../middleware/planGuard");
const { signPutUrl, signGetUrl, publicUrl, safeDeleteObject } = require("../utils/s3");

function getPool(req) { return req.app.get("pool"); }

// 1) Get a signed PUT URL (client uploads directly to S3)
router.post("/sign", authenticateToken, async (req, res) => {
  try {
    const { filename, contentType } = req.body || {};
    if (!filename) return res.status(400).json({ error: "Missing filename" });

    // Key scheme: user/{id}/docs/{timestamp}-{filename}
    const key = `user/${req.user.id}/docs/${Date.now()}-${filename}`;
    const r = await signPutUrl({ key, contentType: contentType || "application/octet-stream" });
    res.json(r); // { url, key, contentType, publicUrl }
  } catch (e) {
    console.error("uploads.sign error:", e);
    res.status(500).json({ error: "Failed to sign" });
  }
});

// 2) Finalize (save record into DB) — enforce plan docsEnabled
router.post(
  "/finalize",
  authenticateToken,
  (req, _res, next) => { req.enforceDocs = true; next(); },
  planGuard(),
  async (req, res) => {
    try {
      const pool = getPool(req);
      const userId = req.user.id;
      const {
        key,
        document_type = "insurance",
        vehicle_id = null,
        original_filename = null,
        mime_type = null,
        size_bytes = null
      } = req.body || {};

      if (!key) return res.status(400).json({ error: "Missing key" });

      const r = await pool.query(
        `INSERT INTO public.documents
           (user_id, vehicle_id, document_type, storage_key, file_name, mime_type, size_bytes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         RETURNING id, user_id, vehicle_id, document_type, storage_key, file_name, mime_type, size_bytes, created_at`,
        [userId, vehicle_id, document_type, key, original_filename, mime_type, size_bytes]
      );

      res.json({ document: r.rows[0], publicUrl: publicUrl(key) });
    } catch (e) {
      console.error("uploads.finalize error:", e);
      res.status(500).json({ error: "Failed to save file record", detail: e.message });
    }
  }
);

// 3) Delete (safe)
router.delete("/", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const userId = req.user.id;
    const { document_id } = req.query;

    if (!document_id) return res.status(400).json({ error: "Missing document_id" });

    const docQ = await pool.query(
      `SELECT id, user_id, storage_key FROM public.documents WHERE id=$1 AND user_id=$2`,
      [document_id, userId]
    );
    const doc = docQ.rows[0];
    if (!doc) return res.status(404).json({ error: "Document not found" });

    await safeDeleteObject(doc.storage_key);
    await pool.query(`DELETE FROM public.documents WHERE id=$1`, [document_id]);

    res.json({ ok: true });
  } catch (e) {
    console.error("uploads.delete error:", e);
    res.status(500).json({ error: "Failed to delete", detail: e.message });
  }
});

module.exports = router;
