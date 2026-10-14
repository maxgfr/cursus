import { History as HistoryIcon, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'wouter'
import { to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { TextField } from '../../core/model/schema'
import { formatDateTime } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './History.module.css'
import { applyForward, textAt, textVersions, type Version } from './replay.ts'

type Load = { phase: 'loading' } | { phase: 'ready'; versions: Version[] } | { phase: 'error' }

/** `datetime-local` value of a time, in local time, to the minute. */
function localInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function History() {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const { id = '' } = useParams<{ id: string }>()
  const target = useWorkspaceData(['sources', 'cards', { id }], (ws) => {
    const s = ws.sources.get(id)
    if (s && s.deletedAt === undefined) {
      return {
        back: to.source(id),
        title: s.title,
        fields: ['body'] as TextField[],
        texts: { body: ws.text({ id, field: 'body' }).toString() },
      }
    }
    const c = ws.cards.get(id)
    if (c && c.deletedAt === undefined) {
      return {
        back: to.card(id),
        title: t('common.cardTitle'),
        fields: ['front', 'back'] as TextField[],
        texts: { front: ws.text({ id, field: 'front' }).toString(), back: ws.text({ id, field: 'back' }).toString() },
      }
    }
    return null
  })
  const [field, setField] = useState<TextField>(target?.fields[0] ?? 'body')
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [at, setAt] = useState<number | null>(null)
  const [restored, setRestored] = useState(false)

  useEffect(() => {
    let live = true
    setLoad({ phase: 'loading' })
    setAt(null)
    // Seal first so the latest edits are part of the history being replayed.
    rt.seal()
      .then(() => rt.log.since(0))
      .then(
        (segments) => {
          if (live) setLoad({ phase: 'ready', versions: textVersions(segments, id, field) })
        },
        (e: unknown) => {
          noteError('history.load', e)
          if (live) setLoad({ phase: 'error' })
        },
      )
    return () => {
      live = false
    }
  }, [rt, id, field])

  if (target === null) return <NotFound />
  const current = (target.texts as Partial<Record<TextField, string>>)[field] ?? ''
  const versions = load.phase === 'ready' ? load.versions : []
  const chosenAt = at ?? versions.at(-1)?.at ?? null
  const preview = chosenAt === null ? null : textAt(versions, chosenAt)
  const restore = () => {
    if (preview === null) return
    rt.ws.batch(() => applyForward(rt.ws.text({ id, field }), preview))
    setRestored(true)
  }

  return (
    <Screen title={t('common.historyTitle')} subtitle={target.title} back={target.back}>
      {target.fields.length > 1 && (
        <Segmented<TextField>
          label={t('course.historyField')}
          hideLabel
          value={field}
          onChange={(f) => {
            setField(f)
            setRestored(false)
          }}
          options={target.fields.map((f) => ({
            value: f,
            label: f === 'front' ? t('course.front') : f === 'back' ? t('course.back') : t('common.sourceTitle'),
          }))}
        />
      )}
      {load.phase === 'loading' && <p className={styles.note}>{t('common.loading')}</p>}
      {load.phase === 'error' && (
        <p className={styles.note} role="alert">
          {t('course.historyFailed')}
        </p>
      )}
      {load.phase === 'ready' && versions.length === 0 && (
        <EmptyState icon={HistoryIcon} title={t('course.historyEmptyTitle')} body={t('course.historyEmptyBody')} />
      )}
      {load.phase === 'ready' && versions.length > 0 && (
        <>
          <p className={styles.note}>{t('course.historyHelp')}</p>
          <Field
            label={t('course.replayTo')}
            type="datetime-local"
            value={chosenAt === null ? '' : localInput(chosenAt)}
            min={localInput(versions[0]?.at ?? 0)}
            onChange={(e) => {
              const v = e.currentTarget.valueAsNumber
              // valueAsNumber reads the local wall time as UTC; shift it back, and keep the whole minute.
              if (!Number.isNaN(v)) setAt(v + new Date(v).getTimezoneOffset() * 60_000 + 59_999)
              setRestored(false)
            }}
          />
          <ListGroup title={t('course.versions')} footer={t('course.versionCount', { count: versions.length })}>
            {[...versions].reverse().map((v) => (
              <ListRow
                key={v.at}
                title={formatDateTime(locale, v.at)}
                subtitle={v.text.split('\n')[0] || t('course.emptyVersion')}
                trailing={v.at === chosenAt ? <span className={styles.chosen}>{t('course.chosen')}</span> : undefined}
                onClick={() => {
                  setAt(v.at)
                  setRestored(false)
                }}
              />
            ))}
          </ListGroup>
          {preview !== null && (
            <section className={styles.preview} aria-labelledby="history-preview">
              <h2 id="history-preview" className={styles.label}>
                {t('course.asOf', { when: formatDateTime(locale, chosenAt ?? 0) })}
              </h2>
              <pre className={styles.text}>{preview === '' ? t('course.emptyVersion') : preview}</pre>
              {restored ? (
                <p className={styles.note} role="status">
                  {t('course.restored')}
                </p>
              ) : (
                <Button
                  variant="primary"
                  icon={<RotateCcw size={18} aria-hidden="true" />}
                  disabled={preview === current}
                  onClick={restore}
                >
                  {preview === current ? t('course.isCurrent') : t('course.restoreVersion')}
                </Button>
              )}
            </section>
          )}
        </>
      )}
    </Screen>
  )
}
