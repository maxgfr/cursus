import type { VitePWAOptions } from 'vite-plugin-pwa'

/** Service worker, precache and manifest. Nothing from the network is cached at runtime: no API responses. */
export function pwaOptions(base: string): Partial<VitePWAOptions> {
  return {
    registerType: 'prompt',
    injectRegister: false,
    base,
    pwaAssets: { config: true, overrideManifestIcons: true },
    manifest: {
      id: './',
      name: 'Cursus',
      short_name: 'Cursus',
      description: 'Learn your courses with spaced repetition. Local-first.',
      start_url: './',
      scope: './',
      display: 'standalone',
      display_override: ['window-controls-overlay', 'standalone'],
      theme_color: '#f2f4f7',
      background_color: '#f2f4f7',
      launch_handler: { client_mode: 'focus-existing' },
      shortcuts: [
        { name: 'Today', url: './#/' },
        { name: 'Review', url: './#/review' },
        { name: 'Courses', url: './#/courses' },
      ],
      file_handlers: [{ action: './', accept: { 'application/x-cursus': ['.cursus'] } }],
    },
    workbox: {
      // App shell, workers (pdf.js, sql.js wasm), KaTeX fonts, pdf.js cmaps and standard fonts.
      globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,woff,woff2,ttf,wasm,bcmap,pfb}'],
      // Splash screens are fetched by iOS at install, not by the app: no point precaching ~50 large PNGs.
      globIgnores: ['**/apple-splash-*.png'],
      maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      navigateFallback: 'index.html',
      navigateFallbackDenylist: [/oauth-callback/],
      cleanupOutdatedCaches: true,
      runtimeCaching: [],
    },
  }
}
