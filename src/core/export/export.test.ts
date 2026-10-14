import { describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import * as Y from 'yjs'
import { createWorkspace } from '../model/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { MemoryBucket, memoryRemote } from '../sync/providers/memory'
import {
  COURSE_EXT,
  CoursePackageError,
  CourseTreeError,
  exportCourse,
  importCourse,
  readCoursePackage,
} from './coursePackage'
import { CsvTargetError, importCards, parseDelimited } from './csvImport'
import { buildIcs, escapeText, foldLine } from './ics'
import { csvField, exportMarkdown, safeName } from './markdown'
import { MIRROR_PREFIX, writeMirror } from './mirror'

function ws(seed = 1) {
  const doc = new Y.Doc()
  const clock = virtualClock(1_000)
  return createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: `dev${seed}` })
}

function sample() {
  const w = ws()
  const course = w.courses.create({ title: 'Bio/Chem', examDate: '2027-01-15', emoji: 'x' })
  const src = w.sources.create({ courseId: course, kind: 'note', title: 'Cell' })
  w.text({ id: src, field: 'body' }).insert(0, 'Cells are small.')
  w.sources.create({ courseId: course, kind: 'pdf', title: 'Scan' })
  const fiche = w.fiches.create({
    courseId: course,
    title: 'Mitosis',
    subject: 'Division',
    sourceIds: [src],
    keyPoints: [{ text: 'Four phases', sourceRef: { sourceId: src, page: 2 } }, { text: 'No ref' }],
  })
  w.text({ id: fiche, field: 'body' }).insert(0, 'Prophase first.')
  const card = w.cards.create({ courseId: course, kind: 'basic', ficheId: fiche, sourceId: src, tags: ['bio', 'cell'] })
  w.text({ id: card, field: 'front' }).insert(0, 'What, "exactly"?')
  w.text({ id: card, field: 'back' }).insert(0, 'Line1\nLine2')
  const trashed = w.fiches.create({ courseId: course, title: 'Gone' })
  w.fiches.trash(trashed)
  return { w, course, src, fiche, card }
}

describe('readable export', () => {
  test('contents: sources, fiches, cards.csv; trashed and binary sources left out', () => {
    const { w } = sample()
    const files = exportMarkdown(w)
    expect([...files.keys()].sort()).toEqual(['Bio Chem/Cell.md', 'Bio Chem/cards.csv', 'Bio Chem/fiches/Mitosis.md'])
    expect(files.get('Bio Chem/Cell.md')).toBe('# Cell\n\nCells are small.\n')
    expect(files.get('Bio Chem/fiches/Mitosis.md')).toBe(
      '# Mitosis\n\n_Division_\n\nProphase first.\n\n## Key points\n\n- Four phases\n- No ref\n',
    )
    expect(files.get('Bio Chem/cards.csv')).toBe('front,back,tags\r\n"What, ""exactly""?","Line1\nLine2",bio cell\r\n')
  })

  test('names are sanitised and collisions get a suffix', () => {
    const w = ws()
    w.courses.create({ title: 'A' })
    const b = w.courses.create({ title: 'a' })
    w.sources.create({ courseId: b, kind: 'note', title: '' })
    w.sources.create({ courseId: b, kind: 'note', title: '..' })
    w.fiches.create({ courseId: b, title: 'X' })
    w.fiches.create({ courseId: b, title: 'X' })
    expect([...exportMarkdown(w).keys()].sort()).toEqual([
      'a (2)/Source (2).md',
      'a (2)/Source.md',
      'a (2)/fiches/X (2).md',
      'a (2)/fiches/X.md',
    ])
    expect(safeName(' a:b*c\t', 'f')).toBe('a b c')
    expect(csvField('plain')).toBe('plain')
  })

  test('mirror/ writes changed files only and reports stale ones', async () => {
    const { w, src } = sample()
    const store = memoryRemote({ bucket: new MemoryBucket() })
    await store.put(`${MIRROR_PREFIX}Old/x.md`, new TextEncoder().encode('old'))
    expect(await writeMirror(w, store)).toEqual({ written: 3, unchanged: 0, stale: ['mirror/Old/x.md'] })
    expect(await writeMirror(w, store)).toEqual({ written: 0, unchanged: 3, stale: ['mirror/Old/x.md'] })
    w.text({ id: src, field: 'body' }).insert(0, 'New. ')
    expect((await writeMirror(w, store)).written).toBe(1)
    expect(
      new TextDecoder().decode((await store.get({ key: 'mirror/Bio Chem/Cell.md' })) ?? new Uint8Array()),
    ).toContain('New. Cells')
  })
})

describe('course package', () => {
  test('round-trip creates a NEW course with fresh ids and the same content', () => {
    const { w, course, src, fiche, card } = sample()
    const bytes = exportCourse(w, course)
    expect(COURSE_EXT).toBe('.cursus-course')
    const other = ws(7)
    const id = importCourse(other, bytes)
    expect(exportMarkdown(other)).toEqual(exportMarkdown(w))
    const c = other.courses.get(id)
    expect(c?.examDate).toBe('2027-01-15')
    const [s] = other.sources.list({ courseId: id }).filter((x) => x.kind === 'note')
    const [f] = other.fiches.list({ courseId: id })
    const [k] = other.cards.list({ courseId: id })
    for (const old of [course, src, fiche, card]) expect([id, s?.id, f?.id, k?.id]).not.toContain(old)
    expect(f?.sourceIds).toEqual([s?.id as string])
    expect(f?.keyPoints?.[0]?.sourceRef).toEqual({ sourceId: s?.id as string, page: 2 })
    expect(k?.ficheId).toBe(f?.id as string)
    expect(k?.sourceId).toBe(s?.id as string)

    // Importing into the same workspace twice duplicates, never merges into the original.
    const again = importCourse(w, bytes)
    expect(again).not.toBe(course)
    expect(w.courses.list().length).toBe(2)
    expect(w.cards.list({ courseId: course }).length).toBe(1)
  })

  test('errors: unknown course, garbage, wrong format', () => {
    const w = ws()
    expect(() => exportCourse(w, 'nope')).toThrow(CoursePackageError)
    expect(() => readCoursePackage(new Uint8Array([1, 2]))).toThrow(CoursePackageError)
    expect(() => readCoursePackage(zipSync({ 'other.json': new Uint8Array() }))).toThrow(CoursePackageError)
    const wrong = zipSync({ 'course.json': new TextEncoder().encode('{"format":"x"}') })
    expect(() => readCoursePackage(wrong)).toThrow(CoursePackageError)
  })
})

describe('CSV/TSV import', () => {
  test('parses quoting, CRLF, BOM and blank lines', () => {
    expect(parseDelimited('﻿a,"b ""q"", c"\r\n\r\n"x\ny",z')).toEqual([
      ['a', 'b "q", c'],
      ['x\ny', 'z'],
    ])
    expect(parseDelimited('a;b\nc;d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseDelimited('single')).toEqual([['single']])
  })

  test('Anki plain-text export with headers', () => {
    const w = ws()
    const c = w.courses.create({ title: 'C' })
    const anki = '#separator:tab\n#html:false\n#tags column:3\nQ1\tA1\tt1 t2\nQ2\tA2\t\n\tmissing\n'
    expect(importCards(w, c, anki)).toEqual({ created: 2, skipped: 1 })
    const cards = w.cards.list({ courseId: c })
    expect(cards.map((k) => w.text({ id: k.id, field: 'front' }).toString()).sort()).toEqual(['Q1', 'Q2'])
    expect(cards.map((k) => k.tags ?? []).sort((a, b) => b.length - a.length)).toEqual([['t1', 't2'], []])
    expect(parseDelimited('#separator:Pipe\na|b')).toEqual([['a', 'b']])
  })

  test('Quizlet TSV and CSV with a header row', () => {
    const w = ws()
    const c = w.courses.create({ title: 'C' })
    expect(importCards(w, c, 'term\tdefinition\nchat\tcat\n')).toEqual({ created: 2, skipped: 0 })
    expect(importCards(w, c, 'front,back\nhund,dog\n')).toEqual({ created: 1, skipped: 0 })
  })
})

describe('.ics', () => {
  const now = Date.UTC(2026, 9, 14, 8, 30, 5)

  test('RFC 5545 structure: CRLF, daily reminder with VALARM, exams as all-day events', () => {
    const ics = buildIcs({
      now,
      daily: { hour: 19, minute: 5, summary: 'Review, today; cards', description: 'Open Cursus\nnow' },
      exams: [{ id: 'C1', title: 'Bio', date: '2026-12-31' }],
      examPrefix: 'Exam: ',
    })
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n')
    const lines = ics.split('\r\n')
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('DTSTAMP:20261014T083005Z')
    expect(lines).toContain('DTSTART:20261014T190500')
    expect(lines).toContain('RRULE:FREQ=DAILY')
    expect(lines).toContain('SUMMARY:Review\\, today\\; cards')
    expect(lines).toContain('DESCRIPTION:Open Cursus\\nnow')
    expect(lines).toContain('UID:exam-C1@cursus')
    expect(lines).toContain('DTSTART;VALUE=DATE:20261231')
    expect(lines).toContain('DTEND;VALUE=DATE:20270101')
    expect(lines).toContain('TRIGGER:-PT1440M')
    expect(ics.match(/BEGIN:VALARM/g)?.length).toBe(2)
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(ics.match(/END:VEVENT/g)?.length)
  })

  test('folding at 75 octets keeps UTF-8 sequences whole and unfolds back', () => {
    const long = `SUMMARY:${'é'.repeat(100)}`
    const folded = foldLine(long)
    const enc = new TextEncoder()
    for (const l of folded.split('\r\n')) expect(enc.encode(l).length).toBeLessThanOrEqual(75)
    expect(folded.replace(/\r\n /g, '')).toBe(long)
    expect(foldLine('short')).toBe('short')
    expect(escapeText('a\\b')).toBe('a\\\\b')
  })

  test('invalid input is rejected; no reminder and no exams is an empty calendar', () => {
    expect(() => buildIcs({ now, daily: { hour: 24, minute: 0, summary: 's' } })).toThrow(RangeError)
    expect(() => buildIcs({ now, exams: [{ id: 'x', title: 't', date: '2026-1-1' }] })).toThrow(RangeError)
    expect(buildIcs({ now })).not.toContain('VEVENT')
    expect(buildIcs({ now, exams: [{ id: 'x', title: 't', date: '2026-01-01' }], examAlarmMinutes: 60 })).toContain(
      'TRIGGER:-PT60M',
    )
  })
})

describe('ICS TEXT escaping (RFC 5545 §3.3.11)', () => {
  test('escapes semicolons, commas, backslashes and newlines', () => {
    expect(escapeText('Maths; Physics')).toBe(String.raw`Maths\; Physics`)
    expect(escapeText('a\\b')).toBe('a\\\\b')
    expect(escapeText('a\r\nb\nc')).toBe('a\\nb\\nc')
    expect(escapeText(String.raw`x\;y`)).toBe(String.raw`x\\\;y`)
    const ics = buildIcs({
      now: 0,
      exams: [{ id: 'M', title: 'Maths; Physics', date: '2026-06-01' }],
      examPrefix: 'Exam: ',
    })
    expect(ics.split('\r\n')).toContain(String.raw`SUMMARY:Exam: Maths\; Physics`)
  })
})

describe('course package validation', () => {
  const pack = (json: unknown) => zipSync({ 'course.json': new TextEncoder().encode(JSON.stringify(json)) })
  const base = (over: Record<string, unknown> = {}) => ({
    format: 'cursus-course/1',
    course: { title: 'T' },
    sources: [],
    fiches: [],
    cards: [],
    ...over,
  })

  test('rejects a numeric title and other ill-typed fields', () => {
    const w = ws()
    expect(() => importCourse(w, pack(base({ course: { title: 42 } })))).toThrow(CoursePackageError)
    expect(() =>
      readCoursePackage(pack(base({ sources: [{ ref: 's0', kind: 'exe', title: 't', body: '' }] }))),
    ).toThrow(CoursePackageError)
    expect(() => readCoursePackage(pack(base({ cards: [{ kind: 'basic', front: 1, back: '' }] })))).toThrow(
      CoursePackageError,
    )
    expect(() =>
      readCoursePackage(pack(base({ fiches: [{ ref: 'f', title: 't', sourceRefs: [], keyPoints: [{}], body: '' }] }))),
    ).toThrow(CoursePackageError)
    expect(w.courses.list().length).toBe(0)
  })

  test('never writes deletedAt, purgedAt, ids or unknown keys', () => {
    const w = ws()
    const evil = { id: 'X', deletedAt: 1, purgedAt: 2, evil: 'y' }
    const id = importCourse(
      w,
      pack(
        base({
          course: { title: 'Ok', color: 'red', ...evil },
          sources: [{ ref: 's0', kind: 'note', title: 'S', body: 'b', ...evil }],
          fiches: [
            { ref: 'f0', title: 'F', sourceRefs: ['s0'], keyPoints: [{ text: 'k', evil: 1 }], body: '', ...evil },
          ],
          cards: [{ kind: 'basic', ficheRef: 'f0', front: 'q', back: 'a', origin: 'ai', ...evil }],
        }),
      ),
    )
    expect(id).not.toBe('X')
    const c = w.courses.get(id) as unknown as Record<string, unknown>
    expect(c.title).toBe('Ok')
    for (const rec of [
      c,
      ...w.sources.list({ courseId: id }),
      ...w.fiches.list({ courseId: id }),
      ...w.cards.list({ courseId: id }),
    ] as unknown as Record<string, unknown>[]) {
      expect(rec.deletedAt).toBeUndefined()
      expect(rec.purgedAt).toBeUndefined()
      expect(rec.evil).toBeUndefined()
      expect(rec.id).not.toBe('X')
    }
    const [f] = w.fiches.list({ courseId: id })
    expect(f?.keyPoints).toEqual([{ text: 'k' }])
    expect(w.cards.list({ courseId: id }).length).toBe(1)
  })
})

function nested() {
  const w = ws()
  const course = w.courses.create({ title: 'Law' })
  const contracts = w.sections.create({ courseId: course, name: 'Contracts/Deals', examDate: '2027-02-01' })
  const formation = w.sections.create({ courseId: course, parentId: contracts, name: 'CON' })
  const torts = w.sections.create({ courseId: course, name: 'Torts. ' })
  const src = w.sources.create({ courseId: course, sectionId: formation, kind: 'note', title: 'Offer' })
  w.text({ id: src, field: 'body' }).insert(0, 'An offer.')
  w.sources.create({ courseId: course, kind: 'note', title: 'Intro' })
  const fiche = w.fiches.create({ courseId: course, sectionId: contracts, title: 'Deal', sourceIds: [src] })
  const card = w.cards.create({ courseId: course, sectionId: formation, kind: 'basic', ficheId: fiche })
  w.text({ id: card, field: 'front' }).insert(0, 'Q')
  w.text({ id: card, field: 'back' }).insert(0, 'A')
  const rootCard = w.cards.create({ courseId: course, kind: 'basic' })
  w.text({ id: rootCard, field: 'front' }).insert(0, 'R')
  w.text({ id: rootCard, field: 'back' }).insert(0, 'S')
  return { w, course, contracts, formation, torts, src, fiche, card }
}

describe('subsets', () => {
  test('readable export: one sanitised folder per subset, items in their own folder only', () => {
    const { w } = nested()
    expect([...exportMarkdown(w).keys()].sort()).toEqual([
      'Law/Contracts Deals/_CON/Offer.md',
      'Law/Contracts Deals/_CON/cards.csv',
      'Law/Contracts Deals/fiches/Deal.md',
      'Law/Intro.md',
      'Law/cards.csv',
    ])
    expect(exportMarkdown(w).get('Law/Contracts Deals/_CON/cards.csv')).toBe('front,back,tags\r\nQ,A,\r\n')
  })

  test('a subset folder never collides with a file or the fiches folder', () => {
    const w = ws()
    const course = w.courses.create({ title: 'C' })
    const sub = w.sections.create({ courseId: course, name: 'fiches' })
    w.fiches.create({ courseId: course, title: 'F' })
    w.fiches.create({ courseId: course, sectionId: sub, title: 'G' })
    expect([...exportMarkdown(w).keys()].sort()).toEqual(['C/fiches (2)/fiches/G.md', 'C/fiches/F.md'])
  })

  test('safeName covers every filesystem', () => {
    expect(safeName('nul', 'f')).toBe('_nul')
    expect(safeName('Com1.txt', 'f')).toBe('_Com1.txt')
    expect(safeName('end. . ', 'f')).toBe('end')
    expect(safeName('a\u007fb', 'f')).toBe('a b')
    expect(safeName('é'.repeat(200), 'f')).toHaveLength(120)
    expect(safeName('...', 'f')).toBe('f')
  })

  test('mirror: moving a subset writes the new folder and reports the old files as stale', async () => {
    const { w, formation, torts } = nested()
    const store = memoryRemote({ bucket: new MemoryBucket() })
    expect((await writeMirror(w, store)).written).toBe(5)
    w.sections.move(formation, torts)
    const res = await writeMirror(w, store)
    expect(res.written).toBe(2)
    expect(res.stale).toEqual(['mirror/Law/Contracts Deals/_CON/Offer.md', 'mirror/Law/Contracts Deals/_CON/cards.csv'])
    expect(await store.get({ key: 'mirror/Law/Contracts Deals/_CON/Offer.md' })).not.toBeNull()
    expect(await store.get({ key: 'mirror/Law/Torts/_CON/Offer.md' })).not.toBeNull()
  })

  test('course package carries the tree with fresh ids and remapped parents', () => {
    const { w, course, contracts, formation, torts, card } = nested()
    const bytes = exportCourse(w, course)
    expect(readCoursePackage(bytes).sections).toEqual([
      { ref: 't0', name: 'Contracts/Deals', examDate: '2027-02-01' },
      { ref: 't1', parentRef: 't0', name: 'CON' },
      { ref: 't2', name: 'Torts. ' },
    ])
    const other = ws(9)
    const id = importCourse(other, bytes)
    expect(exportMarkdown(other)).toEqual(exportMarkdown(w))
    const secs = other.sections.list({ courseId: id })
    expect(secs.map((s) => s.name).sort()).toEqual(['CON', 'Contracts/Deals', 'Torts. '])
    for (const old of [contracts, formation, torts]) expect(secs.map((s) => s.id)).not.toContain(old)
    const newContracts = secs.find((s) => s.name === 'Contracts/Deals')
    const newFormation = secs.find((s) => s.name === 'CON')
    expect(newFormation?.parentId).toBe(newContracts?.id as string)
    expect(newContracts?.examDate).toBe('2027-02-01')
    const [k] = other.cards
      .list({ courseId: id })
      .filter((c) => other.text({ id: c.id, field: 'front' }).toString() === 'Q')
    expect(k?.sectionId).toBe(newFormation?.id as string)
    expect(k?.id).not.toBe(card)
  })

  test('course package: a broken tree is rejected with a typed error, nothing imported', () => {
    const pack = (sections: unknown, cards: unknown[] = []) =>
      zipSync({
        'course.json': new TextEncoder().encode(
          JSON.stringify({
            format: 'cursus-course/1',
            course: { title: 'T' },
            sections,
            sources: [],
            fiches: [],
            cards,
          }),
        ),
      })
    const w = ws()
    const issue = (bytes: Uint8Array) => {
      try {
        importCourse(w, bytes)
      } catch (e) {
        if (e instanceof CourseTreeError) return [e.issue, e.ref]
        throw e
      }
      return null
    }
    expect(
      issue(
        pack([
          { ref: 'a', parentRef: 'b', name: 'A' },
          { ref: 'b', parentRef: 'a', name: 'B' },
        ]),
      ),
    ).toEqual(['cycle', 'a'])
    expect(issue(pack([{ ref: 'a', parentRef: 'a', name: 'A' }]))).toEqual(['cycle', 'a'])
    expect(issue(pack([{ ref: 'a', parentRef: 'zz', name: 'A' }]))).toEqual(['unknownParent', 'a'])
    expect(
      issue(
        pack([
          { ref: 'a', name: 'A' },
          { ref: 'a', name: 'B' },
        ]),
      ),
    ).toEqual(['duplicate', 'a'])
    expect(issue(pack([], [{ kind: 'basic', sectionRef: 'x', front: 'q', back: 'a' }]))).toEqual([
      'unknownSection',
      'x',
    ])
    expect(() => readCoursePackage(pack([{ ref: 'a', name: 'A', examDate: 'soon' }]))).toThrow(CoursePackageError)
    expect(new CourseTreeError('cycle', 'a')).toBeInstanceOf(CoursePackageError)
    expect(w.courses.list()).toHaveLength(0)
    expect(w.sections.list()).toHaveLength(0)
  })

  test('course package: sections are whitelisted and older packages without a tree still import', () => {
    const w = ws()
    const json = {
      format: 'cursus-course/1',
      course: { title: 'T' },
      sections: [{ ref: 'a', name: 'A', id: 'X', deletedAt: 1, courseId: 'evil', evil: 1 }],
      sources: [],
      fiches: [],
      cards: [],
    }
    const id = importCourse(w, zipSync({ 'course.json': new TextEncoder().encode(JSON.stringify(json)) }))
    const [s] = w.sections.list({ courseId: id }) as unknown as Record<string, unknown>[]
    expect(s?.id).not.toBe('X')
    expect(s?.courseId).toBe(id)
    expect(s?.deletedAt).toBeUndefined()
    expect(s?.evil).toBeUndefined()
    const { sections: _, ...old } = json
    const legacy = importCourse(w, zipSync({ 'course.json': new TextEncoder().encode(JSON.stringify(old)) }))
    expect(w.sections.list({ courseId: legacy })).toHaveLength(0)
  })

  test('CSV/TSV import into a chosen subset', () => {
    const { w, course, torts, formation } = nested()
    expect(importCards(w, course, 'a\tb\nc\td\n', torts)).toEqual({ created: 2, skipped: 0 })
    const inTorts = w.cards.list({ courseId: course }).filter((c) => c.sectionId === torts)
    expect(inTorts).toHaveLength(2)
    const other = w.courses.create({ title: 'Other' })
    expect(() => importCards(w, other, 'a\tb\n', formation)).toThrow(CsvTargetError)
    expect(() => importCards(w, course, 'a\tb\n', 'nope')).toThrow(CsvTargetError)
    w.sections.trash(torts)
    expect(() => importCards(w, course, 'a\tb\n', torts)).toThrow(CsvTargetError)
    expect(w.cards.list({ courseId: other })).toHaveLength(0)
  })

  test('course package: an import failing after the subsets are created leaves nothing behind', () => {
    const { w, course } = nested()
    const bytes = exportCourse(w, course)
    const other = ws(11)
    const create = other.cards.create.bind(other.cards)
    other.cards.create = () => {
      throw new Error('disk full')
    }
    expect(() => importCourse(other, bytes)).toThrow('disk full')
    expect(other.courses.list()).toHaveLength(0)
    expect(other.sections.list()).toHaveLength(0)
    expect(other.sources.list()).toHaveLength(0)
    other.cards.create = create
    expect(exportMarkdown(other)).toEqual(new Map())
  })
})
