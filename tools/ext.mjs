// End-to-end check of the browser extension against the sandbox of Curio's checkout (beside this one unless CURIO_APP names another), with no person at the screen.
// Serves test/pages on loopback, starts a browser with a throwaway profile and the extension loaded, runs every fixture as a menu click does, and compares what reached Curio with what the fixture expects.
// node tools/ext.mjs                     Edge, headless
// node tools/ext.mjs --chrome            Chrome instead
// node tools/ext.mjs --show              a visible window
// node tools/ext.mjs --only plain,svg    these cases only; `collect` runs the page's own gestures (Alt+click, the drop zone, shortcuts, screenshots)
// node tools/ext.mjs --shots <dir>       pictures of the panel and of a toast
// EXT_SHOTS=<dir> node tools/ext.mjs --only side   pictures of the side panel's folders and of the drag card turned into the form, with no others
// node tools/ext.mjs --one               the first library only, not the second library before it
// node tools/ext.mjs --scale 2           device pixels per CSS pixel, for screenshots on a high-density screen (with --only collect: other fixtures pick pictures by density)
// Everything goes into two libraries of the harness's own, Ext first and Ext second, so the sandbox's Sample library keeps none of its items and tags.
// Context menus themselves can't be clicked this way; captures go through the worker's menu.click message, the same path a click takes.
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Curio's checkout: the folder beside this one unless CURIO_APP names another
const APP = path.resolve(process.env.CURIO_APP || path.join(ROOT, '..', 'app'))
const SOURCE = ROOT
const PAGES = path.join(SOURCE, 'test', 'pages')
// Cargo's build output, beside the checkout in dev/target
const TARGET = path.join(APP, '..', 'dev', 'target')
const SANDBOX = path.join(TARGET, 'sandbox', 'audit')
const PROFILE = path.join(TARGET, 'ext-profile')
const WEB = 8791
const FIRST = 'Ext first'
const SECOND = 'Ext second'
const LINUX = process.platform === 'linux'
// on Linux, Chromium (or CURIO_EXT_BROWSER) runs as Edge does here: by its debugging port, with the extension from the command line
const BROWSERS = LINUX ? { edge: process.env.CURIO_EXT_BROWSER || '/usr/bin/chromium', chrome: process.env.CURIO_EXT_BROWSER || '/usr/bin/chromium' } : { edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe' }

const args = process.argv.slice(2)
const opt = { browser: args.includes('--chrome') && !LINUX ? 'chrome' : 'edge', show: args.includes('--show'), one: args.includes('--one'), only: null, shots: null, scale: 0 }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only') opt.only = args[++i].split(',')
  if (args[i] === '--shots') opt.shots = path.resolve(args[++i])
  if (args[i] === '--scale') opt.scale = Number(args[++i]) || 0
  if (args[i] === '--ext') opt.ext = path.resolve(args[++i])
}
// the source, or a package that tools/ext-pack.mjs unpacked; the fixture pages always come from the source
const EXT = opt.ext || SOURCE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Curio downloads only from the internet; a debug build may reach the fixture site's port too, and every Curio this run starts inherits it
process.env.CURIO_DEBUG_LOOPBACK_PORT = String(WEB)
const { outcome } = await import(pathToFileURL(path.join(SOURCE, 'lib', 'captures.js')).href)
async function until(f, ms = 15000, step = 200) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    try {
      const v = await f()
      if (v) return v
    } catch {}
    await sleep(step)
  }
  return null
}
let failures = 0
function check(what, ok, detail = '') {
  if (!ok) failures++
  console.log((ok ? 'PASS ' : 'FAIL ') + what + (detail !== '' && !ok ? `  [${String(detail).slice(0, 400)}]` : ''))
}

// ---- the sandbox ----

function sandboxApi() {
  const txt = fs.readFileSync(path.join(SANDBOX, 'api.txt'), 'utf8')
  return { url: txt.match(/url (\S+)/)[1], token: txt.match(/token (\S+)/)[1] }
}
const require = createRequire(import.meta.url)
const Curio = require(path.join(APP, 'client', 'curio.js'))

/** dev/tools/sandbox.ps1, or dev/tools/sandbox.sh on Linux, with `-Stop` or `-Background`. */
function sandboxScript(what) {
  if (LINUX) return spawnSync('bash', [path.join(APP, '..', 'dev', 'tools', 'sandbox.sh'), ...(what === '-Stop' ? ['--stop'] : [])], { stdio: 'inherit' })
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP, '..', 'dev', 'tools', 'sandbox.ps1'), what], { stdio: 'inherit' })
}

async function sandbox() {
  // started again, so it has the fixture site's port
  sandboxScript('-Stop')
  // Windows keeps the ended process's exe locked a moment, and the start copies over it
  await sleep(3000)
  if (!fs.existsSync(path.join(SANDBOX, 'api.txt'))) sandboxScript('-Background')
  let api = sandboxApi()
  let curio = Curio.connect({ url: api.url, token: api.token })
  if (!(await curio.app.info().catch(() => null))) {
    console.log('starting the sandbox')
    sandboxScript('-Background')
    api = sandboxApi()
    curio = Curio.connect({ url: api.url, token: api.token })
    if (!(await until(() => curio.app.info(), 60000, 500))) throw new Error('The sandbox doesn\'t answer')
  }
  return { api, curio, port: Number(new URL(api.url).port) }
}

async function ensurePath(curio, library, parts) {
  let parent = null
  for (const name of parts) {
    const folders = await curio.folder.list({ library })
    let f = folders.find((x) => (x.parentId ?? null) === parent && x.name === name)
    if (!f) f = { id: (await curio.folder.create({ library, name, ...(parent != null ? { parent } : {}) })).id }
    parent = f.id
  }
  return parent
}

/** A call to a library that may still be opening, tried again as the extension does. */
async function opened(f) {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      if (e.code !== 'busy' || i >= 30) throw e
      await sleep(2000)
    }
  }
}

/** Deletes for good the items saved from `url`. */
async function forget(curio, library, url) {
  const ids = (await opened(() => curio.item.query({ library, query: `url = ${JSON.stringify(url)}`, limit: 500 }))).items.map((i) => i.id)
  if (!ids.length) return
  await curio.item.trash({ library, ids })
  await curio.item.purge({ library, ids })
}

async function prepare(curio, library) {
  // the harness's own library starts empty, so a link saved by an earlier run isn't "already in Curio"
  for (;;) {
    const ids = (await opened(() => curio.item.query({ library, query: '', limit: 500 }))).items.map((i) => i.id)
    if (!ids.length) break
    await opened(() => curio.item.trash({ library, ids }))
  }
  await opened(() => curio.item.purge({ library, all: true }))
  const fixtures = await ensurePath(curio, library, ['Ext', 'Fixtures'])
  await ensurePath(curio, library, ['Ext', 'Attributes'])
  const fields = await curio.field.list({ library })
  if (!fields.some((f) => f.key === 'ext_artist')) await curio.field.define({ library, key: 'ext_artist', label: 'Artist', type: 'text' })
  if (!fields.some((f) => f.key === 'ext_kinds')) await curio.field.define({ library, key: 'ext_kinds', label: 'Kinds', type: 'multi_select', options: ['red', 'green', 'blue'] })
  // the panel shows the library's own fields only, not a plugin's such as the reader's ext_state
  if (!fields.some((f) => f.key === 'ext_state')) await curio.field.define({ library, key: 'ext_state', label: 'State', type: 'single_select', options: ['reading', 'finished'] })
  return fixtures
}

// ---- the fixture server ----

function crc32(buf) {
  let crc = 0xffffffff
  for (const b of buf) {
    let c = (crc ^ b) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** A PNG of one colour; `k` goes in a text chunk, so pictures that look the same are different files, which Curio doesn't skip as duplicates. */
function png(w, h, hex, k = '') {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const text = k ? [chunk('tEXt', Buffer.from('k\0' + k))] : []
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...text, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function wav() {
  const n = 800
  const b = Buffer.alloc(44 + n)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(8000, 28)
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36)
  b.writeUInt32LE(n, 40)
  b.fill(128, 44)
  return b
}

/** Every request the fixture site answered, and whether Curio made it: Curio asks for no encoding and sends no Sec-Fetch headers, which the browser always does. */
const served = []

function serve() {
  const handler = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    served.push({ path: url.pathname + url.search, curio: req.headers['accept-encoding'] === 'identity' && !req.headers['sec-fetch-mode'], cookie: req.headers.cookie || '', referer: req.headers.referer || '' })
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers })
      res.end(body)
    }
    if (url.pathname === '/png') return send(200, 'image/png', png(Number(url.searchParams.get('w')) || 10, Number(url.searchParams.get('h')) || 10, url.searchParams.get('c') || '808080', url.searchParams.get('k') || ''))
    if (url.pathname === '/tone.wav') return send(200, 'audio/wav', wav())
    if (url.pathname === '/big.bin') {
      const mb = Math.min(500, Number(url.searchParams.get('mb')) || 1)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(mb << 20), 'Cache-Control': 'no-store' })
      const block = Buffer.alloc(1 << 20, 7)
      let left = mb
      const more = () => {
        while (left > 0) {
          left--
          if (!res.write(block)) return res.once('drain', more)
        }
        res.end()
      }
      return more()
    }
    if (url.pathname === '/gated.png') return /fx_session=1/.test(req.headers.cookie || '') ? send(200, 'image/png', png(40, 40, 'aa7700')) : send(403, 'text/plain', 'sign in first')
    if (url.pathname === '/hotlink.png') return String(req.headers.referer || '').startsWith(`http://${req.headers.host}/`) ? send(200, 'image/png', png(44, 44, '0077aa')) : send(403, 'text/plain', 'no hotlinking')
    const file = path.join(PAGES, path.basename(url.pathname === '/' ? 'media.html' : url.pathname))
    if (!file.startsWith(PAGES) || !fs.existsSync(file)) return send(404, 'text/plain', 'none')
    const headers = path.basename(file) === 'signed.html' ? { 'Set-Cookie': 'fx_session=1; SameSite=Lax; Path=/' } : {}
    send(200, file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', fs.readFileSync(file), headers)
  }
  const a = http.createServer(handler).listen(WEB, '127.0.0.1')
  const b = http.createServer(handler).listen(WEB, '::1')
  return () => (a.close(), b.close())
}

// ---- the browser: Chrome over the debugging pipe, which branded Chrome needs to load an unpacked extension; Edge over its debugging port, since its launcher doesn't hand the pipe on ----

const DEBUG_PORT = 9445

class Browser {
  constructor(proc) {
    this.proc = proc
    this.n = 0
    this.wait = new Map()
    this.write = (_) => {}
    /** Uncaught errors in the extension's own code, in its pages and its content scripts. */
    this.errors = []
  }
  receive(msg) {
    if (msg.method === 'Input.dragIntercepted') this.dragData = msg.params.data
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      const where = d.url || d.stackTrace?.callFrames?.[0]?.url || ''
      if (where.startsWith('chrome-extension://')) this.errors.push(`${(d.exception?.description || d.text).split('\n')[0]} at ${where.replace(/^chrome-extension:\/\/[^/]+\//, '')}:${d.lineNumber + 1}`)
    }
    // a frame that went away never answers what was asked of it
    if (msg.method === 'Target.detachedFromTarget') {
      for (const [id, w] of this.wait) {
        if (w.sessionId !== msg.params.sessionId) continue
        this.wait.delete(id)
        w.no(new Error(`${w.method}: the target went away`))
      }
    }
    if (msg.id && this.wait.has(msg.id)) {
      const { ok, no, timer } = this.wait.get(msg.id)
      clearTimeout(timer)
      this.wait.delete(msg.id)
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result)
    }
  }
  overPipe() {
    let buf = ''
    this.proc.stdio[4].on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\0')) >= 0) {
        this.receive(JSON.parse(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
    })
    this.write = (text) => this.proc.stdio[3].write(text + '\0')
  }
  async overPort() {
    const version = await until(() => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json()), 20000)
    if (!version) throw new Error('The browser\'s debugging port doesn\'t answer')
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((ok, no) => (ws.addEventListener('open', ok), ws.addEventListener('error', no)))
    ws.addEventListener('message', (m) => this.receive(JSON.parse(m.data)))
    this.write = (text) => ws.send(text)
  }
  /** A call, rejected when it gets no answer in time: a minute, five for script that may wait on Curio. */
  send(method, params = {}, sessionId) {
    const id = ++this.n
    this.write(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        this.wait.delete(id)
        no(new Error(`${method}: no answer`))
      }, method === 'Runtime.evaluate' ? 300000 : 60000)
      this.wait.set(id, { ok, no, timer, sessionId, method })
    })
  }
  /** The extension's id: Chrome answers it when loading; Edge loaded it at start, and the worker's manifest tells it from Edge's own extensions. */
  async load() {
    if (opt.browser === 'chrome') return (await this.send('Extensions.loadUnpacked', { path: EXT })).id
    return until(async () => {
      for (const t of (await this.send('Target.getTargets')).targetInfos.filter((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
        const r = await this.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId).catch(() => null)
        await this.send('Target.detachFromTarget', { sessionId }).catch(() => {})
        if (r?.result?.value === 'Send to Curio') return new URL(t.url).host
      }
      return null
    }, 20000, 500)
  }
  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const b = this
    const page = {
      targetId,
      send: (m, p) => b.send(m, p, sessionId),
      async eval(expression) {
        const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
        return r.result.value
      },
      close: () => b.send('Target.closeTarget', { targetId }),
    }
    await b.send('Runtime.enable', {}, sessionId).catch(() => {})
    await until(() => page.eval('document.readyState === "complete"'), 15000)
    return page
  }
}

async function launch() {
  fs.rmSync(PROFILE, { recursive: true, force: true })
  const chrome = opt.browser === 'chrome'
  const argv = [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--lang=en-US', '--accept-lang=en-US', '--window-size=1200,900']
  if (chrome) argv.push('--remote-debugging-pipe', '--enable-unsafe-extension-debugging')
  else argv.push(`--remote-debugging-port=${DEBUG_PORT}`, `--load-extension=${EXT}`, '--disable-features=DisableLoadExtensionCommandLineSwitch')
  if (LINUX) argv.push('--enable-unsafe-extension-debugging')
  if (!opt.show) argv.unshift('--headless=new')
  if (opt.scale) argv.push(`--force-device-scale-factor=${opt.scale}`)
  argv.push('about:blank')
  const b = new Browser(spawn(BROWSERS[opt.browser], argv, { stdio: chrome ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore' }))
  if (chrome) b.overPipe()
  else await b.overPort()
  return b
}

/** Edge's launcher leaves its browser running apart from the process it started; this profile's processes end with the run. */
function endEdge() {
  if (LINUX) return spawnSync('pkill', ['-f', 'ext-profile'])
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*target*ext-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  spawnSync('powershell', ['-NoProfile', '-Command', ps])
}

// ---- a run ----

async function rightClick(page, p) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', clickCount: 1 })
  if (opt.show) await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
}

async function stopWorker(browser, id) {
  const { targetInfos } = await browser.send('Target.getTargets')
  const w = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`))
  if (!w) return 'not running'
  await browser.send('Target.closeTarget', { targetId: w.targetId })
  const gone = await until(async () => !(await browser.send('Target.getTargets')).targetInfos.some((t) => t.targetId === w.targetId), 5000)
  return gone ? 'stopped' : 'still running'
}

const FINAL = ['added', 'queued', 'handed', 'failed', 'unknown']
/** The run's pages are on 127.0.0.1, whose choice of library and folders a rule follows. */
const FOLLOW = { id: 'run-follow', name: 'Follow the run\'s pages', matching: 'all', conditions: [{ field: 'site', op: 'is', value: '127.0.0.1' }], follow: true }

/**
 * What Curio made of a capture it took (`queued`): the same call again with the capture's requestId, from the extension's own page and token, answers what the first did and adds nothing.
 * An add that failed whole frees its id, so that answer is a new try, which fails the same way; anything else must come back as a repeat.
 */
async function landed(options, rec) {
  if (rec?.state !== 'queued') return rec
  const link = rec.mode === 'link'
  const params = { library: rec.dest.library, urls: [link ? rec.draft.src : rec.urls?.[0] || rec.draft.src], requestId: rec.request || rec.id, ...(link ? { as: 'link' } : {}) }
  const answer = await until(async () => {
    const a = await options.eval(`chrome.storage.local.get('conn').then(({ conn }) => Curio.connect({ token: conn.token, port: conn.port, transport: 'fetch' }).call('item.add.fromUrls', ${JSON.stringify(params)})).catch((e) => ({ error: e.message }))`)
    return a && !a.queued ? a : null
  }, 180000, 500)
  if (!answer || answer.error) return { ...rec, state: 'failed', message: answer?.error || 'Curio never finished it', queued: true }
  const o = outcome(answer)
  if (!answer.repeat && o.state !== 'failed') check(`${rec.draft.title || rec.id}: asked again, Curio repeats its answer`, false, JSON.stringify(answer))
  return { ...rec, ...o, answer, queued: true }
}

async function capture(browser, id, options, page, pageUrl, name, hooks = {}) {
  const p = await page.eval(`fixture.locate(${JSON.stringify(name)})`)
  if (!p) throw new Error('no element for ' + name)
  await rightClick(page, p)
  const info = { ...(await page.eval(`fixture.menuInfo(${JSON.stringify(name)})`)), menuItemId: 'quick' }
  const before = await options.eval('chrome.storage.session.get(null).then((s) => Object.keys(s).filter((k) => k.startsWith("capture:")))')
  if (hooks.cold) check(`${name}: the worker was stopped before the click`, (await stopWorker(browser, id)) === 'stopped')
  const tabId = await options.eval(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(pageUrl)})?.id)`)
  const r = await options.eval(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'menu.click', tabId, info, ask: !!hooks.ask })})`)
  if (r?.error) throw new Error(r.error)
  if (hooks.midway) check(`${name}: the worker was stopped while the capture was on its way`, (await stopWorker(browser, id)) === 'stopped')
  // a capture the panel opens on waits there, new
  const settled = hooks.settled || (hooks.panel ? (s) => s === 'new' : (s) => FINAL.includes(s))
  const rec = await until(async () => {
    const all = await options.eval('chrome.storage.session.get(null)')
    const rec = Object.entries(all).find(([k, v]) => k.startsWith('capture:') && !before.includes(k) && v.tabId === tabId)?.[1]
    return rec && settled(rec.state) ? rec : null
  }, 100000, 300)
  return landed(options, rec)
}

async function verify(curio, name, rec, expect, ctx) {
  const want = { state: 'added', ...expect }
  if (!rec) return check(`${name}: finished`, false, 'no final state within 100 s')
  check(`${name}: ${want.state}`, rec.state === want.state, `${rec.state} ${rec.message || ''}`)
  if (rec.via === 'url') check(`${name}: Curio downloaded it itself`, served.some((s) => s.curio && rec.urls.some((u) => u.endsWith(s.path))), rec.urls.join(' '))
  if (name === 'cookie') {
    const page = served.find((s) => !s.curio && s.path === '/gated.png')
    const own = served.find((s) => s.curio && s.path === '/gated.png')
    check('cookie: Curio sent the cookies the page\'s own request did', !!page && !!own && page.cookie.split('; ').every((c) => own.cookie.includes(c)), `page ${page?.cookie} curio ${own?.cookie}`)
  }
  if (name === 'referer') check('referer: Curio sent the page as Referer', served.some((s) => s.curio && s.path === '/hotlink.png' && s.referer.startsWith(`http://127.0.0.1:${WEB}/`)))
  if (rec.state !== 'added') return
  const libs = await curio.library.list()
  const library = want.library ? libs.find((l) => l.name === want.library)?.id : ctx.library
  check(`${name}: in ${want.library || ctx.libraryName}`, rec.dest.library === library, rec.dest.library)
  const item = await curio.item.get({ library: rec.dest.library, id: rec.ids[0] })
  const pageUrl = ctx.pageUrl
  const problems = []
  const base = item.name.slice(0, item.name.length - (item.ext ? item.ext.length + 1 : 0))
  if (want.name && base !== want.name) problems.push(`name ${JSON.stringify(item.name)}`)
  if (want.nameMax && base.length > want.nameMax) problems.push(`name of ${base.length}`)
  if (want.ext && item.ext !== want.ext) problems.push(`ext ${item.ext}`)
  if (want.kind === 'link' && item.ext !== 'url') problems.push(`not a link: ${item.ext}`)
  if (want.width && item.width !== want.width) problems.push(`width ${item.width}`)
  const url = want.url === undefined || want.url === 'page' ? pageUrl : want.url
  if (item.url !== url) problems.push(`url ${item.url}`)
  if (want.notes !== undefined && item.annotation !== want.notes) problems.push(`notes ${JSON.stringify(item.annotation.slice(0, 40))}`)
  if (want.notes === undefined && item.annotation.length > 10000) problems.push(`notes of ${item.annotation.length}`)
  for (const t of want.tags || []) if (!item.tags.includes(t)) problems.push(`no tag ${t}`)
  if (want.tagsMax && item.tags.length > want.tagsMax) problems.push(`${item.tags.length} tags`)
  if (want.rating !== undefined && item.rating !== want.rating) problems.push(`rating ${item.rating}`)
  for (const [k, v] of Object.entries(want.fields || {})) if (item.fields?.[k] !== v) problems.push(`field ${k}=${JSON.stringify(item.fields?.[k])}`)
  if (want.fields && rec.dropped?.length !== 1) problems.push(`dropped ${JSON.stringify(rec.dropped)}`)
  const folders = item.folders.map((f) => f.name)
  for (const f of want.folders || (want.library ? [] : ['Fixtures'])) if (!folders.includes(f)) problems.push(`not in ${f} (${folders.join(', ')})`)
  if (want.sameDestination && (rec.dest.library !== ctx.library || !rec.dest.folders.includes(ctx.fixtures))) problems.push('the page changed the destination')
  if (!want.library && !want.sameDestination && !item.tags.includes(ctx.runTag)) problems.push('no run tag')
  check(`${name}: ${want.kind === 'link' ? 'link' : 'file'} as the fixture says`, !problems.length, problems.join('; '))
}

/** The panel on a capture already saved: a folder, a tag and a name, then Send saves it again as a capture of its own. */
async function panelSend(browser, id, curio, ctx, rec) {
  const panel = await browser.open(`chrome-extension://${id}/panel/panel.html?capture=${rec.id}`)
  const ready = await until(() => panel.eval(`!!document.querySelector('#folders [data-id="${ctx.fixtures}"]') && !document.getElementById('send').disabled`), 30000)
  check('panel: lists the library\'s folders', !!ready)
  const tag = 'panel-' + ctx.runTag
  await panel.eval(`(() => {
    const row = document.querySelector('#folders [data-id="${ctx.fixtures}"]')
    row.click()
    const again = document.querySelector('#folders [data-id="${ctx.fixtures}"]')
    if (!again.classList.contains('on')) again.click()
    document.getElementById('name').value = 'Sent from the panel'
    const t = document.getElementById('tagInput')
    t.value = ${JSON.stringify(tag)}
    t.dispatchEvent(new Event('change'))
    document.getElementById('send').click()
  })()`)
  const status = await until(async () => {
    const s = await panel.eval(`document.getElementById('status').className + '|' + document.getElementById('status').textContent`)
    return / (ok|error)\|/.test(s) ? s : null
  }, 60000, 300)
  check('panel: Send saves it', !!status && status.includes(' ok|'), status)
  const found = await until(async () => { const f = await curio.item.query({ library: ctx.library, query: `tag = "${tag}"`, limit: 5 }); return f.items.length ? f : null }, 60000, 500)
  const item = found?.items[0]
  check('panel: the item has the panel\'s name, folder and tag', found?.items.length === 1 && item.name.startsWith('Sent from the panel') && item.folders.some((f) => f.id === ctx.fixtures), JSON.stringify(found?.items.map((i) => [i.name, i.folders])))
  await panel.close()
}

/** A button in the extension's note: the note is in a closed shadow root, which the debugging protocol still reaches. */
async function clickInPage(page, label) {
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true })
  const found = []
  const walk = (n) => {
    if (n.nodeName === 'BUTTON' && (n.children || []).some((c) => c.nodeType === 3 && c.nodeValue === label)) found.push(n)
    for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c)
  }
  walk(root)
  const node = found[found.length - 1]
  if (!node) return false
  const { model } = await page.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
  const [x1, y1, , , x3, y3] = model.content
  const p = { x: (x1 + x3) / 2, y: (y1 + y3) / 2 }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
  return true
}

/** The middle of the first node of the page, through shadow roots, that `test` takes; with its text. */
async function nodeIn(page, test) {
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true })
  let found = null
  const walk = (n) => {
    if (found) return
    const attrs = {}
    for (let i = 0; i < (n.attributes || []).length; i += 2) attrs[n.attributes[i]] = n.attributes[i + 1]
    if (n.nodeType === 1 && test(n, attrs)) found = n
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c)
  }
  walk(root)
  if (!found) return null
  const { model } = await page.send('DOM.getBoxModel', { backendNodeId: found.backendNodeId }).catch(() => ({ model: null }))
  if (!model) return null
  const [x1, y1, , , x3, y3] = model.content
  const text = (found.children || []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('')
  return { x: (x1 + x3) / 2, y: (y1 + y3) / 2, text }
}

async function altClick(page, p) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 })
  await sleep(300)
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: 1 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 })
}

/** The colour of one pixel of an 8-bit RGB or RGBA PNG, as hex. */
function pngPixel(file, x, y) {
  const buf = fs.readFileSync(file)
  let pos = 8
  let w = 0
  let depth = 0
  let ctype = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') [w, depth, ctype] = [data.readUInt32BE(0), data[8], data[9]]
    else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6)) return null
  const bpp = ctype === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  let prev = Buffer.alloc(stride)
  let row = prev
  for (let r = 0; r <= y; r++) {
    const f = raw[r * (stride + 1)]
    row = Buffer.from(raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      const add = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0
      row[i] = (row[i] + add) & 255
    }
    prev = row
  }
  return row.subarray(x * bpp, x * bpp + 3).toString('hex')
}

const near = (hex, want, by = 8) => !!hex && [0, 2, 4].every((i) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= by)

/** Captures of one tab as they finish: `next(trigger)` is the next one that trigger made, `state` its state to wait for. */
async function watchTab(options, pageUrl) {
  const tabId = await options.eval(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(pageUrl)})?.id)`)
  const seen = new Set(await options.eval('chrome.storage.session.get(null).then((s) => Object.keys(s).filter((k) => k.startsWith("capture:")))'))
  const next = async (trigger, ms = 60000, done = (s) => FINAL.includes(s)) => landed(options, await until(async () => {
    const all = await options.eval('chrome.storage.session.get(null)')
    const found = Object.entries(all).find(([k, v]) => k.startsWith('capture:') && !seen.has(k) && v.tabId === tabId && v.trigger === trigger && done(v.state))
    if (found) seen.add(found[0])
    return found ? found[1] : null
  }, ms, 300))
  return { tabId, next, run: (name) => options.eval(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'command.run', name, tabId })})`) }
}

/** Drags from `from` as a person does, held by the browser, to a pull away; answers the drag's data, or null. */
async function startDrag(browser, page, from) {
  browser.dragData = null
  await page.send('Input.setInterceptDrags', { enabled: true })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 15, y: from.y, button: 'left', buttons: 1 })
  const data = await until(() => browser.dragData, 5000)
  if (data) for (const type of ['dragEnter', 'dragOver']) await page.send('Input.dispatchDragEvent', { type, x: from.x + 120, y: from.y + 10, data })
  return data
}

/** Drops where a row is, or gives the drag up, and ends it. Over the drag card the page takes the drop, as Chrome makes it for a real drag: none reaches the card's frame, another process. */
async function endDrag(page, data, at) {
  if (data && at) {
    // a hand moves onto the place over a few events, and the browser passes over one that comes while it still handles the last
    for (const d of [12, 6, 0]) {
      await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: at.x - d, y: at.y, data }).catch(() => {})
      await sleep(60)
    }
    if (at.frame) {
      // the card lights what is under the pointer, from the page's word
      const lit = await until(() => at.frame.eval(`!!document.querySelector('.over')`).catch(() => false), 2000, 50)
      if (!lit) check('The drag card lights the place under the pointer', false, at.text)
    }
    await page.send('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data }).catch(() => {})
  } else if (data) await page.send('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data }).catch(() => {})
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at?.x || 0, y: at?.y || 0, button: 'left', clickCount: 1 })
  await page.send('Input.setInterceptDrags', { enabled: false })
}

/** Once the drag card or the panel in the page is gone, after a drop on the card's frame: the browser may still hold the page's drag, and mouse moves don't reach the page until a cancel ends it. */
async function freeMouse(page, data) {
  await page.send('Input.setInterceptDrags', { enabled: true })
  for (let i = 0; i < 10; i++) {
    await page.eval(`(() => { window.__moves = 0; if (!window.__countMoves) addEventListener('mousemove', (window.__countMoves = () => window.__moves++), true) })()`)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2 + i, y: 2 })
    await sleep(100)
    if (await page.eval('window.__moves')) break
    await page.send('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data }).catch(() => {})
    await sleep(300)
  }
  await page.send('Input.setInterceptDrags', { enabled: false })
  const free = !!(await page.eval('window.__moves'))
  if (!free) check('The page takes the mouse again after a drop on the drag card', false)
  return free
}

/** A picture of a page for --shots, or into EXT_SHOTS alone, by name; nothing without either or a name. */
async function picture(target, name) {
  const dir = opt.shots || process.env.EXT_SHOTS
  if (!dir || !name) return
  fs.mkdirSync(dir, { recursive: true })
  const shot = await target.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
  if (shot) fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(shot.data, 'base64'))
}

/** The panel's page in a page's dialog, showing the drag card's drops (`drop`) or the form (`panel`); one page, which turns from the one into the other. */
async function framedPanel(browser, mode) {
  const t = (await browser.send('Target.getTargets')).targetInfos.find((x) => x.url.includes('/panel/panel.html?frame=1'))
  if (!t) return null
  const f = await attach(browser, t.targetId).catch(() => null)
  const view = f && (await f.eval(`document.getElementById('card').hidden ? '' : document.documentElement.dataset.view || ''`).catch(() => ''))
  return view && (mode === 'drop') === (view === 'drops') ? f : null
}

/** A place on the drag card: a folder's row, or the drop area. The card's page lies over the whole page, so its coordinates are the page's. */
async function cardAt(browser, folderId) {
  const f = await framedPanel(browser, 'drop')
  const sel = folderId == null ? '#dropPanel' : `#dropFolders [data-id="${folderId}"]`
  const at = f && (await f.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: e.textContent } })()`).catch(() => null))
  return at ? { ...at, frame: f } : null
}

/** The gestures where they are harder: a worker asleep, the switches off, a frame, a screenshot with no destination yet. */
async function collectMore(browser, id, curio, ctx) {
  console.log('-- collecting: a sleeping worker, switches off, a frame, the panel')
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  const settings = await options.eval('chrome.storage.local.get("settings").then((s) => s.settings)')
  const itemOf = async (rec) => (rec?.ids?.[0] ? curio.item.get({ library: rec.dest.library, id: rec.ids[0] }) : null)
  const pageUrl = `http://127.0.0.1:${WEB}/collect.html`
  const at = (page, sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)

  // a fresh page whose first gesture is a drag, with the worker stopped
  let page = await browser.open(pageUrl)
  let w = await watchTab(options, pageUrl)
  check('Sleeping worker: stopped before the drag', (await stopWorker(browser, id)) === 'stopped')
  let data = await startDrag(browser, page, await at(page, '#pic'))
  const row = await until(async () => {
    if (data) await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: 470, y: 160, data })
    return cardAt(browser, ctx.fixtures)
  }, 8000, 300)
  check('Sleeping worker: the first drag on a page still shows the drag card', !!row)
  await endDrag(page, data, row)
  const coldDrop = await w.next('drop')
  check('Sleeping worker: the drop saves', coldDrop?.state === 'added', coldDrop?.state)
  await page.close()

  // a fresh page whose first gesture is Alt+click on a link, as quick as a hand does it
  page = await browser.open(pageUrl)
  w = await watchTab(options, pageUrl)
  // an address of its own: one saved earlier in the run would be "already in Curio"
  await page.eval(`document.getElementById('lnk').href = '/about.html?cold=${ctx.runTag}'`)
  // it may have gone to sleep by itself since the drop
  const asleep = await stopWorker(browser, id)
  check('Sleeping worker: stopped before the Alt+click', asleep === 'stopped' || asleep === 'not running', asleep)
  const lnk = await at(page, '#lnk')
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lnk.x, y: lnk.y })
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 })
  await sleep(150)
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: lnk.x, y: lnk.y, button: 'left', clickCount: 1, modifiers: 1 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 })
  const coldAlt = await w.next('alt', 15000)
  // not a failure of the run: this says how a cold worker answers in this browser
  console.log(`INFO Sleeping worker: Alt+click 150 ms after Alt ${coldAlt ? (coldAlt.state === 'added' ? 'saved the link' : `ended ${coldAlt.state} ${coldAlt.message || ''}`) : 'fell through to the page and the browser'}`)
  await page.close()

  // the switches off: the page gets the click, and no zone shows
  await options.eval(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, altClick: false, dragOff: ['127.0.0.1'] } })`)
  page = await browser.open(pageUrl)
  w = await watchTab(options, pageUrl)
  await sleep(500)
  await altClick(page, await at(page, '#pic'))
  const offAlt = await w.next('alt', 2500)
  check('Alt+click off: nothing is saved and the page gets the click', !offAlt && (await page.eval('window.__clicks')) === 1, `${offAlt?.state} ${await page.eval('window.__clicks')}`)
  data = await startDrag(browser, page, await at(page, '#pic'))
  await sleep(1500)
  check('Drop zone off on this site: no card or zone shows', !!data && !(await framedPanel(browser, 'drop')) && !(await nodeIn(page, (n, a) => /choose/.test(a.class || ''))))
  await endDrag(page, data, null)
  await options.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} })`)
  await page.close()

  // what the page itself made draggable is its own drag: no card covers it
  page = await browser.open(pageUrl)
  await sleep(500)
  await page.eval(`(() => { const a = document.createElement('a'); a.id = 'own'; a.href = '/about.html'; a.draggable = true; a.textContent = 'A card of the page'; a.style.cssText = 'position:fixed;left:20px;top:20px;padding:8px;background:#ddd'; document.body.append(a) })()`)
  data = await startDrag(browser, page, await at(page, '#own'))
  await sleep(1500)
  check('A page\'s own draggable: no card or zone shows', !!data && !(await framedPanel(browser, 'drop')) && !(await nodeIn(page, (n, a) => /choose/.test(a.class || ''))))
  await endDrag(page, data, null)

  // any site may frame the panel's page: outside the worker's grant it draws nothing
  await page.eval(`(() => { const f = document.createElement('iframe'); f.src = 'chrome-extension://${id}/panel/panel.html?capture=framed'; document.body.append(f) })()`)
  const framedByPage = await until(async () => (await browser.send('Target.getTargets')).targetInfos.find((t) => t.url.includes('/panel/panel.html?capture=framed')), 5000)
  const inside = framedByPage && (await attach(browser, framedByPage.targetId).catch(() => null))
  await sleep(1000)
  check('A page that frames the panel gets nothing of it', !!inside && (await inside.eval(`document.getElementById('card').hidden && document.getElementById('form').hidden`)) === true)
  await page.close()

  // in a frame: Alt+click, and the shortcut finds the frame the pointer is in
  const framesUrl = `http://127.0.0.1:${WEB}/frames.html`
  page = await browser.open(framesUrl)
  await browser.send('Target.activateTarget', { targetId: page.targetId })
  w = await watchTab(options, framesUrl)
  await sleep(800)
  const framed = await page.eval('fixture.locate("frame")')
  await altClick(page, framed)
  const frameAlt = await w.next('alt')
  const frameItem = await itemOf(frameAlt)
  check('In a frame: Alt+click saves the framed picture, from its frame', frameAlt?.state === 'added' && frameItem?.width === 60 && frameAlt.frameId !== 0, `${frameAlt?.state} ${frameItem?.width} frame ${frameAlt?.frameId}`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: framed.x, y: framed.y })
  await sleep(200)
  await w.run('quick-save')
  const frameKey = await w.next('command')
  const frameKeyItem = await itemOf(frameKey)
  check('In a frame: the shortcut saves what is under the pointer there', frameKey?.state === 'added' && frameKeyItem?.width === 60, `${frameKey?.state} ${frameKeyItem?.width}`)
  await page.close()

  // a screenshot with no destination yet: the panel opens on it, shows it and sends it
  const dest = await options.eval('chrome.storage.local.get("dest").then((d) => d.dest)')
  await options.eval(`chrome.storage.local.set({ dest: { ...${JSON.stringify(dest)}, last: null } })`)
  page = await browser.open(pageUrl)
  await browser.send('Target.activateTarget', { targetId: page.targetId })
  w = await watchTab(options, pageUrl)
  await sleep(500)
  await w.run('capture-visible')
  const waiting = await w.next('shot', 15000, (s) => s === 'new')
  const opened = waiting && (await panelTarget(browser, waiting.id))
  check('Screenshot with no destination: the panel opens on it', !!opened)
  if (opened) {
    const panel = await attach(browser, opened.targetId)
    const shown = await until(() => panel.eval(`!!document.querySelector('#preview img') && document.getElementById('what').title`), 15000)
    check('Screenshot with no destination: the panel shows it', !!shown && shown.includes('Collect fixtures'), shown)
    await until(() => panel.eval(`!!document.querySelector('#folders [data-id="${ctx.fixtures}"]')`), 30000)
    await panel.eval(`(() => { const r = document.querySelector('#folders [data-id="${ctx.fixtures}"]'); r.click(); if (!document.querySelector('#folders [data-id="${ctx.fixtures}"]').classList.contains('on')) document.querySelector('#folders [data-id="${ctx.fixtures}"]').click(); document.getElementById('send').click() })()`)
    const status = await panelStatus(panel)
    const rec = await record(options, waiting.id)
    const item = await itemOf(rec)
    check('Screenshot with no destination: Send saves it', status?.includes(' ok|') && rec?.state === 'added' && item?.ext === 'png', `${status} ${rec?.state} ${rec?.message || ''} ${item?.ext}`)
    // the panel in the page has closed itself by now
    await panel.close()
  }
  await options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify(dest)} })`)
  await page.close()
  await options.close()
}

/** Site rules: a rule's place and tags with the page's own from a selector, a rule that opens the panel, Options listing them; then the pointer in a closed shadow root, and the sender closed when idle and opened again. */
async function ruleChecks(browser, id, curio, ctx) {
  console.log('-- site rules, the pointer, the sender')
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  const last = { library: ctx.library, folders: [ctx.fixtures], tags: [ctx.runTag] }
  const tag = 'rule-' + ctx.runTag
  const rule = { id: 'run-rule', name: 'Run rule', matching: 'all', conditions: [{ field: 'site', op: 'is', value: '127.0.0.1' }, { field: 'kind', op: 'is', value: 'image' }], library: ctx.library, folders: [ctx.fixtures], tags: [tag], tagsFrom: '#ruleTags span' }
  const setRules = (rules) => options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify({ last, recents: [], perLibrary: {}, aliases: {}, recentTags: [], rules })} })`)
  await setRules([FOLLOW, rule])
  check('Rules: Options lists them', !!(await until(async () => {
    await options.eval('location.reload()').catch(() => {})
    await sleep(500)
    return options.eval(`[...document.querySelectorAll('#rules .rule-title')].some((e) => e.textContent === 'Run rule')`)
  }, 8000, 1000)))

  // its own pictures: one saved before would be skipped as already in the library
  const pageUrl = `http://127.0.0.1:${WEB}/collect.html?rule=${ctx.runTag}`
  const page = await browser.open(pageUrl)
  await browser.send('Target.activateTarget', { targetId: page.targetId })
  const w = await watchTab(options, pageUrl)
  await sleep(500)
  await page.eval(`(() => {
    const d = document.createElement('div')
    d.id = 'ruleTags'
    for (const t of [' Red ', 'red', 'Blue' + String.fromCharCode(10) + '  sky']) d.append(Object.assign(document.createElement('span'), { textContent: t }))
    document.body.append(d)
  })()`)
  const at = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const itemOf = async (rec) => (rec?.ids?.[0] ? curio.item.get({ library: rec.dest.library, id: rec.ids[0] }) : null)
  const lastNow = async () => {
    const l = await options.eval('chrome.storage.local.get("dest").then((d) => d.dest.last)')
    return JSON.stringify({ library: l?.library, folders: l?.folders, tags: l?.tags })
  }

  await altClick(page, await at('#pic'))
  const byRule = await w.next('alt')
  const tags = ((await itemOf(byRule))?.tags || []).map((t) => t.toLowerCase())
  check('Rules: a quick save takes the rule\'s place and tags, and the page\'s from its selector', byRule?.state === 'added' && byRule.from === 'rule' && tags.includes(tag) && tags.includes('red') && tags.includes('blue sky') && tags.filter((t) => t === 'red').length === 1, `${byRule?.state} ${byRule?.from} ${JSON.stringify(tags)}`)
  check('Rules: the last destination stays as it was', (await lastNow()) === JSON.stringify(last), await lastNow())

  await setRules([FOLLOW, { ...rule, ask: true }])
  await sleep(300)
  await altClick(page, await at('#pic'))
  const panel = await until(() => framedPanel(browser, 'panel'), 10000)
  const chips = panel && (await until(async () => {
    const t = await panel.eval(`[...document.querySelectorAll('#tags .chip')].map((c) => c.textContent).join('|')`)
    return t.includes(tag) ? t : null
  }, 10000))
  check('Rules: one that opens the panel opens it with its tags', !!chips, chips)
  if (panel) await panel.eval(`document.getElementById('cancel').click()`).catch(() => {})
  await until(async () => !(await framedPanel(browser, 'panel')), 5000)
  await setRules([FOLLOW])

  // the shortcut finds what is under the pointer when it saves, inside a closed shadow root too
  await page.eval(`(() => {
    const host = document.createElement('div')
    host.style.cssText = 'position: fixed; left: 400px; top: 300px'
    const img = document.createElement('img')
    img.src = '/png?w=222&h=111&c=884422&k=' + encodeURIComponent(location.search + '-shadow')
    host.attachShadow({ mode: 'closed' }).append(img)
    document.body.append(host)
  })()`)
  await sleep(800)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 450, y: 350 })
  await w.run('quick-save')
  const shadow = await w.next('command')
  const shadowItem = await itemOf(shadow)
  check('Shortcut: what is under the pointer in a closed shadow root', shadow?.state === 'added' && shadowItem?.width === 222, `${shadow?.state} ${shadow?.message || ''} ${shadowItem?.width}`)

  // the sender closes after its idle time, and a save opens it again
  const settings = await options.eval('chrome.storage.local.get("settings").then((s) => s.settings)')
  await options.eval(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, senderIdle: 1000 } })`)
  const closed = await until(() => options.eval(`chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.length === 0)`), 30000, 1000)
  check('Sender: the offscreen document closes with nothing to do', !!closed)
  await page.eval(`(() => { const img = document.createElement('img'); img.id = 'pic2'; img.src = '/png?w=233&h=100&c=228844&k=' + encodeURIComponent(location.search + '-idle'); img.style.cssText = 'position: fixed; left: 700px; top: 300px'; document.body.append(img) })()`)
  await sleep(800)
  await altClick(page, await at('#pic2'))
  const after = await w.next('alt')
  check('Sender: a save after it closed opens it again', after?.state === 'added', `${after?.state} ${after?.message || ''}`)
  await options.eval(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, senderIdle: 60000 } })`)
  await page.close()
  await options.close()
}

/** Disconnect, last: Curio deletes the token and the extension forgets it and what it kept. Never with the sandbox's own token, which later runs use. */
async function disconnectCheck(browser, id, sandboxToken) {
  // only a paired token is given up, and pairing is skipped on Linux
  if (LINUX) return console.log('-- disconnect: skipped on Linux, with no paired token')
  console.log('-- disconnect')
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  const conn = await options.eval('chrome.storage.local.get("conn").then((c) => c.conn)')
  if (!conn?.token || conn.token === sandboxToken) return check('Disconnect: the run has a paired token to give up', false)
  await until(() => options.eval(`!document.getElementById('disconnect').hidden`), 5000)
  await options.eval(`document.getElementById('disconnect').click()`)
  const said = await until(() => options.eval(`(() => { const t = document.getElementById('connStatus').textContent; return t.startsWith('Disconnected') ? t : null })()`), 10000)
  const kept = await options.eval(`chrome.storage.local.get(null).then((a) => JSON.stringify({ token: a.conn?.token, libraries: !!a.libraries, lists: Object.keys(a).some((k) => k.startsWith('lists:')) }))`)
  const after = await options.eval(`Curio.connect({ token: ${JSON.stringify(conn.token)}, port: ${conn.port}, transport: 'fetch' }).call('app.info').then(() => 'still works', (e) => e.code || e.message)`)
  check('Disconnect: Curio deleted the token, and the extension forgot it and what it kept', said === 'Disconnected; Curio deleted the token.' && kept === JSON.stringify({ token: '', libraries: false, lists: false }) && after === 'unauthorized', `${said} ${kept} ${after}`)
  await options.close()
}

/** Rating and choice fields in the panel: from the page's attributes, then changed in the panel; and All, the library itself, in its folder list. */
async function fieldChecks(browser, id, curio, ctx) {
  console.log('-- rating and choice fields, downloaded through the browser')
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  // sent as bytes, so the answer names the item at once
  const settings = await options.eval('chrome.storage.local.get("settings").then((s) => s.settings)')
  await options.eval(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, browserDownload: true } })`)
  await options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify({ last: { library: ctx.library, folders: [ctx.fixtures], tags: [ctx.runTag] }, recents: [], perLibrary: {}, aliases: {}, recentTags: [], rules: [FOLLOW] })} })`)
  const pageUrl = `http://127.0.0.1:${WEB}/collect.html?fields=${ctx.runTag}`
  const page = await browser.open(pageUrl)
  const w = await watchTab(options, pageUrl)
  await sleep(500)
  await page.eval(`(() => { const p = document.getElementById('pic'); p.dataset.curioRating = '4'; p.dataset.curioFields = JSON.stringify({ ext_state: 'finished' }) })()`)
  const at = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const src = await page.eval(`document.getElementById('pic').src`)
  await rightClick(page, await at('#pic'))
  await options.eval(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'menu.click', tabId: w.tabId, ask: true, info: { menuItemId: 'ask', mediaType: 'image', srcUrl: src, pageUrl, frameId: 0 } })})`)
  const rec = await w.next('menu', 15000, (s) => s === 'new')
  const target = rec && (await panelTarget(browser, rec.id))
  if (!target) {
    check('Fields: the panel opens', false)
    return
  }
  const panel = await attach(browser, target.targetId)
  const state = `(() => ({ stars: document.querySelectorAll('#rating .star.on').length, read: document.querySelector('select[data-key="ext_state"]')?.value, kinds: [...document.querySelectorAll('[data-key="ext_kinds"] .chip.on')].map((b) => b.textContent) }))()`
  const first = await until(() => panel.eval(state).then((s) => (s.read ? s : null)), 30000)
  check('Fields: the page\'s rating and choice come into the panel', first?.stars === 4 && first?.read === 'finished', JSON.stringify(first))
  await panel.eval(`(() => {
    document.querySelectorAll('#rating .star')[2].click()
    const s = document.querySelector('select[data-key="ext_state"]')
    s.value = ''
    s.dispatchEvent(new Event('change'))
  })()`)
  await panel.eval(`[...document.querySelectorAll('[data-key="ext_kinds"] .chip')].find((b) => b.textContent === 'green').click()`)
  await panel.eval(`[...document.querySelectorAll('[data-key="ext_kinds"] .chip')].find((b) => b.textContent === 'blue').click()`)
  await panel.eval(`[...document.querySelectorAll('[data-key="ext_kinds"] .chip')].find((b) => b.textContent === 'blue').click()`)
  const allFirst = await panel.eval(`(() => { const r = document.querySelector('#folders .p-row'); return r?.dataset.all === '1' && !r.classList.contains('on') && document.querySelectorAll('#folders .p-row.on').length > 0 })()`)
  await panel.eval(`document.querySelector('#folders .p-row[data-all]').click()`)
  check('Panel: All comes first in the folder list, and choosing it leaves every folder', allFirst && (await panel.eval(`document.querySelector('#folders .p-row[data-all]').classList.contains('on') && document.querySelectorAll('#folders .p-row.on').length === 1`)))
  await panel.eval(`document.getElementById('send').click()`)
  const saved = await until(async () => { const r = await record(options, rec.id); return r?.state === 'added' ? r : null }, 30000, 300)
  check('Download through the browser: the browser sent the bytes', saved?.via === 'bytes', saved?.via)
  const item = saved && (await curio.item.get({ library: ctx.library, id: saved.ids[0] }))
  check('Fields: Send saves the rating and choices, and a page value cleared stays cleared', item?.rating === 3 && item.fields?.ext_state == null && JSON.stringify(item.fields?.ext_kinds) === '["green"]', JSON.stringify({ rating: item?.rating, fields: item?.fields }))
  check('All: the item is in the library itself, in no folder', !!item && item.folders.length === 0, JSON.stringify(item?.folders))
  await sleep(1500)
  check('A save leaves no note in the page: Curio tells of it', !(await noteSays(page, 'Saved to')) && !(await noteSays(page, 'Sending to')))
  await panel.close().catch(() => {})

  await options.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} })`)
  await page.close()
  await options.close()
}

/** The panel in the side panel. A tab at its address stands in for it: a headless browser draws no side panel, and a click sent here is no person's, which the browser wants before it opens one. */
async function sideChecks(browser, id, curio, ctx) {
  console.log('-- the side panel')
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  const settings = await options.eval('chrome.storage.local.get("settings").then((s) => s.settings)')
  await options.eval(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, browserDownload: true }, dest: ${JSON.stringify({ last: { library: ctx.library, folders: [ctx.fixtures], tags: [ctx.runTag] }, recents: [], perLibrary: {}, aliases: {}, recentTags: [], rules: [FOLLOW] })} })`)
  const pageUrl = `http://127.0.0.1:${WEB}/collect.html?side=${ctx.runTag}`
  const page = await browser.open(pageUrl)
  const w = await watchTab(options, pageUrl)
  await sleep(500)
  const at = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const src = await page.eval(`document.getElementById('pic').src`)
  const ask = async () => {
    // input reaches only the tab in front, and the menu's page opened above may stand over it
    await browser.send('Target.activateTarget', { targetId: page.targetId })
    await rightClick(page, await at('#pic'))
    await options.eval(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'menu.click', tabId: w.tabId, ask: true, info: { menuItemId: 'ask', mediaType: 'image', srcUrl: src, pageUrl, frameId: 0 } })})`)
    return w.next('menu', 15000, (s) => s === 'new')
  }
  const sideUrl = `chrome-extension://${id}/panel/panel.html?side=1`
  // a real drag out of the picture, held over the page until the drag card has had time to show; `drop` ends it on the card's folder or its drop area
  const dragPic = async (drop, hold = 0, shot = '') => {
    const pic = await at('#pic')
    browser.dragData = null
    await browser.send('Target.activateTarget', { targetId: page.targetId })
    await page.send('Input.setInterceptDrags', { enabled: true })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic.x, y: pic.y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pic.x, y: pic.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 6; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic.x + i * 15, y: pic.y, button: 'left', buttons: 1 })
    const data = await until(() => browser.dragData, 5000)
    if (!data) return { data }
    for (const type of ['dragEnter', 'dragOver']) await page.send('Input.dispatchDragEvent', { type, x: pic.x + 120, y: pic.y + 10, data })
    const row = await until(() => cardAt(browser, ctx.fixtures), drop ? 8000 : 3000)
    const area = drop === 'area' && row ? await cardAt(browser, null) : null
    if (row && shot) await picture(page, shot)
    if (row && hold) await sleep(hold)
    if (drop && row) await endDrag(page, data, area || row)
    await freeMouse(page, data)
    return { data, row }
  }
  // a drop on the floating drag card's drop area turns it into the form in place
  const dropOnArea = async () => {
    const onArea = await dragPic('area')
    const shows = async (f) => f && (await f.eval(`document.getElementById('what').title || ''`).then((t) => t.includes('/png')).catch(() => false))
    const got = onArea.row && (await until(async () => {
      const win = await framedPanel(browser, 'panel')
      return (await shows(win)) ? { win } : null
    }, 15000))
    const card = await framedPanel(browser, 'drop')
    const frames = (await browser.send('Target.getTargets')).targetInfos.filter((t) => t.url.includes('/panel/panel.html?frame=1')).length
    check('Drag card: a drop on the drop area turns the card into the form on it, in place', !!got && !card && frames === 1, `${!!onArea.row} ${!!got} ${!!card} ${frames} frames`)
    if (got?.win) await picture(page, 'side-card-turned-form')
    if (got?.win) await got.win.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`).catch(() => true)
    await until(async () => !(await browser.send('Target.getTargets')).targetInfos.some((t) => t.url.includes('/panel/panel.html')), 5000)
  }
  let stand = null
  try {
    const menu = await browser.open(`chrome-extension://${id}/popup/popup.html`)
    await menu.eval(`chrome.runtime.sendMessage({ type: 'popup.run', name: 'open-panel', tabId: ${w.tabId} })`)
    await menu.close()
    const empty = await until(() => framedPanel(browser, 'panel'), 10000)
    const blank = empty && (await until(() => empty.eval(`!document.getElementById('form').hidden && !document.getElementById('drop').classList.contains('has')`).catch(() => false), 10000))
    check('Card: Open draws the empty panel in the page', !!blank)
    if (empty) await empty.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`).catch(() => true)
    await until(async () => !(await browser.send('Target.getTargets')).targetInfos.some((t) => t.url.includes('/panel/panel.html')), 5000)
    const first = await ask()
    const popup = first && (await panelTarget(browser, first.id))
    check('Side panel: none open, Save to Curio… opens the panel in the page', !!popup && popup.url.includes('frame=1'))
    if (popup) {
      // the next right-click lands on this panel, which takes input once it has drawn
      await until(async () => { const f = await framedPanel(browser, 'panel'); return f && (await f.eval(`!document.getElementById('form').hidden`).catch(() => false)) }, 15000)
      const again = await ask()
      await sleep(1500)
      const panels = (await browser.send('Target.getTargets')).targetInfos.filter((t) => t.url.includes('/panel/panel.html'))
      const win = await framedPanel(browser, 'panel')
      const showing = again && win && (await until(() => win.eval(`document.getElementById('what').title || ''`).then((t) => (t.includes('/png') ? t : null)).catch(() => null), 10000))
      check('Panel in the page: the next Save to Curio… takes its place, no second one', panels.length === 1 && !!showing, `${panels.length} panels, showing ${showing}`)
      if (win) await win.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`).catch(() => true)
      const gone = await until(async () => !(await browser.send('Target.getTargets')).targetInfos.some((t) => t.url.includes('/panel/panel.html')), 5000)
      check('Panel in the page: Escape closes it', !!gone)
    }
    await dropOnArea()

    const windowId = await options.eval(`chrome.tabs.get(${w.tabId}).then((t) => t.windowId)`)
    await options.eval(`chrome.tabs.create({ windowId: ${windowId}, url: ${JSON.stringify(sideUrl)}, active: false }).then(() => true)`)
    const target = await until(async () => (await browser.send('Target.getTargets')).targetInfos.find((t) => t.url === sideUrl), 10000)
    stand = target && (await attach(browser, target.targetId))
    const between = () => stand.eval(`!document.getElementById('dropCard').hidden && document.getElementById('form').hidden && document.body.classList.contains('side')`).catch(() => false)
    check('Side panel: its page opens on the drop area over the folders', !!stand && !!(await until(between, 30000)))
    if (!stand) return
    const none = await dragPic(false)
    check('Side panel: open, a drag shows no drag card', !!none.data && !none.row && !(await framedPanel(browser, 'drop')))

    const second = await ask()
    await sleep(1500)
    const noWindow = !(await (async () => (await browser.send('Target.getTargets')).targetInfos.some((t) => second && t.url.includes('/panel/panel.html?capture=' + second.id)))())
    const shown = await until(() => stand.eval(`document.getElementById('what').title || ''`).then((t) => (t.includes('/png?w=300') ? t : null)), 10000)
    check('Side panel: open, it takes the capture, and no window opens', noWindow && !!shown, `${noWindow} ${shown}`)
    await stand.eval(`document.getElementById('name').value = 'Side picture'; document.getElementById('send').click()`)
    const sent = await panelStatus(stand)
    const rec = second && (await landed(options, await until(async () => { const r = await record(options, second.id); return FINAL.includes(r?.state) ? r : null }, 30000, 300)))
    check('Side panel: Send saves it, and returns to the drop area over the folders', !!sent?.includes(' ok|') && !!rec && !!(await until(between, 5000)), sent)
    if (opt.shots || process.env.EXT_SHOTS) {
      // a tab in the back draws nothing to take
      const standTarget = (await browser.send('Target.getTargets')).targetInfos.find((t) => t.url === sideUrl)
      if (standTarget) await browser.send('Target.activateTarget', { targetId: standTarget.targetId })
      await stand.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 760, deviceScaleFactor: opt.scale || 1, mobile: false })
      await sleep(500)
      await picture(stand, 'side-folders-between-saves')
      await stand.send('Emulation.clearDeviceMetricsOverride')
      await browser.send('Target.activateTarget', { targetId: page.targetId })
      await sleep(300)
    }
    const row = await until(() => stand.eval(`(() => { const e = document.querySelector('#dropFolders [data-id="${ctx.fixtures}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`), 10000)
    const dropOnStand = async (data) => {
      for (const type of ['dragEnter', 'dragOver', 'drop']) await stand.send('Input.dispatchDragEvent', { type, x: row.x, y: row.y, data: { items: [], dragOperationsMask: 1, ...data } })
    }
    const known = new Set(await options.eval('chrome.storage.session.get(null).then((s) => Object.keys(s).filter((k) => k.startsWith("capture:")))'))
    const newDrop = () => until(async () => {
      const all = await options.eval('chrome.storage.session.get(null)')
      const found = Object.entries(all).find(([k, v]) => k.startsWith('capture:') && !known.has(k) && v.tabId === w.tabId && v.trigger === 'drop' && FINAL.includes(v.state))
      return found ? found[1] : null
    }, 30000, 300)
    await browser.send('Target.activateTarget', { targetId: page.targetId })
    const data = row && (await startDrag(browser, page, await at('#pic')))
    if (data) {
      await dropOnStand(data)
      await freeMouse(page, data)
    }
    const fromPage = data && (await landed(options, await newDrop()))
    const fromItem = fromPage?.ids?.[0] ? await curio.item.get({ library: fromPage.dest.library, id: fromPage.ids[0] }) : null
    check('Folders between saves: a drag from the page dropped on a folder saves it there, read by the page', fromPage?.state === 'added' && !!fromItem?.folders.some((f) => f.id === ctx.fixtures) && fromItem.url === pageUrl && (await between()), `${!!row} ${!!data} ${fromPage?.state} ${fromItem?.folders?.map((f) => f.id)} ${fromItem?.url}`)
    // from elsewhere, with no page holding the drag: the form takes it with that folder and sends it
    const addr = src + (src.includes('?') ? '&' : '?') + 'between=' + ctx.runTag
    if (row) await dropOnStand({ items: [{ mimeType: 'text/uri-list', data: addr }] })
    const said = row && (await panelStatus(stand))
    const back = said && (await until(between, 5000))
    const found = said?.includes(' ok|') && (await curio.item.list({ library: ctx.library, folder: ctx.fixtures, limit: 200 }).catch(() => null))
    check('Folders between saves: an address dropped on a folder is sent there, and the folders come back', !!said?.includes(' ok|') && !!back, `${said} ${back} ${JSON.stringify(found)?.includes('between=' + ctx.runTag)}`)

  } finally {
    await options.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} })`)
    if (stand) await stand.eval('window.close()').catch(() => {})
    for (const t of (await browser.send('Target.getTargets')).targetInfos) if (t.url.includes('/panel/panel.html')) await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {})
    await page.close()
    await options.close()
  }
}

/** A link is sent to Curio with no note in the page, and one saved again isn't added twice. */
async function noteChecks(browser, id, curio, ctx) {
  console.log('-- links: no note, already in Curio')
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  await options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify({ last: { library: ctx.library, folders: [ctx.fixtures], tags: [ctx.runTag] }, recents: [], perLibrary: {}, aliases: {}, recentTags: [], rules: [FOLLOW] })} })`)
  const pageUrl = `http://127.0.0.1:${WEB}/collect.html?note=${ctx.runTag}`
  const page = await browser.open(pageUrl)
  const w = await watchTab(options, pageUrl)
  await sleep(500)
  await page.eval(`document.getElementById('lnk').href = '/about.html?note=${ctx.runTag}'`)
  const at = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)

  // a link goes to Curio, which compares it with the library's links and tells the result itself
  const lnk = await at('#lnk')
  await altClick(page, lnk)
  const first = await w.next('alt')
  await sleep(1000)
  check('Links: sent, with no note in the page', !!first?.queued && !(await noteSays(page, 'Sent to')))
  await altClick(page, lnk)
  const second = await w.next('alt')
  check('Already in Curio: a link saved twice isn\'t added twice', first?.state === 'added' && second?.state === 'added' && second.ids?.[0] === first.ids?.[0] && !!second.answer?.duplicates?.[0]?.skipped, `${first?.state} ${second?.state} ${JSON.stringify(second?.answer)}`)
  await page.close()
  await options.close()
}

/** Saves from the page's own gestures: Alt+click, the drop zone, the button on pictures, the shortcuts and screenshots. */
async function collect(browser, id, curio, ctx) {
  console.log('-- collecting from the page')
  // its own options page: one opened before extras() reloaded the extension is gone
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  await options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify({ last: { library: ctx.library, folders: [ctx.fixtures], tags: [ctx.runTag] }, recents: [], perLibrary: {}, aliases: {}, recentTags: [], rules: [FOLLOW] })} })`)
  // addresses of its own: earlier steps saved the plain ones, which would now be "already in Curio"
  const pageUrl = `http://127.0.0.1:${WEB}/collect.html?collect=${ctx.runTag}`
  const page = await browser.open(pageUrl)
  await browser.send('Target.activateTarget', { targetId: page.targetId })
  await sleep(500)
  await page.eval(`document.getElementById('lnk').href = '/about.html?collect=${ctx.runTag}'`)
  const tabId = await options.eval(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(pageUrl)})?.id)`)
  const seen = new Set(await options.eval('chrome.storage.session.get(null).then((s) => Object.keys(s).filter((k) => k.startsWith("capture:")))'))
  // the next finished capture of this tab that `trigger` made
  const next = async (trigger, ms = 60000) => landed(options, await until(async () => {
    const all = await options.eval('chrome.storage.session.get(null)')
    const found = Object.entries(all).find(([k, v]) => k.startsWith('capture:') && !seen.has(k) && v.tabId === tabId && v.trigger === trigger && FINAL.includes(v.state))
    if (found) seen.add(found[0])
    return found ? found[1] : null
  }, ms, 300))
  const itemOf = async (rec) => (rec?.ids?.[0] ? curio.item.get({ library: rec.dest.library, id: rec.ids[0] }) : null)
  const at = (sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const run = (name) => options.eval(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'command.run', name, tabId })})`)
  const pic = await at('#pic')

  await altClick(page, pic)
  const alt = await next('alt')
  const altItem = await itemOf(alt)
  check('Alt+click: the picture is saved', alt?.state === 'added' && altItem?.width === 300 && altItem.name.startsWith('Collect picture') && altItem.url === pageUrl, `${alt?.state} ${alt?.message || ''} ${altItem?.width} ${altItem?.name}`)
  await altClick(page, await at('#lnk'))
  const altLink = await next('alt')
  const linkItem = await itemOf(altLink)
  const clicks = await page.eval('window.__clicks + " " + location.pathname')
  check('Alt+click: a link is saved as a link, and the page never sees the click', altLink?.state === 'added' && linkItem?.ext === 'url' && linkItem.url.endsWith(`/about.html?collect=${ctx.runTag}`) && clicks === '0 /collect.html', `${altLink?.state} ${linkItem?.ext} ${linkItem?.url} ${clicks}`)
  const block = await at('#block')
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: block.x, y: block.y, button: 'left', clickCount: 1 })
  check('A plain click is the page\'s', (await page.eval('window.__clicks')) === 1)

  // a real drag out of the picture, held by the browser so it can be dropped on the zone
  browser.dragData = null
  await page.send('Input.setInterceptDrags', { enabled: true })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic.x, y: pic.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pic.x, y: pic.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic.x + i * 15, y: pic.y, button: 'left', buttons: 1 })
  const data = await until(() => browser.dragData, 5000)
  check('Drop zone: the drag starts from the picture', !!data)
  if (data) {
    const over = { x: pic.x + 120, y: pic.y + 10 }
    for (const type of ['dragEnter', 'dragOver']) await page.send('Input.dispatchDragEvent', { type, x: over.x, y: over.y, data })
    const row = await until(() => cardAt(browser, ctx.fixtures), 8000)
    const choose = await cardAt(browser, null)
    check('Drag card: shows the last library\'s folders beside the drop area', !!row && !!choose && row.text.includes('Fixtures'), row?.text)
    check('Drag card: All, the library itself, comes first', !!row && (await row.frame.eval(`document.querySelector('#dropFolders .p-row')?.dataset.all === '1'`)))
    await endDrag(page, data, row)
    const dropped = await next('drop')
    const dropItem = await itemOf(dropped)
    check('Drag card: a drop on a folder saves the picture there', dropped?.state === 'added' && dropItem?.width === 300 && dropped.dest.library === ctx.library && dropItem.folders.some((f) => f.id === ctx.fixtures), `${dropped?.state} ${dropped?.message || ''} ${dropItem?.width}`)
    check('Drag card: gone after the drop', !!(await until(async () => !(await framedPanel(browser, 'drop')), 3000)))
    await freeMouse(page, data)
  }
  await page.send('Input.setInterceptDrags', { enabled: false })

  // a drop on the drop area: the panel in the same place, on the dragged picture
  const data2 = await startDrag(browser, page, pic)
  const dropArea = data2 && (await until(() => cardAt(browser, null), 8000))
  await endDrag(page, data2, dropArea || null)
  const inPage = await until(() => framedPanel(browser, 'panel'), 8000)
  const shows = inPage && (await until(() => inPage.eval(`(document.getElementById('what').title || '').includes('/png') && !document.getElementById('send').disabled`), 15000))
  check('Drag card: a drop on the drop area opens the panel in the page on the picture', !!shows)
  if (inPage) {
    await inPage.eval(`document.getElementById('name').value = 'Dropped on the card'; document.getElementById('send').click()`)
    const sent = await next('drop')
    check('Panel in the page: Send saves it, and it closes', sent?.state === 'added' && !!(await until(async () => !(await framedPanel(browser, 'panel')), 5000)), sent?.state)
  }
  if (data2) await freeMouse(page, data2)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic.x, y: pic.y })
  await run('quick-save')
  const quick = await next('command')
  const quickItem = await itemOf(quick)
  check('Shortcut: Save what is under the pointer', quick?.state === 'added' && quickItem?.width === 300, `${quick?.state} ${quick?.message || ''} ${quickItem?.width}`)
  // a save that opens the form in the page on its screenshot: sent as it is or after `edit`, with what the form showed
  const viaForm = async (trigger, edit = '') => {
    const panel = await until(async () => {
      const f = await framedPanel(browser, 'panel')
      return f && (await f.eval(`!!document.querySelector('#preview img') && !document.getElementById('send').disabled`).catch(() => false)) ? f : null
    }, 20000)
    if (!panel) return { rec: null, shown: null }
    const shown = await panel.eval(`({ link: !document.getElementById('asLinkRow').hidden && document.getElementById('asLink').checked, name: document.getElementById('name').value })`)
    await panel.eval(`${edit}; document.getElementById('send').click(); true`)
    const rec = await next(trigger)
    await until(async () => !(await framedPanel(browser, 'panel')), 5000)
    return { rec, shown }
  }
  const thumbOf = async (rec) => (rec?.ids?.[0] ? curio.item.thumbnail({ library: rec.dest.library, id: rec.ids[0] }).then((b) => b?.size || 0, () => 0) : 0)
  await run('save-page')
  const pageForm = await viaForm('command')
  const pageItem = await itemOf(pageForm.rec)
  const pageThumb = await until(() => thumbOf(pageForm.rec), 10000)
  check('Shortcut: Save the page as a link opens the form on its screenshot, Save as link checked', !!pageForm.shown?.link && pageForm.shown.name.startsWith('Collect fixtures'), JSON.stringify(pageForm.shown))
  check('Shortcut: the page is saved as a link with its screenshot as the thumbnail', pageForm.rec?.state === 'added' && pageItem?.ext === 'url' && pageItem.url === pageUrl && pageThumb > 0, `${pageForm.rec?.state} ${pageItem?.ext} ${pageItem?.url} ${pageThumb}`)
  await run('save-page')
  const asShot = await viaForm('command', `document.getElementById('asLink').checked = false`)
  const asShotItem = await itemOf(asShot.rec)
  check('Save page with Save as link unchecked: the screenshot is saved, named after the page', asShot.rec?.state === 'added' && asShotItem?.ext === 'png' && asShotItem.name.startsWith('Collect fixtures') && asShotItem.url === pageUrl, `${asShot.rec?.state} ${asShotItem?.ext} ${asShotItem?.name} ${asShotItem?.url}`)
  // an address of its own, as the page's own is in the library by now
  await page.eval(`history.replaceState(null, '', location.href + '&all=1'), true`)
  await run('save-page-all')
  const allRec = await next('command')
  const allItem = await itemOf(allRec)
  check('Save the page to All: no form, a link in no folder, with its thumbnail', allRec?.state === 'added' && allItem?.ext === 'url' && allItem.folders.length === 0 && !(await framedPanel(browser, 'panel')) && (await until(() => thumbOf(allRec), 10000)) > 0, `${allRec?.state} ${allItem?.ext} ${JSON.stringify(allItem?.folders)}`)
  await page.eval(`history.replaceState(null, '', ${JSON.stringify(pageUrl)}), true`)

  // the toolbar button's menu, opened as a page: its entries, the drag card's switch, and an entry run for the tab it was opened over
  const popup = await browser.open(`chrome-extension://${id}/popup/popup.html`)
  const entries = await until(() => popup.eval(`[...document.querySelectorAll('.item .label')].map((e) => e.textContent).join('|')`), 5000)
  check('Toolbar menu: its entries', entries === 'Open|Save page as link|Screenshot area|Screenshot|Mode|Position|Options', entries)
  const pick = (m) => popup.eval(`(() => { const s = document.querySelector('.item select'); s.value = '${m}'; s.dispatchEvent(new Event('change')) })()`)
  const modeIs = (drag, hover) => until(() => options.eval(`chrome.storage.local.get('settings').then((s) => s.settings.drag === ${drag} && s.settings.hover === ${hover})`), 3000)
  await pick('button')
  const buttonMode = await modeIs(false, true)
  await pick('drag')
  check('Toolbar menu: Mode switches between the drag card and the button', !!buttonMode && !!(await modeIs(true, false)))
  // the real menu stands over the tab, which stays in front for its screenshot
  await browser.send('Target.activateTarget', { targetId: page.targetId })
  await popup.eval(`chrome.runtime.sendMessage({ type: 'popup.run', name: 'save-page', tabId: ${tabId} })`)
  const fromMenu = (await viaForm('command')).rec
  check('Toolbar menu: Save page as link opens the form for the tab it was opened over', !!fromMenu, fromMenu?.state)
  await popup.close().catch(() => {})

  await browser.send('Target.activateTarget', { targetId: page.targetId })
  await run('capture-visible')
  const shot = (await viaForm('shot')).rec
  const shotItem = await itemOf(shot)
  const width = await page.eval('Math.round(innerWidth * devicePixelRatio)')
  check('Screenshot: the visible area, as a PNG named after the page with the page as source', shot?.state === 'added' && shotItem?.ext === 'png' && shotItem.width === width && shotItem.name.startsWith('Collect fixtures') && shotItem.url === pageUrl, `${shot?.state} ${shot?.message || ''} ${shotItem?.ext} ${shotItem?.width}/${width} ${shotItem?.name}`)
  if (shotItem?.path) check('Screenshot: the extension\'s note isn\'t in it, the page is', near(pngPixel(shotItem.path, Math.round(block.x * (width / (await page.eval('innerWidth')))), Math.round(block.y * (width / (await page.eval('innerWidth'))))), 'c83232'))

  // an area inside the red block, 140 by 100 CSS pixels; an emulated density doesn't reach captureVisibleTab, so --scale sets a real one
  await run('capture-region')
  const overlay = await until(() => nodeIn(page, (n, a) => /^crop/.test(a.class || '')), 5000)
  check('Screenshot area: the page shows the marking overlay', !!overlay)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 620, y: 60 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 620, y: 60, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 100, button: 'left', buttons: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 160, button: 'left', buttons: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 760, y: 160, button: 'left', clickCount: 1 })
  const area = (await viaForm('shot')).rec
  const areaItem = await itemOf(area)
  const dpr = await page.eval('devicePixelRatio')
  check(`Screenshot area: cut to the marked area at ${dpr} device pixels per CSS pixel`, area?.state === 'added' && areaItem?.width === 140 * dpr && areaItem?.height === 100 * dpr, `${area?.state} ${area?.message || ''} ${areaItem?.width}x${areaItem?.height}`)
  if (areaItem?.path) check('Screenshot area: what is in it is the red block, without the overlay', near(pngPixel(areaItem.path, 70 * dpr, 50 * dpr), 'c83232'), pngPixel(areaItem.path, 70 * dpr, 50 * dpr))
  await run('capture-region')
  await until(() => nodeIn(page, (n, a) => /^crop/.test(a.class || '')), 5000)
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const cancelled = !(await next('shot', 2500))
  check('Screenshot area: Esc gives it up', cancelled && !(await nodeIn(page, (n, a) => /^crop/.test(a.class || ''))))

  const settings = await options.eval('chrome.storage.local.get("settings").then((s) => s.settings)')
  await options.eval(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, hover: true, hoverMin: 100 } })`)
  const registered = await until(() => options.eval('chrome.scripting.getRegisteredContentScripts().then((l) => l.some((s) => s.id === "hover"))'), 5000)
  check('Button on pictures: its script is registered while the option is on', !!registered)
  await sleep(800)
  const pic2 = await at('#pic')
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic2.x, y: pic2.y })
  const btn = await until(() => nodeIn(page, (n, a) => n.nodeName === 'BUTTON' && a.class === 'hover-btn'), 5000)
  check('Button on pictures: shown over the picture', !!btn)
  if (btn) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y })
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
    const asked = await until(() => framedPanel(browser, 'panel'), 8000)
    const ready = asked && (await until(() => asked.eval(`!document.getElementById('send').disabled`), 15000))
    check('Button on pictures: a click opens the panel on the picture', !!ready)
    if (ready) await asked.eval(`document.getElementById('send').click()`)
    const hovered = await next('hover')
    const hoverItem = await itemOf(hovered)
    check('Button on pictures: Send in the panel saves the picture', hovered?.state === 'added' && hoverItem?.width === 300, `${hovered?.state} ${hovered?.message || ''} ${hoverItem?.width}`)
  }
  await options.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} })`)
  const unregistered = await until(() => options.eval('chrome.scripting.getRegisteredContentScripts().then((l) => !l.some((s) => s.id === "hover"))'), 5000)
  check('Button on pictures: its script is gone once the option is off', !!unregistered)
  await page.close()
  await options.close()
}

/** Whether the extension's note in the page shows a text starting so. */
async function noteSays(page, text) {
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true })
  let found = false
  const walk = (n) => {
    if (n.nodeType === 3 && n.nodeValue.startsWith(text)) found = true
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c)
  }
  walk(root)
  return found
}

async function record(options, id) {
  return (await options.eval(`chrome.storage.session.get('capture:${id}')`))[`capture:${id}`]
}

async function panelTarget(browser, captureId) {
  // the panel in a page names no capture in its address; there is one at a time
  return until(async () => (await browser.send('Target.getTargets')).targetInfos.find((t) => t.url.includes('/panel/panel.html') && (t.url.includes('frame=1') || !captureId || t.url.includes(captureId))), 10000)
}

async function attach(browser, targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (m, p) => browser.send(m, p, sessionId)
  await send('Runtime.enable', {}).catch(() => {})
  return {
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    },
    // the panel in a page asks the page to take it away, as its Cancel does; one that already left has nothing to close
    async close() {
      const framed = await send('Runtime.evaluate', { expression: `new URLSearchParams(location.search).get('frame') === '1' && (parent.postMessage({ curio: 'close' }, '*'), true)`, returnByValue: true }).then((r) => r.result?.value === true, () => false)
      if (!framed) await browser.send('Target.closeTarget', { targetId }).catch(() => {})
    },
  }
}

async function panelStatus(panel) {
  return until(async () => {
    const s = await panel.eval(`document.getElementById('status').className + '|' + document.getElementById('status').textContent`)
    return / (ok|error)\|/.test(s) ? s : null
  }, 100000, 300)
}

/** The paths a fixture's quick save doesn't take: the panel from the menu, no destination yet, a site the script is off on, Save as link, drops into the panel. */
async function extras(browser, id, options, curio, ctx) {
  console.log('-- other paths')
  const pageUrl = `http://127.0.0.1:${WEB}/media.html`
  const page = await browser.open(pageUrl)
  await sleep(500)

  const asked = await capture(browser, id, options, page, pageUrl, 'canvas', { ask: true, panel: true })
  check('Save to Curio…: a capture waits for the panel', asked?.state === 'new')
  const opened = asked && (await panelTarget(browser, asked.id))
  check('Save to Curio…: the panel opens on it', !!opened)
  if (opened) {
    const panel = await attach(browser, opened.targetId)
    await until(() => panel.eval(`!document.getElementById('send').disabled`), 30000)
    await panel.eval(`document.getElementById('send').click()`)
    const status = await panelStatus(panel)
    const rec = await record(options, asked.id)
    check('Save to Curio…: Send in the panel saves the canvas the page read', status?.includes(' ok|') && rec?.state === 'added', `${status} ${rec?.state} ${rec?.message || ''}`)
    if (rec?.ids?.[0]) {
      const item = await curio.item.get({ library: rec.dest.library, id: rec.ids[0] })
      check('Save to Curio…: the canvas is a 90 px PNG', item.ext === 'png' && item.width === 90, `${item.ext} ${item.width}`)
    }
    await panel.close()
  }

  const dest = await options.eval('chrome.storage.local.get("dest").then((d) => d.dest)')
  await options.eval(`chrome.storage.local.set({ dest: { ...${JSON.stringify(dest)}, last: null } })`)
  const first = await capture(browser, id, options, page, pageUrl, 'plain', { panel: true })
  const firstPanel = first && (await panelTarget(browser, first.id))
  check('No destination yet: the panel opens instead of saving', first?.state === 'new' && !!firstPanel)
  if (firstPanel) await (await attach(browser, firstPanel.targetId)).close()
  await options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify(dest)} })`)

  const settings = await options.eval('chrome.storage.local.get("settings").then((s) => s.settings)')
  await options.eval(`chrome.storage.local.set({ settings: { ...${JSON.stringify(settings)}, off: ['127.0.0.1'] } })`)
  await sleep(500)
  const plain = await capture(browser, id, options, page, pageUrl, 'srcset')
  if (plain?.ids?.[0]) {
    const item = await curio.item.get({ library: plain.dest.library, id: plain.ids[0] })
    check('Off on this site: the menu\'s own address is saved, as the page shows it', plain.state === 'added' && item.width === 64, `${plain.state} ${item.width}`)
  } else check('Off on this site: the menu\'s own address is saved', false, plain?.state)
  await options.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} })`)
  await sleep(500)


  const broken = await capture(browser, id, options, page, pageUrl, 'broken')
  check('A file nobody can fetch: Curio takes it, and its download fails', broken?.queued && broken.state === 'failed', `${broken?.state} ${broken?.message || ''}`)
  await page.close()

  const panel = await browser.open(`chrome-extension://${id}/panel/panel.html`)
  await until(() => panel.eval(`!!document.querySelector('#folders [data-id="${ctx.fixtures}"]')`), 30000)
  const dropAt = await panel.eval(`(() => { const r = document.getElementById('drop').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const drop = async (data) => {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await panel.send('Input.dispatchDragEvent', { type, x: dropAt.x, y: dropAt.y, data: { items: [], dragOperationsMask: 1, ...data } })
  }
  const address = `http://127.0.0.1:${WEB}/png?w=66&h=66&c=123456`
  await drop({ items: [{ mimeType: 'text/uri-list', data: address }] })
  const shown = await until(() => panel.eval(`document.getElementById('drop').classList.contains('has') && !document.getElementById('send').disabled && !document.getElementById('asLinkRow').hidden`), 10000)
  check('Panel: a dropped address with no extension can still be saved as a file or a link', !!shown)
  const tag = 'drop-' + ctx.runTag
  const send = async () => {
    await panel.eval(`(() => {
      const row = document.querySelector('#folders [data-id="${ctx.fixtures}"]')
      row.click()
    const again = document.querySelector('#folders [data-id="${ctx.fixtures}"]')
    if (!again.classList.contains('on')) again.click()
      const t = document.getElementById('tagInput')
      t.value = ${JSON.stringify(tag)}
      t.dispatchEvent(new Event('change'))
      document.getElementById('status').textContent = ''
      document.getElementById('status').className = 'note'
      document.getElementById('send').click()
    })()`)
    return panelStatus(panel)
  }
  const s1 = await send()
  const byAddress = await until(async () => (await curio.item.query({ library: ctx.library, query: `tag = "${tag}"`, limit: 5 })).items.find((i) => i.width === 66), 60000, 500)
  check('Panel: the dropped address is saved as a file, with itself as source', s1?.includes(' ok|') && byAddress?.ext === 'png' && byAddress?.url === address, `${s1} ${JSON.stringify(byAddress && [byAddress.ext, byAddress.url])}`)
  const file = path.join(TARGET, 'ext-drop.png')
  fs.writeFileSync(file, png(68, 68, '654321'))
  const dragged = `http://127.0.0.1:${WEB}/png?w=68&h=68&c=654321`
  await drop({ files: [file], items: [{ mimeType: 'text/uri-list', data: dragged }] })
  await until(() => panel.eval(`document.getElementById('name').value === 'ext-drop'`), 10000)
  // a dropped file goes from the panel itself, with the rating and choices set there
  await panel.eval(`(() => {
    document.querySelectorAll('#rating .star')[1].click()
    const s = document.querySelector('select[data-key="ext_state"]')
    if (s) (s.value = 'reading'), s.dispatchEvent(new Event('change'))
  })()`)
  const s2 = await send()
  const found = (await curio.item.query({ library: ctx.library, query: `tag = "${tag}"`, limit: 5 })).items.find((i) => i.width === 68)
  const byFile = found && (await curio.item.get({ library: ctx.library, id: found.id }))
  check('Panel: a file dragged out of a page is saved with its address as source, rating and choice', s2?.includes(' ok|') && !!byFile && byFile.name.startsWith('ext-drop') && byFile.url === dragged && byFile.rating === 2 && byFile.fields?.ext_state === 'reading', `${s2} ${byFile?.name} ${byFile?.url} ${byFile?.rating} ${JSON.stringify(byFile?.fields)}`)
  await panel.close()

  // the extension reloaded under a page left open: the old content script steps aside and a new one is put in
  const kept = await browser.open(pageUrl)
  await sleep(500)
  // Chrome, and Chromium on Linux, drop an extension loaded this way when it reloads itself, so there it is loaded again, which reloads it
  if (opt.browser === 'chrome' || LINUX) await browser.send('Extensions.loadUnpacked', { path: EXT })
  else await options.eval('chrome.runtime.reload()').catch(() => {})
  await sleep(3000)
  // the extension may take longer to come back than that; a page opened before it has no extension APIs
  let fresh = null
  for (let i = 0; i < 20 && !fresh; i++) {
    const p = await browser.open(`chrome-extension://${id}/options/options.html`)
    if (await p.eval('!!chrome.storage?.session').catch(() => false)) fresh = p
    else {
      await p.close().catch(() => {})
      await sleep(500)
    }
  }
  if (!fresh) throw new Error('the extension did not come back after reloading itself')
  const after = await capture(browser, id, fresh, kept, pageUrl, 'inlink')
  check('After a reload, a page open from before still saves', after?.state === 'added', after?.state)
  const keptTab = await fresh.eval(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(pageUrl)})?.id)`)
  const known = await fresh.eval('chrome.storage.session.get(null).then((s) => Object.keys(s))')
  await altClick(kept, await kept.eval('fixture.locate("plain")'))
  const altAfter = await landed(fresh, await until(async () => Object.entries(await fresh.eval('chrome.storage.session.get(null)')).find(([k, v]) => !known.includes(k) && v.tabId === keptTab && v.trigger === 'alt' && FINAL.includes(v.state))?.[1], 30000, 300))
  check('After a reload, Alt+click on a page open from before still saves', altAfter?.state === 'added', altAfter?.state)
  await kept.close()
  await fresh.close()
}

/** Runs script in the sandbox's main window, through its WebView debugging port (dev/tools/cdp.mjs). */
function inSandbox(body) {
  const r = spawnSync('node', [path.join(APP, '..', 'dev', 'tools', 'cdp.mjs'), body], { encoding: 'utf8' })
  try {
    return JSON.parse(r.stdout.trim())
  } catch {
    return null
  }
}

/** What a person does in the sandbox's window when it asks to pair: reads the code, then presses the button. */
const answerPairing = (button) => inSandbox(`const d = [...document.querySelectorAll('.p-dialog')].find((x) => x.querySelector('.pair-code')); if (!d) return null; const code = d.querySelector('.pair-code').textContent.trim(); [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(button)}).click(); return code`)

/** Connect in the panel, as a person would: denied once, then allowed in the sandbox's window; answers the token Curio made. */
async function pairPanel(browser, id, port) {
  console.log('-- pairing')
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  await options.eval(`chrome.storage.local.set({ conn: { port: ${port}, token: '' } })`)
  await options.close()
  const panel = await browser.open(`chrome-extension://${id}/panel/panel.html`)
  check('Pairing: with no token, the panel offers Connect', !!(await until(() => panel.eval(`!document.getElementById('setup').hidden && !document.getElementById('pair').disabled`), 10000)))
  const ask = async (button) => {
    await panel.eval(`document.getElementById('pair').click()`)
    const shown = await until(() => panel.eval(`!document.getElementById('pairCode').hidden && document.getElementById('pairCode').textContent`), 5000)
    const seen = await until(() => answerPairing(button), 15000, 500)
    return { shown, seen }
  }
  const denied = await ask('Deny')
  check('Pairing: the sandbox window asks with the code the panel shows', !!denied.shown && String(denied.shown) === String(denied.seen), `${denied.shown} ${denied.seen}`)
  check('Pairing: Deny is told in the panel', !!(await until(() => panel.eval(`document.getElementById('setupStatus').className.includes('error') && document.getElementById('setupStatus').textContent`), 10000)))
  const allowed = await ask('Allow')
  check('Pairing: Allow opens the panel\'s form', !!allowed.seen && !!(await until(() => panel.eval(`!document.getElementById('form').hidden`), 15000)))
  const conn = await panel.eval('chrome.storage.local.get("conn").then((c) => c.conn)')
  await panel.close()
  return conn?.token || null
}

/** 200 MB: Curio downloads it, and a library no window holds adds it. */
async function largeFile(browser, id, options, curio, ctx) {
  console.log('-- a 200 MB file')
  await options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify({ last: { library: ctx.library, folders: [ctx.fixtures], tags: [ctx.runTag] }, recents: [], perLibrary: {}, aliases: {}, recentTags: [], rules: [FOLLOW] })} })`)
  const pageUrl = `http://127.0.0.1:${WEB}/big.html`
  const page = await browser.open(pageUrl)
  await sleep(500)
  const started = Date.now()
  const rec = await capture(browser, id, options, page, pageUrl, 'big')
  check(`200 MB file: added to ${ctx.libraryName} in ${Math.round((Date.now() - started) / 1000)} s`, rec?.state === 'added', `${rec?.state} ${rec?.message || ''}`)
  if (rec?.ids?.[0]) {
    const item = await curio.item.get({ library: rec.dest.library, id: rec.ids[0] })
    check('200 MB file: whole, in the library the page was saved to', rec.dest.library === ctx.library && item.size === 200 * 1024 * 1024 && item.ext === 'bin', `${item.size} ${item.ext}`)
    // not kept from run to run
    await curio.item.trash({ library: rec.dest.library, ids: rec.ids })
    await curio.item.purge({ library: rec.dest.library, ids: rec.ids }).catch((e) => check('200 MB file: removed afterwards', false, e.message))
  }
  await page.close()
}

/** Curio not running: the capture waits, Open Curio grants its tab one launch, and Curio started as the link starts it saves what waited. */
async function startCurio(browser, id, curio, ctx) {
  console.log('-- Curio not running')
  // the options page of the run went with the reload of the extension
  let options = await browser.open(`chrome-extension://${id}/options/options.html`)
  const pageUrl = `http://127.0.0.1:${WEB}/media.html`
  const page = await browser.open(pageUrl)
  await sleep(500)
  sandboxScript('-Stop')
  check('The sandbox is stopped', !(await curio.app.info().catch(() => null)))
  const conn = await options.eval('chrome.storage.local.get("conn").then((c) => c.conn)')
  let panel = await browser.open(`chrome-extension://${id}/panel/panel.html`)
  check('Panel, Curio not running: Open Curio, with the connection below it', !!(await until(() => panel.eval(`!document.getElementById('off').hidden && !document.getElementById('setup').hidden && document.getElementById('port').value === '${conn.port}'`), 10000)))
  await panel.eval(`document.getElementById('openCurio').click()`)
  // the launch frame is the panel's own origin, so the link it frames once granted can be read
  const framed = await until(() => panel.eval(`document.querySelector('body > iframe')?.contentDocument?.querySelector('iframe')?.getAttribute('src') || ''`), 5000)
  check('Panel: Open Curio frames the link, granted to the panel', framed === 'curio://open?background=1', framed)
  const rec = await capture(browser, id, options, page, pageUrl, 'plain', { settled: (s) => s === 'waiting' || FINAL.includes(s) })
  check('Curio not running: the capture waits', rec?.state === 'waiting', `${rec?.state} ${rec?.message || ''}`)
  if (!rec) return Promise.all([page.close(), options.close()])
  await sleep(300)
  check('Curio not running: the note offers Open Curio', await clickInPage(page, 'Open Curio'))
  check('Open Curio: the note says Curio is starting', !!(await until(() => noteSays(page, 'Starting Curio'), 5000)))
  // the launch frame asks within two seconds, and the grant is spent once it has
  await sleep(2500)
  check('Open Curio: the launch frame used its tab\'s grant', !(await options.eval('chrome.storage.session.get("launch")')).launch)

  // a second capture waits too, and Options removes it
  const second = await capture(browser, id, options, page, pageUrl, 'srcset', { settled: (s) => s === 'waiting' || FINAL.includes(s) })
  check('Waiting list: a second capture waits', second?.state === 'waiting', second?.state)
  await options.eval('location.reload()').catch(() => {})
  await sleep(800)
  const listed = await until(() => options.eval(`document.querySelectorAll('#queue li').length`).then((n) => (n >= 2 ? n : 0)), 8000, 500)
  check('Waiting list: Options lists both, as addresses for Curio', listed >= 2 && (await options.eval(`[...document.querySelectorAll('#queue li')].every((li) => li.textContent.includes('address'))`)), listed)
  await options.eval(`[...document.querySelectorAll('#queue li')].find((li) => li.textContent.includes('Responsive'))?.querySelector('button')?.click()`)
  const removed = second && (await until(async () => ((await record(options, second.id))?.state === 'failed' ? true : null), 8000, 300))
  check('Waiting list: Remove takes it out and it fails, so nothing waits for it', !!removed && !(await options.eval(`[...document.querySelectorAll('#queue li')].some((li) => li.textContent.includes('Responsive'))`)))

  // the extension reloads while it waits: the queue keeps it
  await panel.close().catch(() => {})
  if (opt.browser === 'chrome' || LINUX) await browser.send('Extensions.loadUnpacked', { path: EXT })
  else await options.eval('chrome.runtime.reload()').catch(() => {})
  await sleep(3000)
  options = await browser.open(`chrome-extension://${id}/options/options.html`)
  const kept = await until(async () => ((await record(options, rec.id))?.state === 'waiting' ? true : null), 10000, 500)
  check('After a reload, what waited is still waiting, from the queue', !!kept && (await until(() => options.eval(`document.querySelectorAll('#queue li').length`), 8000, 500)) === 1)
  panel = await browser.open(`chrome-extension://${id}/panel/panel.html`)
  // the browser would start this from the frame's link once the person allows it; here it is started the same way by hand
  const exe = path.join(SANDBOX, LINUX ? 'curio' : 'curio.exe')
  const link = 'curio://open?background=1'
  spawn(exe, [link], { env: { ...process.env, CURIO_BACKGROUND: '1' }, detached: true, stdio: 'ignore' }).unref()
  const done = await landed(options, await until(async () => {
    const r = await record(options, rec.id)
    return r && FINAL.includes(r.state) ? r : null
  }, 90000, 500))
  check('Curio started by the link: what waited is saved', done?.state === 'added', `${done?.state} ${done?.message || ''}`)
  if (done?.ids?.[0]) {
    const item = await curio.item.get({ library: done.dest.library, id: done.ids[0] })
    check('Curio started by the link: the item is in the library, with the picture the page had', done.dest.library === ctx.library && item.width === 64, `${done.dest.library} ${item.width}`)
  }
  check('Curio started by the link: the note about Curio is gone', !!(await until(async () => !(await noteSays(page, 'Starting Curio')) && !(await noteSays(page, 'Curio isn')), 5000)))
  check('Panel: its form comes once Curio answers', !!(await until(() => panel.eval(`!document.getElementById('form').hidden && document.getElementById('off').hidden`), 30000)))
  await panel.close()
  const again = spawn(exe, [link], { env: { ...process.env, CURIO_BACKGROUND: '1' }, stdio: 'ignore' })
  const code = await Promise.race([new Promise((r) => again.on('exit', r)), sleep(10000).then(() => 'still running')])
  if (code === 'still running') again.kill()
  check('A second start from the link ends at once, since Curio answers', code === 0, code)
  await page.close()
  await options.close()
  // back to the sandbox as sandbox.ps1 starts it, with its window and debugging port
  sandboxScript('-Background')
}

const PAGE_LIST = [
  { file: 'media.html' },
  { file: 'signed.html' },
  { file: 'frames.html' },
  { file: 'attrs.html' },
  { file: 'eagle.html' },
  { file: 'hostile.html' },
  { file: 'unfollowed.html', host: 'localhost' },
]

async function pass(browser, id, options, curio, ctx, hooks) {
  console.log(`-- into ${ctx.libraryName}`)
  await options.eval(`chrome.storage.local.set({ dest: ${JSON.stringify({ last: { library: ctx.library, folders: [ctx.fixtures], tags: [ctx.runTag] }, recents: [], perLibrary: {}, aliases: {}, recentTags: [], rules: [FOLLOW] })} })`)
  let last = null
  for (const p of PAGE_LIST) {
    const pageUrl = `http://${p.host || '127.0.0.1'}:${WEB}/${p.file}`
    const page = await browser.open(pageUrl)
    await sleep(500)
    for (const c of await page.eval('fixture.cases()')) {
      if (opt.only && !opt.only.includes(c.name)) continue
      try {
        // the page's other cases may have saved it already, which is "already in Curio" by design
        if (c.expect.fresh) await forget(curio, ctx.library, pageUrl)
        const rec = await capture(browser, id, options, page, pageUrl, c.name, hooks[c.name] || {})
        await verify(curio, c.name, rec, c.expect, { ...ctx, pageUrl })
        if (rec) last = { rec, page, pageUrl }
      } catch (e) {
        check(c.name, false, e.message)
      }
    }
    if (opt.shots && p.file === 'media.html' && last) {
      fs.mkdirSync(opt.shots, { recursive: true })
      const shot = await page.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(opt.shots, `toast-${ctx.libraryName.replace(/\W+/g, '-')}.png`), Buffer.from(shot.data, 'base64'))
    }
    await page.close()
  }
  return last
}

const stopServer = serve()
let browser
setTimeout(() => {
  console.log('FAIL the run took longer than 30 minutes')
  browser?.proc.kill()
  if (opt.browser === 'edge') endEdge()
  process.exit(2)
}, 30 * 60 * 1000).unref()
try {
  const { api, curio, port } = await sandbox()
  const runTag = 'ext-run-' + Date.now().toString(36)
  let libs = await curio.library.list()
  for (const name of [FIRST, SECOND]) if (!libs.some((l) => l.name === name)) await curio.library.create({ name })
  libs = await curio.library.list()
  const firstLib = libs.find((l) => l.name === FIRST)
  const second = libs.find((l) => l.name === SECOND)
  const firstFixtures = await prepare(curio, firstLib.id)
  const secondFixtures = await prepare(curio, second.id)
  if (!opt.one) {
    console.log(`waiting for ${SECOND} to close (its background process ends after an idle minute)`)
    const closed = await until(async () => (await curio.library.list()).find((l) => l.id === second.id)?.state === 'closed', 120000, 2000)
    check(`${SECOND} is closed when the run starts`, !!closed)
  }
  browser = await launch()
  const version = await browser.send('Browser.getVersion')
  const id = await browser.load()
  check(`${version.product} loads the extension`, !!id)
  check('The extension has its fixed id', id === 'chfhdgecmnomfokannimcbbjgghdmejg', id)
  // every save of the run goes with the token pairing made: pinned to the extension, with the paired permissions only
  // pairing is answered in Curio's own window, which only WebView2 opens to the debugging protocol; on Linux the run uses the sandbox's token
  const paired = LINUX ? (console.log('-- pairing: skipped on Linux, where the window of Curio has no debugging port to answer it'), null) : await pairPanel(browser, id, port)
  if (!LINUX) check('Pairing: Curio made a token', !!paired)
  const options = await browser.open(`chrome-extension://${id}/options/options.html`)
  await options.eval(`chrome.storage.local.set({ conn: { port: ${port}, token: ${JSON.stringify(paired || api.token)} }, settings: { v: 1, off: [], minSize: 24, eagle: true, makeFolders: false, keepTags: false, cookies: true, loopbackPort: ${WEB} }, dest: ${JSON.stringify({ rules: [FOLLOW] })} })`)
  const ctxOf = (lib, fixtures) => ({ library: lib.id, libraryName: lib.name, fixtures, runTag })
  if (!opt.only) await largeFile(browser, id, options, curio, ctxOf(second, secondFixtures))
  if (!opt.one) await pass(browser, id, options, curio, ctxOf(second, secondFixtures), { plain: { midway: true }, srcset: { cold: true } })
  const last = await pass(browser, id, options, curio, ctxOf(firstLib, firstFixtures), opt.one ? { plain: { midway: true }, srcset: { cold: true } } : {})
  if (last && !opt.only) await panelSend(browser, id, curio, ctxOf(firstLib, firstFixtures), last.rec)
  if (!opt.only) await extras(browser, id, options, curio, ctxOf(firstLib, firstFixtures))
  if (!opt.only || opt.only.includes('collect')) {
    await collect(browser, id, curio, ctxOf(firstLib, firstFixtures))
    await collectMore(browser, id, curio, ctxOf(firstLib, firstFixtures))
  }
  if (!opt.only || opt.only.includes('rules')) await ruleChecks(browser, id, curio, ctxOf(firstLib, firstFixtures))
  if (!opt.only || opt.only.includes('note')) await noteChecks(browser, id, curio, ctxOf(firstLib, firstFixtures))
  if (!opt.only || opt.only.includes('side')) await sideChecks(browser, id, curio, ctxOf(firstLib, firstFixtures))
  if (!opt.only || opt.only.includes('fields')) await fieldChecks(browser, id, curio, ctxOf(firstLib, firstFixtures))
  if (!opt.only) await startCurio(browser, id, curio, ctxOf(firstLib, firstFixtures))
  check('No uncaught errors in the extension\'s pages and content scripts', !browser.errors.length, [...new Set(browser.errors)].join(' | '))
  if (opt.shots && last) {
    const panel = await browser.open(`chrome-extension://${id}/panel/panel.html?capture=${last.rec.id}`)
    // the panel's window, light and dark, with the tag picker open; and the side panel's one column
    for (const [name, width, height, scheme, tags] of [['panel-light', 640, 640, 'light', false], ['panel-dark', 640, 640, 'dark', false], ['panel-tags', 640, 640, 'dark', true], ['panel-side', 400, 780, 'light', false]]) {
      await panel.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
      await sleep(1500)
      await panel.eval(tags ? `document.getElementById('tagInput').focus()` : `document.activeElement?.blur()`)
      await sleep(300)
      const shot = await panel.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(opt.shots, name + '.png'), Buffer.from(shot.data, 'base64'))
    }
    // the toolbar button's menu, at its own width
    const menu = await browser.open(`chrome-extension://${id}/popup/popup.html`)
    for (const [name, scheme] of [['menu-light', 'light'], ['menu-dark', 'dark']]) {
      await menu.send('Emulation.setDeviceMetricsOverride', { width: 256, height: 300, deviceScaleFactor: 2, mobile: false })
      await menu.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
      await sleep(800)
      const shot = await menu.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(opt.shots, name + '.png'), Buffer.from(shot.data, 'base64'))
    }
    // Options with a rule open
    const opts = await browser.open(`chrome-extension://${id}/options/options.html`)
    const rule = { id: 'shot-rule', name: '', matching: 'all', conditions: [{ field: 'site', op: 'is', value: 'example.com' }, { field: 'kind', op: 'is', value: 'image' }], library: firstLib.id, folders: [firstFixtures], tags: ['reference', runTag], tagsFrom: '.tags a', follow: false, ask: false, stop: false }
    await opts.eval(`chrome.storage.local.get('dest').then((d) => chrome.storage.local.set({ dest: { ...d.dest, rules: [${JSON.stringify(FOLLOW)}, ${JSON.stringify(rule)}] } }))`)
    for (const [name, scheme] of [['options-light', 'light'], ['options-dark', 'dark']]) {
      await opts.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1300, deviceScaleFactor: 1, mobile: false })
      await opts.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
      await opts.eval('location.reload()').catch(() => {})
      await sleep(1500)
      await opts.eval(`(() => { document.querySelectorAll('#rules .rule-head')[1]?.click(); document.getElementById('rules').scrollIntoView() })()`)
      await sleep(800)
      const shot = await opts.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(opt.shots, name + '.png'), Buffer.from(shot.data, 'base64'))
    }
  }
  // last: it gives the run's token up; the pictures need it
  if ((!opt.only || opt.only.includes('disconnect')) && !opt.shots) await disconnectCheck(browser, id, api.token)
} catch (e) {
  check('run', false, e.stack || e.message)
} finally {
  try {
    await browser?.send('Browser.close')
  } catch {}
  await sleep(300)
  browser?.proc.kill()
  if (opt.browser === 'edge') endEdge()
  stopServer()
  console.log(failures ? `${failures} failed` : 'all passed')
  process.exit(failures ? 1 : 0)
}
