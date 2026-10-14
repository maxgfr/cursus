import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { pwaOptions } from './pwa.config.ts'

const base = process.env.VITE_BASE ?? '/cursus/'

export default defineConfig({
  base,
  plugins: [react(), VitePWA(pwaOptions(base))],
  build: { target: 'es2022' },
})
