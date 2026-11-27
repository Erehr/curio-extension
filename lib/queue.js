// @ts-check
// Captures waiting for Curio, with their bytes, in IndexedDB: they last through a browser restart and an extension reload. The sender, the worker and Options share it.

/**
 * @typedef {{ id: string, rec: any, file: { blob: Blob, name: string } | null, size: number, at: number, why: 'off' | 'unknown' }} Entry
 */

const DB = 'curio'
const STORE = 'queue'

/** @type {Promise<IDBDatabase> | null} */
let opened = null

function db() {
  opened ||= new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' })
    r.onsuccess = () => ok(r.result)
    r.onerror = () => {
      opened = null
      no(r.error)
    }
  })
  return opened
}

/** @param {(s: IDBObjectStore) => IDBRequest} f */
async function run(mode, f) {
  const d = await db()
  return new Promise((ok, no) => {
    const tx = d.transaction(STORE, mode)
    const r = f(tx.objectStore(STORE))
    tx.oncomplete = () => ok(r.result)
    tx.onerror = () => no(tx.error)
    tx.onabort = () => no(tx.error)
  })
}

/** @param {Entry} e */
export const put = (e) => run('readwrite', (s) => s.put(e))
/** @returns {Promise<Entry | undefined>} */
export const get = (id) => run('readonly', (s) => s.get(id))
/** @returns {Promise<Entry[]>} */
export const all = () => run('readonly', (s) => s.getAll())
export const drop = (id) => run('readwrite', (s) => s.delete(id))
export const clear = () => run('readwrite', (s) => s.clear())

/** What the queue holds, in bytes. */
export async function size() {
  return (await all()).reduce((n, e) => n + (e.size || 0), 0)
}
