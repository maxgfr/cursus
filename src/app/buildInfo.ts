import { FORMAT_VERSION, READABLE_VERSIONS } from '../core/log/codec'

// Replaced at build time by vite.config.ts `define`; absent under `bun test`, hence the fallbacks below.
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_BUILT_AT__: string
declare const __APP_FORMAT__: { writes: number; reads: readonly number[] }

/** This build, as Settings › General shows it. */
export interface BuildInfo {
  /** The release (semantic-release tag), or `0.0.0-dev` for an untagged build. */
  version: string
  /** Short git commit, or `dev` when the build had no git. */
  commit: string
  /** When it was built (ISO); outside a build (tests), when this module loaded. */
  builtAt: string
  /** The sync envelope version this build writes, and those it reads. */
  format: { writes: number; reads: readonly number[] }
}

export const BUILD: BuildInfo = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev',
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev',
  builtAt: typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : new Date().toISOString(),
  format: typeof __APP_FORMAT__ === 'object' ? __APP_FORMAT__ : { writes: FORMAT_VERSION, reads: READABLE_VERSIONS },
}
