import { Suspense } from 'react'
import { lazyChunk, nothing } from '../../app/lazyChunk.tsx'
import type { GenerateAt } from './GenerateSheet.tsx'

export const GENERATE_QUERY = 'generate=1'
/** « Create cards » opened on one slide, page or section of a source. */
export const generateUnitQuery = (unit: number): string => `${GENERATE_QUERY}&unit=${unit}`
/** The unit `generateUnitQuery` names, if any. */
export function generateUnit(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('unit')
  const n = raw === null || raw === '' ? Number.NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

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
