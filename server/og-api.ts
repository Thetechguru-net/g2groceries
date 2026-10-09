// JSON API that wraps the (Node-only) `ourgroceries` client.
//
// The glasses app runs in a WebView, and ourgroceries.com neither sends CORS
// headers nor offers a token API (sign-in is an HTML form + cookie), so the
// WebView cannot talk to it directly. This handler runs on Node — inside the
// Vite dev server during development, or via server/standalone.ts — and the
// app POSTs JSON to it.
//
// Every request carries { email, password }. The server keeps one logged-in
// OurGroceries client per credential pair in memory and re-logs-in on demand,
// so it holds no state that matters across restarts.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { OurGroceries } from 'ourgroceries'

interface Creds { email: string; password: string }

const clients = new Map<string, OurGroceries>()
const categoryCache = new Map<string, { at: number; categories: { id: string; name: string }[] }>()
const CATEGORY_TTL_MS = 5 * 60 * 1000

function keyFor(c: Creds): string {
  return createHash('sha256').update(`${c.email.toLowerCase()}\0${c.password}`).digest('hex')
}

async function clientFor(c: Creds): Promise<OurGroceries> {
  const key = keyFor(c)
  let og = clients.get(key)
  if (!og) {
    og = new OurGroceries({ username: c.email, password: c.password })
    clients.set(key, og)
  }
  try {
    await og.login()
  } catch (err) {
    clients.delete(key)
    throw err
  }
  return og
}

/** Run a command; if the session has gone stale, log in afresh and retry once. */
async function withClient<T>(c: Creds, fn: (og: OurGroceries) => Promise<T>): Promise<T> {
  const og = await clientFor(c)
  try {
    return await fn(og)
  } catch (err) {
    if (isAuthError(err)) throw err
    clients.delete(keyFor(c))
    return fn(await clientFor(c))
  }
}

async function categories(c: Creds, og: OurGroceries) {
  const key = keyFor(c)
  const hit = categoryCache.get(key)
  if (hit && Date.now() - hit.at < CATEGORY_TTL_MS) return hit.categories
  const res = await og.getCategoryItems()
  const cats = (res.list?.items ?? []).map((i) => ({ id: String(i.id), name: String(i.value) }))
  categoryCache.set(key, { at: Date.now(), categories: cats })
  return cats
}

/** Bad credentials, as opposed to a network failure that happened during login. */
function isAuthError(err: unknown): boolean {
  const e = err as Error
  return e?.name === 'InvalidLoginException' && !/^Login transport error/.test(e.message)
}

type Body = Partial<Creds> & Record<string, unknown>

const routes: Record<string, (c: Creds, body: Body) => Promise<unknown>> = {
  async login(c) {
    await clientFor(c)
    return { ok: true }
  },

  async lists(c) {
    return withClient(c, async (og) => {
      const overview = await og.getMyLists()
      const lists = await Promise.all((overview.shoppingLists ?? []).map(async (l) => {
        const id = String(l.id)
        const { list } = await og.getListItems(id)
        return {
          id,
          name: String(l.name),
          activeCount: (list.items ?? []).filter((item) => !item.crossedOff).length,
        }
      }))
      return { lists }
    })
  },

  async list(c, body) {
    const listId = String(body.listId ?? '')
    if (!listId) throw new HttpError(400, 'listId required')
    return withClient(c, async (og) => {
      const [res, cats] = await Promise.all([og.getListItems(listId), categories(c, og)])
      return {
        id: listId,
        name: String(res.list?.name ?? ''),
        categories: cats,
        // Server order is preserved; the client relies on it as a tiebreaker.
        items: (res.list?.items ?? []).filter((i) => !i.crossedOff).map((i) => ({
          id: String(i.id),
          value: String(i.value ?? ''),
          categoryId: i.categoryId ? String(i.categoryId) : undefined,
          crossedOff: false,
          note: i.note ? String(i.note) : undefined,
        })),
      }
    })
  },

  async toggle(c, body) {
    const listId = String(body.listId ?? '')
    const itemId = String(body.itemId ?? '')
    if (!listId || !itemId) throw new HttpError(400, 'listId and itemId required')
    await withClient(c, (og) => og.toggleItemCrossedOff(listId, itemId, Boolean(body.crossedOff)))
    return { ok: true }
  },

  async 'clear-crossed-off'(c, body) {
    const listId = String(body.listId ?? '')
    if (!listId) throw new HttpError(400, 'listId required')
    await withClient(c, (og) => og.deleteAllCrossedOffFromList(listId))
    return { ok: true }
  },
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > 64 * 1024) reject(new HttpError(413, 'Body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

/** Handles /api/<route>. Returns false if the URL is not an API route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x')
  const match = /^\/api\/([a-z-]+)$/.exec(url.pathname)
  if (!match) return false

  // The packaged app is served from a different origin than this server.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true }

  const route = routes[match[1]]
  if (!route) { send(res, 404, { error: 'Unknown route' }); return true }
  if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true }

  try {
    const body = JSON.parse((await readBody(req)) || '{}') as Body
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!email || !password) throw new HttpError(400, 'email and password required')
    send(res, 200, await route({ email, password }, body))
  } catch (err) {
    const e = err as Error
    const status = err instanceof HttpError ? err.status
      : isAuthError(err) ? 401
      : 502
    send(res, status, { error: e?.message ?? String(err), auth: status === 401 })
  }
  return true
}
