import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../../app/routes.ts'
import { type Runtime, useRuntime } from '../../app/workspaceContext.tsx'
import { secretsVault } from '../../core/storage/secrets'
import { noteError } from '../../screens/settings/Diagnostic/recent.ts'

/**
 * Whether this device has an AI model ready to call, for the whole app: without one, nothing of the AI shows
 * (the AI settings and the welcome's AI step aside). While the settings are read it is `loading`, and nothing
 * of the AI shows either, so nothing appears and then vanishes.
 *
 * The settings are read in their own chunk (`aiSettings.ts`, without the AI SDK), once at launch and again
 * whenever they change (`aiSettingsChanged`) or the AI settings are left (a download ended, a model removed).
 */

export type AiReadiness = 'loading' | 'missing' | 'ready'

let status: AiReadiness = 'loading'
let runtime: Runtime | null = null
let checking: Promise<AiReadiness> | null = null
let generation = 0
const listeners = new Set<() => void>()
const changeListeners = new Set<() => void>()

function publish(next: AiReadiness): void {
  if (next === status) return
  status = next
  for (const fn of [...listeners]) fn()
}

async function read(rt: Runtime): Promise<AiReadiness> {
  try {
    const m = await import('../../screens/Understand/shared/aiSettings.ts')
    return m.statusOf(await m.loadAiSettings(secretsVault(rt.store))).status
  } catch (e) {
    noteError('ai.readiness', e)
    return 'missing'
  }
}

function check(rt: Runtime): Promise<AiReadiness> {
  generation += 1
  const mine = generation
  runtime = rt
  // The status on screen stays until the new reading is in: a check never makes the AI blink.
  const reading = read(rt).then((s) => {
    if (mine === generation) publish(s)
    return s
  })
  checking = reading
  return reading
}

/** Whether a model is ready on this device, read once (and again after a change). */
export function aiReadiness(rt: Runtime): Promise<AiReadiness> {
  if (checking && runtime === rt) return checking
  return check(rt)
}

/** Whether a model is ready now, waiting for the first reading when it is not in yet. */
export async function isAiReady(rt: Runtime): Promise<boolean> {
  return (await aiReadiness(rt)) === 'ready'
}

/** The AI settings changed on this device (saved, a key, a test): read them again, and tell who follows them. */
export function aiSettingsChanged(): void {
  if (runtime) void check(runtime)
  for (const fn of [...changeListeners]) fn()
}

/** Calls `fn` whenever the AI settings change on this device; returns the unsubscribe. */
export function onAiSettingsChange(fn: () => void): () => void {
  changeListeners.add(fn)
  return () => {
    changeListeners.delete(fn)
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
const current = () => status

/** `loading`, `missing` or `ready`: the AI's state for the screens. */
export function useAiReadiness(): AiReadiness {
  return useSyncExternalStore(subscribe, current)
}

/** True only when a model is ready: every AI entry point outside the AI settings shows on this alone. */
export function useAiReady(): boolean {
  return useAiReadiness() === 'ready'
}

const inAiSettings = (location: string) => location.startsWith(paths.settingsAi)

/** Reads the AI settings at launch and again on leaving the AI settings. Mounted once, inside the workspace. */
export function AiReadinessCheck(): null {
  const rt = useRuntime()
  const [location] = useLocation()
  const wasInSettings = useRef(inAiSettings(location))
  useEffect(() => {
    void aiReadiness(rt)
  }, [rt])
  useEffect(() => {
    const now = inAiSettings(location)
    if (wasInSettings.current && !now) void check(rt)
    wasInSettings.current = now
  }, [location, rt])
  return null
}
