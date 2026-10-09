// App state, local persistence, and OurGroceries synchronisation.
//
// Crossing items off is local-first: the change is applied and saved locally
// right away, queued in `pending`, then pushed to OurGroceries. If the push
// fails (offline, server down) the change stays queued and the whole queue is
// retried after every later change and on "Sync all".
import { api, AuthError, NetworkError, withoutCrossedOffItems, type Creds, type ListData, type ListSummary } from './api'
import { load, remove, save } from './storage'

interface PendingChange { listId: string; itemId: string; crossedOff: boolean }

const K = {
  creds: 'og.creds',
  lists: 'og.lists',
  pending: 'og.pending',
  checkedAt: 'og.checkedAt',
  list: (id: string) => `og.list.${id}`,
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error'

export const state = {
  creds: null as Creds | null,
  lists: [] as ListSummary[],
  list: null as ListData | null,
  /** Unsynced changes keyed by `${listId}:${itemId}`; the latest wins. */
  pending: {} as Record<string, PendingChange>,
  /** When this device crossed an item off, so the checked section can show newest first. */
  checkedAt: {} as Record<string, number>,
  status: 'idle' as SyncStatus,
  message: '',
  /** Set when stored credentials were rejected; the phone shows the sign-in form again. */
  authFailed: false,
}

type Listener = () => void
const listeners = new Set<Listener>()
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function emit(): void {
  for (const fn of listeners) fn()
}

function setStatus(status: SyncStatus, message = ''): void {
  state.status = status
  state.message = message
  emit()
}

export const pendingCount = () => Object.keys(state.pending).length

/** Classify a failure, update status, and report whether it was recoverable. */
function handleError(err: unknown): void {
  if (err instanceof AuthError) {
    state.authFailed = true
    setStatus('error', 'Sign-in rejected')
  } else if (err instanceof NetworkError) {
    setStatus('offline', 'Offline')
  } else {
    setStatus('error', (err as Error)?.message || 'Error')
  }
}

// ---------------------------------------------------------------- startup

export async function init(): Promise<void> {
  const [creds, lists, pending, checkedAt] = await Promise.all([
    load<Creds>(K.creds),
    load<ListSummary[]>(K.lists),
    load<Record<string, PendingChange>>(K.pending),
    load<Record<string, number>>(K.checkedAt),
  ])
  state.creds = creds
  state.lists = lists ?? []
  state.pending = pending ?? {}
  state.checkedAt = checkedAt ?? {}
  emit()
}

// ---------------------------------------------------------------- auth

export async function signIn(creds: Creds): Promise<void> {
  await api.login(creds) // throws AuthError / NetworkError for the form to show
  state.creds = creds
  state.authFailed = false
  await save(K.creds, creds)
  emit()
}

/** Forget credentials and every cached list, including unsynced changes. */
export async function signOut(): Promise<void> {
  const ids = new Set([...state.lists.map((l) => l.id), ...(state.list ? [state.list.id] : [])])
  state.creds = null
  state.lists = []
  state.list = null
  state.pending = {}
  state.checkedAt = {}
  state.authFailed = false
  state.status = 'idle'
  state.message = ''
  emit()
  await Promise.all([
    remove(K.creds), remove(K.lists), remove(K.pending), remove(K.checkedAt),
    ...[...ids].map((id) => remove(K.list(id))),
  ])
}

// ---------------------------------------------------------------- lists

export async function refreshLists(): Promise<void> {
  const creds = state.creds
  if (!creds) return
  setStatus('syncing')
  try {
    const lists = await api.lists(creds)
    if (state.creds !== creds) return
    state.lists = lists
    await save(K.lists, lists)
    setStatus('idle')
  } catch (err) {
    handleError(err)
  }
}

/** Delete the list's checked items, then fetch it; fall back to the cached copy. */
export async function openList(id: string): Promise<void> {
  const summary = state.lists.find((l) => l.id === id)
  state.list = { id, name: summary?.name ?? '', categories: [], items: [] }
  setStatus('syncing')
  const synced = await syncAll()
  if (!synced && state.list?.id === id) {
    const cached = await load<ListData>(K.list(id))
    if (cached && state.list?.id === id) {
      state.list = withoutCrossedOffItems(cached)
      await save(K.list(id), state.list)
      emit()
    }
  }
}

/** Delete checked items remotely after applying every queued local change. */
export async function clearCrossedOff(id: string): Promise<boolean> {
  const creds = state.creds
  if (!creds || !(await flushPending())) return false
  try {
    await api.clearCrossedOff(creds, id)
    if (state.creds !== creds) return false

    for (const [key, change] of Object.entries(state.pending)) {
      if (change.listId === id) delete state.pending[key]
    }
    const list = state.list?.id === id ? state.list : await load<ListData>(K.list(id))
    if (list) {
      const removed = list.items.filter((item) => item.crossedOff)
      list.items = list.items.filter((item) => !item.crossedOff)
      for (const item of removed) delete state.checkedAt[item.id]
      if (state.list?.id === id) state.list = list
      await save(K.list(id), list)
    }
    await Promise.all([save(K.pending, state.pending), save(K.checkedAt, state.checkedAt)])
    setStatus('idle')
    return true
  } catch (err) {
    handleError(err)
    return false
  }
}

/** Delete checked items from every list. Returns false if any list failed. */
async function clearAllCrossedOff(): Promise<boolean> {
  let ok = true
  for (const { id } of state.lists) {
    if (!(await clearCrossedOff(id))) ok = false
  }
  if (!ok && state.status !== 'offline') setStatus('error', CLEAR_FAILED)
  return ok
}

const CLEAR_FAILED = 'Checked items not deleted'

export function closeList(): void {
  state.list = null
  emit()
}

// ---------------------------------------------------------------- items

export async function toggleItem(itemId: string): Promise<void> {
  const list = state.list
  const item = list?.items.find((i) => i.id === itemId)
  if (!list || !item) return
  item.crossedOff = !item.crossedOff
  if (item.crossedOff) state.checkedAt[item.id] = Date.now()
  else delete state.checkedAt[item.id]
  state.pending[`${list.id}:${item.id}`] = { listId: list.id, itemId: item.id, crossedOff: item.crossedOff }
  emit()
  await Promise.all([save(K.list(list.id), list), save(K.pending, state.pending), save(K.checkedAt, state.checkedAt)])
  await flushPending()
}

// ---------------------------------------------------------------- sync

let flushing: Promise<boolean> | null = null
let flushAgain = false

/**
 * Push every queued change to OurGroceries, oldest first. Stops at the first
 * failure so nothing is lost. Concurrent calls coalesce into one extra pass.
 * Resolves true if the queue was emptied.
 */
export function flushPending(): Promise<boolean> {
  if (flushing) { flushAgain = true; return flushing }
  flushing = (async () => {
    try {
      do {
        flushAgain = false
        if (!(await flushOnce())) return false
      } while (flushAgain)
      return true
    } finally {
      flushing = null
    }
  })()
  return flushing
}

async function flushOnce(): Promise<boolean> {
  const creds = state.creds
  if (!creds) return false
  if (!pendingCount()) return true
  setStatus('syncing')
  for (const [key, change] of Object.entries(state.pending)) {
    try {
      await api.toggle(creds, change.listId, change.itemId, change.crossedOff)
    } catch (err) {
      handleError(err)
      return false
    }
    if (state.creds !== creds) return false // signed out mid-flush
    // Only drop the entry if it wasn't toggled again while the request was in flight.
    if (state.pending[key] === change) delete state.pending[key]
    await save(K.pending, state.pending)
    emit()
  }
  setStatus('idle')
  return true
}

/**
 * Push local changes and delete checked items from the open list (or from
 * every list when none is open), then reload to pick up edits made in other
 * OurGroceries apps. Changes still queued after a failed push are re-applied
 * on top of the fresh copy so they are not lost.
 */
export async function syncAll(): Promise<boolean> {
  const creds = state.creds
  if (!creds) return false
  await flushPending()
  const open = state.list
  if (!open) {
    await refreshLists()
    if (state.creds === creds) await clearAllCrossedOff()
    return false
  }

  const cleared = await clearCrossedOff(open.id)
  if (state.list?.id !== open.id) return false
  setStatus('syncing')
  try {
    const fresh = await api.list(creds, open.id)
    if (state.list?.id !== open.id || state.creds !== creds) return false
    for (const [key, change] of Object.entries(state.pending)) {
      if (change.listId !== fresh.id) continue
      const item = fresh.items.find((i) => i.id === change.itemId)
      if (item) item.crossedOff = change.crossedOff
      else delete state.pending[key] // deleted elsewhere; it would block the queue forever
    }
    await save(K.pending, state.pending)
    // Forget timestamps for items that are no longer crossed off anywhere.
    for (const item of fresh.items) if (!item.crossedOff) delete state.checkedAt[item.id]
    state.list = fresh
    await Promise.all([save(K.list(fresh.id), fresh), save(K.checkedAt, state.checkedAt)])
    if (pendingCount()) setStatus('offline', 'Offline')
    else if (!cleared) setStatus('error', CLEAR_FAILED)
    else setStatus('idle')
    return true
  } catch (err) {
    handleError(err)
    return false
  }
}
