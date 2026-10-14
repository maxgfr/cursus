import type { VitePWAOptions } from 'vite-plugin-pwa'

// Skeleton: completed in S-026.
export function pwaOptions(base: string): Partial<VitePWAOptions> {
  return {
    registerType: 'prompt',
    injectRegister: false,
    base,
    manifest: {
      name: 'Cursus',
      short_name: 'Cursus',
      start_url: base,
      scope: base,
      display: 'standalone',
      theme_color: '#ffffff',
      background_color: '#ffffff',
    },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
  }
}
