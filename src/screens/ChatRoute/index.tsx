import { useEffect, useRef } from 'react'
import { useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspace } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { aiReadiness, useAiReadiness } from '../../ui/ai/ready.ts'
import type { StudyKind } from '../../ui/chat/actions.ts'
import { useChat } from '../../ui/chat/context.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { NoModel } from '../Understand/shared/SourcePicker.tsx'

/**
 * The former Generate, Quiz and New study sheet screens, kept as links (`#/generate?course=…`): with a model
 * ready they open the course or section asked for (else the first course) and run their action in the chat;
 * without one they say what is missing.
 */
function ChatRoute({ kind }: { kind: StudyKind }) {
  const t = useT()
  const ws = useWorkspace()
  const rt = useRuntime()
  const chat = useChat()
  // The app's one readiness decides; the model's own state only says why one is missing.
  const readiness = useAiReadiness()
  const ai = useAiModel()
  const asked = useScopeOnce()
  const [, navigate] = useLocation()
  const done = useRef(false)
  const title = kind === 'generate' ? t('ai.generate') : kind === 'quiz' ? t('ai.quiz') : t('course.newSheet')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (readiness !== 'ready' || !chat || done.current) return
    done.current = true
    // The latest reading decides (one may be under way, the AI settings just left): a model removed a moment ago
    // is not run, and the screen says what is missing instead.
    void aiReadiness(rt).then((now) => {
      if (!mounted.current) return
      if (now !== 'ready') {
        done.current = false
        return
      }
      const first = ws.courses.list()[0]
      const scope = asked && ws.courses.get(asked.courseId) ? asked : first ? { courseId: first.id } : null
      // This entry becomes the place the action runs in: Back leaves it as it would leave the course.
      navigate(scope ? to.place(scope.courseId, scope.sectionId) : kind === 'quiz' ? paths.sessions : paths.courses, {
        replace: true,
      })
      chat.run(kind, scope ?? undefined)
    })
  }, [readiness, chat, ws, rt, asked, kind, navigate])
  const back = asked ? to.place(asked.courseId, asked.sectionId) : kind === 'quiz' ? paths.sessions : paths.courses
  if (readiness === 'missing') {
    return (
      <Screen title={title} back={back}>
        <NoModel reason={ai.status === 'missing' ? ai.reason : undefined} />
      </Screen>
    )
  }
  return <Screen title={title} back={back} />
}

export function Generate() {
  return <ChatRoute kind="generate" />
}

export function Quiz() {
  return <ChatRoute kind="quiz" />
}

export function Understand() {
  return <ChatRoute kind="understand" />
}
