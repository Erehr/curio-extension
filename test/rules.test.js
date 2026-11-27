import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, clean, fileSelectors, fromPresets, matches, pageTags, regexBad, subject, test as check } from '../lib/rules.js'

const PIC = { kind: 'image', src: 'https://cdn.art.test/a/b/photo.JPG?x=1', pageUrl: 'https://www.art.test/gallery/42', pageTitle: 'Faces of 42', size: { w: 1200, h: 800 } }

test('what a rule looks at', () => {
  assert.deepEqual(subject(PIC, 'www.art.test'), { site: 'www.art.test', page: PIC.pageUrl, title: 'Faces of 42', src: PIC.src, type: 'jpg', kind: 'image', width: 1200, height: 800 })
  assert.equal(subject({ kind: 'canvas' }, '').kind, 'image')
  assert.equal(subject({ kind: 'link', link: 'https://x.test/file.pdf' }, '').type, 'pdf')
})

test('conditions', () => {
  const s = subject(PIC, 'www.art.test')
  assert.equal(check({ field: 'site', op: 'is', value: 'art.test' }, s), true)
  assert.equal(check({ field: 'site', op: 'is', value: 'other.test, art.test' }, s), true)
  assert.equal(check({ field: 'site', op: 'isnot', value: 'art.test' }, s), false)
  assert.equal(check({ field: 'site', op: 'is', value: 'https://art.test/x' }, s), true)
  assert.equal(check({ field: 'page', op: 'contains', value: '/GALLERY/' }, s), true)
  assert.equal(check({ field: 'title', op: 'regex', value: '/faces of \\d+/i' }, s), true)
  assert.equal(check({ field: 'title', op: 'regex', value: '/faces of \\d+/' }, s), false)
  assert.equal(check({ field: 'title', op: 'notregex', value: '[' }, s), false, 'a broken expression matches nothing')
  assert.equal(check({ field: 'type', op: 'is', value: 'jpg' }, s), true)
  assert.equal(check({ field: 'kind', op: 'is', value: 'video' }, s), false)
  assert.equal(check({ field: 'width', op: 'gte', value: '1200' }, s), true)
  assert.equal(check({ field: 'height', op: 'gt', value: 'tall' }, s), false)
  assert.equal(check({ field: 'width', op: 'gt', value: '1' }, subject({ kind: 'link' }, '')), false, 'no size, no match')
  assert.equal(check({ field: 'page', op: 'contains', value: '  ' }, s), false, 'an empty value matches nothing')
  assert.equal(regexBad({ op: 'regex', value: '(' }), true)
  assert.equal(regexBad({ op: 'contains', value: '(' }), false)
})

test('all or any', () => {
  const s = subject(PIC, 'www.art.test')
  const conditions = [{ field: 'site', op: 'is', value: 'art.test' }, { field: 'kind', op: 'is', value: 'video' }]
  assert.equal(matches(clean({ matching: 'all', conditions }), s), false)
  assert.equal(matches(clean({ matching: 'any', conditions }), s), true)
})

test('top to bottom: a later library replaces the destination, tags add up, stop ends it, off is passed over', () => {
  const rules = [
    { id: 'a', conditions: [{ field: 'site', op: 'is', value: 'art.test' }], library: 'lib-a', folders: [1], tags: ['art'], tagsFrom: '.tag a' },
    { id: 'b', enabled: false, conditions: [{ field: 'site', op: 'is', value: 'art.test' }], library: 'lib-x', tags: ['off'] },
    { id: 'c', conditions: [{ field: 'kind', op: 'is', value: 'image' }], tags: ['picture', 'art'], ask: true },
    { id: 'd', conditions: [{ field: 'width', op: 'gt', value: '1000' }], library: 'lib-b', folders: [], tags: ['big'], stop: true, follow: true },
    { id: 'e', conditions: [{ field: 'site', op: 'is', value: 'art.test' }], library: 'lib-c', tags: ['never'] },
  ]
  const r = apply(rules, PIC, 'www.art.test')
  assert.equal(r.library, 'lib-b')
  assert.deepEqual(r.folders, [])
  assert.deepEqual(r.tags, ['art', 'picture', 'big'])
  assert.deepEqual(r.selectors, ['.tag a'])
  assert.equal(r.ask, true)
  assert.equal(r.follow, true)
  assert.deepEqual(r.names, ['a', 'c', 'd'])
  assert.equal(apply(rules, PIC, 'other.test').library, 'lib-b')
  assert.equal(apply([], PIC, 'x').library, null)
})

test('a rule from storage gets every field, of its type', () => {
  const r = clean({ conditions: [{ field: 'nope' }, { field: 'kind', op: 'gt', value: 3 }], folders: [1, 'x'], tags: [' a ', 'a', ''], library: '' })
  assert.deepEqual(r.conditions, [{ field: 'kind', op: 'is', value: 'image' }], 'an unknown kind is a picture, as Options shows it')
  assert.deepEqual(r.folders, [1])
  assert.deepEqual(r.tags, ['a'])
  assert.equal(r.library, null)
  assert.equal(r.enabled, true)
  assert.equal(clean({}).conditions.length, 1)
})

test('a page\'s texts as tags', () => {
  assert.deepEqual(pageTags(['  Cats ', 'cats', '', 'two\n  lines', null, 5]), ['Cats', 'two lines', '5'])
  assert.equal(pageTags(Array.from({ length: 50 }, (_, i) => 't' + i)).length, 30)
  assert.deepEqual(pageTags('nope'), [])
})

test('presets and followed sites become rules', () => {
  const rules = fromPresets({ presets: [{ id: 'p1', name: 'Faces', library: 'lib-b', folders: [2], tags: ['face'], sites: ['art.test', 'x.test'] }, { id: 'p2', name: 'Loose', library: 'lib-a', folders: [], tags: [], sites: [] }] }, { follow: ['refs.test'] })
  assert.equal(rules.length, 3)
  assert.deepEqual([rules[0].id, rules[0].enabled, rules[0].conditions[0].value, rules[0].library, rules[0].folders, rules[0].tags], ['p1', true, 'art.test, x.test', 'lib-b', [2], ['face']])
  assert.equal(rules[1].enabled, false)
  assert.deepEqual([rules[2].follow, rules[2].library, rules[2].conditions[0].value], [true, null, 'refs.test'])
  assert.deepEqual(fromPresets({}, {}), [])
})

test('file selectors resolve by page-level conditions with last matching rule first', () => {
  const rules = [
    { id: '1', conditions: [{ field: 'site', op: 'is', value: 'art.test' }], fileFrom: 'img.preview' },
    { id: '2', enabled: false, conditions: [{ field: 'site', op: 'is', value: 'art.test' }], fileFrom: 'img.disabled' },
    { id: '3', conditions: [{ field: 'site', op: 'is', value: 'art.test' }, { field: 'page', op: 'contains', value: '/gallery/' }], fileFrom: 'a.original' },
    { id: '4', conditions: [{ field: 'width', op: 'gt', value: '500' }], fileFrom: 'img.element-only' },
  ]
  assert.deepEqual(fileSelectors(rules, { pageUrl: PIC.pageUrl, pageTitle: PIC.pageTitle }, 'www.art.test'), ['a.original', 'img.preview'])
  assert.deepEqual(fileSelectors(rules, { pageUrl: 'https://www.art.test/home', pageTitle: 'Home' }, 'www.art.test'), ['img.preview'])
  assert.deepEqual(fileSelectors(rules, { pageUrl: 'https://other.test/', pageTitle: 'Other' }, 'other.test'), [])
  assert.equal(apply(rules, PIC, 'www.art.test').fileFrom, 'img.element-only')
})
