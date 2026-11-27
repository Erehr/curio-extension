// @ts-check
// Listens for where the pointer was, answers the worker's questions about it, and hands over bytes only the page can read.
;(function (G) {
  'use strict'
  const C = G.CurioCompanion
  // injected again after an update, the copy whose extension is gone steps aside
  if (!C || (C.alive && C.alive())) return
  // after the extension is reloaded or updated, a page keeps this copy running with chrome.runtime gone
  const alive = () => {
    try {
      return !!chrome.runtime.id
    } catch {
      return false
    }
  }
  C.alive = alive

  const top = window === window.top
  let settings = { on: true, minSize: 48, eagle: true, drag: true, altClick: true, hover: false, hoverCorner: 'bottom-right', hoverSize: 20, hoverMin: 200 }
  /** Whether `settings` came from the worker yet; until then nothing in the page acts on them. */
  let known = false
  /** @type {{ target: any, x: number, y: number, at: number } | null} */
  let last = null

  // asked on the first gesture, not on load, so pages that are only looked at never wake the worker
  /** @type {Promise<void> | null} */
  let hello = null
  const greet = () => (hello ||= chrome.runtime.sendMessage({ type: 'hello', top }).then((s) => {
    if (s) {
      settings = { ...settings, ...s }
      known = true
    } else hello = null
  }, () => {
    hello = null
  }))
  C.greet = greet
  C.known = () => (known ? settings : null)

  const onDown = (e) => e.button === 2 && remember(e)
  function remember(e) {
    if (!alive()) return retire()
    last = { target: e.composedPath()[0] || e.target, x: e.clientX, y: e.clientY, at: Date.now() }
    greet()
  }
  function retire() {
    removeEventListener('contextmenu', remember, { capture: true })
    removeEventListener('mousedown', onDown, { capture: true })
  }
  addEventListener('contextmenu', remember, { capture: true, passive: true })
  addEventListener('mousedown', onDown, { capture: true, passive: true })

  // a page script may fill attributes on curio:collect, or set data-curio-pending and clear it when done
  async function settle(el) {
    el.dispatchEvent(new CustomEvent('curio:collect', { bubbles: true, composed: true }))
    const until = Date.now() + 3000
    while (C.isPending(el, settings.eagle) && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
  }

  /** What is under a point now, inside shadow roots, closed ones too, and never the extension's own layer. */
  function elementAt(x, y) {
    let el = document.elementsFromPoint(x, y).find((e) => !C.isOurs(e)) || null
    for (let i = 0; el && i < 32; i++) {
      const root = el.shadowRoot || chrome.dom?.openOrClosedShadowRoot?.(/** @type {HTMLElement} */ (el))
      const inner = root?.elementFromPoint(x, y)
      if (!inner || inner === el) break
      el = inner
    }
    return el
  }

  /** The text of what a site rule's selectors find in this frame; a selector the page can't take finds nothing. */
  function pageTexts(selectors) {
    const out = []
    for (const sel of Array.isArray(selectors) ? selectors.slice(0, 10) : []) {
      try {
        for (const el of document.querySelectorAll(String(sel))) {
          if (C.isOurs(el)) continue
          out.push(String(el.textContent || '').slice(0, 200))
          if (out.length >= 60) return out
        }
      } catch {}
    }
    return out
  }

  function findBySelectors(selectors) {
    for (const sel of Array.isArray(selectors) ? selectors.slice(0, 10) : []) {
      try {
        for (const el of document.querySelectorAll(String(sel))) {
          if (C.isOurs(el)) continue
          const found = C.targetFromElement(el, settings.eagle)
          if (found) return found
        }
      } catch {}
    }
    return null
  }

  const recentPointer = () => (last && Date.now() - last.at < 15000 ? last : null)

  async function draftFor(info, use, fileSelectors = null) {
    await greet()
    if (!settings.on) return null
    if (Array.isArray(fileSelectors) && fileSelectors.length) {
      const picked = findBySelectors(fileSelectors)
      if (picked) return draftFrom(picked, info)
    }
    if (use === 'page') return draftFrom(C.directMedia() || { el: null, kind: 'page' }, info)
    const p = C.pointer
    const recent = use === 'pointer' ? (p && Date.now() - p.at < 60000 ? p : null) : recentPointer()
    const found = recent ? C.findTarget(recent.target || elementAt(recent.x, recent.y), { x: recent.x, y: recent.y }, settings.minSize, settings.eagle) : { el: null, kind: 'page' }
    return draftFrom(found, info)
  }

  async function draftFrom(found, info = {}) {
    if (found.el) await settle(found.el)
    const draft = C.draftOf(found, { eagle: settings.eagle, info })
    if (found.el && top) {
      const r = found.el.getBoundingClientRect()
      const x = Math.max(0, r.left)
      const y = Math.max(0, r.top)
      draft.box = { x, y, w: Math.min(innerWidth, r.right) - x, h: Math.min(innerHeight, r.bottom) - y, vw: innerWidth }
    }
    let frameId = 0
    try {
      frameId = chrome.runtime.getFrameId(window)
    } catch {}
    return { ...draft, frameId }
  }
  /** The draft of an element the page's own gestures found (collect.js). */
  C.draftFrom = draftFrom

  // only the page reads blob:, data:, canvas and inline SVG sources, and a same-origin address the extension couldn't fetch
  async function sendBytes({ captureId, inPageId }) {
    const port = chrome.runtime.connect({ name: 'bytes:' + captureId })
    try {
      const entry = C.inPage.get(inPageId)
      if (!entry) throw new Error('No longer on the page')
      if (entry.src && /^https?:/i.test(entry.src) && new URL(entry.src).origin !== location.origin) throw new Error('Another site\'s address')
      const blob = await C.readInPage(entry)
      port.postMessage({ t: 'meta', type: blob.type, size: blob.size })
      // 6 MiB of bytes is 8 MiB of base64, and a multiple of 3, so the chunks join into one base64 text
      const step = 6 * 1024 * 1024
      for (let at = 0; at < blob.size; at += step) port.postMessage({ t: 'chunk', data: await base64(blob.slice(at, at + step)) })
      port.postMessage({ t: 'end' })
    } catch (e) {
      port.postMessage({ t: 'error', message: String(e && e.message ? e.message : e) })
    }
  }

  function base64(blob) {
    return new Promise((ok, no) => {
      const r = new FileReader()
      r.onload = () => ok(String(r.result).slice(String(r.result).indexOf(',') + 1))
      r.onerror = () => no(r.error)
      r.readAsDataURL(blob)
    })
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !msg) return false
    if (msg.type === 'draft.get') {
      // asked of every frame, only the one the pointer was in answers
      if (msg.anyFrame && !recentPointer()) return false
      draftFor(msg.info || {}, msg.use, msg.fileSelectors).then(reply, () => reply(null))
      return true
    }
    if (msg.type === 'ui.hide' && top) {
      C.uiHidden(!!msg.on)
      // answered once the page has painted without it
      requestAnimationFrame(() => requestAnimationFrame(() => reply(true)))
      return true
    }
    if (msg.type === 'crop.start' && top) {
      C.cropper((rect) => {
        if (!rect) return void chrome.runtime.sendMessage({ type: 'crop.done', rect: null }).catch(() => {})
        C.uiHidden(true)
        requestAnimationFrame(() => requestAnimationFrame(() => chrome.runtime.sendMessage({ type: 'crop.done', rect, vw: innerWidth, vh: innerHeight }).catch(() => {})))
      })
      return false
    }
    if (msg.type === 'frame.open' && top) {
      const p = !msg.center && C.pointer && Date.now() - C.pointer.at < 60000 ? { x: C.pointer.x, y: C.pointer.y } : null
      C.frame.open(String(msg.secret), msg.mode === 'drop' ? 'drop' : 'panel', p).then(reply, () => reply(false))
      return true
    }
    if (msg.type === 'frame.close' && top && (!msg.onlyDrop || C.frame.mode() === 'drop')) C.frame.close()
    if (msg.type === 'tags.from') {
      // a site the extension is off on is never read
      greet().then(() => reply(settings.on ? pageTexts(msg.selectors) : []), () => reply([]))
      return true
    }
    if (msg.type === 'toast' && top) C.toast(msg.toast)
    else if (msg.type === 'toast.close' && top) C.untoast(msg.id)
    else if (msg.type === 'bytes.request') sendBytes(msg)
    else if (msg.type === 'settings') {
      settings = { ...settings, ...msg.settings }
      known = true
    }
    return false
  })
})(globalThis)
