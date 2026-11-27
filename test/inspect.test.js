import test from 'node:test'
import assert from 'node:assert/strict'
import '../content/attrs.js'
import '../content/inspect.js'

const C = globalThis.CurioCompanion

test('srcset candidates, with commas inside addresses', () => {
  const list = C.parseSrcset('a.jpg 320w, https://res.example.com/w_640,h_480/b.jpg 640w,c.jpg 1280w', 'https://example.com/p/')
  assert.deepEqual(list.map((c) => [c.url, c.w]), [['https://example.com/p/a.jpg', 320], ['https://res.example.com/w_640,h_480/b.jpg', 640], ['https://example.com/p/c.jpg', 1280]])
  assert.equal(C.largest(list).url, 'https://example.com/p/c.jpg')
  const dense = C.parseSrcset('one.png, two.png 2x, three.png 1.5x', 'https://example.com/')
  assert.equal(C.largest(dense).url, 'https://example.com/two.png')
})

test('readable names', () => {
  for (const n of ['sunset-over-sea', 'Portrait study', 'IMG cat']) assert.equal(C.readableName(n), true, n)
  for (const n of ['3f9a1c2e4b5d6e7f', '550e8400-e29b-41d4-a716-446655440000', '1234567', 'image', 'AbC123dEf456GhI789', 'x']) assert.equal(C.readableName(n), false, n)
})

test('a title: the page\'s word, alternatives, a readable file name, then the page title', () => {
  assert.equal(C.titleOf({ attr: 'Given', alt: 'Alt' }), 'Given')
  assert.equal(C.titleOf({ alt: '  Alt  text ' }), 'Alt text')
  assert.equal(C.titleOf({ url: 'https://x.test/blue_sky.jpg', pageTitle: 'Page' }), 'blue sky')
  assert.equal(C.titleOf({ url: 'https://x.test/9f86d081884c7d65.jpg', pageTitle: 'Page' }), 'Page')
})

test('addresses that look like files', () => {
  assert.equal(C.looksLikeFile('https://x.test/a/b.JPG'), true)
  assert.equal(C.looksLikeFile('https://x.test/post/12'), false)
  assert.equal(C.directMediaKind('https://x.test/photo.JPG?size=orig'), 'image')
  assert.equal(C.directMediaKind('https://x.test/clip.mp4'), 'video')
  assert.equal(C.directMediaKind('https://x.test/track.flac'), 'audio')
  assert.equal(C.directMediaKind('https://x.test/post/12'), '')
})
