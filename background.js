// @ts-check
// The worker: menus, messages, the capture's record and which context does what. It keeps nothing in variables across events and never waits on Curio for long.
import './curio.js'
import './content/attrs.js'
import * as store from './lib/store.js'
import * as cap from './lib/captures.js'
import * as dst from './lib/destinations.js'
import * as Rules from './lib/rules.js'
import { M, fromExtension } from './lib/messages.js'
import { candidates as siteCandidates } from './lib/sites.js'
import { client } from './lib/connection.js'
import { S } from './lib/strings.js'
import * as queue from './lib/queue.js'

const C = /** @type {any} */ (globalThis).CurioCompanion
const BASE = chrome.runtime.getURL('')
/** The panel's window from outside; the panel corrects it to 560 × 540 inside. */
const PANEL = { width: 576, height: 580 }
const CONTEXTS = /** @type {chrome.contextMenus.ContextType[]} */ (['image', 'video', 'audio', 'link', 'page', 'selection', 'frame'])

store.closeToContentScripts().catch(() => {})

chrome.runtime.onInstalled.addListener(async () => {
  await store.migrate()
  await sideBehavior()
  await menus()
  await hoverScript(true)
  await reachOpenTabs()
  await resumeQueue()
})

/** Captures the queue kept through a restart or a reload: their records again, and the sender told to take them up. */
async function resumeQueue() {
  const entries = await queue.all().catch(() => [])
  if (!entries.length) return
  for (const e of entries) if (!(await store.getCapture(e.id))) await store.putCapture({ ...e.rec, state: 'waiting' })
  await ensureSender()
  await chrome.runtime.sendMessage({ type: M.resume, conn: await store.conn() }).catch(() => {})
}

/** Options' Remove: out of the queue and the sender, and failed, so nothing waits for it. */
async function removeQueued(ids) {
  for (const id of ids) {
    await queue.drop(id).catch(() => {})
    chrome.runtime.sendMessage({ type: M.queueDrop, id }).catch(() => {})
    const rec = await store.getCapture(id)
    if (rec && rec.state === 'waiting') {
      const gone = cap.advance(rec, 'failed', { message: S.removed })
      await store.putCapture(gone)
      await show(gone, 'error', S.removed)
    }
  }
}

/** Pages open before the extension was installed or updated get its content script now, so their first right click is read as well. */
async function reachOpenTabs(files = null) {
  files ||= [...(chrome.runtime.getManifest().content_scripts?.[0]?.js || []), ...((await store.settings()).hover ? HOVER.js : [])]
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
    if (tab.id == null || tab.discarded) continue
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files }).catch(() => {})
  }
}

// the hover button's script is registered only while the option is on, so pages without it pay nothing
const HOVER = { id: 'hover', js: ['content/hover.js'], matches: ['http://*/*', 'https://*/*'], allFrames: true, runAt: /** @type {const} */ ('document_idle'), persistAcrossSessions: true }
async function hoverScript(quiet = false) {
  const on = (await store.settings()).hover
  try {
    const had = (await chrome.scripting.getRegisteredContentScripts({ ids: [HOVER.id] })).length > 0
    if (on === had) return
    if (!on) return await chrome.scripting.unregisterContentScripts({ ids: [HOVER.id] })
    await chrome.scripting.registerContentScripts([HOVER])
    if (!quiet) await reachOpenTabs(HOVER.js)
  } catch {}
}
chrome.runtime.onStartup.addListener(() => {
  sideBehavior()
  menus()
  resumeQueue()
})

async function menus() {
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({ id: 'ask', title: S.menuAsk, contexts: CONTEXTS })
  chrome.contextMenus.create({ id: 'save-page', title: S.menuPage, contexts: ['action'] })
  chrome.contextMenus.create({ id: 'capture-visible', title: S.menuShot, contexts: ['action'] })
  chrome.contextMenus.create({ id: 'capture-region', title: S.menuShotArea, contexts: ['action'] })
}

/** Theme for the page's note: Curio's tokens, forced light/dark, or null to follow the system. */
const pageTheme = async () => {
  const mode = store.themeModeOf(await store.settings())
  if (mode === 'curio') return (await store.theme())?.tokens || null
  if (mode === 'light' || mode === 'dark') return mode
  return null
}

const PANEL_URL = chrome.runtime.getURL('panel/panel.html')
const SIDE_URL = PANEL_URL + '?side=1'

/** The toolbar button opens its menu, never the side panel by itself, which an earlier version set. */
async function sideBehavior() {
  if (chrome.sidePanel) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
}

/** Whether a visible side panel is open in that window (any, for null). Handles Vivaldi keeping closed panels loaded while hidden and reporting non-normal/missing windowIds. */
async function sideIn(windowId) {
  const states = (await chrome.storage.session.get('sideStates')).sideStates || {}
  const open = await chrome.runtime.getContexts({ documentUrls: [SIDE_URL] }).catch(() => [])
  const normals = new Set((await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])).map((x) => x.id))
  const windowMatches = (w) => windowId == null || w == null || !normals.has(w) || w === windowId
  if (open.length) {
    for (const c of open) {
      const st = c.documentId ? states[c.documentId] : null
      if (c.contextType !== 'TAB' && st && st.visible === false) continue
      const w = Number.isInteger(c.windowId) && c.windowId >= 0 ? c.windowId : (st?.windowId ?? null)
      if (windowMatches(w)) return true
    }
    return false
  }
  // fallback for browsers (e.g. Vivaldi web panels) where an open side panel isn't listed by getContexts
  const entries = Object.entries(states).filter(([, s]) => s && s.visible)
  if (!entries.length) return false
  const pong = await Promise.race([chrome.runtime.sendMessage({ type: M.sidePing }).catch(() => null), new Promise((ok) => setTimeout(() => ok(null), 150))])
  if (pong && pong.visible) return windowMatches(Number.isInteger(pong.windowId) && pong.windowId >= 0 ? pong.windowId : null)
  // no live side panel answered: clear stale visible entries
  const next = {}
  for (const [k, v] of Object.entries(states)) if (!v?.visible) next[k] = v
  await chrome.storage.session.set({ sideStates: next }).catch(() => {})
  return false
}

async function setSideState(key, windowId, visible, gone = false) {
  if (!key) return
  const states = { ...((await chrome.storage.session.get('sideStates')).sideStates || {}) }
  if (gone) delete states[key]
  else states[key] = { windowId: Number.isInteger(windowId) && windowId >= 0 ? windowId : null, visible: !!visible, at: Date.now() }
  await chrome.storage.session.set({ sideStates: states })
}

const windowOf = (tabId) => (tabId == null || tabId < 0 ? Promise.resolve(null) : chrome.tabs.get(tabId).then((t) => t.windowId, () => null))

const PAGE_COMMANDS = store.SHORTCUT_COMMANDS.map(([name]) => name)

/** Active page keyboard shortcuts from extension settings (empty entries omitted). */
function pageShortcuts(s) {
  const map = store.shortcutsOf(s)
  return PAGE_COMMANDS.filter((name) => map[name]).map((name) => ({ name, shortcut: map[name] }))
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.settings) {
    pushSettings()
    hoverScript()
  }
})

async function pushSettings() {
  const s = await store.settings()
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !tab.url) continue
    chrome.tabs.sendMessage(tab.id, { type: 'settings', settings: pageSettings(s, tab.url) }).catch(() => {})
  }
}

function pageSettings(s, url) {
  const host = C.hostOf(url)
  return { on: !dst.hostMatches(host, s.off), minSize: s.minSize, eagle: s.eagle, drag: !!s.drag && !dst.hostMatches(host, s.dragOff), altClick: !!s.altClick, hover: !!s.hover, hoverCorner: s.hoverCorner, hoverSize: s.hoverSize, hoverMin: s.hoverMin, keys: pageShortcuts(s) }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId)
  if (id === 'ask') trigger({ ask: true, info, tab }).catch((e) => console.error(e))
  else command(id, tab).catch((e) => console.error(e))
})

/** Short debounce so accidental double-triggers or multi-frame key presses don't stack panels. */
let lastCommand = { name: '', at: 0 }
function triggerCommand(name, tab) {
  const now = Date.now()
  if (lastCommand.name === name && now - lastCommand.at < 350) return
  lastCommand = { name, at: now }
  command(name, tab).catch((e) => console.error(e))
}

/** An entry of the toolbar button's menu, for the tab it was opened over. */
async function popupRun(msg) {
  const name = String(msg.name)
  if (name === 'open-panel') return openPanel(null, Number.isInteger(msg.windowId) ? msg.windowId : null, Number.isInteger(msg.tabId) ? msg.tabId : null)
  if (!['save-page', 'capture-region', 'capture-visible'].includes(name) || !Number.isInteger(msg.tabId)) return
  const tab = await chrome.tabs.get(msg.tabId).catch(() => null)
  if (tab) await command(name, tab)
}

/** Fallback draft when the tab is viewing a direct image, video, or audio file and no content script answered. */
function directMediaDraft(tab) {
  const pageUrl = tab?.url || ''
  const kind = C.directMediaKind(pageUrl)
  if (!kind || !/^https?:/i.test(pageUrl)) return null
  const title = C.text(tab?.title || '', C.LIMITS.title)
  return { kind, src: pageUrl, candidates: [pageUrl], inPage: false, pageUrl, pageTitle: title, link: pageUrl, title, type: 'file' }
}

/** File selectors from site rules matching this tab's page (menu and shortcut triggers only, never drag). */
async function fileSelectorsFor(pageUrl, pageTitle) {
  const d = await store.dest()
  return Rules.fileSelectors(d.rules, { pageUrl, pageTitle }, C.hostOf(pageUrl))
}

/** A shortcut, or the same entry in the button's menu. */
async function command(name, tab) {
  if (!tab || tab.id == null || tab.id < 0) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
    if (active) tab = active
  }
  if (name === 'open-panel') return openPanel(null, tab?.windowId ?? null, tab?.id ?? null)
  if (!tab || tab.id == null || tab.id < 0) return
  if (name === 'quick-save') return pointerSave(tab)
  if (name === 'save-page' || name === SAVE_PAGE_ALL) {
    const pageUrl = tab.url || ''
    const selectors = name === 'save-page' ? await fileSelectorsFor(pageUrl, tab.title || '') : []
    const raw = /^https?:/i.test(pageUrl) || /^file:/i.test(pageUrl) ? await askFrame(tab.id, 0, {}, 'page', selectors, 2000) : null
    const base = raw || directMediaDraft(tab) || fromInfo({}, tab)
    // a page link takes a visible screenshot as its thumbnail; direct media and file-selector matches go as files
    const needsShot = base.kind === 'page' || base.kind === 'link'
    const fresh = needsShot ? await chrome.tabs.get(tab.id).catch(() => null) : null
    const shot = fresh?.active ? await grab(fresh, null, true) : null
    const all = name === SAVE_PAGE_ALL ? await allOf() : undefined
    return start({ raw: base, tab, pageUrl, frameId: Number.isInteger(raw?.frameId) ? raw.frameId : 0, trigger: 'command', ask: !all, dest: all, shot: shot || undefined })
  }
  if (name === 'capture-visible') return shoot(tab, null)
  if (name === 'capture-region') return askCrop(tab)
}

/** The shortcut that saves the page with no form: a link in the last library, in no folder. */
const SAVE_PAGE_ALL = 'save-page-all'

async function allOf() {
  const d = await store.dest()
  const libs = await libraries()
  const library = d.last?.library && libs.some((l) => dst.libraryKey(l) === d.last.library) ? d.last.library : libs[0] ? dst.libraryKey(libs[0]) : null
  return library ? { library, folders: [], tags: [] } : undefined
}

/** The shortcut's quick save: the frame the pointer moved in last, asked for what is under it there. */
async function pointerSave(tab) {
  let frameId = 0
  try {
    const seen = await chrome.scripting.executeScript({ target: { tabId: /** @type {number} */ (tab.id), allFrames: true }, func: () => /** @type {any} */ (globalThis).CurioCompanion?.pointer?.at || 0 })
    const latest = seen.filter((r) => typeof r.result === 'number' && r.result > 0).sort((a, b) => b.result - a.result)[0]
    if (latest) frameId = latest.frameId
  } catch {}
  const selectors = await fileSelectorsFor(tab.url || '', tab.title || '')
  const raw = await askFrame(/** @type {number} */ (tab.id), frameId, {}, 'pointer', selectors)
  await start({ raw: raw || fromInfo({}, tab), tab, pageUrl: tab.url || '', frameId: Number.isInteger(raw?.frameId) ? raw.frameId : frameId, trigger: 'command' })
}

const CROP = 'crop:'

/** Asks the page for the area to keep; its answer comes as crop.done, checked against this. */
async function askCrop(tab) {
  await chrome.storage.session.set({ [CROP + tab.id]: { at: Date.now() } })
  try {
    await chrome.tabs.sendMessage(tab.id, { type: M.cropStart }, { frameId: 0 })
  } catch {
    // no content script here (a store page, say): the whole visible area instead
    await chrome.storage.session.remove(CROP + tab.id)
    await shoot(tab, null)
  }
}

async function cropDone(msg, sender) {
  const tab = sender.tab
  if (tab?.id == null || sender.frameId !== 0) return
  const key = CROP + tab.id
  const asked = (await chrome.storage.session.get(key))[key]
  await chrome.storage.session.remove(key)
  if (!asked || Date.now() - asked.at > 10 * 60 * 1000 || !msg.rect) return
  const r = msg.rect
  const n = (v) => (Number.isFinite(v) ? Number(v) : NaN)
  const crop = { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h), vw: n(msg.vw) }
  if (Object.values(crop).some((v) => Number.isNaN(v) || v < 0) || !crop.vw || crop.w < 1 || crop.h < 1) return
  await shoot(tab, crop)
}

/**
 * A screenshot of the tab's visible area, cut to `crop` where given, kept by the sender under the id this answers; null where the browser refused it, which `quiet` doesn't tell.
 * The bytes stay in the sender; a capture names them by id, since records live in session storage.
 */
async function grab(fresh, crop, quiet = false) {
  if (!crop) await Promise.race([chrome.tabs.sendMessage(fresh.id, { type: M.uiHide, on: true }, { frameId: 0 }).catch(() => {}), new Promise((r) => setTimeout(r, 350))])
  let data
  try {
    data = await chrome.tabs.captureVisibleTab(fresh.windowId, { format: 'png' })
  } catch (e) {
    console.error(e)
    if (quiet) chrome.tabs.sendMessage(fresh.id, { type: M.uiHide, on: false }, { frameId: 0 }).catch(() => {})
    // the toast brings the note back as well
    else chrome.tabs.sendMessage(fresh.id, { type: M.toast, toast: { id: crypto.randomUUID(), tone: 'error', text: S.shotFailed, actions: [], theme: await pageTheme() } }, { frameId: 0 }).catch(() => {})
    return null
  }
  chrome.tabs.sendMessage(fresh.id, { type: M.uiHide, on: false }, { frameId: 0 }).catch(() => {})
  const id = crypto.randomUUID()
  try {
    await ensureSender()
  } catch (e) {
    console.error(e)
    return null
  }
  const kept = await Promise.race([chrome.runtime.sendMessage({ type: M.shot, id, data, crop }).catch(() => false), new Promise((r) => setTimeout(() => r(false), 3000))])
  return kept ? id : null
}

/** A screenshot, saved like a picture from the page, through the form. */
async function shoot(tab, crop) {
  const fresh = await chrome.tabs.get(tab.id).catch(() => null)
  if (!fresh || !fresh.active) return
  const id = await grab(fresh, crop)
  if (!id) return
  const pageUrl = fresh.url || ''
  const title = C.text(fresh.title || '', C.LIMITS.title) || C.hostOf(pageUrl) || 'Screenshot'
  const raw = { kind: 'image', src: '', candidates: [], inPage: false, pageUrl, pageTitle: title, link: pageUrl, title, type: 'file' }
  await start({ raw, tab: fresh, pageUrl, frameId: 0, trigger: 'shot', shot: id, ask: true })
}

/** The panel's own window, when one is open: the one place a capture opens outside the side panel. */
async function panelWindow() {
  const pages = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] }).catch(() => [])
  for (const c of pages) {
    if (!c.documentUrl?.startsWith(PANEL_URL) || c.documentUrl.includes('side=1') || c.windowId < 0) continue
    const w = await chrome.windows.get(c.windowId).catch(() => null)
    if (w?.type === 'popup') return w.id
  }
  return null
}

const GRANT = 'grant:'

/** A drop on the drag card: on a folder, saved there at once as a drop zone's row is; on the drop area, the panel. The frame the drag began in takes it. */
async function frameDrop(msg, tabId) {
  let key = 'choose'
  // a folder, or All: the library itself
  if (msg.at === 'folder' && typeof msg.library === 'string' && (Number.isInteger(msg.folder) || msg.folder === null)) {
    key = crypto.randomUUID().slice(0, 8)
    await chrome.storage.session.set({ [ZONE + tabId]: { at: Date.now(), rows: [{ key, label: '', dest: { library: msg.library, folders: msg.folder === null ? [] : [msg.folder], tags: [] } }] } })
  }
  return (await chrome.tabs.sendMessage(tabId, { type: 'drop.at', key }).catch(() => false)) === true
}

/** The tab of each browser window whose drag the open side panel was left to take, by window. @type {Map<number, { tabId: number, at: number }>} */
const sideDrags = new Map()

/** A drop on the open side panel: on a folder to save there at once, or on the drop area to open in the form; false where no page holds a drag. */
async function sideDrop(msg) {
  let key = Number.isInteger(msg.windowId) && sideDrags.has(msg.windowId) ? msg.windowId : null
  // Vivaldi's side panel may report a different windowId than the tab; fall back to the freshest active drag
  if (key == null) {
    let bestAt = 0
    for (const [wid, entry] of sideDrags) if (Date.now() - entry.at <= 60000 && entry.at >= bestAt) { bestAt = entry.at; key = wid }
  }
  const d = key != null ? sideDrags.get(key) : null
  let tabId = d && Date.now() - d.at <= 60000 ? d.tabId : null
  if (key != null) sideDrags.delete(key)
  // a quick drag straight off the page edge into the side panel may skip dragover's 30px threshold: check the active tab
  if (tabId == null) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
    tabId = active?.id ?? null
  }
  if (tabId == null) return false
  if (msg.at === 'panel') return frameDrop({ at: 'panel' }, tabId)
  if (typeof msg.library !== 'string' || !(Number.isInteger(msg.folder) || msg.folder === null)) return false
  return frameDrop({ at: 'folder', library: msg.library, folder: msg.folder }, tabId)
}

/** The panel drawn in the tab's page, on the secret it must show; false where the page can't take it (no content script, a page that blocks the frame). `center` places the panel centered in the viewport instead of beside the pointer. */
async function inPage(tabId, captureId, mode = 'panel', center = false) {
  const secret = crypto.randomUUID()
  const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1)
  await chrome.storage.session.set({ [GRANT + secret]: { tabId, capture: captureId, mode, zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1, at: Date.now() } })
  const shown = await chrome.tabs.sendMessage(tabId, { type: M.frameOpen, secret, mode, center }, { frameId: 0 }).catch(() => false)
  if (shown !== true) await chrome.storage.session.remove(GRANT + secret)
  return shown === true
}

/** A framed panel's secret: good once, for the tab it was made for, for half a minute. */
async function frameGrant(msg, sender) {
  const key = GRANT + String(msg.secret || '')
  const g = (await chrome.storage.session.get(key))[key]
  if (!g) return null
  await chrome.storage.session.remove(key)
  if (sender.tab?.id !== g.tabId || !sender.url?.startsWith(PANEL_URL + '?frame=1') || !sender.frameId || Date.now() - g.at > 30000) return null
  return { capture: g.capture, mode: g.mode, tab: g.tabId, zoom: Number.isFinite(g.zoom) && g.zoom > 0 ? g.zoom : 1 }
}

/** The panel, on a capture or empty: an open side panel in that window takes it; else the tab's page draws the floating card; else the panel's own window, reused and brought forward, or a new centered one. */
async function openPanel(captureId, windowId = null, tabId = null) {
  if (captureId) {
    if (await sideIn(windowId)) {
      await chrome.storage.session.set({ panelWant: { capture: captureId, windowId, to: 'side', at: Date.now() } })
      if (tabId != null && tabId >= 0) chrome.tabs.sendMessage(tabId, { type: M.frameClose, onlyDrop: true }, { frameId: 0 }).catch(() => {})
      return
    }
  } else if (await sideIn(windowId)) return
  if (tabId != null && tabId >= 0 && (await inPage(tabId, captureId, 'panel', true))) return
  const own = await panelWindow()
  if (own != null) {
    if (captureId) await chrome.storage.session.set({ panelWant: { capture: captureId, windowId: own, to: 'window', at: Date.now() } })
    return chrome.windows.update(own, { focused: true })
  }
  const url = PANEL_URL + (captureId ? '?capture=' + encodeURIComponent(captureId) : '')
  const anchor = (windowId != null ? await chrome.windows.get(windowId).catch(() => null) : null) || (await chrome.windows.getLastFocused().catch(() => null))
  const pos = anchor && Number.isFinite(anchor.left) && Number.isFinite(anchor.top) && Number.isFinite(anchor.width) && Number.isFinite(anchor.height)
    ? { left: Math.max(0, Math.round(anchor.left + (anchor.width - PANEL.width) / 2)), top: Math.max(0, Math.round(anchor.top + (anchor.height - PANEL.height) / 2)) }
    : {}
  return chrome.windows.create({ url, type: 'popup', ...PANEL, ...pos })
}

/** The libraries as last listed; listed again when older than a minute and Curio answers quickly. */
async function libraries() {
  const cached = await store.libraries()
  if (cached && Date.now() - cached.at < 60000) return cached.list
  try {
    const conn = await store.conn()
    if (!conn.token) return cached?.list || []
    const list = await Promise.race([client(conn).library.list(), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 3000))])
    await store.setLibraries(list)
    return list
  } catch {
    return cached?.list || []
  }
}

/** The draft of the element the person pointed at, from the frame that saw it, or from whichever frame saw the pointer when the frame isn't known; null where no content script runs. */
async function askFrame(tabId, frameId, info, use = undefined, fileSelectors = undefined, timeout = 5000) {
  const pick = { srcUrl: info.srcUrl, linkUrl: info.linkUrl, mediaType: info.mediaType, pageUrl: info.pageUrl, frameUrl: info.frameUrl, selectionText: info.selectionText }
  const selectors = Array.isArray(fileSelectors) && fileSelectors.length ? fileSelectors : undefined
  const ask = frameId == null ? chrome.tabs.sendMessage(tabId, { type: M.draftGet, info: pick, anyFrame: true, fileSelectors: selectors }) : chrome.tabs.sendMessage(tabId, { type: M.draftGet, info: pick, use, fileSelectors: selectors }, { frameId })
  try {
    return await Promise.race([ask, new Promise((ok) => setTimeout(() => ok(null), timeout))])
  } catch {
    return null
  }
}

/** What the menu itself knows, for pages where the content script can't run or is off. */
function fromInfo(info, tab) {
  const page = tab?.url || info.pageUrl || ''
  if (info.mediaType && info.srcUrl && info.mediaType !== 'canvas') {
    const kind = info.mediaType === 'image' ? 'image' : info.mediaType
    return { kind, src: info.srcUrl, candidates: [info.srcUrl], inPage: false, pageUrl: page, link: page, title: '' }
  }
  if (info.linkUrl) return { kind: 'link', src: info.linkUrl, pageUrl: page, link: page, title: info.selectionText || '' }
  return { kind: 'page', src: page, pageUrl: page, link: page, title: tab?.title || '' }
}

/** The checked draft with the larger versions the site rules know, and the tab's title where the page gave none. */
function complete(draft, tab) {
  const d = C.expandCandidates(draft, siteCandidates)
  if (!d.pageTitle) d.pageTitle = C.text(tab?.title || '', C.LIMITS.title)
  if (!d.title && d.kind === 'page') d.title = d.pageTitle
  return d
}

async function trigger({ ask = false, info, tab, trigger = 'menu' }) {
  const tabId = tab?.id ?? null
  const pageUrl = tab?.url || info.pageUrl || ''
  const selectors = trigger === 'menu' ? await fileSelectorsFor(pageUrl, tab?.title || '') : []
  const raw = tabId != null && tabId >= 0 ? await askFrame(tabId, info.frameId, info, undefined, selectors) : null
  const frameId = Number.isInteger(raw?.frameId) ? raw.frameId : info.frameId ?? 0
  await start({ raw: raw || fromInfo(info, tab), tab, pageUrl, frameId, ask, trigger })
}

/**
 * A capture from a draft, checked against the tab's own address, then sent or asked about in the panel.
 * `dest` is a destination the person picked in the page (a folder of the drag card); it keeps its place and takes the rules' tags.
 */
async function start({ raw, tab, pageUrl, frameId = 0, ask = false, trigger, dest = undefined, shot = undefined }) {
  const draft = complete(C.checkDraft(raw, pageUrl), tab)
  // the worker's own: a screenshot the sender holds
  if (shot) draft.shot = shot
  const settings = await store.settings()
  const host = C.hostOf(pageUrl)
  const d = await store.dest()
  const ruled = dest ? Rules.apply(d.rules, draft, host) : null
  const r = ruled ? { dest: { ...dest, tags: [...new Set([...(dest.tags || []), ...ruled.tags])] }, from: 'zone', asked: null, rules: { ...ruled, ask: false } } : dst.resolve(draft, d, await libraries(), host, { rememberFolder: settings.rememberFolder, keepTags: settings.keepTags })
  if (r.rules.selectors.length && tab?.id != null && tab.id >= 0) draft.tags = C.tags(JSON.stringify([...draft.tags, ...(await tagsFrom(tab.id, frameId, r.rules.selectors))]))
  const rec = { ...cap.make({ draft, dest: r.dest, trigger, tabId: tab?.id ?? null, frameId, asked: r.asked }), makeFolders: settings.makeFolders, from: r.from, ruleTags: r.rules.tags }
  await forgetOld()
  await store.putCapture(rec)
  if (ask || !r.dest || r.rules.ask) {
    // after a drop the drag card covers the page, and the address loads anyway
    if (draft.box && frameId === 0 && trigger !== 'drop' && (draft.kind === 'image' || draft.kind === 'video')) await previewOf(tab, rec.id, draft.box)
    return openPanel(rec.id, tab?.windowId ?? null, tab?.id ?? null)
  }
  await dispatch(rec)
}

/** The element as the page showed it, cut from the visible tab before the panel covers it, for a preview whose address won't load in the panel; the sender keeps it in memory under `thumb:` and the capture's id. */
async function previewOf(tab, id, box) {
  if (tab?.windowId == null) return
  let data
  try {
    data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 })
  } catch {
    return
  }
  ensureSender().then(() => chrome.runtime.sendMessage({ type: M.shot, id: 'thumb:' + id, data, crop: box, small: true })).catch(() => {})
}

/** The text of what the rules' selectors find in the frame the capture came from, as tags. */
async function tagsFrom(tabId, frameId, selectors) {
  const texts = await chrome.tabs.sendMessage(tabId, { type: M.tagsFrom, selectors }, { frameId }).catch(() => [])
  return Rules.pageTags(texts)
}

const ZONE = 'zone:'

/** The drop zone's rows for a tab: the last destination and recent ones, kept under keys the drop must name, since recents change. */
async function zoneRows(tabId) {
  const d = await store.dest()
  const libs = (await store.libraries())?.list || []
  const rows = []
  const seen = new Set()
  for (const r of [d.last, ...(d.recents || [])]) {
    if (!r || rows.length >= 6) continue
    const k = JSON.stringify([r.library, r.folders, r.tags])
    if (seen.has(k)) continue
    seen.add(k)
    const name = dst.label(r, libs, (await store.lists(r.library))?.folders || [])
    if (!name) continue
    const tags = (r.tags || []).length ? ' · ' + r.tags.join(', ') : ''
    rows.push({ key: crypto.randomUUID().slice(0, 8), label: name + tags, dest: { library: r.library, folders: r.folders || [], tags: r.tags || [] } })
  }
  await chrome.storage.session.set({ [ZONE + tabId]: { at: Date.now(), rows } })
  return rows.map(({ key, label }) => ({ key, label }))
}

const GESTURE = { alt: 'altClick', drop: 'drag', hover: 'hover' }

/** A save from the page's own gesture; the page's word, so its settings and its draft are checked here again. */
async function pageSave(msg, sender) {
  const tab = sender.tab
  if (tab?.id == null || !Object.hasOwn(GESTURE, msg.how)) return
  const ps = pageSettings(await store.settings(), tab.url || '')
  if (!ps.on || !ps[GESTURE[msg.how]]) return
  let dest
  // the button on pictures opens the panel on the picture
  let ask = msg.how === 'hover'
  if (msg.how === 'drop') {
    const key = ZONE + tab.id
    const z = (await chrome.storage.session.get(key))[key]
    await chrome.storage.session.remove(key)
    const row = z && Date.now() - z.at < 10 * 60 * 1000 ? z.rows.find((r) => r.key === msg.row) : null
    if (row) dest = row.dest
    else ask = true
  }
  await start({ raw: msg.draft, tab, pageUrl: tab.url || '', frameId: sender.frameId ?? 0, ask, trigger: msg.how, dest })
}

async function forgetOld() {
  for (const rec of await store.allCaptures()) if (Date.now() - rec.at > 60 * 60 * 1000 && cap.FINAL.has(rec.state)) await store.dropCapture(rec.id)
}

async function where(rec) {
  const libs = (await store.libraries())?.list || []
  const folders = (await store.lists(rec.dest.library))?.folders || []
  return dst.label(rec.dest, libs, folders) || rec.dest.library
}

/** The Referer the page would have sent, set for the capture's own fetches only, through a session rule (S5). */
async function refererRule(rec) {
  const d = rec.draft
  if (rec.via !== 'bytes' || d.inPage || !/^https?:/i.test(d.pageUrl)) return undefined
  const hosts = [...new Set(d.candidates.filter((c) => /^https?:/i.test(c)).map((c) => C.hostOf(c)).filter(Boolean))]
  if (!hosts.length) return undefined
  const pageHost = C.hostOf(d.pageUrl)
  if (C.isPrivateHost(pageHost) && hosts.some((h) => !C.isPrivateHost(h))) return undefined
  const value = d.referer || new URL(d.pageUrl).origin + '/'
  const id = await store.nextRuleId()
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value }] }, condition: { requestDomains: hosts, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] } }],
    })
    return id
  } catch {
    return undefined
  }
}

/** Opening and closing the sender wait for each other, so a save never finds it half closed. */
let senderTurn = Promise.resolve()
let senderUsed = 0

function ensureSender() {
  const go = async () => {
    senderUsed = Date.now()
    const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    if (open.length) return
    try {
      await chrome.offscreen.createDocument({ url: 'sender/sender.html', reasons: ['BLOBS'], justification: 'Fetches what is saved and sends it to Curio on this computer' })
    } catch (e) {
      if (!/single offscreen/i.test(String(e))) throw e
    }
  }
  const p = senderTurn.then(go, go)
  senderTurn = p.catch(() => {})
  return p
}

/** The sender has had nothing to do for `since` ms, and took its last screenshot `shot` ms ago: closed after the setting's minute, or five while a preview may still be asked for. */
function senderIdle(since, shot) {
  const go = async () => {
    const idle = (await store.settings()).senderIdle || 60000
    if (since < idle || shot < 5 * idle || Date.now() - senderUsed < idle) return
    // a screenshot the panel may still send lives only in the sender
    if ((await store.allCaptures()).some((rec) => rec.draft?.shot && !cap.FINAL.has(rec.state) && Date.now() - rec.at < 30 * 60 * 1000)) return
    await chrome.offscreen.closeDocument().catch(() => {})
  }
  senderTurn = senderTurn.then(go, go).catch(() => {})
}

/** Whether an address is on this computer or its network, which Curio doesn't download from; the one port `loopbackPort` names is Curio's to reach, for tools/ext.mjs. */
function privateFor(s) {
  return (u) => {
    const host = C.hostOf(u)
    if (s.loopbackPort && /^(127\.0\.0\.1|localhost)$/.test(host) && Number(new URL(u).port) === s.loopbackPort) return false
    return C.isPrivateHost(host)
  }
}

async function dispatch(rec) {
  const s = await store.settings()
  rec = { ...rec, ...cap.routeOf(rec, { browser: s.browserDownload, isPrivate: privateFor(s) }) }
  rec = rec.via === 'bytes' ? cap.advance(rec, 'fetching', { ruleId: await refererRule(rec) }) : cap.advance(rec, 'sending')
  await store.putCapture(rec)
  // a page's choice and a rule's place leave the last destination as it was, and a rule's tags don't stay with it
  if (!['page', 'rule'].includes(rec.from)) await store.setDest(dst.remember(await store.dest(), { ...rec.dest, tags: rec.dest.tags.filter((t) => !(rec.ruleTags || []).includes(t)) }, C.hostOf(rec.draft.pageUrl || '')))
  await show(rec, 'busy', S.sending(await where(rec)))
  await ensureSender()
  await chrome.runtime.sendMessage({ type: M.send, capture: rec, conn: await store.conn() }).catch(() => {})
}

/**
 * The capture's state to any open panel, and a note in its tab only for what Curio can't tell there: that Curio isn't running or connected, or what failed before Curio had it.
 * What Curio adds, finds already there or fails to download, it tells in a notification of its own; any other state takes the capture's note away.
 */
async function show(rec, tone, text, { sub = undefined, actions = [], keep = false, page = tone === 'warn' || tone === 'error' } = {}) {
  chrome.runtime.sendMessage({ type: M.captureState, capture: rec, text }).catch(() => {})
  if (rec.tabId == null || rec.tabId < 0) return
  if (!page) return void chrome.tabs.sendMessage(rec.tabId, { type: M.toastClose, id: rec.id }, { frameId: 0 }).catch(() => {})
  const theme = await pageTheme()
  chrome.tabs.sendMessage(rec.tabId, { type: M.toast, toast: { id: rec.id, tone, text, sub, actions, theme, keep } }, { frameId: 0 }).catch(() => {})
}

/**
 * A launch the person asked for from a tab: the grant its launch frame checks, and the sender told to watch for Curio.
 * Captures the worker counts as waiting but the sender no longer holds (it was gone with an extension reload) fail here, so none waits forever.
 */
async function launch(tabId) {
  await chrome.storage.session.set({ launch: { tabId, at: Date.now() } })
  await ensureSender()
  const conn = await store.conn()
  // the queue first, so what it kept through a reload counts as held
  await chrome.runtime.sendMessage({ type: M.resume, conn }).catch(() => {})
  const held = await chrome.runtime.sendMessage({ type: M.held }).catch(() => [])
  for (const rec of await store.allCaptures()) {
    if (rec.state !== 'waiting') continue
    if (Array.isArray(held) && held.includes(rec.id)) await show(rec, 'busy', S.starting, { page: true })
    else {
      const lost = cap.advance(rec, 'failed', { message: S.lost })
      await store.putCapture(lost)
      await show(lost, 'error', S.lost, { actions: [{ id: 'choose', label: S.choose }] })
    }
  }
  await chrome.runtime.sendMessage({ type: M.launch, conn }).catch(() => {})
}

const OPEN = 'curio://open?background=1'

/** The launch frame's question: the link, granted to its own tab in the last five seconds and used once, or false. */
async function launchCheck(sender) {
  const { launch: g } = await chrome.storage.session.get('launch')
  if (!g || g.tabId !== (sender.tab?.id ?? null) || Date.now() - g.at > 5000) return false
  await chrome.storage.session.remove('launch')
  return OPEN
}

async function onLaunchTimeout(msg) {
  for (const id of Array.isArray(msg.ids) ? msg.ids : []) {
    const rec = await store.getCapture(String(id))
    if (rec?.state === 'waiting') await show(rec, 'warn', S.noAnswer, { sub: S.offMore, actions: [{ id: 'launch', label: S.tryAgain }], keep: true })
  }
}

const dropRule = (rec) => rec.ruleId && chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rec.ruleId] }).catch(() => {})

async function onProgress(msg) {
  let rec = await store.getCapture(msg.id)
  if (!rec || cap.FINAL.has(rec.state)) return
  if (msg.state === 'waiting' && rec.state !== 'waiting') {
    // the bytes are fetched, so the Referer rule has done its work
    dropRule(rec)
    rec = cap.advance(rec, 'waiting', { ruleId: undefined })
    await store.putCapture(rec)
    await show(rec, 'warn', msg.why === 'unknown' ? S.retrying : S.off, { actions: [{ id: 'launch', label: S.openCurio }], keep: true })
  }
  if (msg.state === 'sending' && (rec.state === 'fetching' || rec.state === 'waiting')) {
    const resumed = rec.state === 'waiting'
    rec = cap.advance(rec, 'sending')
    await store.putCapture(rec)
    if (resumed) await show(rec, 'busy', S.sending(await where(rec)))
  }
  if (typeof msg.percent === 'number') await show(rec, 'busy', S.uploading(await where(rec), msg.percent))
  if (msg.opening) {
    const libs = (await store.libraries())?.list || []
    const lib = libs.find((l) => dst.libraryKey(l) === rec.dest.library)
    await show(rec, 'busy', S.opening(lib ? lib.name : rec.dest.library))
  }
}

async function onDone(msg) {
  let rec = await store.getCapture(msg.id)
  if (!rec || cap.FINAL.has(rec.state)) return
  dropRule(rec)
  if (msg.state !== 'failed' && (rec.state === 'fetching' || rec.state === 'waiting')) rec = cap.advance(rec, 'sending')
  rec = cap.advance(rec, msg.state, { ids: msg.ids, message: msg.message, handed: msg.handed, dropped: msg.dropped, ruleId: undefined, ...(msg.folders ? { dest: { ...rec.dest, folders: msg.folders, folderPaths: undefined } } : {}) })
  await store.putCapture(rec)
  const place = await where(rec)
  if (rec.state === 'added') await show(rec, 'ok', S.added(place))
  else if (rec.state === 'queued') await show(rec, 'ok', S.sent(place))
  else if (rec.state === 'handed') await show(rec, 'ok', S.handed(rec.handed?.[0]?.plugin || 'a plugin'))
  else if (rec.state === 'unknown') await show(rec, 'warn', S.unknown)
  else {
    const actions = []
    if (rec.mode === 'file' && /^https?:/i.test(rec.draft.candidates[0] || rec.draft.src)) actions.push({ id: 'link', label: S.saveAsLink })
    actions.push({ id: 'choose', label: S.choose })
    await show(rec, 'error', S.failed(rec.message), { sub: msg.conn === 'off' ? S.offMore : undefined, actions })
    if (msg.needsPanel) await openPanel(rec.id, await windowOf(rec.tabId), rec.tabId)
  }
}

async function toastAction(msg, sender) {
  let rec = await store.getCapture(String(msg.captureId))
  if (!rec || rec.tabId !== sender.tab?.id) return
  if (msg.action === 'launch' && rec.state === 'waiting') {
    await launch(rec.tabId)
  } else if (msg.action === 'link' && rec.state === 'failed') {
    const url = rec.draft.candidates.find((c) => /^https?:/i.test(c)) || rec.draft.src
    rec = cap.again(rec, { mode: 'link', draft: { ...rec.draft, src: url } })
    await store.putCapture(rec)
    await dispatch(rec)
  } else if (msg.action === 'choose') {
    await openPanel(rec.id, sender.tab?.windowId ?? null, sender.tab?.id ?? null)
  }
}

/** A capture the panel made from a drop or a paste. */
async function newFromPanel(msg) {
  const draft = complete(C.checkDraft(msg.draft, msg.draft?.pageUrl || ''), null)
  const rec = cap.make({ draft, dest: null, trigger: 'panel', tabId: null })
  await store.putCapture(rec)
  return { id: rec.id }
}

/** The panel's Send: its destination and edits, then on as a quick save goes. */
async function sendFromPanel(msg) {
  let rec = await store.getCapture(String(msg.id))
  if (!rec) throw new Error('That capture is gone')
  const e = msg.edits || {}
  // a field the panel cleared stays cleared, rather than taking the page's value again
  const fields = { ...(rec.draft.fields || {}) }
  for (const [k, v] of Object.entries(e.fields && typeof e.fields === 'object' ? e.fields : {})) v == null ? delete fields[k] : (fields[k] = v)
  const rating = Number.isInteger(e.rating) && e.rating >= 0 && e.rating <= 5 ? e.rating : rec.draft.rating
  const favorite = typeof e.favorite === 'boolean' ? e.favorite : rec.draft.favorite
  const explicit = typeof e.explicit === 'boolean' ? e.explicit : rec.draft.explicit
  const draft = { ...rec.draft, title: C.text(e.title ?? rec.draft.title, C.LIMITS.title), notes: C.text(e.notes ?? rec.draft.notes, C.LIMITS.notes, true), tags: C.tags(JSON.stringify(e.tags ?? rec.draft.tags)), rating, favorite, explicit, fields: C.fields(JSON.stringify(fields)) }
  const dest = { library: String(msg.dest.library), folders: (msg.dest.folders || []).filter((f) => Number.isInteger(f)), tags: C.tags(JSON.stringify(msg.dest.tags || [])) }
  const mode = e.mode === 'link' || e.mode === 'file' ? e.mode : rec.mode
  // one already saved is saved again as a capture of its own
  // as asked for again: a file the library holds already is added anyway
  const base = rec.state === 'new' || rec.state === 'failed' ? rec : { ...cap.make({ draft: rec.draft, dest: null, trigger: 'panel', tabId: rec.tabId, frameId: rec.frameId }), replaces: rec.id, force: true }
  rec = { ...cap.again(base, { draft, dest, mode }), from: 'panel', asked: null }
  await store.putCapture(rec)
  await dispatch(rec)
  return { ok: true, id: rec.id }
}

/**
 * The `Cookie` header the browser would send opening a download's address, for the sender to put in its call, never kept.
 * None while the setting is off, and none for an address a page's attribute named on another site.
 */
async function cookiesFor(msg) {
  const rec = await store.getCapture(String(msg.id))
  if (!rec || rec.mode === 'link' || !(await store.settings()).cookies) return {}
  const d = rec.draft
  const url = rec.urls?.[0] || d.src
  if (!/^https?:/i.test(url) || (d.srcFromAttr && !C.sameSite(url, d.pageUrl))) return {}
  const own = await chrome.cookies.getAll({ url }).catch(() => [])
  // those the address's site keeps for the page's site only (partitioned), which the page's own request sends too
  const page = /^https?:/i.test(d.pageUrl || '') ? new URL(d.pageUrl) : null
  const parted = page ? await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: `${page.protocol}//${C.siteOf(page.hostname)}` } }).catch(() => []) : []
  const seen = new Set()
  const parts = []
  for (const c of [...parted, ...own]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    parts.push(`${c.name}=${c.value}`)
  }
  const header = parts.join('; ')
  return header && header.length <= 16 * 1024 ? { cookies: header } : {}
}

async function relayBytes(msg) {
  const rec = await store.getCapture(String(msg.captureId))
  if (!rec || rec.tabId == null) return
  chrome.tabs.sendMessage(rec.tabId, { type: M.bytesRequest, captureId: rec.id, inPageId: rec.draft.inPageId }, { frameId: rec.frameId }).catch(() => {})
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return false
  if (!fromExtension(sender, BASE)) {
    // a content script: its page's word, and nothing that names a token, a port or an address to call
    if (!sender.tab) return false
    if (msg.type === M.hello) {
      store.settings().then((s) => {
        const ps = pageSettings(s, sender.tab?.url || sender.url || '')
        reply(ps)
        // the frames too: Alt goes to the focused document, so a frame clicked with it would otherwise not know yet
        if (msg.top && sender.tab?.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'settings', settings: ps }).catch(() => {})
      })
      return true
    }
    if (msg.type === M.pageCommand && PAGE_COMMANDS.includes(String(msg.name))) {
      triggerCommand(String(msg.name), sender.tab)
      return false
    }
    if (msg.type === M.zoneRows) {
      zoneRows(sender.tab.id).then(reply, () => reply([]))
      return true
    }
    if (msg.type === M.dragStart) {
      const tabId = sender.tab.id
      const windowId = sender.tab.windowId
      store.settings().then(async (s) => {
        const ps = pageSettings(s, sender.tab?.url || '')
        if (!ps.on || !ps.drag) return false
        // an open side panel takes the drop itself, so nothing comes over the page
        if (chrome.sidePanel && (await sideIn(windowId))) {
          sideDrags.set(windowId, { tabId, at: Date.now() })
          return 'none'
        }
        return inPage(tabId, null, 'drop')
      }).then(reply, () => reply(false))
      return true
    }
    if (msg.type === M.dragEnd) chrome.tabs.sendMessage(sender.tab.id, { type: M.frameClose, onlyDrop: true }, { frameId: 0 }).catch(() => {})
    if (msg.type === M.pageSave) pageSave(msg, sender).catch((e) => console.error(e))
    if (msg.type === M.cropDone) cropDone(msg, sender).catch((e) => console.error(e))
    if (msg.type === M.toastAction) toastAction(msg, sender)
    return false
  }
  const answer = (p) => {
    p.then(reply, (e) => reply({ error: String(e && e.message ? e.message : e) }))
    return true
  }
  switch (msg.type) {
    case M.progress:
      onProgress(msg)
      return false
    case M.done:
      onDone(msg)
      return false
    case M.bytesRequest:
      relayBytes(msg)
      return false
    case M.cookies:
      if (!sender.url?.startsWith(BASE + 'sender/')) return false
      return answer(cookiesFor(msg))
    case M.launchTimeout:
      onLaunchTimeout(msg)
      return false
    case M.senderIdle:
      if (sender.url?.startsWith(BASE + 'sender/')) senderIdle(Number(msg.since) || 0, Number(msg.shot) || 0)
      return false
    case M.launchCheck:
      return answer(launchCheck(sender))
    case M.launchAsk:
      // the panel's Open Curio, which frames the launch page in itself
      // the side panel has no tab: its grant is for a frame without one, which no web page's frame is
      return answer(launch(sender.tab?.id ?? null).then(() => true))
    case M.queueRemove:
      return answer(removeQueued(Array.isArray(msg.ids) ? msg.ids.map(String) : []).then(() => true))
    case M.captureGet:
      return answer(store.getCapture(String(msg.id)))
    case M.frameGrant:
      return answer(frameGrant(msg, sender))
    case M.popupRun:
      if (sender.url !== chrome.runtime.getURL('popup/popup.html')) return false
      popupRun(msg).catch((e) => console.error(e))
      return false
    case M.sideDrop:
      if (!sender.url?.startsWith(SIDE_URL)) return false
      return answer(sideDrop(msg))
    case M.sideState:
      if (!sender.url?.startsWith(SIDE_URL)) return false
      setSideState(sender.documentId || String(msg.sideId || ''), msg.windowId, !!msg.visible, !!msg.gone).catch(() => {})
      return false
    case M.frameDrop:
      if (!sender.url?.startsWith(PANEL_URL + '?frame=1') || sender.tab?.id == null) return false
      return answer(frameDrop(msg, sender.tab.id))
    case M.captureNew:
      return answer(newFromPanel(msg))
    case M.captureSend:
      return answer(sendFromPanel(msg))
    case M.menuClick:
      // the same path as a menu click, for tools/ext.mjs and the panel
      return answer(chrome.tabs.get(msg.tabId).then((tab) => trigger({ ask: !!msg.ask, info: msg.info || {}, tab, trigger: msg.trigger || 'menu' })).then(() => ({ ok: true })))
    case M.commandRun:
      return answer(chrome.tabs.get(msg.tabId).then((tab) => command(String(msg.name), tab)).then(() => ({ ok: true })))
  }
  return false
})
