import { createAppleSplashScreens, defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

/** Logo width on iOS launch screens, in points: the same on every iPhone and iPad, in both orientations. */
const SPLASH_LOGO_PT = 120
/** The logo's blue: as the background of the touch and maskable icons, its rounded corners vanish (full bleed). */
const LOGO_BLUE = '#2563eb'

const splash = createAppleSplashScreens({
  resizeOptions: { background: '#f2f4f7', fit: 'contain' },
  darkResizeOptions: { background: '#0b0d12', fit: 'contain' },
  linkMediaOptions: { log: true, addMediaScreen: true, xhtml: false },
})

// Icons, maskable icons and iOS splash screens, generated from the logo at build time.
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    // iOS rounds the touch icon itself: a full-bleed square, not the rounded logo inside a white frame.
    apple: { sizes: [180], padding: 0.1, resizeOptions: { background: LOGO_BLUE, fit: 'contain' } },
    // The mark stays well inside the 80 % safe zone whatever mask the platform applies.
    maskable: { sizes: [512], padding: 0.2, resizeOptions: { background: LOGO_BLUE, fit: 'contain' } },
    appleSplashScreens: {
      ...splash,
      // The generator sizes the logo as a fraction of the short side: one fraction per device keeps it fixed in points.
      sizes: splash.sizes.map((size) => ({
        ...size,
        padding: 1 - (SPLASH_LOGO_PT * size.scaleFactor) / Math.min(size.width, size.height),
      })),
    },
  },
  images: ['public/logo.svg'],
})
