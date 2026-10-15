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
  /** section id → its name at creation: the section must survive every merge (renames may win later) */
  readonly sections = new Map<string, string>()
  /** session id → what it was started as */
  readonly sessions = new Map<string, { kind: string; practice: boolean }>()
  /** sessions whose end was acknowledged: they must stay ended */
  readonly ended = new Set<string>()
  /** practice review id → its session: it must keep its `p` and `sid`, and never move the schedule */
  readonly practice = new Map<string, string>()
  /** planned session id → its name at creation */
  readonly plans = new Map<string, string>()
  /** draft id → the token of its question at creation */
  readonly drafts = new Map<string, string>()
  /** drafts whose rejection was acknowledged: they must never be proposed again */
  readonly rejected = new Set<string>()
  /** draft id → the cards its acknowledged acceptances created (all kept) */
  readonly accepted = new Map<string, string[]>()
  private counter = 0

  token(prefix: string): string {
    this.counter++
    return `${prefix}${this.counter}z`
  }

  get acknowledged(): number {
    return (
      this.courses.size +
      this.tokens.size +
      this.deleted.size +
      this.reviews.size +
      this.voids.size +
      this.files.size +
      this.sections.size +
      this.sessions.size +
      this.ended.size +
      this.plans.size +
      this.drafts.size +
      this.rejected.size +
      this.accepted.size
    )
  }
}
