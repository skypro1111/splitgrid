import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  detectComposerTrigger,
  rankSlashCommands,
  replaceTextRange,
  type ComposerTrigger,
} from './composerTrigger';
import type { CompleteItem } from './AgentCompleteMenu';
import type { AgentSlashCommand } from '../../../shared/agent-types';

// Composer autocomplete for the Claude Code pane: `/` commands from the running
// CLI, `@` paths from the project. Both are consumed by the CLI itself once the
// prompt is sent — this only builds the list and rewrites the draft.

/** The file walk is per keystroke otherwise; typing shouldn't re-rank a repo. */
const PATH_SEARCH_DEBOUNCE_MS = 90;
const MAX_ITEMS = 10;

export interface UseComposerComplete {
  items: CompleteItem[];
  activeIndex: number;
  title: string;
  open: boolean;
  setActiveIndex: (index: number) => void;
  /** Feed every draft/caret change so the trigger stays current. */
  sync: (text: string, caret: number) => void;
  /** Apply a suggestion; returns the new draft + caret for the textarea. */
  accept: (item: CompleteItem) => { text: string; cursor: number } | null;
  /** Dismiss until the trigger changes (Escape). */
  dismiss: () => void;
}

export function useComposerComplete(input: {
  draft: string;
  cwd: string;
  slashCommands: AgentSlashCommand[];
}): UseComposerComplete {
  const { draft, cwd, slashCommands } = input;
  const [caret, setCaret] = useState(0);
  const [pathItems, setPathItems] = useState<CompleteItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  const trigger: ComposerTrigger | null = useMemo(
    () => detectComposerTrigger(draft, caret),
    [draft, caret],
  );
  const triggerKey = trigger ? `${trigger.kind}:${trigger.rangeStart}:${trigger.query}` : null;

  const commandItems = useMemo<CompleteItem[]>(() => {
    if (trigger?.kind !== 'slash-command') return [];
    return rankSlashCommands(slashCommands, trigger.query, MAX_ITEMS).map((command) => ({
      value: `/${command.name}`,
      label: `/${command.name}`,
      ...(command.argumentHint ? { hint: command.argumentHint } : {}),
      description: command.description,
    }));
  }, [trigger?.kind, trigger?.query, slashCommands]);

  // Path lookups go to the main process, so they are debounced and guarded
  // against out-of-order replies.
  const requestId = useRef(0);
  useEffect(() => {
    if (trigger?.kind !== 'path' || !cwd) {
      setPathItems([]);
      return;
    }
    const query = trigger.query;
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      window.electronAPI
        .agentSearchFiles(cwd, query, MAX_ITEMS)
        .then((files) => {
          if (id !== requestId.current) return;
          setPathItems(
            files.map((file) => ({
              value: `@${file.path}`,
              label: file.path,
              isDirectory: file.isDirectory,
            })),
          );
        })
        .catch(() => {
          if (id === requestId.current) setPathItems([]);
        });
    }, PATH_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trigger?.kind, trigger?.query, cwd]);

  const items = trigger?.kind === 'slash-command' ? commandItems : pathItems;

  // A new trigger position/query is a new menu: reset the highlight and clear
  // an earlier dismissal so Escape only hides the menu it was pressed on.
  useEffect(() => {
    setActiveIndex(0);
  }, [triggerKey]);

  const open = Boolean(trigger) && items.length > 0 && dismissedAt !== triggerKey;

  const sync = useCallback((text: string, nextCaret: number) => {
    setCaret(Math.max(0, Math.min(text.length, nextCaret)));
  }, []);

  const accept = useCallback(
    (item: CompleteItem) => {
      if (!trigger) return null;
      // A directory is a step, not a destination: keep the caret inside the
      // token so the next segment can be typed straight away.
      const replacement = item.isDirectory ? `${item.value}/` : `${item.value} `;
      return replaceTextRange(draft, trigger.rangeStart, trigger.rangeEnd, replacement);
    },
    [draft, trigger],
  );

  const dismiss = useCallback(() => {
    setDismissedAt(triggerKey);
  }, [triggerKey]);

  return {
    items: open ? items : [],
    activeIndex: Math.min(activeIndex, Math.max(0, items.length - 1)),
    title: trigger?.kind === 'slash-command' ? 'COMMANDS' : 'FILES',
    open,
    setActiveIndex,
    sync,
    accept,
    dismiss,
  };
}
