// Runs every scripts/anki/check-*.py against the official Anki engine.
const glob = new Bun.Glob('scripts/anki/check-*.py')
const checks = (await Array.fromAsync(glob.scan('.'))).sort()
if (checks.length === 0) {
  console.error('No Anki checks found')
  process.exit(1)
}
let failed = 0
for (const check of checks) {
  console.log(`> ${check}`)
  const proc = Bun.spawn(['uv', 'run', '--quiet', '--no-project', '--with', 'anki==26.9.3', 'python', check], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await proc.exited) !== 0) failed++
}
if (failed > 0) {
  console.error(`${failed}/${checks.length} Anki checks failed`)
  process.exit(1)
}

export {}
