import { combinePresetAndAppleSplashScreens, defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

// Icons, maskable icons and iOS splash screens, generated from the logo at build time.
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: combinePresetAndAppleSplashScreens(minimal2023Preset, {
    padding: 0.35,
    resizeOptions: { background: '#f2f4f7', fit: 'contain' },
    darkResizeOptions: { background: '#0b0d12', fit: 'contain' },
    linkMediaOptions: { log: true, addMediaScreen: true, xhtml: false },
  }),
  images: ['public/logo.svg'],
})
