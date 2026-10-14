import { BookOpen, FileText, Layers, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { paths } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { formatRelative } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Trash.module.css'

type Kind = 'courses' | 'sources' | 'cards'

interface Item {
  kind: Kind
  id: Id
  title: string
  deletedAt: number
}

const ICON = { courses: BookOpen, sources: FileText, cards: Layers } as const

export default function Trash() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  // The items awaiting a "delete forever" confirmation; null when none is open.
  const [purging, setPurging] = useState<Item[] | null>(null)
  const items = useWorkspaceData(['courses', 'sources', 'cards'], (w): Item[] => {
    const out: Item[] = [
      ...w.courses.list({ trashed: true }).map((c) => ({ kind: 'courses' as const, id: c.id, title: c.title, at: c })),
      ...w.sources.list({ trashed: true }).map((s) => ({ kind: 'sources' as const, id: s.id, title: s.title, at: s })),
      ...w.cards.list({ trashed: true }).map((c) => ({
        kind: 'cards' as const,
        id: c.id,
        title: w.text({ id: c.id, field: 'front' }).toString().split('\n')[0] || t('course.emptyCard'),
        at: c,
      })),
    ].map(({ at, ...rest }) => ({ ...rest, deletedAt: at.deletedAt ?? at.updatedAt }))
    return out.sort((a, b) => b.deletedAt - a.deletedAt)
  })

  const restore = (i: Item) => ws[i.kind].restore(i.id)
  const purge = (list: Item[]) => {
    ws.batch(() => {
      for (const i of list) ws[i.kind].purge(i.id)
    })
    setPurging(null)
  }
  const kindLabel = (k: Kind) =>
    k === 'courses' ? t('common.courseTitle') : k === 'sources' ? t('common.sourceTitle') : t('common.cardTitle')

  return (
    <Screen title={t('common.trashTitle')} back={paths.settings}>
      {items.length === 0 ? (
        <EmptyState icon={Trash2} title={t('common.trashEmpty')} />
      ) : (
        <>
          <ListGroup title={t('common.trashTitle')} hideTitle footer={t('course.trashFooter')}>
            {items.map((i) => {
              const Icon = ICON[i.kind]
              return (
                <ListRow
                  key={i.id}
                  leading={<Icon size={20} />}
                  title={i.title}
                  subtitle={`${kindLabel(i.kind)} · ${t('course.deletedWhen', { when: formatRelative(locale, i.deletedAt) })}`}
                  trailing={
                    <span className={styles.rowActions}>
                      <Button
                        variant="plain"
                        onClick={() => restore(i)}
                        aria-label={t('course.restoreItem', { name: i.title })}
                      >
                        {t('course.restore')}
                      </Button>
                      <Button
                        variant="plain"
                        className={styles.purge}
                        onClick={() => setPurging([i])}
                        aria-label={t('course.purgeItem', { name: i.title })}
                      >
                        {t('course.purge')}
                      </Button>
                    </span>
                  }
                />
              )
            })}
          </ListGroup>
          <div>
            <Button variant="danger" icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => setPurging(items)}>
              {t('course.emptyTrash')}
            </Button>
          </div>
        </>
      )}
      <Sheet open={purging !== null} title={t('course.purgeTitle')} onClose={() => setPurging(null)}>
        <div className={styles.confirm}>
          <p>{t('course.purgeBody', { count: purging?.length ?? 0 })}</p>
          <p className={styles.note}>{t('course.purgeHistory')}</p>
          <Button variant="danger" size="large" full onClick={() => purge(purging ?? [])}>
            {t('course.purgeConfirm')}
          </Button>
          <Button variant="plain" full onClick={() => setPurging(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      </Sheet>
    </Screen>
  )
}
