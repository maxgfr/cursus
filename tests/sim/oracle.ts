/**
 * What the user was told is saved: every write whose `appendLocal` resolved (durably in `pending`).
 * Unacknowledged writes (the device crashed first) may be lost; acknowledged ones never.
 */
export class Oracle {
  /** course id → its unique title token */
  readonly courses = new Map<string, string>()
  /** unique text token → where it was inserted */
  readonly tokens = new Map<string, { id: string; field: 'body' | 'front' | 'back' }>()
  /** tokens whose deletion was acknowledged: they must never come back */
  readonly deleted = new Set<string>()
  /** review id → card id */
  readonly reviews = new Map<string, string>()
  /** voided review ids: they must stay voided */
  readonly voids = new Set<string>()
  /** source id → blob id of its file */
  readonly files = new Map<string, string>()
  private counter = 0

  token(prefix: string): string {
    this.counter++
    return `${prefix}${this.counter}z`
  }

  get acknowledged(): number {
    return (
      this.courses.size + this.tokens.size + this.deleted.size + this.reviews.size + this.voids.size + this.files.size
    )
  }
}
