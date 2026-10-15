import { buildIcs, type IcsPlan } from '../../core/export/ics'
import type { PlanRecord } from '../../core/model/schema'
import { download, safeName } from '../Stats/download.ts'

/** Calendar events of planned sessions: weekly on their days at their time, with an alarm when they start. */
export function icsPlans(plans: readonly PlanRecord[], describe?: (p: PlanRecord) => string): IcsPlan[] {
  return plans.map((p) => {
    const event: IcsPlan = { id: p.id, summary: p.name, weekdays: p.weekdays, time: p.time }
    const description = describe?.(p)
    if (description) event.description = description
    return event
  })
}

/** Saves an `.ics` file of these planned sessions: one opened in Calendar adds their reminders. */
export function downloadPlans(
  plans: readonly PlanRecord[],
  name: string,
  describe: (p: PlanRecord) => string,
  now = Date.now(),
): void {
  const ics = buildIcs({ now, plans: icsPlans(plans, describe) })
  download(`${safeName(name, 'sessions')}.ics`, new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
}
