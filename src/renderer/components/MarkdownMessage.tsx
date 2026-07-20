import React, { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Flatten a React children tree into its plain text — used to grab the raw
// source of a fenced code block for the copy button.
function childrenToText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(childrenToText).join('');
  if (React.isValidElement(node)) return childrenToText((node.props as { children?: React.ReactNode }).children);
  return '';
}

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    window.electronAPI.clipboardWriteText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => { /* ignore */ });
  }, [text]);
  return (
    <button
      onClick={copy}
      title="Copy"
      style={{
        position: 'absolute', top: 6, right: 6, padding: '3px 8px', fontSize: 11,
        borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer',
        background: 'var(--bg-surface)', color: 'var(--text-secondary)', opacity: 0.85,
      }}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
};

// A fenced code block: monospace panel with a hover-independent copy button.
const Pre: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const text = childrenToText(children).replace(/\n$/, '');
  return (
    <div style={{ position: 'relative', margin: '8px 0' }}>
      <CopyButton text={text} />
      <pre style={{
        margin: 0, padding: '12px 12px', paddingTop: 14, borderRadius: 8, overflow: 'auto',
        background: 'var(--bg-primary)', border: '1px solid var(--border)',
        fontSize: 12.5, lineHeight: 1.5, fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        color: 'var(--text-primary)',
      }}>
        {children}
      </pre>
    </div>
  );
};

const mdComponents = {
  pre: Pre as never,
  code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
    // Inline code (no language class, not wrapped by our <pre>) gets a subtle chip.
    const isFenced = !!className && /language-/.test(className);
    if (isFenced) return <code className={className} {...props}>{children}</code>;
    return (
      <code style={{
        background: 'var(--bg-hover)', borderRadius: 4, padding: '1px 5px',
        fontSize: '0.9em', fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      }} {...props}>{children}</code>
    );
  },
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      onClick={(e) => { e.preventDefault(); if (href) window.electronAPI.openExternal(href); }}
      style={{ color: 'var(--accent, #5b9dd9)', cursor: 'pointer' }}
    >{children}</a>
  ),
};

/** Renders an assistant message as GitHub-flavored markdown with copyable code
 * blocks. The whole answer is selectable too, so the user copies exactly what
 * they need. */
export const MarkdownMessage: React.FC<{ content: string }> = ({ content }) => (
  <div className="qc-md" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)', minWidth: 0 }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {content}
    </ReactMarkdown>
  </div>
);
