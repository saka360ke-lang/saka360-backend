// utils/s3.js  (AWS SDK v2)
const AWS = require("aws-sdk");
const path = require("path");

// Read env
const {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN, // optional
  AWS_REGION,
  S3_BUCKET
} = process.env;

// Minimal validation (no secrets logged)
function assertEnv() {
  const errs = [];
  if (!AWS_ACCESS_KEY_ID) errs.push("AWS_ACCESS_KEY_ID missing");
  if (!AWS_SECRET_ACCESS_KEY) errs.push("AWS_SECRET_ACCESS_KEY missing");
  if (!AWS_REGION) errs.push("AWS_REGION missing");
  if (!S3_BUCKET) errs.push("S3_BUCKET missing");
  if (errs.length) {
    throw new Error("[s3] Missing env: " + errs.join(", "));
  }
}
assertEnv();

// Configure AWS SDK v2
const base = {
  region: AWS_REGION,
  signatureVersion: "v4",
};
if (AWS_SESSION_TOKEN) {
  AWS.config.update({
    ...base,
    credentials: new AWS.Credentials(
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN
    ),
  });
} else {
  AWS.config.update({
    ...base,
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  });
}

const s3 = new AWS.S3({ apiVersion: "2006-03-01" });

// Helper: clean key (optional)
function safeKey(p) {
  return p.replace(/^\//, "");
}

// Create a presigned PUT URL (upload)
async function getPresignedPutUrl({ key, contentType = "application/octet-stream", expiresInSec = 300 }) {
  if (!key) throw new Error("key is required");
  const params = {
    Bucket: S3_BUCKET,
    Key: safeKey(key),
    Expires: expiresInSec,
    ContentType: contentType,
    // optional: ACL: "private",
  };
  return s3.getSignedUrlPromise("putObject", params);
}

// Create a presigned GET URL (download)
async function getPresignedGetUrl({ key, expiresInSec = 300 }) {
  if (!key) throw new Error("key is required");
  const params = {
    Bucket: S3_BUCKET,
    Key: safeKey(key),
    Expires: expiresInSec,
  };
  return s3.getSignedUrlPromise("getObject", params);
}

module.exports = {
  s3,
  getPresignedPutUrl,
  getPresignedGetUrl,
};
