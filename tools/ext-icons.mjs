// Writes panel/tabler.json: the body of every Tabler icon by name, from the web/node_modules of Curio's checkout, for the icons folders carry in the extension's panel.
// node tools/ext-icons.mjs      after Curio updates @iconify-json/tabler
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Curio's checkout: the folder beside this one unless CURIO_APP names another
const APP = path.resolve(process.env.CURIO_APP || path.join(ROOT, '..', 'app'))
const set = JSON.parse(fs.readFileSync(path.join(APP, 'web', 'node_modules', '@iconify-json', 'tabler', 'icons.json'), 'utf8'))
const out = {}
for (const [name, icon] of Object.entries(set.icons)) out[name] = icon.body
for (const [name, alias] of Object.entries(set.aliases || {})) if (out[alias.parent] && !out[name]) out[name] = out[alias.parent]
const file = path.join(ROOT, 'panel', 'tabler.json')
fs.writeFileSync(file, JSON.stringify(out) + '\n')
console.log(`${Object.keys(out).length} icons, ${Math.round(fs.statSync(file).size / 1024)} KB`)
