import type { SessionKind, SessionScope } from '../../core/contracts/workspace'
import type { ModelWorkspace } from '../../core/model/workspace'
import { intlTag, type Locale, type Translate } from '../../i18n/index.ts'

/** Short labels of the type control, in the order the control shows them. */
export const KIND_SEGMENT = {
  due: 'review.kindDue',
  ahead: 'review.kindAhead',
  failed: 'review.kindFailed',
  new: 'review.kindNew',
  all: 'review.kindAll',
} as const satisfies Record<SessionKind, string>

/** What a session of each type is called on its own (a title). */
export const KIND_LABEL = {
  due: 'review.labelDue',
  ahead: 'review.labelAhead',
  failed: 'review.labelFailed',
  new: 'review.labelNew',
  all: 'review.labelAll',
} as const satisfies Record<SessionKind, string>

export const KIND_HINT = {
  due: 'review.kindHintDue',
  ahead: 'review.kindHintAhead',
  failed: 'review.kindHintFailed',
  new: 'review.kindHintNew',
  all: 'review.kindHintAll',
} as const satisfies Record<SessionKind, string>

/** Practice (kept out of the schedule) by default: going ahead of the schedule, or through everything. */
export const practiceByDefault = (kind: SessionKind): boolean => kind === 'ahead' || kind === 'all'

/** The course or subset a scope names ("Law › Contracts"); null for every course or a scope gone since. */
export function scopeName(ws: ModelWorkspace, scope: SessionScope): string | null {
  if (scope.sectionId !== undefined) {
    const tree = ws.sections.tree()
    const chain = tree.get(scope.sectionId) === undefined ? [] : tree.chain(scope.sectionId)
    const course = ws.courses.get(scope.courseId ?? chain[0]?.courseId ?? '')
    if (chain.length === 0) return course?.title ?? null
    return [course?.title, ...chain.map((s) => s.name)].filter((x) => x !== undefined).join(' › ')
  }
  if (scope.courseId !== undefined) return ws.courses.get(scope.courseId)?.title ?? null
  return null
}

/** A session's name: its plan's, else its type and where its cards come from. */
export function sessionLabel(
  ws: ModelWorkspace,
  t: Translate,
  s: { kind: SessionKind; scope: SessionScope; planId?: string },
): string {
  const plan = s.planId === undefined ? undefined : ws.plans.get(s.planId)
  if (plan !== undefined && plan.deletedAt === undefined) return plan.name
  const kind = t(KIND_LABEL[s.kind])
  const scope = scopeName(ws, s.scope)
  return scope === null ? kind : t('review.sessionLabel', { kind, scope })
}

/** Monday 1 January 2024, so ISO weekday `d` is 2024-01-0d. */
const weekdayDate = (d: number): number => Date.UTC(2024, 0, d, 12)

/** "Mon, Wed, Fri at 18:00", or "Every day at 18:00". */
export function planSchedule(locale: Locale, t: Translate, weekdays: readonly number[], time: string): string {
  const tag = intlTag(locale)
  const short = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' })
  const days =
    weekdays.length === 7
      ? t('review.everyDay')
      : new Intl.ListFormat(tag, { style: 'narrow', type: 'unit' }).format(
          weekdays.map((d) => short.format(weekdayDate(d))),
        )
  return t('review.planSchedule', { days, time: formatTime(locale, time) })
}

/** `HH:MM` in the locale's own clock (6:00 PM, 18:00). */
export function formatTime(locale: Locale, time: string): string {
  const [h, m] = time.split(':').map(Number)
  return new Intl.DateTimeFormat(intlTag(locale), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
    Date.UTC(2024, 0, 1, h ?? 0, m ?? 0),
  )
}

/** "today at 18:00", "tomorrow at 7:30 AM", "Thursday at 18:00". */
export function formatWhen(locale: Locale, t: Translate, at: number, now: number): string {
  const tag = intlTag(locale)
  const time = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' }).format(at)
  const midnight = (x: number) => {
    const d = new Date(x)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((midnight(at) - midnight(now)) / 86_400_000)
  const day =
    days <= 1
      ? new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(days, 'day')
      : new Intl.DateTimeFormat(tag, { weekday: 'long' }).format(at)
  return t('review.planWhen', { day, time })
}
