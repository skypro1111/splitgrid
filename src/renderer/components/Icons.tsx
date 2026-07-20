import React from 'react';

interface IconProps {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}

export const SplitHorizontalIcon: React.FC<IconProps> = ({ size = 14, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none" style={style}>
    <rect x="48" y="48" width="160" height="160" rx="8" stroke={color} strokeWidth="16" />
    <line x1="128" y1="48" x2="128" y2="208" stroke={color} strokeWidth="16" />
  </svg>
);

export const SplitVerticalIcon: React.FC<IconProps> = ({ size = 14, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none" style={style}>
    <rect x="48" y="48" width="160" height="160" rx="8" stroke={color} strokeWidth="16" />
    <line x1="48" y1="128" x2="208" y2="128" stroke={color} strokeWidth="16" />
  </svg>
);

export const SidebarIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none" style={style}>
    <rect x="32" y="48" width="192" height="160" rx="8" stroke={color} strokeWidth="16" />
    <line x1="96" y1="48" x2="96" y2="208" stroke={color} strokeWidth="16" />
  </svg>
);

export const NewFileIcon: React.FC<IconProps> = ({ size = 14, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={style}>
    <path d="M3 1h6.5L13 4.5V15H3V1z" stroke={color} strokeWidth="1.2" />
    <path d="M9.5 1v3.5H13" stroke={color} strokeWidth="1.2" />
    <line x1="8" y1="7" x2="8" y2="13" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    <line x1="5" y1="10" x2="11" y2="10" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

export const NewFolderIcon: React.FC<IconProps> = ({ size = 14, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={style}>
    <path d="M1.5 2.5h4.3l1.2 1.5h7.5v10h-13z" stroke={color} strokeWidth="1.2" fill="none" />
    <line x1="8" y1="6.5" x2="8" y2="11.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    <line x1="5.5" y1="9" x2="10.5" y2="9" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

export const RefreshIcon: React.FC<IconProps> = ({ size = 14, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={style}>
    <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    <path d="M8 0.5v4h4" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

export const CollapseAllIcon: React.FC<IconProps> = ({ size = 14, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={style}>
    <path d="M3 8l5-4v8z" fill={color} />
    <line x1="9" y1="4" x2="14" y2="4" stroke={color} strokeWidth="1.2" />
    <line x1="9" y1="8" x2="14" y2="8" stroke={color} strokeWidth="1.2" />
    <line x1="9" y1="12" x2="14" y2="12" stroke={color} strokeWidth="1.2" />
  </svg>
);

export const PlusSquareIcon: React.FC<IconProps> = ({ size = 14, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none" style={style}>
    <rect x="48" y="48" width="160" height="160" rx="8" stroke={color} strokeWidth="16" />
    <line x1="128" y1="96" x2="128" y2="160" stroke={color} strokeWidth="16" strokeLinecap="round" />
    <line x1="96" y1="128" x2="160" y2="128" stroke={color} strokeWidth="16" strokeLinecap="round" />
  </svg>
);

export const GearIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// Notes — a sheet with text lines (sidebar workspace notes).
export const NotesIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8M8 17h6" />
  </svg>
);

// Checklist — a checkbox with a tick over list rows (sidebar workspace todos).
export const ChecklistIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M3.5 5.5l1.2 1.2 2.3-2.4" />
    <path d="M4 12h.01M4 18h.01" />
  </svg>
);

// Ports — a network plug/connector (terminal's listening ports).
export const PortsIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <rect x="6" y="9" width="12" height="11" rx="2" />
    <path d="M9 9V6a3 3 0 0 1 6 0v3" />
    <path d="M9 13v3M15 13v3" />
  </svg>
);

export const ActivityIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
);

// Globe — used to jump to the browser a running agent opened (bound browser).
export const GlobeIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

/* ============ SQL Tree Icons ============ */

export const SqlServerIcon: React.FC<IconProps> = ({ size = 14, color = '#888' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="3" y="1" width="10" height="4.5" rx="1" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.12} />
    <rect x="3" y="5.5" width="10" height="4.5" rx="0" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.08} />
    <rect x="3" y="10" width="10" height="4.5" rx="1" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.05} />
    <circle cx="11" cy="3.2" r="0.9" fill="#4EC9B0" />
    <circle cx="11" cy="7.7" r="0.9" fill="#4EC9B0" />
    <circle cx="11" cy="12.2" r="0.9" fill={color} fillOpacity={0.4} />
  </svg>
);

export const SqlPostgresIcon: React.FC<IconProps> = ({ size = 14, color = '#336791' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <ellipse cx="8" cy="4" rx="5" ry="2.5" fill={color} fillOpacity={0.25} stroke={color} strokeWidth="0.9" />
    <path d="M3 4v8c0 1.38 2.24 2.5 5 2.5s5-1.12 5-2.5V4" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.1} />
    <ellipse cx="8" cy="8" rx="5" ry="2" stroke={color} strokeWidth="0.5" strokeOpacity={0.3} fill="none" />
  </svg>
);

export const SqlSchemaIcon: React.FC<IconProps> = ({ size = 14, color = '#D7BA7D' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <path d="M2 4.5h12v8a1 1 0 01-1 1H3a1 1 0 01-1-1v-8z" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.1} />
    <path d="M2 4.5l2-2.5h8l2 2.5" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.15} />
    <line x1="2" y1="7.5" x2="14" y2="7.5" stroke={color} strokeWidth="0.5" strokeOpacity={0.4} />
  </svg>
);

export const SqlSchemasGroupIcon: React.FC<IconProps> = ({ size = 14, color = '#D7BA7D' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="3" y="1" width="10" height="4" rx="0.8" stroke={color} strokeWidth="0.8" fill={color} fillOpacity={0.12} />
    <rect x="3" y="6" width="10" height="4" rx="0.8" stroke={color} strokeWidth="0.8" fill={color} fillOpacity={0.12} />
    <rect x="3" y="11" width="10" height="4" rx="0.8" stroke={color} strokeWidth="0.8" fill={color} fillOpacity={0.12} />
  </svg>
);

export const SqlTableIcon: React.FC<IconProps> = ({ size = 14, color = '#4EC9B0' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke={color} strokeWidth="0.9" />
    <rect x="1.5" y="2" width="13" height="3.5" rx="1.5" fill={color} fillOpacity={0.25} stroke="none" />
    <line x1="1.5" y1="5.5" x2="14.5" y2="5.5" stroke={color} strokeWidth="0.9" />
    <line x1="6" y1="5.5" x2="6" y2="14" stroke={color} strokeWidth="0.5" strokeOpacity={0.4} />
    <line x1="1.5" y1="9" x2="14.5" y2="9" stroke={color} strokeWidth="0.4" strokeOpacity={0.3} />
    <line x1="1.5" y1="11.5" x2="14.5" y2="11.5" stroke={color} strokeWidth="0.4" strokeOpacity={0.3} />
  </svg>
);

export const SqlViewIcon: React.FC<IconProps> = ({ size = 14, color = '#569CD6' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke={color} strokeWidth="0.9" />
    <rect x="1.5" y="2" width="13" height="3.5" rx="1.5" fill={color} fillOpacity={0.25} stroke="none" />
    <line x1="1.5" y1="5.5" x2="14.5" y2="5.5" stroke={color} strokeWidth="0.9" />
    <path d="M4.5 10.5C5.5 8.5 10.5 8.5 11.5 10.5C10.5 12.5 5.5 12.5 4.5 10.5Z" stroke={color} strokeWidth="0.8" fill="none" />
    <circle cx="8" cy="10.5" r="1" fill={color} fillOpacity={0.6} />
  </svg>
);

export const SqlMatViewIcon: React.FC<IconProps> = ({ size = 14, color = '#569CD6' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.08} />
    <rect x="1.5" y="2" width="13" height="3.5" rx="1.5" fill={color} fillOpacity={0.3} stroke="none" />
    <line x1="1.5" y1="5.5" x2="14.5" y2="5.5" stroke={color} strokeWidth="0.9" />
    <line x1="6" y1="5.5" x2="6" y2="14" stroke={color} strokeWidth="0.5" strokeOpacity={0.4} />
    <line x1="1.5" y1="9" x2="14.5" y2="9" stroke={color} strokeWidth="0.4" strokeOpacity={0.3} />
    <line x1="1.5" y1="11.5" x2="14.5" y2="11.5" stroke={color} strokeWidth="0.4" strokeOpacity={0.3} />
  </svg>
);

export const SqlForeignTableIcon: React.FC<IconProps> = ({ size = 14, color = '#4EC9B0' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="2" width="11" height="12" rx="1.5" stroke={color} strokeWidth="0.9" />
    <rect x="1.5" y="2" width="11" height="3.5" rx="1.5" fill={color} fillOpacity={0.2} stroke="none" />
    <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" stroke={color} strokeWidth="0.9" />
    <path d="M11 9l3 0M12.5 7.5l1.5 1.5-1.5 1.5" stroke={color} strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SqlFunctionIcon: React.FC<IconProps> = ({ size = 14, color = '#C586C0' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.1} />
    <path d="M7 12C7 12 6.2 12 6.2 10.5V8.8H5M6.2 8.8V5.5C6.2 4 7 4 7 4M6.2 8.8H5M6.2 8.8H8M9 8L11 5M9 5L11 8" stroke={color} strokeWidth="0.9" strokeLinecap="round" />
  </svg>
);

export const SqlProcedureIcon: React.FC<IconProps> = ({ size = 14, color = '#CE9178' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.1} />
    <circle cx="8" cy="8" r="3.5" stroke={color} strokeWidth="0.8" fill="none" />
    <circle cx="8" cy="8" r="1.2" fill={color} fillOpacity={0.5} />
    <line x1="8" y1="1.5" x2="8" y2="4.5" stroke={color} strokeWidth="0.8" />
    <line x1="8" y1="11.5" x2="8" y2="14.5" stroke={color} strokeWidth="0.8" />
    <line x1="1.5" y1="8" x2="4.5" y2="8" stroke={color} strokeWidth="0.8" />
    <line x1="11.5" y1="8" x2="14.5" y2="8" stroke={color} strokeWidth="0.8" />
  </svg>
);

export const SqlSequenceIcon: React.FC<IconProps> = ({ size = 14, color = '#DCDCAA' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.08} />
    <path d="M5 4.5h6M5 8h4M5 11.5h5" stroke={color} strokeWidth="1" strokeLinecap="round" />
    <circle cx="3.5" cy="4.5" r="0.7" fill={color} />
    <circle cx="3.5" cy="8" r="0.7" fill={color} />
    <circle cx="3.5" cy="11.5" r="0.7" fill={color} />
  </svg>
);

export const SqlTypeIcon: React.FC<IconProps> = ({ size = 14, color = '#4FC1FF' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke={color} strokeWidth="0.9" fill={color} fillOpacity={0.08} />
    <path d="M4 11L6 5M6 5L8 8M10 11L12 5" stroke={color} strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 5h6" stroke={color} strokeWidth="0.9" strokeLinecap="round" />
  </svg>
);

export const SqlColumnIcon: React.FC<IconProps> = ({ size = 14, color = '#9CDCFE' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <rect x="3" y="2.5" width="10" height="11" rx="1.5" stroke={color} strokeWidth="0.9" />
    <line x1="3" y1="6" x2="13" y2="6" stroke={color} strokeWidth="0.7" />
    <line x1="3" y1="10" x2="13" y2="10" stroke={color} strokeWidth="0.7" />
  </svg>
);

export const SqlIndexIcon: React.FC<IconProps> = ({ size = 14, color = '#DCDCAA' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <path d="M4 3h8M4 6h8M4 9h5M4 12h5" stroke={color} strokeWidth="0.9" strokeLinecap="round" />
    <circle cx="11.5" cy="11.5" r="2" stroke={color} strokeWidth="0.9" />
    <line x1="13" y1="13" x2="14.2" y2="14.2" stroke={color} strokeWidth="0.9" strokeLinecap="round" />
  </svg>
);

export const SqlKeyIcon: React.FC<IconProps> = ({ size = 14, color = '#D7BA7D' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <circle cx="5" cy="6" r="3" stroke={color} strokeWidth="0.9" />
    <path d="M7 8l5 5M10.5 11.5l1.5-1.5M12 13l1.5-1.5" stroke={color} strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SqlTriggerIcon: React.FC<IconProps> = ({ size = 14, color = '#F1A55C' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <path d="M8.5 1.5L3 9h4l-0.5 5.5L13 7H8.5l0-5.5z" stroke={color} strokeWidth="0.9" strokeLinejoin="round" fill={color} fillOpacity={0.08} />
  </svg>
);

export const SqlForeignServerIcon: React.FC<IconProps> = ({ size = 14, color = '#888' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
    <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="0.9" />
    <ellipse cx="8" cy="8" rx="2.5" ry="5.5" stroke={color} strokeWidth="0.7" />
    <line x1="2.5" y1="8" x2="13.5" y2="8" stroke={color} strokeWidth="0.5" />
    <line x1="3.5" y1="5" x2="12.5" y2="5" stroke={color} strokeWidth="0.4" />
    <line x1="3.5" y1="11" x2="12.5" y2="11" stroke={color} strokeWidth="0.4" />
  </svg>
);
