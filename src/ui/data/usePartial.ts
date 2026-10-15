import type { DeepPartial } from 'ai'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * What an AI answer has written so far, for a screen that shows it as it arrives. `onPartial` goes into the
 * feature's context (`FeatureCtx.onPartial`); updates are applied once per frame, never once per token.
 * `reset` clears it (a new request, or the final answer taking its place).
 */
export function usePartial<T>(): {
  partial: DeepPartial<T> | null
  onPartial: (p: unknown) => void
  reset: () => void
} {
  const [partial, setPartial] = useState<DeepPartial<T> | null>(null)
  const latest = useRef<DeepPartial<T> | null>(null)
  const frame = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )
  const onPartial = useCallback((p: unknown) => {
    latest.current = p as DeepPartial<T>
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      setPartial(latest.current)
    })
  }, [])
  const reset = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    latest.current = null
    setPartial(null)
  }, [])
  return { partial, onPartial, reset }
}

/**
 * Items of a list still being written, with a React key from their rank (they arrive in order and never reorder)
 * and which one is being written now (the last).
 */
export function streamedKeys<T>(items: readonly T[]): { item: T; key: string; last: boolean }[] {
  return items.map((item, n) => ({ item, key: `item-${n + 1}`, last: n === items.length - 1 }))
}
