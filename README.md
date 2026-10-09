# OurGroceries for Even G2

Shopping lists from [OurGroceries](https://www.ourgroceries.com) on Even Realities G2 glasses.

## Run

```bash
npm install
npm run dev          # app + OurGroceries proxy on :5173
npm run simulate     # or: npx evenhub qr --url http://<your-ip>:5173
```

Sign in on the phone screen. The credentials are saved on the phone, and "Sign out" erases them along with all cached lists.

## Using it on the glasses

| Screen | Swipe | Press | Long press (on release) | Double press |
|---|---|---|---|---|
| Lists | move | open list | — | exit |
| Items | move | — | check / uncheck | jump to first checked item |

Contextual menu: **Sync all** and **All lists**. Double-press on an empty checked section leaves the selection unchanged. Opening a list for the first time and choosing **All lists** permanently deletes all checked-off items from that OurGroceries list.

Only unchecked items are retrieved from OurGroceries and grouped under category headings. Items checked off locally remain visible until the next successful refresh; checked items are not downloaded.
List names show the number of unchecked items in each list.

## Why there is a server

`ourgroceries` is Node-only: it uses `got` and `tough-cookie` and signs in through an HTML form. ourgroceries.com also sends no CORS headers. The WebView therefore can't call it directly. `server/og-api.ts` wraps the library as a small JSON API:

- **Development:** Vite serves it.
- **Production:** run it with `npm run build && npm start` (port `PORT`, default 8787). This also serves `dist/`.

A packaged `.ehpk` must be told where that server is: enter its URL under **Server** on the sign-in form. Also add it to `app.json` as a `network` permission:

```json
"permissions": [{ "name": "network", "desc": "Syncs with OurGroceries via the proxy.", "whitelist": ["https://your-server.example"] }]
```

Use HTTPS for anything beyond your LAN, because the app sends your OurGroceries credentials to the proxy on every request.

## Sync model

Opening a list for the first time deletes its checked-off items from OurGroceries before retrieving it. Choosing **All lists** deletes checked-off items again before leaving. This deletion is permanent. The cached copy is used only when retrieval fails.

Checking an item updates the screen and local storage right away and adds the change to a queue. The queue is then pushed with `toggleItemCrossedOff`.

If a push fails, the changes stay queued and the header shows `Offline · N unsynced`. The whole queue is retried on every later change, on returning to the foreground, and on **Sync all**. Sync all pushes the queue and then reloads the list (`getListItems`) to pick up changes made elsewhere.

## Files

| File | Purpose |
|---|---|
| `src/glasses.ts` | Glasses UI: long lists as text containers (see g2-long-lists-v1.md), input, menu |
| `src/store.ts` | State, offline queue, sync |
| `src/phone.ts` | Sign in / status / sync / sign out on the phone |
| `src/api.ts` | Client for the proxy |
| `src/storage.ts` | Even app local storage, with a browser fallback |
| `server/og-api.ts` | Proxy around the `ourgroceries` package |
| `server/standalone.ts` | Production server |
