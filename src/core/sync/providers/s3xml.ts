/**
 * The few S3 XML responses Cursus reads (ListObjectsV2 and <Error>), parsed with regexes: no DOMParser in
 * src/core. S3 bodies are flat and machine-generated, so a tag regex plus entity decoding is enough.
 */

export interface ListedObject {
  key: string
  size: number
}

export interface ListPage {
  objects: ListedObject[]
  truncated: boolean
  nextToken?: string
}

export interface S3ErrorBody {
  code?: string
  message?: string
  /** Region the bucket really lives in (AuthorizationHeaderMalformed, PermanentRedirect). */
  region?: string
  /** Server time, sent with RequestTimeTooSkewed. */
  serverTime?: string
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decodes the five XML entities and numeric character references; unknown entities are left as they are. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    return NAMED[name] ?? whole
  })
}

/** Text of the first <tag> in xml, decoded; undefined when absent. */
export function tagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m?.[1] === undefined ? undefined : decodeEntities(m[1])
}

export function parseListPage(xml: string): ListPage {
  const objects: ListedObject[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1] ?? ''
    const key = tagText(body, 'Key')
    if (key === undefined) continue
    objects.push({ key, size: Number(tagText(body, 'Size') ?? 0) })
  }
  const nextToken = tagText(xml, 'NextContinuationToken')
  return { objects, truncated: tagText(xml, 'IsTruncated') === 'true', ...(nextToken ? { nextToken } : {}) }
}

/** Reads an S3 <Error> body; anything that is not one yields an empty object. */
export function parseError(xml: string): S3ErrorBody {
  const m = /<Error>([\s\S]*?)<\/Error>/.exec(xml)
  if (!m?.[1]) return {}
  const body = m[1]
  const out: S3ErrorBody = {}
  const code = tagText(body, 'Code')
  const message = tagText(body, 'Message')
  const region = tagText(body, 'Region')
  const serverTime = tagText(body, 'ServerTime')
  if (code) out.code = code
  if (message) out.message = message
  if (region) out.region = region
  if (serverTime) out.serverTime = serverTime
  return out
}
