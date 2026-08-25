'use strict'
const path = require('node:path')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const routes = new Map()
const writtenFiles = new Map()

const ctx = {
  get(name) {
    if (name === 'dshMessaging.root') return '/mock/workspace'
    if (name === 'sandboxPolicy') return { workspaceRoot: '/mock/workspace' }
    return undefined
  },
  on() { return () => {} },
  effect() { return () => {} },
  interval() { return () => {} },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  shell: {
    resolve(request) { return request },
    async run(request) {
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        timeoutMs: request.timeoutMs || 60000,
        stdout: { text: '\n__DSH_STATUS__:200', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
    start() {
      return {
        status: 'running',
        kill() { return false },
      }
    },
  },
  fs: {
    async resolve(filePath) { return { displayPath: filePath, targetKey: filePath } },
    async readText(target) {
      const existing = writtenFiles.get(target.displayPath)
      if (existing !== undefined) return existing
      const error = new Error('not found')
      error.code = 'FS_NOT_FOUND'
      throw error
    },
    async writeText(target, content) {
      writtenFiles.set(target.displayPath, content)
      return { version: 'v1' }
    },
  },
  agents: {
    async create(options) {
      return { agent: { id: options.sessionId, followup() {} }, async dispose() {} }
    },
  },
}

function fakeRequest(method, url, { body, headers, encrypted } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers || {}
  req.socket = { encrypted: Boolean(encrypted) }
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function fakeResponse() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = (status, headers) => {
    res.statusCode = status
    res.headers = headers || {}
    res.headersSent = true
  }
  res.end = (body) => {
    res.body = body
    res.finished = true
  }
  return res
}

async function invoke(method, path, opts) {
  const handler = routes.get(path)
  assert.ok(handler, 'missing route ' + path)
  const req = fakeRequest(method, path, opts)
  const res = fakeResponse()
  await handler(req, res)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  let json = null
  if (res.body) {
    try { json = JSON.parse(res.body) } catch { json = res.body }
  }
  return { status: res.statusCode, json, text: res.body }
}

function loopbackHeaders(extra) {
  return Object.assign({
    origin: 'http://127.0.0.1:3080',
    host: '127.0.0.1:3080',
  }, extra || {})
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  await plugin.apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))

  const expected = [
    '/__dsh-messaging/status',
    '/__dsh-messaging/config',
    '/__dsh-messaging/reload',
    '/__dsh-messaging/send',
    '/__dsh-messaging/ilink/login/start',
    '/__dsh-messaging/ilink/login/status',
    '/__dsh-messaging/ilink/login/verify',
    '/__dsh-messaging/ilink/login/cancel',
  ]
  for (const pathName of expected) {
    assert.equal(routes.has(pathName), true, 'route missing: ' + pathName)
  }
  assert.equal(plugin.name, 'dsh-messaging')
  assert.ok(plugin.inject.includes('webServer'))

  const denied = [
    await invoke('GET', '/__dsh-messaging/status', { headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } }),
    await invoke('GET', '/__dsh-messaging/status', { headers: { origin: 'http://127.0.0.1:3080', host: 'evil.example' } }),
    await invoke('GET', '/__dsh-messaging/status', { headers: { host: '127.0.0.1:3080' } }),
    await invoke('GET', '/__dsh-messaging/status', { headers: { origin: 'https://127.0.0.1:3080', host: '127.0.0.1:3080' } }),
  ]
  for (const result of denied) {
    assert.equal(result.status, 403)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'forbidden origin')
  }

  const status = await invoke('GET', '/__dsh-messaging/status', { headers: loopbackHeaders() })
  assert.equal(status.status, 200)
  assert.ok(Array.isArray(status.json.channels))
  assert.equal(status.json.channels.length, 7)

  const config = await invoke('GET', '/__dsh-messaging/config', { headers: loopbackHeaders() })
  assert.equal(config.status, 200)
  assert.ok(config.json.config)
  assert.ok(config.json.config.adapters)

  const methodNotAllowed = await invoke('POST', '/__dsh-messaging/status', { headers: loopbackHeaders(), body: '{}' })
  assert.equal(methodNotAllowed.status, 405)

  const localhost = await invoke('GET', '/__dsh-messaging/status', {
    headers: { origin: 'http://localhost:3080', host: 'localhost:3080' },
  })
  assert.equal(localhost.status, 200)

  const ipv6 = await invoke('GET', '/__dsh-messaging/status', {
    headers: { origin: 'http://[::1]:3080', host: '[::1]:3080' },
  })
  assert.equal(ipv6.status, 200, 'IPv6 loopback [::1] must be accepted')
  assert.ok(Array.isArray(ipv6.json.channels))

  const refererOnly = await invoke('GET', '/__dsh-messaging/status', {
    headers: { referer: 'http://127.0.0.1:3080/settings', host: '127.0.0.1:3080' },
  })
  assert.equal(refererOnly.status, 200)

  const nextConfig = JSON.parse(JSON.stringify(config.json.config))
  nextConfig.adapters.onebot.enabled = false
  const saved = await invoke('POST', '/__dsh-messaging/config', {
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(nextConfig),
  })
  assert.equal(saved.status, 200)
  const onebot = saved.json.channels.find((channel) => channel.key === 'onebot')
  assert.equal(onebot.enabled, false)

  const reloaded = await invoke('POST', '/__dsh-messaging/reload', {
    headers: loopbackHeaders(),
    body: '{}',
  })
  assert.equal(reloaded.status, 200)
  assert.ok(Array.isArray(reloaded.json.channels))

  const sendFail = await invoke('POST', '/__dsh-messaging/send', {
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ channel: 'onebot' }),
  })
  assert.equal(sendFail.status, 500)
  assert.match(String(sendFail.json.error), /messaging_send requires/)

  const loginStart = await invoke('POST', '/__dsh-messaging/ilink/login/start', {
    headers: loopbackHeaders(),
    body: '{}',
  })
  assert.equal(loginStart.status, 200)
  assert.equal(loginStart.json.ok, false)
  assert.ok(loginStart.json.error)

  const loginStatus = await invoke('POST', '/__dsh-messaging/ilink/login/status', {
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ sessionKey: 'missing' }),
  })
  assert.equal(loginStatus.status, 200)

  const loginVerify = await invoke('POST', '/__dsh-messaging/ilink/login/verify', {
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ sessionKey: 'missing', verifyCode: '123' }),
  })
  assert.equal(loginVerify.status, 200)
  assert.equal(loginVerify.json.ok, false)
  assert.equal(loginVerify.json.error, 'no active login')

  const loginCancel = await invoke('POST', '/__dsh-messaging/ilink/login/cancel', {
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ sessionKey: 'missing' }),
  })
  assert.equal(loginCancel.status, 200)
  assert.equal(loginCancel.json.ok, true)

  console.log('http-routes: ok')
  console.log('routes:', expected.join(', '))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
