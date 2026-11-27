// Shared by the fixture pages: where a case's element is in the top window, and what the browser's own menu would know of it.
(function () {
  function find(name, doc) {
    const el = doc.querySelector(`[data-case="${name}"]`)
    if (el) return el
    for (const host of doc.querySelectorAll('*')) {
      if (host.shadowRoot) {
        const inner = find(name, host.shadowRoot)
        if (inner) return inner
      }
    }
    for (const f of doc.querySelectorAll('iframe')) {
      try {
        const inner = f.contentDocument && find(name, f.contentDocument)
        if (inner) return inner
      } catch {}
    }
    return null
  }
  function offset(el) {
    let x = 0
    let y = 0
    let win = el.ownerDocument.defaultView
    while (win && win !== window) {
      const r = win.frameElement.getBoundingClientRect()
      x += r.left
      y += r.top
      win = win.parent
    }
    return { x, y }
  }
  window.fixture = {
    cases() {
      const out = []
      const walk = (doc) => {
        for (const el of doc.querySelectorAll('[data-case]')) out.push({ name: el.dataset.case, expect: JSON.parse(el.dataset.expect || '{}') })
        for (const host of doc.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot)
        for (const f of doc.querySelectorAll('iframe')) {
          try {
            if (f.contentDocument) walk(f.contentDocument)
          } catch {}
        }
      }
      walk(document)
      return out
    },
    locate(name) {
      const el = find(name, document)
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = (el.dataset.point ? el.ownerDocument.querySelector(el.dataset.point) : el).getBoundingClientRect()
      const o = offset(el)
      return { x: Math.round(o.x + r.left + Math.min(r.width / 2, 20)), y: Math.round(o.y + r.top + Math.min(r.height / 2, 20)) }
    },
    // the browser's menu sees the topmost element: an overlay hides the picture from it, as on real sites
    menuInfo(name) {
      const p = this.locate(name)
      let doc = document
      let x = p.x
      let y = p.y
      let hit = doc.elementFromPoint(x, y)
      while (hit && hit.tagName === 'IFRAME') {
        const r = hit.getBoundingClientRect()
        x -= r.left
        y -= r.top
        doc = hit.contentDocument
        hit = doc.elementFromPoint(x, y)
      }
      const info = { pageUrl: location.href }
      if (hit && hit.tagName === 'IMG') Object.assign(info, { mediaType: 'image', srcUrl: hit.currentSrc || hit.src })
      else if (hit && (hit.tagName === 'VIDEO' || hit.tagName === 'AUDIO')) Object.assign(info, { mediaType: hit.tagName.toLowerCase(), srcUrl: hit.currentSrc || hit.src })
      const a = hit && hit.closest && hit.closest('a[href]')
      if (a) info.linkUrl = a.href
      if (doc !== document) info.frameUrl = doc.location.href
      return info
    },
  }
})()
