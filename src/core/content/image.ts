export const MAX_IMAGE_DIMENSION = 2048
export const MAX_IMAGE_INPUT_BYTES = 40 * 1024 * 1024
export const MAX_IMAGE_OUTPUT_BYTES = 8 * 1024 * 1024

export type ImageErrorKind = 'too-large' | 'unsupported' | 'decode'
export class ImageError extends Error {
  constructor(
    readonly kind: ImageErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'ImageError'
  }
}

export interface PreparedImage {
  blob: Blob
  mime: string
  width: number
  height: number
}

export interface PrepareImageOptions {
  maxDimension?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  jpegQuality?: number
}

const HEIC = /^image\/hei[cf](?:-sequence)?$/i
const HEIC_NAME = /\.(?:heic|heif)$/i
const PASSTHROUGH = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function isHeic(file: Blob): boolean {
  return HEIC.test(file.type) || (file instanceof File && HEIC_NAME.test(file.name))
}

/** Downscales to `maxDimension` px on the longest side and converts HEIC/HEIF to JPEG, on this device. */
export async function prepareImage(file: Blob, options: PrepareImageOptions = {}): Promise<PreparedImage> {
  const maxDim = options.maxDimension ?? MAX_IMAGE_DIMENSION
  const maxIn = options.maxInputBytes ?? MAX_IMAGE_INPUT_BYTES
  const maxOut = options.maxOutputBytes ?? MAX_IMAGE_OUTPUT_BYTES
  if (file.size > maxIn) throw new ImageError('too-large', `image is ${file.size} bytes, limit ${maxIn}`)
  const heic = isHeic(file)
  if (!heic && !PASSTHROUGH.has(file.type)) throw new ImageError('unsupported', `unsupported image type "${file.type}"`)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (cause) {
    throw new ImageError(heic ? 'unsupported' : 'decode', `cannot decode image: ${String(cause)}`)
  }
  try {
    const { width, height } = bitmap
    const scale = Math.min(1, maxDim / Math.max(width, height))
    if (scale === 1 && !heic && file.size <= maxOut) return { blob: file, mime: file.type, width, height }

    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new ImageError('decode', '2d canvas unavailable')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    const mime = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg'
    const blob = await canvas.convertToBlob({ type: mime, quality: options.jpegQuality ?? 0.85 })
    if (blob.size > maxOut) throw new ImageError('too-large', `encoded image is ${blob.size} bytes, limit ${maxOut}`)
    return { blob, mime: blob.type || mime, width: w, height: h }
  } finally {
    bitmap.close()
  }
}
