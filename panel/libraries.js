// @ts-check
// The library selector: every library on the list with its state; offline ones can't be chosen, and a chosen one that is gone shows as missing.
import { libraryKey } from '../lib/destinations.js'
import { S } from '../lib/strings.js'

/**
 * @param {HTMLSelectElement} select
 * @param {any[]} list
 * @param {string | null} chosen
 * @param {string} [missingName]
 */
export function render(select, list, chosen, missingName) {
  const options = list.map((l) => {
    const o = new Option(`${l.name} · ${S.states[l.state] || l.state}`, libraryKey(l))
    o.disabled = l.state === 'offline'
    return o
  })
  if (chosen && !list.some((l) => libraryKey(l) === chosen)) {
    const o = new Option(`${missingName || chosen} · ${S.missingLibrary}`, chosen)
    o.disabled = true
    options.unshift(o)
  }
  select.replaceChildren(...options)
  if (chosen) select.value = chosen
}

/** The first choice: the capture's destination, else the last library used, else the default one; never another in place of one that is gone. */
export function firstChoice(list, wanted, last) {
  if (wanted) return wanted
  if (last) return last
  const d = list.find((l) => l.default && l.state !== 'offline') || list.find((l) => l.state !== 'offline')
  return d ? libraryKey(d) : null
}
