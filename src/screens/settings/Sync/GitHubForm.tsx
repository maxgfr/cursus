import { useState } from 'react'
import type { GitHubCheck } from '../../../core/sync/providers/github'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { GITHUB_GUIDE, parseRepo } from './githubRepo.ts'
import { errorText } from './hooks.tsx'
import type { DestRecord } from './registry.ts'
import styles from './settings.module.css'

type GitHubRecord = Extract<DestRecord, { kind: 'github' }>

export interface GitHubFormProps {
  /** A new token for a destination already set up: its repository, branch and folder stay as they are. */
  initial?: GitHubRecord
  onSave: (r: Omit<GitHubRecord, 'id'>) => Promise<void>
}

/**
 * A repository of the student's GitHub account: its name, a fine-grained token limited to it, and optionally a
 * branch and a folder; the connection test says which part is wrong before anything is written.
 */
export function GitHubForm({ initial, onSave }: GitHubFormProps) {
  const t = useT()
  const [v, setV] = useState({
    repo: initial ? `${initial.owner}/${initial.repo}` : '',
    token: initial?.token ?? '',
    branch: initial?.branch ?? '',
    root: initial?.root ?? 'cursus',
  })
  const [result, setResult] = useState<GitHubCheck | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    setV((x) => ({ ...x, [k]: e.target.value }))
    setResult(null)
  }
  const repo = parseRepo(v.repo)
  const complete = repo !== null && v.token.trim() !== ''

  const record = (): Omit<GitHubRecord, 'id'> | null => {
    if (!repo) return null
    return {
      kind: 'github',
      label: initial?.label ?? `${repo.owner}/${repo.repo}`,
      owner: repo.owner,
      repo: repo.repo,
      branch: v.branch.trim(),
      root: v.root.trim().replace(/^\/+|\/+$/g, '') || 'cursus',
      token: v.token.trim(),
      ...(initial?.paused ? { paused: true } : {}),
      ...(initial?.sealed ? { sealed: true } : {}),
    }
  }

  const run = async (what: 'test' | 'save') => {
    const r = record()
    if (!r) return
    setBusy(what)
    setError(null)
    try {
      const { checkGitHub } = await import('../../../core/sync/providers/github')
      const d = await checkGitHub({ owner: r.owner, repo: r.repo, token: r.token })
      setResult(d)
      if (what === 'save' && d.ok) await onSave(r)
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(null)
    }
  }

  const problem = (d: Extract<GitHubCheck, { ok: false }>): string => {
    switch (d.problem) {
      case 'token':
        return t('sync.githubToken')
      case 'not-found':
        return t('sync.githubNotFound')
      case 'no-access':
        return t('sync.githubNoAccess')
      case 'read-only':
        return t('sync.githubReadOnly')
      case 'rate-limited':
        return t('sync.githubRateLimited')
      default:
        return t('sync.githubNetwork')
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault()
        void run('save')
      }}
    >
      <p className={styles.prose}>
        {t('sync.githubIntro')}{' '}
        <a href={GITHUB_GUIDE} target="_blank" rel="noopener noreferrer">
          {t('sync.githubGuide')}
        </a>
      </p>
      <Field
        label={t('sync.githubRepo')}
        hint={t('sync.githubRepoHint')}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={v.repo}
        onChange={set('repo')}
        disabled={initial !== undefined}
        required
      />
      <Field
        label={t('sync.githubTokenLabel')}
        hint={t('sync.githubTokenHint')}
        type="password"
        autoComplete="off"
        value={v.token}
        onChange={set('token')}
        required
      />
      <details className={styles.advanced}>
        <summary>{t('sync.advanced')}</summary>
        <div className={styles.grid}>
          <Field
            label={t('sync.githubBranch')}
            hint={t('sync.githubBranchHint')}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={v.branch}
            onChange={set('branch')}
            disabled={initial !== undefined}
          />
          <Field
            label={t('sync.githubFolder')}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={v.root}
            onChange={set('root')}
            disabled={initial !== undefined}
          />
        </div>
      </details>
      <p className={styles.note}>{t('sync.githubLimits')}</p>
      {result?.ok && (
        <p className={styles.ok} role="status">
          {result.private ? t('sync.testOk') : t('sync.githubPublic')}
        </p>
      )}
      {result && !result.ok && (
        <div className={styles.section}>
          <p className={styles.bad} role="alert">
            {problem(result)}
          </p>
          <p className={styles.note}>{result.detail}</p>
        </div>
      )}
      {error && (
        <p className={styles.bad} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button onClick={() => void run('test')} loading={busy === 'test'} disabled={!complete || busy !== null}>
          {t('sync.test')}
        </Button>
        <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!complete || busy !== null}>
          {initial ? t('common.save') : t('sync.add')}
        </Button>
      </div>
    </form>
  )
}
