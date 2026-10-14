import { useEffect, useState } from 'react'
import { useSearch } from 'wouter'
import { scopeFrom } from '../../app/routes.ts'
import type { StudyScope } from '../../core/contracts/workspace'

/**
 * The course or subset a screen was opened for (`?course=…&section=…`), read once; the query then leaves
 * the URL so later screens don't inherit it.
 */
export function useScopeOnce(): StudyScope | null {
  const search = useSearch()
  const [scope] = useState(() => scopeFrom(search))
  useEffect(() => {
    if (search === '') return
    const url = new URL(window.location.href)
    url.search = ''
    window.history.replaceState(window.history.state, '', url.href)
  }, [search])
  return scope
}
