// @ts-check
// Where a capture goes: the site rules, the page's hint where a rule follows it, the last destination, recents and the menu's label. No chrome.* API.
import { apply } from './rules.js'

/** @typedef {import('./captures.js').Destination} Destination */

/** How a library is kept: its id, or its folder for one listed with `id: null`. */
export const libraryKey = (l) => l.id || l.path || l.name

const TWO_PART = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/

/** The hostname of a web address, lowercased, or ''. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/** The registrable site of a host: the last two labels, three under such as co.uk. */
export function siteOf(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  return parts.slice(TWO_PART.test(h) ? -3 : -2).join('.')
}

/** The folders pre-selected for a library under the rememberFolder mode: never (empty -> All), per site, or always. */
export function rememberedFolders(state, library, { mode = 'never', host = '' } = {}) {
  if (!library || mode === 'never') return []
  if (mode === 'site') {
    const s = siteOf(host)
    return s && Array.isArray(state?.perSite?.[s]?.[library]) ? [...state.perSite[s][library]] : []
  }
  return Array.isArray(state?.perLibrary?.[library]?.folders) ? [...state.perLibrary[library].folders] : []
}

/** Whether a host is one of the patterns or under one: `example.com` matches `img.example.com`. */
export function hostMatches(host, patterns) {
  const h = String(host || '').toLowerCase()
  return (patterns || []).some((p) => {
    const q = String(p).trim().toLowerCase().replace(/^\*\./, '')
    return !!q && (h === q || h.endsWith('.' + q))
  })
}

/**
 * A library named by a page or a setting: an alias, an id, then a name no other library has.
 * @param {string} word
 * @param {any[]} libraries
 * @param {Record<string, string>} aliases
 */
export function findLibrary(word, libraries, aliases = {}) {
  if (!word) return null
  const w = String(word).trim()
  const aliased = Object.entries(aliases).find(([k]) => k.toLowerCase() === w.toLowerCase())
  const target = aliased ? aliased[1] : w
  const byKey = libraries.find((l) => l.id === target || (l.path && l.path === target))
  if (byKey) return byKey
  const named = libraries.filter((l) => l.name.toLowerCase() === target.toLowerCase())
  return named.length === 1 ? named[0] : null
}

/**
 * Folder ids by number and paths by text, as a page names them.
 * @param {(number | string)[]} folders
 */
export function splitFolders(folders = []) {
  const ids = []
  const paths = []
  for (const f of folders) (typeof f === 'number' ? ids.push(f) : paths.push(f))
  return { ids, paths }
}

/**
 * The capture's destination: the page's hint where a rule follows it, else the place the rules give, else the last one used, else none (the panel opens). The rules' tags go with each.
 * @param {any} draft
 * @param {{ last: Destination | null, aliases: Record<string, string>, rules?: any[], perLibrary?: Record<string, { folders: number[], tags: string[] }>, perSite?: Record<string, Record<string, number[]>> }} dest
 * @param {any[]} libraries
 * @param {string} host
 * @param {{ rememberFolder?: 'never' | 'site' | 'always', keepTags?: boolean }} [opts]
 * @returns {{ dest: Destination | null, from: 'page' | 'rule' | 'last' | null, asked: null | { library: string | null, name: string, folders: (number | string)[], reachable: boolean, followed: boolean }, rules: ReturnType<typeof apply> }}
 */
export function resolve(draft, dest, libraries, host, opts = {}) {
  const rules = apply(dest.rules || [], draft, host)
  const tagged = (d) => ({ ...d, tags: [...new Set([...(d.tags || []), ...rules.tags])] })
  const hint = draft.hints || {}
  let asked = null
  if (hint.library || hint.folders?.length) {
    const lib = hint.library ? findLibrary(hint.library, libraries, dest.aliases) : dest.last ? libraries.find((l) => libraryKey(l) === dest.last?.library) || null : null
    const followed = rules.follow
    asked = { library: lib ? libraryKey(lib) : null, name: lib ? lib.name : String(hint.library || ''), folders: hint.folders || [], reachable: !!lib, followed }
    if (followed && lib) {
      const { ids, paths } = splitFolders(hint.folders)
      return { dest: tagged({ library: libraryKey(lib), folders: ids, tags: [], ...(paths.length ? { folderPaths: paths } : {}) }), from: 'page', asked, rules }
    }
  }
  if (rules.library) return { dest: tagged({ library: rules.library, folders: rules.folders, tags: [] }), from: 'rule', asked, rules }
  if (dest.last) {
    const folders = opts.rememberFolder ? rememberedFolders(dest, dest.last.library, { mode: opts.rememberFolder, host }) : [...(dest.last.folders || [])]
    const tags = typeof opts.keepTags === 'boolean' ? (opts.keepTags ? [...(dest.last.tags || [])] : []) : [...(dest.last.tags || [])]
    return { dest: tagged({ library: dest.last.library, folders, tags, folderPaths: undefined }), from: 'last', asked, rules }
  }
  return { dest: null, from: null, asked, rules }
}

/** The path of a folder, its names from the top joined by ` / `. */
export function folderPath(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const names = []
  let f = byId.get(id)
  for (let guard = 0; f && guard < 64; guard++) {
    names.unshift(f.name)
    f = f.parentId != null ? byId.get(f.parentId) : null
  }
  return names.join(' / ')
}

/**
 * Folder paths given as `A/B` from the top, to ids; the ones that don't exist are named in `missing`.
 * @param {string[]} paths
 * @param {any[]} folders
 */
export function resolvePaths(paths, folders) {
  const ids = []
  const missing = []
  for (const path of paths) {
    const parts = String(path).split('/').map((s) => s.trim()).filter(Boolean)
    let parent = null
    let found = null
    for (const part of parts) {
      found = folders.find((f) => (f.parentId ?? null) === parent && f.name.toLowerCase() === part.toLowerCase()) || null
      if (!found) break
      parent = found.id
    }
    if (found && parts.length) ids.push(found.id)
    else missing.push(parts.join(' / '))
  }
  return { ids, missing }
}

/** `Library / Folder`, for the menu and the toast. */
export function label(d, libraries, folders) {
  if (!d) return ''
  const lib = libraries.find((l) => libraryKey(l) === d.library)
  if (!lib) return ''
  const name = lib.name
  const first = d.folders?.[0]
  const f = first != null && folders ? folders.find((x) => x.id === first) : null
  return f ? `${name} / ${f.name}` : name
}

const same = (a, b) => a.library === b.library && JSON.stringify(a.folders) === JSON.stringify(b.folders) && JSON.stringify(a.tags) === JSON.stringify(b.tags)

/**
 * The destination state after one was used: last, recents (16), per-library, per-site (200) and recent tags.
 * @param {any} state
 * @param {Destination} used
 * @param {string} [host]
 */
export function remember(state, used, host = '') {
  const clean = { library: used.library, folders: used.folders || [], tags: used.tags || [] }
  const recents = [clean, ...(state.recents || []).filter((r) => !same(r, clean))].slice(0, 16)
  const perLibrary = { ...(state.perLibrary || {}), [clean.library]: { folders: clean.folders, tags: clean.tags } }
  let perSite = state.perSite || {}
  const s = siteOf(host)
  if (s) {
    const { [s]: prev, ...rest } = perSite
    const next = { ...(prev || {}), [clean.library]: clean.folders }
    perSite = Object.fromEntries([...Object.entries(rest), [s, next]].slice(-200))
  }
  const recentTags = [...new Set([...clean.tags, ...(state.recentTags || [])])].slice(0, 30)
  return { ...state, last: clean, recents, perLibrary, perSite, recentTags }
}
