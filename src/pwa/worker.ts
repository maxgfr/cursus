/** The part of `navigator.serviceWorker` the probe uses. A blocked `register` may resolve with nothing. */
export interface WorkerContainer {
  register(url: string, options?: RegistrationOptions): Promise<unknown>
}

/**
 * Registers the worker script and says whether this page can run service workers at all. Resolves false where
 * they are absent (no container) or blocked: `register` resolving without a registration (as Playwright's
 * `serviceWorkers: 'block'` does) or refused with a `SecurityError` (service workers disabled by the browser).
 * Rejects on a real registration failure (the script missing or failing to evaluate, the network).
 */
export async function probeWorker(
  container: WorkerContainer | undefined,
  url: string,
  scope: string,
): Promise<boolean> {
  if (!container) return false
  try {
    return (await container.register(url, { scope })) != null
  } catch (e) {
    if (e instanceof DOMException && e.name === 'SecurityError') return false
    throw e
  }
}
