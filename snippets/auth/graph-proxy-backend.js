/**
 * scopes: [backend]
 * flags: [microsoft-graph, sharepoint, onedrive]
 * description: Express handlers that proxy frontend Graph requests + auth-start redirects to the platform proxy. SigV4-signs Graph calls with the project's ECS task role.
 *
 * SNIPPET: Microsoft Graph -- Platform OBO Proxy + Bouncer (Backend, Node.js)
 * CATEGORY: Authentication
 * LANGUAGE: JavaScript (Node.js + Express)
 * STATUS: Ready
 *
 * WHAT THIS DOES:
 *   - GET  /api/graph/auth-start    -- 302 redirect to platform bouncer
 *   - POST /api/graph/<op>          -- SigV4-signs to platform proxy with
 *                                       X-Platform-Session forwarded from
 *                                       the frontend
 *
 * WHY THE BACKEND PROXIES auth-start TOO:
 *   The platform's API Gateway is on api.vibe.intranet.cnb, while the
 *   project lives on <project>.vibe.intranet.cnb. The frontend never has
 *   to know the platform domain -- it just hits its own /api/graph/auth-
 *   start, which 302s out to the bouncer. Cleaner for project devs.
 *
 * DEPENDENCIES:
 *   npm i express \
 *         @aws-sdk/credential-providers \
 *         @aws-sdk/signature-v4 \
 *         @aws-sdk/protocol-http \
 *         @aws-crypto/sha256-js
 *
 * ENVIRONMENT VARIABLES (injected by platform deploy, do not hardcode):
 *   PLATFORM_GRAPH_PROXY_URL       AWS-native VPC endpoint URL for backend
 *                                  -> https://<api-id>-<vpce-id>.execute-api.<region>.amazonaws.com/v1/platform/graph
 *                                  Served with an Amazon Trust Services cert (publicly
 *                                  trusted by Node out of the box). Avoids forcing
 *                                  every project to bundle Bayer's corporate CA.
 *   PLATFORM_GRAPH_AUTH_START_URL  Custom domain URL for browser redirects
 *                                  -> https://api.vibe.intranet.cnb/platform/auth/start
 *                                  Must be the custom domain because Entra's
 *                                  registered redirect URI matches this host and
 *                                  the browser sets session cookies on it.
 *   AWS_REGION                     eu-central-1 (set by ECS)
 *
 * USAGE:
 *   const express = require('express')
 *   const { registerGraphProxyEndpoints } = require('./graph-proxy-backend')
 *   const app = express()
 *   app.use(express.json())
 *   registerGraphProxyEndpoints(app)
 *
 * That's it. Per-operation Express routes are optional -- the snippet
 * exposes /api/graph/<op> as a catch-all that forwards every operation
 * the platform proxy supports. You can also wire specific routes if you
 * want to add app-side logging or input validation:
 *
 *   app.post('/api/graph/sharepoint/fetch', async (req, res) => {
 *     const sid = req.headers['x-platform-session']
 *     try {
 *       res.json(await callGraphProxy('sharepoint/fetch', req.body, sid))
 *     } catch (e) {
 *       res.status(e.status || 502).json({ error: e.message })
 *     }
 *   })
 */

const { fromNodeProviderChain } = require('@aws-sdk/credential-providers')
const { SignatureV4 } = require('@aws-sdk/signature-v4')
const { HttpRequest } = require('@aws-sdk/protocol-http')
const { Sha256 } = require('@aws-crypto/sha256-js')

const REGION = process.env.AWS_REGION || 'eu-central-1'

let _credentialsProvider = null
function getCredentials() {
  if (!_credentialsProvider) _credentialsProvider = fromNodeProviderChain()
  return _credentialsProvider
}

function getProxyUrl() {
  const url = process.env.PLATFORM_GRAPH_PROXY_URL
  if (!url) {
    throw new Error(
      'PLATFORM_GRAPH_PROXY_URL not set -- platform deploy should inject this. ' +
        'For local dev, set it to your test platform URL.',
    )
  }
  return url
}

function getAuthStartUrl() {
  const url = process.env.PLATFORM_GRAPH_AUTH_START_URL
  if (!url) {
    throw new Error('PLATFORM_GRAPH_AUTH_START_URL not set -- platform deploy should inject this.')
  }
  return url
}

/**
 * SigV4-signed POST to the platform Graph proxy. The X-Platform-Session
 * header carries the user's session id; the platform looks up the user_token
 * server-side. The project backend never sees user_tokens.
 */
async function callGraphProxy(operation, body, sessionId) {
  if (!sessionId) {
    const err = new Error('missing X-Platform-Session header from frontend')
    err.status = 401
    throw err
  }

  const proxyUrl = new URL(`${getProxyUrl()}/${operation}`)
  const payload = JSON.stringify(body || {})

  const request = new HttpRequest({
    method: 'POST',
    protocol: proxyUrl.protocol,
    hostname: proxyUrl.hostname,
    path: proxyUrl.pathname,
    headers: {
      host: proxyUrl.hostname,
      'content-type': 'application/json',
      'x-platform-session': sessionId,
    },
    body: payload,
  })

  const signer = new SignatureV4({
    credentials: getCredentials(),
    region: REGION,
    service: 'execute-api',
    sha256: Sha256,
  })

  const signed = await signer.sign(request)
  const res = await fetch(proxyUrl.toString(), {
    method: 'POST',
    headers: signed.headers,
    body: payload,
  })

  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch (_) {
    parsed = { raw: text }
  }

  if (!res.ok) {
    const err = new Error(`graph proxy ${res.status}: ${parsed.error || text}`)
    err.status = res.status
    // Preserve the platform proxy's code string (e.g. "consent_required",
    // "session_project_mismatch") so callers can branch on it without
    // string-parsing err.message.
    err.code = typeof parsed.error === 'string' ? parsed.error : undefined
    err.detail = parsed
    throw err
  }
  return parsed
}

/**
 * Register both routes on an Express app:
 *   GET  /api/graph/auth-start   -> 302 to platform bouncer
 *   POST /api/graph/:op*         -> SigV4-forward to platform proxy
 *
 * Error response shape forwarded to the frontend is structured so
 * graph-proxy-client.js can detect consent_required and redirect:
 *   { error: "<code>", consent_url?: string, project?: string,
 *     scope?: string, message: string, detail?: object }
 */
function registerGraphProxyEndpoints(app) {
  app.get('/api/graph/auth-start', (req, res) => {
    const ret = String(req.query.return || '')
    if (!ret) return res.status(400).json({ error: 'missing_return' })
    const url = `${getAuthStartUrl()}?return=${encodeURIComponent(ret)}`
    res.redirect(302, url)
  })

  app.post(/^\/api\/graph\/(.+)$/, async (req, res) => {
    const operation = req.params[0]
    const sid = req.headers['x-platform-session']
    try {
      const data = await callGraphProxy(operation, req.body, sid)
      res.json(data)
    } catch (e) {
      const status = e.status || 502
      // PR2.2 -- forward the platform's consent_required + consent_url
      // verbatim so the frontend client snippet can redirect the browser.
      if (e.code === 'consent_required' && e.detail?.consent_url) {
        return res.status(403).json({
          error: 'consent_required',
          consent_url: e.detail.consent_url,
          project: e.detail.project,
          scope: e.detail.scope,
          message: e.message,
        })
      }
      res.status(status).json({
        error: e.code || 'graph_proxy_error',
        status,
        message: e.message,
        detail: e.detail,
      })
    }
  })
}

module.exports = { registerGraphProxyEndpoints, callGraphProxy }
