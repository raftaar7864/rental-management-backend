// src/lib/r2.js
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const R2_REGION = process.env.R2_REGION || "auto";

if (!R2_ACCOUNT_ID || !R2_BUCKET || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.warn("R2 environment variables are not fully configured.");
}

const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: false,
});

export async function uploadPdfBufferToR2(buffer, key) {
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "application/pdf",
  });

  await s3Client.send(cmd);

  const publicUrl = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeURIComponent(key)}`;
  return { key, publicUrl };
}

export async function getSignedUrlForKey(key, expiresInSeconds = 60 * 60) {
  const getCmd = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  });
  const url = await getSignedUrl(s3Client, getCmd, { expiresIn: expiresInSeconds });
  return url;
}

export default s3Client;
