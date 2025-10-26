// utils/s3.js
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Required envs (Render → Environment)
const REGION = process.env.S3_REGION;            // e.g. "eu-central-1"
const BUCKET = process.env.S3_BUCKET;            // e.g. "saka360-reports"

// Permanent creds (or STS). If using temporary creds, also set S3_SESSION_TOKEN
const credentials = {
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  sessionToken: process.env.S3_SESSION_TOKEN || undefined,
};

const s3 = new S3Client({
  region: REGION,
  credentials,
});

function publicUrl(key) {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${encodeURIComponent(key)}`;
}

/**
 * Create a presigned PUT url for direct upload to S3
 */
async function signPutUrl({ key, contentType, expiresIn = 900 }) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || "application/octet-stream",
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn });
  return { url, key, contentType: contentType || "application/octet-stream", publicUrl: publicUrl(key) };
}

/**
 * Create a presigned GET url to fetch a private object
 */
async function signGetUrl({ key, expiresIn = 300 }) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn });
  return { url, key, expiresInSec: expiresIn, method: "GET" };
}

module.exports = { signPutUrl, signGetUrl, publicUrl };
