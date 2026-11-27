// @ts-check
// File names and titles for what is saved.

const EXT_OF = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/heic': 'heic', 'image/heif': 'heif', 'image/jxl': 'jxl',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/webm': 'weba',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-7z-compressed': '7z', 'application/x-rar-compressed': 'rar', 'application/epub+zip': 'epub',
}
const TYPE_OF = Object.fromEntries(Object.entries(EXT_OF).map(([t, e]) => [e, t]))
Object.assign(TYPE_OF, { jpeg: 'image/jpeg', jfif: 'image/jpeg', tiff: 'image/tiff', m4v: 'video/mp4', cbz: 'application/zip', cbr: 'application/x-rar-compressed', psd: '', kra: '', blend: '', txt: '', md: '', json: '' })

/** @param {string} type */
export function extOfType(type) {
  return EXT_OF[String(type || '').split(';')[0].trim().toLowerCase()] || ''
}

/** jpeg and jpg, tiff and tif are the same file type. */
function canonical(ext) {
  return extOfType(TYPE_OF[ext] || '') || ext
}

/** The extension of an address's last segment, when it is one of the known file types. */
export function extOfUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
    const m = last.match(/\.([a-z0-9]{1,5})$/i)
    const ext = m ? m[1].toLowerCase() : ''
    return ext in TYPE_OF ? ext : ''
  } catch {
    return ''
  }
}

/** The name in a Content-Disposition header, `filename*` first. */
export function dispositionName(header) {
  if (!header) return ''
  const star = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i)
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))
    } catch {}
  }
  const plain = header.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i)
  return plain ? (plain[2] ?? plain[1]).trim() : ''
}

/** The last segment of an address, decoded, without its extension. */
export function baseOfUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
    return last.replace(/\.[a-z0-9]{1,5}$/i, '')
  } catch {
    return ''
  }
}

/** A title made safe as a file name: no characters Windows refuses, no control characters, at most 120 characters. */
export function cleanTitle(title) {
  return String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim()
}

/**
 * `<title>.<ext>`: the extension from the address, else from Content-Disposition, else from the type; a type that contradicts the address wins, since sites serve another format than the address says.
 * @param {{ title?: string, url?: string, type?: string, disposition?: string }} p
 */
export function fileName({ title = '', url = '', type = '', disposition = '' }) {
  const fromDisposition = dispositionName(disposition)
  const typeExt = extOfType(type)
  let ext = extOfUrl(url)
  if (!ext && fromDisposition) ext = (fromDisposition.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase()
  if (typeExt && (!ext || (TYPE_OF[ext] && canonical(ext) !== typeExt))) ext = typeExt
  const base = cleanTitle(title) || cleanTitle(fromDisposition.replace(/\.[a-z0-9]{1,5}$/i, '')) || cleanTitle(baseOfUrl(url)) || 'download'
  return `${base}.${ext || 'bin'}`
}
