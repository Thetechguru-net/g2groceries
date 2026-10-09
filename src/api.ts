// Client for the /api proxy in server/og-api.ts.

export interface Creds {
  email: string
  password: string
  /** Origin of the proxy server; empty means same origin as the page. */
  apiBase: string
}

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

const TIMEOUT_MS = 20_000

async function call<T>(creds: Creds, route: string, extra: Record<string, unknown> = {}): Promise<T> {
  const base = creds.apiBase.replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: creds.email, password: creds.password, ...extra }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new NetworkError((err as Error)?.message || 'Network unavailable')
  }
  const body = await res.json().catch(() => ({})) as { error?: string }
  if (res.ok) return body as T
  if (res.status === 401) throw new AuthError(body.error || 'Invalid email or password')
  if (res.status >= 500) throw new NetworkError(body.error || `Server error ${res.status}`)
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
}
