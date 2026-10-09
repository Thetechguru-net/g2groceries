// JSON key/value storage. Uses the Even app's local storage when the bridge is
// available (it persists on the phone), else the browser's localStorage so the
// phone UI can also be exercised in a plain browser.
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

let bridge: EvenAppBridge | null = null

export function useBridgeStorage(b: EvenAppBridge | null): void {
  bridge = b
}

export async function load<T>(key: string): Promise<T | null> {
  try {
    const raw = bridge ? await bridge.getLocalStorage(key) : localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

export async function save(key: string, value: unknown): Promise<void> {
  const raw = value == null ? '' : JSON.stringify(value)
  try {
    if (bridge) await bridge.setLocalStorage(key, raw)
    else if (raw) localStorage.setItem(key, raw)
    else localStorage.removeItem(key)
  } catch (err) {
    console.warn('storage write failed', key, err)
  }
}

export const remove = (key: string) => save(key, null)
