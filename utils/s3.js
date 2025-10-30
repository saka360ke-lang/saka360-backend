const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const REGION = process.env.S3_REGION;
const BUCKET = process.env.S3_BUCKET;

const credentials = {
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  sessionToken: process.env.S3_SESSION_TOKEN || undefined,
};

const s3 = new S3Client({ region: REGION, credentials });

function publicUrl(key) {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${encodeURIComponent(key)}`;
}

async function signPutUrl({ key, contentType, expiresIn = 900 }) {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType || "application/octet-stream" });
  const url = await getSignedUrl(s3, cmd, { expiresIn });
  return { url, key, contentType: contentType || "application/octet-stream", publicUrl: publicUrl(key) };
}

async function signGetUrl({ key, expiresIn = 300 }) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn });
  return { url, key, expiresInSec: expiresIn, method: "GET" };
}

async function deleteKeySafe(key) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return { ok: true };
  } catch (err) {
    console.error("S3 delete error:", err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { signPutUrl, signGetUrl, publicUrl, deleteKeySafe };
