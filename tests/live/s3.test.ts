import { test } from 'bun:test'
import { s3Remote } from '../../src/core/sync/providers/s3'
import { remoteContract } from '../contract/remote.contract'

// Real S3-compatible service (R2, AWS, B2…). The bucket must exist; each fixture uses a fresh random prefix.
const VARS = ['LIVE_S3_ENDPOINT', 'LIVE_S3_REGION', 'LIVE_S3_BUCKET', 'LIVE_S3_ACCESS_KEY', 'LIVE_S3_SECRET_KEY']
const missing = VARS.filter((v) => !process.env[v])
const env = (name: string): string => process.env[name] ?? ''

if (missing.length > 0) {
  test.skip(`live S3: skipped, set ${missing.join(', ')}`, () => {})
} else {
  remoteContract('s3 (live)', () => {
    let offline = false
    const store = s3Remote({
      endpoint: env('LIVE_S3_ENDPOINT'),
      region: env('LIVE_S3_REGION'),
      bucket: env('LIVE_S3_BUCKET'),
      prefix: `cursus-live/${crypto.randomUUID()}`,
      accessKeyId: env('LIVE_S3_ACCESS_KEY'),
      secretAccessKey: env('LIVE_S3_SECRET_KEY'),
      fetch: (input, init) => (offline ? Promise.reject(new TypeError('offline')) : fetch(input, init)),
    })
    return {
      store,
      goOffline: () => {
        offline = true
      },
    }
  })
}
