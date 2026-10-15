import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSync } from '../../app/syncContext.tsx'
import { type Runtime, useRuntime } from '../../app/workspaceContext.tsx'
import type { BlobResolver } from '../../core/content/markdown'
import { blobIdsIn, makeThumbnail, thumbnails } from '../../core/content/photos'
import type { FileLoader } from '../../core/export/coursePackage'
import { blobStore } from '../../core/log/blobs'
import type { SyncEngineImpl } from '../../core/sync/engine'
import { noteError } from '../settings/Diagnostic/recent.ts'

/**
 * A stored file from this device, else from a destination ("on demand", or not synced down yet): the file is
 * fetched once and kept. Null when no destination can send it now (offline, none configured).
 */
export async function loadFile(rt: Runtime, engine: SyncEngineImpl | null, id: string): Promise<Blob | null> {
  const blobs = blobStore(rt.store)
  const local = await blobs.get(id)
  if (local !== null || engine === null) return local
  return (await engine.fetchBlob(id)) ? blobs.get(id) : null
}

/** `loadFile` bound to this device's runtime and sync engine. */
export function useFileLoader(): FileLoader {
  const rt = useRuntime()
  const { engine } = useSync()
  return useCallback((id: string) => loadFile(rt, engine, id), [rt, engine])
}

export type FileState =
  | { phase: 'loading' }
  | { phase: 'fetching' }
  | { phase: 'ready'; blob: Blob }
  | { phase: 'missing' }

/**
 * One photo's file for the viewer: local at once, else downloaded on open (the "on demand" promise). `retry`
 * asks the destinations again.
 */
export function usePhotoFile(blobId: string): { state: FileState; retry: () => void } {
  const rt = useRuntime()
  const { engine } = useSync()
  const [state, setState] = useState<FileState>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    void attempt
    let live = true
    setState({ phase: 'loading' })
    const blobs = blobStore(rt.store)
    blobs
      .get(blobId)
      .then(async (local) => {
        if (local !== null) return local
        if (engine === null) return null
        if (live) setState({ phase: 'fetching' })
        return (await engine.fetchBlob(blobId)) ? blobs.get(blobId) : null
      })
      .then(
        (blob) => {
          if (live) setState(blob === null ? { phase: 'missing' } : { phase: 'ready', blob })
        },
        (e: unknown) => {
          noteError('photos.open', e)
          if (live) setState({ phase: 'missing' })
        },
      )
    return () => {
      live = false
    }
  }, [rt, engine, blobId, attempt])
  return { state, retry: () => setAttempt((n) => n + 1) }
}

/** An object URL for a blob, revoked when the blob changes or the component leaves. */
export function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => (blob === null ? null : URL.createObjectURL(blob)), [blob])
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url)
    },
    [url],
  )
  return url
}

/** What a gallery tile shows: a thumbnail URL, or why there is none. */
export type Thumb = { kind: 'ready'; url: string } | { kind: 'remote' } | { kind: 'failed' }

/**
 * Thumbnails of local photos, computed once and kept in this device's cache (never synced). A photo whose file
 * is not here yet reads `remote`; such tiles are tried again whenever the sync status changes.
 */
export function useThumbs(blobIds: readonly string[]): ReadonlyMap<string, Thumb> {
  const rt = useRuntime()
  const { status } = useSync()
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, Thumb>>(new Map())
  const urls = useRef(new Map<string, string>())
  const key = blobIds.join(',')

  useEffect(() => {
    void status
    let live = true
    const ids = key === '' ? [] : key.split(',')
    const blobs = blobStore(rt.store)
    const run = async () => {
      for (const id of ids) {
        if (!live) return
        const known = urls.current.get(id)
        if (known !== undefined) {
          setThumbs((m) => (m.get(id)?.kind === 'ready' ? m : new Map(m).set(id, { kind: 'ready', url: known })))
          continue
        }
        let next: Thumb
        try {
          let thumb = await thumbnails.get(id)
          if (thumb === null) {
            const file = await blobs.get(id)
            if (file !== null) {
              thumb = await makeThumbnail(file)
              await thumbnails.put(id, thumb)
            }
          }
          if (thumb === null) next = { kind: 'remote' }
          else {
            const url = URL.createObjectURL(thumb)
            urls.current.set(id, url)
            next = { kind: 'ready', url }
          }
        } catch (e) {
          noteError('photos.thumbnail', e)
          next = { kind: 'failed' }
        }
        if (live) setThumbs((m) => new Map(m).set(id, next))
      }
    }
    void run()
    return () => {
      live = false
    }
  }, [rt, key, status])

  useEffect(() => {
    const kept = urls.current
    return () => {
      for (const url of kept.values()) URL.revokeObjectURL(url)
      kept.clear()
    }
  }, [])
  return thumbs
}

/**
 * Resolves the `cursus-blob:` images (and sounds) of a Markdown text to object URLs for rendering, fetching the
 * files a destination still holds. Undefined until the text names no file or every file has an answer.
 */
export function useBlobResolver(markdown: string): BlobResolver | undefined {
  const rt = useRuntime()
  const { engine } = useSync()
  const ids = useMemo(() => blobIdsIn(markdown), [markdown])
  const key = ids.join(',')
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    if (key === '') return
    let live = true
    const made: string[] = []
    const run = async () => {
      const next = new Map<string, string>()
      for (const id of key.split(',')) {
        try {
          const blob = await loadFile(rt, engine, id)
          if (!live) return
          if (blob === null) continue
          const url = URL.createObjectURL(blob)
          made.push(url)
          next.set(id, url)
        } catch (e) {
          noteError('photos.resolve', e)
        }
      }
      if (live) setUrls(next)
    }
    void run()
    return () => {
      live = false
      for (const url of made) URL.revokeObjectURL(url)
    }
  }, [rt, engine, key])

  return useMemo(() => (urls.size === 0 ? undefined : (sha: string) => urls.get(sha) ?? null), [urls])
}
