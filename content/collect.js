// @ts-check
// Saving from the page's own gestures: Alt+click, and a drop zone that shows while something is dragged.
// Each acts only on a real gesture (isTrusted), and only once the worker's settings are known; the worker checks the page's word again.
;(function (G) {
  'use strict'
  const C = G.CurioCompanion
  // injected again into a page that has it, this copy steps aside; after a reload, the new content.js's `alive` is another function, so this copy runs
  if (!C || !C.alive || C.collecting === C.alive) return
  C.collecting = C.alive

  /** @type {[string, any, any][]} */
  const listeners = []
  const on = (type, f, opts) => {
    addEventListener(type, f, opts)
    listeners.push([type, f, opts])
  }
  function live() {
    if (C.alive()) return true
    for (const [t, f, o] of listeners) removeEventListener(t, f, o)
    C.zone.hide()
    return false
  }
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null)
  const COLLECTABLE = new Set(['image', 'video', 'audio', 'svg', 'canvas', 'file', 'link'])

  async function save(found, how, extra = {}) {
    const draft = await C.draftFrom(found)
    if (draft) send({ type: 'page.save', draft, how, ...extra })
  }

  // where the pointer is, for the shortcut that saves what is under it; the worker asks each frame and takes the latest, and what is there is found when it saves
  on('mousemove', (e) => {
    C.pointer = { x: e.clientX, y: e.clientY, at: Date.now() }
  }, { capture: true, passive: true })
  on('mouseout', (e) => {
    if (!e.relatedTarget) C.pointer = null
  }, { capture: true, passive: true })

  // ---- Alt+click & keyboard shortcuts ----

  const MODIFIERS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'AltGraph'])
  // mirrors store.DEFAULT_SHORTCUTS only for the first few milliseconds before C.greet() resolves on a fresh tab
  const DEFAULT_KEYS = [
    { name: 'save-page', shortcut: 'Alt+D' },
    { name: 'quick-save', shortcut: 'Alt+Shift+S' },
    { name: 'capture-region', shortcut: 'Alt+Shift+A' },
  ]
  function matchCommand(e, keys) {
    if (!Array.isArray(keys)) return null
    for (const item of keys) {
      const parsed = item && C.parseShortcut(item.shortcut)
      if (parsed && C.matchesShortcut(e, parsed)) return item.name
    }
    return null
  }

  // preload shortcuts on the visible top frame so the very first shortcut press can call preventDefault() synchronously (beating browser Alt+D) without waking the worker for background tabs
  if (window === window.top) {
    if (!document.hidden && live()) C.greet()
    on('visibilitychange', () => !document.hidden && !C.known() && live() && C.greet())
  }
  // also warm up settings on first pointer press or modifier key as fallback (e.g. inside iframes)
  on('pointerdown', () => live() && C.greet(), { capture: true, passive: true })
  on('keydown', (e) => {
    if (!e.isTrusted || !live()) return
    if (MODIFIERS.has(e.key)) {
      if (e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') C.greet()
      return
    }
    if ((!e.altKey && !e.ctrlKey && !e.metaKey) || e.repeat || e.isComposing) return
    if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return
    if (window === window.top && C.frame?.mode?.()) return
    const s = C.known()
    if (s) {
      const cmd = matchCommand(e, s.keys)
      if (!cmd) return
      e.preventDefault()
      e.stopImmediatePropagation()
      send({ type: 'page.command', name: cmd })
      return
    }
    // cold tab whose first gesture beats C.greet(): prevent browser default for default combos synchronously, then verify against actual user settings
    if (matchCommand(e, DEFAULT_KEYS)) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const snap = { altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey, code: e.code, key: e.key, repeat: false, isComposing: false }
    C.greet().then(() => {
      const loaded = C.known()
      const cmd = loaded && matchCommand(snap, loaded.keys)
      if (cmd) send({ type: 'page.command', name: cmd })
    })
  }, { capture: true })
  on('click', (e) => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || e.button !== 0 || !e.isTrusted || C.isOurs(e.target) || !live()) return
    const s = C.known()
    if (!s || !s.on || !s.altClick) return
    const found = C.findTarget(e.composedPath()[0], { x: e.clientX, y: e.clientY }, s.minSize, s.eagle)
    if (!found.el || !COLLECTABLE.has(found.kind)) return
    // the browser's own Alt+click downloads a link
    e.preventDefault()
    e.stopImmediatePropagation()
    save(found, 'alt')
  }, { capture: true })

  // ---- the drop zone ----

  /** @type {{ target: any, x: number, y: number, shown: boolean, found?: any } | null} */
  let drag = null
  /** Media element temporarily made draggable so native dragstart fires on <video>/<audio>. @type {HTMLElement | null} */
  let madeDraggable = null
  const PULL = 30

  function restoreDraggable() {
    if (!madeDraggable) return
    madeDraggable.removeAttribute('draggable')
    madeDraggable = null
  }

  on('mousedown', (e) => {
    restoreDraggable()
    if (e.button !== 0 || !e.isTrusted || C.isOurs(e.target) || !live()) return
    const s = C.known()
    if (!s || !s.on || !s.drag) return
    const t = /** @type {Element | null} */ (e.composedPath()[0])
    const media = /** @type {HTMLMediaElement | null} */ (t?.closest?.('video, audio') || null)
    if (!media || media.hasAttribute('draggable') || media.closest('[draggable="true"]') || C.isPending(media, s.eagle)) return
    // keep the bottom control strip usable for scrubbing when native controls are shown
    if (media.tagName === 'VIDEO' && media.controls) {
      const r = media.getBoundingClientRect()
      if (r.height > 100 && e.clientY > r.bottom - 52) return
    }
    media.draggable = true
    madeDraggable = media
  }, { capture: true, passive: true })
  on('mouseup', restoreDraggable, { capture: true, passive: true })
  on('blur', restoreDraggable, { passive: true })

  on('dragstart', (e) => {
    const own = madeDraggable && (e.target === madeDraggable || e.composedPath().includes(madeDraggable)) ? madeDraggable : null
    restoreDraggable()
    if (!e.isTrusted || !live()) return
    // what a page made draggable is the page's own drag (a board's card, a list's row), which the card would cover
    if (!own && /** @type {Element} */ (e.target).closest?.('[draggable="true"]')) return
    if (own && e.dataTransfer) {
      try { e.dataTransfer.setDragImage(own, 0, 0) } catch {}
    }
    drag = { target: own || e.composedPath()[0], x: e.clientX, y: e.clientY, shown: false }
    held = drag
    C.greet()
  }, { capture: true, passive: true })

  // the zone comes after a short pull, from the document's own dragover, which a drag that never fires `drag` still gives
  on('dragover', (e) => {
    // a drag moves no mouse: where it is now is where the card comes
    if (drag) C.pointer = { x: e.clientX, y: e.clientY, at: Date.now() }
    if (!drag || drag.shown || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < PULL) return
    const s = C.known()
    // a worker still waking hasn't answered yet; dragover keeps coming while the drag lasts
    if (!s) return
    drag.shown = true
    if (!s.on || !s.drag || !live()) return
    const found = C.findTarget(drag.target, { x: drag.x, y: drag.y }, s.minSize, s.eagle)
    if (!found.el || !COLLECTABLE.has(found.kind)) return
    drag.found = found
    const picked = drag
    held = picked
    // the drag card: the panel's page over this one, a drop area beside the folders; the small zone where the page won't take it; nothing where the side panel is open to take the drop
    // the card is drawn in the top page, and Chrome drops nothing into it from a frame of another site
    const card = window === window.top || sameOriginTop()
    ;(card ? send({ type: 'drag.start' }) : Promise.resolve(false)).then((shown) => {
      if (shown === 'none') return void (picked.side = true)
      if (shown !== true && drag === picked) C.zone.show(e.clientX, e.clientY, send({ type: 'zone.rows' }), (row) => picked.found && save(picked.found, 'drop', { row }))
    })
  }, { capture: true, passive: true })

  function sameOriginTop() {
    try {
      return !!window.top?.location.href
    } catch {
      return false
    }
  }

  /** The drag the card or side panel is for, until a drop says where it goes. */
  let held = null
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'drop.at' || !held || !live()) return false
    const s = C.known()
    const found = held.found || (s && s.on ? C.findTarget(held.target, { x: held.x, y: held.y }, s.minSize, s.eagle) : null)
    if (!found?.el || !COLLECTABLE.has(found.kind)) return false
    held = null
    save(found, 'drop', { row: String(msg.key) })
    reply(true)
    return false
  })

  const end = (e) => {
    const was = drag
    drag = null
    // after the zone's own drop handler, which this capture listener runs before
    setTimeout(() => C.zone.hide(), 0)
    const cancelled = e?.type === 'dragend' && (!e.dataTransfer || e.dataTransfer.dropEffect === 'none')
    const closeDrop = () => {
      if (window === window.top) C.frame.mode() === 'drop' && !C.frame.droppedOn() && C.frame.close()
      else send({ type: 'drag.end' })
    }
    // catcher's drop runs before dragend in the same frame, so an un-dropped or Esc-cancelled drag closes the card immediately
    if (cancelled || (e?.type === 'dragend' && window === window.top && !C.frame.droppedOn())) closeDrop()
    // a drop on the card or side panel is told to the worker by the target; a drag that ended anywhere else clears `held`
    setTimeout(() => {
      if (!was || held !== was) return
      // the side panel's word on a drop there comes through the worker as the card's does
      if (was.side && !cancelled) return setTimeout(() => held === was && (held = null), 5000)
      // a drop on the card waits for the card's word, which comes through the worker
      if (window === window.top && C.frame.droppedOn()) return setTimeout(() => held === was && (held = null), 5000)
      held = null
      closeDrop()
    }, cancelled ? 0 : 800)
  }
  on('dragend', end, { capture: true, passive: true })
  on('drop', end, { capture: true, passive: true })
})(globalThis)
