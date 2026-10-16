import { expect, type Page } from '@playwright/test'
import { AwsClient } from 'aws4fetch'

// The S3 emulator the e2e run starts (`bun scripts/with-s3.ts`): a fresh bucket per test, set up as a destination
// the way a student does it.

export const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'cursus',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'cursus-secret',
  region: 'us-east-1',
}

const admin = () => new AwsClient({ ...S3, service: 's3' })

export async function newBucket(prefix: string): Promise<string> {
  const bucket = `${prefix}-${crypto.randomUUID()}`
  const res = await admin().fetch(`${S3.endpoint}/${bucket}`, { method: 'PUT' })
  expect(res.status).toBe(200)
  return bucket
}

/** The keys stored in a bucket, read as an administrator. */
export async function bucketKeys(bucket: string): Promise<string[]> {
  const res = await admin().fetch(`${S3.endpoint}/${bucket}?list-type=2`)
  expect(res.status).toBe(200)
  return [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1] ?? '')
}

/** Adds the bucket as an S3 destination from Settings › Sync, its connection tested first. */
export async function addS3(page: Page, bucket: string): Promise<void> {
  await page.goto('./#/settings/sync')
  await expect(page.getByRole('heading', { level: 1, name: 'Sync & backup' })).toBeVisible()
  await page.locator('summary', { hasText: 'Advanced' }).click()
  await page.getByRole('button', { name: 'S3-compatible storage' }).click()
  const dialog = page.getByRole('dialog', { name: 'S3-compatible storage' })
  await dialog.getByLabel('Endpoint URL').fill(S3.endpoint)
  await dialog.getByLabel('Bucket').fill(bucket)
  await dialog.getByLabel('Region').fill(S3.region)
  await dialog.getByLabel('Folder prefix').fill('cursus')
  await dialog.getByLabel('Access key ID').fill(S3.accessKeyId)
  await dialog.getByLabel('Secret access key').fill(S3.secretAccessKey)
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByText('Connection works.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
}
