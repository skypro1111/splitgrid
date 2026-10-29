import { useState, useCallback, useRef } from 'react';
import { detectLanguage, basename } from './utils';
import type { IDEContainerState } from '../../../shared/types';

export interface IDETab {
  id: string;           // absolute file path = unique key
  filePath: string;
  fileName: string;
  language: string;
  isDirty: boolean;
  isPreview: boolean;   // single-click = preview (italic), double-click = pinned
}

export function useTabs(initialState?: IDEContainerState) {
  const [tabs, setTabs] = useState<IDETab[]>(() =>
    (initialState?.tabs ?? []).map((tab) => ({
      id: tab.filePath,
      filePath: tab.filePath,
      fileName: basename(tab.filePath),
      language: detectLanguage(tab.filePath),
      isDirty: false,
      isPreview: tab.isPreview,
    }))
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    const initialActive = initialState?.activeTabId ?? null;
    if (!initialActive) return null;
    return (initialState?.tabs ?? []).some((t) => t.filePath === initialActive) ? initialActive : null;
  });
  const dirtySet = useRef(new Set<string>());

  const openFile = useCallback((filePath: string, preview = true) => {
    setTabs(prev => {
      const existing = prev.find(t => t.id === filePath);
      if (existing) {
        // If re-opening a preview tab by double-click, pin it
        if (!preview && existing.isPreview) {
          return prev.map(t =>
            t.id === filePath ? { ...t, isPreview: false } : t
          );
        }
        return prev;
      }

      // Replace existing preview tab if opening a new preview
      const newTab: IDETab = {
        id: filePath,
        filePath,
        fileName: basename(filePath),
        language: detectLanguage(filePath),
        isDirty: false,
        isPreview: preview,
      };

      if (preview) {
        const previewIdx = prev.findIndex(t => t.isPreview);
        if (previewIdx >= 0) {
          const next = [...prev];
          next[previewIdx] = newTab;
          return next;
        }
      }

      return [...prev, newTab];
    });
    setActiveTabId(filePath);
  }, []);

  // Close any set of tabs. When the active one goes, activate the tab that now
  // sits where it was (or the last one). Callers save/prompt beforehand — this
  // only drops the tabs.
  const closeTabs = useCallback((tabIds: string[]) => {
    if (tabIds.length === 0) return;
    const closing = new Set(tabIds);
    for (const id of tabIds) dirtySet.current.delete(id);
    setTabs(prev => {
      const next = prev.filter(t => !closing.has(t.id));
      setActiveTabId(active => {
        if (!active || !closing.has(active)) return active;
        if (next.length === 0) return null;
        const idx = prev.findIndex(t => t.id === active);
        const survivorsBefore = prev.slice(0, idx).filter(t => !closing.has(t.id)).length;
        return next[Math.min(survivorsBefore, next.length - 1)].id;
      });
      return next;
    });
  }, []);

  const pinTab = useCallback((tabId: string) => {
    setTabs(prev =>
      prev.map(t => (t.id === tabId ? { ...t, isPreview: false } : t))
    );
  }, []);

  const setDirty = useCallback((tabId: string, dirty: boolean) => {
    if (dirty) dirtySet.current.add(tabId);
    else dirtySet.current.delete(tabId);
    // Editing pins a preview tab (as in VS Code), so the next single-click
    // can't replace a tab that holds unsaved edits.
    setTabs(prev =>
      prev.map(t => (t.id === tabId ? { ...t, isDirty: dirty, isPreview: dirty ? false : t.isPreview } : t))
    );
  }, []);

  const reorderTab = useCallback((fromIdx: number, toIdx: number) => {
    setTabs(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) || null;

  return {
    tabs,
    activeTabId,
    activeTab,
    openFile,
    closeTabs,
    pinTab,
    setActiveTabId,
    setDirty,
    reorderTab,
  };
}
