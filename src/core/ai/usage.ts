import type { CatalogModel } from './catalogTrim'
import { costOf, type TokenUsage } from './cost'

export type AiFeature =
  | 'understand'
  | 'generateCards'
  | 'explainCard'
  | 'gradeAnswer'
  | 'quiz'
  | 'improveCard'
  | 'explainBack'

/** One event of the workspace's `aiUsage` array. */
export interface AiUsageEvent {
  at: number
  feature: AiFeature
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
}

export type UsageSink = (e: AiUsageEvent) => void

export function usageEvent(feature: AiFeature, model: CatalogModel, usage: TokenUsage, at: number): AiUsageEvent {
  return {
    at,
    feature,
    provider: model.provider,
    model: model.id,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: costOf(usage, model.cost),
  }
}

/** Total cost of the events in the local calendar month containing `now`. */
export function monthCost(events: readonly AiUsageEvent[], now: number): number {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  let total = 0
  for (const e of events) if (e.at >= start && e.at < end) total += e.cost
  return total
}
