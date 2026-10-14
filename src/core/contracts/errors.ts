export type RemoteErrorKind = 'auth' | 'permission' | 'network' | 'cors' | 'quota' | 'rate-limited' | 'clock-skew'
export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    m: string,
    readonly retryAfterMs?: number,
  ) {
    super(m)
  }
}

export type EnvelopeErrorKind = 'hash' | 'magic' | 'version'
export class EnvelopeError extends Error {
  constructor(
    readonly kind: EnvelopeErrorKind,
    m: string,
  ) {
    super(m)
  }
}
