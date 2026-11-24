// A fake EHR for trying out placing notes with Claude, with made-up patients only.
// npm run fake-ehr, then add http://localhost:5179 in Settings › EHRs.
// Served on this Mac only (127.0.0.1); nothing typed into it leaves the browser.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 5179

// The page is read on every request, so edits to it show up on reload without restarting.
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(readFileSync(join(here, 'index.html')))
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Fake EHR at http://localhost:${PORT} (made-up patients only). Ctrl+C to stop.`)
})
