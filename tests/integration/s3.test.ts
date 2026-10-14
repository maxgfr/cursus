import { expect, test } from 'bun:test'
import { AwsClient } from 'aws4fetch'
import { s3Remote } from '../../src/core/sync/providers/s3'
import { remoteContract } from '../contract/remote.contract'

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000'
const accessKeyId = process.env.S3_ACCESS_KEY ?? 'cursus'
const secretAccessKey = process.env.S3_SECRET_KEY ?? 'cursus-secret'
const admin = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'us-east-1' })

async function newBucket(): Promise<string> {
  const bucket = `contract-${crypto.randomUUID()}`
  const res = await admin.fetch(`${endpoint}/${bucket}`, { method: 'PUT' })
  if (res.status !== 200) throw new Error(`bucket creation failed: HTTP ${res.status}`)
  return bucket
}

remoteContract('s3 (emulator)', async () => {
  let offline = false
  const store = s3Remote({
    endpoint,
    region: 'us-east-1',
    bucket: await newBucket(),
    prefix: 'cursus',
    accessKeyId,
    secretAccessKey,
    fetch: (input, init) => (offline ? Promise.reject(new TypeError('offline')) : fetch(input, init)),
  })
  return {
    store,
    goOffline: () => {
      offline = true
    },
  }
})

remoteContract('s3 (emulator, page size 2)', async () => ({
  store: s3Remote({
    endpoint,
    region: 'us-east-1',
    bucket: await newBucket(),
    accessKeyId,
    secretAccessKey,
    pageSize: 2,
  }),
}))

test('a local clock an hour off is corrected from the server Date', async () => {
  const store = s3Remote({
    endpoint,
    region: 'us-east-1',
    bucket: await newBucket(),
    accessKeyId,
    secretAccessKey,
    now: () => Date.now() - 3_600_000,
  })
  await store.put('fmt/v1', new TextEncoder().encode('x'))
  expect(await store.get({ key: 'fmt/v1' })).toEqual(new TextEncoder().encode('x'))
})

test('diagnose: ok, wrong keys, missing bucket', async () => {
  const bucket = await newBucket()
  const base = { endpoint, region: 'us-east-1', bucket, accessKeyId, secretAccessKey }
  expect(await s3Remote(base).diagnose()).toEqual({ ok: true })
  expect(await s3Remote({ ...base, secretAccessKey: 'wrong-secret' }).diagnose()).toMatchObject({ problem: 'keys' })
  expect(await s3Remote({ ...base, accessKeyId: 'nobody' }).diagnose()).toMatchObject({ problem: 'keys' })
  expect(await s3Remote({ ...base, bucket: `${bucket}-missing` }).diagnose()).toMatchObject({ problem: 'bucket' })
})
