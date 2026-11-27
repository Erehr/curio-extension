// curio.js: Curio's web API for scripts, userscripts, browser extensions, Node and plugin pages. See docs/api/client.md.
// Served by the running app at http://127.0.0.1:41733/api/v1/curio.js and, for plugin pages, at /curio/ui/curio.js; its types are in curio.d.ts beside it.
//   const curio = Curio.connect({ token: 'curio_…' })   // in a plugin page, or a plugin's program in Node: Curio.connect()
//   const { items } = await curio.item.query({ query: 'tag = sky', limit: 10 })
//   curio.on('items.added', (e) => console.log(e.library, e.data.ids))
// Every operation in docs/api/operations.md is a method: item.add.fromUrls is curio.item.add.fromUrls(params).
var Curio = (function () {
  'use strict'

  var RETRY_MS = 3000

  class CurioError extends Error {
    constructor(code, message, status) {
      super(message)
      this.name = 'CurioError'
      this.code = code
      this.status = status || 0
    }
  }

  // a userscript's GM_xmlhttpRequest reaches 127.0.0.1 from any page, past the page's CSP and CORS
  function gmRequest() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest
    if (typeof GM === 'object' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest
    return null
  }

  // Violentmonkey and others hand a response over only once it ends, so events go through fetch there
  function gmStreams() {
    return typeof GM_info === 'object' && !!GM_info && GM_info.scriptHandler === 'Tampermonkey'
  }

  function unreachable(base, why) {
    return new CurioError('network', 'Curio can\'t be reached at ' + base + (why ? ': ' + why : '') + '. Is it running, with the API on in Settings › API?')
  }

  function refusal(status, type, text) {
    if (type.indexOf('application/json') >= 0) {
      try {
        var e = JSON.parse(text).error
        if (e) return new CurioError(e.code, e.message, status)
      } catch (_) {}
    }
    return new CurioError(status === 503 ? 'busy' : 'failed', text || 'HTTP ' + status, status)
  }

  function headerOf(raw, name) {
    var m = new RegExp('^' + name + ':\\s*(.*)$', 'im').exec(raw || '')
    return m ? m[1].trim() : ''
  }

  // one call: JSON comes back parsed, a file as a Blob
  function viaFetch(base, url, headers, body) {
    return fetch(url, { method: 'POST', headers: headers, body: body }).then(
      function (r) {
        var type = r.headers.get('content-type') || ''
        if (!r.ok) return r.text().then(function (t) { throw refusal(r.status, type, t) })
        return type.indexOf('application/json') >= 0 ? r.json() : r.blob()
      },
      function (e) { throw unreachable(base, e && e.message) },
    )
  }

  function viaGm(xhr, base, url, headers, body) {
    return new Promise(function (resolve, reject) {
      xhr({
        method: 'POST', url: url, headers: headers, data: body, responseType: 'arraybuffer',
        onload: function (r) {
          var type = headerOf(r.responseHeaders, 'content-type')
          var bytes = r.response || new ArrayBuffer(0)
          var text = function () { return new TextDecoder().decode(bytes) }
          if (r.status < 200 || r.status >= 300) return reject(r.status ? refusal(r.status, type, text()) : unreachable(base, r.statusText))
          if (type.indexOf('application/json') >= 0) {
            try { resolve(JSON.parse(text())) } catch (e) { reject(new CurioError('failed', 'The answer isn\'t JSON: ' + e.message, r.status)) }
          } else resolve(new Blob([bytes], { type: type }))
        },
        onerror: function (r) { reject(unreachable(base, r && (r.error || r.statusText))) },
        ontimeout: function () { reject(unreachable(base, 'timed out')) },
      })
    })
  }

  // server-sent events: each `data:` line is one event's JSON
  function lineReader(onEvent) {
    var rest = ''
    return function (chunk) {
      var lines = (rest + chunk).split(/\r?\n/)
      rest = lines.pop()
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].lastIndexOf('data: ', 0) === 0) onEvent(JSON.parse(lines[i].slice(6)))
      }
    }
  }

  // resolves when the stream ends; `stop` set by the caller ends it early
  function streamFetch(base, url, headers, body, take, ctl) {
    var abort = new AbortController()
    ctl.stop = function () { abort.abort() }
    return fetch(url, { method: 'POST', headers: headers, body: body, signal: abort.signal }).then(
      function (r) {
        if (!r.ok) return r.text().then(function (t) { throw refusal(r.status, r.headers.get('content-type') || '', t) })
        ctl.opened()
        var reader = r.body.getReader()
        var dec = new TextDecoder()
        var pump = function () {
          return reader.read().then(function (x) {
            if (x.done) return
            take(dec.decode(x.value, { stream: true }))
            return pump()
          })
        }
        return pump()
      },
      function (e) { if (!abort.signal.aborted) throw unreachable(base, e && e.message) },
    ).catch(function (e) { if (!abort.signal.aborted) throw e })
  }

  function streamGm(xhr, base, url, headers, body, take, ctl) {
    return new Promise(function (resolve, reject) {
      var seen = 0
      var streaming = false
      var req = xhr({
        method: 'POST', url: url, headers: headers, data: body,
        responseType: 'stream',
        onloadstart: function (r) {
          if (r.response && typeof r.response.getReader === 'function') {
            streaming = true
            ctl.opened()
            var reader = r.response.getReader()
            var dec = new TextDecoder()
            var pump = function () {
              reader.read().then(function (x) {
                if (x.done) return resolve()
                take(typeof x.value === 'string' ? x.value : dec.decode(x.value, { stream: true }))
                pump()
              }, resolve)
            }
            pump()
          }
        },
        onprogress: function (r) {
          if (streaming || typeof r.responseText !== 'string') return
          if (r.status >= 400) return
          if (!seen) ctl.opened()
          take(r.responseText.slice(seen))
          seen = r.responseText.length
        },
        onload: function (r) {
          if (r.status >= 400) return reject(refusal(r.status, headerOf(r.responseHeaders, 'content-type'), typeof r.responseText === 'string' ? r.responseText : ''))
          if (!streaming && typeof r.responseText === 'string') take(r.responseText.slice(seen))
          if (!streaming) resolve()
        },
        onerror: function (r) { reject(unreachable(base, r && (r.error || r.statusText))) },
        onabort: function () { resolve() },
      })
      ctl.stop = function () { if (req && req.abort) req.abort() }
    })
  }

  // A plugin page runs in a sandboxed frame inside a Curio window; that window passes its calls on, as this plugin's.
  function inPluginPage() {
    return typeof window === 'object' && window.parent && window.parent !== window && typeof location === 'object' && /^(http:\/\/plugin\.[a-z0-9-]+\.localhost\/|plugin:\/\/)/.test(location.href)
  }

  // the theme's tokens become the page's CSS variables, as in the app itself
  var overlayLoading = null
  var OVERLAY_SCROLL = '/curio/ui/overlay-scroll.js'
  function applyTheme(m) {
    var root = document.documentElement
    var t = m.theme.tokens || {}
    for (var k in t) root.style.setProperty('--' + k, t[k])
    root.style.fontSize = t['font-size'] || ''
    root.style.colorScheme = m.theme.dark ? 'dark' : 'light'
    root.classList.add('curio-kit')
    if (m.role) root.classList.add('curio-role-' + m.role)
    if (m.role === 'widget' || m.role === 'popover' || m.role === 'settings') reportHeight()
    root.classList.toggle('app-dark', !!m.theme.dark)
    root.classList.toggle('fx-see-through', !!m.seeThrough)
    root.classList.toggle('fx-inactive', !!m.inactive)
    root.classList.toggle('overlay-scroll', !!m.overlayScroll)
    // Curio's own scrollbars, which take no room and show while scrolling
    if (m.overlayScroll && !overlayLoading) overlayLoading = import(/* @vite-ignore */ OVERLAY_SCROLL).then(function (o) { o.installOverlayScroll() }).catch(function () {})
    if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('curio-theme', { detail: m.theme }))
  }

  // the web view's own menu (Back, Refresh, Print) would reload or leave the page; text fields and selected text keep it for copy and paste
  if (typeof window !== 'undefined' && window.parent !== window) {
    window.addEventListener('contextmenu', function (e) {
      var text = (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) || String(window.getSelection ? window.getSelection() : '').trim()
      if (!e.defaultPrevented && !text) e.preventDefault()
    })
  }

  // a widget, popover or settings page is as tall as what it shows, as Curio's own are, unless a widget is given a height; an open list or popup (laid over the page, outside its flow) counts too, so the frame doesn't clip it
  var heightObserved = false
  function reportHeight() {
    if (heightObserved || typeof ResizeObserver !== 'function' || !document.body) return
    heightObserved = true
    // a page that starts with nothing to show reports its 0 too, so the widget hides
    var last = -1
    var OVERLAY = '[class*="-overlay"], .p-popover, .p-contextmenu, .p-datepicker-panel'
    // the field whose list is open: a list goes under it, which the page may first have to grow for
    var openField = function () {
      var f = document.querySelector('[aria-expanded="true"]')
      return f && (f.closest('.p-select, .p-multiselect, .p-autocomplete, .p-datepicker, .p-cascadeselect, .p-treeselect') || f)
    }
    var measure = function () {
      var h = document.body.getBoundingClientRect().height
      var field = openField()
      var under = field ? field.getBoundingClientRect().bottom + window.scrollY : 0
      for (var i = 0; i < document.body.children.length; i++) {
        var el = document.body.children[i]
        if (!el.matches(OVERLAY)) continue
        var o = el.getBoundingClientRect()
        // with room for its margin and shadow
        h = Math.max(h, o.bottom + window.scrollY + 6, under + o.height + 8)
      }
      h = Math.ceil(h)
      if (h !== last) window.parent.postMessage({ curio: 1, height: (last = h) }, '*')
    }
    var ro = new ResizeObserver(measure)
    ro.observe(document.body)
    // a list opened while the page was too short was laid over its own field; once the frame has grown it goes under it
    window.addEventListener('resize', function () {
      var field = openField()
      if (!field) return
      var r = field.getBoundingClientRect()
      for (var i = 0; i < document.body.children.length; i++) {
        var el = document.body.children[i]
        if (!el.matches('[class*="-overlay"]')) continue
        var o = el.getBoundingClientRect()
        if (o.top < r.bottom && r.bottom + o.height <= window.innerHeight + 1) el.style.top = r.bottom + window.scrollY + 'px'
      }
      measure()
    })
    new MutationObserver(function (list) {
      list.forEach(function (m) { if (m.target === document.body) m.addedNodes.forEach(function (n) { if (n.nodeType === 1) ro.observe(n) }) })
      measure()
      // the field says its list is open only after the list is in the page
      requestAnimationFrame(measure)
    }).observe(document.body, { childList: true })
    // a widget folded away for having nothing to show is a frame with no room, which the web view stops drawing, so the size observer stays quiet; what the page changes in itself is measured as it changes
    var pending = false
    new MutationObserver(function () {
      if (pending) return
      pending = true
      Promise.resolve().then(function () { pending = false; measure() })
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
  }

  var bridgeOne = null
  function bridge() {
    if (bridgeOne) return bridgeOne
    var seq = 0
    var waiting = {}
    var subs = {}
    // menus and pickers open where the pointer was in the page, which only the page knows
    var pointer = null
    var track = function (e) { pointer = { x: e.clientX, y: e.clientY } }
    window.addEventListener('pointermove', track, { capture: true, passive: true })
    window.addEventListener('pointerdown', function (e) {
      track(e)
      window.parent.postMessage({ curio: 1, down: true }, '*')
    }, { capture: true, passive: true })
    // keys the page doesn't use (no preventDefault, not typed into a field) reach Curio, so the viewer's and Curio's shortcuts still work
    window.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.isComposing) return
      var t = e.target
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return
      window.parent.postMessage({ curio: 1, key: { key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat } }, '*')
    })
    window.addEventListener('message', function (e) {
      if (e.source !== window.parent) return
      var m = e.data
      if (!m || m.curio !== 1) return
      if (m.theme) return applyTheme(m)
      if (m.sub != null) {
        if (subs[m.sub]) subs[m.sub](m.event)
        return
      }
      var w = waiting[m.id]
      if (!w) return
      delete waiting[m.id]
      if (m.error) w.reject(new CurioError(m.error.code, m.error.message, 0))
      else w.resolve(m.ok)
    })
    function send(msg) {
      return new Promise(function (resolve, reject) {
        var id = ++seq
        waiting[id] = { resolve: resolve, reject: reject }
        msg.curio = 1
        msg.id = id
        msg.pointer = pointer
        window.parent.postMessage(msg, '*')
      })
    }
    bridgeOne = { send: send, subs: subs }
    send({ hello: true }).catch(function () {})
    return bridgeOne
  }

  function connectBridge(options) {
    var b = bridge()
    // arguments are JSON for every transport; a copy also takes framework proxies, which can't be posted as they are
    function call(op, params) {
      return Promise.resolve().then(function () { return b.send({ op: String(op), args: JSON.parse(JSON.stringify(params || {})) }) })
    }
    function subscribe(filter, onEvent, onState) {
      var f = filter || {}
      var closed = false
      var sub = null
      var state = function (s, e) { if (onState) onState(s, e) }
      b.send({ subscribe: JSON.parse(JSON.stringify({ events: f.events, ids: f.ids })) }).then(
        function (r) {
          sub = r.sub
          if (closed) return b.send({ unsubscribe: sub })
          b.subs[sub] = function (e) { if (!closed) onEvent(e) }
          state('open')
        },
        function (e) {
          closed = true
          state('closed', e)
        },
      )
      return {
        close: function () {
          if (closed) return
          closed = true
          if (sub != null) {
            delete b.subs[sub]
            b.send({ unsubscribe: sub }).catch(function () {})
          }
          state('closed')
        },
      }
    }
    // a thumbnail page's answer to `plugin.thumbnail`: a picture as a Blob, a data: address or base64, or null when it can't make one
    function thumbnailDone(request, picture, info) {
      var send = function (data) {
        var i = info || {}
        return b.send({ thumbnailDone: { request: request, data: data, width: i.width || null, height: i.height || null } })
      }
      if (picture == null || typeof picture === 'string') return send(picture || null)
      return new Promise(function (resolve, reject) {
        var r = new FileReader()
        r.onload = function () { resolve(r.result) }
        r.onerror = function () { reject(new CurioError('bad_request', 'The picture can\'t be read')) }
        r.readAsDataURL(picture)
      }).then(send)
    }
    return { call: call, subscribe: subscribe, thumbnailDone: thumbnailDone, options: Object.assign({}, options, { transport: 'bridge' }) }
  }

  // a plugin's program gets its address and a token for its run in its environment
  function programEnv() {
    var env = typeof process === 'object' && process && process.env
    return env && env.CURIO_API_TOKEN ? { token: env.CURIO_API_TOKEN, url: env.CURIO_API_URL } : null
  }

  function connect(options) {
    options = options || {}
    if (options.transport === 'bridge' || (!options.token && !options.transport && inPluginPage())) return withNamespaces(connectBridge(options), function () {
      throw new CurioError('not_allowed', 'A plugin works on the library of the window it was started from')
    })
    if (!options.token && programEnv()) options = Object.assign({}, programEnv(), options)
    if (!options.token) throw new CurioError('unauthorized', 'Curio.connect needs a token from Settings › API')
    var base = options.url ? String(options.url).replace(/\/*$/, '/') : 'http://' + (options.host || '127.0.0.1') + ':' + (options.port || 41733) + '/api/v1/'
    var xhr = options.transport === 'fetch' ? null : gmRequest()
    if (options.transport === 'gm' && !xhr) throw new CurioError('bad_request', 'GM_xmlhttpRequest isn\'t granted to this script')
    var headers = { Authorization: 'Bearer ' + options.token, 'Content-Type': 'application/json' }
    var streamXhr = xhr && (options.transport === 'gm' || gmStreams()) ? xhr : null

    function call(op, params) {
      var url = base + String(op).split('.').join('/')
      // the server leaves it out for operations that take no library
      if (options.library) url += '?library=' + encodeURIComponent(options.library)
      var body = JSON.stringify(params || {})
      return xhr ? viaGm(xhr, base, url, headers, body) : viaFetch(base, url, headers, body)
    }

    function subscribe(filter, onEvent, onState) {
      var closed = false
      var last = null
      var ctl = { stop: null, opened: function () { if (onState) onState('open') } }
      var state = function (s, e) { if (onState) onState(s, e) }
      var take = lineReader(function (e) {
        last = e.id
        if (!closed) onEvent(e)
      })
      var run = function () {
        if (closed) return
        var f = filter || {}
        var body = JSON.stringify({ events: f.events, library: f.library, ids: f.ids, after: last || f.after || undefined })
        var open = streamXhr ? streamGm(streamXhr, base, base + 'events', headers, body, take, ctl) : streamFetch(base, base + 'events', headers, body, take, ctl)
        open.then(
          function () {
            if (closed) return
            state('retrying')
            setTimeout(run, RETRY_MS)
          },
          function (e) {
            if (closed) return
            // a refusal stays a refusal; anything else is tried again, as when the app restarts or another process takes the port over
            if (e.status >= 400 && e.status < 500) {
              closed = true
              return state('closed', e)
            }
            state('retrying', e)
            setTimeout(run, RETRY_MS)
          },
        )
      }
      run()
      return {
        close: function () {
          if (closed) return
          closed = true
          if (ctl.stop) ctl.stop()
          state('closed')
        },
      }
    }

    function forLibrary(library) {
      return connect(Object.assign({}, options, { library: library }))
    }

    return withNamespaces({ call: call, subscribe: subscribe, options: Object.assign({}, options, { token: undefined }) }, forLibrary)
  }

  // every operation is a method: curio.item.add.fromUrls(params) calls item.add.fromUrls
  function withNamespaces(own, forLibrary) {
    own.forLibrary = forLibrary
    own.on = function (name, onEvent, filter) {
      return own.subscribe(Object.assign({}, filter || {}, { events: [name] }), onEvent)
    }
    var namespace = function (path) {
      return new Proxy(function () {}, {
        get: function (_, key) {
          if (typeof key !== 'string' || key === 'then') return undefined
          return namespace(path.concat(key))
        },
        apply: function (_, __, args) { return own.call(path.join('.'), args[0]) },
      })
    }
    return new Proxy(own, {
      get: function (target, key) {
        if (typeof key !== 'string' || key === 'then' || key in target) return target[key]
        return namespace([key])
      },
    })
  }

  // a second copy, such as the UI kit's, leaves the page to the first
  if (inPluginPage() && !(typeof globalThis === 'object' && globalThis.Curio)) bridge()

  return { connect: connect, Error: CurioError, apiVersion: 1 }
})()

if (typeof module === 'object' && module && module.exports) module.exports = Curio
// loaded as a module, as the UI kit does, it still leaves Curio for the page
else if (typeof globalThis === 'object' && !globalThis.Curio) globalThis.Curio = Curio
