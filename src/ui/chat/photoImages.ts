import { useCallback } from 'react'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { renderPhoto } from '../../core/content/photos'
import { getPhoto } from '../../core/model/photos'
import { useFileLoader } from '../../screens/Photos/files.ts'
import { type PhotoImages, PhotoUnavailableError } from './studyRun.ts'

/** A photo's pixels as sent to a model: fetched if it is not here yet, turned upright, at most 1024 px. */
export function usePhotoImages(): PhotoImages {
  const ws = useWorkspace()
  const loadFile = useFileLoader()
  return useCallback(
    async (id: string) => {
      const photo = getPhoto(ws, id)
      const file = photo ? await loadFile(photo.blobId) : null
      if (!photo || !file) throw new PhotoUnavailableError(id)
      const small = await renderPhoto(file, photo.rotation, 1024)
      return { bytes: new Uint8Array(await small.arrayBuffer()), mediaType: small.type || 'image/jpeg' }
    },
    [ws, loadFile],
  )
}
