// @ts-check
// The panel's rating and the library's choice fields: single and multi select fields with fixed options.
import { icon } from './icons.js'

/** The fields the panel offers: a choice from a fixed list, shown in the library. */
export function choiceFields(fields) {
  return (fields || []).filter((f) => (f.type === 'single_select' || f.type === 'multi_select') && Array.isArray(f.options) && f.options.length && f.visible !== false)
}

/** The library's own fields, shown at once, and those a plugin owns, behind More fields. */
export function split(fields) {
  const all = choiceFields(fields)
  return { own: all.filter((f) => !f.owner || f.owner === 'user'), more: all.filter((f) => f.owner && f.owner !== 'user') }
}

/** A field's value as the panel holds it: text for one choice, a list for several, nothing for none. */
export function held(field, value) {
  if (field.type === 'multi_select') {
    const list = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',').map((x) => x.trim()) : []
    return list.filter((x) => typeof x === 'string' && field.options.includes(x))
  }
  const one = Array.isArray(value) ? value[0] : value
  return typeof one === 'string' && field.options.includes(one) ? one : ''
}

const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length)
const same = (a, b) => JSON.stringify(empty(a) ? null : a) === JSON.stringify(empty(b) ? null : b)

/** The choice fields that changed from `before` to `after`, a cleared one as null. */
export function patch(fields, before, after) {
  const out = {}
  for (const f of fields) {
    const was = held(f, before?.[f.key])
    const now = held(f, after?.[f.key])
    if (!same(was, now)) out[f.key] = empty(now) ? null : now
  }
  return out
}

/** The values to send with a new item: only those set. */
export function filled(fields, values) {
  const out = {}
  for (const f of fields) {
    const v = held(f, values?.[f.key])
    if (!empty(v)) out[f.key] = v
  }
  return out
}

/** Draws the stars; a click on the one already set clears the rating. */
export function renderRating(box, rating, onPick) {
  box.replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'star' + (n <= rating ? ' on' : '')
    b.append(icon(n <= rating ? 'star-filled' : 'star', 16))
    b.title = `${n}`
    b.setAttribute('aria-label', `${n}`)
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(n === rating))
    b.addEventListener('click', () => onPick(n === rating ? 0 : n))
    return b
  }))
}

/** Draws the Favorite and Explicit toggle buttons beside the rating stars. */
export function renderFlags(box, { favorite, explicit }, onToggle) {
  const fav = document.createElement('button')
  fav.type = 'button'
  fav.className = 'icon flag-btn' + (favorite ? ' fav' : '')
  fav.title = 'Favorite'
  fav.setAttribute('aria-label', 'Favorite')
  fav.setAttribute('aria-pressed', String(!!favorite))
  fav.append(icon(favorite ? 'heart-filled' : 'heart', 16))
  fav.addEventListener('click', () => onToggle('favorite', !favorite))

  const exp = document.createElement('button')
  exp.type = 'button'
  exp.className = 'icon flag-btn' + (explicit ? ' exp' : '')
  exp.title = 'Explicit'
  exp.setAttribute('aria-label', 'Explicit')
  exp.setAttribute('aria-pressed', String(!!explicit))
  exp.append(icon('shield-exclamation', 16))
  exp.addEventListener('click', () => onToggle('explicit', !explicit))

  box.replaceChildren(fav, exp)
}

/** Draws a select for each single choice field and chips for each multiple one. */
export function renderFields(box, fields, values, onChange) {
  box.replaceChildren(...fields.map((f) => {
    const wrap = document.createElement('div')
    wrap.className = 'field'
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = f.label || f.key
    wrap.append(label)
    const v = held(f, values[f.key])
    if (f.type === 'single_select') {
      const s = document.createElement('select')
      s.dataset.key = f.key
      s.append(new Option('', ''), ...f.options.map((o) => new Option(o, o, false, o === v)))
      s.value = /** @type {string} */ (v)
      s.addEventListener('change', () => onChange(f.key, s.value))
      wrap.append(s)
    } else {
      const chips = document.createElement('div')
      chips.className = 'chips'
      chips.dataset.key = f.key
      for (const o of f.options) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'chip' + (v.includes(o) ? ' on' : '')
        b.textContent = o
        b.addEventListener('click', () => onChange(f.key, v.includes(o) ? [...v].filter((x) => x !== o) : [...v, o]))
        chips.append(b)
      }
      wrap.append(chips)
    }
    return wrap
  }))
}
