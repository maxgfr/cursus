export const COVERAGE_DIRS = ['src/core/log', 'src/core/sync', 'src/core/crypto', 'src/core/srs'] as const
export const THRESHOLD = 0.9

export type DirResult =
  | { dir: string; status: 'absent' }
  | { dir: string; status: 'ok' | 'fail'; hit: number; found: number; ratio: number }

export function checkCoverage(
  lcov: string,
  dirs: readonly string[] = COVERAGE_DIRS,
  threshold: number = THRESHOLD,
): { ok: boolean; results: DirResult[] } {
  const totals = new Map<string, { hit: number; found: number; files: number }>()
  let file: string | null = null
  let lf = 0
  let lh = 0
  const flush = (): void => {
    if (file === null) return
    const norm = file.replace(/\\/g, '/')
    for (const dir of dirs) {
      if (norm === dir || norm.startsWith(`${dir}/`) || norm.includes(`/${dir}/`)) {
        const t = totals.get(dir) ?? { hit: 0, found: 0, files: 0 }
        t.hit += lh
        t.found += lf
        t.files += 1
        totals.set(dir, t)
      }
    }
  }
  for (const raw of lcov.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      file = line.slice(3)
      lf = 0
      lh = 0
    } else if (line.startsWith('LF:')) lf = Number(line.slice(3))
    else if (line.startsWith('LH:')) lh = Number(line.slice(3))
    else if (line === 'end_of_record') {
      flush()
      file = null
    }
  }
  flush()
  const results: DirResult[] = dirs.map((dir) => {
    const t = totals.get(dir)
    if (!t) return { dir, status: 'absent' }
    const ratio = t.found === 0 ? 1 : t.hit / t.found
    return { dir, status: ratio >= threshold ? 'ok' : 'fail', hit: t.hit, found: t.found, ratio }
  })
  return { ok: results.every((r) => r.status !== 'fail'), results }
}

if (import.meta.main) {
  const proc = Bun.spawnSync(
    [
      'bun',
      'test',
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-dir=coverage',
      'src',
      'tests/smoke.test.ts',
      'tests/coverage-check.test.ts',
      'tests/sim',
      'tests/contract',
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1)
  const { ok, results } = checkCoverage(await Bun.file('coverage/lcov.info').text())
  for (const r of results) {
    if (r.status === 'absent') console.log(`${r.dir}: not yet present`)
    else
      console.log(
        `${r.dir}: ${(r.ratio * 100).toFixed(2)}% lines (${r.hit}/${r.found}) ${r.status === 'ok' ? 'OK' : `FAIL (< ${THRESHOLD * 100}%)`}`,
      )
  }
  if (!ok) {
    console.error('Line coverage below 90% in src/core directories listed above.')
    process.exit(1)
  }
}
