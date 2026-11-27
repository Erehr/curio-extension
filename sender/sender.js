// @ts-check
// The offscreen document: fetches the bytes of what Curio can't download itself and makes every call that adds, since adds may wait two minutes and the worker is ended after 30 s of waiting (S3).
// It has chrome.runtime only; the worker hands it the port, the token and the record with each send, keeps the record's state itself, and reads a download's cookies when it is sent.
import '../curio.js'
import '../content/attrs.js'
import { M, BYTES_PORT, fromExtension } from '../lib/messages.js'
import { callFor, outcome, keepFields, MAX_BYTES, MAX_UPLOAD, MAX_HELD } from '../lib/captures.js'
import { fileName } from '../lib/naming.js'
import { state, client, whileBusy, upload } from '../lib/connection.js'
import { resolvePaths } from '../lib/destinations.js'
import * as queue from '../lib/queue.js'
import { S } from '../lib/strings.js'

const C = /** @type {any} */ (globalThis).CurioCompanion
const BASE = chrome.runtime.getURL('')
/** Captures waiting for bytes from their page, by id. @type {Map<string, { tabId: number | null, ok: (v: any) => void, no: (e: Error) => void }>} */
const waiting = new Map()
/** Captures that wait for Curio to start, with their bytes, by id. @type {Map<string, { rec: any, conn: any, file: any }>} */
const held = new Map()
/** Captures taken out of `held` whose run hasn't settled; still Curio's to answer, never lost. */
const resuming = new Set()
/** Screenshots by id, kept a while for a capture sent again from the panel. @type {Map<string, Blob>} */
const shots = new Map()

/** Sends in progress, and when anything last happened, for closing when there is nothing to do. */
let busy = 0
let lastUse = Date.now()
let lastShot = 0
const track = (p) => {
  busy++
  lastUse = Date.now()
  return p.finally(() => {
    busy--
    lastUse = Date.now()
  })
}
// what waits for Curio keeps the document open however long; the worker decides how long a screenshot is kept for
setInterval(() => {
  if (busy || held.size || resuming.size || waiting.size || watching) return
  chrome.runtime.sendMessage({ type: M.senderIdle, since: Date.now() - lastUse, shot: lastShot ? Date.now() - lastShot : 1e12 }).catch(() => {})
}, 5000)

const report = (type, id, extra = {}) => chrome.runtime.sendMessage({ type, id, ...extra }).catch(() => {})

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !fromExtension(sender, BASE)) return false
  lastUse = Date.now()
  if (msg.type === M.shot) {
    keepShot(msg).then(() => reply(true), (e) => (console.error(e), reply(false)))
    return true
  }
  if (msg.type === M.shotData) {
    const blob = shots.get(String(msg.id))
    if (!blob) return false
    dataUrl(blob).then(reply, () => reply(null))
    return true
  }
  if (msg.type === M.send) track(run(msg.capture, msg.conn))
  else if (msg.type === M.resume) {
    restore(msg.conn).then(() => reply(true), () => reply(false))
    return true
  } else if (msg.type === M.queueDrop) held.delete(String(msg.id))
  else if (msg.type === M.launch) {
    for (const h of held.values()) h.conn = msg.conn
    watch(msg.conn)
  } else if (msg.type === M.held) reply([...held.keys(), ...resuming])
  return false
})

/** What the queue kept from before this document started (a browser restart, an extension reload), held again with the connection the worker gives. */
async function restore(conn) {
  for (const e of await queue.all()) if (!held.has(e.id) && !resuming.has(e.id)) held.set(e.id, { rec: e.rec, conn, file: e.file })
  for (const h of held.values()) h.conn = conn
  if (held.size) watch()
}

/** Keeps a capture until Curio answers, in the queue as well, so it outlasts this document. */
async function hold(rec, conn, file, why, finish) {
  const size = file?.blob?.size || 0
  const kept = (await queue.size().catch(() => 0)) - ((await queue.get(rec.id).catch(() => null))?.size || 0)
  if (kept + size > MAX_HELD) return finish('failed', { message: S.heldFull })
  try {
    await queue.put({ id: rec.id, rec, file, size, at: Date.now(), why })
  } catch (e) {
    console.error(e)
  }
  held.set(rec.id, { rec, conn, file })
  report(M.progress, rec.id, { state: 'waiting', why })
  watch()
}

/** Until when a launch was asked for: checked every 500 ms until then, every 3 s otherwise. */
let launchUntil = 0
let watching = false

/** Watches for Curio while captures wait or a launch was asked for, and sends what waited once it answers, however it was started. */
async function watch(conn = null) {
  if (conn) launchUntil = Date.now() + 30000
  if (watching) return
  watching = true
  try {
    while (held.size || Date.now() < launchUntil) {
      await new Promise((r) => setTimeout(r, Date.now() < launchUntil ? 500 : 3000))
      const c = held.values().next().value?.conn || conn
      if (!c) break
      const st = await state(c, 1500)
      if (st.state !== 'off') {
        launchUntil = 0
        // each is taken out before it is sent, so a second look never sends it twice
        for (const [id, h] of [...held]) {
          held.delete(id)
          resuming.add(id)
          track(run(h.rec, h.conn, h)).finally(() => resuming.delete(id))
        }
        continue
      }
      if (launchUntil && Date.now() >= launchUntil) {
        launchUntil = 0
        chrome.runtime.sendMessage({ type: M.launchTimeout, ids: [...held.keys()] }).catch(() => {})
      }
    }
  } finally {
    watching = false
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(BYTES_PORT)) return
  const w = waiting.get(port.name.slice(BYTES_PORT.length))
  if (!w || port.sender?.tab?.id !== w.tabId) return port.disconnect()
  const parts = []
  let type = ''
  port.onMessage.addListener((m) => {
    if (m.t === 'meta') type = String(m.type || '')
    else if (m.t === 'chunk' && typeof m.data === 'string') parts.push(bytesOf(m.data))
    else if (m.t === 'end') w.ok({ blob: new Blob(parts, { type }), type })
    else if (m.t === 'error') w.no(new Error(String(m.message || 'The page couldn\'t read it')))
  })
  port.onDisconnect.addListener(() => w.no(new Error('Page closed')))
})

/** A screenshot cut to the marked area; the image's width over the page's width gives the device pixels per CSS pixel. A `small` one is the panel's preview, at most 480 pixels across. */
async function keepShot({ id, data, crop, small }) {
  let blob = await (await fetch(data)).blob()
  if (crop) {
    const bmp = await createImageBitmap(blob)
    const scale = bmp.width / crop.vw
    const x = Math.max(0, Math.round(crop.x * scale))
    const y = Math.max(0, Math.round(crop.y * scale))
    const w = Math.min(bmp.width - x, Math.round(crop.w * scale))
    const h = Math.min(bmp.height - y, Math.round(crop.h * scale))
    if (w < 1 || h < 1) throw new Error('Nothing in the marked area')
    const k = small ? Math.min(1, 480 / Math.max(w, h)) : 1
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
    canvas.getContext('2d')?.drawImage(bmp, x, y, w, h, 0, 0, canvas.width, canvas.height)
    bmp.close()
    blob = await canvas.convertToBlob(small ? { type: 'image/jpeg', quality: 0.85 } : { type: 'image/png' })
  }
  shots.set(id, blob)
  lastShot = Date.now()
  setTimeout(() => shots.delete(id), 30 * 60 * 1000)
  // the oldest go first past a handful
  for (const old of [...shots.keys()].slice(0, Math.max(0, shots.size - 12))) shots.delete(old)
}

function bytesOf(base64) {
  const text = atob(base64)
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function dataUrl(blob) {
  return new Promise((ok, no) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => no(r.error)
    r.readAsDataURL(blob)
  })
}

// pages and error texts come back where a file was expected
const NOT_A_FILE = /^(text\/html|text\/plain|application\/json|application\/xhtml)/i

class TooLarge extends Error {
  constructor(size) {
    super(S.tooLarge(Math.round(size / 1e6)))
    this.size = size
  }
}

/** The browser's own fetch: with the browser's sign-ins, except for an address a page's attribute named on another site. */
async function fetchFile(url, d) {
  const credentials = d.srcFromAttr && !C.sameSite(url, d.pageUrl) ? 'omit' : 'include'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120000)
  try {
    const r = await fetch(url, { credentials, signal: ctrl.signal })
    if (!r.ok) return null
    const type = r.headers.get('content-type') || ''
    if (NOT_A_FILE.test(type)) return null
    const length = Number(r.headers.get('content-length') || 0)
    if (length > MAX_UPLOAD) throw new TooLarge(length)
    const blob = await r.blob()
    if (!blob.size) return null
    if (blob.size > MAX_UPLOAD) throw new TooLarge(blob.size)
    return { blob, name: fileName({ title: d.title, url, type: blob.type || type, disposition: r.headers.get('content-disposition') || '' }) }
  } catch (e) {
    if (e instanceof TooLarge) throw e
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Bytes only the page can read, over a port its content script opens to this document. */
async function fromPage(rec) {
  const d = rec.draft
  const got = await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error('The page didn\'t answer')), 120000)
    waiting.set(rec.id, { tabId: rec.tabId, ok: (v) => (clearTimeout(timer), ok(v)), no: (e) => (clearTimeout(timer), no(e)) })
    report(M.bytesRequest, rec.id, { captureId: rec.id, inPageId: d.inPageId })
  }).finally(() => waiting.delete(rec.id))
  if (!got.blob.size) throw new Error('Nothing to save')
  if (got.blob.size > MAX_UPLOAD) throw new TooLarge(got.blob.size)
  const type = got.type || (d.kind === 'svg' ? 'image/svg+xml' : d.kind === 'canvas' ? 'image/png' : 'application/octet-stream')
  return { blob: got.blob.type ? got.blob : new Blob([got.blob], { type }), name: fileName({ title: d.title || d.pageTitle, url: /^https?:/i.test(d.src) ? d.src : '', type }) }
}

/** The ladder, for what Curio doesn't download itself: the browser's fetch for each candidate, then the page, then Curio's own download (left to the call). */
async function bytes(rec) {
  const d = rec.draft
  if (d.shot) {
    const blob = shots.get(d.shot)
    if (!blob) throw new Error(S.shotGone)
    return { blob, name: fileName({ title: d.title || d.pageTitle || 'Screenshot', type: 'image/png' }) }
  }
  let tooLarge = null
  for (const url of d.candidates.filter((c) => /^(https?|data):/i.test(c))) {
    try {
      const f = await fetchFile(url, d)
      if (f) return f
    } catch (e) {
      if (e instanceof TooLarge) tooLarge = e
    }
  }
  const pageMayRead = d.inPageId && rec.tabId != null && (d.inPage || (/^https?:/i.test(d.src) && new URL(d.src).origin === new URL(d.pageUrl || d.src).origin))
  if (pageMayRead && !tooLarge) {
    try {
      return await fromPage(rec)
    } catch (e) {
      if (e instanceof TooLarge) tooLarge = e
      else if (d.inPage) throw e
    }
  }
  if (tooLarge && !rec.urls?.length) throw tooLarge
  return null
}

/**
 * Fetches the bytes Curio can't download while the page still has them, holds the capture when Curio isn't running, and otherwise sends it.
 * @param {{ file: any } | null} got what an earlier run fetched before it was held
 */
async function run(rec, conn, got = null) {
  const finish = (st, extra = {}) => {
    queue.drop(rec.id).catch(() => {})
    return report(M.done, rec.id, { state: st, ...extra })
  }
  try {
    const st = await state(conn)
    if (st.state === 'refused' || st.state === 'no-token') return finish('failed', { message: st.state === 'refused' ? S.refused : S.noToken, conn: st.state })
    let file = got ? got.file : null
    if (!got && rec.via === 'bytes') {
      report(M.progress, rec.id, { state: 'fetching' })
      file = await bytes(rec)
      if (!file && !rec.urls?.length) return finish('failed', { message: 'Couldn\'t get the file' })
    }
    if (st.state === 'off') return hold(rec, conn, file, 'off', finish)
    const curio = client(conn)
    const busy = () => report(M.progress, rec.id, { opening: true })
    const library = rec.dest.library
    const extra = {}
    if (rec.dest.folderPaths?.length) {
      const folders = await whileBusy(() => curio.folder.list({ library }), { onBusy: busy })
      let { ids, missing } = resolvePaths(rec.dest.folderPaths, folders)
      if (missing.length && rec.makeFolders) {
        for (const path of missing) ids.push(await makePath(curio, library, path, folders))
        missing = []
      }
      if (missing.length) return finish('failed', { message: S.folderMissing(missing[0]), needsPanel: true })
      rec = { ...rec, dest: { ...rec.dest, folders: [...new Set([...ids, ...rec.dest.folders])], folderPaths: undefined } }
      extra.folders = rec.dest.folders
    }
    if (rec.draft.fields && Object.keys(rec.draft.fields).length) {
      const defined = await whileBusy(() => curio.field.list({ library }), { onBusy: busy })
      const { kept, dropped } = keepFields(rec.draft.fields, defined)
      rec = { ...rec, draft: { ...rec.draft, fields: kept } }
      if (dropped.length) extra.dropped = dropped
    }
    report(M.progress, rec.id, { state: 'sending' })
    let sent = null
    if (file && file.blob.size <= MAX_BYTES) sent = { data: await dataUrl(file.blob), name: file.name }
    else if (file) {
      let last = -1
      const progress = (part) => {
        const percent = Math.floor(part * 100)
        if (percent >= last + 5) report(M.progress, rec.id, { percent: (last = percent) })
      }
      try {
        sent = { upload: await upload(conn, file.blob, file.name, progress), name: file.name }
      } catch (e) {
        // nothing was added when an upload breaks off
        return finish('failed', { message: e && e.message ? e.message : String(e), ...extra })
      }
    }
    // a Curio that restarted since the first call forgot its requestId, so the bytes decide
    const onDuplicate = rec.called ? 'skip' : undefined
    // read now, never kept: they go in this call only
    const download = sent || rec.mode === 'link' ? {} : { referer: refererOf(rec.draft, rec.urls?.[0] || rec.draft.src), userAgent: navigator.userAgent, cookies: await cookiesFor(rec) }
    const { op, params } = callFor(rec, sent, { ...download, onDuplicate })
    let answer
    try {
      answer = await whileBusy(() => curio.call(op, params), { onBusy: busy })
    } catch (e) {
      // the call left and nothing came back: it may have been added, so it is sent again, and Curio answers the repeat with what the first did
      if (e && e.code === 'network') return hold({ ...rec, called: true }, conn, file, 'unknown', finish)
      return finish('failed', { message: e && e.message ? e.message : String(e), ...extra })
    }
    const o = outcome(answer)
    // a link saved with the page's screenshot shows that, as Curio makes none without Link previews; Curio sizes it down
    const shot = rec.mode === 'link' && rec.draft.shot ? shots.get(rec.draft.shot) : null
    if (shot && o.ids?.length) await curio.item.setThumbnail({ library, ids: o.ids, data: await dataUrl(shot) }).catch((e) => console.error(e))
    finish(o.state, { ...o, via: op, ...extra })
  } catch (e) {
    finish('failed', { message: e && e.message ? e.message : String(e) })
  }
}

/** The `Cookie` header for the download's address, from the worker, where the setting allows it; this document has no chrome.cookies. */
async function cookiesFor(rec) {
  const r = await chrome.runtime.sendMessage({ type: M.cookies, id: rec.id }).catch(() => null)
  return typeof r?.cookies === 'string' && r.cookies ? r.cookies : undefined
}

/** The page a download is asked for from, as the browser's own fetch sent it; a page on this computer or its network goes only to its own site. */
function refererOf(d, url) {
  if (!/^https?:/i.test(d.pageUrl || '') || (C.isPrivateHost(C.hostOf(d.pageUrl)) && !C.sameSite(d.pageUrl, url))) return undefined
  return d.referer || new URL(d.pageUrl).origin + '/'
}

/** Makes the folders of a path that don't exist yet, from the top. */
async function makePath(curio, library, path, folders) {
  let parent = null
  for (const name of path.split(' / ')) {
    let f = folders.find((x) => (x.parentId ?? null) === parent && x.name.toLowerCase() === name.toLowerCase())
    if (!f) {
      const made = await curio.folder.create({ library, name, ...(parent != null ? { parent } : {}) })
      f = { id: made.id, parentId: parent, name }
      folders.push(f)
    }
    parent = f.id
  }
  return parent
}
