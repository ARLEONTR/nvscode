const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { applySecurityHeaders, createLauncherApp, parseProxyRequest } = require('../src/app')

test('parseProxyRequest extracts token, path, and query', () => {
  const parsed = parseProxyRequest('/session/abc123/static/out.js?x=1')

  assert.equal(parsed.token, 'abc123')
  assert.equal(parsed.upstreamPath, '/static/out.js')
  assert.equal(parsed.search, '?x=1')
})

test('internal session endpoint rejects invalid shared secret', async () => {
  const sessionService = {
    docker: { ping: async () => ({ ok: true }) },
    createSession: async () => ({ iframePath: '/ok', expiresAt: 'later' }),
    resolveProxyTarget: async () => 'http://example:8080',
  }

  const { app } = createLauncherApp({ internalSharedSecret: 'topsecret', sessionService })
  const server = http.createServer(app)
  server.listen(0)
  await once(server, 'listening')

  try {
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shared-Secret': 'wrong' },
      body: JSON.stringify({ userId: 'alice' }),
    })

    assert.equal(response.status, 403)
  } finally {
    server.close()
  }
})

test('internal session endpoint returns launcher session payload', async () => {
  const sessionService = {
    docker: { ping: async () => ({ ok: true }) },
    createSession: async (payload) => ({
      iframePath: `/apps/nvscode/proxy/session/fake/?folder=${encodeURIComponent(payload.workspacePath)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    resolveProxyTarget: async () => 'http://example:8080',
  }

  const { app } = createLauncherApp({ internalSharedSecret: 'topsecret', sessionService })
  const server = http.createServer(app)
  server.listen(0)
  await once(server, 'listening')

  try {
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shared-Secret': 'topsecret' },
      body: JSON.stringify({ userId: 'alice', workspacePath: '/Documents' }),
    })

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN')
    const body = await response.json()
    assert.equal(body.expiresAt, '2099-01-01T00:00:00.000Z')
    assert.match(body.iframePath, /folder=%2FDocuments/)
  } finally {
    server.close()
  }
})

test('applySecurityHeaders updates proxy response headers objects', () => {
  const proxyRes = { headers: {} }

  applySecurityHeaders(proxyRes)

  assert.equal(proxyRes.headers['cache-control'], 'private, no-store, max-age=0')
  assert.equal(proxyRes.headers['referrer-policy'], 'no-referrer')
  assert.equal(proxyRes.headers['x-content-type-options'], 'nosniff')
  assert.equal(proxyRes.headers['x-frame-options'], 'SAMEORIGIN')
})

test('proxy error returns 502 for HTTP responses', async () => {
  const sessionService = {
    docker: { ping: async () => ({ ok: true }) },
    createSession: async () => ({ iframePath: '/ok', expiresAt: 'later' }),
    resolveProxyTarget: async () => 'http://127.0.0.1:9',
  }

  const { app } = createLauncherApp({ internalSharedSecret: 'topsecret', sessionService })
  const server = http.createServer(app)
  server.listen(0)
  await once(server, 'listening')

  try {
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/session/fake/`)

    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error, 'Proxy error')
  } finally {
    server.close()
  }
})

test('proxy error destroys websocket sockets without throwing', () => {
  const sessionService = {
    docker: { ping: async () => ({ ok: true }) },
    createSession: async () => ({ iframePath: '/ok', expiresAt: 'later' }),
    resolveProxyTarget: async () => 'http://example:8080',
  }

  const { proxy } = createLauncherApp({ internalSharedSecret: 'topsecret', sessionService })
  const socket = {
    destroyed: false,
    destroy() {
      this.destroyed = true
    },
  }

  proxy.emit('error', new Error('boom'), {}, socket)

  assert.equal(socket.destroyed, true)
})
