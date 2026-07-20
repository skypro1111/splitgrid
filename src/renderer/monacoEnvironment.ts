// @ts-nocheck — Vite resolves `new URL(..., import.meta.url)` for the Monaco
// workers at build time, but the project's tsconfig is `module: commonjs` (the
// main process needs it), under which tsc rejects import.meta. This file is pure
// worker-URL wiring with no logic to typecheck, so we opt it out rather than
// split the tsconfig.
declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (_moduleId: string, label: string) => Worker;
    };
  }
}

const monacoEnv = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') {
      return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' });
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), { type: 'module' });
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), { type: 'module' });
    }
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' });
    }
    return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' });
  },
};

self.MonacoEnvironment = monacoEnv;
window.MonacoEnvironment = monacoEnv;

export {};
