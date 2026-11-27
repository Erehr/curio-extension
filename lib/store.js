// @ts-check
// chrome.storage, with defaults and a schema version. For the worker, the panel and options; content scripts can't read it (S6).
import { fromPresets } from './rules.js'

export const VERSION = 1

/** Page-level keyboard shortcuts handled directly by the extension (not chrome.commands, so Alt+D works reliably across Chromium browsers). */
export const SHORTCUT_COMMANDS = /** @type {const} */ ([
  ['save-page', 'Open save window (page or media)'],
  ['quick-save', 'Save item under pointer'],
  ['capture-region', 'Screenshot an area'],
  ['capture-visible', 'Screenshot visible area'],
  ['save-page-all', 'Save page as link without the form'],
])

export const DEFAULT_SHORTCUTS = {
  'save-page': 'Alt+D',
  'quick-save': 'Alt+Shift+S',
  'capture-region': 'Alt+Shift+A',
  'capture-visible': '',
  'save-page-all': '',
}

export const DEFAULT_SETTINGS = {
  v: VERSION,
  /** Hosts where the content script stays quiet. */
  off: /** @type {string[]} */ ([]),
  /** Pictures smaller than this, in CSS pixels both ways, aren't collected from under the pointer. */
  minSize: 48,
  /** Read eagle-* attributes when no Curio attribute gives the value. */
  eagle: true,
  /** Pages a rule follows may make the folders they name, where the token has organize. */
  makeFolders: false,
  /** Keep the panel's tags for the next capture. */
  keepTags: false,
  /** Whether to remember the last used folder: never (starts at All), per site, or always. */
  rememberFolder: /** @type {'never' | 'site' | 'always'} */ ('never'),
  /** Theme mode: light, dark, system (follows OS/browser), or curio (follows Curio's window theme). */
  themeMode: /** @type {'light' | 'dark' | 'system' | 'curio'} */ ('system'),
  /** Legacy flag kept in sync with themeMode === 'curio'. */
  appTheme: false,
  /** A drop zone while a picture or a link is dragged, except on these hosts. */
  drag: true,
  dragOff: /** @type {string[]} */ ([]),
  /** Alt+click saves what is under the pointer. */
  altClick: true,
  /** A save button over pictures, at a corner, of a size, on pictures at least this large. */
  hover: false,
  hoverCorner: 'bottom-right',
  hoverSize: 20,
  hoverMin: 200,
  /** Page keyboard shortcuts by command name; empty string means unbound. */
  shortcuts: /** @type {Record<string, string>} */ ({ ...DEFAULT_SHORTCUTS }),
  /** A download Curio makes carries the cookies the browser holds for its address. */
  cookies: false,
  /** The browser reads every file and sends its bytes, as before Curio downloaded them itself. */
  browserDownload: false,
  /** Never shown: the one port on this computer a debug build of Curio downloads from (CURIO_DEBUG_LOOPBACK_PORT), for tools/ext.mjs. */
  loopbackPort: 0,
  /** Never shown: how long the offscreen document waits with nothing to do before it closes, in ms; tools/ext.mjs shortens it. */
  senderIdle: 60000,
}

export const DEFAULT_CONN = { port: 41733, token: '' }

/** @typedef {{ library: string, folders: number[], tags: string[], folderPaths?: string[] }} Destination */

export const DEFAULT_DEST = {
  /** Presets of the panel: a library with folders and tags, by name. @type {{ id: string, name: string, library: string, folders: number[], tags: string[] }[]} */
  saved: [],
  /** @type {Destination | null} */
  last: null,
  /** @type {Destination[]} */
  recents: [],
  /** Per library id: the folders and tags last used there. @type {Record<string, { folders: number[], tags: string[] }>} */
  perLibrary: {},
  /** Per registrable site, then library id: the folders last used there. @type {Record<string, Record<string, number[]>>} */
  perSite: {},
  /** A word a page may use for a library, to its id. @type {Record<string, string>} */
  aliases: {},
  /** @type {string[]} */
  recentTags: [],
  /** Site rules, top to bottom (lib/rules.js). @type {import('./rules.js').Rule[]} */
  rules: [],
}

const local = () => chrome.storage.local
const session = () => chrome.storage.session

async function read(key, defaults) {
  const got = (await local().get(key))[key]
  return { ...structuredClone(defaults), ...(got || {}) }
}

/** Closes storage to content scripts; called whenever the worker starts. */
export async function closeToContentScripts() {
  await local().setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  await session().setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
}

/** The example extension kept `token`, `port` and `library` at the top level; 1.11 had presets and a list of followed sites where rules are now. */
export async function migrate() {
  const kept = await local().get(['dest', 'settings'])
  if (kept.dest?.presets || kept.settings?.follow) {
    const { presets, ...dest } = kept.dest || {}
    const { follow, ...settings } = kept.settings || {}
    await local().set({ dest: { ...dest, rules: [...(dest.rules || []), ...fromPresets(kept.dest || {}, kept.settings || {})] }, ...(kept.settings ? { settings } : {}) })
  }
  const old = await local().get(['token', 'port', 'library', 'conn', 'dest'])
  if (old.conn || (!old.token && !old.port && !old.library)) return
  await local().set({ conn: { ...DEFAULT_CONN, token: old.token || '', port: Number(old.port) || 41733 } })
  if (old.library && !old.dest) await local().set({ dest: { ...DEFAULT_DEST, last: { library: old.library, folders: [], tags: [] } } })
  await local().remove(['token', 'port', 'library'])
}

export const conn = () => read('conn', DEFAULT_CONN)
/** Forgets the connection and what was kept of Curio's libraries and theme; the port stays. */
export async function forget() {
  const all = await local().get(null)
  await local().remove(['libraries', 'theme', ...Object.keys(all).filter((k) => k.startsWith('lists:'))])
  await local().set({ conn: { ...DEFAULT_CONN, port: all.conn?.port || DEFAULT_CONN.port, token: '' } })
}
export const setConn = (c) => local().set({ conn: { ...DEFAULT_CONN, ...c } })
export async function settings() {
  const s = await read('settings', DEFAULT_SETTINGS)
  s.shortcuts = shortcutsOf(s)
  return s
}

/** Normalized shortcut map for all page commands (missing keys inherit defaults; explicit '' stays unbound). */
export function shortcutsOf(s) {
  const raw = s?.shortcuts && typeof s.shortcuts === 'object' ? s.shortcuts : {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name] of SHORTCUT_COMMANDS) {
    out[name] = typeof raw[name] === 'string' ? raw[name].trim() : DEFAULT_SHORTCUTS[name]
  }
  return out
}

const CODE_NAMES = {
  Space: 'Space',
  Comma: 'Comma',
  Period: 'Period',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
}

/** Formats a KeyboardEvent into a canonical shortcut string (e.g. "Alt+D"), or '' if invalid / modifier-only. */
export function formatShortcut(e) {
  if (!e || e.isComposing || e.repeat) return ''
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return ''
  if (['Alt', 'Control', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return ''
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return ''
  let main = ''
  const code = String(e.code || '')
  if (/^Key[A-Z]$/.test(code)) main = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) main = code.slice(5)
  else if (/^F([1-9]|1[0-2])$/.test(code)) main = code
  else if (code in CODE_NAMES) main = CODE_NAMES[code]
  else {
    const k = String(e.key || '').toUpperCase()
    if (/^[A-Z0-9]$/.test(k)) main = k
  }
  if (!main) return ''
  const parts = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.metaKey) parts.push('Command')
  if (e.shiftKey) parts.push('Shift')
  parts.push(main)
  return parts.join('+')
}
/** What pictures take the pointer with: the drag card, the button at their corner, or neither; kept as the two switches. */
export const MODES = [['drag', 'Drag'], ['button', 'Button'], ['off', 'None']]
export const modeOf = (s) => (s.hover ? 'button' : s.drag ? 'drag' : 'off')
export const modeSettings = (m) => ({ drag: m === 'drag', hover: m === 'button' })
/** Whether the panel pre-selects the last used folder. */
export const REMEMBER_FOLDERS = [['never', 'Never'], ['site', 'Per site'], ['always', 'Always']]
/** Extension color theme modes. */
export const THEME_MODES = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System'], ['curio', 'Curio']]
export const themeModeOf = (s) => (['light', 'dark', 'system', 'curio'].includes(s?.themeMode) ? s.themeMode : s?.appTheme ? 'curio' : 'system')
export const themeSettings = (mode) => ({ themeMode: ['light', 'dark', 'system', 'curio'].includes(mode) ? mode : 'system', appTheme: mode === 'curio' })
/** Applies Light, Dark, System, or Curio's own theme tokens to `root` (`document.documentElement`). */
export function applyTheme(root, mode, curioTheme = null) {
  const prev = root.dataset.curioTokens ? root.dataset.curioTokens.split(',') : []
  for (const k of prev) if (k) root.style.removeProperty('--' + k)
  delete root.dataset.curioTokens
  if (mode === 'light' || mode === 'dark') {
    root.dataset.theme = mode
    return
  }
  if (mode === 'curio' && curioTheme?.tokens) {
    const applied = []
    for (const [k, v] of Object.entries(curioTheme.tokens)) {
      if (/^[a-z0-9-]+$/.test(k) && typeof v === 'string' && !['row', 'font-size'].includes(k)) {
        root.style.setProperty('--' + k, v)
        applied.push(k)
      }
    }
    root.dataset.curioTokens = applied.join(',')
    root.dataset.theme = curioTheme.dark ? 'dark' : 'light'
    return
  }
  delete root.dataset.theme
}
export async function setSettings(patch) {
  const s = await settings()
  await local().set({ settings: { ...s, ...patch, v: VERSION } })
}
export const dest = () => read('dest', DEFAULT_DEST)
export async function setDest(patch) {
  const d = await dest()
  await local().set({ dest: { ...d, ...patch } })
}

/** @returns {Promise<{ at: number, list: any[] } | null>} */
export async function libraries() {
  return (await local().get('libraries')).libraries || null
}
export const setLibraries = (list) => local().set({ libraries: { at: Date.now(), list } })

/** @returns {Promise<{ at: number, folders: any[], tags: any[], tagGroups: any[], fields: any[] } | null>} */
export async function lists(library) {
  return (await local().get('lists:' + library))['lists:' + library] || null
}
export const setLists = (library, l) => local().set({ ['lists:' + library]: { at: Date.now(), ...l } })

export async function theme() {
  return (await local().get('theme')).theme || null
}
export const setTheme = (t) => local().set({ theme: t })

const CAP = 'capture:'
export async function getCapture(id) {
  return (await session().get(CAP + id))[CAP + id] || null
}
export const putCapture = (rec) => session().set({ [CAP + rec.id]: rec })
export const dropCapture = (id) => session().remove(CAP + id)
export async function allCaptures() {
  const all = await session().get(null)
  return Object.entries(all).filter(([k]) => k.startsWith(CAP)).map(([, v]) => v)
}

/** A number unique among the session's referer rules. */
export async function nextRuleId() {
  const { ruleId = 0 } = await session().get('ruleId')
  const n = (ruleId % 1_000_000) + 1
  await session().set({ ruleId: n })
  return n
}
