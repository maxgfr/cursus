import type { SessionKind } from '../contracts/workspace'

/** Every kind of custom session; its own module so the session log checks kinds without the queue builder. */
export const SESSION_KINDS: readonly SessionKind[] = ['due', 'ahead', 'failed', 'new', 'all']
