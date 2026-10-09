// Glasses UI.
//
// Long lists use the text-container technique from g2-long-lists-v1.md rather
// than the 20-item native list container:
//   - a blank full-screen text container captures all gestures,
//   - the visible body is a non-capturing text container showing only the rows
//     that fit, redrawn with textContainerUpgrade on every swipe,
//   - every row is cut to one line by pixel width (pretext),
//   - one update is in flight at a time; only the latest screen is sent.
//
// Gestures
//   Lists screen:  swipe = move, press = open list, double press = exit
//   Items screen:  swipe = move, long press (on release) = check / uncheck,
//                  double press = jump to the first checked item
//   Menu:          Sync all, All lists
import {
  CreateStartUpPageContainer, MenuContainerProperty, MenuItemProperty, OsEventTypeList, TextContainerProperty,
  TextContainerUpgrade, type EvenAppBridge, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { pxTruncate } from '@evenrealities/pretext'
import type { Item, ListData } from './api'
import * as store from './store'
import { state } from './store'

const X = 16
const WIDTH = 544            // 576 canvas minus 16 px side margins
const LINE = 27              // body line height in px
const HEADER_H = 32
const BODY_Y = 36
const ROWS = 9               // floor((288 - BODY_Y) / LINE)
const BODY_H = ROWS * LINE
const SEL = '> '             // '> ' and 3 spaces are both 15 px wide
const NOSEL = '   '
const MARK_W = 15

const ID_EVENTS = 99
const ID_HEADER = 1
const ID_BODY = 2

const MENU_SYNC = 1
const MENU_LISTS = 2

type Row =
  | { kind: 'heading'; text: string }
  | { kind: 'item'; id: string; text: string }

// ---------------------------------------------------------------- rows

function itemText(item: Item): string {
  const box = item.crossedOff ? '■ ' : '□ '
  return box + item.value + (item.note ? ` (${item.note})` : '')
}

/** Unchecked items grouped under category headings, then checked items newest first. */
export function buildItemRows(list: ListData): Row[] {
  const catOrder = new Map(list.categories.map((c, i) => [c.id, i]))
  const catName = new Map(list.categories.map((c) => [c.id, c.name]))
  const byName = (a: Item, b: Item) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base' })

  const groups = new Map<string, Item[]>()
  for (const item of list.items) {
    if (item.crossedOff) continue
    const key = item.categoryId && catName.has(item.categoryId) ? item.categoryId : ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  const keys = [...groups.keys()].sort((a, b) =>
    (a === '' ? Infinity : catOrder.get(a)!) - (b === '' ? Infinity : catOrder.get(b)!))

  const rows: Row[] = []
  for (const key of keys) {
    rows.push({ kind: 'heading', text: `─ ${key ? catName.get(key) : 'Uncategorized'} ─` })
    for (const item of groups.get(key)!.sort(byName)) rows.push({ kind: 'item', id: item.id, text: itemText(item) })
  }

  // Items crossed off on this device carry a timestamp and come first, newest
  // first; items crossed off elsewhere keep OurGroceries' order after them.
  const serverIndex = new Map(list.items.map((it, i) => [it.id, i]))
  const checked = list.items.filter((i) => i.crossedOff).sort((a, b) =>
    (state.checkedAt[b.id] ?? 0) - (state.checkedAt[a.id] ?? 0)
    || serverIndex.get(a.id)! - serverIndex.get(b.id)!)
  if (checked.length) {
    rows.push({ kind: 'heading', text: `─ Crossed off (${checked.length}) ─` })
    for (const item of checked) rows.push({ kind: 'item', id: item.id, text: itemText(item) })
  }
  return rows
}

function listRows(): Row[] {
  return state.lists.map((l) => ({
    kind: 'item' as const,
    id: l.id,
    text: l.activeCount != null ? `${l.name} (${l.activeCount})` : l.name,
  }))
}

// ---------------------------------------------------------------- view state

let bridge: EvenAppBridge
let rows: Row[] = []
let selected = -1            // index into rows; always an item row, or -1 if none
let offset = 0
let selectedId: string | null = null
let screen: 'signedOut' | 'lists' | 'items' = 'signedOut'
/** Only act on a long-press release if its press started on the items screen. */
let longPressArmed = false

const firstItem = (from: number, dir: 1 | -1): number => {
  for (let i = from; i >= 0 && i < rows.length; i += dir) if (rows[i].kind === 'item') return i
  return -1
}

/** Rebuild rows from state, keeping the selection on the same item if it still exists. */
function rebuildRows(keepIndex = false): void {
  const prev = selected
  rows = screen === 'items' && state.list ? buildItemRows(state.list)
    : screen === 'lists' ? listRows()
    : []
  let idx = keepIndex ? -1 : rows.findIndex((r) => r.kind === 'item' && r.id === selectedId)
  if (idx < 0) {
    const start = Math.min(Math.max(prev, 0), rows.length - 1)
    idx = firstItem(start, 1)
    if (idx < 0) idx = firstItem(start, -1)
  }
  select(idx)
}

function select(idx: number): void {
  selected = idx
  const row = rows[idx]
  selectedId = row?.kind === 'item' ? row.id : null
}

function move(delta: 1 | -1): void {
  const next = firstItem(selected + delta, delta)
  if (next >= 0) select(next)
}

// ---------------------------------------------------------------- render

function statusText(): string {
  const n = store.pendingCount()
  const unsynced = n ? `${n} unsynced` : ''
  switch (state.status) {
    case 'syncing': return 'Syncing…'
    case 'offline': return unsynced ? `Offline · ${unsynced}` : 'Offline'
    case 'error': return state.message
    default: return unsynced
  }
}

function renderHeader(): string {
  const title = screen === 'items' ? state.list?.name || 'List' : 'OurGroceries'
  const status = statusText()
  return pxTruncate(status ? `${title}  ·  ${status}` : title, WIDTH)
}

function renderBody(): string {
  if (screen === 'signedOut') return 'Sign in on your phone to\nload your OurGroceries lists.'
  if (!rows.length) {
    if (state.status === 'syncing') return 'Loading…'
    return screen === 'lists' ? 'No lists found.' : 'This list is empty.'
  }

  // Scroll just enough to keep the selection visible; when scrolling up onto
  // the first item of a category, bring its heading into view too.
  if (selected >= 0) {
    if (selected < offset) offset = selected
    if (selected >= offset + ROWS) offset = selected - ROWS + 1
    if (offset === selected && offset > 0 && rows[offset - 1].kind === 'heading') offset--
  }
  offset = Math.max(0, Math.min(offset, rows.length - ROWS))
  if (firstItem(0, 1) === selected) offset = 0

  return rows.slice(offset, offset + ROWS).map((row, i) => {
    if (row.kind === 'heading') return pxTruncate(row.text, WIDTH)
    return (offset + i === selected ? SEL : NOSEL) + pxTruncate(row.text, WIDTH - MARK_W)
  }).join('\n')
}

let busy = false
let dirty = false
let sentHeader = ''
let sentBody = ''

/** Send the current screen; while an update is in flight, keep only the latest. */
async function update(): Promise<void> {
  if (busy) { dirty = true; return }
  busy = true
  try {
    do {
      dirty = false
      const header = renderHeader()
      const body = renderBody()
      if (header !== sentHeader) {
        sentHeader = header
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: ID_HEADER, containerName: 'header', content: header,
        })).catch(() => false)
      }
      if (body !== sentBody) {
        sentBody = body
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: ID_BODY, containerName: 'body', content: body,
        })).catch(() => false)
      }
    } while (dirty)
  } finally {
    busy = false
  }
}

// ---------------------------------------------------------------- navigation

function show(next: typeof screen): void {
  if (next !== screen) { selected = -1; selectedId = null; offset = 0 }
  screen = next
  longPressArmed = false
  rebuildRows()
  void update()
}

function syncScreenWithState(): void {
  if (!state.creds) return show('signedOut')
  if (screen === 'signedOut') return show(state.list ? 'items' : 'lists')
  if (screen === 'items' && !state.list) return show('lists')
  rebuildRows()
  void update()
}

async function openSelected(): Promise<void> {
  const row = rows[selected]
  if (row?.kind !== 'item') return
  const pending = store.openList(row.id)
  show('items')
  await pending
}

async function backToLists(): Promise<void> {
  const listId = state.list?.id
  if (listId) await store.clearCrossedOff(listId)
  store.closeList()
  show('lists')
  void store.refreshLists()
}

function toggleSelected(): void {
  const row = rows[selected]
  if (row?.kind !== 'item') return
  // The item jumps to the other section; keep the cursor on the same row
  // position so the next item can be checked straight away.
  const keep = selected
  void store.toggleItem(row.id)
  selected = keep
  rebuildRows(true)
  void update()
}

function jumpToFirstChecked(): void {
  const checkedIds = new Set(state.list?.items.filter((item) => item.crossedOff).map((item) => item.id))
  const index = rows.findIndex((row) => row.kind === 'item' && checkedIds.has(row.id))
  if (index < 0) return
  select(index)
  void update()
}

// ---------------------------------------------------------------- events

function eventType(event: EvenHubEvent): number | undefined {
  // Protobuf drops zero values, so a missing eventType means CLICK_EVENT (0).
  if (event.textEvent) return event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT
  if (event.sysEvent) return event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT
  return undefined
}

function onEvent(event: EvenHubEvent): void {
  if (event.menuItemClickEvent) {
    const id = event.menuItemClickEvent.itemID
    if (id === MENU_SYNC) void store.syncAll()
    else if (id === MENU_LISTS && screen === 'items') void backToLists()
    return
  }

  const type = eventType(event)
  switch (type) {
    case OsEventTypeList.SCROLL_TOP_EVENT:
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (screen === 'signedOut') return
      move(type === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1)
      void update()
      return

    case OsEventTypeList.CLICK_EVENT:
      if (screen === 'lists') void openSelected()
      return

    case OsEventTypeList.LONG_PRESS_EVENT:
      longPressArmed = screen === 'items'
      return

    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      if (screen === 'items' && longPressArmed) toggleSelected()
      longPressArmed = false
      return

    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      if (screen === 'items') jumpToFirstChecked()
      else void bridge.shutDownPageContainer(1) // system exit confirmation
      return

    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      sentHeader = sentBody = '' // the host may have redrawn; resend everything
      void update()
      if (state.creds && store.pendingCount()) void store.flushPending()
      return
  }
}

// ---------------------------------------------------------------- startup

export async function start(b: EvenAppBridge): Promise<void> {
  bridge = b
  screen = state.creds ? 'lists' : 'signedOut'
  rebuildRows()
  sentHeader = renderHeader()
  sentBody = renderBody().slice(0, 900) // 1,000-char limit at page creation

  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [
      // Invisible full-screen layer that receives every gesture. The visible
      // containers must not capture, or the firmware scrolls them itself.
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288, paddingLength: 0, borderWidth: 0,
        containerID: ID_EVENTS, containerName: 'events', isEventCapture: 1, content: ' ',
      }),
      new TextContainerProperty({
        xPosition: X, yPosition: 0, width: WIDTH, height: HEADER_H, paddingLength: 0, borderWidth: 0,
        containerID: ID_HEADER, containerName: 'header', isEventCapture: 0, content: sentHeader,
      }),
      new TextContainerProperty({
        xPosition: X, yPosition: BODY_Y, width: WIDTH, height: BODY_H, paddingLength: 0, borderWidth: 0,
        containerID: ID_BODY, containerName: 'body', isEventCapture: 0, content: sentBody,
      }),
    ],
    menuObject: new MenuContainerProperty({
      menuItems: [
        new MenuItemProperty({ itemID: MENU_SYNC, itemName: 'Sync all' }),
        new MenuItemProperty({ itemID: MENU_LISTS, itemName: 'All lists' }),
      ],
    }),
  }))

  bridge.onEvenHubEvent(onEvent)
  store.subscribe(syncScreenWithState)
  void update()
}
