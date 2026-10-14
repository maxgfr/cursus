import type { Id } from '../../core/contracts/workspace'
import type { ModelWorkspace } from '../../core/model/workspace'
import type { Translate } from '../../i18n/index.ts'

/**
 * The demo course, written only when the student asks for it: one note and a few cards, all in
 * one transaction so another device never sees half of it.
 */
export function createDemoCourse(ws: ModelWorkspace, t: Translate): Id {
  return ws.batch(() => {
    const courseId = ws.courses.create({ title: t('today.demoCourse') })
    const note = ws.sources.create({ courseId, kind: 'note', title: t('today.demoNoteTitle') })
    ws.text({ id: note, field: 'body' }).insert(0, t('today.demoNoteBody'))
    const cards: [string, string][] = [
      [t('today.demoQ1'), t('today.demoA1')],
      [t('today.demoQ2'), t('today.demoA2')],
    ]
    for (const [front, back] of cards) {
      const id = ws.cards.create({ courseId, kind: 'basic', sourceId: note, origin: 'manual' })
      ws.text({ id, field: 'front' }).insert(0, front)
      ws.text({ id, field: 'back' }).insert(0, back)
    }
    const cloze = ws.cards.create({ courseId, kind: 'cloze', sourceId: note, origin: 'cloze' })
    ws.text({ id: cloze, field: 'front' }).insert(0, t('today.demoCloze'))
    return courseId
  })
}
