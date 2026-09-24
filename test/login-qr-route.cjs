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
  qr: 'ok', // 'ok' | 'fail' | 'no-payload'
  send: '{"message_id":987654321}', // sendmessage 响应体；成功形状**无 ret 字段**（实测）
  lastSendPayload: null, // 捕获的 sendmessage 请求体（stdin），用于断言信封字段
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
  if (command.includes('sendmessage')) {
    try { gateway.lastSendPayload = JSON.parse(String(request.stdin || 'null')) } catch { gateway.lastSendPayload = null }
    return gateway.send + '\n__DSH_STATUS__:200'
  }
  if (command.includes('getupdates')) {
    // 让长轮询循环**单次即退出**：mock 的 shell 瞬时解析会让 while 循环变成
    // 微任务风暴、饿死事件循环（启用 wechat 适配器后 suite 曾整体挂死）。
    return '\n__DSH_STATUS__:500'
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

  // 6.5) 启用 wechat 适配器（默认 disabled；出站用例要求 adapter 就绪，
  //      否则 sendOutbound 以 'adapter not ready' 失败——这正是 case7 首跑失败的原因）
  const cfgBefore = await invoke('GET', '/__dsh-messaging/config')
  const cfg = cfgBefore.json.config
  cfg.adapters.wechat.enabled = true
  const cfgSaved = await invoke('POST', '/__dsh-messaging/config', { body: JSON.stringify(cfg) })
  assert.equal(cfgSaved.status, 200, 'config save must succeed')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  // 7) 出站成功形状：sendmessage 返回 {message_id}（**无 ret 字段**，实测网关如此）。
  //    旧判据 ret===0 把成功判成失败、错误串恰为 'HTTP 200'——回复被误报未送达。
  gateway.send = '{"message_id":987654321}'
  const sendOk = await invoke('POST', '/__dsh-messaging/send', {
    body: JSON.stringify({ channel: 'wechat', conversation: 'wechat:tester', text: 'hello' }),
  })
  assert.equal(sendOk.json.ok, true, 'message_id 形状必须判成功')
  assert.equal(sendOk.json.error, null, '成功不得带错误')
  // 出站信封必须与参考实现一致（openclaw-weixin / wechat-ilink-client 双源）：
  // 缺 message_type/message_state/client_id 时网关返回 message_id 但手机端不显示。
  const sent = gateway.lastSendPayload && gateway.lastSendPayload.msg
  assert.ok(sent, 'send payload must be captured from stdin')
  assert.equal(sent.from_user_id, '', 'from_user_id must be explicit empty string')
  assert.equal(sent.message_type, 2, 'message_type must be BOT(2)')
  assert.equal(sent.message_state, 2, 'message_state must be FINISH(2)')
  assert.match(String(sent.client_id), /^dsh-messaging-[0-9a-f]{16}$/, 'client_id must be a unique id')
  assert.equal(sent.to_user_id, 'wechat:tester'.replace(/^wechat:/, ''), 'to_user_id strips the channel prefix')
  assert.equal(sent.item_list[0].type, 1, 'text item type')
  assert.equal(sent.item_list[0].text_item.text, 'hello')

  // 8) 真失败：ret 非 0 → 透传 errmsg
  gateway.send = '{"ret":7,"errmsg":"boom"}'
  const sendFail = await invoke('POST', '/__dsh-messaging/send', {
    body: JSON.stringify({ channel: 'wechat', conversation: 'wechat:tester', text: 'x' }),
  })
  assert.equal(sendFail.json.ok, false)
  assert.equal(sendFail.json.error, 'boom', 'errmsg 必须透传')

  // 9) 不可判定形状 → 失败且错误带 body 预览（诊断性，不再只有裸 'HTTP 200'）
  gateway.send = '{"foo":1}'
  const sendWeird = await invoke('POST', '/__dsh-messaging/send', {
    body: JSON.stringify({ channel: 'wechat', conversation: 'wechat:tester', text: 'x' }),
  })
  assert.equal(sendWeird.json.ok, false)
  assert.match(String(sendWeird.json.error), /^HTTP 200 body=/, '错误必须携带响应体预览')

  console.log('login-qr-route: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
