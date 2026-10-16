import type { Id } from '../../core/contracts/workspace'
import type { ModelWorkspace } from '../../core/model/workspace'

/** Both faces of a card replaced in one change (one sync update, one undo in its editors). */
export function replaceFaces(ws: ModelWorkspace, cardId: Id, front: string, back: string): void {
  ws.batch(() => {
    for (const [field, value] of [
      ['front', front],
      ['back', back],
    ] as const) {
      const text = ws.text({ id: cardId, field })
      text.delete(0, text.length)
      text.insert(0, value)
    }
  })
}
