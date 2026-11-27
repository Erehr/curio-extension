// @ts-check
// Options: the connection, where the content script stays quiet, and which pages may choose a destination.
import * as store from '../lib/store.js'
import * as connection from '../lib/connection.js'
import { findLibrary, libraryKey } from '../lib/destinations.js'
import { S } from '../lib/strings.js'
import { newCode, pair } from '../lib/pairing.js'
import * as queue from '../lib/queue.js'
import { M } from '../lib/messages.js'
import * as Rules from './rules.js'

const $ = (id) => /** @type {any} */ (document.getElementById(id))
const hosts = (text) => [...new Set(String(text).split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))]

/** Applies the selected theme mode (light, dark, system, or Curio's own theme). */
async function syncTheme(mode, refresh = false) {
  let t = mode === 'curio' ? await store.theme() : null
  if (mode === 'curio' && (refresh || !t)) {
    const c = await store.conn()
    if (c.token) {
      try {
        t = await connection.client(c).app.theme()
        await store.setTheme(t)
      } catch {}
    }
  }
  store.applyTheme(document.documentElement, mode, t)
}

async function libraries() {
  return (await store.libraries())?.list || []
}

function connStatus(text, tone = '') {
  $('connStatus').textContent = text
  $('connStatus').className = 'note' + (tone ? ' ' + tone : '')
}

/** Curio forgets the token where it answers; the extension forgets it, the library list and what it kept of each library either way. */
async function disconnect() {
  const c = await store.conn()
  $('disconnect').disabled = true
  let gone = false
  try {
    await connection.client(c).token.forget()
    gone = true
  } catch {}
  await store.forget()
  $('token').value = ''
  $('disconnect').hidden = true
  $('disconnect').disabled = false
  connStatus(gone ? 'Disconnected; Curio deleted the token.' : 'Disconnected. Curio wasn\'t reached: delete the token in its Settings › API.', gone ? '' : 'error')
}

async function connect() {
  const c = { token: $('token').value.trim(), port: Number($('port').value) || 41733 }
  connStatus(S.connecting)
  const st = await connection.state(c)
  if (st.state === 'up') {
    await store.setConn(c)
    $('disconnect').hidden = false
    connStatus(S.connected(st.info.version), 'ok')
    try {
      await store.setLibraries(await connection.client(c).library.list())
    } catch {}
  } else if (st.state === 'no-token') connStatus(S.noToken, 'error')
  else if (st.state === 'refused') connStatus(st.message || S.refused, 'error')
  else connStatus(S.offMore, 'error')
}

/** Connect: Curio's window asks the person to allow this extension, with the code shown here too. */
async function pairHere() {
  const port = Number($('port').value) || 41733
  const code = newCode()
  $('pair').disabled = true
  $('pairCode').textContent = code
  $('pairCode').hidden = false
  connStatus(S.pairing)
  try {
    const r = await pair(port, code)
    if (!('token' in r)) return connStatus(r.error === 'off' ? S.offMore : r.message, 'error')
    $('token').value = r.token
    await connect()
  } finally {
    $('pair').disabled = false
    $('pairCode').hidden = true
  }
}

const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)

/** What waits for Curio, on this computer only: an address for Curio to download, or the bytes the browser read. */
async function waiting() {
  const list = await queue.all().catch(() => [])
  const box = $('queue')
  box.replaceChildren()
  const remove = (ids) => chrome.runtime.sendMessage({ type: M.queueRemove, ids }).then(waiting)
  for (const e of list.sort((a, b) => a.at - b.at)) {
    const li = document.createElement('li')
    const what = document.createElement('span')
    const d = e.rec.draft || {}
    what.textContent = `${d.title || d.pageTitle || d.src || e.id} · ${e.size ? mb(e.size) : 'address'}${e.why === 'unknown' ? ' · no answer' : ''}`
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = 'Remove'
    del.addEventListener('click', () => remove([e.id]))
    li.append(what, del)
    box.append(li)
  }
  const bytes = list.reduce((n, e) => n + (e.size || 0), 0)
  $('queueTotal').textContent = list.length ? `${list.length}${bytes ? ' · ' + mb(bytes) : ''}` : 'Empty'
  $('queueClear').hidden = !list.length
  $('queueClear').onclick = () => remove(list.map((e) => e.id))
}

/** A library's folders, tags and tag groups from Curio, kept for the panel too; null while it doesn't answer. */
async function fetchLists(library) {
  const c = await store.conn()
  if (!c.token) return null
  const curio = connection.client(c)
  const [folders, tags, tagGroups] = await Promise.all([curio.folder.list({ library }), curio.tag.list({ library }), curio.tagGroup.list({ library })])
  const kept = (await store.lists(library)) || {}
  await store.setLists(library, { ...kept, folders, tags, tagGroups })
  return { folders, tags, tagGroups }
}

/** Editable page shortcuts stored in extension settings, plus the browser-managed toolbar popup binding. */
let recordingKey = ''
function keyNote(text, tone = '') {
  $('keysNote').textContent = text
  $('keysNote').className = 'note' + (tone ? ' ' + tone : '')
}
async function setShortcut(name, value) {
  const s = await store.settings()
  const next = { ...store.shortcutsOf(s), [name]: value }
  await store.setSettings({ shortcuts: next })
  recordingKey = ''
  keyNote('')
  await shortcuts()
}
async function shortcuts() {
  const s = await store.settings()
  const map = store.shortcutsOf(s)
  const list = $('keys')
  list.replaceChildren()
  for (const [cmd, label] of store.SHORTCUT_COMMANDS) {
    const bound = map[cmd] || ''
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = label
    const ctl = document.createElement('span')
    ctl.className = 'key-ctl'
    const rec = document.createElement('button')
    rec.type = 'button'
    rec.className = 'key-rec' + (recordingKey === cmd ? ' rec' : '') + (!bound && recordingKey !== cmd ? ' unset' : '')
    rec.textContent = recordingKey === cmd ? 'Press keys…' : bound || 'Not set'
    rec.title = 'Click to record a shortcut (Esc to cancel, Backspace to clear)'
    rec.addEventListener('click', () => {
      recordingKey = recordingKey === cmd ? '' : cmd
      keyNote('')
      shortcuts().then(() => recordingKey === cmd && list.querySelector('.key-rec.rec')?.focus())
    })
    rec.addEventListener('keydown', (e) => {
      if (recordingKey !== cmd) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        recordingKey = ''
        keyNote('')
        return void shortcuts()
      }
      if (e.key === 'Backspace' || e.key === 'Delete') return void setShortcut(cmd, '')
      const combo = store.formatShortcut(e)
      if (!combo) return
      const clash = store.SHORTCUT_COMMANDS.find(([other]) => other !== cmd && map[other]?.toLowerCase() === combo.toLowerCase())
      if (clash) return keyNote(`${combo} is already used by "${clash[1]}".`, 'error')
      setShortcut(cmd, combo)
    })
    rec.addEventListener('blur', () => {
      if (recordingKey === cmd) {
        recordingKey = ''
        shortcuts()
      }
    })
    ctl.append(rec)
    if (bound) {
      const clr = document.createElement('button')
      clr.type = 'button'
      clr.className = 'key-clr'
      clr.title = 'Clear shortcut'
      clr.setAttribute('aria-label', `Clear ${label}`)
      clr.textContent = '×'
      clr.addEventListener('click', () => setShortcut(cmd, ''))
      ctl.append(clr)
    }
    li.append(name, ctl)
    list.append(li)
  }
  const browserCmds = await chrome.commands.getAll().catch(() => [])
  const action = browserCmds.find((c) => c.name === '_execute_action')
  if (action) {
    const li = document.createElement('li')
    li.className = 'browser-key'
    const name = document.createElement('span')
    name.textContent = action.description || 'Open toolbar menu'
    const key = document.createElement(action.shortcut ? 'kbd' : 'span')
    key.textContent = action.shortcut || 'Not set'
    if (!action.shortcut) key.className = 'unset'
    li.append(name, key)
    list.append(li)
  }
}

async function aliasesText() {
  const d = await store.dest()
  const libs = await libraries()
  return Object.entries(d.aliases).map(([word, key]) => `${word} = ${libs.find((l) => libraryKey(l) === key)?.name || key}`).join('\n')
}

async function save() {
  const num = (id, min, max, fallback) => Math.max(min, Math.min(max, Number($(id).value) || fallback))
  await store.setSettings({
    off: hosts($('off').value),
    minSize: num('minSize', 1, 2000, 48),
    eagle: $('eagle').checked,
    rememberFolder: $('rememberFolder').value,
    ...store.themeSettings($('themeMode').value),
    makeFolders: $('makeFolders').checked,
    cookies: $('cookies').checked,
    browserDownload: $('browserDownload').checked,
    altClick: $('altClick').checked,
    ...store.modeSettings($('mode').value),
    dragOff: hosts($('dragOff').value),
    hoverCorner: $('hoverCorner').value,
    hoverSize: num('hoverSize', 20, 48, 20),
    hoverMin: num('hoverMin', 1, 4000, 200),
  })
  const libs = await libraries()
  const aliases = {}
  const unknown = []
  for (const line of String($('aliases').value).split('\n')) {
    const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/)
    if (!m) continue
    const lib = findLibrary(m[2], libs, {})
    if (lib) aliases[m[1]] = libraryKey(lib)
    else unknown.push(m[2])
  }
  await store.setDest({ aliases })
  $('saved').textContent = unknown.length ? `Not on the library list: ${unknown.join(', ')}` : 'Saved'
  $('saved').className = 'note' + (unknown.length ? ' error' : '')
}

async function start() {
  const c = await store.conn()
  const s = await store.settings()
  $('token').value = c.token
  $('port').value = c.port
  $('off').value = s.off.join('\n')
  $('minSize').value = s.minSize
  $('eagle').checked = s.eagle
  for (const [v, label] of store.REMEMBER_FOLDERS) $('rememberFolder').append(new Option(label, v))
  $('rememberFolder').value = s.rememberFolder || 'never'
  for (const [v, label] of store.THEME_MODES) $('themeMode').append(new Option(label, v))
  const mode = store.themeModeOf(s)
  $('themeMode').value = mode
  await syncTheme(mode)
  $('makeFolders').checked = s.makeFolders
  $('cookies').checked = s.cookies
  $('browserDownload').checked = s.browserDownload
  $('altClick').checked = s.altClick
  for (const [v, label] of store.MODES) $('mode').append(new Option(label, v))
  $('mode').value = store.modeOf(s)
  $('dragOff').value = s.dragOff.join('\n')
  $('hoverCorner').value = s.hoverCorner
  $('hoverSize').value = s.hoverSize
  $('hoverMin').value = s.hoverMin
  $('aliases').value = await aliasesText()
  $('themeMode').addEventListener('change', async () => {
    await save()
    await syncTheme($('themeMode').value, true)
  })
  $('connect').addEventListener('click', connect)
  $('pair').addEventListener('click', pairHere)
  $('disconnect').addEventListener('click', disconnect)
  $('disconnect').hidden = !c.token
  $('addRule').addEventListener('click', () => Rules.add())
  $('keysReset').addEventListener('click', async () => {
    recordingKey = ''
    await store.setSettings({ shortcuts: { ...store.DEFAULT_SHORTCUTS } })
    keyNote('Shortcuts reset to defaults')
    await shortcuts()
  })
  $('keysEdit').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))
  shortcuts()
  Rules.mount($('rules'), { fetchLists })
  waiting()
  setInterval(waiting, 3000)
  addEventListener('focus', () => (shortcuts(), Rules.reload()))
  for (const id of ['off', 'minSize', 'eagle', 'rememberFolder', 'makeFolders', 'cookies', 'browserDownload', 'aliases', 'altClick', 'mode', 'dragOff', 'hoverCorner', 'hoverSize', 'hoverMin']) $(id).addEventListener('change', save)
  if (c.token) {
    const st = await connection.state(c)
    if (st.state === 'up') connStatus(S.connected(st.info.version), 'ok')
    else connStatus(st.state === 'refused' ? st.message || S.refused : S.offMore, 'error')
  }
}

start()
