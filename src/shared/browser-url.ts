// ─── Browser pane address normalization (pure) ───────────────────────────────
// Turns whatever was typed into the address bar — or passed to
// `splitgrid-browser open` — into the URL the <webview> loads. Shared by both so
// an agent and the user get the same answer for the same input.
//
// Local files and dev servers are first-class: an absolute path (POSIX, Windows
// drive or UNC) becomes a file:// URL and a scheme-less localhost / IP address
// gets http://. Without this they fell through to a Google search, which is why
// agents rendered local HTML with headless Chrome instead of the pane.

const KEEP_SCHEME = /^(https?|file):\/\//i;
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:[/?#]|$)/i;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/;
const DOMAIN = /^[\w-]+\.\w{2,}/;

// Percent-encode each path segment, leaving the separators alone. A file name
// with '#', '?' or '%' must not be read as a fragment, query or escape.
function encodePath(segments: string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

export function normalizeBrowserInput(input: string): string {
  const text = input.trim();
  if (!text) return '';

  if (KEEP_SCHEME.test(text) || /^about:blank$/i.test(text)) return text;

  // Windows UNC (\\server\share\…, also \\wsl.localhost\Distro\… from wslpath -w).
  if (/^\\\\[^\\]+\\/.test(text)) {
    const [host, ...rest] = text.slice(2).split('\\');
    return `file://${host}/${encodePath(rest)}`;
  }
  // Windows drive path: C:\dir\file.html or C:/dir/file.html.
  if (/^[a-z]:[\\/]/i.test(text)) {
    const [drive, ...rest] = text.split(/[\\/]/);
    return `file:///${drive}/${encodePath(rest)}`;
  }
  // POSIX absolute path.
  if (text.startsWith('/')) return `file://${encodePath(text.split('/'))}`;

  if (!text.includes(' ')) {
    if (LOCAL_HOST.test(text) || IPV4_HOST.test(text)) return `http://${text}`;
    if (DOMAIN.test(text)) return `https://${text}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
