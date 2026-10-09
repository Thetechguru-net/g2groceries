// Phone-side UI inside the Even app: sign in, status, sync, sign out.
import { api, AuthError, NetworkError } from './api'
import { formatEntry, log, logEntries, onLog } from './log'
import * as store from './store'
import { state } from './store'

const root = document.getElementById('app')!

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Default proxy location: the page's own origin when it was served over http(s). */
const defaultApiBase = () => (/^https?:$/.test(location.protocol) ? location.origin : '')

let confirmingSignOut = false
let formError = ''
let submitting = false
let logsOpen = false
let serverLog = ''

function render(): void {
  if (!state.creds || state.authFailed) renderSignIn()
  else renderAccount()
}

function renderSignIn(): void {
  // Once the form is up, only patch it so what the user typed is kept.
  if (root.querySelector('#signin')) {
    root.querySelector('#err')!.textContent = formError
    const button = root.querySelector<HTMLButtonElement>('#signin button')!
    button.disabled = submitting
    button.textContent = submitting ? 'Signing in…' : 'Sign in'
    return
  }
  const email = state.creds?.email ?? ''
  const apiBase = state.creds?.apiBase || defaultApiBase()
  root.innerHTML = `
    <form id="signin" class="card" autocomplete="on">
      <h1>G2Groceries</h1>
      <p class="muted">${state.authFailed ? 'Your saved sign-in was rejected. Please sign in again.'
        : 'Sign in with your OurGroceries account. Your credentials are saved on this phone.'}</p>
      <label>Email<input name="email" type="email" autocomplete="username" required value="${esc(email)}"></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <details ${apiBase ? '' : 'open'}>
        <summary>Server</summary>
        <label>Proxy server URL<input name="apiBase" type="url" placeholder="https://your-server:8787" value="${esc(apiBase)}"></label>
      </details>
      <p id="err" class="error" role="alert">${esc(formError)}</p>
      <button type="submit" ${submitting ? 'disabled' : ''}>${submitting ? 'Signing in…' : 'Sign in'}</button>
    </form>`
  root.querySelector<HTMLFormElement>('#signin')!.addEventListener('submit', onSubmit)
}

async function onSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault()
  const data = new FormData(e.target as HTMLFormElement)
  const creds = {
    email: String(data.get('email') ?? '').trim(),
    password: String(data.get('password') ?? ''),
    apiBase: String(data.get('apiBase') ?? '').trim(),
  }
  submitting = true
  formError = ''
  render()
  try {
    await store.signIn(creds)
    submitting = false
    await store.refreshLists()
  } catch (err) {
    submitting = false
    formError = err instanceof AuthError ? 'Email or password is incorrect.'
      : err instanceof NetworkError ? `Can't reach the server. ${(err as Error).message}`
      : (err as Error)?.message || 'Sign-in failed.'
  }
  render()
}

function renderAccount(): void {
  const n = store.pendingCount()
  const status = state.status === 'syncing' ? 'Syncing…'
    : state.status === 'offline' ? 'Offline — changes are saved on this phone and will sync later.'
    : state.status === 'error' ? `Error: ${state.message}`
    : 'Up to date'
  root.innerHTML = `
    <div class="card">
      <h1>G2Groceries</h1>
      <p class="muted">Signed in as <strong>${esc(state.creds!.email)}</strong></p>
      <dl>
        <dt>Viewing</dt><dd>${esc(state.list?.name || 'All lists')}</dd>
        <dt>Status</dt><dd>${esc(status)}</dd>
        <dt>Unsynced changes</dt><dd>${n}</dd>
      </dl>
      <button id="sync" ${state.status === 'syncing' ? 'disabled' : ''}>Sync all</button>
      <button id="signout" class="${confirmingSignOut ? 'danger' : 'secondary'}">${confirmingSignOut
        ? (n ? `Tap again — ${n} unsynced change${n > 1 ? 's' : ''} will be lost` : 'Tap again to sign out')
        : 'Sign out and forget credentials'}</button>
      <p class="muted small">On the glasses: swipe to move · press to open a list ·
        long-press to check or uncheck · double-press to jump to the first checked item ·
        menu → All lists or Sync all.</p>
    </div>
    <details id="logs" class="card" ${logsOpen ? 'open' : ''}>
      <summary>Diagnostic log</summary>
      <button id="copylog" class="secondary">Copy log</button>
      <pre id="applog" class="log"></pre>
      <button id="loadserverlog" class="secondary">Load companion log</button>
      <pre id="serverlog" class="log"></pre>
    </details>`
  renderLog()
  root.querySelector('#logs')!.addEventListener('toggle', (e) => {
    logsOpen = (e.target as HTMLDetailsElement).open
    renderLog()
  })
  root.querySelector('#copylog')!.addEventListener('click', () => void copyLog())
  root.querySelector('#loadserverlog')!.addEventListener('click', () => void loadServerLog())
  root.querySelector('#sync')!.addEventListener('click', () => void store.syncAll())
  root.querySelector('#signout')!.addEventListener('click', async () => {
    if (!confirmingSignOut) {
      confirmingSignOut = true
      render()
      setTimeout(() => { confirmingSignOut = false; render() }, 5000)
      return
    }
    confirmingSignOut = false
    formError = ''
    await store.signOut()
  })
}

function appLogText(): string {
  return logEntries().map(formatEntry).join('\n')
}

/** Refresh the log panes in place, newest entries first, only while visible. */
function renderLog(): void {
  if (!logsOpen) return
  const app = root.querySelector('#applog')
  if (app) app.textContent = [...logEntries()].reverse().map(formatEntry).join('\n') || '(empty)'
  const server = root.querySelector('#serverlog')
  if (server) server.textContent = serverLog
}

async function loadServerLog(): Promise<void> {
  if (!state.creds) return
  serverLog = 'Loading…'
  renderLog()
  try {
    serverLog = [...await api.serverLog(state.creds)].reverse().join('\n') || '(empty)'
  } catch (err) {
    serverLog = `Could not load the companion log: ${(err as Error)?.message}`
  }
  renderLog()
}

async function copyLog(): Promise<void> {
  const text = `App log\n${appLogText()}\n\nCompanion log\n${serverLog || '(not loaded)'}`
  try {
    await navigator.clipboard.writeText(text)
    log.info('log copied to clipboard')
  } catch (err) {
    log.warn(`copy failed: ${(err as Error)?.message}`)
  }
}

export function start(): void {
  store.subscribe(render)
  onLog(renderLog)
  render()
}
