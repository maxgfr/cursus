import { Search as SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { paths, to } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function Search() {
  const t = useT()
  const [query, setQuery] = useState('')
  const q = query.trim()
  const hits = useWorkspaceData(['courses', 'sources', 'fiches', 'cards'], (ws) => ({ ws }))
  const results =
    q === ''
      ? []
      : hits.ws.search.search(q).flatMap((h) => {
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
            return f ? [{ id: h.id, title: f.title, href: to.course(f.courseId) }] : []
          }
          const c = ws.cards.get(h.id)
          if (!c) return []
          const front = ws.text({ id: c.id, field: 'front' }).toString().split('\n')[0] ?? ''
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
        onChange={(e) => setQuery(e.currentTarget.value)}
        enterKeyHint="search"
        autoComplete="off"
      />
      {q === '' || results.length === 0 ? (
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
