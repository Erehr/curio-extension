import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { state, whileBusy } from '../lib/connection.js'

function stub(handler) {
  return new Promise((ok) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => ok(server))
  })
}
const port = (s) => s.address().port

test('the connection\'s states, from one call to app.info', async () => {
  assert.deepEqual(await state({ port: 1, token: '' }), { state: 'no-token' })
  const curio = await stub((req, res) => {
    const auth = req.headers.authorization
    res.setHeader('Content-Type', 'application/json')
    if (auth === 'Bearer good') return res.end(JSON.stringify({ name: 'Curio', version: '0.8.30', apiVersion: 1 }))
    if (auth === 'Bearer origin') return (res.statusCode = 403), res.end(JSON.stringify({ error: { code: 'not_allowed', message: 'origin not allowed' } }))
    res.statusCode = 401
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'unknown token' } }))
  })
  const other = await stub((req, res) => res.end('<html>not Curio</html>'))
  try {
    const up = await state({ port: port(curio), token: 'good' })
    assert.equal(up.state, 'up')
    assert.equal(up.info.version, '0.8.30')
    assert.deepEqual(await state({ port: port(curio), token: 'bad' }), { state: 'refused', message: 'unknown token' })
    assert.equal((await state({ port: port(curio), token: 'origin' })).state, 'refused')
    assert.equal((await state({ port: port(other), token: 'good' })).state, 'off')
  } finally {
    curio.close()
    other.close()
  }
  const closed = await stub(() => {})
  const p = port(closed)
  closed.close()
  assert.equal((await state({ port: p, token: 'good' })).state, 'off')
})

test('a busy answer is tried again until it isn\'t, and only busy is', async () => {
  let n = 0
  const r = await whileBusy(async () => {
    if (++n < 3) throw Object.assign(new Error('opening'), { code: 'busy' })
    return 'done'
  }, { every: 5, upTo: 1000 })
  assert.equal(r, 'done')
  assert.equal(n, 3)
  await assert.rejects(whileBusy(async () => { throw Object.assign(new Error('no'), { code: 'failed' }) }, { every: 5 }), /no/)
  await assert.rejects(whileBusy(async () => { throw Object.assign(new Error('still'), { code: 'busy' }) }, { every: 5, upTo: 20 }), /still/)
})
