# Sync with S3-compatible storage

Cursus can sync to any S3-compatible bucket with an access key: Cloudflare R2, AWS S3, Backblaze B2, MinIO.
The app talks to the bucket directly from your browser, so the bucket needs a CORS rule for the app's origin.

**Recommended: Cloudflare R2.** 10 GB free, no egress fees, and keys can be limited to one bucket.

## Cloudflare R2 (recommended)

1. In the Cloudflare dashboard, open **R2** and create a bucket (for example `cursus`).
2. Open the bucket, **Settings → CORS policy → Edit**, and paste the JSON that Cursus shows in
   **Settings → Sync → S3 → CORS** (it is generated for the app's exact origin).
3. Go to **R2 → Manage API tokens → Create API token**:
   - permission **Object Read & Write**;
   - **Apply to specific buckets only**, and pick only your Cursus bucket.
4. In Cursus, enter:
   - **Endpoint**: `https://<account-id>.r2.cloudflarestorage.com`
   - **Region**: `auto`
   - **Bucket**: the bucket name
   - **Access key ID** and **Secret access key** from the token.
5. Press **Test connection**.

## AWS S3

1. Create a bucket and note its region (for example `eu-west-3`).
2. **Permissions → CORS**: paste the JSON shown by Cursus.
3. Create an IAM user with a policy restricted to the bucket:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::BUCKET" },
       { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::BUCKET/*" }
     ]
   }
   ```

4. Endpoint `https://s3.<region>.amazonaws.com`, region as above.

## Backblaze B2 and MinIO

Use the XML CORS rule shown by Cursus:

- **MinIO**: `mc cors set <alias>/<bucket> cors.xml`.
- **B2**: send it with the S3 API (`PutBucketCors`). Create an application key restricted to the bucket.
  Endpoint `https://s3.<region>.backblazeb2.com`.

## What Cursus needs

- `ListBucket`, `GetObject`, `PutObject` on the bucket. Cursus never deletes remote objects
  (except the readable `mirror/` export).
- CORS allowing `GET`, `PUT`, `HEAD` from the app's origin, any request header, and exposing `ETag` and `Date`.
  `Date` lets Cursus fix a wrong device clock by itself.
- An optional **prefix** keeps Cursus in a sub-folder of a shared bucket. Changing the endpoint, bucket or
  prefix creates a new destination.

## Test connection: what the results mean

| Result | Cause | Fix |
|---|---|---|
| CORS | The server answers, but the browser blocks the response. | Paste the CORS rule for the exact app origin. |
| Network | The endpoint cannot be reached. | Check the endpoint URL and your connection. |
| Keys | Unknown access key ID, or wrong secret. | Copy both values again from the token. |
| Region | The bucket lives in another region. | Use the region shown; `auto` for R2. |
| Bucket | No bucket with that name at this endpoint. | Check the name (case matters). |
| Permission | The key cannot list or write this bucket. | Give the key read and write access to the bucket. |
| Clock | The device clock is far off and the server time could not be read. | Set the device clock to automatic, or expose `Date` in CORS. |
