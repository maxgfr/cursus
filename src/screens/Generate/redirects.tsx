import { Redirect, useParams, useSearch } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { GENERATE_QUERY } from './open.tsx'

/** The former « Create cards » screen of a deck: its source, with « Create cards » open. */
export function DeckQuestionsRedirect() {
  const { id = '' } = useParams<{ id: string }>()
  return <Redirect to={`${to.source(id)}?${GENERATE_QUERY}`} replace />
}

/** The former Generate screen (`#/generate?course=…`): « Suggested cards », with « Create cards » open there. */
export function GenerateRedirect() {
  const search = useSearch()
  return <Redirect to={`${paths.inbox}?${GENERATE_QUERY}${search ? `&${search}` : ''}`} replace />
}
