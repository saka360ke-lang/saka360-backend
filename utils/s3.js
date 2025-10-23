// utils/s3.js
const { S3Client, HeadBucketCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  S3_BUCKET
} = process.env;

if (!AWS_REGION) throw new Error("AWS_REGION is missing");
if (!AWS_ACCESS_KEY_ID) throw new Error("AWS_ACCESS_KEY_ID is missing");
if (!AWS_SECRET_ACCESS_KEY) throw new Error("AWS_SECRET_ACCESS_KEY is missing");
if (!S3_BUCKET) throw new Error("S3_BUCKET is missing");

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY
  }
});

// --- helpers ---
function sanitizeFilename(name = "file") {
  // remove path parts and keep safe chars
  const base = path.basename(name).replace(/[^\w.\-+]+/g, "_");
  return base.length ? base : "file";
}

function two(n) {
  return String(n).padStart(2, "0");
}

function makeObjectKey(userId, originalName) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = two(now.getMonth() + 1);
  const id = uuidv4();
  const safe = sanitizeFilename(originalName);
  return `uploads/${userId || "anon"}/${yyyy}/${mm}/${id}-${safe}`;
}

// --- API ---
async function signPutUrl({ key, contentType = "application/octet-stream", expiresIn = 900 }) {
  const cmd = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn });
  return { url, key, method: "PUT", contentType, expiresIn };
}

async function signGetUrl({ key, expiresIn = 900, responseContentDisposition }) {
  const cmd = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ...(responseContentDisposition ? { ResponseContentDisposition: responseContentDisposition } : {})
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn });
  return { url, key, method: "GET", expiresIn };
}

async function deleteObject(key) {
  const cmd = new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key });
  await s3.send(cmd);
  return { ok: true, key };
}

async function isAlive() {
  await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  return true;
}

module.exports = {
  s3,
  makeObjectKey,
  signPutUrl,
  signGetUrl,
  deleteObject,
  isAlive
};
