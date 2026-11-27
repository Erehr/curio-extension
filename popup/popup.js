// @ts-check
// The toolbar button's menu: the panel, the page's own saves, how pictures take the pointer, and Options.
import * as store from '../lib/store.js'
import * as connection from '../lib/connection.js'
import { M } from '../lib/messages.js'
import { S } from '../lib/strings.js'
import { icon } from '../panel/icons.js'

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

async function start() {
  const s = await store.settings()
  store.applyTheme(document.documentElement, store.themeModeOf(s), await store.theme())
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const menu = $('menu')
  const item = (ico, label, run, end = null) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'item'
    const text = document.createElement('span')
    text.className = 'label'
    text.textContent = label
    b.append(icon(ico, 16), text)
    if (end) b.append(end)
    b.addEventListener('click', run)
    menu.append(b)
    return b
  }
  const line = () => menu.append(document.createElement('hr'))
  const run = (name) => () => {
    chrome.runtime.sendMessage({ type: M.popupRun, name, tabId: tab?.id ?? null, windowId: tab?.windowId ?? null }).catch(() => {})
    close()
  }

  const keys = store.shortcutsOf(s)
  const kbd = (cmd) => {
    const v = keys[cmd]
    if (!v) return null
    const el = document.createElement('span')
    el.className = 'end kbd'
    el.textContent = v
    return el
  }

  if (chrome.sidePanel?.open) {
    item('layout-sidebar-right', S.popupPanel, () => {
      // the side panel opens only while this click still counts, so before anything is awaited
      if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {})
      close()
    })
  } else {
    item('app-window', S.popupPanel, () => {
      chrome.runtime.sendMessage({ type: M.popupRun, name: 'open-panel', tabId: tab?.id ?? null, windowId: tab?.windowId ?? null }).catch(() => {})
      close()
    })
  }
  line()
  item('link', S.menuPage, run('save-page'), kbd('save-page'))
  item('crop', S.menuShotArea, run('capture-region'), kbd('capture-region'))
  item('screenshot', S.menuShot, run('capture-visible'), kbd('capture-visible'))
  line()
  const choice = (ico, label, options, value, change) => {
    const select = document.createElement('select')
    select.setAttribute('aria-label', label)
    for (const [v, text] of options) select.append(new Option(text, v))
    select.value = value
    select.addEventListener('change', () => change(select.value))
    const row = document.createElement('label')
    row.className = 'item mode'
    const text = document.createElement('span')
    text.className = 'label'
    text.textContent = label
    row.append(icon(ico, 16), text, select)
    menu.append(row)
  }
  // pictures take the pointer with the drag card, the button at their corner, or neither
  choice('drag-drop', S.popupMode, store.MODES, store.modeOf(s), (v) => store.setSettings(store.modeSettings(v)))
  line()
  item('settings', S.popupOptions, () => {
    chrome.runtime.openOptionsPage()
    close()
  }, icon('chevron-right', 14))

  const c = await store.conn()
  const off = (text) => {
    $('off').textContent = text
    $('off').hidden = !text
  }
  if (!c.token) return off(S.noToken)
  const st = await connection.state(c, 1500).catch(() => ({ state: 'off' }))
  off(st.state === 'up' ? '' : st.state === 'refused' ? S.refused : S.off)
}

document.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || document.activeElement?.tagName === 'SELECT') return
  e.preventDefault()
  const items = [...document.querySelectorAll('button.item, .item select')]
  const i = items.indexOf(/** @type {Element} */ (document.activeElement))
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
  /** @type {HTMLElement} */ (next)?.focus()
})

start()
