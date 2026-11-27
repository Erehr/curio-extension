import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, findLibrary, hostMatches, resolvePaths, folderPath, label, remember, rememberedFolders } from '../lib/destinations.js'

const LIBS = [
  { id: 'lib-a', name: 'Inspiration', state: 'window', default: true },
  { id: 'lib-b', name: 'Work', state: 'closed', default: false },
  { id: null, path: 'C:\\old.curio', name: 'Old', state: 'closed', default: false },
]
const FOLDERS = [
  { id: 1, parentId: null, name: 'Refs' },
  { id: 2, parentId: 1, name: 'Faces' },
  { id: 3, parentId: null, name: 'Inbox' },
]
const DEST = { last: { library: 'lib-a', folders: [3], tags: ['web'] }, aliases: { refs: 'lib-b' }, recents: [], perLibrary: {}, recentTags: [] }

test('libraries by alias, id, folder or a name no other library has', () => {
  assert.equal(findLibrary('refs', LIBS, DEST.aliases).id, 'lib-b')
  assert.equal(findLibrary('lib-a', LIBS).name, 'Inspiration')
  assert.equal(findLibrary('work', LIBS).id, 'lib-b')
  assert.equal(findLibrary('C:\\old.curio', LIBS).name, 'Old')
  assert.equal(findLibrary('Nope', LIBS), null)
  assert.equal(findLibrary('x', [...LIBS, { id: 'c', name: 'X' }, { id: 'd', name: 'x' }]), null)
})

test('hosts and their subdomains', () => {
  assert.equal(hostMatches('img.example.com', ['example.com']), true)
  assert.equal(hostMatches('example.com', ['*.example.com']), true)
  assert.equal(hostMatches('badexample.com', ['example.com']), false)
})

const FOLLOWED = { rules: [{ conditions: [{ field: 'site', op: 'is', value: 'example.com' }], follow: true }] }

test('a page\'s hint is followed only where a rule follows the site', () => {
  const draft = { hints: { library: 'refs', folders: [2, 'Refs/Faces'] } }
  const followed = resolve(draft, { ...DEST, ...FOLLOWED }, LIBS, 'www.example.com')
  assert.equal(followed.from, 'page')
  assert.deepEqual(followed.dest, { library: 'lib-b', folders: [2], tags: [], folderPaths: ['Refs/Faces'] })
  const elsewhere = resolve(draft, DEST, LIBS, 'www.example.com')
  assert.equal(elsewhere.from, 'last')
  assert.deepEqual(elsewhere.dest.folders, [3])
  assert.equal(elsewhere.asked.name, 'Work')
  assert.equal(elsewhere.asked.reachable, true)
  assert.equal(elsewhere.asked.followed, false)
})

test('a hint to a library the token can\'t reach changes nothing, even on a followed site', () => {
  const r = resolve({ hints: { library: 'Secret' } }, { ...DEST, ...FOLLOWED }, LIBS, 'example.com')
  assert.equal(r.from, 'last')
  assert.equal(r.dest.library, 'lib-a')
  assert.equal(r.asked.reachable, false)
})

test('rules: a followed page\'s hint first, then the rules\' place, then the last, each with the rules\' tags', () => {
  const site = { field: 'site', op: 'is', value: 'art.test' }
  const state = { ...DEST, rules: [{ conditions: [site], library: 'lib-b', folders: [2], tags: ['face'] }, { conditions: [{ field: 'kind', op: 'is', value: 'image' }], tags: ['pic'], tagsFrom: '.tags a' }] }
  const r = resolve({ hints: {}, kind: 'image' }, state, LIBS, 'img.art.test')
  assert.equal(r.from, 'rule')
  assert.deepEqual(r.dest, { library: 'lib-b', folders: [2], tags: ['face', 'pic'] })
  assert.deepEqual(r.rules.selectors, ['.tags a'])
  const page = resolve({ hints: { library: 'Inspiration' }, kind: 'image' }, { ...state, rules: [...state.rules, { conditions: [site], follow: true }] }, LIBS, 'art.test')
  assert.equal(page.from, 'page')
  assert.deepEqual(page.dest, { library: 'lib-a', folders: [], tags: ['face', 'pic'] })
  const elsewhere = resolve({ hints: {}, kind: 'image' }, state, LIBS, 'other.test')
  assert.equal(elsewhere.from, 'last')
  assert.deepEqual(elsewhere.dest.tags, ['web', 'pic'])
  assert.equal(resolve({ hints: {}, kind: 'link' }, state, LIBS, 'other.test').dest.tags.length, 1)
})

test('no destination yet: none, and the panel opens', () => {
  assert.equal(resolve({ hints: {} }, { ...DEST, last: null }, LIBS, 'x.test').dest, null)
})

test('folder paths from the top', () => {
  assert.deepEqual(resolvePaths(['Refs/Faces', 'inbox', 'Refs/Hands'], FOLDERS), { ids: [2, 3], missing: ['Refs / Hands'] })
  assert.equal(folderPath(FOLDERS, 2), 'Refs / Faces')
})

test('labels and remembered destinations', () => {
  assert.equal(label({ library: 'lib-a', folders: [2] }, LIBS, FOLDERS), 'Inspiration / Faces')
  assert.equal(label({ library: 'lib-b', folders: [] }, LIBS, []), 'Work')
  assert.equal(label({ library: 'gone', folders: [] }, LIBS, []), '')
  let s = remember(DEST, { library: 'lib-b', folders: [1], tags: ['x'] })
  s = remember(s, { library: 'lib-a', folders: [3], tags: [] })
  s = remember(s, { library: 'lib-b', folders: [1], tags: ['x'] })
  assert.deepEqual(s.last, { library: 'lib-b', folders: [1], tags: ['x'] })
  assert.equal(s.recents.length, 2)
  assert.deepEqual(s.perLibrary['lib-a'], { folders: [3], tags: [] })
  assert.deepEqual(s.recentTags, ['x'])
})

test('folder memory respects never, per-site, and always modes without leaking across domains', () => {
  let s = remember({ ...DEST, last: null, perLibrary: {}, perSite: {} }, { library: 'lib-a', folders: [2], tags: ['art'] }, 'img.example.com')
  assert.deepEqual(s.perSite['example.com'], { 'lib-a': [2] })
  assert.deepEqual(rememberedFolders(s, 'lib-a', { mode: 'never', host: 'www.example.com' }), [])
  assert.deepEqual(rememberedFolders(s, 'lib-a', { mode: 'site', host: 'www.example.com' }), [2])
  assert.deepEqual(rememberedFolders(s, 'lib-a', { mode: 'site', host: 'other.org' }), [])
  assert.deepEqual(rememberedFolders(s, 'lib-a', { mode: 'always', host: 'other.org' }), [2])

  const neverRes = resolve({ hints: {} }, s, LIBS, 'other.org', { rememberFolder: 'never', keepTags: false })
  assert.equal(neverRes.dest.library, 'lib-a')
  assert.deepEqual(neverRes.dest.folders, [])
  assert.deepEqual(neverRes.dest.tags, [])

  const siteHit = resolve({ hints: {} }, s, LIBS, 'sub.example.com', { rememberFolder: 'site', keepTags: false })
  assert.deepEqual(siteHit.dest.folders, [2])
  assert.deepEqual(siteHit.dest.tags, [])

  const siteMiss = resolve({ hints: {} }, s, LIBS, 'other.org', { rememberFolder: 'site', keepTags: true })
  assert.deepEqual(siteMiss.dest.folders, [])
  assert.deepEqual(siteMiss.dest.tags, ['art'])
})
