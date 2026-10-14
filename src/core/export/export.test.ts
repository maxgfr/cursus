import { describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import * as Y from 'yjs'
import { createWorkspace } from '../model/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { MemoryBucket, memoryRemote } from '../sync/providers/memory'
import { COURSE_EXT, CoursePackageError, exportCourse, importCourse, readCoursePackage } from './coursePackage'
import { importCards, parseDelimited } from './csvImport'
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
