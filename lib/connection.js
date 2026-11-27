// @ts-check
// Where Curio is, whether it answers, and what the token may do. Needs no chrome.* API, so every context can use it.

/** @typedef {{ port: number, token: string }} Conn */
/** @typedef {{ state: 'up' | 'no-token' | 'refused' | 'off', info?: any, message?: string }} ConnState */

export const base = (conn) => `http://127.0.0.1:${Number(conn.port) || 41733}/api/v1/`

/**
 * One quick call, `app.info`, decides the state.
 * @param {Conn} conn
 * @returns {Promise<ConnState>}
 */
export async function state(conn, timeout = 3000) {
  if (!conn || !conn.token) return { state: 'no-token' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  let r
  try {
    r = await fetch(base(conn) + 'app/info', { method: 'POST', headers: { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'application/json' }, body: '{}', signal: ctrl.signal })
  } catch {
    return { state: 'off' }
  } finally {
    clearTimeout(timer)
  }
  let body = null
  try {
    body = await r.json()
  } catch {}
  if (r.status === 200 && body && body.name === 'Curio') return { state: 'up', info: body }
  if ((r.status === 401 || r.status === 403) && body && body.error) return { state: 'refused', message: body.error.message }
  return { state: 'off' }
}

/** @param {Conn} conn */
export function client(conn) {
  return /** @type {any} */ (globalThis).Curio.connect({ token: conn.token, port: Number(conn.port) || 41733, transport: 'fetch' })
}

/**
 * What this token may call, from `app.operations`; features are gated on this list, never on versions.
 * @returns {Promise<{ ops: Set<string>, params: Record<string, string[]> }>}
 */
export async function capabilities(curio) {
  const list = await curio.app.operations()
  return { ops: new Set(list.map((o) => o.name)), params: Object.fromEntries(list.map((o) => [o.name, Object.keys(o.params?.properties || {})])) }
}

/**
 * Sends a file past the JSON cap as the body of `POST /upload`, from a page or the sender (XHR, for its progress); answers the id `item.add.fromBytes` takes.
 * @param {Conn} conn
 * @param {Blob} blob
 * @param {(part: number) => void} onProgress
 * @returns {Promise<string>}
 */
export function upload(conn, blob, name, onProgress = () => {}) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest()
    x.open('POST', base(conn) + 'upload?name=' + encodeURIComponent(name))
    x.setRequestHeader('Authorization', 'Bearer ' + conn.token)
    x.setRequestHeader('Content-Type', 'application/octet-stream')
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    x.onload = () => {
      let body = null
      try {
        body = JSON.parse(x.responseText)
      } catch {}
      if (x.status === 200 && body?.upload) ok(body.upload)
      else no(new Error(body?.error?.message || `The upload failed (${x.status})`))
    }
    x.onerror = () => no(new Error('The upload broke off'))
    x.send(blob)
  })
}

/** Retries a call while Curio answers `busy`, as a closed library does while it opens: every 2 s for 40 s. */
export async function whileBusy(fn, { every = 2000, upTo = 40000, onBusy = () => {} } = {}) {
  const until = Date.now() + upTo
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      if (e?.code !== 'busy' || Date.now() + every > until) throw e
      onBusy()
      await new Promise((r) => setTimeout(r, every))
    }
  }
}
