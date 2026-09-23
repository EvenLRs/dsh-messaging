'use strict'
// 登录路由集成测试：不碰网络，把 ctx.shell.run mock 成 ilink 网关，驱动
// **真实的 HTTP 路由 + startIlinkLogin/pollIlinkLoginStatus 全链路**，
// 断言设置页拿到的 qrcodeUrl 一直是可作 <img src> 的 SVG data URL——
// 这正是「二维码无法加载」缺陷的线上契约（缺陷时它是一个返回 HTML 的远程 URL）。
const path = require('node:path')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const routes = new Map()
const writtenFiles = new Map()

// 网关脚本：按 shell 命令里的端点分流，可在用例间切换。
const gateway = {
  qr: 'ok', // 'ok' | 'fail'
  statusSequence: ['wait'], // 每次 get_qrcode_status 依次消费，最后一个重复
  statusCalls: 0,
  qrCalls: 0,
}

const REAL_PAYLOAD =
  'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=215f1c6f7cdc370e72094cc6b5431d3f&bot_type=3'

function gatewayStdout(request) {
  const command = String((request && request.command) || '')
  if (command.includes('get_bot_qrcode')) {
    gateway.qrCalls++
    if (gateway.qr === 'fail') return '\n__DSH_STATUS__:500'
    if (gateway.qr === 'no-payload') {
      // HTTP 200 但缺少 qrcode_img_content：必须显式失败，而不是画一个空码。
      return JSON.stringify({ qrcode: 'x', ret: 0 }) + '\n__DSH_STATUS__:200'
    }
    const body = JSON.stringify({
      qrcode: '215f1c6f7cdc370e72094cc6b5431d3f',
      qrcode_img_content: REAL_PAYLOAD,
      ret: 0,
    })
    return body + '\n__DSH_STATUS__:200'
  }
  if (command.includes('get_qrcode_status')) {
    gateway.statusCalls++
    const seq = gateway.statusSequence
    const idx = Math.min(gateway.statusCalls - 1, seq.length - 1)
    const status = seq[idx]
    return JSON.stringify({ status }) + '\n__DSH_STATUS__:200'
  }
  return '\n__DSH_STATUS__:200'
}

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
        stdout: { text: gatewayStdout(request), truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
    start() {
      return { status: 'running', kill() { return false } }
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

function fakeRequest(method, url, { body, headers } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers || {}
  req.socket = { encrypted: false }
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
  res.writeHead = (status, hdrs) => {
    res.statusCode = status
    res.headers = hdrs || {}
    res.headersSent = true
  }
  res.end = (body) => {
    res.body = body
    res.finished = true
  }
  return res
}

async function invoke(method, routePath, opts = {}) {
  const handler = routes.get(routePath)
  assert.ok(handler, 'missing route ' + routePath)
  const headers = Object.assign(
    { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' },
    opts.headers || {},
  )
  const req = fakeRequest(method, routePath, Object.assign({}, opts, { headers }))
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

function assertQrDataUrl(value, label) {
  assert.equal(typeof value, 'string', label + ': qrcodeUrl must be a string')
  assert.ok(value.startsWith('data:image/svg+xml;base64,'), label + ': qrcodeUrl must be an inline svg data url, got: ' + value.slice(0, 64))
  const svg = Buffer.from(value.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
  assert.match(svg, /^<svg /, label + ': data url must decode to <svg')
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, label + ': svg must carry a viewBox')
  assert.match(svg, /<path d="M/, label + ': svg must draw dark modules')
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  await plugin.apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))

  // 1) 生成二维码：start 返回的 qrcodeUrl 必须是内联 SVG（缺陷时是远程 HTML URL）
  const start = await invoke('POST', '/__dsh-messaging/ilink/login/start', { body: '{}' })
  assert.equal(start.status, 200)
  assert.equal(start.json.ok, true, 'login start must succeed, got: ' + start.text)
  assert.ok(start.json.sessionKey, 'sessionKey required')
  assertQrDataUrl(start.json.qrcodeUrl, 'login/start')
  assert.ok(start.json.expiresAt > Date.now(), 'expiry must be in the future')
  assert.equal(gateway.qrCalls, 1, 'gateway must be asked exactly once')

  // 2) 轮询 wait：会话保持，不重新取码
  gateway.statusSequence = ['wait']
  gateway.statusCalls = 0
  const wait = await invoke('POST', '/__dsh-messaging/ilink/login/status', {
    body: JSON.stringify({ sessionKey: start.json.sessionKey }),
  })
  assert.equal(wait.json.status, 'wait')

  // 3) 二维码过期：自动刷新，返回的仍是内联 SVG data URL
  gateway.statusSequence = ['expired']
  gateway.statusCalls = 0
  const expired = await invoke('POST', '/__dsh-messaging/ilink/login/status', {
    body: JSON.stringify({ sessionKey: start.json.sessionKey }),
  })
  assert.equal(expired.json.status, 'expired', 'expired must be reported to the client')
  assertQrDataUrl(expired.json.qrcodeUrl, 'expired refresh')
  assert.equal(gateway.qrCalls, 2, 'expiry must fetch a fresh QR from the gateway')

  // 4) 网关故障：start 必须以 {ok:false, error} 失败，而不是返回空图
  gateway.qr = 'fail'
  const failed = await invoke('POST', '/__dsh-messaging/ilink/login/start', { body: '{}' })
  assert.equal(failed.status, 200)
  assert.equal(failed.json.ok, false, 'gateway failure must surface as ok:false')
  assert.match(String(failed.json.error), /HTTP 500/, 'error message must name the status')
  gateway.qr = 'ok'

  // 5) 字段缺失：HTTP 200 但没有 qrcode_img_content → 显式失败，不画空码
  gateway.qr = 'no-payload'
  const missing = await invoke('POST', '/__dsh-messaging/ilink/login/start', { body: '{}' })
  assert.equal(missing.status, 200)
  assert.equal(missing.json.ok, false, 'a payload-less gateway response must fail the start')
  assert.match(String(missing.json.error), /no qrcode_img_content/, 'the error must name the missing field')
  gateway.qr = 'ok'

  // 6) 取消：会话删除，重复 status 报 no active login
  const cancel = await invoke('POST', '/__dsh-messaging/ilink/login/cancel', {
    body: JSON.stringify({ sessionKey: start.json.sessionKey }),
  })
  assert.equal(cancel.json.ok, true)
  const after = await invoke('POST', '/__dsh-messaging/ilink/login/status', {
    body: JSON.stringify({ sessionKey: start.json.sessionKey }),
  })
  assert.equal(after.json.ok, false)
  assert.equal(after.json.error, 'no active login')

  console.log('login-qr-route: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
