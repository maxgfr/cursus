import { BookOpen, FileText, FolderTree, Layers, Trash2 } from 'lucide-react'
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
import { useGuard } from '../../ui/PasswordGate.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { purgeSection, type SectionContents, type TrashedSection, trashedSections } from './sections.ts'
import styles from './Trash.module.css'

type Kind = 'courses' | 'sources' | 'cards' | 'sections'

interface Item {
  kind: Kind
  id: Id
  title: string
  deletedAt: number
  /** For a subset: what it holds, which restore brings back and "delete forever" removes with it. */
  section?: TrashedSection
}

const ICON = { courses: BookOpen, sources: FileText, cards: Layers, sections: FolderTree } as const

export default function Trash() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const { guard, sheet: guardSheet } = useGuard()
  // The items awaiting a "delete forever" confirmation; null when none is open.
  const [purging, setPurging] = useState<Item[] | null>(null)
  const items = useWorkspaceData(['courses', 'sections', 'sources', 'cards', 'fiches'], (w): Item[] => {
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
    for (const s of trashedSections(w)) {
      out.push({ kind: 'sections', id: s.id, title: s.path, deletedAt: s.deletedAt, section: s })
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt)
  })

  const restore = (i: Item) => ws[i.kind].restore(i.id)
  const purge = (list: Item[]) => {
    ws.batch(() => {
      for (const i of list) {
        if (i.section) purgeSection(ws, i.section)
        else ws[i.kind].purge(i.id)
      }
    })
    setPurging(null)
  }
  const kindLabel = (k: Kind) =>
    k === 'courses'
      ? t('common.courseTitle')
      : k === 'sources'
        ? t('common.sourceTitle')
        : k === 'sections'
          ? t('common.sectionTitle')
          : t('common.cardTitle')
  const contents = (c: SectionContents): string => {
    const parts = [
      c.sections > 0 ? t('course.sectionCount', { count: c.sections }) : '',
      c.cards > 0 ? t('course.cardCount', { count: c.cards }) : '',
      c.sources > 0 ? t('course.sourceCount', { count: c.sources }) : '',
      c.fiches > 0 ? t('course.sheetCount', { count: c.fiches }) : '',
    ].filter((p) => p !== '')
    return parts.length > 0 ? parts.join(', ') : t('course.sectionEmpty')
  }
  const subtitle = (i: Item): string =>
    [
      kindLabel(i.kind),
      ...(i.section ? [contents(i.section.contents)] : []),
      t('course.deletedWhen', { when: formatRelative(locale, i.deletedAt) }),
    ].join(' · ')
  const purgingSections = (purging ?? []).flatMap((i) => (i.section ? [i.section.contents] : []))
  const purgingInside = purgingSections.reduce<SectionContents>(
    (a, c) => ({
      sections: a.sections + c.sections,
      cards: a.cards + c.cards,
      sources: a.sources + c.sources,
      fiches: a.fiches + c.fiches,
    }),
    { sections: 0, cards: 0, sources: 0, fiches: 0 },
  )

  return (
    <Screen title={t('common.trashTitle')} back={paths.settings}>
      {items.length === 0 ? (
        <EmptyState icon={Trash2} title={t('course.trashEmptyTitle')} body={t('course.trashEmptyBody')} />
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
                  subtitle={subtitle(i)}
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
          {purgingSections.length > 0 && <p>{t('course.purgeSectionBody', { contents: contents(purgingInside) })}</p>}
          <p className={styles.note}>{t('course.purgeHistory')}</p>
          <Button
            variant="danger"
            size="large"
            full
            onClick={() => {
              const list = purging ?? []
              guard(() => purge(list))
            }}
          >
            {t('course.purgeConfirm')}
          </Button>
          <Button variant="plain" full onClick={() => setPurging(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      </Sheet>
      {guardSheet}
    </Screen>
  )
}
