import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { useBridgeStorage } from './storage'
import * as store from './store'
import * as phone from './phone'
import * as glasses from './glasses'

// Outside the Even app (plain browser) the bridge never arrives; the phone UI
// still works there with browser storage, which is handy for testing sign-in.
const bridge = await Promise.race([
  waitForEvenAppBridge(),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
]) as EvenAppBridge | null

useBridgeStorage(bridge)
await store.init()
phone.start()
if (bridge) await glasses.start(bridge)

// Fetch the list of lists on every startup (and push anything left unsynced).
if (store.state.creds) {
  void store.flushPending()
  void store.refreshLists()
}
