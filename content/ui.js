// @ts-check
// The extension's own UI in the page, in a closed shadow root: the toast. Text from pages goes in as text nodes only.
;(function (G) {
  'use strict'
  const C = (G.CurioCompanion = G.CurioCompanion || {})

  // what a copy of this script drew before the extension was reloaded or updated can no longer act: it goes
  for (const old of document.querySelectorAll('curio-companion')) old.remove()

  const CSS = `
:host { all: initial; }
.stack { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: flex-start; gap: 10px; max-width: 360px; min-width: 220px; padding: 10px 12px; border-radius: var(--r, 8px); background: var(--surface, #fff); color: var(--text, #1e345d); border: 1px solid var(--border, #d5dee2); box-shadow: 0 6px 24px rgba(0,0,0,.18); font: 12.5px/1.4 var(--ui-font, system-ui, 'Segoe UI', sans-serif); }
.dot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: var(--accent, #3b9160); }
.busy .dot { animation: pulse 1s ease-in-out infinite alternate; }
.ok .dot { background: var(--success, #24875d); }
.error .dot { background: var(--danger, #d64545); }
.warn .dot { background: var(--warning, #b86b00); }
@keyframes pulse { from { opacity: .3; } to { opacity: 1; } }
.body { flex: 1; min-width: 0; }
.text { overflow-wrap: anywhere; }
.sub { color: var(--text-muted, #475b70); font-size: 12px; overflow-wrap: anywhere; margin-top: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
button { font: inherit; font-size: 12px; cursor: pointer; border-radius: var(--r, 6px); border: 0; background: var(--button, #e4e9ed); color: var(--text, #1e345d); padding: 4px 10px; }
button:hover { background: var(--button-hover, #dae0e5); }
.close { border: 0; background: none; padding: 0 2px; color: var(--text-muted, #475b70); font-size: 15px; line-height: 1; }
.zone { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; gap: 4px; padding: 6px; min-width: 200px; max-width: 300px; border-radius: 10px; background: var(--surface, #fff); color: var(--text, #1e345d); border: 1px solid var(--border, #d5dee2); box-shadow: 0 8px 28px rgba(0,0,0,.22); font: 12.5px/1.3 var(--ui-font, system-ui, 'Segoe UI', sans-serif); }
.zone .head { font-size: 11px; color: var(--text-muted, #475b70); padding: 2px 6px; }
.zone .row { padding: 7px 9px; border-radius: 6px; border: 1px dashed var(--border, #d5dee2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zone .row.over { background: var(--accent, #3b9160); color: var(--accent-text, #fff); border-color: transparent; }
.zone .row.choose { color: var(--text-muted, #475b70); }
.hover-btn { position: fixed; z-index: 2147483646; display: grid; place-items: center; border: 0; padding: 0; background: none; cursor: pointer; opacity: .92; }
.hover-btn:hover { opacity: 1; background: none; }
dialog.frame { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; overflow: hidden; }
dialog.frame::backdrop { background: rgba(0, 0, 0, .38); }
dialog.frame.drop::backdrop { background: rgba(0, 0, 0, .18); }
dialog.frame iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
dialog.frame .catch { position: absolute; inset: 0; }
.crop { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; background: rgba(0,0,0,.28); }
.crop.marking { background: transparent; }
.crop .box { position: fixed; border: 1px solid #fff; outline: 1px dashed rgba(0,0,0,.6); box-shadow: 0 0 0 100vmax rgba(0,0,0,.28); }
.crop .hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); padding: 6px 12px; border-radius: 7px; background: rgba(20,22,26,.86); color: #fff; font: 13px/1.3 system-ui, 'Segoe UI', sans-serif; pointer-events: none; }
.toast.dark { --surface: #222327; --text: #eceef0; --border: #2b2c31; --text-muted: #a7a9ae; --button: #3d3f43; --button-hover: #4b4c51; --accent: #3b9160; --accent-text: #ffffff; --success: #3ecf8e; --danger: #ff6b6b; --warning: #f5a524; }
@media (prefers-color-scheme: dark) {
  .zone { --surface: #222327; --text: #eceef0; --border: #2b2c31; --text-muted: #a7a9ae; --accent: #3b9160; --accent-text: #ffffff; }
  .toast:not(.themed):not(.light):not(.dark) { --surface: #222327; --text: #eceef0; --border: #2b2c31; --text-muted: #a7a9ae; --button: #3d3f43; --button-hover: #4b4c51; --accent: #3b9160; --accent-text: #ffffff; --success: #3ecf8e; --danger: #ff6b6b; --warning: #f5a524; }
}
`

  const LOGO = '<rect x="83.18" y="102.94" width="839.25" height="839.25" rx="183.59" fill="#3B9160"/><path d="M335.35 341C355.81 325.75 378.68 312.01 404 300C530 240 676 244 792 256C803.23 303.55 807.26 354.37 803.66 405H547L495 353Q483 341 467 341Z" fill="#A1CAB3"/><path d="M310.82 361H467Q475 361 481 367L539 425H801.84C797.56 463.55 788.8 501.73 775.37 538H497L445 486Q433 474 417 474H228.65C246.88 432.02 274.14 393.74 310.82 361Z" fill="#D0E5D9"/><path d="M220.75 494H417Q425 494 431 500L489 558H767.41C747.69 604.17 720.03 646.62 684 682C574 790 398 822 232 776C194.96 678.25 190.21 579.44 220.75 494Z" fill="#FFFFFF"/>'

  let root = null
  let stack = null
  /** @type {HTMLElement | null} */
  let hostEl = null
  /** @type {Map<string, { el: HTMLElement, timer: any, keep: boolean }>} */
  const shown = new Map()

  function ensure() {
    if (stack && stack.isConnected) return
    const host = document.createElement('curio-companion')
    hostEl = host
    root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = CSS
    stack = document.createElement('div')
    stack.className = 'stack'
    root.append(style, stack)
    document.documentElement.append(host)
  }

  function remove(id) {
    const t = shown.get(id)
    if (!t) return
    clearTimeout(t.timer)
    t.el.remove()
    shown.delete(id)
  }

  function arm(id, ms) {
    const t = shown.get(id)
    if (!t) return
    clearTimeout(t.timer)
    if (ms && !t.keep) t.timer = setTimeout(() => remove(id), ms)
  }

  /** The hidden frame that asks the browser to start Curio; the worker granted it to this tab a moment before. */
  function launchFrame() {
    ensure()
    const f = document.createElement('iframe')
    f.src = chrome.runtime.getURL('launch/launch.html')
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'
    root.append(f)
    setTimeout(() => f.remove(), 15000)
  }

  // kept out of a screenshot; back with the next toast, or after a moment whatever happens
  let hiddenTimer = null
  C.uiHidden = function (on) {
    clearTimeout(hiddenTimer)
    if (hostEl) hostEl.style.visibility = on ? 'hidden' : ''
    if (on) hiddenTimer = setTimeout(() => C.uiHidden(false), 3000)
  }

  /**
   * An overlay to mark an area with the mouse; Esc or a click without a drag gives it up.
   * @param {(rect: { x: number, y: number, w: number, h: number } | null) => void} done
   */
  let cropping = false
  C.cropper = function (done) {
    if (cropping) return
    cropping = true
    ensure()
    const o = document.createElement('div')
    o.className = 'crop'
    o.tabIndex = -1
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = 'Drag to mark an area · Esc to cancel'
    const box = document.createElement('div')
    box.className = 'box'
    box.hidden = true
    o.append(hint, box)
    let from = null
    let rect = null
    const finish = (r) => {
      removeEventListener('keydown', onKey, true)
      o.remove()
      cropping = false
      done(r)
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      finish(null)
    }
    addEventListener('keydown', onKey, true)
    o.addEventListener('mousedown', (e) => {
      if (!e.isTrusted || e.button !== 0) return
      e.preventDefault()
      from = { x: e.clientX, y: e.clientY }
      o.classList.add('marking')
      hint.hidden = true
    })
    o.addEventListener('mousemove', (e) => {
      if (!from) return
      rect = { x: Math.min(from.x, e.clientX), y: Math.min(from.y, e.clientY), w: Math.abs(e.clientX - from.x), h: Math.abs(e.clientY - from.y) }
      Object.assign(box.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' })
      box.hidden = false
    })
    o.addEventListener('mouseup', (e) => {
      if (!from || !e.isTrusted) return
      finish(rect && rect.w >= 4 && rect.h >= 4 ? rect : null)
    })
    root.append(o)
    o.focus()
  }

  /** Whether a node is the extension's own element in the page. */
  C.isOurs = (n) => !!n && n === hostEl

  // ---- the panel in the page: a modal dialog over everything, holding the extension's own page edge to edge, which draws the window and alone talks to Curio ----
  /** @type {{ dialog: HTMLDialogElement, frame: HTMLIFrameElement, mode: string, off: () => void, catcher: HTMLElement | null, at: { x: number, y: number } | null, shown: ((ok: boolean) => void) | null, prevFocus: Element | null, ready?: boolean, droppedAt?: number } | null} */
  let framed = null
  const EXT = new URL(chrome.runtime.getURL('')).origin
  C.frame = {
    /**
     * Opens the panel's page in the page; the worker's secret goes to the frame by message, never in its address, and the frame asks the worker whether it is good.
     * @param {string} secret
     * @param {'panel' | 'drop'} mode
     * @param {{ x: number, y: number } | null} at where the pointer is, for the frame to draw its window beside; the panel a card turns into stays where the card was
     * @returns {Promise<boolean>} whether the frame showed in time
     */
    open(secret, mode, at = null) {
      ensure()
      // the card dropped on becomes the form in place: the same page takes the new secret
      const kept = framed && framed.mode === 'drop' && mode === 'panel' ? framed : null
      if (kept) {
        kept.catcher?.remove()
        kept.catcher = null
        kept.mode = mode
        kept.dialog.className = 'frame ' + mode
        return new Promise((ok) => {
          kept.shown = ok
          kept.frame.contentWindow?.postMessage({ curio: 'grant', secret, at: kept.at }, EXT)
          setTimeout(() => {
            if (kept.shown !== ok) return
            kept.shown = null
            if (framed === kept) C.frame.close()
            ok(false)
          }, 2500)
        })
      }
      this.close()
      const dialog = document.createElement('dialog')
      dialog.className = 'frame ' + mode
      const frame = document.createElement('iframe')
      // the same scheme as the page inside, or the browser paints the frame opaque
      frame.style.colorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      frame.allow = 'clipboard-read; clipboard-write'
      frame.src = chrome.runtime.getURL('panel/panel.html?frame=1&mode=' + mode)
      dialog.append(frame)
      const catcher = mode === 'drop' ? catchDrops(frame) : null
      if (catcher) dialog.append(catcher)
      root.append(dialog)
      return new Promise((ok) => {
        const onMessage = (e) => {
          // the frame's word only, and it carries nothing but what to do
          if (e.source !== frame.contentWindow || e.origin !== EXT || !e.data || typeof e.data.curio !== 'string') return
          if (e.data.curio === 'ready') frame.contentWindow?.postMessage({ curio: 'grant', secret, at }, EXT)
          else if (e.data.curio === 'shown') {
            frame.focus()
            try { frame.contentWindow?.focus() } catch {}
            const done = framed?.frame === frame ? framed.shown : null
            if (framed?.frame === frame) {
              framed.shown = null
              framed.ready = true
            }
            done?.(true)
          } else if (e.data.curio === 'close') C.frame.close()
        }
        const onKey = (e) => {
          if (e.key !== 'Escape' || framed?.frame !== frame) return
          e.preventDefault()
          e.stopImmediatePropagation()
          C.frame.close()
        }
        addEventListener('message', onMessage)
        addEventListener('keydown', onKey, true)
        // Escape while the page has the keyboard
        dialog.addEventListener('cancel', (e) => {
          e.preventDefault()
          C.frame.close()
        })
        const prevFocus = document.activeElement
        framed = { dialog, frame, mode, off: () => { removeEventListener('message', onMessage); removeEventListener('keydown', onKey, true) }, catcher, at, shown: ok, prevFocus }
        try {
          dialog.showModal()
        } catch {
          C.frame.close()
          return ok(false)
        }
        setTimeout(() => {
          if (framed?.frame !== frame || framed.shown !== ok) return
          C.frame.close()
          ok(false)
        }, 2500)
      })
    },
    close() {
      if (!framed) return
      // a frame that goes before it showed answers the worker all the same
      const waiting = framed.shown
      const prev = framed.prevFocus
      framed.shown = null
      waiting?.(false)
      framed.off()
      framed.dialog.close()
      framed.dialog.remove()
      framed = null
      // return keyboard focus to the page so subsequent shortcuts reach it cleanly
      try {
        window.focus()
        if (prev && prev.isConnected && typeof (/** @type {any} */ (prev).focus) === 'function') /** @type {HTMLElement} */ (prev).focus({ preventScroll: true })
      } catch {}
    },
    mode: () => framed?.mode || null,
    /** Whether the drag that just ended was dropped on the card. */
    droppedOn: () => !!framed?.droppedAt && Date.now() - framed.droppedAt < 2000,
  }

  /**
   * Chrome drops nothing from a page into a frame of another process in the same tab, and the card's frame is the extension's.
   * So the page's side takes the drag over the card: where it is goes to the card by message, to light what is under it, and the drop by the extension's messaging, which the page can't send.
   * @param {HTMLIFrameElement} frame
   */
  function catchDrops(frame) {
    const el = document.createElement('div')
    el.className = 'catch'
    let last = ''
    const at = (e) => {
      const r = frame.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const point = (p) => framed?.frame === frame && framed.ready && frame.contentWindow?.postMessage({ curio: 'point', ...p }, EXT)
    // the page's own handlers further up never see these, so none of them can refuse the drop or take it
    const mine = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }
    el.addEventListener('dragenter', mine)
    // no dropEffect: a page's effectAllowed of move or link would refuse a copy
    el.addEventListener('dragover', (e) => {
      mine(e)
      const p = at(e)
      // dragover repeats while the pointer rests; the card scrolls on that, so only a jump within a few pixels is passed over
      const key = Math.round(p.x / 3) + ',' + Math.round(p.y / 3) + ',' + Math.floor(Date.now() / 100)
      if (key === last) return
      last = key
      point(p)
    })
    el.addEventListener('dragleave', (e) => !e.relatedTarget && point({ x: -1, y: -1 }))
    el.addEventListener('drop', (e) => {
      mine(e)
      if (!e.isTrusted || framed?.catcher !== el) return
      framed.droppedAt = Date.now()
      const p = at(e)
      chrome.runtime.sendMessage({ type: 'card.drop', ...p }).catch(() => {})
    })
    return el
  }

  // ---- the drop zone: rows of destinations to drop on, while something is dragged ----
  let zoneEl = null
  C.zone = {
    /**
     * @param {Promise<{ key: string, label: string }[] | null>} rows the worker's destinations for this tab
     * @param {(key: string) => void} pick
     */
    show(x, y, rows, pick) {
      ensure()
      this.hide()
      const z = document.createElement('div')
      z.className = 'zone'
      const head = document.createElement('div')
      head.className = 'head'
      head.textContent = 'Save to Curio'
      z.append(head)
      const add = (key, label, cls = '') => {
        const r = document.createElement('div')
        r.className = 'row ' + cls
        r.textContent = label
        r.addEventListener('dragenter', (e) => (e.preventDefault(), r.classList.add('over')))
        // no dropEffect: a page's effectAllowed of move or link would refuse a copy
        r.addEventListener('dragover', (e) => {
          e.preventDefault()
          e.stopPropagation()
        })
        r.addEventListener('dragleave', () => r.classList.remove('over'))
        r.addEventListener('drop', (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (e.isTrusted) pick(key)
        })
        z.insertBefore(r, z.lastChild && z.lastChild.classList.contains('choose') ? z.lastChild : null)
      }
      add('choose', 'Choose', 'choose')
      rows.then((list) => {
        if (zoneEl === z) for (const row of (list || []).slice(0, 6)) add(row.key, row.label, '')
      })
      z.style.left = Math.max(8, Math.min(innerWidth - 310, x + 24)) + 'px'
      z.style.top = Math.max(8, Math.min(innerHeight - 260, y + 24)) + 'px'
      root.append(z)
      zoneEl = z
    },
    hide() {
      if (zoneEl) zoneEl.remove()
      zoneEl = null
    },
  }

  // ---- the hover button ----
  let hoverEl = null
  C.hoverButton = {
    show(rect, corner, size, click) {
      ensure()
      this.hide()
      const b = document.createElement('button')
      b.className = 'hover-btn'
      b.type = 'button'
      b.title = 'Save to Curio'
      const px = Math.max(20, Math.min(48, Number(size) || 20))
      b.style.width = b.style.height = px + 'px'
      const inset = 6
      const left = /left/.test(corner) ? rect.left + inset : rect.right - px - inset
      const top = /bottom/.test(corner) ? rect.bottom - px - inset : rect.top + inset
      b.style.left = Math.max(0, Math.min(innerWidth - px, left)) + 'px'
      b.style.top = Math.max(0, Math.min(innerHeight - px, top)) + 'px'
      // Curio's own icon (.github/logo.svg)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '83.18 102.94 839.25 839.25')
      svg.setAttribute('width', String(px))
      svg.setAttribute('height', String(px))
      svg.innerHTML = LOGO
      b.append(svg)
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        click(e)
        this.hide()
      })
      root.append(b)
      hoverEl = b
    },
    hide() {
      if (hoverEl) hoverEl.remove()
      hoverEl = null
    },
  }

  /** Takes a capture's toast away. */
  C.untoast = (id) => remove(String(id))

  /**
   * Shows or replaces the toast of one capture.
   * @param {{ id: string, tone: 'busy' | 'ok' | 'error' | 'warn', text: string, sub?: string, actions?: { id: string, label: string }[], theme?: Record<string, string> | null, keep?: boolean }} t
   */
  C.toast = function (t) {
    ensure()
    C.uiHidden(false)
    let entry = shown.get(t.id)
    if (!entry) {
      const el = document.createElement('div')
      el.addEventListener('mouseenter', () => arm(t.id, 0))
      el.addEventListener('mouseleave', () => arm(t.id, 3000))
      entry = { el, timer: null, keep: false }
      shown.set(t.id, entry)
      stack.append(el)
      while (shown.size > 3) remove(shown.keys().next().value)
    }
    const el = entry.el
    entry.keep = !!t.keep
    const themed = t.theme && typeof t.theme === 'object'
    el.className = 'toast ' + t.tone + (themed ? ' themed' : t.theme === 'dark' ? ' dark' : t.theme === 'light' ? ' light' : '')
    if (themed) for (const [k, v] of Object.entries(t.theme)) if (/^[a-z0-9-]+$/.test(k) && typeof v === 'string') el.style.setProperty('--' + k, v)
    const dot = document.createElement('span')
    dot.className = 'dot'
    const body = document.createElement('div')
    body.className = 'body'
    const text = document.createElement('div')
    text.className = 'text'
    text.textContent = t.text
    body.append(text)
    if (t.sub) {
      const sub = document.createElement('div')
      sub.className = 'sub'
      sub.textContent = t.sub
      body.append(sub)
    }
    if (t.actions?.length) {
      const row = document.createElement('div')
      row.className = 'actions'
      for (const a of t.actions) {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = a.label
        b.addEventListener('click', (e) => {
          if (!e.isTrusted) return
          chrome.runtime.sendMessage({ type: 'toast.action', captureId: t.id, action: a.id }).catch(() => {})
          // in the click itself, as the browser asks of a page that opens another program
          if (a.id === 'launch') launchFrame()
          remove(t.id)
        })
        row.append(b)
      }
      body.append(row)
    }
    const close = document.createElement('button')
    close.className = 'close'
    close.type = 'button'
    close.title = 'Close'
    close.textContent = '×'
    close.addEventListener('click', () => remove(t.id))
    el.replaceChildren(dot, body, close)
    arm(t.id, t.tone === 'busy' ? 60000 : t.tone === 'ok' ? (t.actions?.length ? 6000 : 3500) : 10000)
  }
})(globalThis)
