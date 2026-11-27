// @ts-check
// The panel: what to save (a capture from the page, or a drop, a paste or a file) on the left, the library, its folders and tags on the right, Send always in view.
import * as store from '../lib/store.js'
import * as connection from '../lib/connection.js'
import * as dst from '../lib/destinations.js'
import { M } from '../lib/messages.js'
import { S } from '../lib/strings.js'
import { MAX_BYTES, MAX_UPLOAD, FINAL, outcome } from '../lib/captures.js'
import { newCode, pair, ping } from '../lib/pairing.js'
import { cleanTitle, extOfUrl } from '../lib/naming.js'
import * as Folders from './folders.js'
import * as Tags from './tags.js'
import * as Libs from './libraries.js'
import * as Choices from './choices.js'
import { icon, loadAll } from './icons.js'

const $ = (id) => /** @type {any} */ (document.getElementById(id))
const params = new URLSearchParams(location.search)
/** In the side panel, the page stays open and takes one capture after another. */
const side = params.get('side') === '1'
/** In a page: the content script's dialog holds this page edge to edge, and it draws its window in the middle. */
const framed = params.get('frame') === '1'
/** The window this page is in, and whether it is the panel's own popup, which closes after a save. */
/** @type {number | null} */ let myWindow = null
let ownWindow = false
/** Inside size of the panel's own window. */
const SIZE = { width: 560, height: 540 }

/** @type {any} */ let curio = null
/** @type {{ ops: Set<string>, params: Record<string, string[]> } | null} */ let caps = null
/** @type {any[]} */ let libs = []
/** @type {string | null} */ let library = null
let lists = { folders: /** @type {any[]} */ ([]), tags: /** @type {any[]} */ ([]), tagGroups: /** @type {any[]} */ ([]), fields: /** @type {any[]} */ ([]) }
let rating = 0
let favorite = false
let explicit = false
/** The choice fields' values, by key. @type {Record<string, any>} */ let values = {}
/** @type {any[]} */ let recentFromCurio = []
/** Recently used folders of this library, newest first. @type {number[]} */ let recentFolders = []
/** @type {string[]} */ let recentTags = []
/** @type {number[]} */ let chosen = []
/** @type {string[]} */ let tags = []
/** @type {{ capture?: any, file?: File, url?: string } | null} */ let what = null
/** @type {string | null} */ let sending = null
let generation = 0
/** @type {any} */ let subscription = null
/** @type {any} */ let asked = null
let keepTags = false
/** @type {any} */ let closing = 0
/** The side panel shows the drop area over the folders between saves. */
const drops = side
const sideId = side ? crypto.randomUUID() : ''
/** The host tab's page zoom factor, counteracted on `#card` so the floating card keeps a fixed physical size. */
let pageZoom = 1
/** Last pointer placement of the floating card, re-applied if page zoom changes while open. @type {{ x: number, y: number } | null} */
let placedAt = null
/** The library the folders between saves are of. @type {string | null} */ let dropLib = null
/** The drag card's own client, for the folders as Curio has them, while the form isn't connected. @type {any} */ let dropClient = null

// the folder picker: recently used folders over the tree
const tab = 'all'
/** @type {Set<number>} */ const collapsed = new Set()
let folderActive = -1
let folderKeyNav = false
/** @type {any[]} */ let folderList = []

// the tag picker
/** @type {number | 'none' | null} */ let tagGroup = null
let tagActive = -1
/** @type {Set<string>} */ const folded = new Set()

function status(text, tone = '') {
  const el = $('status')
  el.textContent = text
  el.className = 'note where' + (tone ? ' ' + tone : '')
  el.title = text
  const d = $('dropStatus')
  d.textContent = text
  d.className = 'note dropStatus' + (tone ? ' ' + tone : '')
  d.hidden = !text
}

/** The largest file this Curio takes: through its upload where it has one. */
const fileLimit = () => ((caps?.params?.['item.add.fromBytes'] || []).includes('upload') ? MAX_UPLOAD : MAX_BYTES)

/** Applies Light, Dark, System, or Curio's own theme. */
function applyTheme(mode, t = null) {
  store.applyTheme(document.documentElement, mode, t)
}

// ---- connection ----

function showSetup(text) {
  $('setupText').textContent = text
  $('setup').hidden = false
  $('form').hidden = true
  $('dropCard').hidden = true
  document.documentElement.dataset.view = 'connect'
}

/** Curio isn't running: Open Curio, with the connection still editable below in case the port is wrong. */
function showOff(text = S.off) {
  $('offText').textContent = text
  $('off').hidden = false
  showSetup(S.offMore)
  watchOff()
}

/** Curio started some other way (by hand, at sign-in) brings the form as Open Curio does. */
let offWatch = 0
function watchOff() {
  clearInterval(offWatch)
  offWatch = setInterval(async () => {
    if ($('off').hidden) return clearInterval(offWatch)
    if ($('openCurio').disabled) return
    const c = await store.conn()
    if (!c.token || (await connection.state(c, 1500)).state !== 'up') return
    clearInterval(offWatch)
    $('off').hidden = true
    open(c)
  }, 3000)
}

const typedConn = () => ({ token: $('token').value.trim(), port: Number($('port').value) || 41733 })

/** Asks the browser to start Curio through a hidden launch frame, then watches for it for 30 s. */
async function launchCurio() {
  $('openCurio').disabled = $('launchInline').disabled = true
  $('offText').textContent = S.starting
  try {
    if ((await chrome.runtime.sendMessage({ type: M.launchAsk })) !== true) throw new Error()
    const f = document.createElement('iframe')
    f.src = chrome.runtime.getURL('launch/launch.html')
    f.hidden = true
    document.body.append(f)
    setTimeout(() => f.remove(), 15000)
    const typed = !$('off').hidden
    const c = typed ? typedConn() : await store.conn()
    const until = Date.now() + 30000
    while (Date.now() < until) {
      // without a token only the ping tells whether Curio is up
      const st = c.token ? await connection.state(c, 1500) : { state: (await ping(c.port)) ? 'no-token' : 'off', message: '' }
      if (st.state !== 'off') {
        $('off').hidden = true
        $('launchInline').hidden = true
        if (!$('form').hidden) return status('')
        if (st.state !== 'up') return showSetup(st.state === 'refused' ? st.message || S.refused : S.connectFirst)
        if (typed) await store.setConn(c)
        return open(c)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    $('offText').textContent = S.noAnswer
    $('openCurio').textContent = S.tryAgain
    if (!$('form').hidden) status(S.noAnswer, 'error')
  } catch {
    $('offText').textContent = S.noAnswer
  } finally {
    $('openCurio').disabled = $('launchInline').disabled = false
  }
}

/** Connect: Curio's window asks the person to allow this extension, with the code shown here too. */
async function pairFromSetup() {
  const port = Number($('port').value) || 41733
  const code = newCode()
  $('pair').disabled = true
  $('pairCode').textContent = code
  $('pairCode').hidden = false
  $('setupStatus').textContent = S.pairing
  $('setupStatus').className = 'note'
  try {
    const r = await pair(port, code)
    if ('token' in r) {
      const c = { token: r.token, port }
      await store.setConn(c)
      $('token').value = r.token
      $('setupStatus').textContent = ''
      $('off').hidden = true
      return await open(c)
    }
    if (r.error === 'off') return showOff()
    $('setupStatus').textContent = r.message
    $('setupStatus').className = 'note error'
  } finally {
    $('pair').disabled = false
    $('pairCode').hidden = true
  }
}

async function connectFromSetup() {
  const c = typedConn()
  $('setupStatus').textContent = S.connecting
  const st = await connection.state(c)
  if (st.state !== 'up') {
    $('setupStatus').textContent = st.state === 'refused' ? st.message || S.refused : S.offMore
    $('setupStatus').className = 'note error'
    return
  }
  await store.setConn(c)
  $('setupStatus').textContent = ''
  $('off').hidden = true
  await open(c)
}

async function open(c) {
  quiet()
  curio = connection.client(c)
  $('setup').hidden = true
  if (drops && !what) $('dropCard').hidden = false
  else $('form').hidden = false
  document.documentElement.dataset.view = $('dropCard').hidden ? 'form' : 'drops'
  connection.capabilities(curio).then((x) => {
    caps = x
    drawFolders()
    updateSend()
  }, () => {})
  curio.app.theme().then(async (t) => {
    store.setTheme(t)
    const mode = store.themeModeOf(await store.settings())
    if (mode === 'curio') applyTheme(mode, t)
  }, () => {})
  await loadLibraries(what?.capture?.dest?.library || asked?.library || null)
  if (!$('dropCard').hidden) showDrops()
  listen()
}

// ---- libraries, folders, tags ----

async function loadLibraries(wanted) {
  const cached = await store.libraries()
  if (cached && !libs.length) libs = cached.list
  try {
    libs = await curio.library.list()
    await store.setLibraries(libs)
  } catch (e) {
    if (e.code === 'unauthorized' || e.code === 'not_allowed') return showSetup(e.message)
    status(e.message, 'error')
  }
  const d = await store.dest()
  library = Libs.firstChoice(libs, wanted || library, d.last?.library || null)
  Libs.render($('library'), libs, library)
  const explicitDest = what?.capture?.dest && what.capture.dest.library === library && what.capture.from !== 'last' ? { folders: what.capture.dest.folders, tags: what.capture.dest.tags } : null
  await libraryChanged(explicitDest)
}

const current = () => libs.find((l) => dst.libraryKey(l) === library) || null

/**
 * @param {{ folders?: number[], tags?: string[], paths?: string[] } | null} initial
 * @param {boolean} quiet a refresh after an event, which leaves the status line to what the person did
 */
async function libraryChanged(initial = null, quiet = false) {
  const say = (text, tone = '') => !quiet && status(text, tone)
  const gen = ++generation
  folderActive = -1
  folderKeyNav = false
  library = $('library').value || library
  const lib = current()
  $('libSwatch').style.background = lib?.color || ''
  const [d, s] = await Promise.all([store.dest(), store.settings()])
  const mem = library ? d.perLibrary[library] : null
  const host = dst.hostOf(what?.capture?.draft?.pageUrl || what?.url || '')
  chosen = [...(initial?.folders ?? dst.rememberedFolders(d, library, { mode: s.rememberFolder || 'never', host }))]
  const captureTags = what?.capture?.draft?.tags || []
  const ruleTags = what?.capture?.ruleTags || []
  if (initial?.tags != null) tags = Tags.add(captureTags, initial.tags.join(','))
  else if (keepTags) tags = Tags.add(tags.length ? tags : mem?.tags || [], [...captureTags, ...ruleTags].join(','))
  else tags = Tags.add(captureTags, ruleTags.join(','))
  recentTags = d.recentTags || []
  const cached = library ? await store.lists(library) : null
  if (cached) lists = { folders: cached.folders || [], tags: cached.tags || [], tagGroups: cached.tagGroups || [], fields: cached.fields || [] }
  else lists = { folders: [], tags: [], tagGroups: [], fields: [] }
  if (lists.folders.some((f) => f.icon)) await loadAll()
  await recent()
  draw()
  if (!lib) {
    updateSend()
    return
  }
  say(lib.state === 'closed' ? S.opening(lib.name) : '')
  try {
    const [folders, tagList, tagGroups, fromCurio, fields] = await connection.whileBusy(() => Promise.all([curio.folder.list({ library }), curio.tag.list({ library }), curio.tagGroup.list({ library }), curio.folder.recent({ library }).catch(() => []), curio.field.list({ library }).catch(() => [])]), { onBusy: () => gen === generation && say(S.opening(lib.name)) })
    if (gen !== generation) return
    lists = { folders, tags: tagList, tagGroups, fields }
    recentFromCurio = fromCurio
    await store.setLists(library, lists)
    if (initial?.paths?.length) {
      const { ids, missing } = dst.resolvePaths(initial.paths, folders)
      chosen = [...new Set([...ids, ...chosen])]
      if (missing.length) say(S.folderMissing(missing[0]), 'error')
      else say('')
    } else say('')
    chosen = chosen.filter((id) => folders.some((f) => f.id === id))
    if (folders.some((f) => f.icon)) await loadAll()
    await recent()
    draw()
  } catch (e) {
    if (gen === generation) say(e.message, 'error')
  }
  updateSend()
}

/** The folders used last here and in Curio's window, newest first. */
async function recent() {
  const d = await store.dest()
  recentFolders = [...new Set([...d.recents.filter((r) => r.library === library).flatMap((r) => r.folders), ...recentFromCurio.map((f) => f.id)])].filter((id) => lists.folders.some((f) => f.id === id)).slice(0, 12)
}

function draw() {
  drawFolders()
  drawTags()
  drawChoices()
}

function drawChoices() {
  Choices.renderRating($('rating'), rating, (n) => {
    rating = n
    drawChoices()
  })
  Choices.renderFlags($('flags'), { favorite, explicit }, (key, on) => {
    if (key === 'favorite') favorite = on
    else explicit = on
    drawChoices()
  })
  // a plugin's fields are its own to fill
  Choices.renderFields($('choices'), Choices.split(lists.fields).own, values, (key, v) => {
    values = { ...values, [key]: v }
    drawChoices()
  })
}

const choices = () => Choices.split(lists.fields).own
const canCreate = () => !!caps?.ops.has('folder.create')

function drawFolders(reveal = false, resetActive = false) {
  folderList = Folders.view({ folders: lists.folders, chosen, recent: recentFolders, filter: $('folderFilter').value, tab, collapsed, canCreate: canCreate(), all: true })
  const rows = folderList.filter((r) => !r.sep)
  if (resetActive) {
    const has = !!$('folderFilter').value.trim()
    folderKeyNav = has
    // focus the first matching folder below Create; fall back to Create when nothing matches
    folderActive = has ? (rows[0]?.create && rows.length > 1 ? 1 : 0) : -1
  } else if (folderActive >= rows.length) folderActive = rows.length - 1
  Folders.render($('folders'), {
    list: folderList,
    chosen,
    active: folderActive,
    reveal,
    collapsed,
    empty: $('folderFilter').value.trim() ? S.noMatch : S.noFolders,
    onPoint: (i) => {
      folderKeyNav = false
      if (folderActive === i) return
      folderActive = i
      for (const r of $('folders').querySelectorAll('.p-row')) r.classList.toggle('act', r.dataset.i === String(i))
    },
    onToggle: toggleFolder,
    onAll: noFolder,
    onCreate: newFolder,
    onCollapse: (id) => {
      if (collapsed.has(id)) collapsed.delete(id)
      else collapsed.add(id)
      drawFolders()
    },
  })
  const auto = [...new Set(chosen.flatMap((id) => lists.folders.find((f) => f.id === id)?.autoTags || []))]
  $('autoTags').hidden = !auto.length
  $('autoTags').textContent = auto.length ? `+ ${auto.join(', ')}` : ''
  markPreset()
}

function toggleFolder(id) {
  chosen = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]
  drawFolders()
}

// ---- presets: a library with folders and tags, saved under a name and chosen again in the footer ----

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

/** The preset that is what the form holds now, if any. */
async function presetNow() {
  const saved = (await store.dest()).saved || []
  // the capture's own tags may come on top of a preset's
  const have = tags.map((t) => t.toLowerCase())
  return saved.find((x) => x.library === library && sameSet(x.folders, chosen) && x.tags.every((t) => have.includes(t.toLowerCase()))) || null
}

async function drawPresets() {
  const saved = (await store.dest()).saved || []
  const sel = $('preset')
  sel.replaceChildren(new Option('Preset', ''), ...saved.map((x) => new Option(x.name, x.id)))
  sel.disabled = !saved.length
  await markPreset()
}

/** The footer names the preset the form matches, and offers to delete that one. */
async function markPreset() {
  const now = await presetNow()
  $('preset').value = now ? now.id : ''
  $('presetDelete').hidden = !now
}

async function usePreset(id) {
  const x = ((await store.dest()).saved || []).find((y) => y.id === id)
  if (!x) return markPreset()
  if (!libs.some((l) => dst.libraryKey(l) === x.library)) {
    status(S.missingLibrary, 'error')
    return markPreset()
  }
  library = x.library
  $('library').value = library
  // a preset's tags are the tags, whatever was kept before
  tags = []
  await libraryChanged({ folders: x.folders, tags: x.tags })
}

function namePreset(on) {
  $('preset').hidden = on
  $('presetName').hidden = !on
  if (on) {
    $('presetName').value = ''
    $('presetName').focus()
  }
}

async function savePreset() {
  const name = $('presetName').value.trim()
  namePreset(false)
  if (!name || !library) return
  const saved = ((await store.dest()).saved || []).filter((x) => x.name.toLowerCase() !== name.toLowerCase())
  await store.setDest({ saved: [...saved, { id: crypto.randomUUID().slice(0, 8), name, library, folders: [...chosen], tags: [...tags] }].slice(-30) })
  await drawPresets()
}

async function deletePreset() {
  const now = await presetNow()
  if (!now) return
  await store.setDest({ saved: ((await store.dest()).saved || []).filter((x) => x.id !== now.id) })
  await drawPresets()
}

/** All: the library itself, in no folder. */
function noFolder() {
  chosen = []
  drawFolders()
}

function folderKey(e) {
  const rows = folderList.filter((r) => !r.sep)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!rows.length) return
    folderKeyNav = true
    folderActive = folderActive < 0 ? 0 : (folderActive + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    drawFolders(true)
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    if (!e.target.value.trim() && !(folderKeyNav && folderActive >= 0)) return
    e.preventDefault()
    const r = rows[folderActive < 0 ? 0 : folderActive]
    if (!r) return
    if (r.create) newFolder(r.create)
    else if (r.all) noFolder()
    else toggleFolder(r.f.id)
  } else if (e.key === 'Escape' && e.target.value) {
    e.preventDefault()
    e.stopPropagation()
    e.target.value = ''
    folderActive = -1
    folderKeyNav = false
    drawFolders()
  }
}

/** A new folder at the top of the library, chosen as soon as it exists. */
async function newFolder(name) {
  if (!name || !library) return
  try {
    const r = await curio.folder.create({ library, name })
    $('folderFilter').value = ''
    lists.folders = await curio.folder.list({ library })
    await store.setLists(library, lists)
    chosen = [...chosen, r.id]
    drawFolders()
  } catch (e) {
    status(e.message, 'error')
  }
}

function tagColors() {
  return Tags.colors(lists.tags, lists.tagGroups)
}

function drawTags() {
  Tags.render($('tags'), $('tagInput'), tags, tagColors(), (i) => {
    tags = tags.filter((_, j) => j !== i)
    drawTags()
  })
  $('keepTags').replaceChildren(icon(keepTags ? 'pinned-filled' : 'pin', 15))
  $('keepTags').classList.toggle('on', keepTags)
  $('keepTags').setAttribute('aria-pressed', String(keepTags))
  if (!$('tagPicker').hidden) drawTagPicker()
  markPreset()
}

/** The words a new tag might be: the name, then the page's title. */
const recommendFrom = () => [$('name').value, what?.capture?.draft?.pageTitle || ''].join(' ')

function drawTagPicker(reveal = false, resetActive = false) {
  const q = $('tagInput').value
  const term = q.trim()
  const sections = Tags.sections({ tags: lists.tags, groups: lists.tagGroups, group: tagGroup, q, recent: recentTags, recommended: Tags.recommended(recommendFrom(), lists.tags, tags) })
  const create = term && !lists.tags.some((t) => t.name.toLowerCase() === term.toLowerCase()) && !tags.some((t) => t.toLowerCase() === term.toLowerCase()) ? term : ''
  const firstHit = sections.some((s) => s.rows.length > 0)
  // focus the first matching tag below Add; fall back to Add when nothing matches
  if (resetActive) tagActive = term ? (create && firstHit ? 1 : 0) : -1
  Tags.renderPicker({
    side: $('tagGroups'),
    list: $('tagRows'),
    groups: Tags.groupRows(lists.tags, lists.tagGroups),
    group: tagGroup,
    sections,
    chosen: tags,
    active: tagActive,
    reveal,
    create,
    folded,
    onGroup: (id) => {
      tagGroup = id
      drawTagPicker(false, true)
    },
    onPick: pickTag,
    onFold: (id) => {
      if (folded.has(id)) folded.delete(id)
      else folded.add(id)
      drawTagPicker()
    },
    onPoint: (i) => {
      if (tagActive === i) return
      tagActive = i
      for (const r of $('tagRows').querySelectorAll('.p-row')) r.classList.toggle('act', r.dataset.i === String(i))
    },
  })
}

function openTagPicker() {
  const pop = $('tagPicker')
  if (!pop.hidden) return
  // under the tag field, as a menu opens; over it only where under leaves too little room, as wide as the window allows
  const scale = framed ? pageZoom : 1
  const cols = pop.parentElement.getBoundingClientRect()
  const box = $('tags').getBoundingClientRect()
  const colsW = cols.width * scale
  const width = Math.min(400, colsW - 16)
  const below = (cols.bottom - box.bottom) * scale - 8
  const above = (box.top - cols.top) * scale - 8
  const under = below >= 150 || below >= above
  const height = Math.min(300, under ? below : above)
  pop.style.width = width + 'px'
  pop.style.height = height + 'px'
  pop.style.left = Math.min((box.left - cols.left) * scale, colsW - width - 8) + 'px'
  pop.style.top = (under ? (box.bottom - cols.top) * scale + 4 : (box.top - cols.top) * scale - height - 4) + 'px'
  tagGroup = null
  tagActive = -1
  pop.hidden = false
  drawTagPicker()
}
const closeTagPicker = () => ($('tagPicker').hidden = true)

/** A click or Enter on a tag: added, or taken away when it is there already. */
function pickTag(name) {
  const has = tags.some((t) => t.toLowerCase() === name.toLowerCase())
  tags = has ? tags.filter((t) => t.toLowerCase() !== name.toLowerCase()) : Tags.add(tags, name)
  $('tagInput').value = ''
  tagActive = -1
  drawTags()
  $('tagInput').focus()
}

function addTagFromInput() {
  const v = $('tagInput').value
  if (!v.trim()) return
  tags = Tags.add(tags, v)
  $('tagInput').value = ''
  tagActive = -1
  drawTags()
}

function tagKey(e) {
  const names = Tags.order($('tagRows'))
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    openTagPicker()
    if (!names.length) return
    tagActive = tagActive < 0 ? 0 : (tagActive + (e.key === 'ArrowDown' ? 1 : -1) + names.length) % names.length
    drawTagPicker(true)
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    // a half-typed tag is only committed by Enter or a comma
    if (!$('tagPicker').hidden && tagActive >= 0 && names[tagActive]) {
      e.preventDefault()
      pickTag(names[tagActive])
    } else if (e.target.value.trim()) {
      e.preventDefault()
      addTagFromInput()
    }
  } else if (e.key === ',') {
    if (!e.target.value.trim()) return
    e.preventDefault()
    addTagFromInput()
  } else if (e.key === 'Backspace' && !e.target.value && tags.length) {
    tags = tags.slice(0, -1)
    drawTags()
  } else if (e.key === 'Escape' && !$('tagPicker').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeTagPicker()
  }
}

// ---- what to save ----

/** A glyph for what has no picture to show. */
function glyph(kind) {
  const g = icon(kind === 'link' || kind === 'page' ? 'link' : kind === 'video' ? 'movie' : kind === 'audio' ? 'music' : kind === 'image' ? 'photo' : 'file', 36)
  g.classList.add('glyph')
  return g
}

/** The picture the page showed, cut from the tab when the panel opened, for an address that won't load here. */
async function fallback(rec, box) {
  for (let i = 0; i < 6 && what?.capture?.id === rec.id; i++) {
    const data = await chrome.runtime.sendMessage({ type: M.shotData, id: 'thumb:' + rec.id }).catch(() => null)
    if (typeof data === 'string') {
      const img = new Image()
      img.alt = ''
      img.src = data
      return box.replaceChildren(img)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function setCapture(rec) {
  showForm()
  folderActive = -1
  folderKeyNav = false
  what = { capture: rec }
  const d = rec.draft
  const preview = $('preview')
  preview.replaceChildren(glyph(d.kind))
  const meta = []
  const show = (el) => preview.replaceChildren(el)
  if (/^https?:/i.test(d.src) && d.kind === 'video') {
    const v = document.createElement('video')
    v.muted = true
    v.autoplay = true
    v.loop = true
    v.playsInline = true
    v.preload = 'auto'
    const ext = extOfUrl(d.src).toUpperCase() || 'VIDEO'
    meta.push(ext)
    v.onloadedmetadata = () => {
      show(v)
      const parts = []
      if (v.videoWidth) parts.push(`${v.videoWidth} × ${v.videoHeight}`)
      if (Number.isFinite(v.duration) && v.duration > 0) parts.push(formatDuration(v.duration))
      parts.push(ext)
      meta.splice(0, meta.length, ...parts)
      caption()
      v.play().catch(() => {})
    }
    v.onerror = () => fallback(rec, preview)
    v.src = d.src
  } else if (/^https?:/i.test(d.src) && (d.kind === 'image' || d.kind === 'file')) {
    const img = new Image()
    img.alt = ''
    img.onload = () => {
      show(img)
      if (d.kind !== 'image') return
      meta.unshift(`${img.naturalWidth} × ${img.naturalHeight}`)
      caption()
    }
    img.onerror = () => d.kind === 'image' && fallback(rec, preview)
    img.src = d.candidates[d.candidates.length - 1] || d.src
  } else if (d.shot) {
    chrome.runtime.sendMessage({ type: M.shotData, id: d.shot }).then((data) => {
      if (typeof data !== 'string' || what?.capture?.id !== rec.id) return
      const img = new Image()
      img.alt = ''
      img.onload = () => show(img)
      img.src = data
    }, () => {})
  } else if (/^(blob|data):/i.test(d.src) || d.inPage) fallback(rec, preview)
  const caption = () => {
    const what = $('what')
    const address = d.shot && d.kind !== 'page' ? `${S.menuShot} · ${d.pageTitle || d.pageUrl}` : d.kind === 'svg' || d.kind === 'canvas' ? `${d.kind === 'svg' ? 'SVG' : 'Canvas'} · ${d.pageTitle || d.pageUrl}` : d.src
    let host = ''
    try {
      host = /^https?:/i.test(d.src) ? new URL(d.src).host : ''
    } catch {}
    // the size once known, over the picture; the whole address on hover
    what.textContent = meta.length ? meta.join(' · ') : (d.shot && d.kind !== 'page') || d.kind === 'svg' || d.kind === 'canvas' ? address : host || address
    what.title = address
    what.dataset.address = address
    what.hidden = false
  }
  caption()
  $('drop').classList.add('has')
  $('name').value = d.title || ''
  $('notes').value = d.notes || ''
  rating = typeof d.rating === 'number' ? d.rating : 0
  favorite = !!d.favorite
  explicit = !!d.explicit
  values = { ...(d.fields || {}) }
  if (!keepTags) tags = Tags.add(d.tags || [], (rec.ruleTags || []).join(','))
  drawChoices()
  drawTags()
  // a page with its screenshot is saved as the link, or unchecked as the screenshot
  const address = (/^https?:/i.test(d.src) && d.kind !== 'page' && d.kind !== 'link') || (d.kind === 'page' && !!d.shot)
  $('asLinkRow').hidden = !address
  $('asLink').checked = rec.mode === 'link'
  asked = rec.asked && rec.asked.reachable && !rec.asked.followed ? rec.asked : null
  $('asked').hidden = !asked
  $('useAsked').hidden = false
  if (asked) $('askedText').textContent = S.pageAsked([asked.name, ...asked.folders.filter((f) => typeof f === 'string').map((f) => f.split('/').join(' / '))].join(' / '))
  else if (rec.asked && !rec.asked.reachable) {
    $('asked').hidden = false
    $('askedText').textContent = S.pageAskedMissing
    $('useAsked').hidden = true
  }
  if (rec.state === 'failed' && rec.message) status(rec.message, 'error')
  updateSend()
}

/** A file, with the address it was dragged from when a page gave one. */
function setFile(file, url = '') {
  showForm()
  folderActive = -1
  folderKeyNav = false
  what = { file, url: /^https?:/i.test(url) ? url : '' }
  const preview = $('preview')
  preview.replaceChildren(glyph(file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file'))
  const kb = `${Math.max(1, Math.round(file.size / 1024))} KB`
  const caption = (dims = '') => {
    $('what').textContent = dims || kb
    $('what').title = `${file.name} · ${kb}`
    $('what').dataset.address = file.name
    $('what').hidden = false
  }
  if (file.type.startsWith('image/')) {
    const img = new Image()
    img.alt = ''
    img.onload = () => {
      preview.replaceChildren(img)
      caption(`${img.naturalWidth} × ${img.naturalHeight}`)
    }
    img.src = URL.createObjectURL(file)
  } else if (file.type.startsWith('video/')) {
    const v = document.createElement('video')
    v.muted = true
    v.autoplay = true
    v.loop = true
    v.playsInline = true
    v.preload = 'auto'
    v.onloadedmetadata = () => {
      preview.replaceChildren(v)
      const parts = []
      if (v.videoWidth) parts.push(`${v.videoWidth} × ${v.videoHeight}`)
      if (Number.isFinite(v.duration) && v.duration > 0) parts.push(formatDuration(v.duration))
      caption(parts.join(' · ') || kb)
      v.play().catch(() => {})
    }
    v.src = URL.createObjectURL(file)
  }
  caption()
  $('drop').classList.add('has')
  $('asLinkRow').hidden = true
  $('name').value = file.name.replace(/\.[^.]+$/, '')
  $('notes').value = ''
  rating = 0
  favorite = false
  explicit = false
  values = {}
  asked = null
  $('asked').hidden = true
  if (!keepTags) tags = []
  drawChoices()
  drawTags()
  status(file.size > fileLimit() ? S.tooLarge(Math.round(file.size / 1e6)) : '', file.size > fileLimit() ? 'error' : '')
  updateSend()
}

// the browser fetches it; a page comes back as HTML, and Curio then decides from the address whether it is a file or a link
async function setAddress(url) {
  const draft = { kind: 'file', src: url, candidates: [url], inPage: false, pageUrl: '', link: '', title: '', notes: '', tags: [] }
  const r = await chrome.runtime.sendMessage({ type: M.captureNew, draft })
  if (r?.error) return status(r.error, 'error')
  const rec = await chrome.runtime.sendMessage({ type: M.captureGet, id: r.id })
  if (rec) setCapture(rec)
}

/** Reads a file or web address synchronously from a DataTransfer before any await clears it. */
function readTransfer(dt) {
  if (!dt) return { file: null, url: '' }
  const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#')) || ''
  const text = (dt.getData('text/plain') || '').trim()
  const url = uri || (/^https?:\/\/\S+$/i.test(text) ? text : '')
  const file = (dt.files && dt.files[0]) || null
  return { file, url }
}

/** What a drop or a paste carries: a file, else an address. */
function take(dt) {
  const { file, url } = readTransfer(dt)
  if (file) setFile(file, url)
  else if (url) setAddress(url)
  else status(S.nothing, 'error')
}

function updateSend() {
  const lib = current()
  $('send').disabled = !what || !lib || lib.state === 'offline' || !!sending || (!!what.file && what.file.size > fileLimit())
}

function reset() {
  what = null
  folderActive = -1
  folderKeyNav = false
  $('preview').replaceChildren()
  $('what').hidden = true
  $('drop').classList.remove('has')
  $('name').value = ''
  $('notes').value = ''
  rating = 0
  favorite = false
  explicit = false
  values = {}
  drawChoices()
  $('asLinkRow').hidden = true
  $('asked').hidden = true
  if (!keepTags) tags = []
  drawTags()
  updateSend()
}

/** After a save: the panel's own window closes once the person has seen it went; the side panel empties for the next. */
function done() {
  if (framed) {
    clearTimeout(closing)
    closing = setTimeout(leave, 700)
    return
  }
  if (side || !ownWindow) {
    reset()
    return showDrops()
  }
  clearTimeout(closing)
  closing = setTimeout(() => window.close(), 700)
}

/** Cancel and Escape: the window closes; the side panel lets go of what it shows. */
function cancel() {
  if (framed) return leave()
  if (!side && ownWindow) return window.close()
  sending = null
  reset()
  status('')
  showDrops()
}

function dataUrl(file) {
  return new Promise((ok, no) => {
    const r = new FileReader()
    r.onload = () => ok(r.result)
    r.onerror = () => no(r.error)
    r.readAsDataURL(file)
  })
}

async function send() {
  const lib = current()
  if (!what || !lib || $('send').disabled) return
  addTagFromInput()
  closeTagPicker()
  const dest = { library: /** @type {string} */ (library), folders: [...chosen], tags: [...tags] }
  const name = $('name').value.trim()
  const notes = $('notes').value.trim()
  $('send').disabled = true
  status(S.sending(dst.label(dest, libs, lists.folders)))
  if (what.file) {
    const file = what.file
    const source = what.url
    try {
      const ext = (file.name.match(/\.[^.]+$/) || [''])[0]
      const fileName = name && name !== file.name.replace(/\.[^.]+$/, '') ? cleanTitle(name) + ext : file.name
      const where = dst.label(dest, libs, lists.folders)
      const bytes = file.size <= MAX_BYTES ? { data: await dataUrl(file) } : { upload: await connection.upload(await store.conn(), file, fileName, (part) => status(S.uploading(where, Math.floor(part * 100)))) }
      const fields = Choices.filled(choices(), values)
      const answer = await connection.whileBusy(() => curio.item.add.fromBytes({ library, folders: dest.folders, tags: dest.tags, ...(notes ? { annotation: notes } : {}), ...(source ? { sourceUrl: source } : {}), ...(rating ? { rating } : {}), ...(favorite ? { favorite: true } : {}), ...(explicit ? { explicit: true } : {}), ...(Object.keys(fields).length ? { fields } : {}), ...bytes, name: fileName }), { onBusy: () => status(S.opening(lib.name)) })
      const o = outcome(answer)
      await store.setDest(dst.remember(await store.dest(), dest, dst.hostOf(source)))
      if (o.state === 'failed') throw new Error(o.message)
      status(o.state === 'queued' ? S.queued(lib.name) : S.added(dst.label(dest, libs, lists.folders)), 'ok')
      done()
    } catch (e) {
      status(e.code === 'network' ? S.off : e.message, 'error')
      $('launchInline').hidden = e.code !== 'network'
      updateSend()
    }
    return
  }
  sending = what.capture.id
  const r = await chrome.runtime.sendMessage({ type: M.captureSend, id: sending, dest, edits: { title: name, notes, tags: [], rating, favorite, explicit, fields: Choices.patch(choices(), what.capture.draft.fields, values), mode: $('asLinkRow').hidden ? what.capture.mode : $('asLink').checked ? 'link' : 'file' } })
  if (r?.error) {
    sending = null
    status(r.error, 'error')
    updateSend()
  } else if (r?.id && sending) sending = r.id
}

function onCaptureState(msg) {
  const rec = msg.capture
  if (!rec || (rec.id !== sending && rec.replaces !== sending)) return
  const tone = rec.state === 'failed' ? 'error' : rec.state === 'unknown' ? 'error' : FINAL.has(rec.state) ? 'ok' : ''
  status(msg.text || rec.state, tone)
  $('launchInline').hidden = !(rec.state === 'waiting' && (msg.text === S.off || msg.text === S.noAnswer))
  if (!FINAL.has(rec.state)) return
  sending = null
  // a panel that stays open may show another capture by now, which the answer leaves alone
  const mine = !what || what.capture?.id === rec.id || what.capture?.id === rec.replaces
  if (rec.state === 'failed' || rec.state === 'unknown') {
    if (mine) what = { capture: rec }
    updateSend()
  } else {
    recent().then(() => drawFolders())
    if (mine) done()
    else updateSend()
  }
}

/** A capture into the form, from the address or from the worker; the side panel and the panel's window take one after another. */
async function showCapture(id) {
  const rec = await chrome.runtime.sendMessage({ type: M.captureGet, id })
  if (!rec) return
  clearTimeout(closing)
  sending = null
  setCapture(rec)
  if (curio) await loadLibraries(rec.dest?.library || null)
}

/** What the worker left for this panel, taken once: for the side panel of this browser window, or for the panel's own window. */
async function takeWant(w) {
  if (framed || !w || Date.now() - w.at > 15000 || w.to !== (side ? 'side' : 'window')) return
  if (w.windowId != null && myWindow != null && w.windowId !== myWindow) {
    // Vivaldi's side panel may not share a normal browser windowId with the tab; accept unless it's a different normal window
    const own = side ? await chrome.windows.get(myWindow).catch(() => null) : null
    if (!side || own?.type === 'normal') return
  }
  await chrome.storage.session.remove('panelWant')
  if (w.capture == null) return
  // the window's address names what it shows; the side panel's stays as it is, since the worker finds it by address
  if (!side) {
    const url = new URL(location.href)
    url.searchParams.set('capture', String(w.capture))
    history.replaceState(null, '', url)
  }
  await showCapture(String(w.capture))
}

// events while the panel is open; the stream closes with it, since a stream keeps a background library's process alive
function listen() {
  if (subscription || !curio) return
  let timer = null
  const later = (f) => {
    clearTimeout(timer)
    timer = setTimeout(f, 300)
  }
  subscription = curio.subscribe({ events: ['library.listChanged', 'library.opened', 'library.closed', 'folders.changed', 'tags.changed'] }, (e) => {
    if (e.name.startsWith('library.')) {
      later(async () => {
        libs = await curio.library.list()
        await store.setLibraries(libs)
        Libs.render($('library'), libs, library)
      })
    } else if (e.library && e.library === current()?.id) later(() => libraryChanged({ folders: chosen, tags }, true))
  })
  idle()
}

/** A panel left open, unseen or untouched for a while, stops listening, so a library opened in the background can close. */
const IDLE = 5 * 60 * 1000
let idleTimer = 0
function idle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(quiet, IDLE)
}
function quiet() {
  clearTimeout(idleTimer)
  subscription?.close()
  subscription = null
}
/** Back in use: listening again, with the lists as they are now. */
async function wake() {
  if (!curio || ($('form').hidden && $('dropCard').hidden)) return
  if (subscription) return idle()
  listen()
  try {
    libs = await curio.library.list()
    await store.setLibraries(libs)
    Libs.render($('library'), libs, library)
    await libraryChanged({ folders: chosen, tags }, true)
    if (!$('dropCard').hidden) drawDrops(true)
  } catch {}
}

function reportSideState(visible, gone = false) {
  if (!side) return
  chrome.runtime.sendMessage({ type: M.sideState, sideId, windowId: myWindow, visible, gone }).catch(() => {})
}

/** The panel's own window, sized so the form fits inside without scrolling: the browser sizes a window from the outside. */
async function fitWindow() {
  const w = await chrome.windows.getCurrent().catch(() => null)
  myWindow = w?.id ?? null
  reportSideState(!document.hidden)
  ownWindow = !side && w?.type === 'popup'
  if (!ownWindow || w?.id == null) return
  const dw = SIZE.width - innerWidth
  const dh = SIZE.height - innerHeight
  if (Math.abs(dw) > 2 || Math.abs(dh) > 2) await chrome.windows.update(w.id, { width: (w.width || outerWidth) + dw, height: (w.height || outerHeight) + dh }).catch(() => {})
}

// ---- the side panel between saves ----

/** The form, for what came in; `always` also where Folders between saves is off. */
function showForm(always = false) {
  if (!drops && always !== true) return
  $('dropCard').hidden = true
  $('form').hidden = false
  document.documentElement.dataset.view = 'form'
}

/** The drop area over the folders, while the form holds nothing. */
function showDrops() {
  if (!drops || !curio || what || !$('setup').hidden) return
  $('form').hidden = true
  $('dropCard').hidden = false
  document.documentElement.dataset.view = 'drops'
  drawDrops(true)
}

/** The folders of the chosen library, as the drag card has them: All first, recently used ones above the tree. */
async function drawDrops(fresh) {
  const d = await store.dest()
  dropLib = Libs.firstChoice(libs, dropLib || library, d.last?.library || null)
  const lib = dropLib
  Libs.render($('dropLibrary'), libs, lib)
  $('dropSwatch').style.background = libs.find((l) => dst.libraryKey(l) === lib)?.color || ''
  let folders = (lib && (await store.lists(lib))?.folders) || []
  if (folders.some((f) => f.icon)) await loadAll()
  const recent = [...new Set(d.recents.filter((r) => r.library === lib).flatMap((r) => r.folders))].filter((id) => folders.some((f) => f.id === id))
  const list = Folders.view({ folders, chosen: [], recent, filter: '', tab: 'all', collapsed: new Set(), canCreate: false, all: true })
  Folders.render($('dropFolders'), { list, chosen: [], allOn: false, active: -1, reveal: false, collapsed: new Set(), empty: S.noFolders, onToggle: () => {}, onCreate: () => {}, onCollapse: () => {}, onPoint: () => {} })
  const client = curio || dropClient
  if (!fresh || !client || !lib) return
  try {
    folders = await client.folder.list({ library: lib })
    if (dropLib !== lib) return
    await store.setLists(lib, { ...((await store.lists(lib)) || { tags: [], tagGroups: [], fields: [] }), folders })
    drawDrops(false)
  } catch {}
}

/** The drop area or the folder row under the pointer. */
const dropTarget = (el) => /** @type {HTMLElement | null} */ (el?.closest?.('#dropPanel, #dropFolders .p-row[data-id], #dropFolders .p-row[data-all]') || null)

/** @type {HTMLElement | null} */ let lit = null
function lightDrop(el) {
  if (el === lit) return
  lit?.classList.remove('over')
  el?.classList.add('over')
  lit = el
}

/** A drop between saves: on the drop area into the form, on a folder saved there at once. */
async function dropBetween(e) {
  const el = dropTarget(e.target)
  lightDrop(null)
  if (!el) return
  // what the drop carries is readable only now, before anything is awaited
  const { file, url } = readTransfer(e.dataTransfer)
  if (el.id === 'dropPanel') {
    const took = await chrome.runtime.sendMessage({ type: M.sideDrop, at: 'panel', windowId: myWindow }).catch(() => false)
    if (took === true) return
    if (file) setFile(file, url)
    else if (url) await setAddress(url)
    else status(S.nothing, 'error')
    return
  }
  const lib = dropLib
  const folder = el.dataset.all ? null : Number(el.dataset.id)
  if (!lib) return
  // a drag from the page goes as the drag card's does: the content script read it whole, with the page's rules
  const took = await chrome.runtime.sendMessage({ type: M.sideDrop, library: lib, folder, windowId: myWindow }).catch(() => false)
  if (took === true) return
  // from elsewhere: the form takes it with that folder chosen, and sends it
  if (file) setFile(file, url)
  else if (url) await setAddress(url)
  else return status(S.nothing, 'error')
  if (!what) return
  if (library !== lib) {
    library = lib
    Libs.render($('library'), libs, library)
    await libraryChanged({ folders: folder == null ? [] : [folder], tags }, true)
  } else chosen = folder == null ? [] : [folder]
  drawFolders()
  updateSend()
  await send()
}

function wire() {
  $('options').append(icon('settings', 16))
  $('presetSave').append(icon('device-floppy', 15))
  $('presetDelete').append(icon('trash', 15))
  $('preset').addEventListener('change', () => usePreset($('preset').value))
  $('presetSave').addEventListener('click', () => ($('presetName').hidden ? namePreset(true) : savePreset()))
  $('presetDelete').addEventListener('click', deletePreset)
  $('presetName').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Enter') savePreset()
    else namePreset(false)
  })
  drawPresets()
  $('folderSearchIcon').append(icon('search', 15))
  $('library').after(icon('chevron-down', 13))
  const drop = $('drop')
  document.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (!$('dropCard').hidden) return lightDrop(dropTarget(e.target))
    drop.classList.add('over')
  })
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget) return
    drop.classList.remove('over')
    lightDrop(null)
  })
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    drop.classList.remove('over')
    if (!$('dropCard').hidden) return dropBetween(e)
    const { file, url } = readTransfer(e.dataTransfer)
    if (side) {
      const took = await chrome.runtime.sendMessage({ type: M.sideDrop, at: 'panel', windowId: myWindow }).catch(() => false)
      if (took === true) return
    }
    if (file) setFile(file, url)
    else if (url) setAddress(url)
    else status(S.nothing, 'error')
  })
  document.addEventListener('paste', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('input, textarea') && !e.clipboardData?.files.length) return
    e.preventDefault()
    take(e.clipboardData)
  })
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (!$('form').hidden) {
        e.preventDefault()
        send()
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.defaultPrevented && !$('form').hidden) {
      const t = /** @type {HTMLElement | null} */ (e.target)
      if (t?.closest('select, a, summary, #cancel, #options, #presetSave, #presetDelete, #pick, #useAsked, #launchInline, .chip-x, .caret, button.chip')) return
      e.preventDefault()
      send()
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      if (!$('tagPicker').hidden) return closeTagPicker()
      if (!$('form').hidden) cancel()
      else if (framed) leave()
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if (!$('tagPicker').hidden && !e.target.closest('#tagPicker, #tags')) closeTagPicker()
  })
  $('folders').addEventListener('pointerleave', () => {
    if (folderKeyNav || folderActive < 0) return
    folderActive = -1
    for (const r of $('folders').querySelectorAll('.p-row.act')) r.classList.remove('act')
  })
  $('tagRows').addEventListener('pointerleave', () => {
    if (tagActive < 0) return
    tagActive = -1
    for (const r of $('tagRows').querySelectorAll('.p-row.act')) r.classList.remove('act')
  })
  // the picker goes with the keyboard, as Tab leaves the tags
  $('tags').addEventListener('focusout', (e) => !e.relatedTarget?.closest?.('#tagPicker, #tags') && setTimeout(() => !$('tags').contains(document.activeElement) && closeTagPicker()))
  $('pick').addEventListener('click', () => $('file').click())
  $('file').addEventListener('change', () => $('file').files[0] && setFile($('file').files[0]))
  $('library').addEventListener('change', () => libraryChanged())
  $('folderFilter').addEventListener('input', () => drawFolders(false, true))
  $('folderFilter').addEventListener('keydown', folderKey)
  $('tags').addEventListener('click', (e) => e.target === $('tags') && $('tagInput').focus())
  $('tagInput').addEventListener('focus', openTagPicker)
  $('tagInput').addEventListener('input', () => {
    openTagPicker()
    drawTagPicker(false, true)
  })
  $('tagInput').addEventListener('keydown', tagKey)
  $('tagInput').addEventListener('change', addTagFromInput)
  $('keepTags').addEventListener('click', () => {
    keepTags = !keepTags
    store.setSettings({ keepTags })
    drawTags()
  })
  $('send').addEventListener('click', send)
  $('cancel').addEventListener('click', cancel)
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage())
  $('connect').addEventListener('click', connectFromSetup)
  $('pair').addEventListener('click', pairFromSetup)
  $('openCurio').addEventListener('click', launchCurio)
  $('launchInline').addEventListener('click', launchCurio)
  $('useAsked').addEventListener('click', async () => {
    if (!asked) return
    library = asked.library
    $('library').value = library
    const { ids, paths } = dst.splitFolders(asked.folders)
    $('asked').hidden = true
    await libraryChanged({ folders: ids, paths, tags })
  })
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === M.captureState) onCaptureState(msg)
    else if (side && msg?.type === M.sidePing) reply({ visible: !document.hidden, windowId: myWindow, sideId })
    return false
  })
  for (const type of ['pointerdown', 'keydown', 'focus']) addEventListener(type, wake, { capture: true, passive: true })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      reportSideState(false)
      quiet()
      // Vivaldi hides the side panel without unloading it; reset so reopening starts blank
      if (side && !sending) {
        reset()
        chosen = []
        $('folderFilter').value = ''
        drawFolders()
        status('')
        showDrops()
      }
    } else {
      reportSideState(true)
      wake()
    }
  })
  addEventListener('pagehide', () => {
    reportSideState(false, true)
    quiet()
  })
  $('dropGlyph').append(icon('photo', 36))
  $('dropLibrary').after(icon('chevron-down', 13))
  $('dropLibrary').addEventListener('change', () => {
    dropLib = $('dropLibrary').value
    drawDrops(true)
  })
  if (side) {
    document.body.classList.add('side')
    $('dropPanel').addEventListener('click', () => showForm())
  }
  // a left press beside the window, on the page's dimmed part, closes it
  if (framed) document.body.addEventListener('mousedown', (e) => e.button === 0 && e.target === document.body && leave())
  chrome.storage.session.onChanged.addListener((changes) => changes.panelWant?.newValue && takeWant(changes.panelWant.newValue))
}

/** The framed panel goes: the page's dialog closes. */
const leave = () => parent.postMessage({ curio: 'close' }, '*')

/**
 * In a page, nothing is drawn or listened to until the worker vouches for the secret the content script hands over: any site may frame this page.
 * @returns {Promise<{ capture: string | null, mode: string, at: { x: number, y: number } | null }>}
 */
function granted() {
  return new Promise((ok) => {
    const onMessage = async (e) => {
      if (e.source !== parent || !e.data || e.data.curio !== 'grant' || typeof e.data.secret !== 'string') return
      const g = await chrome.runtime.sendMessage({ type: M.frameGrant, secret: e.data.secret }).catch(() => null)
      if (!g || g.error) return
      removeEventListener('message', onMessage)
      const at = e.data.at
      ok({ ...g, at: at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null })
    }
    addEventListener('message', onMessage)
    parent.postMessage({ curio: 'ready' }, '*')
  })
}

/** Applies the host tab's zoom factor inversely to `#card` so the floating card stays at a fixed physical size. */
function applyZoom(z) {
  pageZoom = Number.isFinite(z) && z > 0 ? z : 1
  if (!framed) return
  document.documentElement.style.setProperty('--page-zoom', String(pageZoom))
  document.documentElement.style.setProperty('--card-zoom', String(1 / pageZoom))
  if (placedAt) place(placedAt)
}

/** The window of a framed panel comes beside the pointer, the drag card and the panel alike, so one takes the other's place; in the middle where the pointer isn't known. */
function place(at) {
  placedAt = at || null
  const wrap = $('cardWrap')
  if (!at) {
    wrap.style.position = ''
    wrap.style.left = ''
    wrap.style.top = ''
    return
  }
  const r = wrap.getBoundingClientRect()
  const edge = 16 / pageZoom
  const gap = 24 / pageZoom
  const clamp = (v, max) => Math.max(edge, Math.min(max, v))
  const left = at.x + gap + r.width <= innerWidth - edge ? at.x + gap : at.x - gap - r.width
  wrap.style.position = 'absolute'
  wrap.style.left = clamp(left, innerWidth - r.width - edge) + 'px'
  wrap.style.top = clamp(at.y - r.height / 3, innerHeight - r.height - edge) + 'px'
}

/** The drag card: the drops view while the page's drag lasts, on the drop area for the form or on a folder to save there at once; a drop on the drop area turns it into the form in place, on the worker's next grant. */
async function dragCard(grant) {
  const html = document.documentElement
  $('form').hidden = true
  $('dropCard').hidden = false
  html.dataset.view = 'drops'
  place(grant.at)
  parent.postMessage({ curio: 'shown' }, '*')
  libs = (await store.libraries())?.list || []
  const conn = await store.conn()
  dropClient = conn.token ? connection.client(conn) : null
  const off = (text) => {
    $('dropOff').textContent = text
    $('dropOff').hidden = !text
  }
  if (!conn.token) off(S.noToken)
  else connection.state(conn, 1500).then((st) => off(st.state === 'up' ? '' : st.state === 'refused' ? st.message || S.refused : S.offWaits), () => off(S.offWaits))
  let dragging = true
  // the drag stays in the page, whose content script covers this frame and says where it is: Chrome drops nothing from a page into a frame of another process
  const hit = (x, y) => {
    const el = dropTarget(x >= 0 ? document.elementFromPoint(x, y) : null)
    lightDrop(el)
    return el
  }
  // the list scrolls while the pointer rests near its edge, as a drag over it would
  const scroll = (x, y) => {
    const list = $('dropFolders')
    const r = list.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return
    const edge = 36 / pageZoom
    if (y < r.top + edge) list.scrollTop -= 12
    else if (y > r.bottom - edge) list.scrollTop += 12
  }
  addEventListener('message', async (e) => {
    if (e.source !== parent || !dragging || !e.data) return
    if (e.data.curio === 'point' && typeof e.data.x === 'number' && typeof e.data.y === 'number') {
      scroll(e.data.x, e.data.y)
      hit(e.data.x, e.data.y)
    } else if (e.data.curio === 'grant' && typeof e.data.secret === 'string') {
      // the form, on what was dropped on the drop area: the worker vouches for this secret as for the first
      const g = await chrome.runtime.sendMessage({ type: M.frameGrant, secret: e.data.secret }).catch(() => null)
      if (!g || g.error || g.mode !== 'panel' || !dragging) return
      dragging = false
      if (g.zoom) applyZoom(g.zoom)
      $('dropCard').hidden = true
      $('form').hidden = false
      place(grant.at)
      parent.postMessage({ curio: 'shown' }, '*')
      window.focus()
      $('folderFilter').focus({ preventScroll: true })
      await formStart(g.capture)
    }
  })
  // the drop itself comes from this tab's content script only, which the page can't speak for
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!dragging || msg?.type !== M.cardDrop || sender.id !== chrome.runtime.id || sender.tab?.id !== grant.tab || sender.frameId !== 0) return false
    const el = hit(Number(msg.x), Number(msg.y))
    const w = !el ? null : el.id === 'dropPanel' ? { at: 'panel' } : dropLib ? { at: 'folder', library: dropLib, folder: el.dataset.all ? null : Number(el.dataset.id) } : null
    if (w) chrome.runtime.sendMessage({ type: M.frameDrop, ...w }).catch(() => {})
    // a folder is the end of it, and so is a drop beside the targets; the drop area becomes the form in this place
    if (w?.at !== 'panel') leave()
    return false
  })
  await drawDrops(true)
}

/** The form: what the frame, the window or the side panel was opened on, and the connection to Curio. */
async function formStart(id) {
  document.documentElement.dataset.view = 'form'
  drawTags()
  if (id) await showCapture(String(id))
  if (!framed) await takeWant((await chrome.storage.session.get('panelWant')).panelWant)
  const c = await store.conn()
  $('token').value = c.token
  $('port').value = c.port
  if (!c.token) return (await ping(c.port)) ? showSetup(S.connectFirst) : showOff()
  const st = await connection.state(c)
  if (st.state === 'up') return open(c)
  if (st.state === 'off') return showOff()
  showSetup(st.state === 'refused' ? st.message || S.refused : S.offMore)
}

async function start() {
  /** @type {any} */ let grant = null
  // any site may frame this page: in a frame it works only as the worker's own, on a grant
  if (window !== window.top && !framed) return
  if (framed) {
    if (location.ancestorOrigins.length !== 1) return
    grant = await granted()
    document.documentElement.classList.add('framed')
    applyZoom(grant.zoom)
    chrome.tabs?.onZoomChange?.addListener((info) => {
      if (info.tabId === grant.tab) applyZoom(info.newZoomFactor)
    })
  }
  wire()
  if (side) reportSideState(!document.hidden)
  const s = await store.settings()
  applyTheme(store.themeModeOf(s), await store.theme())
  chrome.storage.local.onChanged.addListener(async (changes) => {
    if (!changes.settings && !changes.theme) return
    const next = await store.settings()
    applyTheme(store.themeModeOf(next), await store.theme())
  })
  keepTags = s.keepTags
  $('card').hidden = false
  if (grant?.mode === 'drop') return dragCard(grant)
  if (framed) {
    place(grant.at)
    parent.postMessage({ curio: 'shown' }, '*')
    window.focus()
    $('folderFilter').focus({ preventScroll: true })
  } else await fitWindow()
  await formStart(framed ? grant.capture : params.get('capture'))
}

start()
