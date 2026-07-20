/// <reference types="vite/client" />

// Globals injected by @electron-forge/plugin-vite at build time (one pair per
// renderer entry). Declared so `tsc --noEmit` doesn't flag them in src/main.ts.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.mp3' {
  const url: string;
  export default url;
}
