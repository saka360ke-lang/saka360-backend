// routes/uploads.js
const express = require("express");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

const {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  S3_BUCKET,
} = process.env;

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY
  }
});

// POST /api/uploads/presign
// Body: { "key": "docs/<userId>/filename.pdf", "contentType": "application/pdf" }
router.post("/presign", authenticateToken, async (req, res) => {
  try {
    const { key, contentType } = req.body || {};
    if (!key || !contentType) {
      return res.status(400).json({ error: "key and contentType are required" });
    }
    // Optional: enforce per-user key prefix
    const safeKey = key;

    const cmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: safeKey,
      ContentType: contentType
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 }); // 60s
    return res.json({
      uploadUrl: url,
      publicUrl: `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(safeKey)}`
    });
  } catch (err) {
    console.error("uploads.presign error:", err);
    res.status(500).json({ error: "Failed to create presigned URL", detail: err.message });
  }
});

module.exports = router;
