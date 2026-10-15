import { useSyncExternalStore } from 'react'
import { splitHash } from './hashPath.ts'

/**
 * In-app navigation over the hash: `#/path?query`. The query lives in the hash, so it belongs to one history entry
 * and never rides along on the next screen (the page's own `?locale=` stays untouched).
 *
 * Every entry the app creates records the screen that opened it (`from`), or `null` when it was opened directly (a
 * deep link, a reload in a new tab, the palette). In-app Back pops the entry when it has an opener, so the browser's
 * back button and the app's Back agree; without one it replaces the entry with the screen's logical parent.
 */

const KEY = 'cursusNav'

interface Tag {
  /** The in-app screen (path and query) this entry was opened from, or `null` when opened directly. */
  from: string | null
}

type Bag = Record<string, unknown>

export interface NavigateOptions {
  replace?: boolean
  state?: unknown
  /** Opened from global navigation (the palette): Back then goes to the screen's logical parent. */
  direct?: boolean
}

export interface BackOptions {
  /** Merged into the history state of the screen landed on (e.g. a notice offering Undo). */
  state?: object
  /** The screen to land on instead of the opener, written over the opener's entry (the opener is gone). */
  to?: string
}

const hasWindow = typeof window !== 'undefined' && typeof history !== 'undefined'

/** The current hash route, `/path` or `/path?query`. */
function here(): string {
  const { path, search } = splitHash(location.hash)
  return search ? `${path}?${search}` : path
}

function bag(state: unknown): Bag {
  return typeof state === 'object' && state !== null ? { ...(state as Bag) } : {}
}

function tagOf(state: unknown): Tag | undefined {
  const tag = bag(state)[KEY]
  if (typeof tag !== 'object' || tag === null) return undefined
  const from = (tag as { from?: unknown }).from
  return { from: typeof from === 'string' ? from : null }
}

function tagged(state: unknown, tag: Tag): Bag {
  return { ...bag(state), [KEY]: tag }
}

function href(to: string): string {
  const { path, search } = splitHash(to)
  return search ? `#${path}?${search}` : `#${path}`
}

let listeners: (() => void)[] = []
/** What a pending in-app Back writes onto the entry it lands on. */
let pending: BackOptions | null = null

function notify() {
  for (const listener of listeners) listener()
}

/** What an entry keeps when the student comes back to it: its opener, its kept values, its session; not a notice. */
function kept(state: unknown): Bag {
  return Object.fromEntries(Object.entries(bag(state)).filter(([k]) => k.startsWith('cursus') || k === 'session'))
}

/**
 * A pending in-app Back is also kept for the page: after a reload, the entry it pops to belongs to an earlier load of
 * the page, which the browser loads again.
 */
const PENDING = 'cursus:pendingBack'

function keepPending(options: BackOptions | null) {
  try {
    if (options === null) sessionStorage.removeItem(PENDING)
    else sessionStorage.setItem(PENDING, JSON.stringify(options))
  } catch {
    // Storage refused (private mode): the Back still pops, without its notice.
  }
}

function storedPending(): BackOptions | null {
  try {
    const raw = sessionStorage.getItem(PENDING)
    sessionStorage.removeItem(PENDING)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { state, to } = parsed as { state?: unknown; to?: unknown }
    return {
      ...(typeof state === 'object' && state !== null ? { state } : {}),
      ...(typeof to === 'string' ? { to } : {}),
    }
  } catch {
    return null
  }
}

/** Lands a pending in-app Back on the entry now showing: its notice, or the screen that replaces a gone opener. */
function land(options: BackOptions | null) {
  const { state, to } = options ?? {}
  history.replaceState({ ...kept(history.state), ...state }, '', to === undefined ? location.href : href(to))
}

function onHistory(e: Event) {
  if (e.type === 'popstate' && tagOf(history.state) !== undefined) {
    // A notice (Undo, Saved) is shown once: coming back to the entry, only what a pending in-app Back brings shows.
    land(pending)
    pending = null
    keepPending(null)
  }
  // An entry the browser made on its own (an address typed, a plain `#/…` link): opened directly.
  if (tagOf(history.state) === undefined) history.replaceState(tagged(history.state, { from: null }), '', location.href)
  notify()
}

/** Old links put the screen's query before the hash (`?course=…#/quiz`): it moves into the hash. */
const APP_KEYS = ['course', 'section', 'session', 'setup', 'page', 'q']

function adoptLegacyQuery() {
  const url = new URL(location.href)
  const moved = new URLSearchParams()
  for (const key of APP_KEYS) {
    const value = url.searchParams.get(key)
    if (value === null) continue
    moved.set(key, value)
    url.searchParams.delete(key)
  }
  if (moved.size === 0) return
  const { path, search } = splitHash(url.hash)
  url.hash = search ? `${path}?${search}` : `${path}?${moved.toString()}`
  history.replaceState(history.state, '', url.href)
}

if (hasWindow) {
  adoptLegacyQuery()
  if (tagOf(history.state) === undefined) history.replaceState(tagged(history.state, { from: null }), '', location.href)
  else {
    const left = storedPending()
    if (left !== null) land(left)
  }
  addEventListener('popstate', onHistory)
  addEventListener('hashchange', onHistory)
}

/** Goes to an in-app route; a push records the current screen as its opener, a replace keeps the entry's opener. */
export function navigate(to: string, options: NavigateOptions = {}): void {
  const current = tagOf(history.state)
  const from = options.direct ? null : options.replace ? (current?.from ?? null) : here()
  const state = tagged(options.state ?? null, { from })
  if (options.replace) history.replaceState(state, '', href(to))
  else history.pushState(state, '', href(to))
  notify()
}

/** Whether in-app Back can pop this entry: it was opened from another screen of the app. */
export function canGoBack(): boolean {
  return hasWindow && (tagOf(history.state)?.from ?? null) !== null
}

/** The path (without query) of the screen this entry was opened from, if any. */
export function openerPath(): string | null {
  const from = hasWindow ? (tagOf(history.state)?.from ?? null) : null
  return from === null ? null : splitHash(from).path
}

/**
 * For an item that lives in a course place (a card, a source): when it was opened from a course place that is no
 * longer its own (moved since, or that place went to the trash), Back lands on its place instead, over the opener.
 */
export function backHome(home: string): BackOptions {
  const opener = openerPath()
  return opener?.startsWith('/course/') && opener !== splitHash(home).path ? { to: home } : {}
}

/**
 * Back to where the student came from: pops this entry when it has an opener, else replaces it with `parent` (the
 * screen's logical parent). Never pushes, so the browser's back button agrees.
 */
export function goBack(parent: string, options: BackOptions = {}): void {
  if (canGoBack()) pop(options)
  else navigate(options.to ?? parent, { replace: true, state: options.state ?? null })
}

function pop(options: BackOptions) {
  // A second press while the first is on its way would go back one screen too far.
  if (pending !== null) return
  pending = options
  keepPending(options)
  history.back()
  // The browser may refuse to go back (nothing before this entry after all): Back works again shortly.
  setTimeout(() => {
    if (pending === options) {
      pending = null
      keepPending(null)
    }
  }, 1000)
}

/**
 * Leaves this screen for `target` (after an action that ends it, e.g. a trash): pops when the opener is `target`,
 * else replaces this entry, so no dead screen stays in the history and Back never loops back here.
 */
export function leaveTo(target: string, state?: object): void {
  if (openerPath() === splitHash(target).path && canGoBack()) pop(state === undefined ? {} : { state })
  else navigate(target, { replace: true, state: state ?? null })
}

/** Drops a notice from the current entry's state (an Undo offered once), keeping its opener. */
export function clearEntryState(): void {
  history.replaceState(tagged(kept(history.state), tagOf(history.state) ?? { from: null }), '', location.href)
}

/** Rewrites the current entry's query (e.g. a search typed), keeping its state and opener. */
export function replaceQuery(query: string): void {
  const { path } = splitHash(location.hash)
  history.replaceState(history.state, '', href(query ? `${path}?${query}` : path))
  notify()
}

function subscribe(listener: () => void) {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

const currentPath = () => splitHash(location.hash).path
const currentSearch = () => splitHash(location.hash).search

/** wouter location hook: the hash path, without its query. */
export function useNavLocation(): [string, typeof navigate] {
  return [useSyncExternalStore(subscribe, currentPath, () => '/'), navigate]
}
useNavLocation.hrefs = (to: string) => href(to)

/** wouter search hook: the query carried in the hash. */
export function useNavSearch(): string {
  return useSyncExternalStore(subscribe, currentSearch, () => '')
}

/** A value kept in the current history entry (e.g. a result on screen), found again when the student comes back. */
export function readEntry<T>(key: string): T | undefined {
  if (!hasWindow) return undefined
  const value = bag(history.state)[key]
  return value === undefined ? undefined : (value as T)
}

/** Keeps a value in the current history entry, beside its opener and notices. */
export function writeEntry(key: string, value: unknown): void {
  try {
    history.replaceState({ ...bag(history.state), [key]: value }, '', location.href)
  } catch {
    // Too large for the browser's history: the screen works the same, without finding it again.
  }
}
