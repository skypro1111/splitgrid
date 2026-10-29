import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { v4 as uuidv4 } from 'uuid';
import type { WorkspaceTodo, WorkspaceTodoStatus, TodoImage } from '../../shared/types';

// Shared todo-list body used by both the per-workspace popover
// (WorkspaceItemNotesTodo) and the environment-wide popover (EnvTodoButton).
// Renders the list + add input + clear-completed; the header/shell is the
// caller's responsibility.
//
// Screenshots can be pasted into a task (into the add input, or into an item
// while editing it). The bitmap is stored by the main process under userData and
// the item keeps only the path, so an image outlives a restart and is deleted
// exactly when the task — or that one image — is deleted. Run hands the agent
// the image paths along with the text, the same convention as a file drag-drop.

// A todo cycles through these states on click; legacy items carry only the old
// `done` boolean, so derive the status from it until the next edit rewrites it.
const STATUS_ORDER: WorkspaceTodoStatus[] = ['todo', 'in_progress', 'done'];
export const STATUS_LABEL: Record<WorkspaceTodoStatus, string> = {
  todo: 'To do', in_progress: 'In progress', done: 'Done',
};

export const statusOf = (t: WorkspaceTodo): WorkspaceTodoStatus => t.status ?? (t.done ? 'done' : 'todo');
const nextStatus = (s: WorkspaceTodoStatus): WorkspaceTodoStatus =>
  STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % STATUS_ORDER.length];

// Small clickable status indicator: empty box (todo), amber dot (in progress),
// filled green check (done).
const statusBoxStyle = (status: WorkspaceTodoStatus): React.CSSProperties => {
  const accent =
    status === 'done' ? 'var(--accent-green, #15ac91)'
    : status === 'in_progress' ? 'var(--accent-amber, #e0a23a)'
    : 'var(--border)';
  return {
    flexShrink: 0, marginTop: 1, width: 16, height: 16, padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 4, cursor: 'pointer', fontSize: 10, lineHeight: 1,
    border: `1.5px solid ${accent}`,
    background: status === 'done' ? accent : 'transparent',
    color: status === 'done' ? '#0b1f1a' : accent,
  };
};

const THUMB = 46;

// Image files carried by a paste (or a drop). A screenshot copied from the OS and
// an image file copied in Finder/Explorer both arrive this way; anything else
// (plain text, a URL) yields nothing and the default paste handles it.
function imageFilesFrom(dt: DataTransfer | null): File[] {
  const out: File[] = [];
  for (const item of Array.from(dt?.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile(); // must run synchronously, inside the event
    if (file) out.push(file);
  }
  return out;
}

// Every electronAPI call in this file goes through here. A preload older than
// this bundle (a stale install, or a dev reload against an already-running main
// process) would otherwise throw a TypeError straight out of an event handler —
// and ONE unhandled renderer error replaces the entire app with the boot-error
// screen, which reads to the user as a crash. Missing image support has to
// degrade to "no thumbnail", never to that.
async function safely<T>(work: () => Promise<T | null> | undefined): Promise<T | null> {
  try {
    return (await work()) ?? null;
  } catch {
    return null;
  }
}

// Hand the bytes to main, which stores them and returns the record the todo
// keeps. A single unreadable image never drops the rest of the paste.
async function storeImages(files: File[]): Promise<TodoImage[]> {
  const stored: TodoImage[] = [];
  for (const file of files) {
    const saved = await safely(async () =>
      window.electronAPI?.todoSaveImage?.(new Uint8Array(await file.arrayBuffer())));
    if (saved) stored.push(saved);
  }
  return stored;
}

// One paste handler for both the add input and an item's editor. Text pastes are
// left to the browser; an image is stored and handed to `attach`.
//
// Chromium puts a copied screenshot in the event as an image file on all three
// platforms — but not always: some Linux apps (and TIFF-only macOS pasteboards)
// publish a bitmap the paste event never sees. So a paste carrying neither an
// image file nor text asks main to read the OS clipboard directly, which works
// everywhere. The image/text decision has to be synchronous: preventDefault
// can't wait for an await.
const pasteHandler = (attach: (images: TodoImage[]) => void) => (e: React.ClipboardEvent) => {
  const files = imageFilesFrom(e.clipboardData);
  if (files.length === 0 && e.clipboardData?.getData('text/plain')) return;
  e.preventDefault();
  const stored = files.length > 0
    ? storeImages(files)
    : safely(() => window.electronAPI?.todoSaveClipboardImage?.()).then((i) => (i ? [i] : []));
  void stored.then((images) => { if (images.length > 0) attach(images); });
};

// Best-effort removal of the files behind images that are no longer referenced.
function deleteImageFiles(images: TodoImage[] | undefined): void {
  const paths = (images ?? []).map((i) => i.path);
  if (paths.length > 0) void safely(() => window.electronAPI?.todoDeleteImages?.(paths));
}

// One stored image. The bitmap lives on disk, so the preview is fetched from main
// on mount; a file that has gone missing renders as a placeholder instead of a
// broken image.
const ImageThumb: React.FC<{
  image: TodoImage;
  onOpen: () => void;
  onRemove: () => void;
}> = ({ image, onOpen, onRemove }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    let alive = true;
    void safely(() => window.electronAPI?.todoImageData?.(image.path, THUMB * 3))
      .then((data) => { if (alive) setSrc(data); });
    return () => { alive = false; };
  }, [image.path]);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', width: THUMB, height: THUMB, flexShrink: 0,
        borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)',
        background: 'var(--bg-hover)', cursor: 'zoom-in',
      }}
    >
      {src ? (
        <img
          src={src}
          alt="Task screenshot"
          onClick={onOpen}
          title="Click to view"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div style={{
          width: '100%', height: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 14, color: 'var(--text-muted)',
        }}>🖼</div>
      )}
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove image"
          style={{
            position: 'absolute', top: 1, right: 1, width: 14, height: 14, padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', borderRadius: 3, background: 'rgba(0,0,0,0.65)',
            color: '#fff', fontSize: 11, lineHeight: 1, cursor: 'pointer',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
};

// Full-size look at one image, over the whole window (the panel itself is only
// 300px wide). Click anywhere — or Escape — to close.
const ImageLightbox: React.FC<{ image: TodoImage; onClose: () => void }> = ({ image, onClose }) => {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void safely(() => window.electronAPI?.todoImageData?.(image.path, 1600))
      .then((data) => { if (alive) setSrc(data); });
    return () => { alive = false; };
  }, [image.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9300, background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
        cursor: 'zoom-out',
      }}
    >
      {src && (
        <img
          src={src}
          alt="Task screenshot"
          style={{
            maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
            borderRadius: 6, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          }}
        />
      )}
    </div>,
    document.body,
  );
};

// A row of thumbnails under a task (or above the add input, for a task being
// composed). Renders nothing when there are no images.
const ImageStrip: React.FC<{
  images: TodoImage[];
  onOpen: (image: TodoImage) => void;
  onRemove: (image: TodoImage) => void;
  style?: React.CSSProperties;
}> = ({ images, onOpen, onRemove, style }) =>
  images.length === 0 ? null : (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, ...style }}>
      {images.map((img) => (
        <ImageThumb key={img.id} image={img} onOpen={() => onOpen(img)} onRemove={() => onRemove(img)} />
      ))}
    </div>
  );

type TodoUpdater = (todos: WorkspaceTodo[]) => WorkspaceTodo[];

interface Props {
  todos: WorkspaceTodo[];
  onUpdate: (updater: TodoUpdater) => void;
  /** When provided, each item shows a Run button: it flips the item to
   * "in progress" and hands the item's text — plus the paths of any images
   * pasted into it — to the caller (e.g. to paste into the focused terminal). */
  onRun?: (text: string, imagePaths: string[]) => void;
}

export const TodoListPanel: React.FC<Props> = ({ todos, onUpdate, onRun }) => {
  const [draft, setDraft] = useState('');
  const [draftImages, setDraftImages] = useState<TodoImage[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [preview, setPreview] = useState<TodoImage | null>(null);

  // Images pasted into the add input belong to a task that doesn't exist yet, so
  // if the panel closes before Add they'd leak files. Discard them with the draft.
  const draftImagesRef = useRef<TodoImage[]>([]);
  useEffect(() => { draftImagesRef.current = draftImages; }, [draftImages]);
  useEffect(() => () => deleteImageFiles(draftImagesRef.current), []);

  // Attach pasted images to the task being composed…
  const pasteIntoDraft = useCallback(
    pasteHandler((images) => setDraftImages((cur) => [...cur, ...images])),
    [],
  );

  // …or to an existing task, while its text is open for editing.
  const pasteIntoTodo = useCallback((id: string) => pasteHandler((images) => {
    onUpdate((list) => list.map((t) => (
      t.id === id ? { ...t, images: [...(t.images ?? []), ...images] } : t
    )));
  }), [onUpdate]);

  const removeDraftImage = useCallback((image: TodoImage) => {
    deleteImageFiles([image]);
    setDraftImages((cur) => cur.filter((i) => i.id !== image.id));
    setPreview((p) => (p?.id === image.id ? null : p));
  }, []);

  const removeTodoImage = useCallback((todoId: string, image: TodoImage) => {
    deleteImageFiles([image]);
    onUpdate((list) => list.map((t) => (
      t.id === todoId ? { ...t, images: (t.images ?? []).filter((i) => i.id !== image.id) } : t
    )));
    setPreview((p) => (p?.id === image.id ? null : p));
  }, [onUpdate]);

  // Grow a textarea to fit its content (so the editor matches the item's size
  // and wraps like the text, instead of a single-line input).
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const startEdit = useCallback((id: string, text: string) => {
    setEditingId(id);
    setEditDraft(text);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft('');
  }, []);

  // Save the edited text (no-op/cancel when blank), then leave edit mode.
  const commitEdit = useCallback((id: string) => {
    const text = editDraft.trim();
    if (text) onUpdate((list) => list.map((t) => (t.id === id ? { ...t, text } : t)));
    setEditingId(null);
    setEditDraft('');
  }, [editDraft, onUpdate]);

  // An image-only paste is a valid task too (a screenshot with no words), so the
  // draft counts as non-empty when it carries images.
  const addTodo = useCallback(() => {
    const text = draft.trim();
    if (!text && draftImages.length === 0) return;
    onUpdate((list) => [...list, {
      id: uuidv4(), text, status: 'todo', createdAt: Date.now(),
      ...(draftImages.length > 0 ? { images: draftImages } : {}),
    }]);
    setDraft('');
    setDraftImages([]);
  }, [draft, draftImages, onUpdate]);

  // Advance todo → in progress → done → todo; also drops the legacy `done` flag.
  const cycleTodo = useCallback((id: string) => {
    onUpdate((list) => list.map((t) => {
      if (t.id !== id) return t;
      const { done: _done, ...rest } = t;
      return { ...rest, status: nextStatus(statusOf(t)) };
    }));
  }, [onUpdate]);

  // Deleting the task is what finally releases its images — that is the whole
  // contract: an image lives exactly as long as the item it was pasted into.
  const deleteTodo = useCallback((id: string) => {
    deleteImageFiles(todos.find((t) => t.id === id)?.images);
    onUpdate((list) => list.filter((t) => t.id !== id));
  }, [todos, onUpdate]);

  // Mark the item in-progress and hand its text + image paths to the caller
  // (paste into the focused terminal). Also drops the legacy `done` flag.
  const runTodo = useCallback((todo: WorkspaceTodo) => {
    onUpdate((list) => list.map((t) => {
      if (t.id !== todo.id) return t;
      const { done: _done, ...rest } = t;
      return { ...rest, status: 'in_progress' };
    }));
    onRun?.(todo.text, (todo.images ?? []).map((i) => i.path));
  }, [onUpdate, onRun]);

  const clearDone = useCallback(() => {
    for (const t of todos) if (statusOf(t) === 'done') deleteImageFiles(t.images);
    onUpdate((list) => list.filter((t) => statusOf(t) !== 'done'));
  }, [todos, onUpdate]);

  return (
    <>
      <div style={{ minHeight: 180, maxHeight: 390, overflowY: 'auto' }}>
        {todos.length === 0 && (
          <div style={{ padding: '14px 12px', fontSize: '11px', color: 'var(--text-muted)' }}>
            No tasks yet. Add one below — you can paste a screenshot into it.
          </div>
        )}
        {todos.map((t) => {
          const status = statusOf(t);
          const done = status === 'done';
          return (
          <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 12px' }}>
            <button
              onClick={() => cycleTodo(t.id)}
              title={`${STATUS_LABEL[status]} — click to change status`}
              style={statusBoxStyle(status)}
            >
              {status === 'done' ? '✓' : status === 'in_progress' ? '●' : ''}
            </button>
            {/* Text (or its editor) with the item's screenshots stacked underneath. */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {editingId === t.id ? (
                <textarea
                  autoFocus
                  ref={autoGrow}
                  value={editDraft}
                  rows={1}
                  onChange={(e) => { setEditDraft(e.target.value); autoGrow(e.target); }}
                  onFocus={(e) => { autoGrow(e.target); e.target.select(); }}
                  onBlur={() => commitEdit(t.id)}
                  onPaste={pasteIntoTodo(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(t.id); }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                  }}
                  title="Paste a screenshot to attach it to this task"
                  style={{
                    width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '2px 6px', fontSize: '12px',
                    lineHeight: 1.4, background: 'var(--bg-input, var(--bg-base))', color: 'var(--text-primary)',
                    border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', fontFamily: 'inherit',
                    resize: 'none', overflow: 'hidden', wordBreak: 'break-word',
                  }}
                />
              ) : (
                <span
                  onClick={() => startEdit(t.id, t.text)}
                  title="Click to edit"
                  style={{
                    fontSize: '12px', lineHeight: 1.4, cursor: 'text', wordBreak: 'break-word',
                    color: done || !t.text ? 'var(--text-muted)' : 'var(--text-primary)',
                    textDecoration: done ? 'line-through' : 'none',
                  }}
                >
                  {/* An image-only task still needs something to click on. */}
                  {t.text || <em>Screenshot</em>}
                  {status === 'in_progress' && (
                    <span style={{
                      marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                      textTransform: 'uppercase', color: 'var(--accent-amber, #e0a23a)',
                    }}>in progress</span>
                  )}
                </span>
              )}
              <ImageStrip
                images={t.images ?? []}
                onOpen={setPreview}
                onRemove={(img) => removeTodoImage(t.id, img)}
              />
            </div>
            {editingId !== t.id && onRun && (
              <button
                onClick={() => runTodo(t)}
                title={(t.images?.length ?? 0) > 0
                  ? `Run in focused terminal (with ${t.images?.length} image${t.images?.length === 1 ? '' : 's'})`
                  : 'Run in focused terminal'}
                style={{
                  flexShrink: 0, height: 18, padding: '0 7px', lineHeight: '16px',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, fontWeight: 600,
                  borderRadius: 4, display: 'flex', alignItems: 'center', gap: 3,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-green, #15ac91)'; e.currentTarget.style.borderColor = 'var(--accent-green, #15ac91)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
              >
                <span style={{ fontSize: 8 }}>▶</span> Run
              </button>
            )}
            {editingId !== t.id && (
              <button
                onClick={() => deleteTodo(t.id)}
                title="Delete"
                style={{
                  flexShrink: 0, width: 18, height: 18, lineHeight: '16px', padding: 0,
                  border: 'none', background: 'transparent', color: 'var(--text-muted)',
                  cursor: 'pointer', fontSize: '14px', borderRadius: 4,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red, #f14c4c)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
              >
                ×
              </button>
            )}
          </div>
          );
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px' }}>
        {/* Screenshots pasted into the input, waiting to be attached on Add. */}
        <ImageStrip
          images={draftImages}
          onOpen={setPreview}
          onRemove={removeDraftImage}
          style={{ marginBottom: 6 }}
        />
        <div style={{ display: 'flex', gap: '6px' }}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={pasteIntoDraft}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTodo(); } }}
          placeholder="Add a task…  (Enter, paste an image)"
          title="Paste a screenshot to attach it to the task"
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '6px 8px', fontSize: '12px',
            background: 'var(--bg-input, var(--bg-base))', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 6, outline: 'none',
          }}
        />
        <button
          onClick={addTodo}
          disabled={!draft.trim() && draftImages.length === 0}
          style={{
            flexShrink: 0, padding: '0 10px', fontSize: '12px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--bg-hover)',
            color: 'var(--text-primary)', cursor: 'pointer',
          }}
        >
          Add
        </button>
        </div>
      </div>
      {preview && <ImageLightbox image={preview} onClose={() => setPreview(null)} />}
      {todos.some((t) => statusOf(t) === 'done') && (
        <button
          onClick={clearDone}
          style={{
            border: 'none', borderTop: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', fontSize: '11px', padding: '6px 12px',
            cursor: 'pointer', textAlign: 'left',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          Clear completed
        </button>
      )}
    </>
  );
};
