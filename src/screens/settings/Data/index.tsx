import { type ChangeEvent, useCallback, useEffect, useState } from 'react'
import { noteLoadFailure } from '../../../app/chunkGuard.ts'
import { noteBackup } from '../../../app/lastBackup.ts'
import { paths } from '../../../app/routes.ts'
import { useWorkspaceData } from '../../../app/workspaceContext.tsx'
import { formatNumber } from '../../../i18n/format.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { PhotoDeviceSetting } from '../../Photos/DeviceSetting.tsx'
import { loadFile } from '../../Photos/files.ts'
import { noteError } from '../Diagnostic/recent.ts'
import { useAction, useDestinations, useWorkspaceConfirm } from '../Sync/hooks.tsx'
import { absorb, download, exportBackup, fileStamp } from '../Sync/registry.ts'
import styles from '../Sync/settings.module.css'
import { AnkiImport } from './AnkiImport.tsx'
import { EraseSection } from './EraseSection.tsx'
import { GuardSection } from './GuardSection.tsx'
import { canShareFiles, saveFile } from './saveFile.ts'

const MB = 1024 * 1024

async function bytesOf(e: ChangeEvent<HTMLInputElement>): Promise<{ name: string; bytes: Uint8Array } | null> {
  const f = e.target.files?.[0]
  e.target.value = ''
  return f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null
}

export default function DataSettings() {
  const t = useT()
  const locale = useLocale()
  const { rt, engine } = useDestinations()
  const confirmSheet = useWorkspaceConfirm()
  const { busy, error, run } = useAction()
  const [persist, setPersist] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [partial, setPartial] = useState<string | null>(null)
  const courses = useWorkspaceData(['courses'], (w) => w.courses.list())
  // Where the share sheet takes files (iPhone, iPad), the backup goes there: « Save to Files ».
  const [shareable, setShareable] = useState(false)
  useEffect(() => {
    import('../../../core/sync/providers/zip')
      .then(({ CURSUS_MIME }) => setShareable(canShareFiles(CURSUS_MIME)))
      .catch((e: unknown) => void noteLoadFailure('data.share', e, noteError))
  }, [])

  const measure = useCallback(async () => {
    const { persisted, estimate } = await import('../../../core/storage/persist')
    setPersist(await persisted())
    setUsage(await estimate())
  }, [])
  useEffect(() => {
    // Without the figures the rows stay unknown; the failure is in the diagnostic report.
    measure().catch((e: unknown) => void noteLoadFailure('data.measure', e, noteError))
  }, [measure])

  const done = (text: string) => {
    setPartial(null)
    setMessage(text)
  }
  const stamp = () => fileStamp(rt.clock.now())

  const askPersist = () =>
    run('persist', async () => {
      const { requestPersistence } = await import('../../../core/storage/persist')
      const ok = await requestPersistence()
      await measure()
      done(ok ? t('settings.persistGranted') : t('settings.persistRefused'))
    })

  /** Exports the library as a file: downloaded, or handed to the share sheet (« Save to Files » on iPhone). */
  const backup = (share = false) =>
    run(share ? 'share' : 'backup', async () => {
      if (!engine) return
      const { CURSUS_EXT, CURSUS_MIME } = await import('../../../core/sync/providers/zip')
      const { bytes, missingFiles } = await exportBackup(rt, engine)
      const name = `cursus-${stamp()}${CURSUS_EXT}`
      if (share) {
        if ((await saveFile(bytes, name, CURSUS_MIME)) === 'cancelled') return
      } else download(bytes, name, CURSUS_MIME)
      await noteBackup(rt.store, rt.clock.now())
      // Complete only when nothing the library refers to was left out.
      if (missingFiles === 0) done(t('settings.backupDone'))
      else {
        setMessage(null)
        setPartial(t('sync.backupPartial', { count: missingFiles }))
      }
    })

  const restoreFile = (e: ChangeEvent<HTMLInputElement>) =>
    run('restore', async () => {
      const file = await bytesOf(e)
      if (!file || !engine) return
      const { zipStore } = await import('../../../core/sync/providers/zip')
      const r = await absorb(rt, engine, zipStore({ bytes: file.bytes, label: `import-${rt.rng.id()}` }))
      if (r.error) throw new Error(r.error === 'workspace' ? t('settings.importDeclined') : r.error)
      done(t('settings.importDone', { count: r.added }))
    })

  const restoreFolder = (e: ChangeEvent<HTMLInputElement>) =>
    run('folder', async () => {
      const files = [...(e.target.files ?? [])]
      e.target.value = ''
      if (files.length === 0 || !engine) return
      const { DirImportStore } = await import('../../../core/sync/providers/dirImport')
      const r = await absorb(rt, engine, new DirImportStore(files))
      if (r.error) throw new Error(r.error === 'workspace' ? t('settings.importDeclined') : r.error)
      done(t('settings.importDone', { count: r.added }))
    })

  const markdown = () =>
    run('markdown', async () => {
      // Destructured on its own, so the bundler keeps only these two exports of fflate.
      const { exportMarkdown } = await import('../../../core/export/markdown')
      const { zipSync, strToU8 } = await import('fflate')
      const files: Record<string, Uint8Array> = {}
      for (const [name, text] of exportMarkdown(rt.ws)) files[name] = strToU8(text)
      download(zipSync(files), `cursus-${stamp()}-markdown.zip`, 'application/zip')
      done(t('settings.exportDone'))
    })

  const coursePackage = (id: string, title: string) =>
    run(`pkg:${id}`, async () => {
      const { exportCoursePackage, COURSE_EXT } = await import('../../../core/export/coursePackage')
      // With its photos and files; one out of reach (on demand, offline) is left out and said so.
      const { bytes, missing } = await exportCoursePackage(rt.ws, id, (fid) => loadFile(rt, engine, fid))
      download(bytes, `${safe(title)}${COURSE_EXT}`, 'application/zip')
      if (missing === 0) done(t('settings.exportDone'))
      else {
        setMessage(null)
        setPartial(t('photos.packageMissing', { count: missing }))
      }
    })

  const ankiExport = (id: string, title: string) =>
    run(`apkg:${id}`, async () => {
      const [{ exportApkg }, { blobStore }] = await Promise.all([
        import('../../../core/anki/apkgWrite'),
        import('../../../core/log/blobs'),
      ])
      // Card photos kept on demand are fetched for the package like any other.
      const blobs = { ...blobStore(rt.store), get: (fid: string) => loadFile(rt, engine, fid) }
      const bytes = await exportApkg(rt.ws, blobs, { courseIds: [id], now: rt.clock.now() })
      download(bytes, `${safe(title)}.apkg`, 'application/octet-stream')
      done(t('anki.exported'))
    })

  const importPackage = (e: ChangeEvent<HTMLInputElement>) =>
    run('pkg-import', async () => {
      const file = await bytesOf(e)
      if (!file) return
      const [{ importCoursePackage }, { blobStore }] = await Promise.all([
        import('../../../core/export/coursePackage'),
        import('../../../core/log/blobs'),
      ])
      // Its files are stored first, then the course that refers to them.
      await importCoursePackage(rt.ws, blobStore(rt.store), file.bytes)
      done(t('settings.courseImported'))
    })

  const fmt = (n: number) => formatNumber(locale, n / MB, 1)

  return (
    <Screen title={t('common.setData')} back={paths.settings}>
      <div className={styles.stack}>
        <p className={styles.prose}>{t('common.dataBody')}</p>
        {message && (
          <p className={styles.ok} role="status">
            {message}
          </p>
        )}
        {partial && (
          <p className={styles.warn} role="alert">
            {partial}
          </p>
        )}
        {error && (
          <p className={styles.bad} role="alert">
            {error}
          </p>
        )}

        <section className={styles.card} aria-labelledby="data-storage">
          <h2 id="data-storage" className={styles.sectionTitle}>
            {t('settings.storageTitle')}
          </h2>
          <p className={persist ? styles.ok : styles.warn}>
            {persist === null ? t('common.loading') : persist ? t('settings.persistOn') : t('settings.persistOff')}
          </p>
          {usage ? (
            <>
              <progress
                className={styles.meter}
                max={usage.quota}
                value={usage.usage}
                aria-label={t('settings.storageUsed', { used: fmt(usage.usage), quota: fmt(usage.quota) })}
              />
              <p className={styles.note}>
                {t('settings.storageUsed', { used: fmt(usage.usage), quota: fmt(usage.quota) })}
              </p>
            </>
          ) : (
            <p className={styles.note}>{t('settings.storageUnknown')}</p>
          )}
          {persist === false && (
            <div className={styles.actions}>
              <Button onClick={askPersist} loading={busy === 'persist'}>
                {t('settings.persistAsk')}
              </Button>
            </div>
          )}
        </section>

        <PhotoDeviceSetting />

        <section className={styles.card} aria-labelledby="data-backup">
          <h2 id="data-backup" className={styles.sectionTitle}>
            {t('settings.backupTitle')}
          </h2>
          <p className={styles.prose}>{t('settings.backupBody')}</p>
          <div className={styles.actions}>
            {shareable && (
              <Button variant="primary" onClick={() => backup(true)} loading={busy === 'share'} disabled={!engine}>
                {t('sync.saveBackup')}
              </Button>
            )}
            <Button
              variant={shareable ? 'secondary' : 'primary'}
              onClick={() => backup()}
              loading={busy === 'backup'}
              disabled={!engine}
            >
              {t('settings.backupExport')}
            </Button>
            <Button onClick={markdown} loading={busy === 'markdown'}>
              {t('settings.markdownExport')}
            </Button>
          </div>
          <label className={styles.section}>
            <span className={styles.label}>{t('settings.backupImport')}</span>
            <input
              className={styles.file}
              type="file"
              accept=".cursus,application/zip,application/vnd.cursus+zip"
              onChange={restoreFile}
              disabled={!engine || busy !== null}
            />
          </label>
          <label className={styles.section}>
            <span className={styles.label}>{t('settings.folderImport')}</span>
            <input
              className={styles.file}
              type="file"
              {...{ webkitdirectory: '' }}
              multiple
              onChange={restoreFolder}
              disabled={!engine || busy !== null}
            />
          </label>
          <p className={styles.note}>{t('settings.importMerges')}</p>
        </section>

        {courses.length > 0 && (
          <ListGroup title={t('settings.perCourse')} footer={t('settings.perCourseFooter')}>
            {courses.map((c) => (
              <ListRow
                key={c.id}
                title={c.title}
                trailing={
                  <span className={styles.actions}>
                    <Button
                      variant="plain"
                      onClick={() => ankiExport(c.id, c.title)}
                      loading={busy === `apkg:${c.id}`}
                      aria-label={t('settings.ankiExportOf', { name: c.title })}
                    >
                      <span translate="no">Anki</span>
                    </Button>
                    <Button
                      variant="plain"
                      onClick={() => coursePackage(c.id, c.title)}
                      loading={busy === `pkg:${c.id}`}
                      aria-label={t('settings.packageExportOf', { name: c.title })}
                    >
                      {t('settings.package')}
                    </Button>
                  </span>
                }
              />
            ))}
          </ListGroup>
        )}

        <section className={styles.card} aria-labelledby="data-course-import">
          <h2 id="data-course-import" className={styles.sectionTitle}>
            {t('settings.packageImport')}
          </h2>
          <input
            className={styles.file}
            type="file"
            accept=".cursus-course,application/zip"
            aria-labelledby="data-course-import"
            onChange={importPackage}
          />
        </section>

        <AnkiImport />

        <GuardSection />

        <EraseSection onBackup={() => backup()} backingUp={busy === 'backup'} />
      </div>
      {confirmSheet}
    </Screen>
  )
}

const safe = (s: string): string => s.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'course'
