import test from 'node:test'
import assert from 'node:assert/strict'
import { fileName, extOfType, extOfUrl, dispositionName, cleanTitle } from '../lib/naming.js'

test('the extension comes from the address, then Content-Disposition, then the type', () => {
  assert.equal(fileName({ title: 'Sky', url: 'https://x.test/a/photo.png', type: 'image/png' }), 'Sky.png')
  assert.equal(fileName({ title: 'Sky', url: 'https://x.test/media/X?format=jpg', type: 'image/jpeg' }), 'Sky.jpg')
  assert.equal(fileName({ title: '', url: 'https://x.test/get?id=4', disposition: 'attachment; filename="report final.pdf"' }), 'report final.pdf')
  assert.equal(fileName({ title: 'Doc', url: 'https://x.test/get', disposition: "attachment; filename*=UTF-8''%C5%BC%C3%B3%C5%82w.zip" }), 'Doc.zip')
  assert.equal(fileName({ title: 'Clip', url: 'https://x.test/stream', type: 'video/webm' }), 'Clip.webm')
})

test('a type that contradicts the address wins; jpeg and jpg are one type', () => {
  assert.equal(fileName({ title: 'A', url: 'https://cdn.test/a.jpg', type: 'image/webp' }), 'A.webp')
  assert.equal(fileName({ title: 'A', url: 'https://cdn.test/a.jpeg', type: 'image/jpeg' }), 'A.jpeg')
  assert.equal(fileName({ title: 'A', url: 'https://cdn.test/a.php', type: 'image/gif' }), 'A.gif')
})

test('names without a title or a type', () => {
  assert.equal(fileName({ url: 'https://x.test/a/blue%20sky.png' }), 'blue sky.png')
  assert.equal(fileName({ url: 'https://x.test/' }), 'download.bin')
})

test('titles safe as file names', () => {
  assert.equal(cleanTitle('a/b:c*d?  "e"<f>|g\n'), 'a b c d e f g')
  assert.equal(cleanTitle('trailing dots...'), 'trailing dots')
  assert.equal(cleanTitle('x'.repeat(300)).length, 120)
})

test('helpers', () => {
  assert.equal(extOfType('image/svg+xml; charset=utf-8'), 'svg')
  assert.equal(extOfUrl('https://x.test/a.tar.gz'), '')
  assert.equal(extOfUrl('https://x.test/a.MP4'), 'mp4')
  assert.equal(dispositionName(''), '')
})
