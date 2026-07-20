import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import './renderer/monacoEnvironment';
import App from './renderer/App';
import { EnvironmentPicker } from './renderer/components/EnvironmentPicker';
import './renderer/styles/global.css';

const renderBootError = (message: string) => {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = '';
  const el = document.createElement('div');
  el.style.padding = '16px';
  el.style.color = '#f14c4c';
  el.style.fontFamily = 'var(--font-sans, sans-serif)';
  el.style.whiteSpace = 'pre-wrap';
  el.textContent = `Renderer crashed:\n${message}`;
  root.appendChild(el);
};

// "ResizeObserver loop limit exceeded" / "…completed with undelivered
// notifications" are BENIGN spec-defined warnings (the observer just defers
// delivery to the next frame). Browsers still surface them to window.onerror.
// Monaco's automaticLayout and our resizable splitters fire them routinely, so
// we must NOT treat them as a fatal crash — otherwise a normal resize would nuke
// the whole UI.
const isBenignError = (message: string): boolean =>
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i.test(message);

window.addEventListener('error', (event) => {
  const message = event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.message);
  if (isBenignError(message) || isBenignError(String(event.message))) return;
  renderBootError(message);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason);
  if (isBenignError(reason)) return;
  renderBootError(reason);
});

const root = document.getElementById('root');
const mode = new URLSearchParams(window.location.search).get('mode');
const RootComponent = mode === 'env-picker' ? EnvironmentPicker : App;
if (root) {
  try {
    createRoot(root).render(createElement(RootComponent));
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    renderBootError(message);
  }
}
