import { expect, test } from 'bun:test'
import { parseRepo } from './githubRepo.ts'

test('a repository as typed or pasted: owner/name, its web address, its clone address', () => {
  for (const text of [
    'maxgfr/cursus-backup',
    '  maxgfr/cursus-backup  ',
    'https://github.com/maxgfr/cursus-backup',
    'https://github.com/maxgfr/cursus-backup/',
    'https://www.github.com/maxgfr/cursus-backup.git',
    'git@github.com:maxgfr/cursus-backup.git',
  ]) {
    expect(parseRepo(text)).toEqual({ owner: 'maxgfr', repo: 'cursus-backup' })
  }
  for (const text of ['', 'cursus-backup', 'maxgfr/', '/cursus', 'a/b/c', 'https://gitlab.com/a/b', 'own er/repo']) {
    expect(parseRepo(text)).toBeNull()
  }
})
