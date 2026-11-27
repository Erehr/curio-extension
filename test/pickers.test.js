import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rows, filtered, view } from '../panel/folders.js'
import { sections, recommended, groupRows } from '../panel/tags.js'
import { split } from '../panel/choices.js'

const folders = [
  { id: 1, parentId: null, name: 'Concept art', sortOrder: 0, pinned: false, count: 3 },
  { id: 2, parentId: 1, name: 'Characters', sortOrder: 0, pinned: false, count: 2 },
  { id: 3, parentId: 1, name: 'Environments', sortOrder: 1, pinned: false, count: 1 },
  { id: 4, parentId: null, name: 'Photography', sortOrder: 1, pinned: false, count: 0 },
  { id: 5, parentId: null, name: 'Archive', sortOrder: 2, pinned: true, count: 0 },
]

test('the tree puts pinned folders first and hides a collapsed folder\'s children', () => {
  assert.deepEqual(rows(folders).map((r) => r.f.id), [5, 1, 2, 3, 4])
  assert.deepEqual(rows(folders, new Set([1])).map((r) => r.f.id), [5, 1, 4])
  assert.equal(rows(folders).find((r) => r.f.id === 1).kids, true)
})

test('the filter matches whole paths, names that start with it first', () => {
  assert.deepEqual(filtered(rows(folders), 'char').map((r) => r.f.id), [2])
  assert.deepEqual(filtered(rows(folders), 'art char').map((r) => r.f.id), [2])
  assert.deepEqual(filtered(rows(folders), 'c').map((r) => r.f.id), [1, 2, 5, 3])
})

test('the picker shows recent folders over the tree, and a create row for a new name', () => {
  const base = { folders, chosen: [3], recent: [4], filter: '', tab: 'all', collapsed: new Set(), canCreate: true }
  const all = view(base)
  assert.equal(all[0].f.id, 4)
  assert.equal(all[1].sep, true)
  assert.deepEqual(view({ ...base, tab: 'selected' }).map((r) => r.f.id), [3])
  assert.deepEqual(view({ ...base, tab: 'recent' }).map((r) => r.f.id), [4])
  assert.deepEqual(view({ ...base, filter: 'Sketches' }), [{ create: 'Sketches' }])
  assert.equal(view({ ...base, filter: 'characters' })[0].f.id, 2, 'a name the library has makes no create row')
  assert.deepEqual(view({ ...base, filter: 'Sketches', canCreate: false }), [])
  assert.deepEqual(view({ ...base, all: true })[0], { all: true }, 'All comes first')
  assert.equal(view({ ...base, all: true, filter: 'characters' }).some((r) => r.all), false, 'not among what a filter finds')
})

const tags = [
  { name: 'concept', count: 14, starred: true, groupId: 1, groupIds: [1], color: null },
  { name: 'landscape', count: 13, starred: false, groupId: 1, groupIds: [1], color: null },
  { name: 'city', count: 1, starred: false, groupId: null, groupIds: [], color: null },
  { name: 'dusk', count: 5, starred: false, groupId: 2, groupIds: [2], color: '#f00' },
]
const groups = [{ id: 1, name: 'Style', color: '#0a0' }, { id: 2, name: 'Mood', color: '#00a' }]

test('the tag picker lists Starred, Recently, Recommended, then each group and the rest, each tag once', () => {
  const s = sections({ tags, groups, group: null, q: '', recent: ['city', 'concept'], recommended: [{ name: 'Harbour' }] })
  assert.deepEqual(s.map((x) => x.name), ['Starred', 'Recently', 'Recommended', 'Style', 'Mood'])
  assert.deepEqual(s.flatMap((x) => x.rows).filter((r) => r.kind !== 'suggest').map((r) => r.name), ['concept', 'city', 'landscape', 'dusk'])
  assert.equal(s.find((x) => x.name === 'Style').rows[0].color, '#0a0', 'a tag takes its group\'s colour')
  assert.equal(s.find((x) => x.name === 'Mood').rows[0].color, '#f00', 'its own colour wins')
})

test('typing shows matches alone, names that start with it first', () => {
  const s = sections({ tags, groups, group: null, q: 'c', recent: [], recommended: [] })
  assert.equal(s.length, 1)
  assert.deepEqual(s[0].rows.map((r) => r.name), ['concept', 'city', 'landscape'])
})

test('a group shows its tags alone, and the group list counts them', () => {
  assert.deepEqual(sections({ tags, groups, group: 2, q: '', recent: [], recommended: [] }).flatMap((x) => x.rows).map((r) => r.name), ['dusk'])
  assert.deepEqual(sections({ tags, groups, group: 'none', q: '', recent: [], recommended: [] }).flatMap((x) => x.rows).map((r) => r.name), ['city'])
  assert.deepEqual(groupRows(tags, groups).map((g) => [g.name, g.count]), [['All', 4], ['Style', 2], ['Mood', 1], ['Uncategorized', 1]])
})

test('recommended tags are the name\'s words that aren\'t tags yet, in the library\'s spelling', () => {
  const r = recommended('Harbour at dusk.jpg Concept 2024', tags, ['dusk'])
  assert.deepEqual(r.map((x) => x.name), ['Harbour', 'concept'])
})

test('the library\'s own choice fields show at once, a plugin\'s behind More fields', () => {
  const f = (key, owner) => ({ key, owner, type: 'single_select', options: ['a'], visible: true })
  const { own, more } = split([f('mine', 'user'), f('theirs', 'reader'), f('old')])
  assert.deepEqual(own.map((x) => x.key), ['mine', 'old'])
  assert.deepEqual(more.map((x) => x.key), ['theirs'])
})
