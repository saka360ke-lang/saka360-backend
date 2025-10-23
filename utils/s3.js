// utils/s3.js (AWS SDK v2)
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  S3_BUCKET,
} = process.env;

if (!AWS_REGION) throw new Error("AWS_REGION is missing");
if (!AWS_ACCESS_KEY_ID) throw new Error("AWS_ACCESS_KEY_ID is missing");
if (!AWS_SECRET_ACCESS_KEY) throw new Error("AWS_SECRET_ACCESS_KEY is missing");
if (!S3_BUCKET) throw new Error("S3_BUCKET is missing");

// Configure SDK v2
AWS.config.update({
  region: AWS_REGION,
  credentials: new AWS.Credentials({
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  }),
});

const s3 = new AWS.S3({ signatureVersion: "v4" });

// ---------- helpers ----------
function sanitizeFilename(name = "file") {
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

// ---------- API (same signatures you’re already using) ----------
async function signPutUrl({ key, contentType = "application/octet-stream", expiresIn = 900 }) {
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Expires: expiresIn, // seconds
    ContentType: contentType,
  };
  const url = await s3.getSignedUrlPromise("putObject", params);
  return { url, key, method: "PUT", contentType, expiresIn };
}

async function signGetUrl({ key, expiresIn = 900, responseContentDisposition }) {
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Expires: expiresIn,
    ...(responseContentDisposition ? { ResponseContentDisposition: responseContentDisposition } : {}),
  };
  const url = await s3.getSignedUrlPromise("getObject", params);
  return { url, key, method: "GET", expiresIn };
}

async function deleteObject(key) {
  await s3.deleteObject({ Bucket: S3_BUCKET, Key: key }).promise();
  return { ok: true, key };
}

async function isAlive() {
  await s3
    .headBucket({ Bucket: S3_BUCKET })
    .promise();
  return true;
}

module.exports = {
  s3,
  makeObjectKey,
  signPutUrl,
  signGetUrl,
  deleteObject,
  isAlive,
};
