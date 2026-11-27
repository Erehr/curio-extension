// @ts-check
// Framed hidden by the toast or the panel, it frames the link that starts Curio; any site may frame this page, so it does so only when the worker granted a launch to its tab a moment ago.
import { M } from '../lib/messages.js'
import * as store from '../lib/store.js'

/** The link the worker granted, or null. */
async function granted() {
  // the toast's click reaches the worker beside this frame, and may land after it asks
  for (let i = 0; i < 8; i++) {
    const link = await chrome.runtime.sendMessage({ type: M.launchCheck }).catch(() => false)
    if (typeof link === 'string' && link.startsWith('curio://')) return link
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

granted().then(async (link) => {
  if (!link) return
  const f = document.createElement('iframe')
  // tools/ext.mjs's browser has nobody to answer the browser's question about the link, which then holds the page's input: a sandboxed frame asks nothing
  if ((await store.settings()).loopbackPort) f.setAttribute('sandbox', '')
  f.src = link
  document.body.append(f)
})
