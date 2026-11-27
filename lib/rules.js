// @ts-check
// Site rules: conditions on the page and what is saved, then where it goes and which tags it gets. No chrome.* API.
import { hostMatches } from './destinations.js'

/**
 * @typedef {{ field: string, op: string, value: string }} Condition
 * @typedef {{
 *   id: string, enabled: boolean, name: string, matching: 'all' | 'any', conditions: Condition[],
 *   library: string | null, folders: number[], tags: string[], tagsFrom: string, fileFrom: string, follow: boolean, ask: boolean, stop: boolean
 * }} Rule
 */

export const FIELDS = [
  ['site', 'Site', 'site'],
  ['page', 'Page URL', 'text'],
  ['title', 'Page title', 'text'],
  ['src', 'File URL', 'text'],
  ['type', 'Extension', 'text'],
  ['kind', 'Type', 'kind'],
  ['width', 'Width', 'num'],
  ['height', 'Height', 'num'],
]
export const TEXT_OPS = [['contains', 'contains'], ['notcontains', 'does not contain'], ['is', 'is'], ['isnot', 'is not'], ['startswith', 'starts with'], ['endswith', 'ends with'], ['regex', 'matches regex'], ['notregex', 'does not match regex']]
export const SITE_OPS = [['is', 'is'], ['isnot', 'is not']]
export const KIND_OPS = [['is', 'is'], ['isnot', 'is not']]
export const NUM_OPS = [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '=']]
export const KINDS = [['image', 'Image'], ['video', 'Video'], ['audio', 'Audio'], ['file', 'File'], ['link', 'Link'], ['page', 'Page']]

/** At most this many tags come from a page's selector. */
export const MAX_PAGE_TAGS = 30

export const fieldType = (id) => FIELDS.find((f) => f[0] === id)?.[2] || 'text'
export function opsFor(field) {
  const t = fieldType(field)
  return t === 'site' ? SITE_OPS : t === 'kind' ? KIND_OPS : t === 'num' ? NUM_OPS : TEXT_OPS
}

export const newId = () => Math.random().toString(36).slice(2, 10)

/** @returns {Rule} */
export function blank(site = '') {
  return { id: newId(), enabled: true, name: '', matching: 'all', conditions: [{ field: 'site', op: 'is', value: site }], library: null, folders: [], tags: [], tagsFrom: '', fileFrom: '', follow: false, ask: false, stop: false }
}

/** A rule as storage may hold it, with every field present and of its type. */
export function clean(r) {
  const b = blank()
  const value = (c) => (c.field === 'kind' && !KINDS.some((k) => k[0] === c.value) ? 'image' : String(c.value ?? ''))
  const conditions = Array.isArray(r?.conditions) ? r.conditions.filter((c) => c && FIELDS.some((f) => f[0] === c.field)).map((c) => ({ field: c.field, op: opsFor(c.field).some((o) => o[0] === c.op) ? c.op : opsFor(c.field)[0][0], value: value(c) })) : []
  return {
    id: typeof r?.id === 'string' && r.id ? r.id : b.id,
    enabled: r?.enabled !== false,
    name: String(r?.name || '').slice(0, 60),
    matching: r?.matching === 'any' ? 'any' : 'all',
    conditions: conditions.length ? conditions : b.conditions,
    library: typeof r?.library === 'string' && r.library ? r.library : null,
    folders: Array.isArray(r?.folders) ? r.folders.filter(Number.isInteger) : [],
    tags: Array.isArray(r?.tags) ? [...new Set(r.tags.map(String).map((t) => t.trim()).filter(Boolean))] : [],
    tagsFrom: String(r?.tagsFrom || '').trim(),
    fileFrom: String(r?.fileFrom || '').trim(),
    follow: !!r?.follow,
    ask: !!r?.ask,
    stop: !!r?.stop,
  }
}

/** What a rule looks at, from a draft and the page's host. */
export function subject(draft, host) {
  const src = String(draft?.src || draft?.link || '')
  let type = ''
  try {
    const m = new URL(src).pathname.match(/\.([a-z0-9]{1,8})$/i)
    if (m) type = m[1].toLowerCase()
  } catch {}
  const kind = draft?.kind === 'svg' || draft?.kind === 'canvas' ? 'image' : draft?.kind || 'page'
  return { site: String(host || ''), page: String(draft?.pageUrl || ''), title: String(draft?.pageTitle || ''), src, type, kind, width: draft?.size?.w ?? null, height: draft?.size?.h ?? null }
}

function regex(value) {
  const m = value.match(/^\/(.*)\/([a-z]*)$/)
  try {
    return m ? new RegExp(m[1], m[2].replace(/[^imsu]/g, '')) : new RegExp(value, 'i')
  } catch {
    return null
  }
}

/** Whether a regular expression a condition holds is one, for Options to mark. */
export const regexBad = (c) => (c.op === 'regex' || c.op === 'notregex') && !!c.value && !regex(c.value)

/** @param {Condition} c */
export function test(c, s) {
  const v = String(c.value || '').trim()
  if (!v) return false
  const t = fieldType(c.field)
  if (t === 'site') {
    const hit = hostMatches(s.site, v.split(/[\s,]+/).filter(Boolean).map((h) => h.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')))
    return c.op === 'isnot' ? !hit : hit
  }
  if (t === 'kind') return c.op === 'isnot' ? s.kind !== v : s.kind === v
  if (t === 'num') {
    const n = s[c.field]
    const w = Number(v)
    if (typeof n !== 'number' || !Number.isFinite(w)) return false
    return c.op === 'gt' ? n > w : c.op === 'gte' ? n >= w : c.op === 'lt' ? n < w : c.op === 'lte' ? n <= w : n === w
  }
  const have = String(s[c.field] || '').toLowerCase()
  const want = v.toLowerCase()
  switch (c.op) {
    case 'contains': return have.includes(want)
    case 'notcontains': return !have.includes(want)
    case 'is': return have === want
    case 'isnot': return have !== want
    case 'startswith': return have.startsWith(want)
    case 'endswith': return have.endsWith(want)
    case 'regex': return !!regex(v)?.test(String(s[c.field] || ''))
    case 'notregex': {
      const r = regex(v)
      return !!r && !r.test(String(s[c.field] || ''))
    }
  }
  return false
}

/** @param {Rule} r */
export const matches = (r, s) => (r.matching === 'any' ? r.conditions.some((c) => test(c, s)) : r.conditions.length > 0 && r.conditions.every((c) => test(c, s)))

/**
 * The rules that apply, top to bottom: a later rule with a library replaces the destination, tags add up, and a rule may stop the rest.
 * @param {Rule[]} rules
 * @returns {{ library: string | null, folders: number[], tags: string[], selectors: string[], fileFrom: string | null, follow: boolean, ask: boolean, names: string[] }}
 */
export function apply(rules, draft, host) {
  const s = subject(draft, host)
  const out = { library: /** @type {string | null} */ (null), folders: /** @type {number[]} */ ([]), tags: /** @type {string[]} */ ([]), selectors: /** @type {string[]} */ ([]), fileFrom: /** @type {string | null} */ (null), follow: false, ask: false, names: /** @type {string[]} */ ([]) }
  for (const raw of rules || []) {
    const r = clean(raw)
    if (!r.enabled || !matches(r, s)) continue
    out.names.push(r.name || r.id)
    if (r.library) {
      out.library = r.library
      out.folders = r.folders
    }
    out.tags = [...new Set([...out.tags, ...r.tags])]
    if (r.tagsFrom && !out.selectors.includes(r.tagsFrom)) out.selectors.push(r.tagsFrom)
    if (r.fileFrom) out.fileFrom = r.fileFrom
    out.follow ||= r.follow
    out.ask ||= r.ask
    if (r.stop) break
  }
  return out
}

const PAGE_FIELDS = new Set(['site', 'page', 'title'])

/** File selectors from rules matching this page, last matching rule first (highest priority), for menu/shortcut triggers before inspecting an element. */
export function fileSelectors(rules, pageDraft, host) {
  const s = subject({ kind: 'page', ...pageDraft }, host)
  const list = []
  for (const raw of rules || []) {
    const r = clean(raw)
    if (!r.enabled || !r.fileFrom) continue
    const pageConds = r.conditions.filter((c) => PAGE_FIELDS.has(c.field))
    if (!pageConds.length) continue
    const hit = r.matching === 'any' ? pageConds.some((c) => test(c, s)) : pageConds.every((c) => test(c, s))
    if (hit) list.unshift(r.fileFrom)
  }
  return [...new Set(list)]
}

/** The texts a page's selector found, as tags: trimmed, one line, no empties or repeats, at most 30. */
export function pageTags(texts) {
  const out = []
  for (const t of Array.isArray(texts) ? texts : []) {
    const tag = String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
    if (tag && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag)
    if (out.length >= MAX_PAGE_TAGS) break
  }
  return out
}

/**
 * Presets and the followed sites, as rules: a preset's sites become one condition, a preset with none stays off until it has some.
 * @param {{ presets?: any[] }} dest
 * @param {{ follow?: string[] }} settings
 * @returns {Rule[]}
 */
export function fromPresets(dest, settings) {
  const rules = []
  for (const p of dest.presets || []) {
    const sites = (p.sites || []).join(', ')
    rules.push(clean({ id: p.id, enabled: !!sites, name: p.name, conditions: [{ field: 'site', op: 'is', value: sites }], library: p.library, folders: p.folders, tags: p.tags }))
  }
  if (settings.follow?.length) rules.push(clean({ name: 'Follow pages', conditions: [{ field: 'site', op: 'is', value: settings.follow.join(', ') }], follow: true }))
  return rules
}
