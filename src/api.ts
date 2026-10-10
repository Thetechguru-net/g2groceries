// Client for the /api proxy in server/og-api.ts.
import { log } from './log'

export interface Creds {
  email: string
  password: string
  /** Origin of the proxy server; empty means DEFAULT_API_BASE. */
  apiBase: string
}

/** The Android companion proxy, which listens only on the phone's loopback. */
export const DEFAULT_API_BASE = 'http://127.0.0.1:42225/'

export interface ListSummary { id: string; name: string; activeCount?: number }
export interface Category { id: string; name: string }
export interface Item { id: string; value: string; categoryId?: string; crossedOff: boolean; note?: string }
export interface ListData { id: string; name: string; categories: Category[]; items: Item[] }

export function withoutCrossedOffItems(list: ListData): ListData {
  return { ...list, items: list.items.filter((item) => !item.crossedOff) }
}

/** Wrong email or password. */
export class AuthError extends Error { override name = 'AuthError' }
/** Could not reach the proxy, or the proxy could not reach OurGroceries. Safe to retry. */
export class NetworkError extends Error { override name = 'NetworkError' }
/** The proxy answered with a 5xx: it is reachable but the request failed. Safe to retry. */
export class ServerError extends NetworkError { override name = 'ServerError' }

const TIMEOUT_MS = 20_000

async function call<T>(creds: Creds, route: string, extra: Record<string, unknown> = {}): Promise<T> {
  const base = (creds.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  const what = `${route}${extra.listId ? ` list=${String(extra.listId)}` : ''}`
  const started = Date.now()
  const ms = () => `${Date.now() - started} ms`
  // text/plain keeps this a CORS "simple" request: no OPTIONS preflight, which
  // the WebView failed on the first call to each route. Both proxies parse the
  // body as JSON regardless of content type.
  const send = () => fetch(`${base}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ email: creds.email, password: creds.password, ...extra }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  let res: Response
  try {
    try {
      res = await send()
    } catch (err) {
      // Every route is safe to repeat; retry once in case a stale connection was reused.
      if ((err as Error)?.name === 'TimeoutError') throw err
      log.warn(`${what} → no response after ${ms()}: ${(err as Error)?.message}; retrying`)
      await new Promise((resolve) => setTimeout(resolve, 250))
      res = await send()
    }
  } catch (err) {
    const message = (err as Error)?.message || 'Network unavailable'
    log.error(`${what} → no response after ${ms()}: ${message}`)
    throw new NetworkError(message)
  }
  const body = await res.json().catch(() => ({})) as { error?: string }
  if (res.ok) {
    log.info(`${what} → ${res.status} in ${ms()}`)
    return body as T
  }
  log.error(`${what} → ${res.status} in ${ms()}: ${body.error ?? '(no message)'}`)
  if (res.status === 401) throw new AuthError(body.error || 'Invalid email or password')
  if (res.status >= 500) throw new ServerError(body.error || `Server error ${res.status}`)
  throw new Error(body.error || `Request failed (${res.status})`)
}

export const api = {
  login: (c: Creds) => call<{ ok: true }>(c, 'login'),
  lists: (c: Creds) => call<{ lists: ListSummary[] }>(c, 'lists').then((r) => r.lists),
  list: async (c: Creds, listId: string): Promise<ListData> => {
    return withoutCrossedOffItems(await call<ListData>(c, 'list', { listId }))
  },
  clearCrossedOff: (c: Creds, listId: string) =>
    call<{ ok: true }>(c, 'clear-crossed-off', { listId }),
  toggle: (c: Creds, listId: string, itemId: string, crossedOff: boolean) =>
    call<{ ok: true }>(c, 'toggle', { listId, itemId, crossedOff }),
  /** Recent log lines from the Android companion (not available from the Node proxy). */
  serverLog: (c: Creds) => call<{ lines: string[] }>(c, 'log').then((r) => r.lines),
}
