/**
 * Fake CloudKit Web Services: the subset Cursus uses (users/current, records/query with BEGINS_WITH and
 * continuationMarker, records/lookup, records/modify forceReplace, assets/upload and the asset upload and
 * download URLs). Serve it with `Bun.serve({ port: 0, fetch: fake.handle })`, or call `handle` directly.
 */
interface Rec {
  recordName: string
  recordType: string
  fields: Record<string, { value: unknown; type?: string }>
  created: number
}

export interface FakeFault {
  status: number
  serverErrorCode?: string
  retryAfter?: number
  /** Fail a single record inside a 200 response instead of the whole request. */
  perRecord?: boolean
}

export class FakeCloudKit {
  readonly records = new Map<string, Rec>()
  readonly blobs = new Map<string, Uint8Array<ArrayBuffer>>()
  readonly validTokens = new Set<string>(['user-token'])
  readonly requests: string[] = []
  apiToken = 'api-token'
  origin = 'http://fake.cloudkit'
  /** Fails the next database calls, in order. */
  faults: FakeFault[] = []
  /** Server-side cap on resultsLimit, like CloudKit's own. */
  maxResults = 200
  private clock = 1_000
  private nextId = 1

  now = (): number => this.clock
  advance = (ms: number): void => {
    this.clock += ms
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    this.requests.push(`${req.method} ${url.pathname}`)
    const up = url.pathname.match(/^\/upload\/(\w+)$/)
    if (up) {
      const id = up[1] as string
      const bytes = new Uint8Array(await req.arrayBuffer())
      this.blobs.set(id, bytes)
      return json(200, { singleFile: { receipt: id, size: bytes.length, fileChecksum: 'x' } })
    }
    const down = url.pathname.match(/^\/download\/(\w+)\/data$/)
    if (down) {
      const b = this.blobs.get(down[1] as string)
      return b ? new Response(b) : new Response('missing', { status: 404 })
    }
    const m = url.pathname.match(/^\/database\/1\/([^/]+)\/(development|production)\/(private|public)\/(.+)$/)
    if (!m) return json(404, { serverErrorCode: 'NOT_FOUND', reason: 'no such endpoint' })
    if (url.searchParams.get('ckAPIToken') !== this.apiToken)
      return json(401, { serverErrorCode: 'AUTHENTICATION_FAILED', reason: 'bad API token' })
    const signedIn = this.validTokens.has(url.searchParams.get('ckWebAuthToken') ?? '')
    const op = m[4]
    if (op === 'users/current') {
      if (!signedIn)
        return json(421, {
          serverErrorCode: 'AUTHENTICATION_REQUIRED',
          redirectURL: 'https://idmsa.apple.com/signin?x=1',
        })
      return json(200, { userRecordName: '_user' })
    }
    if (!signedIn)
      return json(421, { serverErrorCode: 'AUTHENTICATION_REQUIRED', redirectURL: 'https://idmsa.apple.com' })
    const fault = this.faults.shift()
    if (fault && !fault.perRecord)
      return json(fault.status, { serverErrorCode: fault.serverErrorCode, retryAfter: fault.retryAfter })
    const recordFault = fault && { serverErrorCode: fault.serverErrorCode, reason: 'injected' }
    const body = (await req.json()) as Record<string, unknown>
    switch (op) {
      case 'records/query':
        return json(200, this.query(body, recordFault))
      case 'records/lookup': {
        const names = (body.records as { recordName: string }[]).map((r) => r.recordName)
        return json(200, {
          records: names.map((n) => {
            if (recordFault) return { recordName: n, ...recordFault }
            const r = this.records.get(n)
            return r ? this.render(r) : { recordName: n, serverErrorCode: 'NOT_FOUND' }
          }),
        })
      }
      case 'records/modify': {
        const ops = body.operations as { operationType: string; record: Rec }[]
        return json(200, {
          records: ops.map(({ operationType, record }) => {
            if (recordFault) return { recordName: record.recordName, ...recordFault }
            if (operationType !== 'forceReplace')
              return { recordName: record.recordName, serverErrorCode: 'BAD_REQUEST' }
            const fields = { ...record.fields }
            const asset = fields.asset?.value as { receipt?: string } | undefined
            if (asset && !this.blobs.has(asset.receipt ?? ''))
              return { recordName: record.recordName, serverErrorCode: 'BAD_REQUEST', reason: 'unknown receipt' }
            const prev = this.records.get(record.recordName)
            const r = { ...record, fields, created: prev?.created ?? this.clock }
            this.records.set(record.recordName, r)
            return this.render(r)
          }),
        })
      }
      case 'assets/upload': {
        const tokens = body.tokens as { recordName: string; fieldName: string }[]
        return json(200, {
          tokens: tokens.map((t) => ({ ...t, url: `${this.origin}/upload/u${this.nextId++}` })),
        })
      }
      default:
        return json(400, { serverErrorCode: 'BAD_REQUEST', reason: op })
    }
  }

  /** `fetch` bound to this fake without a socket. */
  fetch = (url: string, init?: RequestInit): Promise<Response> => this.handle(new Request(url, init))

  private render(r: Rec) {
    const fields = { ...r.fields }
    const asset = fields.asset?.value as { receipt: string } | undefined
    if (asset)
      fields.asset = { value: { downloadURL: `${this.origin}/download/${asset.receipt}/\${f}` }, type: 'ASSETID' }
    return { recordName: r.recordName, recordType: r.recordType, fields, created: { timestamp: r.created } }
  }

  private query(body: Record<string, unknown>, recordFault?: { serverErrorCode?: string; reason: string }) {
    const q = body.query as { filterBy: { fieldName: string; comparator: string; fieldValue: { value: string } }[] }
    const f = q.filterBy[0]
    if (f?.comparator !== 'BEGINS_WITH' || f.fieldName !== 'key') throw new Error('fake supports BEGINS_WITH on key')
    const prefix = f.fieldValue.value
    const all = [...this.records.values()]
      .filter((r) => String(r.fields.key?.value).startsWith(prefix))
      .sort((a, b) => (String(a.fields.key?.value) < String(b.fields.key?.value) ? -1 : 1))
    const start = body.continuationMarker ? Number(body.continuationMarker) : 0
    const limit = Math.min(Number(body.resultsLimit ?? this.maxResults), this.maxResults)
    const page = all.slice(start, start + limit).map((r) => {
      if (recordFault) return { recordName: r.recordName, ...recordFault }
      const rendered = this.render(r)
      const keys = body.desiredKeys as string[] | undefined
      if (keys) rendered.fields = Object.fromEntries(Object.entries(rendered.fields).filter(([k]) => keys.includes(k)))
      return rendered
    })
    return start + limit < all.length ? { records: page, continuationMarker: String(start + limit) } : { records: page }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
