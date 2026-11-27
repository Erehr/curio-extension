// The extension's curio.js is a copy of Curio's client (client/curio.js in Curio's repository), pinned until it is copied again.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = path.join(path.resolve(process.env.CURIO_APP || path.join(root, '..', 'app')), 'client', 'curio.js')
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

test('curio.js is the client of the Curio checkout beside this one', { skip: !fs.existsSync(client) && `no ${client}` }, () => {
  assert.ok(read(path.join(root, 'curio.js')) === read(client), `curio.js differs from ${client}: copy it again`)
})
