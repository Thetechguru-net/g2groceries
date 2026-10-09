// In-memory diagnostic log. Every entry also goes to the console; the phone UI
// shows the most recent entries so problems can be diagnosed on the device.
// Never log credentials.

export interface LogEntry { time: number; level: 'info' | 'warn' | 'error'; message: string }

const MAX_ENTRIES = 300
const entries: LogEntry[] = []
const listeners = new Set<() => void>()

function write(level: LogEntry['level'], message: string): void {
  entries.push({ time: Date.now(), level, message })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  console[level](`[g2groceries] ${message}`)
  for (const fn of listeners) fn()
}

export const log = {
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
}

export const logEntries = (): readonly LogEntry[] => entries

export function onLog(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function formatEntry(e: LogEntry): string {
  const t = new Date(e.time)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`
  return `${stamp} ${e.level.toUpperCase().padEnd(5)} ${e.message}`
}
