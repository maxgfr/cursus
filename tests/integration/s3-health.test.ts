import { expect, test } from 'bun:test'
import { AwsClient } from 'aws4fetch'

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000'
const aws = new AwsClient({
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'cursus',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'cursus-secret',
  service: 's3',
  region: 'us-east-1',
})

test('S3 emulator: bucket, PUT/GET and CORS', async () => {
  const bucket = `health-${crypto.randomUUID()}`
  const created = await aws.fetch(`${endpoint}/${bucket}`, { method: 'PUT' })
  expect(created.status).toBe(200)

  const body = new TextEncoder().encode('cursus')
  const put = await aws.fetch(`${endpoint}/${bucket}/fmt/v1`, { method: 'PUT', body })
  expect(put.status).toBe(200)

  const origin = 'http://localhost:4173'
  const got = await aws.fetch(`${endpoint}/${bucket}/fmt/v1`, { headers: { Origin: origin } })
  expect(got.status).toBe(200)
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(body)
  expect(got.headers.get('access-control-allow-origin')).toBe(origin)

  const preflight = await fetch(`${endpoint}/${bucket}/fmt/v1`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' },
  })
  expect(preflight.ok).toBe(true)
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
  expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT')
})
