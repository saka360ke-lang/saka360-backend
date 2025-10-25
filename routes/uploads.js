// routes/uploads.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { makeObjectKey, signPutUrl, signGetUrl, deleteObject, isAlive } = require("../utils/s3");

// Health check for S3 (admin-only optional). For now, just require auth.
router.get("/health", authenticateToken, async (req, res) => {
  try {
    await isAlive();
    res.json({ ok: true, bucket: process.env.S3_BUCKET, region: process.env.AWS_REGION });
  } catch (err) {
    res.status(500).json({ ok: false, error: "S3 not reachable", detail: err.message });
  }
});

// TEMP
// routes/uploads.js (add at top with other routes)
router.get("/debug/aws", (req, res) => {
  const hasAKID = !!process.env.AWS_ACCESS_KEY_ID;
  const hasSK   = !!process.env.AWS_SECRET_ACCESS_KEY;
  const hasTok  = !!process.env.AWS_SESSION_TOKEN;
  res.json({
    region: process.env.AWS_REGION || null,
    bucket: process.env.S3_BUCKET || null,
    accessKeyIdPresent: hasAKID,
    secretPresent: hasSK,
    sessionTokenPresent: hasTok
  });
});


/**
 * POST /api/uploads/sign-put
 * Body: { filename: "report.pdf", contentType: "application/pdf" }
 * Returns: { url, key, method:"PUT", contentType, expiresIn }
 */
router.post("/sign-put", authenticateToken, async (req, res) => {
  try {
    const { filename, contentType } = req.body || {};
    const key = makeObjectKey(req.user?.id, filename || "file.bin");
    const signed = await signPutUrl({ key, contentType: contentType || "application/octet-stream" });
    res.json(signed);
  } catch (err) {
    console.error("sign-put error:", err);
    res.status(500).json({ error: "Failed to create PUT URL", detail: err.message });
  }
});

/**
 * POST /api/uploads/sign-get
 * Body: { key: "uploads/<...>" , downloadName?: "NiceName.pdf" }
 * Returns: { url, key, method:"GET", expiresIn }
 */
router.post("/sign-get", authenticateToken, async (req, res) => {
  try {
    const { key, downloadName } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key'" });

    const responseContentDisposition = downloadName
      ? `attachment; filename="${downloadName.replace(/["\r\n]/g, "")}"`
      : undefined;

    const signed = await signGetUrl({ key, expiresIn: 900, responseContentDisposition });
    res.json(signed);
  } catch (err) {
    console.error("sign-get error:", err);
    res.status(500).json({ error: "Failed to create GET URL", detail: err.message });
  }
});

/**
 * DELETE /api/uploads/file
 * Body: { key: "uploads/<...>" }
 * NOTE: No ownership check (add DB mapping if you need strict ownership).
 */
router.delete("/file", authenticateToken, async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key'" });
    const out = await deleteObject(key);
    res.json(out);
  } catch (err) {
    console.error("delete file error:", err);
    res.status(500).json({ error: "Failed to delete file", detail: err.message });
  }
});

module.exports = router;
