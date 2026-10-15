import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  CalendarClock,
  CalendarPlus,
  ChartColumn,
  FileText,
  Inbox,
  Layers,
  Library,
  MessageCircle,
  Play,
  Search as SearchIcon,
  Settings,
  Sun,
} from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { useDueBadge } from '../app/badge.ts'
import { type Captured, usePasteCapture } from '../app/paste.ts'
import { paths, to } from '../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../app/workspaceContext.tsx'
import type { Id } from '../core/contracts/workspace'
import { fold, type SearchHit } from '../core/model/search'
import type { ModelWorkspace } from '../core/model/workspace'
import { useT } from '../i18n/react.tsx'
import { noteError } from '../screens/settings/Diagnostic/recent.ts'
import styles from './CommandPalette.module.css'
import { useChat } from './chat/context.tsx'
import { Sheet } from './components/Sheet.tsx'
import { Toast } from './components/Toast.tsx'
import { useStudy } from './data/useStudy.ts'

interface Item {
  id: string
  group: 'go' | 'actions' | 'results' | 'capture'
  title: string
  icon: LucideIcon
  run: () => void
}

const MAX_RESULTS = 8

/** Screens that take pasted content themselves: the global capture stays out of their way. */
function capturesOwnPaste(location: string): boolean {
  return /^\/(course|source|card)\//.test(location) || location === paths.review || location === paths.onboarding
}

function searchItems(
  ws: ModelWorkspace,
  hits: readonly SearchHit[],
  cardTitle: string,
  go: (href: string) => void,
): Item[] {
  const out: Item[] = []
  for (const h of hits) {
    if (out.length >= MAX_RESULTS) break
    if (h.kind === 'courses') {
      const c = ws.courses.get(h.id)
      if (c) out.push({ id: h.id, group: 'results', title: c.title, icon: Library, run: () => go(to.course(c.id)) })
    } else if (h.kind === 'sources') {
      const s = ws.sources.get(h.id)
      if (s) out.push({ id: h.id, group: 'results', title: s.title, icon: FileText, run: () => go(to.source(s.id)) })
    } else if (h.kind === 'fiches') {
      const f = ws.fiches.get(h.id)
      if (f)
        out.push({ id: h.id, group: 'results', title: f.title, icon: BookOpen, run: () => go(to.course(f.courseId)) })
    } else {
      const c = ws.cards.get(h.id)
      if (!c) continue
      const front = ws.text({ id: c.id, field: 'front' }).toString().split('\n')[0]?.trim() ?? ''
      out.push({ id: h.id, group: 'results', title: front || cardTitle, icon: Layers, run: () => go(to.card(c.id)) })
    }
  }
  return out
}

function noteTitle(text: string, fallback: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (line === '') return fallback
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/**
 * Global ⌘K / Ctrl+K palette: jump to screens, run actions, search everything.
 * Also hosts the global ⌘V capture (pasted text becomes a note in a chosen course)
 * and keeps the app icon badge in step with today's due count.
 */
export function CommandPalette() {
  const t = useT()
  const ws = useWorkspace()
  const [location, navigate] = useLocation()
  const [open, setOpen] = useState(false)
  // Each opening is a session: a close event still queued from the previous dialog (Escape, then ⌘K
  // at once) must not shut the new one.
  const [session, setSession] = useState(0)
  const sessionRef = useRef(0)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [captured, setCaptured] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const study = useStudy()
  const chat = useChat()
  useDueBadge(study.due)
  const courses = useWorkspaceData(['courses'], (w) => w.courses.list())
  // Search hits arrive asynchronously (the first search loads the engine), for the query they answer.
  const [found, setFound] = useState<{ q: string; hits: readonly SearchHit[] }>({ q: '', hits: [] })

  const close = useCallback(() => {
    setOpen(false)
    setCaptured(null)
  }, [])

  const show = useCallback(() => {
    setQuery('')
    setActive(0)
    sessionRef.current += 1
    setSession(sessionRef.current)
    setOpen(true)
  }, [])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        // The native dialog is the truth: Escape closes it before its close event reaches React.
        if (inputRef.current?.closest('dialog')?.open === true) close()
        else {
          setCaptured(null)
          show()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close, show])

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), 4_000)
    return () => clearTimeout(timer)
  }, [toast])

  usePasteCapture(
    (c: Captured) => {
      if (c.kind !== 'text') return
      if (courses.length === 0) {
        setToast(t('common.captureNoCourse'))
        return
      }
      setCaptured(c.text)
      show()
    },
    { enabled: !open && !capturesOwnPaste(location) },
  )

  const go = useCallback(
    (href: string) => {
      close()
      navigate(href)
    },
    [close, navigate],
  )

  const addNote = useCallback(
    (courseId: Id, title: string, text: string) => {
      const id = ws.batch(() => {
        const sid = ws.sources.create({ courseId, kind: 'note', title: noteTitle(text, t('common.captureNoteTitle')) })
        ws.text({ id: sid, field: 'body' }).insert(0, text)
        return sid
      })
      setToast(t('common.captureDone', { course: title }))
      go(to.source(id))
    },
    [ws, t, go],
  )

  const searched = open && captured === null ? query.trim() : ''
  useEffect(() => {
    if (searched === '') return
    let live = true
    ws.search.search(searched).then(
      (hits) => {
        if (live) setFound({ q: searched, hits })
      },
      (e: unknown) => {
        noteError('palette.search', e)
        if (live) setToast(t('common.chunkFailed'))
      },
    )
    return () => {
      live = false
    }
  }, [searched, ws, t])

  const items = useMemo((): Item[] => {
    if (!open) return []
    const q = query.trim()
    const match = (title: string) => q === '' || fold(title).includes(fold(q))
    if (captured !== null) {
      return courses
        .filter((c) => match(c.title))
        .map((c) => ({
          id: c.id,
          group: 'capture' as const,
          title: c.title,
          icon: Library,
          run: () => addNote(c.id, c.title, captured),
        }))
    }
    const nav: Item[] = [
      { id: 'today', group: 'go', title: t('common.cmdToday'), icon: Sun, run: () => go(paths.today) },
      { id: 'courses', group: 'go', title: t('common.cmdCourses'), icon: Library, run: () => go(paths.courses) },
      { id: 'stats', group: 'go', title: t('common.cmdStats'), icon: ChartColumn, run: () => go(paths.stats) },
      { id: 'inbox', group: 'go', title: t('ai.inboxTitle'), icon: Inbox, run: () => go(paths.inbox) },
      { id: 'sessions', group: 'go', title: t('review.sessions'), icon: CalendarClock, run: () => go(paths.sessions) },
      { id: 'newSession', group: 'go', title: t('review.newSession'), icon: Play, run: () => go(paths.sessionNew) },
      { id: 'settings', group: 'go', title: t('common.cmdSettings'), icon: Settings, run: () => go(paths.settings) },
      { id: 'search', group: 'go', title: t('common.cmdSearch'), icon: SearchIcon, run: () => go(paths.search) },
    ]
    const actions: Item[] = [
      ...(chat
        ? [
            {
              id: 'ask',
              group: 'actions' as const,
              title: t('chat.open'),
              icon: MessageCircle,
              run: () => {
                close()
                if (!chat.open) chat.toggle()
              },
            },
          ]
        : []),
      {
        id: 'ics',
        group: 'actions',
        title: t('common.cmdCalendar'),
        icon: CalendarPlus,
        run: () => {
          close()
          import('../screens/Stats/files.ts').then(
            (m) => {
              m.downloadCalendar(ws, { daily: t('common.icsDaily'), examPrefix: t('common.icsExamPrefix') })
              setToast(t('common.icsDone'))
            },
            (e: unknown) => {
              console.error('calendar export failed', e)
              setToast(t('errors.generic'))
            },
          )
        },
      },
    ]
    const results = q === '' || found.q !== q ? [] : searchItems(ws, found.hits, t('common.cardTitle'), go)
    return [...nav.filter((i) => match(i.title)), ...actions.filter((i) => match(i.title)), ...results]
  }, [open, query, captured, courses, ws, t, go, close, addNote, found, chat])

  const current = Math.min(active, Math.max(0, items.length - 1))
  const optionId = (i: number) => `${listId}-${i}`

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length === 0) return
      const next = (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      setActive(next)
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[current]?.run()
    }
  }

  const groupLabel: Record<Item['group'], string> = {
    go: t('common.paletteGo'),
    actions: t('common.paletteActions'),
    results: t('common.paletteResults'),
    capture: t('common.captureTitle'),
  }

  return (
    <>
      <Sheet
        key={session}
        open={open}
        initialFocus={inputRef}
        title={captured !== null ? t('common.captureTitle') : t('common.paletteTitle')}
        onClose={() => {
          if (sessionRef.current === session) close()
        }}
      >
        <input
          ref={inputRef}
          className={styles.input}
          role="combobox"
          aria-label={t('common.palettePlaceholder')}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length > 0 ? optionId(current) : undefined}
          placeholder={t('common.palettePlaceholder')}
          value={query}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div id={listId} role="listbox" aria-label={t('common.paletteTitle')} className={styles.list}>
          {items.length === 0 && <p className={styles.empty}>{t('common.paletteEmpty')}</p>}
          {items.map((item, i) => {
            const Icon = item.icon
            const head = i === 0 || items[i - 1]?.group !== item.group
            return [
              head && captured === null ? (
                <div key={`g-${item.group}`} role="presentation" className={styles.group}>
                  {groupLabel[item.group]}
                </div>
              ) : null,
              <div
                key={`${item.group}-${item.id}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                className={styles.option}
                onPointerMove={() => setActive(i)}
                tabIndex={-1}
                onClick={item.run}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    item.run()
                  }
                }}
              >
                <Icon className={styles.optionIcon} size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className={styles.optionTitle}>{item.title}</span>
              </div>,
            ]
          })}
        </div>
        <p className={styles.hint}>{t('common.paletteHint')}</p>
      </Sheet>
      {toast !== null && !open && <Toast message={toast} />}
    </>
  )
}
