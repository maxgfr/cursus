/// <reference types="vite/client" />

// Emits pdf.js character maps and standard fonts into the build so the service worker precaches them
// (no inlining: the precache glob picks them up by extension). Maps file name → served URL.
const cmaps = import.meta.glob('../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
}) as Record<string, string>
const fonts = import.meta.glob('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
}) as Record<string, string>

function byName(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k.slice(k.lastIndexOf('/') + 1), v]))
}

export const pdfCMaps = byName(cmaps)
export const pdfStandardFonts = byName(fonts)
