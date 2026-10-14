import { CloudCheck, CloudOff, HardDrive, LoaderCircle, Shield, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Link } from 'wouter'
import { useT } from '../../i18n/react.tsx'
import { cx } from '../cx.ts'
import styles from './Badge.module.css'

/** What the sync chip says. Derived from the verified engine status, never optimistic. */
export type SyncSummary =
  | { kind: 'protected'; count: number }
  | { kind: 'syncing' }
  | { kind: 'local' }
  | { kind: 'offline' }
  | { kind: 'attention' }
  | { kind: 'unsaved' }

const TONE: Record<SyncSummary['kind'], string | undefined> = {
  protected: styles.good,
  syncing: styles.busy,
  local: styles.neutral,
  offline: styles.neutral,
  attention: styles.warn,
  unsaved: styles.bad,
}

export function SyncBadge({ summary, href }: { summary: SyncSummary; href?: string }) {
  const t = useT()
  let text: string
  let Icon = HardDrive
  switch (summary.kind) {
    case 'protected':
      text = t('sync.protected', { count: summary.count })
      Icon = CloudCheck
      break
    case 'syncing':
      text = t('sync.syncing')
      Icon = LoaderCircle
      break
    case 'local':
      text = t('common.syncLocal')
      break
    case 'offline':
      text = t('common.syncOffline')
      Icon = CloudOff
      break
    case 'attention':
      text = t('common.syncAttention')
      Icon = TriangleAlert
      break
    case 'unsaved':
      text = t('common.syncUnsaved')
      Icon = TriangleAlert
      break
  }
  const body = (
    <>
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      <span>{text}</span>
    </>
  )
  const cls = cx(styles.badge, TONE[summary.kind])
  const label = t('common.syncStatus', { status: text })
  return href ? (
    <Link href={href} className={cls} aria-label={label} data-sync={summary.kind}>
      {body}
    </Link>
  ) : (
    <span className={cls} role="status" aria-label={label} data-sync={summary.kind}>
      {body}
    </span>
  )
}

/** Whether a destination seals (encrypts) what it receives. */
export function ProtectionBadge({ sealed }: { sealed: boolean }) {
  const t = useT()
  const Icon = sealed ? ShieldCheck : Shield
  return (
    <span className={cx(styles.badge, sealed ? styles.good : styles.neutral)}>
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      <span>{sealed ? t('common.sealed') : t('common.notSealed')}</span>
    </span>
  )
}

/** Small numeric pill (due counts). */
export function CountPill({ count, label }: { count: number; label: string }) {
  return (
    <span className={cx(styles.count, count === 0 && styles.countMuted)}>
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

export const COURSE_HUES = ['blue', 'teal', 'green', 'amber', 'orange', 'red', 'purple', 'graphite'] as const
export type CourseHue = (typeof COURSE_HUES)[number]

/** Course identity colour: the stored hue when it is one of the eight, otherwise derived from the id. */
export function courseHue(color: string | undefined, id: string): CourseHue {
  const named = COURSE_HUES.find((h) => h === color)
  if (named) return named
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return COURSE_HUES[h % COURSE_HUES.length] ?? 'blue'
}

export function CourseDot({ hue }: { hue: CourseHue }) {
  return <span className={styles.dot} style={{ background: `var(--course-${hue})` }} aria-hidden="true" />
}
