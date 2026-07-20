// ─── Browser automation scripts (injected JS, DOM-walk approach) ─────────────
// The interactive layer of agent browser control. Rather than CDP (which needs
// an attached debugger), these are self-contained page scripts run via
// `<webview>.executeJavaScript`. `snapshot` walks the DOM (and same-origin
// iframes), tags every visible interactive element with a stable
// `data-splitgrid-ref` ("e1", "e2", …) and returns a compact tree; the action
// scripts (click/fill/type/select) then resolve an element by that ref — across
// frames, so refs inside same-origin iframes work too. Same model as
// agent-browser/cmux: snapshot → act by ref.
//
// Every script is an IIFE that returns a JSON STRING (never a bare value/
// undefined — that hands V8 an empty MaybeLocal and crashes the renderer). The
// caller JSON-parses it back. Values interpolated into a script are always
// JSON.stringify'd so quotes/newlines can't break out.

// Cap so a huge page can't return a multi-megabyte snapshot to the agent.
const SNAPSHOT_CAP = 250;

// Shared helper source: resolve a TARGET across the top document and all
// reachable same-origin iframes (cross-origin frames throw on access and are
// skipped). A target is EITHER a snapshot ref ("e1", "e2", …) OR a raw CSS
// selector — so every action command (click/fill/hover/…) accepts both, matching
// agent-browser/cmux where actions take a selector while still supporting our
// snapshot refs. Embedded into each action script so it can reach elements inside
// same-origin frames too.
const RESOLVE_SRC = `function __swResolve(target) {
  var isRef = /^e[0-9]+$/.test(target);
  function inDoc(doc) {
    try {
      var el = null;
      if (isRef) { el = doc.querySelector('[data-splitgrid-ref="' + target + '"]'); }
      else { try { el = doc.querySelector(target); } catch (e) { el = null; } }
      if (el) return el;
      var frames = doc.querySelectorAll('iframe, frame');
      for (var i = 0; i < frames.length; i++) {
        try { var d = frames[i].contentDocument; if (d) { var f = inDoc(d); if (f) return f; } } catch (e) {}
      }
    } catch (e) {}
    return null;
  }
  return inDoc(document);
}`;

interface SnapshotOpts {
  viewportOnly?: boolean;
}

// Build a snapshot of interactive elements across the document + same-origin
// iframes. Tags each with data-splitgrid-ref and returns
// { url, title, count, truncated, elements:[…] }. With `viewportOnly`, only
// elements intersecting their frame's viewport are included.
export function snapshotScript(opts: SnapshotOpts = {}): string {
  const viewportOnly = !!opts.viewportOnly;
  return `(function () {
    try {
      var VIEWPORT_ONLY = ${viewportOnly};
      var SEL = [
        'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select',
        'summary', '[contenteditable=""]', '[contenteditable="true"]', '[onclick]',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
        '[role="tab"]', '[role="menuitem"]', '[role="switch"]', '[role="option"]',
        '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(', ');
      var SEMANTIC = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, SUMMARY: 1 };

      function visible(el) {
        if (el.disabled) return false;
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        var s = win.getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        if (VIEWPORT_ONLY) {
          var vw = win.innerWidth, vh = win.innerHeight;
          if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
        }
        return true;
      }

      function labelledBy(el, doc) {
        var ids = (el.getAttribute('aria-labelledby') || '').trim();
        if (!ids) return '';
        return ids.split(/\\s+/).map(function (id) {
          var n = doc.getElementById(id);
          return n ? (n.innerText || n.textContent || '').trim() : '';
        }).filter(Boolean).join(' ');
      }

      function name(el, doc) {
        var n = labelledBy(el, doc) || el.getAttribute('aria-label') || '';
        if (!n && el.id) {
          try { var lab = doc.querySelector('label[for="' + el.id + '"]'); if (lab) n = (lab.innerText || lab.textContent || '').trim(); } catch (e) {}
        }
        if (!n) { var wrap = el.closest && el.closest('label'); if (wrap) n = (wrap.innerText || wrap.textContent || '').trim(); }
        if (!n) n = el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || '';
        if (!n && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) n = el.value || '';
        if (!n) n = (el.innerText || el.textContent || '').trim();
        if (!n && el.tagName === 'INPUT') n = el.getAttribute('name') || el.type || '';
        return String(n).replace(/\\s+/g, ' ').slice(0, 160);
      }

      // Drop generic wrappers (div/span/[onclick]/[tabindex] with no semantic
      // role) that merely contain another candidate — keeps the innermost real
      // control and cuts wrapper noise. Semantic controls (a/button/input/…) and
      // role-bearing elements are always kept.
      function isGeneric(el) {
        return !SEMANTIC[el.tagName] && !el.getAttribute('role');
      }
      function dedup(cands) {
        return cands.filter(function (el) {
          if (!isGeneric(el)) return true;
          for (var i = 0; i < cands.length; i++) {
            if (cands[i] !== el && el.contains(cands[i])) return false;
          }
          return true;
        });
      }

      var out = [];
      var counter = { n: 0 };

      function collect(doc, frameId) {
        var nodes;
        try { nodes = Array.prototype.slice.call(doc.querySelectorAll(SEL)); } catch (e) { return; }
        var cands = nodes.filter(visible);
        cands = dedup(cands);
        for (var k = 0; k < cands.length; k++) {
          if (out.length >= ${SNAPSHOT_CAP}) { out.__truncated = true; return; }
          var el = cands[k];
          counter.n++;
          var ref = 'e' + counter.n;
          el.setAttribute('data-splitgrid-ref', ref);
          var item = { ref: ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), name: name(el, doc) };
          if (frameId != null) item.frame = frameId;
          var tag = el.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            item.tag = tag.toLowerCase();
            if (el.type) item.type = el.type;
            if (el.value) item.value = String(el.value).slice(0, 120);
            if (el.checked !== undefined && (el.type === 'checkbox' || el.type === 'radio')) item.checked = !!el.checked;
          } else if (tag === 'A') {
            var href = el.getAttribute('href');
            if (href) item.href = href.slice(0, 200);
          }
          out.push(item);
        }
        // Recurse into same-origin iframes.
        var frames;
        try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { frames = []; }
        for (var fi = 0; fi < frames.length; fi++) {
          if (out.length >= ${SNAPSHOT_CAP}) { out.__truncated = true; return; }
          var fdoc = null;
          try { fdoc = frames[fi].contentDocument; } catch (e) { fdoc = null; }
          if (fdoc) {
            try { fdoc.querySelectorAll('[data-splitgrid-ref]').forEach(function (e) { e.removeAttribute('data-splitgrid-ref'); }); } catch (e) {}
            collect(fdoc, (frameId == null ? '' : frameId + '.') + fi);
          }
        }
      }

      try { document.querySelectorAll('[data-splitgrid-ref]').forEach(function (e) { e.removeAttribute('data-splitgrid-ref'); }); } catch (e) {}
      collect(document, null);

      return JSON.stringify({ url: location.href, title: document.title, count: out.length, truncated: !!out.__truncated, viewportOnly: VIEWPORT_ONLY, elements: out });
    } catch (e) {
      return JSON.stringify({ __evalError: String(e) });
    }
  })()`;
}

// Click the element matching a ref or CSS selector (scrolls into view + focuses).
export function clickScript(ref: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(ref)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(ref)} });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (el.focus) try { el.focus(); } catch (e) {}
      el.click();
      return JSON.stringify({ ok: true, target: ${JSON.stringify(ref)} });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), target: ${JSON.stringify(ref)} }); }
  })()`;
}

// Set the value of an input/textarea/contenteditable (replaces existing value).
// Uses the native value setter so React's controlled inputs see the change.
export function fillScript(ref: string, text: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(ref)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(ref)} });
      var text = ${JSON.stringify(text)};
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      el.scrollIntoView({ block: 'center' });
      if (el.focus) try { el.focus(); } catch (e) {}
      if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new win.InputEvent('input', { bubbles: true }));
      } else {
        var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, text); else el.value = text;
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
      return JSON.stringify({ ok: true, ref: ${JSON.stringify(ref)}, value: el.value !== undefined ? String(el.value) : text });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), ref: ${JSON.stringify(ref)} }); }
  })()`;
}

// Append text to the currently-focused field (does not replace existing value).
export function typeScript(text: string): string {
  return `(function () {
    try {
      var el = document.activeElement;
      // Reach into a focused same-origin iframe if the top activeElement is one.
      try {
        while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME') && el.contentDocument && el.contentDocument.activeElement) {
          el = el.contentDocument.activeElement;
        }
      } catch (e) {}
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable))
        return JSON.stringify({ ok: false, error: 'no_focused_field', message: 'click a field first, then type' });
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var text = ${JSON.stringify(text)};
      if (el.isContentEditable) {
        el.textContent = (el.textContent || '') + text;
        el.dispatchEvent(new win.InputEvent('input', { bubbles: true }));
      } else {
        var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        var next = (el.value || '') + text;
        if (desc && desc.set) desc.set.call(el, next); else el.value = next;
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
      return JSON.stringify({ ok: true, value: el.value !== undefined ? String(el.value) : (el.textContent || '') });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  })()`;
}

// Select an <option> by value, then exact text, then substring of its label.
export function selectScript(ref: string, value: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(ref)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(ref)} });
      if (el.tagName !== 'SELECT') return JSON.stringify({ ok: false, error: 'not_a_select', target: ${JSON.stringify(ref)} });
      var want = ${JSON.stringify(value)};
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var opts = Array.prototype.slice.call(el.options);
      var opt = opts.find(function (o) { return o.value === want; })
        || opts.find(function (o) { return (o.text || '').trim() === want; })
        || opts.find(function (o) { return (o.text || '').trim().indexOf(want) !== -1; });
      if (!opt) return JSON.stringify({ ok: false, error: 'option_not_found', value: want, options: opts.map(function (o) { return { value: o.value, label: (o.text || '').trim() }; }) });
      el.value = opt.value;
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, ref: ${JSON.stringify(ref)}, selected: opt.value, label: (opt.text || '').trim() });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), ref: ${JSON.stringify(ref)} }); }
  })()`;
}

// ── Wait / synchronization ───────────────────────────────────────────────────
// These return a Promise (awaited by executeJavaScript) that resolves when the
// condition holds or a deadline passes. The deadline is always well under the
// bridge's 35s request timeout so the agent gets a clean `timeout` reply rather
// than a transport error. Poll on a short interval (DOM can mutate without
// navigation, e.g. SPA route changes / async content).

function visibleFnSrc(): string {
  return `function (el) { if (!el) return false; var s = window.getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none') return false; var r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; }`;
}

// Resolve once a selector matches a VISIBLE element (or timeout).
export function waitSelectorScript(selector: string, timeoutMs: number): string {
  return `(function () {
    return new Promise(function (resolve) {
      try {
        var sel = ${JSON.stringify(selector)};
        var deadline = Date.now() + ${Math.floor(timeoutMs)};
        var visible = ${visibleFnSrc()};
        function tick() {
          var el;
          try { el = document.querySelector(sel); } catch (e) { return resolve(JSON.stringify({ ok: false, error: 'bad_selector', selector: sel, detail: String(e) })); }
          if (visible(el)) return resolve(JSON.stringify({ ok: true, found: true, selector: sel }));
          if (Date.now() >= deadline) return resolve(JSON.stringify({ ok: false, error: 'timeout', found: false, selector: sel }));
          setTimeout(tick, 100);
        }
        tick();
      } catch (e) { resolve(JSON.stringify({ ok: false, error: String(e) })); }
    });
  })()`;
}

// Resolve once the page's visible text contains a substring (or timeout).
export function waitTextScript(text: string, timeoutMs: number): string {
  return `(function () {
    return new Promise(function (resolve) {
      try {
        var needle = ${JSON.stringify(text)};
        var deadline = Date.now() + ${Math.floor(timeoutMs)};
        function tick() {
          var hay = (document.body ? document.body.innerText : '') || '';
          if (hay.indexOf(needle) !== -1) return resolve(JSON.stringify({ ok: true, found: true, text: needle }));
          if (Date.now() >= deadline) return resolve(JSON.stringify({ ok: false, error: 'timeout', found: false, text: needle }));
          setTimeout(tick, 100);
        }
        tick();
      } catch (e) { resolve(JSON.stringify({ ok: false, error: String(e) })); }
    });
  })()`;
}

// Fixed delay (capped by the caller).
export function sleepScript(ms: number): string {
  return `(function () {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(JSON.stringify({ ok: true, sleptMs: ${Math.floor(ms)} })); }, ${Math.floor(ms)});
    });
  })()`;
}

// ── More element actions (target = ref OR CSS selector) ──────────────────────

// Hover: dispatch the pointer/mouse-enter/over sequence so JS-driven menus open.
export function hoverScript(target: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(target)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(target)} });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var r = el.getBoundingClientRect();
      var opt = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function (t) {
        try { el.dispatchEvent(new win.MouseEvent(t, opt)); } catch (e) {}
      });
      return JSON.stringify({ ok: true, target: ${JSON.stringify(target)} });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), target: ${JSON.stringify(target)} }); }
  })()`;
}

// Focus the element (so a subsequent `type`/`press` lands on it).
export function focusScript(target: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(target)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(target)} });
      el.scrollIntoView({ block: 'center' });
      if (el.focus) el.focus();
      return JSON.stringify({ ok: true, target: ${JSON.stringify(target)}, focused: true });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), target: ${JSON.stringify(target)} }); }
  })()`;
}

// Double-click.
export function dblclickScript(target: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(target)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(target)} });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      if (el.focus) try { el.focus(); } catch (e) {}
      el.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return JSON.stringify({ ok: true, target: ${JSON.stringify(target)} });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), target: ${JSON.stringify(target)} }); }
  })()`;
}

// Check / uncheck a checkbox or radio (idempotent; fires change only on change).
export function checkScript(target: string, checked: boolean): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(target)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(target)} });
      if (el.tagName !== 'INPUT' || (el.type !== 'checkbox' && el.type !== 'radio'))
        return JSON.stringify({ ok: false, error: 'not_checkable', target: ${JSON.stringify(target)} });
      var want = ${checked ? 'true' : 'false'};
      el.scrollIntoView({ block: 'center' });
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      if (el.checked !== want) {
        el.checked = want;
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
      return JSON.stringify({ ok: true, target: ${JSON.stringify(target)}, checked: !!el.checked });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), target: ${JSON.stringify(target)} }); }
  })()`;
}

// Scroll the page (or a target's nearest scroll container) in a direction.
export function scrollScript(direction: string, px: number): string {
  return `(function () {
    try {
      var dir = ${JSON.stringify(direction)};
      var amt = ${Math.floor(px)};
      var dx = 0, dy = 0;
      if (dir === 'up') dy = -amt; else if (dir === 'down') dy = amt;
      else if (dir === 'left') dx = -amt; else if (dir === 'right') dx = amt;
      else return JSON.stringify({ ok: false, error: 'bad_direction', message: 'up|down|left|right' });
      window.scrollBy(dx, dy);
      return JSON.stringify({ ok: true, direction: dir, by: amt, scrollY: window.scrollY, scrollX: window.scrollX });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  })()`;
}

// Scroll a specific element into view.
export function scrollIntoViewScript(target: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var el = __swResolve(${JSON.stringify(target)});
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: ${JSON.stringify(target)} });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return JSON.stringify({ ok: true, target: ${JSON.stringify(target)} });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e), target: ${JSON.stringify(target)} }); }
  })()`;
}

// `get <what> <selector> [attr]` for a specific element (text/html/value/attr),
// plus selector-wide `count` and a single element's `box`.
export function getElementScript(what: string, selector: string, attr?: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var what = ${JSON.stringify(what)};
      var sel = ${JSON.stringify(selector)};
      if (what === 'count') {
        var n = 0;
        try { n = document.querySelectorAll(sel).length; } catch (e) { return JSON.stringify({ ok: false, error: 'bad_selector', detail: String(e) }); }
        return JSON.stringify({ ok: true, selector: sel, count: n });
      }
      var el = __swResolve(sel);
      if (!el) return JSON.stringify({ ok: false, error: 'not_found', target: sel });
      if (what === 'text') return JSON.stringify({ ok: true, selector: sel, text: String(el.innerText || el.textContent || '').slice(0, 20000) });
      if (what === 'html') return JSON.stringify({ ok: true, selector: sel, html: String(el.innerHTML || '').slice(0, 50000) });
      if (what === 'value') return JSON.stringify({ ok: true, selector: sel, value: el.value !== undefined ? String(el.value) : null });
      if (what === 'attr') { var a = ${JSON.stringify(attr || '')}; return JSON.stringify({ ok: true, selector: sel, attr: a, result: el.getAttribute(a) }); }
      if (what === 'box') { var r = el.getBoundingClientRect(); return JSON.stringify({ ok: true, selector: sel, box: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left } }); }
      return JSON.stringify({ ok: false, error: 'unknown_get' });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  })()`;
}

// `is visible|enabled|checked <selector>` — boolean state checks.
export function isStateScript(what: string, selector: string): string {
  return `(function () {
    try {
      ${RESOLVE_SRC}
      var what = ${JSON.stringify(what)};
      var sel = ${JSON.stringify(selector)};
      var el = __swResolve(sel);
      if (!el) return JSON.stringify({ ok: true, selector: sel, result: false, reason: 'not_found' });
      if (what === 'enabled') return JSON.stringify({ ok: true, selector: sel, result: !el.disabled });
      if (what === 'checked') return JSON.stringify({ ok: true, selector: sel, result: !!el.checked });
      // visible (default)
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var s = win.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var vis = s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && r.width >= 1 && r.height >= 1;
      return JSON.stringify({ ok: true, selector: sel, result: !!vis });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  })()`;
}

// `find <strategy> <query> <action> [value]`: locate ONE element semantically
// (without a prior snapshot), then act on it. Strategies: text, role, label,
// placeholder, testid, selector. Actions: click, fill, check, uncheck, hover,
// focus, text (returns its text).
export function findScript(strategy: string, query: string, action: string, value: string): string {
  return `(function () {
    try {
      var strategy = ${JSON.stringify(strategy)};
      var query = ${JSON.stringify(query)};
      var action = ${JSON.stringify(action)};
      var value = ${JSON.stringify(value)};
      function norm(s){ return String(s || '').replace(/\\s+/g, ' ').trim(); }
      function matches(el){
        if (strategy === 'selector') { try { return el.matches(query); } catch(e){ return false; } }
        if (strategy === 'testid') { return el.getAttribute('data-testid') === query; }
        if (strategy === 'role') { var role = el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:'textbox',SELECT:'combobox',TEXTAREA:'textbox'}[el.tagName] || ''); return role === query; }
        if (strategy === 'placeholder') { return el.getAttribute('placeholder') === query; }
        if (strategy === 'label') {
          var al = el.getAttribute('aria-label'); if (al && norm(al) === norm(query)) return true;
          if (el.id) { try { var lab = document.querySelector('label[for="' + el.id + '"]'); if (lab && norm(lab.innerText || lab.textContent) === norm(query)) return true; } catch(e){} }
          var wrap = el.closest && el.closest('label'); if (wrap && norm(wrap.innerText || wrap.textContent).indexOf(norm(query)) !== -1) return true;
          return false;
        }
        if (strategy === 'text') { return norm(el.innerText || el.textContent).indexOf(norm(query)) !== -1; }
        return false;
      }
      var INTERACTIVE = 'a,button,input,textarea,select,summary,[role],[onclick],[tabindex],[contenteditable]';
      var pool;
      if (strategy === 'selector') { try { pool = Array.prototype.slice.call(document.querySelectorAll(query)); } catch(e){ return JSON.stringify({ ok:false, error:'bad_selector' }); } }
      else { pool = Array.prototype.slice.call(document.querySelectorAll(INTERACTIVE)); }
      // For text strategy, prefer the SMALLEST matching element (innermost).
      var hits = pool.filter(matches);
      if (strategy === 'text') hits.sort(function(a,b){ return norm(a.innerText||a.textContent).length - norm(b.innerText||b.textContent).length; });
      var el = hits[0];
      if (!el) return JSON.stringify({ ok:false, error:'not_found', strategy:strategy, query:query, candidates: pool.filter(matches).length });
      el.scrollIntoView({ block:'center', inline:'center' });
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      if (action === 'click' || action === '') { if (el.focus) try{el.focus();}catch(e){} el.click(); return JSON.stringify({ ok:true, action:'click', tag: el.tagName.toLowerCase() }); }
      if (action === 'hover') { var r=el.getBoundingClientRect(); ['pointerover','mouseover','mousemove'].forEach(function(t){ try{ el.dispatchEvent(new win.MouseEvent(t,{bubbles:true,clientX:r.left+1,clientY:r.top+1})); }catch(e){} }); return JSON.stringify({ ok:true, action:'hover' }); }
      if (action === 'focus') { if (el.focus) el.focus(); return JSON.stringify({ ok:true, action:'focus' }); }
      if (action === 'text') { return JSON.stringify({ ok:true, action:'text', text: norm(el.innerText||el.textContent).slice(0,5000) }); }
      if (action === 'check' || action === 'uncheck') { var want = action==='check'; if (el.checked !== want){ el.checked = want; el.dispatchEvent(new win.Event('change',{bubbles:true})); } return JSON.stringify({ ok:true, action:action, checked: !!el.checked }); }
      if (action === 'fill') {
        if (el.focus) try{el.focus();}catch(e){}
        var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        el.dispatchEvent(new win.Event('input',{bubbles:true}));
        el.dispatchEvent(new win.Event('change',{bubbles:true}));
        return JSON.stringify({ ok:true, action:'fill', value: String(el.value) });
      }
      return JSON.stringify({ ok:false, error:'unknown_action', action:action });
    } catch (e) { return JSON.stringify({ ok:false, error:String(e) }); }
  })()`;
}

// Resolve once the page URL matches a substring/regex pattern (or timeout).
export function waitUrlScript(pattern: string, timeoutMs: number): string {
  return `(function () {
    return new Promise(function (resolve) {
      try {
        var pat = ${JSON.stringify(pattern)};
        var rx = null; try { rx = new RegExp(pat); } catch (e) { rx = null; }
        var deadline = Date.now() + ${Math.floor(timeoutMs)};
        function hit(){ var u = location.href; return rx ? rx.test(u) : u.indexOf(pat) !== -1; }
        function tick() {
          if (hit()) return resolve(JSON.stringify({ ok: true, matched: true, url: location.href }));
          if (Date.now() >= deadline) return resolve(JSON.stringify({ ok: false, error: 'timeout', url: location.href }));
          setTimeout(tick, 100);
        }
        tick();
      } catch (e) { resolve(JSON.stringify({ ok: false, error: String(e) })); }
    });
  })()`;
}

// Resolve once a JS predicate returns truthy (or timeout). The predicate is the
// agent's expression, evaluated each tick; its truthy value is returned.
export function waitFnScript(js: string, timeoutMs: number): string {
  return `(function () {
    return new Promise(function (resolve) {
      try {
        var deadline = Date.now() + ${Math.floor(timeoutMs)};
        function tick() {
          var v;
          try { v = eval(${JSON.stringify(js)}); } catch (e) { return resolve(JSON.stringify({ ok: false, error: 'fn_threw', detail: String(e) })); }
          if (v) { var out; try { out = JSON.stringify(v); } catch (e) { out = null; } return resolve(JSON.stringify({ ok: true, satisfied: true, value: out ? JSON.parse(out) : true })); }
          if (Date.now() >= deadline) return resolve(JSON.stringify({ ok: false, error: 'timeout', satisfied: false }));
          setTimeout(tick, 100);
        }
        tick();
      } catch (e) { resolve(JSON.stringify({ ok: false, error: String(e) })); }
    });
  })()`;
}

// localStorage / sessionStorage access: get all | get key | set k v | clear.
export function storageScript(area: string, op: string, key: string, value: string): string {
  return `(function () {
    try {
      var store = ${JSON.stringify(area)} === 'session' ? window.sessionStorage : window.localStorage;
      var op = ${JSON.stringify(op)};
      if (op === 'set') { store.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return JSON.stringify({ ok: true, set: ${JSON.stringify(key)} }); }
      if (op === 'clear') { store.clear(); return JSON.stringify({ ok: true, cleared: true }); }
      if (op === 'get' && ${JSON.stringify(key)}) { return JSON.stringify({ ok: true, key: ${JSON.stringify(key)}, value: store.getItem(${JSON.stringify(key)}) }); }
      // dump all
      var all = {};
      for (var i = 0; i < store.length; i++) { var k = store.key(i); all[k] = store.getItem(k); }
      return JSON.stringify({ ok: true, count: store.length, items: all });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  })()`;
}

// SPA client-side navigation via history.pushState (no full page load).
export function pushStateScript(url: string): string {
  return `(function () {
    try {
      history.pushState({}, '', ${JSON.stringify(url)});
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      return JSON.stringify({ ok: true, url: location.href });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  })()`;
}
