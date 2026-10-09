// Production server: serves the built app from dist/ and the /api proxy.
//   npm run build && npm start         (PORT defaults to 8787)
// Node >= 22.18 runs this .ts file directly (type stripping).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApi } from './og-api.ts'

const PORT = Number(process.env.PORT ?? 8787)
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}

createServer(async (req, res) => {
  if (await handleApi(req, res)) return
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const file = normalize(join(DIST, path === '/' ? 'index.html' : path))
  if (!file.startsWith(DIST)) { res.statusCode = 403; res.end(); return }
  try {
    const body = await readFile(file)
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('Not found')
  }
}).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`))
