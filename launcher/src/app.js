const express = require('express')
const httpProxy = require('http-proxy')

function applySecurityHeaders(target) {
  const headers = {
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  }

  if (typeof target.setHeader === 'function') {
    for (const [name, value] of Object.entries(headers)) {
      target.setHeader(name, value)
    }
    return
  }

  if (target && typeof target === 'object' && target.headers) {
    for (const [name, value] of Object.entries(headers)) {
      target.headers[name.toLowerCase()] = value
    }
  }
}

function createLauncherApp({ internalSharedSecret, sessionService }) {
  const app = express()
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    xfwd: true,
    ignorePath: true,
  })

  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use((req, res, next) => {
    applySecurityHeaders(res)
    next()
  })

  proxy.on('proxyRes', (proxyRes) => {
    applySecurityHeaders(proxyRes)
    delete proxyRes.headers.etag
    delete proxyRes.headers['last-modified']
  })

  proxy.on('error', (error, req, resOrSocket) => {
    if (resOrSocket && typeof resOrSocket.writeHead === 'function' && !resOrSocket.headersSent) {
      applySecurityHeaders(resOrSocket)
      resOrSocket.writeHead(502, { 'Content-Type': 'application/json' })
      resOrSocket.end(JSON.stringify({ error: 'Proxy error', details: error.message }))
      return
    }

    if (resOrSocket && typeof resOrSocket.destroy === 'function') {
      resOrSocket.destroy()
      return
    }

    if (resOrSocket && typeof resOrSocket.end === 'function' && !resOrSocket.writableEnded) {
      resOrSocket.end()
    }
  })

  app.get('/healthz', async (_req, res) => {
    try {
      await sessionService.docker.ping()
      res.json({ ok: true })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/internal/sessions', async (req, res) => {
    if (req.get('X-Shared-Secret') !== internalSharedSecret) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    try {
      const session = await sessionService.createSession(req.body || {})
      res.json(session)
    } catch (error) {
      const status = error.message === 'Invalid userId' || error.message === 'Path traversal is not allowed' ? 400 : 500
      res.status(status).json({ error: error.message })
    }
  })

  app.use('/session', async (req, res) => {
    try {
      const route = parseProxyRequest(req.originalUrl)
      const target = await sessionService.resolveProxyTarget(route.token)

      proxy.web(req, res, {
        target: `${target}${route.upstreamPath}${route.search}`,
      })
    } catch (error) {
      res.status(401).json({ error: error.message })
    }
  })

  async function handleUpgrade(req, socket, head) {
    try {
      const route = parseProxyRequest(req.url)
      const target = await sessionService.resolveProxyTarget(route.token)

      proxy.ws(req, socket, head, {
        target: `${target}${route.upstreamPath}${route.search}`,
      })
    } catch (_error) {
      socket.destroy()
    }
  }

  return { app, handleUpgrade, proxy }
}

function parseProxyRequest(rawUrl) {
  const parsed = new URL(rawUrl, 'http://launcher.internal')
  const match = parsed.pathname.match(/^\/session\/([^/]+)(\/.*)?$/)

  if (!match) {
    throw new Error('Invalid proxy path')
  }

  return {
    token: match[1],
    upstreamPath: match[2] || '/',
    search: parsed.search || '',
  }
}

module.exports = {
  applySecurityHeaders,
  createLauncherApp,
  parseProxyRequest,
}
