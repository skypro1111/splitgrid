import { describe, expect, it } from 'vitest';
import { normalizeBrowserInput } from './browser-url';

describe('normalizeBrowserInput', () => {
  it('keeps http(s), file and about:blank as they are', () => {
    expect(normalizeBrowserInput('http://localhost:3000/login')).toBe('http://localhost:3000/login');
    expect(normalizeBrowserInput('  https://splitgrid.dev ')).toBe('https://splitgrid.dev');
    expect(normalizeBrowserInput('file:///tmp/a.html')).toBe('file:///tmp/a.html');
    expect(normalizeBrowserInput('about:blank')).toBe('about:blank');
  });

  it('turns an absolute POSIX path into a file URL, escaping each segment', () => {
    expect(normalizeBrowserInput('/Users/me/site/index.html')).toBe('file:///Users/me/site/index.html');
    expect(normalizeBrowserInput('/Users/me/My Drive/plan #2.html')).toBe('file:///Users/me/My%20Drive/plan%20%232.html');
  });

  it('turns Windows drive and UNC paths into file URLs', () => {
    expect(normalizeBrowserInput('C:\\work\\site\\index.html')).toBe('file:///C:/work/site/index.html');
    expect(normalizeBrowserInput('d:/a b/x.html')).toBe('file:///d:/a%20b/x.html');
    expect(normalizeBrowserInput('\\\\wsl.localhost\\Ubuntu\\home\\me\\x.html')).toBe('file://wsl.localhost/Ubuntu/home/me/x.html');
  });

  it('gives scheme-less local hosts and IP addresses http://', () => {
    expect(normalizeBrowserInput('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeBrowserInput('localhost')).toBe('http://localhost');
    expect(normalizeBrowserInput('127.0.0.1:8000/plans/x.html')).toBe('http://127.0.0.1:8000/plans/x.html');
    expect(normalizeBrowserInput('0.0.0.0:3000')).toBe('http://0.0.0.0:3000');
    expect(normalizeBrowserInput('[::1]:8080')).toBe('http://[::1]:8080');
    expect(normalizeBrowserInput('192.168.1.20:8080')).toBe('http://192.168.1.20:8080');
  });

  it('gives a bare domain https:// and searches everything else', () => {
    expect(normalizeBrowserInput('splitgrid.dev/docs')).toBe('https://splitgrid.dev/docs');
    expect(normalizeBrowserInput('electron webview file url')).toBe('https://www.google.com/search?q=electron%20webview%20file%20url');
    expect(normalizeBrowserInput('javascript:alert(1)')).toBe('https://www.google.com/search?q=javascript%3Aalert(1)');
  });

  it('returns empty for blank input', () => {
    expect(normalizeBrowserInput('   ')).toBe('');
  });
});
