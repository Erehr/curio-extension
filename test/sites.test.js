import test from 'node:test'
import assert from 'node:assert/strict'
import { candidates } from '../lib/sites.js'

test('Next.js image optimiser addresses give their original first', () => {
  assert.deepEqual(candidates('https://shop.test/_next/image?url=%2Fimg%2Fa.png&w=640&q=75'), ['https://shop.test/img/a.png', 'https://shop.test/_next/image?url=%2Fimg%2Fa.png&w=640&q=75'])
  assert.deepEqual(candidates('https://shop.test/_next/image?url=https%3A%2F%2Fcdn.test%2Fb.jpg&w=64'), ['https://cdn.test/b.jpg', 'https://shop.test/_next/image?url=https%3A%2F%2Fcdn.test%2Fb.jpg&w=64'])
})

test('weserv proxies give the proxied address', () => {
  assert.deepEqual(candidates('https://images.weserv.nl/?url=example.com/c.jpg&w=300')[0], 'https://example.com/c.jpg')
  assert.deepEqual(candidates('https://wsrv.nl/?url=https://example.com/d.png')[0], 'https://example.com/d.png')
})

test('Wikimedia thumbnails give the original file', () => {
  assert.deepEqual(candidates('https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/320px-Example.jpg'), ['https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/320px-Example.jpg'])
  for (const other of ['https://upload.wikimedia.org/wikipedia/en/thumb/8/80/Logo.svg/200px-Logo.svg.png', 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Book.pdf/page1-220px-Book.pdf.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Clip.webm/220px--Clip.webm.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Scan.tif/lossy-page1-220px-Scan.tif.jpg']) {
    assert.deepEqual(candidates(other), [other], 'a thumbnail of another type of file stays the thumbnail')
  }
  assert.deepEqual(candidates('https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg'), ['https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg'], 'an original is left as it is')
})

test('X pictures ask for the original size', () => {
  assert.deepEqual(candidates('https://pbs.twimg.com/media/GAbc123XYZ?format=jpg&name=small')[0], 'https://pbs.twimg.com/media/GAbc123XYZ?format=jpg&name=orig')
  assert.deepEqual(candidates('https://pbs.twimg.com/media/GAbc123XYZ?format=png')[0], 'https://pbs.twimg.com/media/GAbc123XYZ?format=png&name=orig')
  assert.deepEqual(candidates('https://pbs.twimg.com/media/GAbc123XYZ.jpg:large')[0], 'https://pbs.twimg.com/media/GAbc123XYZ.jpg:orig')
  assert.deepEqual(candidates('https://pbs.twimg.com/media/GAbc123XYZ?format=jpg&name=orig'), ['https://pbs.twimg.com/media/GAbc123XYZ?format=jpg&name=orig'])
  assert.deepEqual(candidates('https://pbs.twimg.com/profile_images/1/a_normal.jpg'), ['https://pbs.twimg.com/profile_images/1/a_normal.jpg'], 'only pictures of posts')
})

test('Pinterest sizes give the original', () => {
  assert.deepEqual(candidates('https://i.pinimg.com/736x/12/34/56/123456abcdef.jpg')[0], 'https://i.pinimg.com/originals/12/34/56/123456abcdef.jpg')
  assert.deepEqual(candidates('https://i.pinimg.com/60x60_RS/12/34/56/123456abcdef.jpg')[0], 'https://i.pinimg.com/originals/12/34/56/123456abcdef.jpg')
  assert.deepEqual(candidates('https://i.pinimg.com/originals/12/34/56/123456abcdef.jpg'), ['https://i.pinimg.com/originals/12/34/56/123456abcdef.jpg'])
})

test('Reddit previews give the picture on i.redd.it', () => {
  assert.deepEqual(candidates('https://preview.redd.it/abc123def.jpg?width=640&crop=smart&auto=webp&s=0f'), ['https://i.redd.it/abc123def.jpg', 'https://preview.redd.it/abc123def.jpg?width=640&crop=smart&auto=webp&s=0f'])
  assert.deepEqual(candidates('https://external-preview.redd.it/abc.jpg?s=1'), ['https://external-preview.redd.it/abc.jpg?s=1'], 'another site\'s picture stays')
})

test('other addresses are tried as they are, and nothing that isn\'t a web, blob or data address', () => {
  assert.deepEqual(candidates('https://x.test/a.png'), ['https://x.test/a.png'])
  assert.deepEqual(candidates('blob:https://x.test/1'), ['blob:https://x.test/1'])
  assert.deepEqual(candidates('javascript:1'), [])
})
