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

  const closeTab = useCallback((tabId: string) => {
    dirtySet.current.delete(tabId);
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      const next = prev.filter(t => t.id !== tabId);
      if (tabId === activeTabId) {
        // Activate neighbour
        if (next.length === 0) {
          setActiveTabId(null);
        } else {
          const newIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[newIdx].id);
        }
      }
      return next;
    });
  }, [activeTabId]);

  const closeOtherTabs = useCallback((tabId: string) => {
    setTabs(prev => prev.filter(t => t.id === tabId));
    setActiveTabId(tabId);
  }, []);

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
    dirtySet.current.clear();
  }, []);

  const closeTabsToRight = useCallback((tabId: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      const next = prev.slice(0, idx + 1);
      if (activeTabId && !next.find(t => t.id === activeTabId)) {
        setActiveTabId(tabId);
      }
      return next;
    });
  }, [activeTabId]);

  const pinTab = useCallback((tabId: string) => {
    setTabs(prev =>
      prev.map(t => (t.id === tabId ? { ...t, isPreview: false } : t))
    );
  }, []);

  const setDirty = useCallback((tabId: string, dirty: boolean) => {
    if (dirty) dirtySet.current.add(tabId);
    else dirtySet.current.delete(tabId);
    setTabs(prev =>
      prev.map(t => (t.id === tabId ? { ...t, isDirty: dirty } : t))
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
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    pinTab,
    setActiveTabId,
    setDirty,
    reorderTab,
  };
}
