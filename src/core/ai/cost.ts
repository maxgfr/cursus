import type { CatalogCost } from './catalogTrim'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** Catalog prices are USD per million tokens. Unknown price ⇒ 0 (free or unpriced). */
export function costOf(usage: TokenUsage, price: CatalogCost | undefined): number {
  if (!price) return 0
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000
}

/** What running a feature is expected to cost, shown before it runs. */
export interface CostEstimate extends TokenUsage {
  /** USD; 0 when the model is free or unpriced. */
  cost: number
  /** Model calls the run makes. */
  calls: number
}

export function estimateCost(usage: TokenUsage, calls: number, price: CatalogCost | undefined): CostEstimate {
  return { ...usage, calls, cost: costOf(usage, price) }
}
