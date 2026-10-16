import { Suspense } from 'react'
import { lazyChunk, nothing } from '../../app/lazyChunk.tsx'
import type { GenerateAt } from './GenerateSheet.tsx'

export const GENERATE_QUERY = 'generate=1'

const GenerateSheet = lazyChunk<{ at: GenerateAt; onClose: () => void }>(
  'generateSheet',
  () => import('./GenerateSheet.tsx'),
  nothing,
)

/** « Create cards », loaded when opened (it brings the AI code): `at` is where it opens, null when closed. */
export function Generate({ at, onClose }: { at: GenerateAt | null; onClose: () => void }) {
  if (at === null) return null
  return (
    <Suspense fallback={null}>
      <GenerateSheet at={at} onClose={onClose} />
    </Suspense>
  )
}
