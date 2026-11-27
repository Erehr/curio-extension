import test from 'node:test'
import assert from 'node:assert/strict'
import '../content/attrs.js'

const C = globalThis.CurioCompanion
const PAGE = 'https://example.com/post/1'

test('the nearest level wins for each name, and a single attribute wins over its level\'s data-curio object', () => {
  const levels = [
    { 'data-curio-title': 'Element', 'data-curio': '{"title":"Object","notes":"x","tags":["a"]}' },
    { 'data-curio-tags': 'b, c', 'data-curio-library': 'Card' },
    { 'curio-library': 'Page', 'data-curio-rating': '4' },
  ]
  const raw = C.rawHints(levels, { library: 'Meta', link: 'https://example.com/meta' })
  assert.equal(raw.title, 'Element')
  assert.deepEqual(raw.tags, ['a'])
  assert.equal(raw.library, 'Card')
  assert.equal(raw.rating, '4')
  assert.equal(raw.link, 'https://example.com/meta')
})

test('eagle-* fills only what no Curio attribute gives, and can be switched off', () => {
  const levels = [{ 'eagle-title': 'E title', 'eagle-tags': 'x, y', 'data-curio-title': 'C title', 'eagle-src-loading': '' }]
  const raw = C.rawHints(levels, {}, true)
  assert.equal(raw.title, 'C title')
  assert.equal(raw.tags, 'x, y')
  assert.equal(raw.pending, '')
  assert.equal(C.rawHints(levels, {}, false).tags, undefined)
})

test('tags come as JSON or separated by commas, once each, cut to 50 of 100 characters', () => {
  assert.deepEqual(C.tags('["a","B","b"," c "]'), ['a', 'B', 'c'])
  assert.deepEqual(C.tags('one, two ,, three'), ['one', 'two', 'three'])
  const many = C.tags(JSON.stringify(Array.from({ length: 80 }, (_, i) => 't' + i + 'x'.repeat(200))))
  assert.equal(many.length, 50)
  assert.equal(many[0].length, 100)
})

test('hints are cut to size and addresses kept to http and https', () => {
  const h = C.cleanHints({ title: 'x'.repeat(500), annotation: 'line one\r\nline two\u0000', link: 'javascript:alert(1)', src: '/full.png', rating: '7', fields: '{"a":1,"bad key":2,"b":"t","c":{"no":1}}', folders: '[3, "Refs / Faces", "12", -1]', type: 'link', referer: 'https://evil.test/' }, PAGE, PAGE)
  assert.equal(h.title.length, 200)
  assert.equal(h.notes, 'line one\nline two')
  assert.equal(h.link, undefined)
  assert.equal(h.src, 'https://example.com/full.png')
  assert.equal(h.rating, 5)
  assert.deepEqual(h.fields, { a: 1, b: 't' })
  assert.deepEqual(h.folders, [3, 'Refs/Faces', 12])
  assert.equal(h.type, 'link')
  assert.equal(h.referer, undefined)
  assert.equal(C.cleanHints({ referer: 'https://img.example.com/x' }, PAGE, PAGE).referer, 'https://img.example.com/x')
  assert.equal(C.cleanHints({ folders: 'Inbox' }, PAGE, PAGE).folders[0], 'Inbox')
})

test('private and loopback hosts', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', 'printer.local', 'a.localhost']) assert.equal(C.isPrivateHost(h), true, h)
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(C.isPrivateHost(h), false, h)
})

test('same site by registrable domain', () => {
  assert.equal(C.sameSite('https://img.example.com/a', 'https://www.example.com/'), true)
  assert.equal(C.sameSite('https://a.example.co.uk/', 'https://b.example.co.uk/'), true)
  assert.equal(C.sameSite('https://other.co.uk/', 'https://example.co.uk/'), false)
  assert.equal(C.sameSite('https://cdn.test/', PAGE), false)
})

test('the worker checks a draft again: a page on the internet can\'t point the extension at this computer', () => {
  const d = C.checkDraft({ kind: 'image', src: 'http://127.0.0.1:8080/secret.png', candidates: ['http://127.0.0.1:8080/secret.png', 'https://cdn.example.com/a.png', 'file:///c:/x'], title: 'x'.repeat(300), tags: ['a', 'a'], pageUrl: 'ignored' }, PAGE)
  assert.deepEqual(d.candidates, ['https://cdn.example.com/a.png'])
  assert.equal(d.src, '')
  assert.equal(d.title.length, 200)
  assert.deepEqual(d.tags, ['a'])
  assert.equal(d.pageUrl, PAGE)
  const local = C.checkDraft({ kind: 'image', src: 'http://127.0.0.1:8080/a.png', candidates: ['http://127.0.0.1:8080/a.png'] }, 'http://127.0.0.1:9000/page')
  assert.deepEqual(local.candidates, ['http://127.0.0.1:8080/a.png'])
})

test('a draft of an unknown kind is the page, and a link without an address is the page', () => {
  assert.equal(C.checkDraft({ kind: 'nope' }, PAGE).kind, 'page')
  assert.equal(C.checkDraft({ kind: 'nope' }, PAGE).src, PAGE)
  assert.equal(C.checkDraft({ kind: 'link', src: 'javascript:void 0' }, PAGE).kind, 'page')
  const blob = C.checkDraft({ kind: 'image', src: 'blob:https://example.com/1', inPage: true, inPageId: 'abc' }, PAGE)
  assert.equal(blob.src, 'blob:https://example.com/1')
  assert.deepEqual(blob.candidates, ['blob:https://example.com/1'])
})

test('larger versions from site rules are checked again: a rule can\'t carry the extension to this computer', async () => {
  const { candidates } = await import('../lib/sites.js')
  const draft = C.checkDraft({ kind: 'image', src: 'https://shop.test/_next/image?url=http%3A%2F%2F127.0.0.1%3A41733%2Fx', candidates: ['https://shop.test/_next/image?url=http%3A%2F%2F127.0.0.1%3A41733%2Fx', 'https://images.weserv.nl/?url=192.168.1.2/y.png'] }, PAGE)
  const out = C.expandCandidates(draft, candidates)
  assert.deepEqual(out.candidates, ['https://shop.test/_next/image?url=http%3A%2F%2F127.0.0.1%3A41733%2Fx', 'https://images.weserv.nl/?url=192.168.1.2/y.png'])
  const local = C.expandCandidates(C.checkDraft({ kind: 'image', src: 'http://127.0.0.1:9/_next/image?url=%2Fa.png', candidates: ['http://127.0.0.1:9/_next/image?url=%2Fa.png'] }, 'http://127.0.0.1:9/'), candidates)
  assert.deepEqual(local.candidates, ['http://127.0.0.1:9/a.png', 'http://127.0.0.1:9/_next/image?url=%2Fa.png'])
})

test('a link to this computer is still saved as that link: a link is never fetched', () => {
  const d = C.checkDraft({ kind: 'link', src: 'http://192.168.1.10/admin' }, PAGE)
  assert.equal(d.kind, 'link')
  assert.equal(d.src, 'http://192.168.1.10/admin')
  assert.deepEqual(d.candidates, [])
})

test('favorite and explicit attributes are read and checked as booleans', () => {
  const raw = C.rawHints([{ 'data-curio-favorite': '', 'data-curio-explicit': 'true' }])
  const h = C.cleanHints(raw, PAGE, PAGE)
  assert.equal(h.favorite, true)
  assert.equal(h.explicit, true)
  const off = C.cleanHints(C.rawHints([{ 'data-curio-favorite': 'false', 'data-curio-explicit': '0' }]), PAGE, PAGE)
  assert.equal(off.favorite, undefined)
  assert.equal(off.explicit, undefined)
  const checked = C.checkDraft({ kind: 'image', src: 'https://cdn.example.com/a.png', favorite: true, explicit: true }, PAGE)
  assert.equal(checked.favorite, true)
  assert.equal(checked.explicit, true)
  assert.equal(C.checkDraft({ kind: 'image', src: 'https://cdn.example.com/a.png', favorite: 'yes' }, PAGE).favorite, undefined)
})

test('parseShortcut and matchesShortcut handle standard and macOS formats while ignoring repeat and AltGraph', () => {
  const altD = C.parseShortcut('Alt+D')
  assert.deepEqual(altD, { alt: true, ctrl: false, shift: false, meta: false, code: 'KeyD', key: 'D' })
  assert.equal(C.matchesShortcut({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyD', key: 'd' }, altD), true)
  assert.equal(C.matchesShortcut({ altKey: true, ctrlKey: false, shiftKey: true, metaKey: false, code: 'KeyD', key: 'D' }, altD), false)
  assert.equal(C.matchesShortcut({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyD', key: 'd', repeat: true }, altD), false)
  assert.equal(C.matchesShortcut({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyD', key: 'd', getModifierState: (m) => m === 'AltGraph' }, altD), false)

  const macOpt = C.parseShortcut('⌥⇧S')
  assert.deepEqual(macOpt, { alt: true, ctrl: false, shift: true, meta: false, code: 'KeyS', key: 'S' })
  assert.equal(C.matchesShortcut({ altKey: true, ctrlKey: false, shiftKey: true, metaKey: false, code: 'KeyS', key: 's' }, macOpt), true)

  const ctrlDigit = C.parseShortcut('Ctrl+Shift+1')
  assert.deepEqual(ctrlDigit, { alt: false, ctrl: true, shift: true, meta: false, code: 'Digit1', key: '1' })
  assert.deepEqual(C.parseShortcut('Alt+-'), { alt: true, ctrl: false, shift: false, meta: false, code: 'Minus', key: '-' })
  assert.equal(C.parseShortcut('D'), null)
  assert.equal(C.parseShortcut(''), null)
})
