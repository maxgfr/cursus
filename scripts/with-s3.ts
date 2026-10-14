// Usage: bun scripts/with-s3.ts [cmd...]  — starts the S3 emulator, runs cmd, always tears down.
const compose = ['docker', 'compose', '-f', 'docker-compose.test.yml']
const cmd = process.argv.slice(2)
const command = cmd.length > 0 ? cmd : ['bun', 'test', 'tests/integration']

const up = Bun.spawnSync([...compose, 'up', '-d', '--wait'], { stdout: 'inherit', stderr: 'inherit' })
let code = up.exitCode ?? 1
try {
  if (code === 0) {
    const proc = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
    code = await proc.exited
  }
} finally {
  const down = Bun.spawnSync([...compose, 'down', '-v'], { stdout: 'inherit', stderr: 'inherit' })
  if (code === 0 && down.exitCode !== 0) code = down.exitCode ?? 1
}
process.exit(code)

export {}
