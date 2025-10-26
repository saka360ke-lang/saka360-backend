// routes/uploads.js
const express = require("express");
const router = express.Router();
const { signPutUrl, signGetUrl, publicUrl } = require("../utils/s3");

// POST /api/uploads/sign-put  { key, contentType?, contentDisposition?, expiresIn? }
router.post("/sign-put", async (req, res) => {
  try {
    const { key, contentType, contentDisposition, expiresIn } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    const out = await signPutUrl({ key, contentType, contentDisposition, expiresIn });
    res.json({ method: "PUT", ...out });
  } catch (err) {
    console.error("sign-put error:", err);
    res.status(500).json({ error: "Failed to create PUT URL", detail: err.message });
  }
});

// POST /api/uploads/sign-get  { key, expiresIn?, download?:true, filename?: "report.pdf" }
router.post("/sign-get", async (req, res) => {
  try {
    const { key, expiresIn, download, filename } = req.body || {};
    if (!key) return res.status(400).json({ error: "Missing 'key' in body" });

    let contentDisposition;
    if (download) {
      // If filename provided, hint it; else let S3/browser infer
      contentDisposition = filename
        ? `attachment; filename="${filename}"`
        : "attachment";
    }

    const out = await signGetUrl({ key, expiresIn, contentDisposition });
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
