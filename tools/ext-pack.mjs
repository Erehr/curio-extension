// Packs the extension for handing out: every shipped file and the licence, as target/send-to-curio-<version>.zip, with the same tree beside it to load unpacked.
// --store leaves out the manifest's `key`, since a store gives the extension an id of its own; the tree beside keeps it, so tools/ext.mjs --ext can run against it.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = ROOT
const OUT = path.join(ROOT, 'target')
// tests, store texts, tools, this repository's own files and the editor's module flag never ship
const LEAVE = new Set(['test', 'store', 'tools', 'target', 'node_modules', 'package.json', 'README.md', 'LICENSE'])
const store = process.argv.includes('--store')

function walk(dir, rel = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.name.startsWith('.') || (!rel && LEAVE.has(e.name))) continue
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r))
    else if (e.isFile()) out.push(r)
  }
  return out
}

const manifestText = fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')
const manifest = JSON.parse(manifestText)
const files = walk(SRC).map((name) => ({ name, data: fs.readFileSync(path.join(SRC, name)) }))
files.push({ name: 'LICENSE', data: fs.readFileSync(path.join(ROOT, 'LICENSE')) })

// everything the manifest names is there, and the script registered at run time too
const named = [
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.background?.service_worker,
  manifest.options_ui?.page,
  manifest.action?.default_popup,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources),
  'content/hover.js',
  'sender/sender.html',
].filter(Boolean).map((p) => p.split('?')[0])
const have = new Set(files.map((f) => f.name))
const missing = named.filter((p) => !have.has(p))
if (missing.length) {
  console.error('missing from the package: ' + missing.join(', '))
  process.exit(1)
}

const base = `send-to-curio-${manifest.version}`
const dir = path.join(OUT, base)
fs.rmSync(dir, { recursive: true, force: true })
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true })
  fs.writeFileSync(path.join(dir, f.name), f.data)
}

if (store) {
  delete manifest.key
  const i = files.findIndex((f) => f.name === 'manifest.json')
  files[i] = { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// a fixed date, so the same files make the same zip
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1
const locals = []
const central = []
let offset = 0
for (const f of files) {
  const name = Buffer.from(f.name, 'utf8')
  const packed = zlib.deflateRawSync(f.data, { level: 9 })
  const crc = crc32(f.data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt16LE(DOS_TIME, 10)
  local.writeUInt16LE(DOS_DATE, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(packed.length, 18)
  local.writeUInt32LE(f.data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  locals.push(local, name, packed)
  const entry = Buffer.alloc(46)
  entry.writeUInt32LE(0x02014b50, 0)
  entry.writeUInt16LE(20, 4)
  entry.writeUInt16LE(20, 6)
  entry.writeUInt16LE(0x0800, 8)
  entry.writeUInt16LE(8, 10)
  entry.writeUInt16LE(DOS_TIME, 12)
  entry.writeUInt16LE(DOS_DATE, 14)
  entry.writeUInt32LE(crc, 16)
  entry.writeUInt32LE(packed.length, 20)
  entry.writeUInt32LE(f.data.length, 24)
  entry.writeUInt16LE(name.length, 28)
  entry.writeUInt32LE(offset, 42)
  central.push(entry, name)
  offset += local.length + name.length + packed.length
}
const centralSize = central.reduce((n, b) => n + b.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)
const zip = path.join(OUT, `${base}${store ? '-store' : ''}.zip`)
fs.writeFileSync(zip, Buffer.concat([...locals, ...central, end]))
console.log(`${files.length} files, ${Math.round(fs.statSync(zip).size / 1024)} KB: ${path.relative(ROOT, zip)}`)
console.log(`unpacked: ${path.relative(ROOT, dir)}`)
