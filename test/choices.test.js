import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choiceFields, held, patch, filled } from '../panel/choices.js'

const STATE = { key: 'read_state', label: 'Reading status', type: 'single_select', options: ['unread', 'reading', 'finished'] }
const KINDS = { key: 'kinds', label: 'Kinds', type: 'multi_select', options: ['a', 'b', 'c'] }
const FREE = { key: 'genre', type: 'multi_select', options: [] }
const TEXT = { key: 'artist', type: 'text', options: [] }
const HIDDEN = { key: 'review', type: 'single_select', options: ['x'], visible: false }

test('only choice fields with options the library shows', () => {
  assert.deepEqual(choiceFields([STATE, KINDS, FREE, TEXT, HIDDEN]).map((f) => f.key), ['read_state', 'kinds'])
})

test('values are held as the field takes them, and unknown options are dropped', () => {
  assert.equal(held(STATE, 'reading'), 'reading')
  assert.equal(held(STATE, 'nope'), '')
  assert.equal(held(STATE, ['finished']), 'finished')
  assert.deepEqual(held(KINDS, ['a', 'z', 'c']), ['a', 'c'])
  assert.deepEqual(held(KINDS, 'b, c'), ['b', 'c'])
  assert.deepEqual(held(KINDS, undefined), [])
})

test('a patch names what changed, a cleared field as null', () => {
  const fields = [STATE, KINDS]
  assert.deepEqual(patch(fields, { read_state: 'unread', kinds: ['a'] }, { read_state: 'unread', kinds: ['a'] }), {})
  assert.deepEqual(patch(fields, { read_state: 'unread' }, { read_state: '', kinds: ['b'] }), { read_state: null, kinds: ['b'] })
  assert.deepEqual(patch(fields, { kinds: ['a'] }, { kinds: [] }), { kinds: null })
})

test('a new item gets only the fields set', () => {
  assert.deepEqual(filled([STATE, KINDS], { read_state: '', kinds: ['c'] }), { kinds: ['c'] })
})
