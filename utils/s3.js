// utils/s3.js
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN,
  S3_BUCKET,
} = process.env;

function getS3() {
  if (!AWS_REGION) throw new Error("Missing AWS_REGION");
  if (!S3_BUCKET) throw new Error("Missing S3_BUCKET");

  // If you’re using long-lived keys, both must be present.
  // If you’re using instance roles or Render’s IAM, the SDK will resolve creds automatically.
  const credentials =
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
          sessionToken: AWS_SESSION_TOKEN || undefined,
        }
      : undefined;

  return new S3Client({ region: AWS_REGION, credentials });
}

/** Debug helper used by /api/uploads/debug/aws */
function debugAws() {
  return {
    region: AWS_REGION || null,
    bucket: S3_BUCKET || null,
    accessKeyIdPresent: Boolean(AWS_ACCESS_KEY_ID),
    secretPresent: Boolean(AWS_SECRET_ACCESS_KEY),
    sessionTokenPresent: Boolean(AWS_SESSION_TOKEN),
  };
}

/** Create a presigned GET URL to download an object */
async function getPresignedGetUrl({ key, expiresInSec = 300 }) {
  if (!key) throw new Error("key is required");
  const s3 = getS3();
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSec });
}

/** Create a presigned PUT URL to upload an object */
async function getPresignedPutUrl({ key, contentType = "application/octet-stream", expiresInSec = 300 }) {
  if (!key) throw new Error("key is required");
  const s3 = getS3();
  const cmd = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
    // You can add ACL/metadata here if you need
  });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSec });
}

module.exports = {
  debugAws,
  getPresignedGetUrl,
  getPresignedPutUrl,
};
