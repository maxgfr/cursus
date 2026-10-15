import { useState } from 'react'
import { useSearch } from 'wouter'
import { scopeFrom } from '../../app/routes.ts'
import type { StudyScope } from '../../core/contracts/workspace'

/**
 * The course or subset a screen was opened for (`?course=…&section=…` in the hash), read once. The query belongs to
 * this history entry only: a reload or a return through the history finds it again, later screens never inherit it.
 */
export function useScopeOnce(): StudyScope | null {
  const search = useSearch()
  const [scope] = useState(() => scopeFrom(search))
  return scope
}
