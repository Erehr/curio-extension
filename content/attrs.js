// @ts-check
// The attribute contract: data-curio-* (and curio-*, and eagle-* as a fallback) read from an element and its ancestors, checked and cut to size.
// Loaded as a content script and imported by the worker and the tests, so it puts what it gives on globalThis.CurioCompanion.
;(function (G) {
  'use strict'
  const C = (G.CurioCompanion = G.CurioCompanion || {})

  const NAMES = ['src', 'title', 'link', 'annotation', 'tags', 'rating', 'favorite', 'explicit', 'fields', 'library', 'folders', 'type', 'referer', 'collectable', 'pending']
  const EAGLE = { src: 'eagle-src', title: 'eagle-title', link: 'eagle-link', annotation: 'eagle-annotation', tags: 'eagle-tags', pending: 'eagle-src-loading' }
  const LIMITS = { title: 200, notes: 10000, tags: 50, tag: 100, fields: 32, fieldText: 2000, url: 4096, library: 200, folders: 20, folderPart: 200, candidates: 12 }
  C.LIMITS = LIMITS
  C.ATTRIBUTE_NAMES = NAMES

  function parseJson(v) {
    if (typeof v !== 'string') return v
    try {
      return JSON.parse(v)
    } catch {
      return undefined
    }
  }

  function objectOf(v) {
    const o = parseJson(v)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  }

  /**
   * The raw value of each name: per level, nearest first, a single attribute wins over that level's data-curio object; `<meta name="curio:…">` is the furthest level; eagle-* only where nothing else gave the value.
   * @param {Record<string, string>[]} levels attributes of the element, then each ancestor
   * @param {Record<string, string>} [metas]
   * @param {boolean} [eagle]
   */
  C.rawHints = function (levels, metas = {}, eagle = true) {
    /** @type {Record<string, unknown>} */
    const out = {}
    const objects = levels.map((a) => objectOf(a['data-curio'] ?? a['curio']))
    for (const name of NAMES) {
      let v
      for (let i = 0; i < levels.length && v === undefined; i++) {
        const a = levels[i]
        if ('data-curio-' + name in a) v = a['data-curio-' + name]
        else if ('curio-' + name in a) v = a['curio-' + name]
        else if (objects[i] && name in objects[i]) v = objects[i][name]
      }
      if (v === undefined && name in metas) v = metas[name]
      if (v === undefined && eagle && EAGLE[name]) {
        for (const a of levels) {
          if (EAGLE[name] in a) {
            v = a[EAGLE[name]]
            break
          }
        }
      }
      if (v !== undefined) out[name] = v
    }
    return out
  }

  /** Text without control characters (newlines kept where asked), trimmed and cut. */
  C.text = function (v, max, lines = false) {
    if (v == null || typeof v === 'object') return ''
    let s = String(v)
    s = lines ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ')
    return s.trim().slice(0, max).trim()
  }

  /** An http or https address resolved against the page, or ''. */
  C.httpUrl = function (v, base) {
    if (typeof v !== 'string' || !v.trim() || v.length > LIMITS.url) return ''
    try {
      const u = new URL(v.trim(), base)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
    } catch {
      return ''
    }
  }

  C.tags = function (v) {
    let list = parseJson(v)
    if (!Array.isArray(list)) list = typeof v === 'string' ? v.split(',') : []
    const seen = new Set()
    const out = []
    for (const t of list) {
      if (typeof t !== 'string' && typeof t !== 'number') continue
      const s = C.text(t, LIMITS.tag)
      const k = s.toLowerCase()
      if (s && !seen.has(k)) {
        seen.add(k)
        out.push(s)
      }
      if (out.length >= LIMITS.tags) break
    }
    return out
  }

  C.fields = function (v) {
    const o = objectOf(v)
    if (!o) return {}
    const out = {}
    for (const [k, val] of Object.entries(o)) {
      if (Object.keys(out).length >= LIMITS.fields) break
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue
      if (typeof val === 'string') out[k] = C.text(val, LIMITS.fieldText, true)
      else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
      else if (typeof val === 'boolean') out[k] = val
      else if (Array.isArray(val)) out[k] = val.filter((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))).slice(0, 50).map((x) => (typeof x === 'string' ? C.text(x, LIMITS.tag) : x))
    }
    return out
  }

  /** Folder ids as numbers and paths as text, from a JSON array or one value. */
  C.folders = function (v) {
    let list = parseJson(v)
    if (list === undefined) list = v
    if (!Array.isArray(list)) list = [list]
    const out = []
    for (const f of list) {
      if (out.length >= LIMITS.folders) break
      if (typeof f === 'number' && Number.isInteger(f) && f > 0) out.push(f)
      else if (typeof f === 'string') {
        if (/^\d+$/.test(f.trim())) {
          out.push(Number(f.trim()))
          continue
        }
        const parts = f.split('/').map((p) => C.text(p, LIMITS.folderPart)).filter(Boolean).slice(0, 16)
        if (parts.length) out.push(parts.join('/'))
      }
    }
    return out
  }

  const present = (v) => v !== undefined && v !== null && v !== false && v !== 'false'
  const flag = (v) => present(v) && v !== '0' && v !== 0

  /**
   * The checked hints a page gave: text cut to size, addresses to http and https, a referer only on the page's own site.
   * @param {Record<string, unknown>} raw
   * @param {string} base
   * @param {string} pageUrl
   */
  C.cleanHints = function (raw, base, pageUrl) {
    /** @type {any} */
    const h = {}
    if (raw.src != null) {
      const u = C.httpUrl(raw.src, base)
      if (u) h.src = u
    }
    if (raw.title != null) {
      const t = C.text(raw.title, LIMITS.title)
      if (t) h.title = t
    }
    if (raw.link != null) {
      const u = C.httpUrl(raw.link, base)
      if (u) h.link = u
    }
    if (raw.annotation != null) {
      const t = C.text(raw.annotation, LIMITS.notes, true)
      if (t) h.notes = t
    }
    if (raw.tags != null) h.tags = C.tags(raw.tags)
    if (raw.rating != null && raw.rating !== '') {
      const n = Number(raw.rating)
      if (Number.isFinite(n)) h.rating = Math.max(0, Math.min(5, Math.round(n)))
    }
    if (flag(raw.favorite)) h.favorite = true
    if (flag(raw.explicit)) h.explicit = true
    if (raw.fields != null) h.fields = C.fields(raw.fields)
    if (raw.library != null) {
      const l = C.text(raw.library, LIMITS.library)
      if (l) h.library = l
    }
    if (raw.folders != null) h.folders = C.folders(raw.folders)
    if (raw.type === 'file' || raw.type === 'link') h.type = raw.type
    if (raw.referer != null) {
      const u = C.httpUrl(raw.referer, base)
      if (u && C.sameSite(u, pageUrl)) h.referer = u
    }
    if (present(raw.collectable)) h.collectable = true
    if (present(raw.pending)) h.pending = true
    return h
  }

  const hostOf = (u) => {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    } catch {
      return ''
    }
  }
  C.hostOf = hostOf

  /** Loopback, private, link-local and .local addresses: what a page on the internet must not make the extension fetch. */
  C.isPrivateHost = function (host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
    if (!h) return true
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0') return true
    const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])]
      return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    }
    if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:')
    return false
  }

  const TWO_PART = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/
  /** The site of a host, roughly its registrable domain: the last two labels, three under such as co.uk. */
  C.siteOf = function (host) {
    const h = String(host || '').toLowerCase()
    if (/^[\d.]+$/.test(h) || h.includes(':')) return h
    const parts = h.split('.')
    return parts.slice(TWO_PART.test(h) ? -3 : -2).join('.')
  }
  C.sameSite = (a, b) => {
    const x = hostOf(a)
    const y = hostOf(b)
    return !!x && !!y && C.siteOf(x) === C.siteOf(y)
  }

  /** Whether a URL points directly at an image, video, or audio file by its extension; '' otherwise. */
  C.directMediaKind = function (url) {
    try {
      const p = new URL(url).pathname
      if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|ico|jxl|heic|heif)$/i.test(p)) return 'image'
      if (/\.(mp4|webm|mov|m4v|mkv|ogv)$/i.test(p)) return 'video'
      if (/\.(mp3|ogg|wav|flac|m4a|aac|opus)$/i.test(p)) return 'audio'
    } catch {}
    return ''
  }

  const KEY_CODES = {
    space: 'Space',
    comma: 'Comma',
    period: 'Period',
    '-': 'Minus',
    minus: 'Minus',
    '=': 'Equal',
    equal: 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '/': 'Slash',
    '\\': 'Backslash',
    '`': 'Backquote',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    insert: 'Insert',
    delete: 'Delete',
    mediaNextTrack: 'MediaTrackNext',
    mediaPrevTrack: 'MediaTrackPrevious',
    mediaPlayPause: 'MediaPlayPause',
    mediaStop: 'MediaStop',
  }

  /** Parses a browser command shortcut string (e.g. "Alt+D", "Ctrl+Shift+S", or macOS "⌥D") into modifier flags and KeyboardEvent code. */
  C.parseShortcut = function (shortcut) {
    let raw = String(shortcut || '').trim()
    if (!raw) return null
    let alt = false
    let ctrl = false
    let shift = false
    let meta = false
    // macOS Chrome sometimes formats chrome.commands.getAll() shortcuts with modifier glyphs
    if (/[⌥⌃⇧⌘]/.test(raw) && !raw.includes('+')) {
      alt = raw.includes('⌥')
      ctrl = raw.includes('⌃')
      shift = raw.includes('⇧')
      meta = raw.includes('⌘')
      raw = raw.replace(/[⌥⌃⇧⌘\s]+/g, '')
    }
    const parts = raw.includes('+') ? raw.split('+').map((p) => p.trim()).filter(Boolean) : [raw]
    let main = ''
    for (const p of parts) {
      const low = p.toLowerCase()
      if (low === 'alt' || low === 'option') alt = true
      else if (low === 'ctrl' || low === 'control' || low === 'macctrl') ctrl = true
      else if (low === 'shift') shift = true
      else if (low === 'command' || low === 'cmd' || low === 'meta') meta = true
      else main = p
    }
    if (!main || (!alt && !ctrl && !meta)) return null
    let code = ''
    const up = main.toUpperCase()
    if (/^[A-Z]$/.test(up)) code = 'Key' + up
    else if (/^[0-9]$/.test(up)) code = 'Digit' + up
    else if (/^F([1-9]|1[0-2])$/.test(up)) code = up
    else code = KEY_CODES[main.toLowerCase()] || KEY_CODES[main] || ''
    if (!code) return null
    return { alt, ctrl, shift, meta, code, key: up }
  }

  /** Whether a KeyboardEvent matches a parsed shortcut (ignoring key repeat, IME composition, and AltGr). */
  C.matchesShortcut = function (e, parsed) {
    if (!e || !parsed || e.repeat || e.isComposing) return false
    if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return false
    if (!!e.altKey !== parsed.alt || !!e.ctrlKey !== parsed.ctrl || !!e.shiftKey !== parsed.shift || !!e.metaKey !== parsed.meta) return false
    if (e.code) return e.code === parsed.code
    return String(e.key || '').toUpperCase() === parsed.key
  }

  /** Whether the extension may fetch an address for a page: blob: and data: always, a web address on this computer or its network only for a page that is on one itself. */
  C.fetchable = function (u, pageUrl) {
    if (typeof u !== 'string') return false
    if (/^(blob|data):/i.test(u)) return true
    const ok = C.httpUrl(u, undefined)
    return !!ok && (C.isPrivateHost(hostOf(pageUrl)) || !C.isPrivateHost(hostOf(ok)))
  }

  /**
   * A checked draft's candidates with the larger versions site rules give, checked again, since a rule's address comes from the page too.
   * @param {any} d
   * @param {(u: string) => string[]} expand
   */
  C.expandCandidates = function (d, expand) {
    if (d.inPage || d.kind === 'link' || d.kind === 'page') return d
    const all = [...new Set(d.candidates.flatMap((c) => expand(c)))]
    return { ...d, candidates: all.filter((u) => C.fetchable(u, d.pageUrl) && u.length <= LIMITS.url).slice(0, LIMITS.candidates) }
  }

  const KINDS = new Set(['image', 'video', 'audio', 'svg', 'canvas', 'file', 'link', 'page'])

  /**
   * A draft from a content script, checked again in the worker: it is a page's word.
   * @param {any} d
   * @param {string} pageUrl the tab's address as the browser reports it
   */
  /** Where the element showed in the top frame's viewport, in CSS pixels, for the panel's preview when its address won't load there. */
  const box = (b) => {
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
    const o = { x: Math.max(0, n(b?.x)), y: Math.max(0, n(b?.y)), w: n(b?.w), h: n(b?.h), vw: n(b?.vw) }
    return Object.values(o).every((v) => !Number.isNaN(v)) && o.w >= 8 && o.h >= 8 && o.vw >= 1 ? o : undefined
  }

  C.checkDraft = function (d, pageUrl) {
    const page = C.httpUrl(pageUrl, undefined) || ''
    const allowed = (u) => C.fetchable(u, page)
    let kind = KINDS.has(d?.kind) ? d.kind : 'page'
    const inPage = !!d?.inPage
    let src = typeof d?.src === 'string' ? d.src : ''
    if (/^data:/i.test(src) && src.length > LIMITS.url) src = 'data:'
    // a link is saved as its address and never fetched by the extension, so any web address will do
    if (kind === 'link') src = C.httpUrl(src, undefined)
    else if (!allowed(src) && !(inPage && /^(blob|data):/i.test(src))) src = ''
    if (kind === 'link' && !src) kind = 'page'
    const candidates = (Array.isArray(d?.candidates) ? d.candidates : []).filter((c) => allowed(c) && String(c).length <= LIMITS.url).slice(0, LIMITS.candidates)
    const out = {
      kind,
      src,
      candidates: candidates.length || !src || !allowed(src) ? candidates : [src],
      inPage,
      inPageId: typeof d?.inPageId === 'string' ? d.inPageId.slice(0, 64) : undefined,
      srcFromAttr: !!d?.srcFromAttr,
      pageUrl: page,
      pageTitle: C.text(d?.pageTitle, LIMITS.title),
      link: C.httpUrl(d?.link, undefined) || page,
      title: C.text(d?.title, LIMITS.title),
      notes: C.text(d?.notes, LIMITS.notes, true),
      tags: C.tags(Array.isArray(d?.tags) ? JSON.stringify(d.tags) : ''),
      rating: typeof d?.rating === 'number' && Number.isFinite(d.rating) ? Math.max(0, Math.min(5, Math.round(d.rating))) : undefined,
      favorite: d?.favorite === true ? true : undefined,
      explicit: d?.explicit === true ? true : undefined,
      fields: C.fields(d?.fields && typeof d.fields === 'object' ? JSON.stringify(d.fields) : ''),
      hints: {
        library: d?.hints?.library ? C.text(d.hints.library, LIMITS.library) : undefined,
        folders: d?.hints?.folders ? C.folders(JSON.stringify(d.hints.folders)) : undefined,
      },
      type: d?.type === 'file' || d?.type === 'link' ? d.type : '',
      stream: kind === 'link' && !!d?.stream,
      referer: d?.referer && C.sameSite(d.referer, page) ? C.httpUrl(d.referer, undefined) : '',
      size: d?.size && Number.isFinite(d.size.w) && Number.isFinite(d.size.h) ? { w: d.size.w, h: d.size.h } : undefined,
      box: box(d?.box),
    }
    if (kind === 'page') {
      out.src = page
      out.candidates = []
    }
    return out
  }
})(globalThis)
