import { useEffect, useRef } from 'react'
import { useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspace } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { aiReadiness, useAiReadiness } from '../../ui/ai/ready.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { NoModel } from '../Understand/shared/SourcePicker.tsx'

/**
 * The former New study sheet screen, kept as a link (`#/understand?course=…`): with a model ready it opens the
 * course or section asked for (else the first course) on its study sheets, where a new one starts; without one it
 * says what is missing.
 */
export function Understand() {
  const t = useT()
  const ws = useWorkspace()
  const rt = useRuntime()
  // The app's one readiness decides; the model's own state only says why one is missing.
  const readiness = useAiReadiness()
  const ai = useAiModel()
  const asked = useScopeOnce()
  const [, navigate] = useLocation()
  const done = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (readiness !== 'ready' || done.current) return
    done.current = true
    // The latest reading decides (one may be under way, the AI settings just left): a model removed a moment ago
    // leaves the screen saying what is missing instead.
    void aiReadiness(rt).then((now) => {
      if (!mounted.current) return
      if (now !== 'ready') {
        done.current = false
        return
      }
      const first = ws.courses.list()[0]
      const scope = asked && ws.courses.get(asked.courseId) ? asked : first ? { courseId: first.id } : null
      // This entry becomes the place: Back leaves it as it would leave the course.
      const place = scope ? to.place(scope.courseId, scope.sectionId) : paths.courses
      navigate(place, { replace: true, state: scope ? { tab: 'fiches' } : undefined })
    })
  }, [readiness, ws, rt, asked, navigate])
  const back = asked ? to.place(asked.courseId, asked.sectionId) : paths.courses
  if (readiness === 'missing') {
    return (
      <Screen title={t('course.newSheet')} back={back}>
        <NoModel reason={ai.status === 'missing' ? ai.reason : undefined} />
      </Screen>
    )
  }
  return <Screen title={t('course.newSheet')} back={back} />
}
