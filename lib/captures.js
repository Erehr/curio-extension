// @ts-check
// The capture record, its states, its route to Curio, and the call that adds it. No chrome.* API: the worker, the sender and the panel share it.
import { cleanTitle } from './naming.js'

/**
 * @typedef {{
 *   kind: 'image' | 'video' | 'audio' | 'svg' | 'canvas' | 'file' | 'link' | 'page',
 *   src: string, candidates: string[], inPage: boolean, inPageId?: string,
 *   pageUrl: string, pageTitle: string, link: string, title: string, notes: string,
 *   tags: string[], rating?: number, favorite?: boolean, explicit?: boolean, fields?: Record<string, unknown>,
 *   hints: { library?: string, folders?: (number | string)[] }, type?: 'file' | 'link' | '', referer?: string,
 *   size?: { w: number, h: number }, stream?: boolean, shot?: string
 * }} Draft
 */
/** @typedef {{ library: string, folders: number[], tags: string[], folderPaths?: string[] }} Destination */
/** @typedef {'url' | 'bytes' | 'link' | 'bookmark'} Via */
/**
 * @typedef {{
 *   id: string, at: number, state: State, trigger: string, tabId: number | null, frameId: number,
 *   draft: Draft, dest: Destination | null, asked?: any, mode: 'file' | 'link',
 *   via?: Via, urls?: string[], request?: string, force?: boolean,
 *   ids?: string[], library?: string, message?: string, handed?: any[], dropped?: string[], ruleId?: number
 * }} Capture
 */
/** @typedef {'new' | 'fetching' | 'waiting' | 'sending' | 'added' | 'queued' | 'handed' | 'failed' | 'unknown'} State */

export const FINAL = new Set(['added', 'queued', 'handed', 'failed', 'unknown'])

const NEXT = {
  new: ['fetching', 'sending', 'failed'],
  fetching: ['fetching', 'waiting', 'sending', 'failed'],
  // held by the sender with its bytes until Curio answers
  waiting: ['waiting', 'sending', 'failed'],
  // back to waiting when the call got no answer and Curio takes requestId, so a repeat can't add it twice
  sending: ['added', 'queued', 'handed', 'failed', 'unknown', 'waiting'],
  added: [],
  // Curio took it and tells the result itself
  queued: [],
  handed: [],
  failed: [],
  unknown: [],
}

/** Up to 44 MB goes as base64 in one call: 44 MB is about 59 MB of base64, under Curio's 64 MiB body. */
export const MAX_BYTES = 44 * 1000 * 1000
/** Larger files go through Curio's upload, which takes up to 2 GiB. */
export const MAX_UPLOAD = 2 * 1024 * 1024 * 1024
/** What the sender keeps of captures waiting for Curio to start. */
export const MAX_HELD = 500 * 1000 * 1000

/**
 * @param {{ draft: Draft, dest: Destination | null, trigger: string, tabId?: number | null, frameId?: number, asked?: any, id?: string }} p
 * @returns {Capture}
 */
export function make({ draft, dest, trigger, tabId = null, frameId = 0, asked, id }) {
  const link = draft.type === 'link' || ((draft.kind === 'link' || draft.kind === 'page') && draft.type !== 'file')
  return { id: id || crypto.randomUUID(), at: Date.now(), state: 'new', trigger, tabId, frameId, draft, dest, asked, mode: link ? 'link' : 'file' }
}

/**
 * The record in its next state; a move the life of a capture doesn't allow throws.
 * @param {Capture} rec
 * @param {State} next
 * @returns {Capture}
 */
export function advance(rec, next, extra = {}) {
  if (!NEXT[rec.state].includes(next)) throw new Error(`A capture can't go from ${rec.state} to ${next}`)
  return { ...rec, ...extra, state: next }
}

/** A capture sent again after a failure, maybe as a link, with a new destination; a new request id, since Curio answers a repeated one with what the first call did. */
export function again(rec, patch = {}) {
  if (rec.state !== 'failed' && rec.state !== 'new') throw new Error(`A capture that is ${rec.state} isn't sent again`)
  const { ids, message, handed, via, urls, ...rest } = rec
  return { ...rest, ...patch, request: crypto.randomUUID(), state: 'new' }
}

/**
 * How a capture goes to Curio, and the web addresses Curio may download it from: the page's own, then the others best first, which Curio tries before it.
 * Curio downloads what has a public address; the browser reads screenshots, what is only in the page, and what is on this computer or its network; `browser` keeps every file with the browser.
 * @param {Capture} rec
 * @param {{ browser?: boolean, isPrivate: (url: string) => boolean }} o
 * @returns {{ via: Via, urls: string[] }}
 */
export function routeOf(rec, { browser = false, isPrivate }) {
  const d = rec.draft
  const web = (u) => typeof u === 'string' && /^https?:/i.test(u) && !isPrivate(u)
  if (rec.mode === 'link') return { via: web(d.src) ? 'link' : 'bookmark', urls: [] }
  // the candidates come best first, and the last is what the page shows
  const best = [...new Set([...d.candidates, d.src].filter(web))]
  const urls = best.length ? [best[best.length - 1], ...best.slice(0, -1)] : []
  return { via: d.shot || d.inPage || browser || !urls.length ? 'bytes' : 'url', urls }
}

/** @param {string[]} a @param {string[]} b */
export function mergeTags(a = [], b = []) {
  const seen = new Set()
  const out = []
  for (const t of [...a, ...b]) {
    const k = String(t).toLowerCase()
    if (t && !seen.has(k)) {
      seen.add(k)
      out.push(t)
    }
  }
  return out
}

/**
 * Where the item goes and what it carries, as Curio's add operations take it.
 * @param {Capture} rec
 */
export function placeOf(rec) {
  const d = rec.draft
  const dest = /** @type {Destination} */ (rec.dest)
  const p = { library: dest.library, folders: dest.folders || [], tags: mergeTags(dest.tags, d.tags) }
  if (d.notes) p.annotation = d.notes
  if (typeof d.rating === 'number') p.rating = d.rating
  if (d.favorite === true) p.favorite = true
  if (d.explicit === true) p.explicit = true
  if (d.fields && Object.keys(d.fields).length) p.fields = d.fields
  return p
}

/**
 * The call that adds a capture: bytes (inline, or an upload's id), an address Curio downloads, or a link.
 * What Curio downloads or saves as a link it answers at once (`queued`); Curio tells of every add in a notification of its own. A file or link the library holds already is skipped, unless the person asked for it again (`force`).
 * A link's own address is its `url`, so it gets no `sourceUrl`, which would replace it.
 * @param {Capture} rec
 * @param {{ data?: string, upload?: string, name: string } | null} file
 * @param {{ referer?: string, cookies?: string, userAgent?: string, onDuplicate?: string }} extra the `Referer`, `Cookie` and `User-Agent` Curio's download sends, and what a file sent as bytes that the library holds already does
 * @returns {{ op: string, params: Record<string, unknown> }}
 */
export function callFor(rec, file, extra = {}) {
  const d = rec.draft
  const place = { ...placeOf(rec), requestId: rec.request || rec.id }
  const name = d.title ? { name: d.title } : {}
  const told = { wait: false, onDuplicate: rec.force ? 'keep' : 'skip' }
  if (rec.via === 'bookmark') return { op: 'item.add.bookmark', params: { ...place, url: d.src, ...name } }
  // through fromUrls, so a plugin that takes such addresses gets it first; one with a screenshot waits for the item, to give it that as its thumbnail
  if (rec.mode === 'link') return { op: 'item.add.fromUrls', params: { ...place, ...told, ...(d.shot ? { wait: true } : {}), urls: [d.src], as: 'link', ...name } }
  // a dropped address has no page: the address itself is where it came from
  const source = d.link || d.pageUrl || (/^https?:/i.test(d.src) ? d.src : '')
  const from = source ? { sourceUrl: source } : {}
  if (file) return { op: 'item.add.fromBytes', params: { ...place, ...(file.upload ? { upload: file.upload } : { data: file.data }), name: file.name, ...from, onDuplicate: extra.onDuplicate || told.onDuplicate } }
  const [url, ...rest] = rec.urls?.length ? rec.urls : [d.src]
  // Curio tries the larger versions first, then the page's own address
  const alternates = rest.slice(0, 8)
  const params = { ...place, ...told, urls: [url], ...(alternates.length ? { alternates } : {}), ...from, ...(d.title ? { name: cleanTitle(d.title) } : {}) }
  if (extra.referer) params.referer = extra.referer
  if (extra.cookies) params.cookies = extra.cookies
  if (extra.userAgent) params.userAgent = extra.userAgent
  return { op: 'item.add.fromUrls', params }
}

/**
 * What an add's answer means for the capture.
 * @returns {{ state: State, ids?: string[], handed?: any[], message?: string }}
 */
export function outcome(answer) {
  if (!answer || typeof answer !== 'object') return { state: 'unknown' }
  if (answer.queued) return { state: 'queued' }
  if (answer.handed?.length && !answer.ids?.length) return { state: 'handed', handed: answer.handed }
  // a file skipped as a duplicate is saved as the item it duplicates
  const ids = [...(answer.ids || []), ...(answer.duplicates || []).filter((d) => d.skipped).map((d) => d.of)]
  if (ids.length) return { state: 'added', ids, message: answer.errors?.length ? answer.errors.join('; ') : undefined }
  return { state: 'failed', message: answer.errors?.join('; ') || 'Curio added nothing' }
}

/** Fields the library defines, and the keys dropped because it doesn't. */
export function keepFields(fields, defined) {
  const keys = new Set((defined || []).map((f) => f.key))
  const kept = {}
  const dropped = []
  for (const [k, v] of Object.entries(fields || {})) (keys.has(k) ? (kept[k] = v) : dropped.push(k))
  return { kept, dropped }
}
