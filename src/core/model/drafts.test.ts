import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import * as Y from 'yjs'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import {
  AUTO_QUESTION_DEFAULTS,
  DraftInputError,
  DraftStateError,
  draftStatus,
  type NewDraft,
  questionKey,
} from './drafts'
import { EntityNotFoundError } from './repos'
import { createWorkspace, type ModelWorkspace } from './workspace'

function ws(seed: number, doc = new Y.Doc()) {
  const clock = virtualClock(1_000)
  return { doc, clock, w: createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: `dev${seed}` }) }
}

function sync(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a))
  Y.applyUpdateV2(b, ua)
  Y.applyUpdateV2(a, ub)
}

function setup(w: ModelWorkspace) {
  const courseId = w.courses.create({ title: 'Physiology' })
  const sourceId = w.sources.create({ courseId, kind: 'pdf', title: 'Heart.pdf' })
  return { courseId, sourceId }
}

const q = (sourceId: string, courseId: string, front: string, unit = 1, more: Partial<NewDraft> = {}): NewDraft => ({
  sourceId,
  courseId,
  unit,
  kind: 'basic',
  type: 'qa',
  front,
  back: `answer to ${front}`,
  ...more,
})

describe('drafts', () => {
  test('no writes at startup, reads included', () => {
    const doc = new Y.Doc()
    let updates = 0
    doc.on('update', () => updates++)
    const { w } = ws(1, doc)
    expect(w.drafts.list()).toEqual([])
    expect(w.drafts.all()).toEqual([])
    expect(w.drafts.groups()).toEqual([])
    expect(w.drafts.summary()).toEqual({ total: 0, sources: [] })
    expect(w.drafts.settings.get()).toEqual(AUTO_QUESTION_DEFAULTS)
    expect(w.drafts.isRejected('anything')).toBe(false)
    w.subscribe('drafts', () => {})()
    expect(updates).toBe(0)
  })

  test('proposed drafts are grouped by source and unit, and counted for Today', () => {
    const { w, clock } = ws(2)
    const { courseId, sourceId } = setup(w)
    const other = w.sources.create({ courseId, kind: 'note', title: 'Notes' })
    w.drafts.propose([
      q(sourceId, courseId, 'What pumps blood?', 2, { unitKind: 'slide', unitLabel: '2' }),
      q(sourceId, courseId, 'What is systole?', 1, { unitKind: 'slide', unitLabel: '1' }),
      q(sourceId, courseId, 'What is diastole?', 2, { unitKind: 'slide', unitLabel: '2', quote: '  quoted  ' }),
    ])
    clock.advance(1000)
    w.drafts.propose([q(other, courseId, 'Note question')])
    expect(w.drafts.list().map((d) => d.status)).toEqual(['proposed', 'proposed', 'proposed', 'proposed'])
    const groups = w.drafts.groups({ sourceId })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.count).toBe(3)
    expect(groups[0]?.units.map((u) => [u.unit, u.unitKind, u.unitLabel, u.drafts.length])).toEqual([
      [1, 'slide', '1', 1],
      [2, 'slide', '2', 2],
    ])
    expect(w.drafts.list({ unit: 2 }).find((d) => d.front === 'What is diastole?')?.quote).toBe('quoted')
    const summary = w.drafts.summary()
    expect(summary.total).toBe(4)
    expect(summary.sources.map((s) => [s.sourceId, s.count])).toEqual([
      [other, 1],
      [sourceId, 3],
    ])
    // Snapshots keep their identity while nothing changes (useSyncExternalStore).
    expect(w.drafts.all()[0]).toBe(w.drafts.all()[0] as never)
  })

  test('propose checks its input and writes nothing on a bad draft', () => {
    const { w } = ws(3)
    const { courseId, sourceId } = setup(w)
    expect(() => w.drafts.propose([q(sourceId, courseId, 'ok'), q(sourceId, courseId, '  ')])).toThrow(DraftInputError)
    expect(() => w.drafts.propose([q(sourceId, courseId, 'no deletion', 1, { kind: 'cloze', type: 'cloze' })])).toThrow(
      DraftInputError,
    )
    expect(() => w.drafts.propose([q(sourceId, courseId, 'x', -1)])).toThrow(DraftInputError)
    expect(() => w.drafts.propose([q(sourceId, courseId, 'x', 1.5)])).toThrow(DraftInputError)
    expect(() => w.drafts.propose([q('', courseId, 'x')])).toThrow(DraftInputError)
    expect(() => w.drafts.propose([q(sourceId, '', 'x')])).toThrow(DraftInputError)
    expect(() => w.drafts.propose([q(sourceId, courseId, 'x', 1, { type: 'essay' as never })])).toThrow(DraftInputError)
    expect(() => w.drafts.propose([q(sourceId, courseId, 'x', 1, { kind: 'other' as never })])).toThrow(DraftInputError)
    expect(() => w.drafts.propose([q(sourceId, courseId, 'x', 1, { difficulty: 'extreme' as never })])).toThrow(
      DraftInputError,
    )
    expect(() => w.drafts.propose([q(sourceId, courseId, 'x', 1, { unitKind: 'chapter' as never })])).toThrow(
      DraftInputError,
    )
    expect(w.drafts.all()).toEqual([])
    expect(w.drafts.propose([])).toEqual([])
  })

  test('accept creates the card with its provenance and marks the draft accepted', () => {
    const { w, clock } = ws(4)
    const { courseId, sourceId } = setup(w)
    const sectionId = w.sections.create({ courseId, name: 'Cardio' })
    const [basic, cloze] = w.drafts.propose([
      q(sourceId, courseId, 'What pumps blood?', 3, { sectionId, model: 'mockai/mock-1' }),
      q(sourceId, courseId, 'The {{c1::heart}} pumps blood', 4, { kind: 'cloze', type: 'cloze', back: '' }),
    ]) as [string, string]
    clock.advance(5000)
    const cardId = w.drafts.accept(basic)
    const card = w.cards.get(cardId)
    expect(card).toMatchObject({ courseId, sectionId, kind: 'basic', sourceId, origin: 'ai', draftId: basic, unit: 3 })
    expect(w.text({ id: cardId, field: 'front' }).toString()).toBe('What pumps blood?')
    expect(w.text({ id: cardId, field: 'back' }).toString()).toBe('answer to What pumps blood?')
    expect(w.drafts.get(basic)).toMatchObject({ status: 'accepted', cardId, acceptedAt: 6000 })
    // Another course on request, its root since no subset was given.
    const elsewhere = w.courses.create({ title: 'Anatomy' })
    const clozeCard = w.drafts.accept(cloze, { courseId: elsewhere })
    expect(w.cards.get(clozeCard)).toMatchObject({ courseId: elsewhere, kind: 'cloze' })
    expect(w.cards.get(clozeCard)?.sectionId).toBeUndefined()
    expect(w.text({ id: clozeCard, field: 'back' }).toString()).toBe('')
    expect(() => w.drafts.accept(basic)).toThrow(DraftStateError)
    expect(() => w.drafts.reject(basic)).toThrow(DraftStateError)
    expect(() => w.drafts.edit(basic, { front: 'changed' })).toThrow(DraftStateError)
    expect(w.drafts.list()).toEqual([])
    expect(w.drafts.list({ status: 'accepted' })).toHaveLength(2)
  })

  test('accept is all or nothing, and falls back to the course when the subset is gone', () => {
    const { w } = ws(5)
    const { courseId, sourceId } = setup(w)
    const sectionId = w.sections.create({ courseId, name: 'Cardio' })
    const [a, b, c] = w.drafts.propose([
      q(sourceId, courseId, 'one', 1, { sectionId }),
      q(sourceId, courseId, 'two', 1),
      q(sourceId, courseId, 'three', 1),
    ]) as [string, string, string]
    w.sections.trash(sectionId)
    const card = w.drafts.accept(a)
    expect(w.cards.get(card)?.sectionId).toBeUndefined()
    // A course in the trash: nothing is created, nothing is marked.
    const gone = w.courses.create({ title: 'Gone' })
    w.courses.trash(gone)
    const before = w.cards.all().length
    expect(() => w.drafts.acceptAll([b, c], { courseId: gone })).toThrow(EntityNotFoundError)
    expect(w.cards.all().length).toBe(before)
    expect(w.drafts.get(b)?.status).toBe('proposed')
    expect(w.drafts.get(c)?.status).toBe('proposed')
    // Accepting all skips what is no longer proposed.
    w.drafts.reject(c)
    expect(w.drafts.acceptAll([a, b, c])).toHaveLength(1)
    expect(w.drafts.get(b)?.status).toBe('accepted')
    expect(() => w.drafts.accept('nope')).toThrow(EntityNotFoundError)
  })

  test('a rejected draft stays forever and its question is recognised again', () => {
    const { w } = ws(6)
    const { courseId, sourceId } = setup(w)
    const [a, b] = w.drafts.propose([
      q(sourceId, courseId, 'What is the SA node?'),
      q(sourceId, courseId, 'What is the AV node?'),
    ]) as [string, string]
    w.drafts.edit(a, { front: 'Where is the SA node?' })
    w.drafts.reject(a)
    w.drafts.reject(a)
    expect(w.drafts.get(a)?.status).toBe('rejected')
    expect(w.drafts.rejectedTexts().sort()).toEqual(['What is the SA node?', 'Where is the SA node?'])
    expect(w.drafts.isRejected('what is the sa NODE ?')).toBe(true)
    expect(w.drafts.isRejected('Where is the SA node')).toBe(true)
    expect(w.drafts.isRejected('What is the AV node?')).toBe(false)
    expect(w.drafts.isRejected('  ?! ')).toBe(false)
    expect(() => w.drafts.edit(a, { front: 'again' })).toThrow(DraftStateError)
    expect(() => w.drafts.accept(a)).toThrow(DraftStateError)
    w.drafts.rejectAll([a, b])
    expect(w.drafts.list({ status: 'rejected' }).map((d) => d.id)).toEqual([a, b].sort())
    expect(w.drafts.all()).toHaveLength(2)
  })

  test('edit changes text, kind and destination of a proposed draft', () => {
    const { w } = ws(7)
    const { courseId, sourceId } = setup(w)
    const sectionId = w.sections.create({ courseId, name: 'Cardio' })
    const [id] = w.drafts.propose([q(sourceId, courseId, 'front', 1, { sectionId })]) as [string]
    w.drafts.edit(id, { front: ' The {{c1::heart}} ', kind: 'cloze', type: 'cloze', back: ' ' })
    expect(w.drafts.get(id)).toMatchObject({ front: 'The {{c1::heart}}', back: '', kind: 'cloze', proposed: 'front' })
    expect(() => w.drafts.edit(id, { front: 'no deletion' })).toThrow(DraftInputError)
    expect(() => w.drafts.edit(id, { front: '' })).toThrow(DraftInputError)
    const other = w.courses.create({ title: 'Anatomy' })
    w.drafts.edit(id, { courseId: other })
    expect(w.drafts.get(id)?.courseId).toBe(other)
    expect(w.drafts.get(id)?.sectionId).toBeUndefined()
    w.drafts.edit(id, { courseId, sectionId })
    expect(w.drafts.get(id)).toMatchObject({ courseId, sectionId })
    w.drafts.edit(id, { sectionId: undefined })
    expect(w.drafts.get(id)?.sectionId).toBeUndefined()
  })

  test('drafts of a trashed source or bound for a trashed course are hidden, without any write', () => {
    const { w, doc } = ws(8)
    const { courseId, sourceId } = setup(w)
    const sectionId = w.sections.create({ courseId, name: 'Cardio' })
    const filed = w.sources.create({ courseId, sectionId, kind: 'note', title: 'Filed' })
    w.drafts.propose([q(sourceId, courseId, 'one'), q(filed, courseId, 'two')])
    expect(w.drafts.summary().total).toBe(2)
    w.sections.trash(sectionId)
    expect(w.drafts.summary().total).toBe(1)
    w.sources.trash(sourceId)
    const sv = Y.encodeStateVector(doc)
    expect(w.drafts.list()).toEqual([])
    expect(w.drafts.all()).toHaveLength(2)
    expect(Y.encodeStateVector(doc)).toEqual(sv)
    w.sources.restore(sourceId)
    w.sections.restore(sectionId)
    expect(w.drafts.list()).toHaveLength(2)
    w.courses.trash(courseId)
    expect(w.drafts.list()).toEqual([])
  })

  test('questionKey folds case, accents, punctuation and cloze markup', () => {
    expect(questionKey('  Qu’est-ce que la SYSTOLE ?')).toBe('qu est ce que la systole')
    expect(questionKey('Le {{c1::cœur::organe}} bat')).toBe('le cœur bat')
    expect(questionKey('Élément')).toBe('element')
    expect(draftStatus({ cardId: 'c', rejectedAt: 1 })).toBe('accepted')
    expect(draftStatus({ rejectedAt: 1 })).toBe('rejected')
    expect(draftStatus({})).toBe('proposed')
  })
})

describe('auto-question settings', () => {
  test('defaults, explicit writes, resets and validation', () => {
    const { w, doc } = ws(10)
    const s = w.drafts.settings
    expect(s.get().mode).toBe('propose')
    s.set({ mode: 'off', perUnit: 5, capPerMonth: 0 })
    expect(s.get()).toMatchObject({ mode: 'off', perUnit: 5, capPerMonth: 0 })
    expect(() => s.set({ types: ['explain', 'qa', 'qa'] })).toThrow(DraftInputError)
    s.set({ types: ['explain', 'qa'], destination: { courseId: 'c1', sectionId: 's1' } })
    expect(s.get().types).toEqual(['explain', 'qa'])
    expect(s.get().destination).toEqual({ courseId: 'c1', sectionId: 's1' })
    s.set({ destination: { courseId: 'c2' } })
    expect(s.get().destination).toEqual({ courseId: 'c2' })
    s.set({ mode: undefined, destination: undefined })
    expect(s.get().mode).toBe('propose')
    expect(s.get().destination).toBeUndefined()
    for (const bad of [
      { mode: 'auto' },
      { perUnit: 0 },
      { perUnit: 11 },
      { perUnit: 2.5 },
      { types: [] },
      { types: ['essay'] },
      { difficulty: 'medium' },
      { language: 'es' },
      { dedupe: 'yes' },
      { destination: { courseId: '' } },
      { destination: null },
      { destination: { courseId: 'c', sectionId: 3 } },
      { capPerDocument: -1 },
      { capPerMonth: Number.POSITIVE_INFINITY },
      { unknown: 1 },
    ]) {
      expect(() => s.set(bad as never)).toThrow(DraftInputError)
    }
    // A value written by another version is ignored, never thrown at the reader.
    doc.getMap('prefs').set('autoQuestions.mode', 'surprise')
    doc.getMap('prefs').set('autoQuestions.language', 'fr')
    expect(s.get().mode).toBe('propose')
    expect(s.get().language).toBe('fr')
  })

  test('questions per unit: automatic by default; a number stored by any version still reads as is', () => {
    const { w, doc } = ws(13)
    const s = w.drafts.settings
    expect(AUTO_QUESTION_DEFAULTS.perUnit).toBe('auto')
    expect(s.get().perUnit).toBe('auto')
    // A number written by an earlier version (before `auto`) keeps working.
    doc.getMap('prefs').set('autoQuestions.perUnit', 4)
    expect(s.get().perUnit).toBe(4)
    s.set({ perUnit: 'auto' })
    expect(doc.getMap('prefs').get('autoQuestions.perUnit')).toBe('auto')
    expect(s.get().perUnit).toBe('auto')
    s.set({ perUnit: 7 })
    expect(s.get().perUnit).toBe(7)
    // An unknown value (a later version's, or a damaged one) falls back to the default, never thrown at the reader.
    for (const unknown of ['many', 12, 0, 1.5, null, { n: 3 }]) {
      doc.getMap('prefs').set('autoQuestions.perUnit', unknown)
      expect(s.get().perUnit).toBe(AUTO_QUESTION_DEFAULTS.perUnit)
    }
    expect(() => s.set({ perUnit: 'many' as never })).toThrow(DraftInputError)
  })

  test('two devices changing different settings both keep their change', () => {
    const a = ws(11)
    const b = ws(12)
    a.w.drafts.settings.set({ mode: 'add' })
    b.w.drafts.settings.set({ capPerMonth: 5 })
    sync(a.doc, b.doc)
    expect(a.w.drafts.settings.get()).toMatchObject({ mode: 'add', capPerMonth: 5 })
    expect(b.w.drafts.settings.get()).toEqual(a.w.drafts.settings.get())
  })
})

// ---------------------------------------------------------------------------------------------------------
// Convergence between two devices

type Op =
  | { t: 'propose'; dev: number; unit: number }
  | { t: 'accept' | 'reject' | 'edit'; dev: number; which: number }
  | { t: 'trashSource'; dev: number; on: boolean }
  | { t: 'sync' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('propose' as const), dev: fc.nat(1), unit: fc.nat(3) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constantFrom('accept' as const, 'reject' as const, 'edit' as const),
      dev: fc.nat(1),
      which: fc.nat(20),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('trashSource' as const), dev: fc.nat(1), on: fc.boolean() }) },
  { weight: 2, arbitrary: fc.constant({ t: 'sync' as const }) },
)

/** Everything a device derives from the drafts. */
function signature(w: ModelWorkspace): string {
  return JSON.stringify({
    all: w.drafts.all().map((d) => [d.id, d.status, d.front, d.cardId ?? null, d.rejectedAt !== undefined]),
    groups: w.drafts.groups(),
    summary: w.drafts.summary(),
    rejected: w.drafts.rejectedTexts().sort(),
    cards: w.cards.all().map((c) => [c.id, c.draftId ?? null]),
  })
}

describe('drafts converge between two devices', () => {
  test('same drafts everywhere; a rejection is never undone; every accepted card is kept', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        const devs = [ws(21), ws(22)]
        const [a, b] = devs as [ReturnType<typeof ws>, ReturnType<typeof ws>]
        const { courseId, sourceId } = setup(a.w)
        sync(a.doc, b.doc)
        const rejected = new Set<string>()
        const accepted = new Map<string, string[]>()
        let n = 0
        for (const op of ops) {
          if (op.t === 'sync') {
            sync(a.doc, b.doc)
            continue
          }
          const d = devs[op.dev] as (typeof devs)[number]
          d.clock.advance(1000)
          const list = [...d.w.drafts.all()].sort((x, y) => (x.id < y.id ? -1 : 1))
          const target = list.length === 0 ? undefined : list[('which' in op ? op.which : 0) % list.length]
          try {
            if (op.t === 'propose') d.w.drafts.propose([q(sourceId, courseId, `question ${n++}`, op.unit)])
            else if (op.t === 'trashSource') {
              if (op.on) d.w.sources.trash(sourceId)
              else d.w.sources.restore(sourceId)
            } else if (target) {
              if (op.t === 'accept') {
                const card = d.w.drafts.accept(target.id)
                accepted.set(target.id, [...(accepted.get(target.id) ?? []), card])
              } else if (op.t === 'reject') {
                d.w.drafts.reject(target.id)
                rejected.add(target.id)
              } else d.w.drafts.edit(target.id, { front: `edited ${n++}` })
            }
          } catch (e) {
            // Refused locally (no longer proposed on this device): nothing was written.
            if (!(e instanceof DraftStateError)) throw e
          }
        }
        sync(a.doc, b.doc)
        const sv = [Y.encodeStateVector(a.doc), Y.encodeStateVector(b.doc)]
        expect(signature(a.w)).toBe(signature(b.w))
        // Reading wrote nothing.
        expect(Y.encodeStateVector(a.doc)).toEqual(sv[0] as Uint8Array)
        expect(Y.encodeStateVector(b.doc)).toEqual(sv[1] as Uint8Array)
        for (const id of rejected) {
          const d = a.w.drafts.get(id)
          expect(d?.rejectedAt).toBeDefined()
          expect(d?.status).not.toBe('proposed')
        }
        for (const [id, cards] of accepted) {
          expect(a.w.drafts.get(id)?.status).toBe('accepted')
          expect(cards).toContain(a.w.drafts.get(id)?.cardId as string)
          for (const c of cards) expect(a.w.cards.get(c)).toMatchObject({ draftId: id, sourceId })
        }
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 200) },
    )
  })
})
