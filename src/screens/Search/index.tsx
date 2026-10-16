import { Search as SearchIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearch } from 'wouter'
import { ChunkFailed } from '../../app/lazyChunk.tsx'
import { replaceQuery } from '../../app/nav.ts'
import { paths, to } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import { clozePlain } from '../../core/model/cloze'
import type { SearchHit } from '../../core/model/search'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'

export default function Search() {
  const t = useT()
  // The query lives in this entry's URL (`?q=`): coming back to Search finds it with its results.
  const search = useSearch()
  const [query, setQuery] = useState(() => new URLSearchParams(search).get('q') ?? '')
  const q = query.trim()
  const hits = useWorkspaceData(['courses', 'sources', 'fiches', 'cards'], (ws) => ({ ws }))
  // The first search loads the engine: until a query's hits arrive, nothing new is claimed about it.
  const [found, setFound] = useState<{ q: string; hits: readonly SearchHit[] }>({ q: '', hits: [] })
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (q === '') return
    let live = true
    hits.ws.search.search(q).then(
      (next) => {
        if (!live) return
        setFailed(false)
        setFound({ q, hits: next })
      },
      (e: unknown) => {
        noteError('search', e)
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [q, hits])
  const pending = q !== '' && found.q !== q
  const results =
    q === ''
      ? []
      : found.hits.flatMap((h) => {
          const ws = hits.ws
          if (h.kind === 'courses') {
            const c = ws.courses.get(h.id)
            return c ? [{ id: h.id, title: c.title, href: to.course(c.id) }] : []
          }
          if (h.kind === 'sources') {
            const s = ws.sources.get(h.id)
            return s ? [{ id: h.id, title: s.title, href: to.source(s.id) }] : []
          }
          if (h.kind === 'fiches') {
            const f = ws.fiches.get(h.id)
            return f ? [{ id: h.id, title: f.title, href: to.fiche(f.id) }] : []
          }
          const c = ws.cards.get(h.id)
          if (!c) return []
          const text = ws.text({ id: c.id, field: 'front' }).toString()
          const front = (c.kind === 'cloze' ? clozePlain(text) : text).split('\n')[0] ?? ''
          return [{ id: h.id, title: front || t('common.cardTitle'), href: to.card(c.id) }]
        })
  return (
    <Screen title={t('common.search')} back={paths.today}>
      <Field
        type="search"
        label={t('common.search')}
        hideLabel
        placeholder={t('common.searchPlaceholder')}
        value={query}
        onChange={(e) => {
          const next = e.currentTarget.value
          setQuery(next)
          replaceQuery(next === '' ? '' : new URLSearchParams({ q: next }).toString())
        }}
        enterKeyHint="search"
        autoComplete="off"
      />
      {failed ? (
        // The engine's code did not load (offline before it was kept): WebKit keeps that import failed, so reload.
        <ChunkFailed retry={() => location.reload()} again />
      ) : pending && results.length === 0 ? null : q === '' || results.length === 0 ? (
        q === '' ? (
          <EmptyState icon={SearchIcon} title={t('common.searchEmptyTitle')} body={t('common.searchEmpty')} />
        ) : (
          <EmptyState icon={SearchIcon} title={t('errors.notFound')} body={t('common.searchNoMatch')} />
        )
      ) : (
        <ListGroup title={t('common.search')} hideTitle>
          {results.map((r) => (
            <ListRow key={r.id} href={r.href} title={r.title} />
          ))}
        </ListGroup>
      )}
    </Screen>
  )
}
