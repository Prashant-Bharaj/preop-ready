/**
 * scopes: [frontend]
 * flags: [microsoft-graph, sharepoint, onedrive, calendar, mail]
 * description: Frontend redirect-flow helper for the platform Graph proxy + auth bouncer. No MSAL, no Entra IDs, no per-project secrets.
 *
 * SNIPPET: Microsoft Graph -- Platform OBO Proxy + Bouncer (Frontend)
 * CATEGORY: Authentication
 * LANGUAGE: JavaScript (vanilla, framework-agnostic)
 * STATUS: Ready
 *
 * WHAT THIS REPLACES:
 *   microsoft-graph-frontend.js (which used MSAL.js and needed per-project
 *   Entra reply URIs). This snippet has NO Entra dependencies: it just
 *   redirects to the platform's /platform/auth/start when the user has no
 *   session and reads the session id from the URL fragment on return.
 *
 * WHEN TO USE:
 *   Default choice for any new project needing Microsoft Graph.
 *
 * DEPENDENCIES: none (no MSAL, no npm install needed for auth).
 *
 * USAGE (in any frontend):
 *
 *   import { callGraph, consumeSessionFromHash } from './graph-proxy-client'
 *
 *   // App bootstrap: pick up session id if we just came back from auth
 *   consumeSessionFromHash()
 *
 *   // Anywhere you need Graph:
 *   try {
 *     const me = await callGraph('whoami', {})
 *     console.log(me.displayName)
 *   } catch (e) {
 *     if (e.code === 'redirected_to_auth') return  // page is navigating away
 *     throw e
 *   }
 *
 *   // SharePoint fetch:
 *   const file = await callGraph('sharepoint/fetch', { url: sharingLink })
 *   // -> { name, mimeType, size, content_base64 }
 *
 * SESSION HANDLING:
 *   - The session id is stored in sessionStorage under "platform_session"
 *   - When absent, callGraph() redirects the browser to the bouncer and
 *     throws 'redirected_to_auth' (the page is unloading -- abort cleanly)
 *   - When the backend returns 401, the session is cleared and a redirect
 *     happens automatically
 *   - To restore work-in-progress across the redirect, save state to
 *     localStorage / sessionStorage before calling Graph
 *
 * JIT CONSENT (per-(user, project, scope)):
 *   The platform proxy requires explicit user consent before each project
 *   can use each Graph scope on a user's behalf. On the FIRST call from
 *   this project for this scope, the proxy returns 403 consent_required
 *   with a consent_url. callGraph() automatically navigates the browser
 *   there (after stashing your `stateBag` for replay). The user clicks
 *   Allow on the platform-owned consent screen, comes back to this
 *   project, and on-mount your code reads consumePendingStateBag() to
 *   resume. Subsequent calls for the same (project, scope) tuple bypass
 *   the prompt for 30 days.
 *
 *   Pass an optional stateBag arg to callGraph() so the prompt is
 *   transparent:
 *
 *     try {
 *       await callGraph('sharepoint/fetch', { url: link }, { type: 'sp-fetch', link })
 *     } catch (e) { if (e.code === 'redirected_to_auth' || e.code === 'redirected_to_consent') return; throw e }
 *
 *   On app mount, after consumeSessionFromHash():
 *     const pending = consumePendingStateBag()
 *     if (pending?.type === 'sp-fetch') replaySharePointFetch(pending.link)
 */

const SESSION_KEY = 'platform_session'

// The platform proxy URL is a platform constant. Set by the platform deploy
// workflow as PLATFORM_GRAPH_PROXY_URL on every project's container. If you
// see this snippet outside that context, override it via window config.
const PROXY_BASE = (typeof window !== 'undefined' && window.__PLATFORM_GRAPH_PROXY__)
  || '/api/graph'   // project backend proxies to the platform; default below

function getSession() {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch (_) {
    return null
  }
}

function setSession(sid) {
  try {
    sessionStorage.setItem(SESSION_KEY, sid)
  } catch (_) {
    /* private mode -- silent */
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch (_) {
    /* noop */
  }
}

/**
 * On app bootstrap, parse #sid=... from the URL fragment (set by the
 * platform bouncer's callback). If present, store it and strip from URL.
 * Returns the session id or null.
 */
export function consumeSessionFromHash() {
  if (typeof window === 'undefined') return null
  const m = window.location.hash.match(/[#&]sid=([^&]+)/)
  if (!m) return null
  const sid = decodeURIComponent(m[1])
  setSession(sid)
  // Strip the fragment from the URL so a refresh doesn't re-consume it.
  const cleaned = window.location.pathname + window.location.search
  window.history.replaceState(null, '', cleaned || '/')
  return sid
}

/**
 * Top-level redirect to the platform bouncer. Browser navigates away; this
 * function never returns. Use the optional state-bag to restore UI on return
 * (saved in sessionStorage, picked up after consumeSessionFromHash).
 */
export function redirectToAuth(stateBag) {
  if (stateBag) {
    try {
      sessionStorage.setItem('platform_auth_pending', JSON.stringify(stateBag))
    } catch (_) { /* noop */ }
  }
  const ret = encodeURIComponent(window.location.href)
  // The backend proxies /api/graph/auth-start to the platform's bouncer
  // so the frontend never has to know the platform domain.
  window.location.href = `/api/graph/auth-start?return=${ret}`
}

export function consumePendingStateBag() {
  try {
    const raw = sessionStorage.getItem('platform_auth_pending')
    sessionStorage.removeItem('platform_auth_pending')
    return raw ? JSON.parse(raw) : null
  } catch (_) {
    return null
  }
}

/**
 * Navigate to the platform consent page. Like redirectToAuth(), the
 * browser is unloading -- caller should NOT continue.
 */
function redirectToConsent(consentUrl, stateBag) {
  if (stateBag) {
    try {
      sessionStorage.setItem('platform_auth_pending', JSON.stringify(stateBag))
    } catch (_) { /* noop */ }
  }
  const ret = encodeURIComponent(window.location.href)
  const sep = consentUrl.includes('?') ? '&' : '?'
  window.location.href = `${consentUrl}${sep}return=${ret}`
}

/**
 * Call a curated Graph operation through the platform proxy.
 *
 * @param {string} operation  e.g. "whoami", "sharepoint/fetch"
 * @param {object} body       operation-specific JSON body
 * @param {object} stateBag   optional state to restore after a consent redirect
 *                            (the bouncer + consent flow both stash this for
 *                            you; pass shape your app expects on mount)
 * @returns {Promise<object>} parsed response from the proxy
 * @throws  Error with code "redirected_to_auth" or "redirected_to_consent"
 *          when the page is navigating away (caller should abort, not retry)
 */
export async function callGraph(operation, body = {}, stateBag = null) {
  let sid = getSession() || consumeSessionFromHash()
  if (!sid) {
    redirectToAuth(stateBag)
    const err = new Error('redirected_to_auth')
    err.code = 'redirected_to_auth'
    throw err
  }

  const res = await fetch(`${PROXY_BASE}/${operation}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-Session': sid,
    },
    body: JSON.stringify(body),
  })

  if (res.status === 401) {
    clearSession()
    redirectToAuth(stateBag)
    const err = new Error('redirected_to_auth')
    err.code = 'redirected_to_auth'
    throw err
  }

  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch (_) {
    parsed = { raw: text }
  }

  // PR2.2 -- per-(user, project, scope) consent. The proxy returns 403
  // with code "consent_required" and a consent_url; redirect the browser
  // there so the user can grant the permission. stateBag is stashed for
  // auto-replay after the user clicks Allow and comes back.
  if (res.status === 403 && parsed.error === 'consent_required' && parsed.consent_url) {
    redirectToConsent(parsed.consent_url, stateBag)
    const err = new Error('redirected_to_consent')
    err.code = 'redirected_to_consent'
    err.scope = parsed.scope
    err.project = parsed.project
    throw err
  }

  if (!res.ok) {
    const err = new Error(`graph proxy ${res.status}: ${parsed.error || text}`)
    err.status = res.status
    err.code = parsed.error
    err.detail = parsed
    throw err
  }
  return parsed
}
