import { type ComponentType, lazy, useEffect, useReducer } from 'react'
import { useT } from '../i18n/react.tsx'
import { noteError } from '../screens/settings/Diagnostic/recent.ts'
import { Button } from '../ui/components/Button.tsx'
import { EmptyState } from '../ui/components/EmptyState.tsx'
import { guardChunk } from './chunkGuard.ts'

/**
 * A part of the app whose code did not load, said calmly, with a retry. `again`: a retry failed too, and
 * WebKit keeps a failed module import failed for the life of the page, so the action becomes a reload.
 */
export function ChunkFailed({ retry, again }: { retry: () => void; again: boolean }) {
  const t = useT()
  return (
    <EmptyState
      title={t('common.chunkFailed')}
      body={t('common.chunkFailedHint')}
      action={
        <Button variant="primary" onClick={again ? () => location.reload() : retry}>
          {again ? t('common.reload') : t('common.retry')}
        </Button>
      }
    />
  )
}

/** What shows in place of a component whose chunk failed; `retry` loads it again. */
export type Failed<P> = ComponentType<P & { retry: () => void; again: boolean }>

const calm = ({ retry, again }: { retry: () => void; again: boolean }) => <ChunkFailed retry={retry} again={again} />

/**
 * React.lazy through the chunk guard: a navigation abort never surfaces, a real failure is recorded for the
 * diagnostic report and renders `failed` (by default a calm retry) instead of throwing out of the tree.
 * Render it inside a Suspense boundary, as React.lazy.
 */
export function lazyChunk<P extends object>(
  where: string,
  load: () => Promise<{ default: ComponentType<P> }>,
  failed: Failed<NoInfer<P>> = calm,
): ComponentType<P> {
  const listeners = new Set<() => void>()
  let failures = 0
  const retry = () => {
    current = make()
    for (const l of listeners) l()
  }
  const make = () =>
    lazy(() =>
      // Recorded by the guard; what is left is to show the part as missing.
      guardChunk(load, `chunk.${where}`, noteError).catch(() => {
        const again = ++failures > 1
        return {
          default: (props: P) => {
            const Failed = failed
            return <Failed {...props} retry={retry} again={again} />
          },
        }
      }),
    )
  let current = make()
  return function Chunk(props: P) {
    const [, rerender] = useReducer((n: number) => n + 1, 0)
    useEffect(() => {
      listeners.add(rerender)
      return () => {
        listeners.delete(rerender)
      }
    }, [])
    const Current = current
    return <Current {...props} />
  }
}

/** Renders nothing: for extras the app works without (recorded all the same). */
export const nothing = () => null
