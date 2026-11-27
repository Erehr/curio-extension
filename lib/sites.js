// @ts-check
// Addresses for a larger version of a picture, tried before the one the page shows. Rules are data; anything beyond a rewrite of the address belongs in a userscript that sets data-curio-src.

/** @typedef {{ name: string, match: (u: URL) => boolean, make: (u: URL) => string[] }} Rule */

/** @type {Rule[]} */
export const RULES = [
  {
    // Next.js and Vercel's image optimiser carry the original in `url`
    name: 'next-image',
    match: (u) => /\/_(next|vercel)\/image\/?$/.test(u.pathname) && u.searchParams.has('url'),
    make: (u) => [new URL(/** @type {string} */ (u.searchParams.get('url')), u).href],
  },
  {
    // images.weserv.nl and wsrv.nl proxies
    name: 'weserv',
    match: (u) => /^(images\.weserv\.nl|wsrv\.nl)$/.test(u.hostname) && u.searchParams.has('url'),
    make: (u) => {
      const raw = /** @type {string} */ (u.searchParams.get('url'))
      return [/^https?:\/\//.test(raw) ? raw : 'https://' + raw.replace(/^\/\//, '')]
    },
  },
  {
    // Wikimedia Commons and Wikipedia: /thumb/a/ab/File.jpg/220px-File.jpg is the original File.jpg scaled
    // only where the thumbnail keeps the original's name and type; a thumb of a PDF, TIFF, video or SVG (File.pdf/…-File.pdf.jpg) would give that file instead of a picture
    name: 'wikimedia',
    match: (u) => {
      const m = u.hostname === 'upload.wikimedia.org' && u.pathname.match(/\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)\/([^/]+)$/)
      return !!m && m[2].endsWith('-' + m[1]) && /\.(jpe?g|png|gif|webp)$/i.test(m[1])
    },
    make: (u) => [new URL(u.pathname.replace(/\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+)\/[^/]+$/, '$1'), u.origin).href],
  },
  {
    // X (Twitter): the size is `name`, or a `:large` suffix on older addresses; `orig` is the upload itself
    name: 'twimg',
    match: (u) => u.hostname === 'pbs.twimg.com' && /^\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(u.pathname) && u.searchParams.get('name') !== 'orig' && !/:orig$/.test(u.pathname),
    make: (u) => {
      const v = new URL(u.href)
      if (/:[a-z0-9]+$/i.test(v.pathname)) v.pathname = v.pathname.replace(/:[a-z0-9]+$/i, ':orig')
      else v.searchParams.set('name', 'orig')
      return [v.href]
    },
  },
  {
    // Pinterest: the first folder is the size (236x, 736x, 60x60…); originals holds the upload
    name: 'pinimg',
    match: (u) => u.hostname === 'i.pinimg.com' && /^\/\d+x(\d+)?(_[a-z]+)?\//i.test(u.pathname),
    make: (u) => [new URL(u.pathname.replace(/^\/[^/]+\//, '/originals/'), u.origin).href],
  },
  {
    // Reddit's resized preview of a picture on i.redd.it has the same name there
    name: 'reddit-preview',
    match: (u) => u.hostname === 'preview.redd.it' && /^\/[a-z0-9]+\.(jpe?g|png|gif|webp)$/i.test(u.pathname),
    make: (u) => ['https://i.redd.it' + u.pathname],
  },
]

/**
 * The addresses to try for a picture, largest first, with the one the page shows last.
 * @param {string} src
 * @param {Rule[]} [rules]
 */
export function candidates(src, rules = RULES) {
  const out = []
  let u
  try {
    u = new URL(src)
  } catch {
    return src ? [src] : []
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    for (const r of rules) {
      try {
        if (r.match(u)) out.push(...r.make(u))
      } catch {}
    }
  }
  out.push(src)
  return [...new Set(out.filter((x) => /^(https?|blob|data):/i.test(x)))]
}
