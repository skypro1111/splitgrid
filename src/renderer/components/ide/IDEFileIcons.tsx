import React from 'react';

interface IconProps {
  size?: number;
}

// Folder icon (neutral VSCode-like)
export const FolderIcon: React.FC<IconProps & { open?: boolean }> = ({ size = 16, open }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    {open ? (
      <path d="M1.5 13h12l1-5H6L4.5 3H1.5v10z" fill="#7a797a" opacity={0.9} />
    ) : (
      <path d="M1.5 2.5h4l1.5 1.5h7v9h-13v-10.5z" fill="#7a797a" opacity={0.85} />
    )}
  </svg>
);

const GlyphIcon: React.FC<IconProps & { glyph: string; color: string }> = ({
  size = 16,
  glyph,
  color,
}) => (
  <span
    style={{
      display: 'inline-flex',
      width: size,
      height: size,
      alignItems: 'center',
      justifyContent: 'center',
      color,
      fontSize: Math.max(10, Math.round(size * 0.78)),
      fontWeight: 700,
      lineHeight: 1,
      fontFamily: 'var(--font-sans)',
      userSelect: 'none',
    }}
  >
    {glyph}
  </span>
);

const GenericFile: React.FC<IconProps> = ({ size = 16 }) => (
  <GlyphIcon size={size} glyph="." color="#6e7781" />
);

type GlyphDef = { glyph: string; color: string };

const ICON_MAP: Record<string, GlyphDef> = {
  ts: { glyph: "{}", color: "#87c3ff" },
  tsx: { glyph: "<>", color: "#87c3ff" },
  js: { glyph: "{}", color: "#f0c674" },
  jsx: { glyph: "<>", color: "#f0c674" },
  json: { glyph: "{}", color: "#f0c674" },
  md: { glyph: "v", color: "#75d3ba" },
  html: { glyph: "<>", color: "#efb080" },
  css: { glyph: "#", color: "#87c3ff" },
  scss: { glyph: "#", color: "#aaa0fa" },
  less: { glyph: "#", color: "#aaa0fa" },
  xml: { glyph: "<>", color: "#efb080" },
  yaml: { glyph: "!", color: "#e567dc" },
  yml: { glyph: "!", color: "#e567dc" },
  py: { glyph: "py", color: "#87c3ff" },
  rs: { glyph: "rs", color: "#efb080" },
  go: { glyph: "go", color: "#75d3ba" },
  java: { glyph: "j", color: "#efb080" },
  rb: { glyph: "rb", color: "#e567dc" },
  sh: { glyph: "$", color: "#a8cc7c" },
  bash: { glyph: "$", color: "#a8cc7c" },
  zsh: { glyph: "$", color: "#a8cc7c" },
  sql: { glyph: "db", color: "#f0c674" },
  swift: { glyph: "sw", color: "#efb080" },
  c: { glyph: "c", color: "#87c3ff" },
  cpp: { glyph: "c+", color: "#87c3ff" },
  h: { glyph: "h", color: "#87c3ff" },
  hpp: { glyph: "h+", color: "#87c3ff" },
  php: { glyph: "php", color: "#aaa0fa" },
  svg: { glyph: "svg", color: "#f0c674" },
  png: { glyph: "img", color: "#aaa0fa" },
  jpg: { glyph: "img", color: "#aaa0fa" },
  jpeg: { glyph: "img", color: "#aaa0fa" },
  gif: { glyph: "img", color: "#aaa0fa" },
  webp: { glyph: "img", color: "#aaa0fa" },
  ico: { glyph: "img", color: "#aaa0fa" },
  toml: { glyph: "{}", color: "#6e7781" },
  ini: { glyph: "{}", color: "#6e7781" },
  env: { glyph: "{}", color: "#6e7781" },
  editorconfig: { glyph: "{}", color: "#6e7781" },
  txt: { glyph: "-", color: "#6e7781" },
  log: { glyph: "-", color: "#6e7781" },
  lock: { glyph: "*", color: "#6e7781" },
};

const FILENAME_ICON_MAP: Record<string, GlyphDef> = {
  '.gitignore': { glyph: "g", color: "#efb080" },
  '.gitmodules': { glyph: "g", color: "#efb080" },
  '.gitattributes': { glyph: "g", color: "#efb080" },
  'dockerfile': { glyph: "dk", color: "#87c3ff" },
  'makefile': { glyph: "mk", color: "#6e7781" },
  'license': { glyph: "-", color: "#6e7781" },
  'readme.md': { glyph: "v", color: "#75d3ba" },
};

export const FileTypeIcon: React.FC<{ filename: string; isDirectory: boolean; isExpanded?: boolean; size?: number }> = ({
  filename,
  isDirectory,
  isExpanded,
  size = 16,
}) => {
  if (isDirectory) {
    return <FolderIcon size={size} open={isExpanded} />;
  }

  const lower = filename.toLowerCase();

  // Check full filename
  const filenameIcon = FILENAME_ICON_MAP[lower];
  if (filenameIcon) {
    return <GlyphIcon size={size} glyph={filenameIcon.glyph} color={filenameIcon.color} />;
  }

  // Check extension
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  const extIcon = ICON_MAP[ext];
  if (extIcon) {
    return <GlyphIcon size={size} glyph={extIcon.glyph} color={extIcon.color} />;
  }

  return <GenericFile size={size} />;
};
