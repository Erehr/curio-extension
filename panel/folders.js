// @ts-check
// The folder picker: recently used folders over the tree, a filter over names, each folder with its own icon and colour, several chosen with the first deciding where the file lives.
import { folderPath } from '../lib/destinations.js'
import { icon, has } from './icons.js'

/** Rows in display order: parents before children, pinned first at each level, then the library's own order; a collapsed folder hides its children. */
export function rows(folders, collapsed = new Set()) {
  const kids = new Map()
  for (const f of folders) {
    const k = f.parentId ?? 0
    if (!kids.has(k)) kids.set(k, [])
    kids.get(k).push(f)
  }
  const out = []
  const walk = (parent, depth, path) => {
    const list = (kids.get(parent) || []).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder)
    for (const f of list) {
      const full = path ? `${path} / ${f.name}` : f.name
      const has = (kids.get(f.id) || []).length > 0
      out.push({ f, depth, full, kids: has })
      if (!collapsed.has(f.id)) walk(f.id, depth + 1, full)
    }
  }
  walk(0, 0, '')
  return out
}

/** Rows whose whole path holds every word of the filter, those whose own name starts with it first. */
export function filtered(all, q) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return all
  const hits = all.filter((r) => words.every((w) => r.full.toLowerCase().includes(w)))
  const starts = (r) => (r.f.name.toLowerCase().startsWith(words[0]) ? 0 : 1)
  return hits.map((r, i) => [r, i]).sort((a, b) => starts(a[0]) - starts(b[0]) || a[1] - b[1]).map(([r]) => r)
}

export const TABS = [['all', 'list-details', 'All folders'], ['recent', 'clock', 'Recently used'], ['selected', 'copy-check', 'Selected']]

/**
 * The rows the picker shows for its tab and filter: a create row first when the name is new, a line between the recent folders and the tree.
 * With `all`, an All row comes first: the library itself, with no folder.
 * @param {{ folders: any[], chosen: number[], recent: number[], filter: string, tab: string, collapsed: Set<number>, canCreate: boolean, all?: boolean }} p
 */
export function view(p) {
  const term = p.filter.trim()
  const byId = new Map(p.folders.map((f) => [f.id, f]))
  const plain = (f, recent = false) => ({ f, depth: 0, full: folderPath(p.folders, f.id), kids: false, recent })
  /** @type {any[]} */ let list
  if (term) list = filtered(rows(p.folders), term).map((r) => ({ ...r, depth: 0, kids: false, flat: true }))
  else if (p.tab === 'selected') list = p.chosen.map((id) => byId.get(id)).filter(Boolean).map((f) => plain(f))
  else if (p.tab === 'recent') list = p.recent.map((id) => byId.get(id)).filter(Boolean).map((f) => plain(f, true))
  else {
    const top = p.recent.map((id) => byId.get(id)).filter(Boolean).slice(0, 6).map((f) => plain(f, true))
    const tree = rows(p.folders, p.collapsed)
    list = top.length && tree.length > top.length ? [...top, { sep: true }, ...tree] : tree
    if (p.all) list = [{ all: true }, ...list]
  }
  const create = term && p.canCreate && !p.folders.some((f) => f.name.toLowerCase() === term.toLowerCase()) ? [{ create: term }] : []
  return [...create, ...list]
}

/**
 * Draws the picker's list; `active` is the row the keyboard or pointer is on.
 * @param {HTMLElement} box
 * @param {{ list: any[], chosen: number[], active: number, reveal: boolean, empty: string, onToggle: (id: number) => void, onCreate: (name: string) => void, onCollapse: (id: number) => void, onPoint: (i: number) => void, collapsed: Set<number>, onAll?: () => void, allOn?: boolean }} p
 */
export function render(box, p) {
  if (!p.list.length) {
    const e = document.createElement('div')
    e.className = 'p-empty'
    e.textContent = p.empty
    return box.replaceChildren(e)
  }
  let n = -1
  box.replaceChildren(...p.list.slice(0, 2000).map((r) => {
    if (r.sep) return document.createElement('hr')
    const i = ++n
    const row = document.createElement('div')
    row.className = 'p-row' + (i === p.active ? ' act' : '')
    row.dataset.i = String(i)
    row.addEventListener('pointerenter', () => p.onPoint(i))
    if (r.create) {
      row.classList.add('create')
      const b = document.createElement('b')
      b.textContent = r.create
      const name = document.createElement('span')
      name.className = 'name'
      name.append('Create "', b, '"')
      row.append(icon('plus', 14), icon('folder', 14), name)
      row.addEventListener('click', () => p.onCreate(r.create))
      return row
    }
    if (r.all) {
      const on = p.allOn ?? !p.chosen.length
      row.classList.add('all')
      if (on) row.classList.add('on')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(on))
      row.dataset.all = '1'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = 'All'
      const ic = icon('bookmark-filled', 15)
      ic.classList.add('ficon')
      row.append(ic, name)
      if (on) row.append(tick())
      row.addEventListener('click', (e) => {
        e.preventDefault()
        p.onAll?.()
      })
      return row
    }
    const f = r.f
    const on = p.chosen.includes(f.id)
    if (on) row.classList.add('on')
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(on))
    row.dataset.id = String(f.id)
    row.style.paddingLeft = 7 + r.depth * 16 + 'px'
    row.title = r.full
    for (let d = 1; d <= r.depth; d++) {
      const g = document.createElement('span')
      g.className = 'guide'
      g.style.left = 14 + (d - 1) * 16 + 'px'
      row.append(g)
    }
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = f.name
    const ic = icon(has(f.icon) ? f.icon : 'folder', 15)
    ic.classList.add('ficon')
    if (f.color) ic.style.color = f.color
    row.append(ic, name)
    if (r.flat && f.parentId != null) {
      const parent = document.createElement('span')
      parent.className = 'parent'
      parent.textContent = r.full.slice(0, r.full.lastIndexOf(' / '))
      row.append(parent)
    }
    if (on) row.append(tick())
    if (r.kids) {
      const caret = document.createElement('button')
      caret.type = 'button'
      caret.className = 'icon caret'
      caret.tabIndex = -1
      caret.setAttribute('aria-label', p.collapsed.has(f.id) ? 'Expand' : 'Collapse')
      caret.append(icon(p.collapsed.has(f.id) ? 'chevron-right' : 'chevron-down', 13))
      caret.addEventListener('click', (e) => {
        e.stopPropagation()
        p.onCollapse(f.id)
      })
      row.append(caret)
    }
    row.addEventListener('click', (e) => {
      e.preventDefault()
      p.onToggle(f.id)
    })
    return row
  }))
  if (p.reveal) box.querySelector('.p-row.act')?.scrollIntoView({ block: 'nearest' })
}

function tick() {
  const t = icon('check', 14)
  t.classList.add('tick')
  return t
}

export { folderPath }
