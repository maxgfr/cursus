import { ListChecks } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useLocation } from 'wouter'
import { to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { StudyOptions } from '../../core/ai/features/tutorChat'
import type { Id, StudyScope } from '../../core/contracts/workspace'
import { failedLately, QUIZ_DEFAULT_COUNT, weakCards } from '../../core/model/quizPlan'
import type { ModelWorkspace } from '../../core/model/workspace'
import { useT } from '../../i18n/react.tsx'
import { useAiReady } from '../../ui/ai/ready.ts'
import { useChat } from '../../ui/chat/context.tsx'
import { QuizFields } from '../../ui/chat/QuizFields.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { scopeOptions, scopeValue } from '../SessionSetup/draft.ts'
import shared from '../Understand/shared/ai.module.css'
import { readLastQuiz, writeLastQuiz } from './quizLast.ts'

interface Node {
  value: string
  label: string
  scope: StudyScope
  sources: number
}

/** The places that can be quizzed: every course, each followed by its subsets in tree order, with their sources. */
function nodesOf(ws: ModelWorkspace): Node[] {
  return scopeOptions(ws).flatMap((o) =>
    o.scope.courseId === undefined
      ? []
      : [
          {
            value: o.value,
            label: o.label,
            scope: o.scope.sectionId
              ? { courseId: o.scope.courseId, sectionId: o.scope.sectionId }
              : { courseId: o.scope.courseId },
            sources: ws.scoped(
              'sources',
              o.scope.sectionId
                ? { courseId: o.scope.courseId, sectionId: o.scope.sectionId }
                : { courseId: o.scope.courseId },
            ).length,
          },
        ],
  )
}

/**
 * Where a quiz opens: the place on screen, else the one quizzed last, else the course with the most to work on (its
 * weak points, then its sources). Only places with sources count.
 */
function defaultNode(
  ws: ModelWorkspace,
  nodes: readonly Node[],
  at: StudyScope | undefined,
  now: number,
): Node | undefined {
  const usable = nodes.filter((n) => n.sources > 0)
  const find = (value: string) => usable.find((n) => n.value === value)
  const here = at ? find(scopeValue(at)) : undefined
  if (here) return here
  const last = find(readLastQuiz())
  if (last) return last
  const courses = usable.filter((n) => n.scope.sectionId === undefined)
  return [...courses].sort(
    (a, b) => weakCards(ws, b.scope, now).length - weakCards(ws, a.scope, now).length || b.sources - a.sources,
  )[0]
}

/**
 * « Quiz me », set up before it runs: the course or section (its sources, some of them only if wished), how many
 * questions — by default all its material covers —, how hard, and whether its weak points come first (on when
 * a card there was forgotten lately). The quiz then runs in the chat, beside that place. Offered only with a
 * model ready: it closes if the model goes away.
 */
export function QuizSheet({ open, at, onClose }: { open: boolean; at?: StudyScope; onClose: () => void }) {
  const t = useT()
  const ready = useAiReady()
  useEffect(() => {
    if (open && !ready) onClose()
  }, [open, ready, onClose])
  return (
    <Sheet open={open && ready} title={t('ai.quiz')} onClose={onClose}>
      {open && ready && <Setup at={at} onClose={onClose} />}
    </Sheet>
  )
}

function Setup({ at, onClose }: { at?: StudyScope; onClose: () => void }) {
  const t = useT()
  const ws = useWorkspace()
  const chat = useChat()
  const [location, navigate] = useLocation()
  const nodeId = useId()
  const nodes = useWorkspaceData(['courses', 'sections', 'sources'], nodesOf)
  // Worked out once, when the sheet opens: what the student then changes stays.
  const [node, setNode] = useState<string>(() => defaultNode(ws, nodes, at, Date.now())?.value ?? '')
  const current = nodes.find((n) => n.value === node)
  const sources = useWorkspaceData(['sources', 'sections', { id: node }], (w) =>
    current ? w.scoped('sources', current.scope) : [],
  )
  const weak = useWorkspaceData(['cards', 'reviews', 'sections', 'prefs', { id: node }], (w) =>
    current ? weakCards(w, current.scope, Date.now()) : [],
  )
  // Everything the place covers by default; a new place brings its own weak points (`pick`), the count chosen stays.
  const [choice, setChoice] = useState<Pick<StudyOptions, 'count' | 'difficulty' | 'focusWeak'>>(() => ({
    count: QUIZ_DEFAULT_COUNT,
    focusWeak: failedLately(weak, Date.now()),
    difficulty: 'standard',
  }))
  const [picked, setPicked] = useState<readonly Id[] | null>(null)
  const [topic, setTopic] = useState('')
  const chosen = picked ?? sources.map((s) => s.id)

  const pick = (value: string) => {
    setNode(value)
    setPicked(null)
    const next = nodes.find((n) => n.value === value)
    const nextWeak = next ? weakCards(ws, next.scope, Date.now()) : []
    setChoice((c) => ({
      ...c,
      focusWeak: failedLately(nextWeak, Date.now()),
    }))
  }

  const start = () => {
    if (!current || !chat || chosen.length === 0) return
    const { courseId, sectionId } = current.scope as { courseId: Id; sectionId?: Id }
    writeLastQuiz(current.value)
    onClose()
    // Already on that place (opened from the course or section itself): no second entry for Back to land on.
    const place = to.place(courseId, sectionId)
    if (location !== place) navigate(place)
    chat.run('quiz', sectionId ? { courseId, sectionId } : { courseId }, {
      courseId,
      ...(sectionId ? { sectionId } : {}),
      sourceIds: [...chosen],
      topic: topic.trim(),
      ...choice,
    })
  }

  if (!nodes.some((n) => n.sources > 0)) return <p className={shared.hint}>{t('ai.quizNoSources')}</p>
  return (
    <form
      className={shared.stack}
      onSubmit={(e) => {
        e.preventDefault()
        start()
      }}
    >
      <div className={shared.field}>
        <label className={shared.label} htmlFor={nodeId}>
          {t('ai.quizNode')}
        </label>
        <select id={nodeId} className={shared.select} value={node} onChange={(e) => pick(e.target.value)}>
          {nodes.map((n) => (
            <option key={n.value} value={n.value} disabled={n.sources === 0}>
              {n.sources === 0
                ? t('ai.quizNodeEmpty', { place: n.label })
                : t('ai.quizNodeSources', { place: n.label, count: n.sources })}
            </option>
          ))}
        </select>
      </div>
      {sources.length > 1 && (
        <details className={shared.disclosure}>
          <summary className={shared.disclosureSummary}>
            <span className={shared.disclosureLabel}>
              {t('ai.quizSourcesChosen', { count: chosen.length, total: sources.length })}
            </span>
          </summary>
          <div className={shared.disclosureBody}>
            {sources.map((s) => (
              <label key={s.id} className={shared.check}>
                <input
                  type="checkbox"
                  checked={chosen.includes(s.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...chosen, s.id] : chosen.filter((id) => id !== s.id))}
                />
                {s.title}
              </label>
            ))}
          </div>
        </details>
      )}
      <QuizFields value={choice} onChange={(patch) => setChoice((c) => ({ ...c, ...patch }))} weak={weak.length} />
      <Field label={t('ai.topicOptional')} value={topic} onChange={(e) => setTopic(e.target.value)} />
      <Button
        type="submit"
        variant="primary"
        icon={<ListChecks size={18} aria-hidden="true" />}
        disabled={!current || chosen.length === 0 || !chat}
      >
        {t('ai.quizStart')}
      </Button>
    </form>
  )
}
