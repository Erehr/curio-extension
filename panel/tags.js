// @ts-check
// Tags as the Inspector shows them, and the window's tag picker: groups beside Starred, Recently, Recommended and each group's tags.
import { icon } from './icons.js'

/** The library's tag names in the order completion offers them. */
export function suggestions(tags) {
  return [...tags].sort((a, b) => Number(b.starred) - Number(a.starred) || b.count - a.count || a.name.localeCompare(b.name)).map((t) => t.name)
}

/** Adds names from text (commas make several) to the list, case-insensitively once each. */
export function add(list, text) {
  const out = [...list]
  for (const t of String(text).split(',').map((s) => s.trim()).filter(Boolean)) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t.slice(0, 100))
  return out
}

/** Colour of each tag: its own, else its group's. */
export function colors(tags, groups) {
  const byGroup = new Map(groups.map((g) => [g.id, g.color]))
  return new Map(tags.map((t) => [t.name.toLowerCase(), t.color || (t.groupId != null ? byGroup.get(t.groupId) : null) || '']).filter(([, c]) => c))
}

const STOP = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mp3', 'copy', 'www', 'com', 'http', 'https'])

/** Words of the name and the page's title that aren't tags yet, as the window recommends them: a known tag keeps its own spelling. */
export function recommended(text, tags, chosen, max = 8) {
  const has = new Set(chosen.map((t) => t.toLowerCase()))
  const known = new Map(tags.map((t) => [t.name.toLowerCase(), t]))
  const seen = new Set()
  const out = []
  for (const w of String(text).replace(/\.[a-z0-9]{2,5}\b/gi, ' ').split(/[^\p{L}\p{N}]+/u)) {
    const low = w.toLowerCase()
    if (w.length < 2 || /^\d+$/.test(w) || STOP.has(low) || seen.has(low) || has.has(low)) continue
    seen.add(low)
    const t = known.get(low)
    out.push({ name: t?.name || w[0].toUpperCase() + w.slice(1), count: t?.count, tag: t || null })
    if (out.length >= max) break
  }
  return out
}

/**
 * The picker's sections for the chosen group and the typed words: matches alone while typing, else Starred, Recently, Recommended, each group, the rest.
 * @param {{ tags: any[], groups: any[], group: number | 'none' | null, q: string, recent: string[], recommended: any[] }} p
 */
export function sections(p) {
  const term = p.q.trim().toLowerCase()
  const inGroup = (t) => p.group == null || (p.group === 'none' ? !t.groupIds?.length : t.groupIds?.includes(p.group))
  const pool = p.tags.filter(inGroup)
  const groupOf = new Map(p.groups.map((g) => [g.id, g]))
  const colour = (t) => t.color || groupOf.get(t.groupId ?? t.groupIds?.[0])?.color || null
  const row = (t, kind) => ({ name: t.name, count: t.count, star: t.starred, color: colour(t), kind })
  if (term) {
    const rank = (t) => (t.name.toLowerCase().startsWith(term) ? 0 : 1)
    const hits = pool.filter((t) => t.name.toLowerCase().includes(term)).sort((a, b) => rank(a) - rank(b) || b.count - a.count)
    return [{ id: 'results', name: null, rows: hits.slice(0, 300).map((t) => row(t, 'tag')) }]
  }
  const used = new Set()
  const take = (list) => list.filter((t) => !used.has(t.name) && used.add(t.name))
  const out = []
  const starred = take(pool.filter((t) => t.starred))
  if (starred.length) out.push({ id: 'starred', name: 'Starred', rows: starred.map((t) => row(t, 'star')) })
  const byName = new Map(pool.map((t) => [t.name.toLowerCase(), t]))
  const recent = take(p.recent.map((n) => byName.get(n.toLowerCase())).filter(Boolean).slice(0, 10))
  if (recent.length) out.push({ id: 'recent', name: 'Recently', rows: recent.map((t) => row(t, 'recent')) })
  if (p.group == null && p.recommended.length) out.push({ id: 'recommended', name: 'Recommended', rows: p.recommended.map((r) => ({ name: r.name, count: r.count, color: r.tag ? colour(r.tag) : null, kind: 'suggest' })) })
  for (const g of p.groups) {
    if (p.group != null && p.group !== g.id) continue
    const list = take(pool.filter((t) => (t.groupId ?? t.groupIds?.[0]) === g.id || (p.group === g.id && t.groupIds?.includes(g.id))))
    if (list.length) out.push({ id: 'g' + g.id, name: p.group === g.id ? null : g.name, color: g.color, rows: list.map((t) => row(t, 'tag')) })
  }
  const rest = take([...pool].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)))
  if (rest.length) out.push({ id: 'others', name: out.length && p.group !== 'none' ? (p.groups.length ? 'Uncategorized' : 'Others') : null, rows: rest.slice(0, 500).map((t) => row(t, 'tag')) })
  return out
}

/** The group list beside the tags: All, each group, Uncategorized. */
export function groupRows(tags, groups) {
  const count = (id) => tags.filter((t) => (id === 'none' ? !t.groupIds?.length : id == null ? true : t.groupIds?.includes(id))).length
  return [{ id: null, name: 'All', icon: 'bookmark-filled', count: tags.length }, ...groups.map((g) => ({ id: g.id, name: g.name, color: g.color, icon: 'bookmark', count: count(g.id) })), { id: 'none', name: 'Uncategorized', icon: 'question-mark', count: count('none') }]
}

/**
 * Draws the tag pills before the field, tinted by the tag's colour where it has one.
 * @param {HTMLElement} box
 * @param {HTMLInputElement} input
 * @param {string[]} list
 * @param {Map<string, string>} colors
 * @param {(i: number) => void} onRemove
 */
export function render(box, input, list, colors, onRemove) {
  const chips = list.map((t, i) => {
    const chip = document.createElement('span')
    chip.className = 'chip'
    const c = colors.get(t.toLowerCase())
    if (c) chip.style.background = `color-mix(in srgb, ${c} 18%, transparent)`
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'chip-x'
    x.title = 'Remove'
    x.setAttribute('aria-label', 'Remove ' + t)
    x.append(icon('x', 10))
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      onRemove(i)
    })
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = t
    chip.title = t
    chip.append(label, x)
    chip.addEventListener('auxclick', (e) => e.button === 1 && onRemove(i))
    return chip
  })
  const keep = box.querySelector('#keepTags')
  box.replaceChildren(...chips, input, ...(keep ? [keep] : []))
}

/**
 * Draws the picker: the groups, then the sections; a click on a row adds the tag or takes it away.
 * @param {{ side: HTMLElement, list: HTMLElement, groups: any[], group: any, sections: any[], chosen: string[], active: number, reveal: boolean, create: string, folded: Set<string>, onGroup: (id: any) => void, onPick: (name: string) => void, onFold: (id: string) => void, onPoint: (i: number) => void }} p
 */
export function renderPicker(p) {
  p.side.hidden = p.groups.length <= 2
  p.side.replaceChildren(...p.groups.map((g) => {
    const r = document.createElement('div')
    r.className = 'p-side-row' + (p.group === g.id ? ' on' : '')
    const ic = icon(g.icon, g.color ? 15 : 13)
    if (g.color) ic.style.color = g.color
    else ic.classList.add('faint')
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = g.name
    const count = document.createElement('span')
    count.className = 'count'
    count.textContent = String(g.count)
    r.append(ic, name, count)
    r.addEventListener('mousedown', (e) => e.preventDefault())
    r.addEventListener('click', () => p.onGroup(g.id))
    return r
  }))
  const has = new Set(p.chosen.map((t) => t.toLowerCase()))
  let n = -1
  const out = []
  const rowEl = (name, build, pick) => {
    const i = ++n
    const r = document.createElement('div')
    r.className = 'p-row' + (i === p.active ? ' act' : '')
    r.dataset.i = String(i)
    r.dataset.name = name
    build(r)
    r.addEventListener('pointerenter', () => p.onPoint(i))
    r.addEventListener('mousedown', (e) => e.preventDefault())
    r.addEventListener('click', pick)
    return r
  }
  if (p.create) {
    out.push(rowEl(p.create, (r) => {
      r.classList.add('create')
      const b = document.createElement('b')
      b.textContent = p.create
      const name = document.createElement('span')
      name.className = 'name'
      name.append('Add "', b, '"')
      r.append(icon('plus', 14), name)
    }, () => p.onPick(p.create)))
  }
  for (const [si, s] of p.sections.entries()) {
    if (si > 0 || p.create) out.push(document.createElement('hr'))
    if (s.name) {
      const h = document.createElement('div')
      h.className = 'p-group'
      if (s.color) {
        const d = document.createElement('span')
        d.className = 'dot'
        d.style.background = s.color
        h.append(d)
      }
      const t = document.createElement('span')
      t.className = 'grow'
      t.textContent = `${s.name} (${s.rows.length})`
      h.append(t, icon(p.folded.has(s.id) ? 'chevron-right' : 'chevron-down', 12))
      h.addEventListener('mousedown', (e) => e.preventDefault())
      h.addEventListener('click', () => p.onFold(s.id))
      out.push(h)
    }
    if (p.folded.has(s.id)) continue
    for (const t of s.rows) {
      out.push(rowEl(t.name, (r) => {
        const mark = (name, size, cls) => {
          const ic = icon(name, size)
          ic.classList.add(cls)
          r.append(ic)
        }
        if (has.has(t.name.toLowerCase())) mark('check', 14, 'tick')
        else if (t.kind === 'suggest') mark('sparkles', 13, 'faint')
        else if (t.star) mark('star-filled', 13, 'starred')
        else if (t.kind === 'recent') {
          const c = icon('clock', 13)
          c.style.color = t.color || 'var(--text-faint)'
          r.append(c)
        } else {
          const d = document.createElement('span')
          d.className = 'dot'
          d.style.background = t.color || 'var(--text-faint)'
          r.append(d)
        }
        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = t.name
        r.append(name)
        if (t.count != null) {
          const c = document.createElement('span')
          c.className = 'tcount'
          c.textContent = `(${t.count})`
          r.append(c)
        }
      }, () => p.onPick(t.name)))
    }
  }
  if (!out.length) {
    const e = document.createElement('div')
    e.className = 'p-empty'
    e.textContent = 'No tags yet: type one.'
    out.push(e)
  }
  p.list.replaceChildren(...out)
  if (p.reveal) p.list.querySelector('.p-row.act')?.scrollIntoView({ block: 'nearest' })
}

/** The names of the picker's rows in order, as the keyboard walks them. */
export const order = (box) => [...box.querySelectorAll('.p-row')].map((r) => /** @type {HTMLElement} */ (r).dataset.name || '')
