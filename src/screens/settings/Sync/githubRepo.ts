/** Where the setup guide lives (the token's permissions, step by step). */
export const GITHUB_GUIDE = 'https://github.com/maxgfr/cursus/blob/main/docs/setup-github.md'

/** `owner/repo` or a repository's address, as pasted: its owner and name; null when it is neither. */
export function parseRepo(text: string): { owner: string; repo: string } | null {
  const s = text
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s)
  return m ? { owner: m[1] ?? '', repo: m[2] ?? '' } : null
}
