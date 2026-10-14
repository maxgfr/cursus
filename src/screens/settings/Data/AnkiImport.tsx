import { type ChangeEvent, useState } from 'react'
import { useRuntime } from '../../../app/workspaceContext.tsx'
import type { ImportResult } from '../../../core/anki/apkgRead'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import styles from '../Sync/settings.module.css'

interface Preview {
  name: string
  bytes: Uint8Array
  format: string
  notes: number
  cards: number
  reviews: number
  media: number
  decks: string[]
}

/** Reads the package first and shows what it holds; nothing is written until the user confirms. */
export function AnkiImport() {
  const t = useT()
  const rt = useRuntime()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [keepHistory, setKeepHistory] = useState(true)
  const [busy, setBusy] = useState<'read' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setBusy('read')
    setError(null)
    setResult(null)
    setPreview(null)
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const { readApkg, courseTitle } = await import('../../../core/anki/apkgRead')
      const { format, collection, media } = await readApkg(bytes)
      const used = new Set(collection.cards.map((c) => c.did))
      const decks = [...collection.decks.entries()]
        .filter(([id]) => used.has(id))
        .map(([, path]) => courseTitle(path))
        .sort()
      setPreview({
        name: f.name,
        bytes,
        format,
        notes: collection.notes.size,
        cards: collection.cards.length,
        reviews: collection.revlog.length,
        media: media.size,
        decks,
      })
    } catch (err) {
      setError(t('anki.unreadable', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(null)
    }
  }

  const confirm = async () => {
    if (!preview) return
    setBusy('import')
    setError(null)
    try {
      const [{ importApkg }, { blobStore }] = await Promise.all([
        import('../../../core/anki/apkgRead'),
        import('../../../core/log/blobs'),
      ])
      setResult(await importApkg(preview.bytes, rt.ws, blobStore(rt.store), { keepHistory }))
      setPreview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={styles.card} aria-labelledby="anki-import">
      <h2 id="anki-import" className={styles.sectionTitle}>
        {t('anki.importTitle')}
      </h2>
      <label className={styles.section}>
        <span className={styles.label}>{t('anki.chooseFile')}</span>
        <input className={styles.file} type="file" accept=".apkg,.colpkg" onChange={pick} disabled={busy !== null} />
      </label>
      {busy === 'read' && (
        <p className={styles.note} role="status">
          {t('anki.reading')}
        </p>
      )}
      {preview && (
        <div className={styles.section}>
          <h3 className={styles.label}>{t('anki.previewTitle', { name: preview.name })}</h3>
          <dl className={styles.facts}>
            <dt>{t('anki.decks')}</dt>
            <dd>{preview.decks.join(', ') || '—'}</dd>
            <dt>{t('anki.notes')}</dt>
            <dd>{preview.notes}</dd>
            <dt>{t('anki.cards')}</dt>
            <dd>{preview.cards}</dd>
            <dt>{t('anki.reviews')}</dt>
            <dd>{preview.reviews}</dd>
            <dt>{t('anki.media')}</dt>
            <dd>{preview.media}</dd>
          </dl>
          <label className={styles.check}>
            <input type="checkbox" checked={keepHistory} onChange={(e) => setKeepHistory(e.target.checked)} />
            {t('anki.keepHistory')}
          </label>
          <div className={styles.actions}>
            <Button variant="primary" onClick={() => void confirm()} loading={busy === 'import'}>
              {t('anki.importAction', { count: preview.cards })}
            </Button>
            <Button onClick={() => setPreview(null)} disabled={busy !== null}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {result && (
        <p className={styles.ok} role="status">
          {t('anki.imported', { count: result.imported })}
          {result.skipped > 0 ? ` · ${t('anki.skipped', { count: result.skipped })}` : ''}
        </p>
      )}
      {error && (
        <p className={styles.bad} role="alert">
          {error}
        </p>
      )}
      <p className={styles.note}>{t('anki.exportHint')}</p>
    </section>
  )
}
