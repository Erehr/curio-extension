// @ts-check
// From an element under the pointer to a draft: what to collect, its largest source, where it came from and its title.
;(function (G) {
  'use strict'
  const C = (G.CurioCompanion = G.CurioCompanion || {})

  /**
   * A srcset's candidates; addresses may hold commas, so it is read as the HTML standard does: an address up to whitespace, then descriptors up to a comma.
   * @returns {{ url: string, w: number, x: number }[]}
   */
  C.parseSrcset = function (srcset, base) {
    const out = []
    const s = String(srcset || '')
    let i = 0
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++
      if (i >= s.length) break
      let j = i
      while (j < s.length && !/\s/.test(s[j])) j++
      let url = s.slice(i, j)
      let desc = ''
      if (url.endsWith(',')) url = url.replace(/,+$/, '')
      else {
        let k = j
        while (k < s.length && s[k] !== ',') k++
        desc = s.slice(j, k).trim()
        j = k
      }
      i = j + 1
      if (!url) continue
      let w = 0
      let x = 0
      for (const d of desc.split(/\s+/)) {
        if (/^\d+w$/.test(d)) w = parseInt(d, 10)
        else if (/^\d*\.?\d+x$/.test(d)) x = parseFloat(d)
      }
      try {
        out.push({ url: new URL(url, base).href, w, x: x || (w ? 0 : 1) })
      } catch {}
    }
    return out
  }

  /** The largest candidate: by width, then by density. */
  C.largest = function (list) {
    return [...list].sort((a, b) => b.w - a.w || b.x - a.x)[0] || null
  }

  /** Whether a file's base name reads as a name, not a hash, a UUID, a run of digits or a CDN key. */
  C.readableName = function (name) {
    const s = String(name || '').trim()
    if (s.length < 2) return false
    if (/^[0-9a-f]{12,}$/i.test(s)) return false
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return false
    if (/^[\d_\-. ]+$/.test(s)) return false
    // long runs of letters and digits without a separator are keys, not names
    if (/^[A-Za-z0-9]{16,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) return false
    if (/^(image|img|photo|picture|file|download|media|original|large|small|thumb|thumbnail|default|index|unknown)$/i.test(s)) return false
    return true
  }

  C.fileBase = function (url) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
      return last.replace(/\.[a-z0-9]{1,5}$/i, '')
    } catch {
      return ''
    }
  }

  /** The first title there is: the page's own word, the element's text alternatives, a readable file name, then the page's title. */
  C.titleOf = function ({ attr = '', alt = '', title = '', aria = '', caption = '', url = '', pageTitle = '' }) {
    for (const t of [attr, alt, title, aria, caption]) {
      const s = C.text(t, C.LIMITS.title)
      if (s) return s
    }
    const base = C.fileBase(url)
    if (C.readableName(base)) return C.text(base.replace(/[_+]+/g, ' '), C.LIMITS.title)
    return C.text(pageTitle, C.LIMITS.title)
  }

  /** A picture's address looks like a file: the anchor around it leads to the picture, not to a page about it. */
  C.looksLikeFile = function (url) {
    try {
      return /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|mp4|webm|mov|mp3|ogg|wav|flac|pdf|zip)$/i.test(new URL(url).pathname)
    } catch {
      return false
    }
  }

  // ---- the DOM ----

  const MEDIA = 'img, picture, video, audio, svg, canvas'

  function parentOf(el) {
    if (el.parentElement) return el.parentElement
    const root = el.getRootNode && el.getRootNode()
    return root && root.host ? root.host : null
  }

  function closest(el, selector) {
    for (let e = el; e; e = parentOf(e)) if (e.nodeType === 1 && e.matches(selector)) return e
    return null
  }

  function bigEnough(el, min) {
    const r = el.getBoundingClientRect()
    // an svg's width is an SVGAnimatedLength, not a number
    const num = (...v) => v.find((x) => typeof x === 'number' && x > 0) || 0
    const nw = num(el.naturalWidth, el.videoWidth, el.width)
    const nh = num(el.naturalHeight, el.videoHeight, el.height)
    if (nw === 1 && nh === 1) return false
    if (el.tagName === 'AUDIO') return true
    return Math.max(r.width, nw) >= min && Math.max(r.height, nh) >= min
  }

  const bgUrl = (el) => {
    const m = getComputedStyle(el).backgroundImage.match(/url\(\s*(['"]?)(.*?)\1\s*\)/)
    return m ? m[2] : ''
  }

  function mediaAt(el, min) {
    let m = closest(el, MEDIA)
    if (m && m.tagName === 'PICTURE') m = m.querySelector('img')
    if (m && m.tagName.toLowerCase() === 'svg') while (m.ownerSVGElement) m = m.ownerSVGElement
    if (m && bigEnough(m, min)) return m
    return null
  }

  function backgroundAt(el, min) {
    let e = el
    for (let i = 0; e && i < 6; i++, e = parentOf(e)) {
      if (e.nodeType !== 1) continue
      if (bgUrl(e)) {
        const r = e.getBoundingClientRect()
        if (r.width >= min && r.height >= min) return e
      }
    }
    return null
  }

  function underPoint(root, x, y, min, seen = new Set()) {
    if (!root.elementsFromPoint) return null
    for (const e of root.elementsFromPoint(x, y)) {
      if (seen.has(e)) continue
      seen.add(e)
      if (e.shadowRoot && !seen.has(e.shadowRoot)) {
        seen.add(e.shadowRoot)
        const inner = underPoint(e.shadowRoot, x, y, min, seen)
        if (inner) return inner
      }
      if (e.matches(MEDIA) && bigEnough(e, min)) return e.tagName === 'PICTURE' ? e.querySelector('img') : e
      if (bgUrl(e)) {
        const r = e.getBoundingClientRect()
        if (r.width >= min && r.height >= min) return e
      }
    }
    return null
  }

  function kindOf(el) {
    const t = el.tagName.toLowerCase()
    if (t === 'img') return 'image'
    if (t === 'video' || t === 'audio') return t
    if (t === 'svg') return 'svg'
    if (t === 'canvas') return 'canvas'
    return bgUrl(el) ? 'image' : 'file'
  }

  /** Whether the document itself is a direct image, video, or audio file (by content type or media URL). */
  C.directMedia = function () {
    const url = location.href
    if (!/^https?:/i.test(url)) return null
    const ct = String(document.contentType || '').toLowerCase()
    let kind = ct.startsWith('image/') ? 'image' : ct.startsWith('video/') ? 'video' : ct.startsWith('audio/') ? 'audio' : ''
    if (!kind) {
      const byExt = C.directMediaKind(url)
      if (byExt && (!document.body || document.body.children.length <= 1) && !document.querySelector('a, p, article, main')) kind = byExt
    }
    if (!kind) return null
    const el = kind === 'image' ? document.querySelector('body > img') : document.querySelector(kind === 'video' ? 'body > video' : 'body > audio')
    return { el: el || null, kind, directUrl: url }
  }

  /** Resolves a site rule's File selector match into a collectable target (element itself, its media child, or a direct-file link). */
  C.targetFromElement = function (el, eagle = true) {
    if (!el || el.nodeType !== 1) return null
    if (el.tagName === 'PICTURE') {
      const img = el.querySelector('img')
      if (img) return { el: img, kind: 'image' }
    }
    const marked = '[data-curio-src], [data-curio-collectable], [curio-src], [curio-collectable]' + (eagle ? ', [eagle-src]' : '')
    if (el.matches(marked)) return { el, kind: el.matches(MEDIA) ? kindOf(el) : 'image', marked: true }
    if (el.matches(MEDIA)) return { el, kind: kindOf(el) }
    if (el.tagName === 'A' && /** @type {HTMLAnchorElement} */ (el).href) {
      const href = /** @type {HTMLAnchorElement} */ (el).href
      const mk = C.directMediaKind(href)
      if (mk) return { el, kind: mk, fromLink: true }
      if (C.looksLikeFile(href)) return { el, kind: 'file', fromLink: true }
      const inner = el.querySelector(MEDIA)
      if (inner) return C.targetFromElement(inner, eagle)
      return { el, kind: 'link' }
    }
    if (bgUrl(el)) return { el, kind: 'image' }
    const inner = el.querySelector(MEDIA)
    if (inner) return C.targetFromElement(inner, eagle)
    const link = el.querySelector('a[href]')
    if (link) return C.targetFromElement(link, eagle)
    return null
  }

  /**
   * What to collect from where the pointer was, nearest first: an element the page marked, media, a background picture, media under an overlay, a link, else the page.
   * @returns {{ el: Element | null, kind: string, marked?: boolean }}
   */
  C.findTarget = function (target, point, min, eagle) {
    const marked = '[data-curio-src], [data-curio-collectable], [curio-src], [curio-collectable]' + (eagle ? ', [eagle-src]' : '')
    if (target && target.nodeType === 1) {
      const m = closest(target, marked)
      if (m) return { el: m, kind: m.matches(MEDIA) ? kindOf(m) : 'image', marked: true }
      const media = mediaAt(target, min)
      if (media) return { el: media, kind: kindOf(media) }
      const bg = backgroundAt(target, min)
      if (bg) return { el: bg, kind: 'image' }
    }
    if (point) {
      const under = underPoint(document, point.x, point.y, min)
      if (under) return { el: under, kind: kindOf(under) }
    }
    const a = target && target.nodeType === 1 ? closest(target, 'a[href]') : null
    if (a) return { el: a, kind: 'link' }
    return { el: null, kind: 'page' }
  }

  function attrsOf(el) {
    const o = {}
    for (const a of el.attributes) o[a.name.toLowerCase()] = a.value
    return o
  }

  /** The element and every ancestor, through shadow roots, as attribute maps. */
  C.levelsOf = function (el) {
    const levels = []
    for (let e = el; e && levels.length < 64; e = parentOf(e)) if (e.nodeType === 1) levels.push(attrsOf(e))
    return levels
  }

  C.metas = function () {
    const out = {}
    for (const m of document.querySelectorAll('meta[name^="curio:" i]')) {
      const name = m.getAttribute('name').slice(6).toLowerCase()
      if (!(name in out)) out[name] = m.getAttribute('content') || ''
    }
    return out
  }

  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || ''

  function sourceOf(el, kind) {
    if (kind === 'image' && el.tagName === 'IMG') {
      const img = /** @type {HTMLImageElement} */ (el)
      const list = C.parseSrcset(img.getAttribute('srcset'), document.baseURI)
      const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null
      if (pic) for (const s of pic.querySelectorAll('source[srcset]')) if (!s.getAttribute('media') || matchMedia(s.getAttribute('media')).matches) list.push(...C.parseSrcset(s.getAttribute('srcset'), document.baseURI))
      const best = C.largest(list.filter((c) => c.w || c.x))
      const shown = img.currentSrc || img.src
      return { src: best && best.url !== shown ? best.url : shown, shown }
    }
    if ((kind === 'video' || kind === 'audio') && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
      const m = /** @type {HTMLMediaElement} */ (el)
      const sources = [...m.querySelectorAll('source[src]')].map((x) => /** @type {HTMLSourceElement} */ (x).src).filter(Boolean)
      const direct = (u) => /^https?:/i.test(u) && !/\.(m3u8|mpd)([?#]|$)/i.test(u)
      const s = (direct(m.currentSrc) && m.currentSrc) || (direct(m.src) && m.src) || sources.find(direct) || m.currentSrc || m.src || sources[0] || ''
      return { src: s, shown: s }
    }
    if (kind === 'svg' || kind === 'canvas') return { src: '', shown: '' }
    const bg = bgUrl(el)
    if (bg) {
      try {
        const u = new URL(bg, document.baseURI).href
        return { src: u, shown: u }
      } catch {}
    }
    const any = el.getAttribute('src') || el.getAttribute('href') || ''
    try {
      const u = any ? new URL(any, document.baseURI).href : ''
      return { src: u, shown: u }
    } catch {
      return { src: '', shown: '' }
    }
  }

  const inPageRegistry = new Map()
  C.inPage = inPageRegistry

  function keepInPage(el, src) {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    inPageRegistry.set(id, { el, src })
    setTimeout(() => inPageRegistry.delete(id), 5 * 60 * 1000)
    return id
  }

  /**
   * The draft of what was found.
   * @param {{ el: Element | null, kind: string }} found
   * @param {{ eagle: boolean, info?: any }} opts
   */
  C.draftOf = function (found, opts) {
    const { el } = found
    let kind = found.kind
    const info = opts.info || {}
    const pageUrl = location.href
    const top = window === window.top
    const pageTitle = top ? meta('meta[property="og:title"]') || document.title : document.title
    const levels = el ? C.levelsOf(el) : [attrsOf(document.documentElement)]
    const h = C.cleanHints(C.rawHints(levels, C.metas(), opts.eagle), document.baseURI, pageUrl)
    let src = ''
    let shown = ''
    if (found.directUrl) {
      src = shown = found.directUrl
    } else {
      if (el && kind !== 'link') ({ src, shown } = sourceOf(el, kind))
      if (kind === 'link' && el) src = /** @type {HTMLAnchorElement} */ (el).href
      if (kind === 'page') src = pageUrl
    }
    if (!el && info.srcUrl && info.mediaType) {
      kind = info.mediaType === 'image' ? 'image' : info.mediaType
      src = shown = info.srcUrl
    } else if (kind === 'page' && info.linkUrl) {
      kind = 'link'
      src = info.linkUrl
    }
    const srcFromAttr = !!h.src
    if (h.src) src = h.src
    // a stream (a playlist, or a blob: that MediaSource feeds) has no file to fetch: its page goes, for a plugin that takes such pages, else as a link
    // a blob: of a whole file is taken for a stream too, so it is saved as its page rather than failing
    const stream = (kind === 'video' || kind === 'audio') && !h.src && (/^blob:/i.test(src) || /\.(m3u8|mpd)([?#]|$)/i.test(src))
    if (stream) {
      kind = 'link'
      src = pageUrl
    }
    if (found.marked && !h.src && kind !== 'svg' && kind !== 'canvas' && !src) kind = 'page'
    const inPage = kind === 'svg' || kind === 'canvas' || /^(blob|data):/i.test(src)
    const candidates = inPage ? [] : [...new Set([src, shown].filter((u) => /^https?:/i.test(u)))]
    const anchor = el && kind !== 'link' ? el.closest && el.closest('a[href]') : null
    let link = h.link || ''
    if (!link && anchor && /^https?:/i.test(anchor.href) && (C.sameSite(anchor.href, pageUrl) || !C.looksLikeFile(anchor.href))) link = anchor.href
    // in a frame, the worker puts the top page's address in its place
    if (!link && top) link = pageUrl
    const caption = el && el.closest && el.closest('figure')?.querySelector('figcaption')?.textContent
    let title
    if (kind === 'page' || stream) title = h.title || pageTitle
    else if (kind === 'link') title = h.title || C.text(el?.textContent, C.LIMITS.title) || el?.getAttribute('title') || C.titleOf({ url: src })
    else title = C.titleOf({ attr: h.title, alt: el?.getAttribute('alt') || '', title: el?.getAttribute('title') || '', aria: el?.getAttribute('aria-label') || '', caption: caption || '', url: src || shown, pageTitle })
    let notes = h.notes || ''
    if (!notes && kind === 'page' && top) notes = C.text(meta('meta[property="og:description"]') || meta('meta[name="description"]'), C.LIMITS.notes, true)
    if (kind === 'page' && top) {
      const canon = document.querySelector('link[rel="canonical"]')?.getAttribute('href')
      const c = canon ? C.httpUrl(canon, document.baseURI) : ''
      if (c && C.sameSite(c, pageUrl)) src = c
    }
    const r = el ? el.getBoundingClientRect() : null
    return {
      kind,
      src: inPage && kind !== 'svg' && kind !== 'canvas' ? (src.length > C.LIMITS.url ? 'data:' : src) : src,
      candidates,
      inPage,
      inPageId: el && kind !== 'link' && kind !== 'page' ? keepInPage(el, src) : undefined,
      srcFromAttr,
      pageUrl,
      pageTitle,
      link,
      title,
      notes,
      tags: h.tags || [],
      rating: h.rating,
      favorite: h.favorite,
      explicit: h.explicit,
      fields: h.fields,
      hints: { library: h.library, folders: h.folders },
      type: stream ? 'link' : h.type || (found.directUrl || found.fromLink ? 'file' : ''),
      stream,
      referer: h.referer || '',
      size: r ? { w: Math.round(r.width), h: Math.round(r.height) } : undefined,
    }
  }

  /** Whether the page asked to wait: data-curio-pending (or eagle-src-loading) on the element or an ancestor. */
  C.isPending = function (el, eagle) {
    const sel = '[data-curio-pending], [curio-pending]' + (eagle ? ', [eagle-src-loading]' : '')
    for (let e = el; e; e = parentOf(e)) if (e.nodeType === 1 && e.matches(sel)) return true
    return false
  }

  /** The bytes of a source only the page can read. */
  C.readInPage = async function (entry) {
    const { el, src } = entry
    const tag = el.tagName.toLowerCase()
    if (tag === 'svg') {
      const clone = el.cloneNode(true)
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' })
    }
    if (tag === 'canvas') return await new Promise((ok, no) => {
      try {
        el.toBlob((b) => (b ? ok(b) : no(new Error('The canvas gave nothing'))), 'image/png')
      } catch (e) {
        no(e)
      }
    })
    const r = await fetch(src, { credentials: 'include' })
    if (!r.ok) throw new Error(`The page got ${r.status}`)
    return await r.blob()
  }
})(globalThis)
