// @ts-check
// A save button over pictures the pointer rests on. Registered by the worker only while the option is on, so pages pay nothing for it otherwise.
;(function (G) {
  'use strict'
  const C = G.CurioCompanion
  // without the main content script (a page it doesn't run on), there is nothing to save with
  if (!C || !C.draftFrom || C.hovering === C.alive) return
  C.hovering = C.alive

  const SHOWN = new Set(['image', 'video', 'svg', 'canvas'])
  /** @type {Element | null} */
  let over = null
  /** @type {[string, any, any][]} */
  const listeners = []
  const on = (type, f, opts) => {
    addEventListener(type, f, opts)
    listeners.push([type, f, opts])
  }
  function hide() {
    over = null
    C.hoverButton.hide()
  }

  on('mouseover', (e) => {
    if (!C.alive()) {
      for (const [t, f, o] of listeners) removeEventListener(t, f, o)
      return hide()
    }
    if (C.isOurs(e.target)) return
    const t = e.composedPath()[0]
    const s = C.known()
    if (!s) return void C.greet()
    if (!s.on || !s.hover) return hide()
    let found = C.findTarget(t, null, s.hoverMin, s.eagle)
    if (!found.el || !SHOWN.has(found.kind)) {
      // galleries lay a transparent layer over their pictures; a background under the pointer is no reason for a button
      found = C.findTarget(t, { x: e.clientX, y: e.clientY }, s.hoverMin, s.eagle)
      if (!found.el || !/^(img|video|canvas|svg)$/i.test(found.el.tagName)) return hide()
    }
    if (found.el === over) return
    over = found.el
    C.hoverButton.show(found.el.getBoundingClientRect(), s.hoverCorner, s.hoverSize, (ev) => {
      if (!ev.isTrusted) return
      C.draftFrom(found).then((draft) => draft && chrome.runtime.sendMessage({ type: 'page.save', draft, how: 'hover' }).catch(() => {}))
    })
  }, { capture: true, passive: true })
  on('scroll', hide, { capture: true, passive: true })
  on('resize', hide, { passive: true })
})(globalThis)
