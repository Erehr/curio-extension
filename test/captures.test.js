import test from 'node:test'
import assert from 'node:assert/strict'
import { make, advance, again, routeOf, callFor, outcome, keepFields, mergeTags } from '../lib/captures.js'

const DRAFT = { kind: 'image', src: 'https://cdn.test/a.png', candidates: ['https://cdn.test/big/a.png', 'https://cdn.test/a.png'], inPage: false, pageUrl: 'https://site.test/post', pageTitle: 'Post', link: 'https://site.test/post', title: 'Sky', notes: 'from the page', tags: ['Sky'], rating: 4, fields: { artist: 'X' }, hints: {}, type: '' }
const DEST = { library: 'lib-a', folders: [3, 4], tags: ['web', 'sky'] }

test('a capture moves only forward through its states', () => {
  let r = make({ draft: DRAFT, dest: DEST, trigger: 'menu', tabId: 7 })
  assert.equal(r.state, 'new')
  assert.equal(r.mode, 'file')
  r = advance(r, 'fetching')
  r = advance(r, 'sending')
  r = advance(r, 'added', { ids: ['u1'] })
  assert.deepEqual(r.ids, ['u1'])
  assert.throws(() => advance(r, 'sending'))
  assert.throws(() => again(r))
  const failed = advance(advance(make({ draft: DRAFT, dest: DEST, trigger: 'menu' }), 'fetching'), 'failed', { message: 'no' })
  const back = again(failed, { mode: 'link' })
  assert.equal(back.state, 'new')
  assert.equal(back.message, undefined)
  assert.equal(back.mode, 'link')
})

test('a capture waits for Curio after its bytes, then is sent or fails', () => {
  const waiting = advance(advance(make({ draft: DRAFT, dest: DEST, trigger: 'menu' }), 'fetching'), 'waiting')
  assert.equal(advance(waiting, 'sending').state, 'sending')
  assert.equal(advance(waiting, 'failed').state, 'failed')
  assert.throws(() => advance(waiting, 'added'))
  assert.throws(() => advance(make({ draft: DRAFT, dest: DEST, trigger: 'menu' }), 'waiting'))
})

test('links and pages are saved as links unless the page says file', () => {
  assert.equal(make({ draft: { ...DRAFT, kind: 'link' }, dest: DEST, trigger: 'menu' }).mode, 'link')
  assert.equal(make({ draft: { ...DRAFT, kind: 'page' }, dest: DEST, trigger: 'menu' }).mode, 'link')
  assert.equal(make({ draft: { ...DRAFT, kind: 'link', type: 'file' }, dest: DEST, trigger: 'menu' }).mode, 'file')
  assert.equal(make({ draft: { ...DRAFT, type: 'link' }, dest: DEST, trigger: 'menu' }).mode, 'link')
})

const PRIVATE = (u) => /^https?:\/\/(127\.|localhost|192\.168\.)/.test(u)
const routed = (draft, o = {}) => {
  const rec = make({ draft, dest: DEST, trigger: 'menu' })
  return { ...rec, ...routeOf(rec, { isPrivate: PRIVATE, ...o }) }
}

test('Curio downloads what has a public address; the browser reads the rest', () => {
  assert.deepEqual(routeOf(make({ draft: DRAFT, dest: DEST, trigger: 'menu' }), { isPrivate: PRIVATE }), { via: 'url', urls: ['https://cdn.test/a.png', 'https://cdn.test/big/a.png'] })
  assert.equal(routed({ ...DRAFT, src: 'blob:https://site.test/1', candidates: [], inPage: true }).via, 'bytes', 'only the page has it')
  assert.equal(routed({ ...DRAFT, shot: 's1' }).via, 'bytes')
  assert.equal(routed({ ...DRAFT, src: 'http://192.168.1.5/a.png', candidates: ['http://192.168.1.5/a.png'] }).via, 'bytes', 'Curio downloads only from the internet')
  assert.equal(routed(DRAFT, { browser: true }).via, 'bytes', 'Download through the browser')
  assert.equal(routed({ ...DRAFT, kind: 'link', src: 'https://site.test/other' }).via, 'link')
  assert.equal(routed({ ...DRAFT, kind: 'link', src: 'http://localhost:3000/' }).via, 'bookmark', 'a page on this computer is only kept as a link')
})

test('bytes go with the page as source; tags merge once each', () => {
  const rec = routed({ ...DRAFT, shot: 's1' })
  const { op, params } = callFor(rec, { data: 'data:image/png;base64,AAAA', name: 'Sky.png' })
  assert.equal(op, 'item.add.fromBytes')
  assert.deepEqual(params, { library: 'lib-a', folders: [3, 4], tags: ['web', 'sky'], annotation: 'from the page', rating: 4, fields: { artist: 'X' }, requestId: rec.id, data: 'data:image/png;base64,AAAA', name: 'Sky.png', sourceUrl: 'https://site.test/post', onDuplicate: 'skip' })
})

test('Curio downloads the page\'s address, the larger versions as alternates, and is asked for no notification', () => {
  const rec = routed(DRAFT)
  const { op, params } = callFor(rec, null, { referer: 'https://site.test/', cookies: 'sid=1', userAgent: 'Browser/1' })
  assert.equal(op, 'item.add.fromUrls')
  assert.deepEqual(params.urls, ['https://cdn.test/a.png'])
  assert.deepEqual(params.alternates, ['https://cdn.test/big/a.png'])
  assert.deepEqual([params.wait, 'notify' in params, params.onDuplicate, params.requestId], [false, false, 'skip', rec.id])
  assert.deepEqual([params.sourceUrl, params.name, params.referer, params.cookies, params.userAgent], ['https://site.test/post', 'Sky', 'https://site.test/', 'sid=1', 'Browser/1'])
  assert.equal(callFor({ ...rec, force: true }, null).params.onDuplicate, 'keep', 'asked for again')
  assert.equal('cookies' in callFor(rec, null).params, false)
  const many = routed({ ...DRAFT, candidates: Array.from({ length: 12 }, (_, i) => `https://cdn.test/${i}.png`) })
  assert.equal(callFor(many, null).params.alternates.length, 8)
})

test('a large file goes by its upload id', () => {
  const { op, params } = callFor(routed({ ...DRAFT, shot: 's1' }), { upload: 'f'.repeat(32), name: 'Big.mp4' })
  assert.equal(op, 'item.add.fromBytes')
  assert.equal(params.upload, 'f'.repeat(32))
  assert.equal('data' in params, false)
})

test('a link goes through fromUrls, so a plugin may take it, and carries no sourceUrl, which would replace its address', () => {
  const { op, params } = callFor(routed({ ...DRAFT, kind: 'link', src: 'https://site.test/other', title: 'Other' }), null)
  assert.equal(op, 'item.add.fromUrls')
  assert.deepEqual([params.urls, params.as, params.name, params.wait], [['https://site.test/other'], 'link', 'Other', false])
  assert.equal('sourceUrl' in params, false)
  const local = callFor(routed({ ...DRAFT, kind: 'link', src: 'http://localhost:3000/', title: 'Dev' }), null)
  assert.deepEqual([local.op, local.params.url, local.params.name], ['item.add.bookmark', 'http://localhost:3000/', 'Dev'])
})

test('a capture sent again has a request id of its own, since Curio answers a repeated one with what the first call did', () => {
  const rec = routed(DRAFT)
  const failed = advance(advance(rec, 'sending'), 'failed', { message: 'no' })
  const back = again(failed, { mode: 'link' })
  assert.notEqual(callFor(back, null).params.requestId, rec.id)
  assert.equal(back.via, undefined, 'routed again')
})

test('a call with no answer goes back to waiting', () => {
  const sending = advance(advance(make({ draft: DRAFT, dest: DEST, trigger: 'menu' }), 'fetching'), 'sending')
  assert.equal(advance(sending, 'waiting').state, 'waiting')
  assert.deepEqual(outcome({ success: true, ids: [], errors: [], duplicates: [{ of: 'u9', skipped: true }] }), { state: 'added', ids: ['u9'], message: undefined }, 'a resend skipped as a duplicate is saved as the item it duplicates')
})

test('answers', () => {
  assert.deepEqual(outcome({ success: true, ids: ['a'], errors: [] }), { state: 'added', ids: ['a'], message: undefined })
  assert.deepEqual(outcome({ success: true, queued: true }), { state: 'queued' })
  assert.equal(outcome({ success: true, ids: [], errors: [], handed: [{ plugin: 'p' }] }).state, 'handed')
  assert.equal(outcome({ success: true, ids: [], errors: ['bad'] }).message, 'bad')
  assert.equal(outcome(null).state, 'unknown')
})

test('fields the library doesn\'t define are dropped and named', () => {
  assert.deepEqual(keepFields({ artist: 'X', mood: 'calm' }, [{ key: 'artist' }]), { kept: { artist: 'X' }, dropped: ['mood'] })
  assert.deepEqual(mergeTags(['A', 'b'], ['a', 'C']), ['A', 'b', 'C'])
})

test('favorite and explicit flags pass through to add calls only when set', () => {
  const rec = routed({ ...DRAFT, favorite: true, explicit: true })
  const { params } = callFor(rec, null)
  assert.equal(params.favorite, true)
  assert.equal(params.explicit, true)
  const plain = callFor(routed({ ...DRAFT, favorite: false, explicit: false }), null).params
  assert.equal('favorite' in plain, false)
  assert.equal('explicit' in plain, false)
})
