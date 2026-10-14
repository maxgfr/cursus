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
