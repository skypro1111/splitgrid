import React from 'react';
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentQuestionRequest,
} from '../../../shared/agent-types';

// The one thing in the pane that BLOCKS the agent: a tool waiting on approval,
// or a clarifying question. It is docked right above the composer rather than
// appended to the transcript — scrolled out of view, it reads as a hung session.

function actionBtn(color: string, filled = false): React.CSSProperties {
  return {
    padding: '5px 11px',
    borderRadius: 6,
    border: `1px solid ${color}`,
    background: filled ? color : 'transparent',
    color: filled ? '#fff' : color,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

const Shell: React.FC<{ accent: string; label: string; children: React.ReactNode }> = ({
  accent,
  label,
  children,
}) => (
  <div
    style={{
      flexShrink: 0,
      minWidth: 0,
      borderTop: '1px solid var(--border)',
      borderLeft: `2px solid ${accent}`,
      background: 'var(--bg-surface)',
      padding: '8px 12px',
      maxHeight: '45%',
      overflowY: 'auto',
    }}
  >
    <div
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.6,
        color: accent,
        marginBottom: 5,
      }}
    >
      {label}
    </div>
    {children}
  </div>
);

export const AgentPendingAction: React.FC<{
  approval: AgentApprovalRequest | null;
  question: AgentQuestionRequest | null;
  onApproval: (decision: AgentApprovalDecision) => void;
  onQuestion: (answers: Record<string, string> | null) => void;
}> = ({ approval, question, onApproval, onQuestion }) => {
  if (question) {
    return (
      <Shell accent="var(--accent-blue)" label={question.header.toUpperCase()}>
        <div style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 8, lineHeight: 1.5 }}>
          {question.question}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {question.options.map((option) => (
            <button
              key={option.label}
              onClick={() => onQuestion({ [question.question]: option.label })}
              style={{
                textAlign: 'left',
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontSize: 12,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent-blue)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            >
              {option.label}
              {option.description && (
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> — {option.description}</span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={() => onQuestion(null)}
          style={{
            marginTop: 6,
            padding: '3px 0',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </Shell>
    );
  }

  if (!approval) return null;

  return (
    <Shell accent="var(--accent-yellow)" label="PERMISSION REQUEST">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>
          {approval.toolName}
        </span>
        <span
          title={approval.summary}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {approval.summary}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={() => onApproval('allow')} style={actionBtn('var(--accent-green)', true)}>
          Allow once
        </button>
        {approval.canAllowForSession && (
          <button
            onClick={() => onApproval('allowForSession')}
            style={actionBtn('var(--accent-blue)')}
          >
            Allow for session
          </button>
        )}
        <button onClick={() => onApproval('deny')} style={actionBtn('var(--accent-red)')}>
          Deny
        </button>
      </div>
    </Shell>
  );
};
