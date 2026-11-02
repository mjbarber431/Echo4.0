// Saves the content some ACBS pages only link to. A page like the ACT ADVISOR's
// is a description with "click here to download", where the measure itself is a
// file, or sits on a second, members-only ACBS page. This downloads those files
// into ClinicalResources/ACBS/<id>/ and lists them in acbs-content.json, so the
// catalogue shows them as the resource's attachments (the viewer opens the first).
//
//   node scripts/follow-acbs-links.mjs pages [ClinicalResources]
//     Lists the members-only ACBS pages to read with a signed-in session, as JSON.
//
//   node scripts/follow-acbs-links.mjs fetch [found.json] [ClinicalResources]
//     Downloads the files pages link to directly, plus those found on the member
//     pages: found.json maps each page's URL to [{ url, label }] for its attachments.
//
// Then rebuild the catalogue with node scripts/catalog-resources.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [mode, ...rest] = process.argv.slice(2)
const foundPath = mode === 'fetch' && rest[0]?.endsWith('.json') ? rest.shift() : null
const root = rest[0] ?? 'ClinicalResources'
const CONTENT = join(root, 'ACBS', 'acbs-content.json')
const SITE = 'https://contextualscience.org'

const content = JSON.parse(readFileSync(CONTENT, 'utf8'))
const catalogued = new Set(JSON.parse(readFileSync('scripts/acbs-resources.json', 'utf8')).map((r) => r.url && norm(r.url)))

const FILE = /\.(pdf|docx?|rtf|pptx?|xlsx?|mp3|m4a)$/i
/** ACBS pages that are citations, articles, videos or site chrome rather than content. */
const NOT_CONTENT = /^\/+(article|publications|video|user|cdn-cgi|node\/\d+\/?$)|^\/+[A-Za-z]+_(et_?al_)?(\w+_)*\d{4}[a-z]?(_\d)?$/

function norm(u) {
  return u.trim().replace(/\/+$/, '').toLowerCase()
}

function absolute(href) {
  const h = href.replace(/&amp;/g, '&').trim()
  try {
    // contextualscience.org/files/x redirects to /sites/default/files/x, where saved files are listed.
    return new URL(h, `${SITE}/`).href.replace(/^https?:\/\/contextualscience\.org\/+files\//, `${SITE}/sites/default/files/`)
  } catch {
    return null
  }
}

const isFile = (u) => FILE.test(new URL(u).pathname) || new URL(u).pathname.startsWith('/sites/default/files/')

/** What each resource's page points to: files to download, and member pages that may hold them. */
function links(id) {
  const html = content.pages[id]?.html ?? ''
  const saved = content.saved[id] ?? []
  const have = new Set(saved.map((f) => absolute(f.url)))
  const files = []
  const pages = []
  for (const [, href] of html.matchAll(/href\s*=\s*"([^"]+)"/gi)) {
    const u = absolute(href)
    if (!u || !/^https?:/.test(u) || have.has(u)) continue
    if (isFile(u)) files.push(u)
    else if (new URL(u).hostname === 'contextualscience.org' && !saved.length && !catalogued.has(norm(u)) && !NOT_CONTENT.test(new URL(u).pathname)) pages.push(u)
  }
  return { files: [...new Set(files)], pages: [...new Set(pages)] }
}

const ids = Object.keys(content.pages)

if (mode === 'pages') {
  const pages = [...new Set(ids.flatMap((id) => links(id).pages))]
  console.log(JSON.stringify(pages, null, 1))
} else if (mode === 'fetch') {
  const found = foundPath ? JSON.parse(readFileSync(foundPath, 'utf8')) : {}
  const failed = []
  let added = 0
  for (const id of ids) {
    const { files, pages } = links(id)
    const want = [...files.map((url) => ({ url })), ...pages.flatMap((p) => (found[p] ?? []).map((f) => ({ ...f, url: absolute(f.url), via: p })))]
    const saved = (content.saved[id] ??= [])
    for (const f of want) {
      if (!f.url || saved.some((s) => absolute(s.url) === f.url)) continue
      const name = fileName(f.url, saved)
      try {
        const res = await fetch(f.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Echo library' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        if ((res.headers.get('content-type') ?? '').includes('text/html')) throw new Error('got a web page, not a file')
        mkdirSync(join(root, 'ACBS', id), { recursive: true })
        writeFileSync(join(root, 'ACBS', id, name), Buffer.from(await res.arrayBuffer()))
        saved.push({ name, label: f.label?.trim() || name, url: f.url, ...(f.via ? { via: f.via } : {}) })
        added++
        console.log(`${id}  ${name}`)
      } catch (e) {
        failed.push({ id, url: f.url, error: String(e.message ?? e) })
        console.warn(`${id}  failed: ${f.url} (${e.message ?? e})`)
      }
    }
  }
  content.linksFollowedAt = new Date().toISOString()
  content.linkFailures = failed
  writeFileSync(CONTENT, `${JSON.stringify(content, null, 1)}\n`)
  console.log(`${added} files saved, ${failed.length} failed. Now run: node scripts/catalog-resources.mjs`)
} else {
  console.error('Usage: node scripts/follow-acbs-links.mjs pages|fetch [found.json] [ClinicalResources]')
  process.exit(1)
}

/** The file's own name, made safe and unique among the resource's files. */
function fileName(url, saved) {
  let name = basename(decodeURIComponent(new URL(url).pathname)).replace(/[/\\:]/g, '-').replace(/^\.+/, '') || 'download'
  if (!/\.\w{2,4}$/.test(name)) name += '.pdf'
  const taken = new Set(saved.map((s) => s.name.toLowerCase()))
  const dot = name.lastIndexOf('.')
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name.slice(0, dot)} ${n}${name.slice(dot)}`
  return name
}
