/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MODE: string
  readonly BASE_URL: string
  readonly VITE_API_URL?: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_WS_URL?: string
  /** The release version, set at build time from RELAYHALL_RELEASE_VERSION (docs/build-identity.md). */
  readonly VITE_RELAYHALL_RELEASE_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
