// Fails if the initial JS (scripts and modulepreloads referenced by dist/index.html) exceeds the gzip budget.
import { gzipSync } from 'node:zlib'

const BUDGET = 200 * 1024
const html = await Bun.file('dist/index.html').text()
const refs = new Set<string>()
for (const m of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+\.js)"/g)) {
  if (m[1]) refs.add(m[1])
}
if (refs.size === 0) {
  console.error('No initial JS found in dist/index.html')
  process.exit(1)
}
let total = 0
for (const ref of refs) {
  const rel = ref.replace(/^https?:\/\/[^/]+/, '').replace(/^.*?\/assets\//, 'assets/')
  const size = gzipSync(await Bun.file(`dist/${rel}`).bytes()).length
  console.log(`${rel}: ${(size / 1024).toFixed(1)} KB gzip`)
  total += size
}
console.log(`initial JS: ${(total / 1024).toFixed(1)} KB gzip (budget ${BUDGET / 1024} KB)`)
if (total > BUDGET) process.exit(1)
