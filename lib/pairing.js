// @ts-check
// Setup by approval: Curio's window asks the person to allow this extension, beside a code shown here as well.
import { base } from './connection.js'

/** Four digits for the person to compare. */
export const newCode = () => String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000))

/** The name the token gets in Curio, with the browser it lives in. */
export function appName() {
  const brands = (/** @type {any} */ (navigator).userAgentData?.brands || []).map((b) => b.brand).join(' ')
  const browser = /Edge/.test(brands) ? 'Edge' : /Opera/.test(brands) ? 'Opera' : /Brave/.test(brands) ? 'Brave' : 'Chrome'
  return `Send to Curio (${browser})`
}

/** Whether Curio answers on this port; needs no token. */
export async function ping(port) {
  try {
    const r = await fetch(base({ port, token: '' }) + 'ping')
    return (await r.json())?.name === 'Curio'
  } catch {
    return false
  }
}

/**
 * Asks Curio for a token, from an extension page: the person decides in Curio, for up to two minutes, longer than a worker lives.
 * @returns {Promise<{ token: string, libraries: string[] } | { error: string, message: string }>}
 */
export async function pair(port, code, name = appName()) {
  let r
  try {
    r = await fetch(base({ port, token: '' }) + 'pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }) })
  } catch {
    return { error: 'off', message: '' }
  }
  let body = null
  try {
    body = await r.json()
  } catch {}
  if (r.ok && body?.token) return { token: body.token, libraries: body.libraries || [] }
  return { error: body?.error?.code || 'failed', message: body?.error?.message || `Curio answered ${r.status}` }
}
