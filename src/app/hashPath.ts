/** A hash route split into its path (`/a/b`) and its query (without `?`). Leading `#` and `/` are optional. */
export function splitHash(hash: string): { path: string; search: string } {
  const raw = hash.replace(/^#?\/?/, '')
  const at = raw.indexOf('?')
  return at < 0 ? { path: `/${raw}`, search: '' } : { path: `/${raw.slice(0, at)}`, search: raw.slice(at + 1) }
}
