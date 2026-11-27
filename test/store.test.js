import test from 'node:test'
import assert from 'node:assert/strict'

// a chrome.storage.local with nothing but get, set and remove
function fakeChrome(initial) {
  const data = { ...initial }
  const area = {
    get: async (keys) => {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]))
    },
    set: async (o) => Object.assign(data, structuredClone(o)),
    remove: async (keys) => [keys].flat().forEach((k) => delete data[k]),
  }
  globalThis.chrome = { storage: { local: area, session: area } }
  return data
}

const store = await import('../lib/store.js')

test('the example extension\'s token, port and library move to conn and dest', async () => {
  const data = fakeChrome({ token: 'curio_x', port: 41800, library: 'lib-a' })
  await store.migrate()
  assert.deepEqual(data.conn, { port: 41800, token: 'curio_x' })
  assert.deepEqual(data.dest.last, { library: 'lib-a', folders: [], tags: [] })
  assert.equal('token' in data, false)
  assert.equal('library' in data, false)
  assert.deepEqual(await store.conn(), { port: 41800, token: 'curio_x' })
})

test('nothing to move, or already moved: nothing changes', async () => {
  const data = fakeChrome({ conn: { port: 1, token: 't' }, token: 'old' })
  await store.migrate()
  assert.deepEqual(data.conn, { port: 1, token: 't' })
  assert.equal(data.token, 'old')
  const empty = fakeChrome({})
  await store.migrate()
  assert.deepEqual(empty, {})
})

test('settings and destinations come with their defaults', async () => {
  fakeChrome({ settings: { minSize: 10 } })
  const s = await store.settings()
  assert.equal(s.minSize, 10)
  assert.equal(s.eagle, true)
  assert.equal(s.rememberFolder, 'never')
  assert.equal('follow' in s, false)
  assert.deepEqual((await store.dest()).recents, [])
  assert.deepEqual((await store.dest()).perSite, {})
  assert.deepEqual((await store.dest()).rules, [])
})

test('presets and followed sites move to rules, once', async () => {
  const data = fakeChrome({ conn: { port: 1, token: 't' }, settings: { minSize: 10, follow: ['refs.test'] }, dest: { last: null, presets: [{ id: 'p1', name: 'Faces', library: 'lib-b', folders: [2], tags: ['face'], sites: ['art.test'] }] } })
  await store.migrate()
  assert.equal('presets' in data.dest, false)
  assert.equal('follow' in data.settings, false)
  assert.equal(data.settings.minSize, 10)
  assert.deepEqual(data.dest.rules.map((r) => [r.name, r.library, r.follow]), [['Faces', 'lib-b', false], ['Follow pages', null, true]])
  await store.migrate()
  assert.equal(data.dest.rules.length, 2)
})

test('forgetting the connection keeps the port and drops what was kept of Curio', async () => {
  const data = fakeChrome({ conn: { port: 41800, token: 't' }, libraries: { list: [] }, theme: {}, 'lists:a': {}, settings: { minSize: 5 } })
  await store.forget()
  assert.deepEqual(data.conn, { port: 41800, token: '' })
  assert.deepEqual(Object.keys(data).sort(), ['conn', 'settings'])
})

test('theme mode supports light, dark, system, curio and migrates legacy appTheme', () => {
  assert.equal(store.themeModeOf({}), 'system')
  assert.equal(store.themeModeOf({ appTheme: true }), 'curio')
  assert.equal(store.themeModeOf({ themeMode: 'dark', appTheme: true }), 'dark')
  assert.deepEqual(store.themeSettings('curio'), { themeMode: 'curio', appTheme: true })
  assert.deepEqual(store.themeSettings('light'), { themeMode: 'light', appTheme: false })

  const props = new Map()
  const root = {
    dataset: {},
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
    },
  }
  store.applyTheme(root, 'curio', { dark: true, tokens: { bg: '#101010', accent: '#3b9160', 'font-size': '14px' } })
  assert.equal(root.dataset.theme, 'dark')
  assert.equal(props.get('--bg'), '#101010')
  assert.equal(props.has('--font-size'), false)
  store.applyTheme(root, 'light', null)
  assert.equal(root.dataset.theme, 'light')
  assert.equal(props.size, 0)
  store.applyTheme(root, 'system', null)
  assert.equal('theme' in root.dataset, false)
})

test('shortcuts merge defaults, preserve explicit clears, and format key events', async () => {
  fakeChrome({ settings: { shortcuts: { 'save-page': '', 'capture-visible': 'Ctrl+Shift+V' } } })
  const s = await store.settings()
  assert.equal(s.shortcuts['save-page'], '')
  assert.equal(s.shortcuts['quick-save'], 'Alt+Shift+S')
  assert.equal(s.shortcuts['capture-region'], 'Alt+Shift+A')
  assert.equal(s.shortcuts['capture-visible'], 'Ctrl+Shift+V')
  assert.equal(s.shortcuts['save-page-all'], '')

  assert.equal(store.formatShortcut({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyD', key: 'd' }), 'Alt+D')
  assert.equal(store.formatShortcut({ altKey: true, ctrlKey: false, shiftKey: true, metaKey: false, code: 'Digit1', key: '!' }), 'Alt+Shift+1')
  assert.equal(store.formatShortcut({ altKey: false, ctrlKey: true, shiftKey: false, metaKey: false, code: 'F8', key: 'F8' }), 'Ctrl+F8')
  assert.equal(store.formatShortcut({ altKey: false, ctrlKey: false, shiftKey: true, metaKey: false, code: 'KeyD', key: 'D' }), '')
  assert.equal(store.formatShortcut({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'AltLeft', key: 'Alt' }), '')
  assert.equal(store.formatShortcut({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyA', key: 'ą', getModifierState: (m) => m === 'AltGraph' }), '')
})
