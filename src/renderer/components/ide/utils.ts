const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', md: 'markdown', html: 'html', css: 'css', scss: 'scss',
  less: 'less', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
  kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', php: 'php', sql: 'sql', sh: 'shell', bash: 'shell',
  zsh: 'shell', fish: 'shell', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  lua: 'lua', r: 'r', dart: 'dart', graphql: 'graphql', proto: 'protobuf',
  dockerfile: 'dockerfile', makefile: 'makefile', ini: 'ini', env: 'ini',
  vue: 'html', svelte: 'html', txt: 'plaintext', log: 'plaintext',
  gitignore: 'plaintext', editorconfig: 'ini', lock: 'json',
};

const FILENAME_LANG: Record<string, string> = {
  Dockerfile: 'dockerfile', Makefile: 'makefile', Rakefile: 'ruby',
  Gemfile: 'ruby', Vagrantfile: 'ruby', CMakeLists: 'cmake',
};

export function detectLanguage(filename: string): string {
  const base = filename.split('/').pop() || filename;
  const nameNoExt = base.split('.')[0];
  if (FILENAME_LANG[nameNoExt]) return FILENAME_LANG[nameNoExt];
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] || 'plaintext';
}

// Paths come from the OS via the main process, so they use '/' on macOS/Linux
// and '\' on Windows (incl. drive prefixes like C:\). These helpers must accept
// BOTH separators — splitting only on '/' returns the whole Windows path as the
// "basename" and breaks tree move/rename/new-file on Windows.
function isWindowsPath(p: string): boolean {
  return /\\/.test(p) || /^[A-Za-z]:/.test(p);
}

export function basename(p: string): string {
  const s = p.replace(/[/\\]+$/, '');
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || '';
}

export function dirname(p: string): string {
  const s = p.replace(/[/\\]+$/, '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (idx < 0) return isWindowsPath(s) ? s : '/';
  const head = s.slice(0, idx);
  if (head === '') return '/';                  // "/foo" -> "/"
  if (/^[A-Za-z]:$/.test(head)) return head + '\\'; // "C:\foo" -> "C:\"
  return head;
}

export function joinPath(...parts: string[]): string {
  const present = parts.filter(Boolean);
  const sep = present.some(isWindowsPath) ? '\\' : '/';
  const joined = present.join(sep);
  // Collapse duplicate separators (preserving content), then drop a trailing one.
  const collapsed = joined.replace(/[/\\]+/g, sep);
  return collapsed.replace(/[/\\]+$/, '') || sep;
}

export function sortEntries(
  entries: { name: string; isDirectory: boolean }[],
): { name: string; isDirectory: boolean }[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}
