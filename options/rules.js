// @ts-check
// Options › Site rules: one row per rule, opened to edit when it applies and what it does. Changes save themselves.
import * as store from '../lib/store.js'
import * as R from '../lib/rules.js'
import * as Folders from '../panel/folders.js'
import * as Tags from '../panel/tags.js'
import { folderPath, libraryKey } from '../lib/destinations.js'
import { icon } from '../panel/icons.js'

/** @type {R.Rule[]} */
let rules = []
let libs = /** @type {any[]} */ ([])
const open = new Set()
/** @type {Record<string, { folders: any[], tags: any[], tagGroups: any[] }>} */
const lists = {}
let box = /** @type {HTMLElement} */ (document.body)
/** @type {(library: string) => Promise<any> | null} */
let fetchLists = () => null
let timer = 0

const el = (tag, cls = '', text = null) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function iconButton(name, title, onClick, disabled = false, cls = 'icon') {
  const b = el('button', cls)
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  b.append(icon(name, 15))
  b.disabled = disabled
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}

/** @param {[string, string][]} options */
function select(options, value, onChange, label = '') {
  const s = /** @type {HTMLSelectElement} */ (el('select'))
  for (const [v, text] of options) s.append(new Option(text, v, false, v === value))
  if (label) s.setAttribute('aria-label', label)
  s.addEventListener('change', () => onChange(s.value))
  return s
}

function checkbox(text, on, onChange) {
  const l = el('label', 'check')
  const c = /** @type {HTMLInputElement} */ (el('input'))
  c.type = 'checkbox'
  c.checked = on
  c.addEventListener('change', () => onChange(c.checked))
  l.append(c, ' ' + text)
  return l
}

const save = () => {
  clearTimeout(timer)
  timer = setTimeout(() => store.setDest({ rules }), 300)
}
/** Saves, then draws every row again, or only the rows' headings while a field is typed in. */
function changed(all = true) {
  save()
  if (all) draw()
  else for (const r of rules) heads.get(r.id)?.()
}

/** The library's folders and tags as last fetched, then fresh from Curio where it answers. */
async function listsOf(library) {
  if (!library) return { folders: [], tags: [], tagGroups: [] }
  if (!lists[library]) {
    const c = await store.lists(library)
    lists[library] = { folders: c?.folders || [], tags: c?.tags || [], tagGroups: c?.tagGroups || [] }
    Promise.resolve(fetchLists(library)).then((got) => {
      if (!got) return
      lists[library] = got
      if (!pop) draw()
    }, () => {})
  }
  return lists[library]
}
const known = (library) => (library && lists[library]) || { folders: [], tags: [], tagGroups: [] }

const libName = (key) => libs.find((l) => libraryKey(l) === key)?.name || key

function conditionText(c) {
  const f = R.FIELDS.find((x) => x[0] === c.field)
  const op = R.opsFor(c.field).find((o) => o[0] === c.op)?.[1] || c.op
  const value = c.field === 'kind' ? R.KINDS.find((k) => k[0] === c.value)?.[1] || c.value : c.value
  return `${f?.[1] || c.field} ${op} ${value || '(empty)'}`
}

function summary(r) {
  const parts = []
  if (r.library) {
    const names = r.folders.map((id) => folderPath(known(r.library).folders, id)).filter(Boolean)
    parts.push([libName(r.library), ...names.slice(0, 1)].join(' / ') + (names.length > 1 ? ` +${names.length - 1}` : ''))
  }
  if (r.tags.length) parts.push(r.tags.length === 1 ? r.tags[0] : `${r.tags.length} tags`)
  if (r.tagsFrom) parts.push('tag selector')
  if (r.fileFrom) parts.push('file selector')
  if (r.follow) parts.push('page destination')
  if (r.ask) parts.push('opens panel')
  if (r.stop) parts.push('stops')
  return parts.join(' · ') || 'No actions'
}

const heads = new Map()

function card(r, i) {
  const c = el('div', 'rule' + (r.enabled ? '' : ' off') + (open.has(r.id) ? ' open' : ''))
  c.dataset.id = r.id
  const head = el('div', 'rule-head')
  const fill = () => {
    const chev = icon('chevron-right', 15)
    chev.classList.add('rule-chev')
    const text = el('div', 'rule-text')
    text.append(el('div', 'rule-title', r.name || r.conditions.map(conditionText).join(r.matching === 'any' ? ' or ' : ' and ')), el('div', 'rule-sum', summary(r)))
    const on = /** @type {HTMLInputElement} */ (el('input', 'switch'))
    on.type = 'checkbox'
    on.checked = r.enabled
    on.title = r.enabled ? 'On' : 'Off'
    on.setAttribute('aria-label', 'On')
    on.addEventListener('click', (e) => e.stopPropagation())
    on.addEventListener('change', () => {
      r.enabled = on.checked
      changed()
    })
    head.replaceChildren(chev, text,
      iconButton('arrow-up', 'Up', () => move(i, -1), i === 0),
      iconButton('arrow-down', 'Down', () => move(i, 1), i === rules.length - 1),
      iconButton('trash', 'Remove', () => {
        rules.splice(i, 1)
        changed()
      }),
      on)
  }
  fill()
  heads.set(r.id, fill)
  head.addEventListener('click', () => {
    if (open.has(r.id)) open.delete(r.id)
    else open.add(r.id)
    draw()
  })
  c.append(head)
  if (open.has(r.id)) c.append(body(r))
  return c
}

function move(i, d) {
  const j = i + d
  if (j < 0 || j >= rules.length) return
  ;[rules[i], rules[j]] = [rules[j], rules[i]]
  changed()
}

function selectorInput(value, placeholder, title, onInput) {
  const input = /** @type {HTMLInputElement} */ (el('input', 'mono'))
  input.placeholder = placeholder
  input.spellcheck = false
  input.value = value
  input.title = title
  const bad = () => {
    try {
      if (input.value.trim()) document.createDocumentFragment().querySelector(input.value)
      return false
    } catch {
      return true
    }
  }
  input.classList.toggle('bad', bad())
  input.addEventListener('input', () => {
    onInput(input.value.trim())
    input.classList.toggle('bad', bad())
    changed(false)
  })
  return input
}

function body(r) {
  const b = el('div', 'rule-body')
  const nameField = el('div', 'rule-field')
  const name = /** @type {HTMLInputElement} */ (el('input'))
  name.placeholder = 'Optional rule name'
  name.maxLength = 60
  name.value = r.name
  name.addEventListener('input', () => {
    r.name = name.value
    changed(false)
  })
  nameField.append(el('span', 'rule-field-label', 'Rule name'), name)
  b.append(nameField)

  const whenBlock = el('div', 'rule-block')
  const whenHead = el('div', 'rule-block-head')
  const match = el('div', 'rule-match')
  match.append('When ', select([['all', 'all'], ['any', 'any']], r.matching, (v) => {
    r.matching = v === 'any' ? 'any' : 'all'
    changed()
  }, 'All or any'), ' conditions match')
  whenHead.append(match)
  const whenBody = el('div', 'rule-block-body')
  for (const [k, cond] of r.conditions.entries()) whenBody.append(conditionLine(r, cond, k))
  whenBlock.append(whenHead, whenBody)
  b.append(whenBlock)

  const thenBlock = el('div', 'rule-block')
  const thenHead = el('div', 'rule-block-head')
  thenHead.append(el('span', 'rule-block-title', 'Then'))
  const thenBody = el('div', 'rule-block-body')
  const grid = el('div', 'grid')
  const libs2 = /** @type {[string, string][]} */ ([['', 'Default'], ...libs.map((l) => /** @type {[string, string]} */ ([libraryKey(l), l.name]))])
  if (r.library && !libs.some((l) => libraryKey(l) === r.library)) libs2.push([r.library, r.library + ' (not listed)'])
  grid.append(el('label', '', 'Library'), select(libs2, r.library || '', (v) => {
    r.library = v || null
    r.folders = []
    if (r.library) listsOf(r.library)
    changed()
  }, 'Library'))
  grid.append(el('label', '', 'Folders'), folderField(r))
  grid.append(el('label', '', 'Tags'), tagField(r))
  grid.append(el('label', '', 'Tag selector'), selectorInput(r.tagsFrom, 'CSS selector, e.g. .tags a', 'Matched text becomes tags (max 30)', (v) => (r.tagsFrom = v)))
  grid.append(el('label', '', 'File selector'), selectorInput(r.fileFrom, 'CSS selector, e.g. img.main, a.original', 'Element to send from menu or shortcut (not drag)', (v) => (r.fileFrom = v)))
  thenBody.append(grid)
  thenBlock.append(thenHead, thenBody)
  b.append(thenBlock)

  const flags = el('div', 'rule-flags')
  flags.append(
    checkbox('Use page destination', r.follow, (v) => ((r.follow = v), changed(false))),
    checkbox('Open panel', r.ask, (v) => ((r.ask = v), changed(false))),
    checkbox('Stop processing rules', r.stop, (v) => ((r.stop = v), changed(false))),
  )
  b.append(flags)
  return b
}

function conditionLine(r, cond, k) {
  const line = el('div', 'line')
  const field = select(/** @type {any} */ (R.FIELDS.map((f) => [f[0], f[1]])), cond.field, (v) => {
    const was = R.fieldType(cond.field)
    cond.field = v
    cond.op = R.opsFor(v)[0][0]
    if (R.fieldType(v) !== was) cond.value = v === 'kind' ? 'image' : ''
    changed()
  }, 'Field')
  field.classList.add('f1')
  const op = select(/** @type {any} */ (R.opsFor(cond.field)), cond.op, (v) => {
    cond.op = v
    changed(false)
  }, 'Operator')
  op.classList.add('f2')
  let value
  if (cond.field === 'kind') value = select(/** @type {any} */ (R.KINDS), cond.value, (v) => ((cond.value = v), changed(false)), 'Value')
  else {
    const input = /** @type {HTMLInputElement} */ (el('input'))
    input.value = cond.value
    input.spellcheck = false
    input.placeholder = cond.field === 'site' ? 'example.com, other.org' : cond.field === 'type' ? 'jpg' : ''
    input.setAttribute('aria-label', 'Value')
    const mark = () => input.classList.toggle('bad', R.regexBad(cond))
    mark()
    input.addEventListener('input', () => {
      cond.value = input.value
      mark()
      changed(false)
    })
    value = input
  }
  value.classList.add('grow')
  line.append(field, op, value,
    iconButton('minus', 'Remove condition', () => {
      r.conditions.splice(k, 1)
      changed()
    }, r.conditions.length < 2, 'step-btn'),
    iconButton('plus', 'Add condition', () => {
      r.conditions.splice(k + 1, 0, { field: cond.field, op: cond.op, value: cond.field === 'kind' ? 'image' : '' })
      changed()
    }, false, 'step-btn'))
  return line
}

// ---- the folder and tag pickers ----

let pop = /** @type {HTMLElement | null} */ (null)
let popClosed = () => {}
function closePop() {
  if (!pop) return
  pop.remove()
  pop = null
  popClosed()
}
function popAt(anchor, width, height, onClose) {
  const a = anchor.getBoundingClientRect()
  closePop()
  const p = el('div', 'pop')
  const below = innerHeight - a.bottom - 8
  const h = Math.min(height, Math.max(below, a.top - 8))
  p.style.position = 'fixed'
  p.style.width = Math.min(width, innerWidth - 16) + 'px'
  p.style.height = h + 'px'
  p.style.left = Math.max(8, Math.min(a.left, innerWidth - width - 8)) + 'px'
  p.style.top = (below >= Math.min(height, a.top - 8) ? a.bottom + 4 : a.top - h - 4) + 'px'
  document.body.append(p)
  pop = p
  popClosed = onClose
  return p
}
addEventListener('mousedown', (e) => {
  if (pop && !pop.contains(/** @type {Node} */ (e.target)) && !(/** @type {HTMLElement} */ (e.target)).closest?.('.opens-pop')) closePop()
}, true)
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pop) {
    e.preventDefault()
    closePop()
  }
})
addEventListener('scroll', closePop)

function folderField(r) {
  const field = el('div', 'pickbox opens-pop' + (r.library ? '' : ' disabled'))
  field.tabIndex = r.library ? 0 : -1
  field.setAttribute('role', 'button')
  field.setAttribute('aria-label', 'Folders')
  let repaintPicker = () => {}
  const renderChips = () => {
    field.replaceChildren()
    if (!r.library) {
      field.append(el('span', 'faint', 'Select a library first'))
      return
    }
    const all = known(r.library).folders
    const names = r.folders.map((id) => all.find((f) => f.id === id)).filter(Boolean)
    if (!names.length) {
      field.append(el('span', 'faint', 'Choose folders'))
      return
    }
    for (const f of names) {
      const chip = el('span', 'chip', f.name)
      chip.title = folderPath(all, f.id)
      const x = el('button', 'chip-x')
      x.type = 'button'
      x.setAttribute('aria-label', `Remove ${f.name}`)
      x.append(icon('x', 10))
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        r.folders = r.folders.filter((id) => id !== f.id)
        save()
        renderChips()
        heads.get(r.id)?.()
        repaintPicker()
      })
      chip.append(x)
      field.append(chip)
    }
  }
  const openFolders = () => {
    if (!r.library) return
    if (pop?.dataset.folderRule === r.id) return closePop()
    pickFolders(field, r, renderChips, (fn) => (repaintPicker = fn))
  }
  field.addEventListener('click', openFolders)
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openFolders()
    }
  })
  renderChips()
  return field
}

async function pickFolders(anchor, r, onChanged, bindPaint) {
  const got = await listsOf(r.library)
  const p = popAt(anchor, 380, 360, () => {
    bindPaint(() => {})
    onChanged()
    heads.get(r.id)?.()
  })
  p.dataset.folderRule = r.id
  const head = el('div', 'p-head')
  const filter = /** @type {HTMLInputElement} */ (el('input'))
  filter.placeholder = 'Filter folders'
  filter.spellcheck = false
  head.append(icon('search', 16), filter)
  const list = el('div', 'p-list')
  const collapsed = new Set()
  const paint = () => {
    if (!pop || pop !== p) return
    const folders = known(r.library).folders.length ? known(r.library).folders : got.folders
    Folders.render(list, {
      list: Folders.view({ folders, chosen: r.folders, recent: [], filter: filter.value, tab: 'all', collapsed, canCreate: false }),
      chosen: r.folders,
      active: -1,
      reveal: false,
      collapsed,
      empty: filter.value.trim() ? 'No match' : 'No folders',
      onPoint: (i) => {
        for (const x of list.querySelectorAll('.p-row')) x.classList.toggle('act', /** @type {HTMLElement} */ (x).dataset.i === String(i))
      },
      onToggle: (id) => {
        r.folders = r.folders.includes(id) ? r.folders.filter((x) => x !== id) : [...r.folders, id]
        save()
        onChanged()
        heads.get(r.id)?.()
        paint()
      },
      onCreate: () => {},
      onCollapse: (id) => {
        if (collapsed.has(id)) collapsed.delete(id)
        else collapsed.add(id)
        paint()
      },
    })
  }
  bindPaint(paint)
  filter.addEventListener('input', paint)
  p.append(head, list)
  paint()
  filter.focus()
}

function tagField(r) {
  const tagbox = el('div', 'tagbox opens-pop')
  const input = /** @type {HTMLInputElement} */ (el('input'))
  input.placeholder = 'Add a tag'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-label', 'Tags')
  const lib = () => r.library || null
  const colors = () => Tags.colors(known(lib()).tags, known(lib()).tagGroups)
  const chips = () => Tags.render(tagbox, input, r.tags, colors(), (i) => {
    r.tags = r.tags.filter((_, j) => j !== i)
    after()
  })
  let paint = () => {}
  const after = () => {
    chips()
    paint()
    save()
    heads.get(r.id)?.()
    input.focus()
  }
  const add = (text) => {
    if (!text.trim()) return
    r.tags = Tags.add(r.tags, text)
    input.value = ''
    after()
  }
  const toggle = (name) => {
    const has = r.tags.some((t) => t.toLowerCase() === name.toLowerCase())
    r.tags = has ? r.tags.filter((t) => t.toLowerCase() !== name.toLowerCase()) : Tags.add(r.tags, name)
    input.value = ''
    after()
  }
  const openPicker = async () => {
    if (pop?.dataset.rule === r.id) return paint()
    const got = await listsOf(lib())
    const p = popAt(tagbox, 440, 320, () => {})
    p.dataset.rule = r.id
    const body = el('div', 'p-body')
    const side = el('div', 'p-side')
    const list = el('div', 'p-list')
    body.append(side, list)
    p.append(body)
    let group = /** @type {any} */ (null)
    const folded = new Set()
    paint = () => {
      if (!pop || pop !== p) return
      const tags = known(lib()).tags.length ? known(lib()) : got
      const term = input.value.trim()
      Tags.renderPicker({
        side, list,
        groups: Tags.groupRows(tags.tags, tags.tagGroups),
        group,
        sections: Tags.sections({ tags: tags.tags, groups: tags.tagGroups, group, q: input.value, recent: [], recommended: [] }),
        chosen: r.tags,
        active: -1,
        reveal: false,
        create: term && !tags.tags.some((t) => t.name.toLowerCase() === term.toLowerCase()) && !r.tags.some((t) => t.toLowerCase() === term.toLowerCase()) ? term : '',
        folded,
        onGroup: (id) => ((group = id), paint()),
        onPick: toggle,
        onFold: (id) => (folded.has(id) ? folded.delete(id) : folded.add(id), paint()),
        onPoint: () => {},
      })
    }
    paint()
  }
  tagbox.addEventListener('click', () => input.focus())
  input.addEventListener('focus', openPicker)
  input.addEventListener('input', openPicker)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === ',' && input.value.trim())) {
      e.preventDefault()
      add(input.value)
    } else if (e.key === 'Backspace' && !input.value && r.tags.length) {
      r.tags = r.tags.slice(0, -1)
      after()
    }
  })
  chips()
  return tagbox
}

// ----

function draw() {
  heads.clear()
  const scroll = scrollY
  box.replaceChildren(...rules.map(card))
  if (!rules.length) box.append(el('p', 'note', 'No rules.'))
  scrollTo(0, scroll)
}

/** A new rule, open, for the site given. */
export function add(site = '') {
  const r = R.blank(site)
  rules.push(r)
  open.add(r.id)
  changed()
}

/**
 * @param {HTMLElement} into
 * @param {{ fetchLists: (library: string) => Promise<any> | null }} p
 */
export async function mount(into, p) {
  box = into
  fetchLists = p.fetchLists
  libs = (await store.libraries())?.list || []
  rules = ((await store.dest()).rules || []).map(R.clean)
  await Promise.all([...new Set(rules.map((r) => r.library).filter(Boolean))].map(listsOf))
  draw()
}

/** Rules changed in another page, such as the note's Follow: taken again unless a row is being typed in. */
export async function reload() {
  if (box.contains(document.activeElement) || pop) return
  libs = (await store.libraries())?.list || []
  rules = ((await store.dest()).rules || []).map(R.clean)
  draw()
}
