const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// 隔离的 DSH 宿主存储根：入站会触发会话 id 惰性迁移的存在性探测，绝不能指向真实家目录。
const fixtureDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mig-home-'))

const routes = new Map()
const listeners = new Map()
// 每个 ctx.effect 注册的清理函数；生命周期测试按逆序执行它们以模拟 fiber 停用。
const effectDisposers = []
const shellCalls = []
const writtenFiles = new Map()
const createdAgents = []
// Durable session ids (survive the in-memory map being cleared) and resume calls.
const persistedSessions = new Set()
const resumedAgents = []

const fsService = {
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
}


const fakeShell = {
  resolve(request) {
    return request
  },
  async run(request) {
    shellCalls.push(request)
    if (request.command.includes('crypto-helper.cjs')) {
      const parts = request.command.split(/(?<!')\s+(?!')|\s+/)
      const secretIndex = parts.indexOf("'--secret'") >= 0 ? parts.indexOf("'--secret'") : parts.indexOf('--secret')
      const secretRaw = secretIndex >= 0 ? parts[secretIndex + 1] : ''
      const secret = secretRaw.replace(/^'|'$/g, '').replace(/''/g, "'")
      const input = JSON.parse(request.stdin || '{}')
      const crypto = require('node:crypto')
      const hmac = crypto.createHmac('sha1', secret).update(input.rawBody || '', 'utf8').digest('hex')
      const expected = 'sha1=' + hmac
      const match = input.signature === expected
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: request.timeoutMs || 60000,
        stdout: { text: JSON.stringify(match ? { ok: true } : { ok: false, error: 'mismatch' }), truncated: false },
        stderr: { text: '', truncated: false },
      }
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: request.timeoutMs || 60000,
      stdout: { text: '\n__DSH_STATUS__:200', truncated: false },
      stderr: { text: '', truncated: false },
    }
  },
  start(request) {
    return {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput() { return { delta: '', lossy: false } },
      kill() { return false },
    }
  },
}

// Injectable stand-in for @larksuiteoapi/node-sdk, consumed through the
// ctx.get('dshMessaging.larkSdk') seam the adapter allows for tests.
let larkEventHandler = null
const larkClients = []
const fakeLarkSdk = {
  LoggerLevel: { info: 'info' },
  EventDispatcher: class {
    register(handlers) {
      larkEventHandler = handlers['im.message.receive_v1']
      return this
    }
  },
  WSClient: class {
    constructor(params) {
      this.params = params
      this.started = false
      this.closed = false
      larkClients.push(this)
    }
    async start({ eventDispatcher }) {
      this.started = true
      this.eventDispatcher = eventDispatcher
      if (typeof this.params.onReady === 'function') this.params.onReady()
    }
    close() {
      this.closed = true
    }
  },
}

const ctx = {
  get(name) {
    if (name === 'dshMessaging.root') return '/mock/workspace'
    if (name === 'sandboxPolicy') return { workspaceRoot: '/mock/workspace' }
    if (name === 'dshMessaging.larkSdk') return fakeLarkSdk
    if (name === 'dsh.home') return fixtureDshHome
    return undefined
  },
  on(name, listener) { listeners[name] = listener; return () => {} },
  effect(fn) {
    const dispose = fn()
    effectDisposers.push(dispose)
    return dispose
  },
  interval() { return () => {} },
  webServer: {
    register(route) {
      // 与真实 dsh-host-webserver 一致：exact 路由重复注册必须抛错。
      // 停用时不注销（disposer 被丢弃）的回归会在这里立刻炸出来。
      if (routes.has(route.path)) {
        throw new Error('webserver: duplicate exact route "' + route.path + '"')
      }
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  shell: fakeShell,
  fs: fsService,
  // Real compositions always provide this; without it every agent creation logs a
  // "default model selection" error.
  agentDefaultModel: {
    currentSelection() {
      return { provider: 'test-provider', model: 'test-model' }
    },
  },
  agents: {
    // Models the real contract: a durable session id can be created once, and
    // `create` on an existing id rejects while `resume` on a missing one rejects.
    // Without this, the create-vs-resume regression cannot surface here.
    async create(options) {
      const id = options.sessionId
      if (persistedSessions.has(id)) {
        const error = new Error(`session "${id}" already exists`)
        error.name = 'SessionAlreadyExistsError'
        throw error
      }
      persistedSessions.add(id)
      const agent = {
        id,
        messages: [],
        followup(message) { agent.messages.push(message) },
      }
      const handle = {
        agent,
        async dispose() {},
      }
      createdAgents.push({ options, agent, handle })
      return handle
    },
    async resume(options) {
      const id = options.resumeSessionId
      if (!persistedSessions.has(id)) {
        const error = new Error(`session "${id}" not found`)
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      }
      const agent = {
        id,
        messages: [],
        followup(message) { agent.messages.push(message) },
      }
      const handle = {
        agent,
        async dispose() {},
      }
      resumedAgents.push({ options, agent, handle })
      return handle
    },
  },
}

function fakeRequest(method, url, body, headers) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers || {}
  req.socket = { encrypted: false }
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body) {
      const bytes = Buffer.from(body)
      req.emit('data', bytes)
    }
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
  }
  res.end = (body) => {
    res.body = body
    res.finished = true
  }
  return res
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// One channel entry from the live status snapshot.
async function channelStatus(key) {
  const status = await invoke('GET', '/__dsh-messaging/status')
  return status.json.channels.find((channel) => channel.key === key)
}

// 会话 id 派生不再本地镜像：直接用被测模块的真实实现（带键哈希的防碰撞方案）。
function loopbackHeaders(extra) {
  return Object.assign({
    origin: 'http://127.0.0.1:3080',
    host: '127.0.0.1:3080',
  }, extra || {})
}

async function invoke(method, routePath, { body, headers } = {}) {
  const handler = routes.get(routePath)
  assert.ok(handler, 'missing route ' + routePath)
  const req = fakeRequest(method, routePath, body, headers || loopbackHeaders())
  const res = fakeResponse()
  await handler(req, res)
  await tick()
  await tick()
  let json = null
  if (res.body) {
    try { json = JSON.parse(res.body) } catch { json = res.body }
  }
  return { status: res.statusCode, json }
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  const { sessionIdForKey } = await import(pathToFileURL(path.join(root, 'lib', 'session-id-migration.js')).href)
  await plugin.apply(ctx)
  await tick()

  assert.equal(writtenFiles.size > 0, true, 'config should be written on first start')
  // Long connection is the default and needs no inbound credentials at all.
  const firstWrite = JSON.parse([...writtenFiles.values()].pop())
  assert.equal(firstWrite.adapters.lark.mode, 'long-connection', 'long connection should be the default mode')
  assert.equal(firstWrite.adapters.lark.verificationToken, '', 'no token is generated: the user supplies it in webhook mode')
  // Security fix: onebot webhook should NOT be registered without secret
  assert.equal(routes.has('/messaging/onebot'), false, 'onebot webhook should not be registered without secret')
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.name, 'dsh-messaging')
  assert.ok(plugin.inject.includes('webServer'))
  assert.ok(plugin.inject.includes('agents'))

  // Set mock secret for onebot adapter and reload
  const configRes = await invoke('GET', '/__dsh-messaging/config')
  assert.equal(configRes.status, 200)
  const config = configRes.json.config
  config.adapters.onebot.secret = 'test-secret-456'
  config.adapters.onebot.accessToken = 'test-token-789'
  // Lark webhook coverage: the user supplies the credentials exactly as the Feishu
  // console shows them; the plugin neither generates nor rewrites them.
  config.adapters.lark.enabled = true
  config.adapters.lark.mode = 'webhook'
  config.adapters.lark.appId = 'cli_test'
  config.adapters.lark.appSecret = 'secret_test'
  config.adapters.lark.verificationToken = 'user-token-abc'
  config.adapters.lark.encryptKey = 'user-encrypt-key-xyz'
  const saved = await invoke('POST', '/__dsh-messaging/config', {
    body: JSON.stringify(config),
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
  })
  assert.equal(saved.status, 200)

  // Trigger reload to apply the new secret
  const reloadRes = await invoke('POST', '/__dsh-messaging/reload', {
    headers: loopbackHeaders({}),
  })
  assert.equal(reloadRes.status, 200)
  await tick()

  // Now webhook should be registered with secret
  assert.equal(routes.has('/messaging/onebot'), true, 'onebot webhook should be registered after secret is set')

  const onebotRoute = routes.get('/messaging/onebot')

  const samplePayload = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 1001,
    self_id: 999,
    raw_message: 'hello from smoke',
    sender: { user_id: 1001, nickname: 'smoke' },
  })

  // 1. Negative assertion: Non-application/json content-type (e.g. text/plain CSRF attempt) -> 415
  const csrfReq = fakeRequest('POST', '/messaging/onebot', samplePayload)
  csrfReq.headers = { 'content-type': 'text/plain' }
  const csrfRes = fakeResponse()
  await onebotRoute(csrfReq, csrfRes)
  await tick()
  assert.equal(csrfRes.statusCode, 415, 'text/plain request must return 415 unsupported media type')
  assert.equal(createdAgents.length, 0, 'no agent should be created for CSRF text/plain request')

  // 2. Negative assertion: Missing X-Signature when secret is configured -> 401
  const unauthReq = fakeRequest('POST', '/messaging/onebot', samplePayload)
  unauthReq.headers = { 'content-type': 'application/json' }
  const unauthRes = fakeResponse()
  await onebotRoute(unauthReq, unauthRes)
  await tick()
  assert.equal(unauthRes.statusCode, 401, 'request without X-Signature must return 401')
  assert.equal(createdAgents.length, 0, 'no agent should be created for unsigned request')

  // 3. Negative assertion: Invalid X-Signature -> 401
  const badReq = fakeRequest('POST', '/messaging/onebot', samplePayload)
  badReq.headers = {
    'content-type': 'application/json',
    'x-signature': 'sha1=0000000000000000000000000000000000000000',
  }
  const badRes = fakeResponse()
  await onebotRoute(badReq, badRes)
  await tick()
  assert.equal(badRes.statusCode, 401, 'request with bad X-Signature must return 401')
  assert.equal(createdAgents.length, 0, 'no agent should be created for bad signature request')

  // 4. Positive assertion: Valid X-Signature with application/json (fake-bot-server protocol)
  const crypto = require('node:crypto')
  const validHmac = crypto.createHmac('sha1', 'test-secret-456').update(samplePayload, 'utf8').digest('hex')
  const req = fakeRequest('POST', '/messaging/onebot', samplePayload)
  req.headers = {
    'content-type': 'application/json',
    'x-signature': 'sha1=' + validHmac,
    'x-self-id': '999',
  }
  const res = fakeResponse()
  await onebotRoute(req, res)
  await tick()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(createdAgents.length, 1, 'one agent should be created for the inbound message')
  assert.equal(createdAgents[0].agent.messages.length, 1)
  assert.equal(createdAgents[0].agent.messages[0].content[0].text, 'hello from smoke')

  const agentId = createdAgents[0].agent.id
  listeners['session/event']({ id: agentId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'hello back' }] } },
  })
  listeners['session/event']({ id: agentId }, {
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  })
  await tick()

  const outboundCurl = shellCalls.find((call) => call.command.includes('send_private_msg'))
  assert.equal(Boolean(outboundCurl), true, 'outbound reply should use curl')
  assert.equal(outboundCurl.command.includes('--data-binary'), true, 'outbound JSON body should be sent via curl stdin')

  const statusRes = await invoke('GET', '/__dsh-messaging/status')
  assert.equal(statusRes.status, 200)
  const status = statusRes.json
  const onebot = status.channels.find((channel) => channel.key === 'onebot')
  assert.equal(onebot.state, 'running')
  assert.equal(onebot.inboundCount, 1)
  assert.equal(onebot.outboundCount, 1)
  assert.equal(status.sessions.length, 1)
  assert.equal(status.sessions[0].conversation, 'private:1001')
  // A conversation without a channel prefix still gets one in the key.
  assert.equal(status.sessions[0].key, 'onebot:private:1001')
  assert.equal(status.channels.length, 7)
  const configResult = await invoke('GET', '/__dsh-messaging/config')
  assert.equal(configResult.json.config.adapters.onebot.enabled, true)

  // Webhook credentials are user-supplied and must be stored verbatim: the values
  // have to match what the Feishu console holds, so the plugin must not rewrite them.
  const larkConfig = (await invoke('GET', '/__dsh-messaging/config')).json.config.adapters.lark
  assert.equal(larkConfig.verificationToken, 'user-token-abc', 'the user-supplied token must be kept')
  assert.equal(larkConfig.encryptKey, 'user-encrypt-key-xyz', 'the user-supplied encrypt key must be kept')
  const userToken = larkConfig.verificationToken

  // The persisted record is what the inbound gate reads. The plugin builds this
  // path with POSIX joins, so compare on normalized separators.
  const configKey = [...writtenFiles.keys()]
    .map((key) => key.replace(/\\/g, '/'))
    .filter((key) => key.includes('.dsh-messaging/config.json'))
    .pop()
  assert.ok(configKey, 'the config file should have been written')
  const persistedText = writtenFiles.get(configKey) || writtenFiles.get(configKey.replace(/\//g, '\\'))
  const persisted = JSON.parse(persistedText)
  assert.equal(persisted.adapters.lark.verificationToken, userToken)
  assert.equal(persisted.adapters.lark.encryptKey, 'user-encrypt-key-xyz')

  const larkRoute = routes.get('/messaging/lark/events')
  assert.ok(larkRoute, 'lark webhook route should be registered once the adapter runs')

  const postLark = async (payload) => {
    const larkReq = fakeRequest('POST', '/messaging/lark/events', JSON.stringify(payload))
    larkReq.headers = { 'content-type': 'application/json' }
    const larkRes = fakeResponse()
    await larkRoute(larkReq, larkRes)
    await tick()
    return larkRes
  }

  const challengeDenied = await postLark({ type: 'url_verification', token: 'wrong', challenge: 'c1' })
  assert.equal(challengeDenied.statusCode, 401, 'challenge with wrong token must be refused')

  const challengeOk = await postLark({ type: 'url_verification', token: userToken, challenge: 'c1' })
  assert.equal(challengeOk.statusCode, 200, 'the challenge is answered after the token matches')
  assert.equal(JSON.parse(challengeOk.body).challenge, 'c1', 'challenge must be echoed for address verification')

  // An encrypted payload is decrypted with the user's key; undecryptable ciphertext
  // is refused rather than passed through.
  const badCipher = await postLark({ encrypt: 'not-valid-ciphertext' })
  assert.equal(badCipher.statusCode, 401, 'an undecryptable payload must be refused')

  // Plaintext inbound requires the Feishu side to run without an Encrypt Key, so
  // clear it before exercising the message path (the key case is asserted above).
  const plaintextConfig = (await invoke('GET', '/__dsh-messaging/config')).json.config
  plaintextConfig.adapters.lark.encryptKey = ''
  await invoke('POST', '/__dsh-messaging/config', {
    body: JSON.stringify(plaintextConfig),
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
  })
  await tick()

  const agentsBeforeLark = createdAgents.length
  const larkMessage = await postLark({
    token: userToken,
    event: {
      type: 'im.message.receive_v1',
      message: { message_id: 'om_1', chat_id: 'oc_1', content: JSON.stringify({ text: 'hi from lark' }) },
    },
  })
  assert.equal(larkMessage.statusCode, 200)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(createdAgents.length, agentsBeforeLark + 1, 'a token-authenticated lark message should reach an agent')
  assert.equal(createdAgents[createdAgents.length - 1].agent.messages[0].content[0].text, 'hi from lark')

  // The same event may arrive in the v2 shape (schema/header/event), which is what the
  // current Feishu platform sends. The body then sits under event.event.
  const agentsBeforeV2 = createdAgents.length
  const v2Webhook = await postLark({
    schema: '2.0',
    token: userToken,
    header: { event_id: 'ev_2', event_type: 'im.message.receive_v1', token: userToken },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: 'om_v2',
        chat_id: 'oc_v2',
        message_type: 'text',
        content: JSON.stringify({ text: 'v2 webhook message' }),
      },
    },
  })
  assert.equal(v2Webhook.statusCode, 200)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(createdAgents.length, agentsBeforeV2 + 1, 'a v2 webhook event must reach an agent')
  assert.equal(createdAgents[createdAgents.length - 1].agent.messages[0].content[0].text, 'v2 webhook message')

  // Long connection (WebSocket) subscription: appId + appSecret only, authenticated
  // at connect time, so no public address, no verification token, no encrypt key.
  const lcConfig = (await invoke('GET', '/__dsh-messaging/config')).json.config
  lcConfig.adapters.lark.mode = 'long-connection'
  const lcSaved = await invoke('POST', '/__dsh-messaging/config', {
    body: JSON.stringify(lcConfig),
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
  })
  assert.equal(lcSaved.status, 200)
  await tick()

  assert.equal(larkClients.length, 1, 'long connection mode must create exactly one WSClient')
  const ws = larkClients[0]
  assert.equal(ws.started, true, 'the WSClient must be started')
  assert.equal(ws.params.appId, 'cli_test')
  assert.equal(ws.params.appSecret, 'secret_test')
  assert.equal(typeof larkEventHandler, 'function', 'im.message.receive_v1 must be registered on the dispatcher')

  const lcStatus = await channelStatus('lark')
  assert.equal(lcStatus.state, 'running', 'onReady should mark the channel running')
  assert.equal(lcStatus.detail.mode, 'long-connection')

  // No HTTP webhook route is registered in this mode.
  assert.equal(routes.has('/messaging/lark/events'), false, 'long connection mode must not register the webhook route')

  // The long connection delivers a v2 event. Derive the payload shape from the REAL
  // SDK instead of hand-writing one: a hand-written v1 shape (`event.type`) previously
  // hid a production bug where every v2 event was silently dropped.
  const realSdk = await import('@larksuiteoapi/node-sdk')
  let sdkDelivered = null
  const realDispatcher = new realSdk.EventDispatcher({})
  realDispatcher.register({
    'im.message.receive_v1': async (data) => { sdkDelivered = data },
  })
  await realDispatcher.invoke({
    schema: '2.0',
    header: {
      event_id: 'ev_1',
      event_type: 'im.message.receive_v1',
      create_time: '1790000000000',
      token: 'ignored-on-long-connection',
      app_id: 'cli_test',
      tenant_key: 'tenant_test',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: 'om_ws',
        chat_id: 'oc_ws',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi over ws' }),
      },
    },
  }, { needCheck: false })
  assert.ok(sdkDelivered, 'the real SDK must deliver a v2 frame to a registered handler')
  assert.equal(sdkDelivered.event_type, 'im.message.receive_v1', 'the SDK flattens header.event_type to the top level')
  assert.equal(sdkDelivered.type, undefined, 'a v2 event carries no v1-style type field')
  assert.ok(sdkDelivered.message, 'the v2 message body is at the top level')

  const agentsBeforeLc = createdAgents.length
  await larkEventHandler(sdkDelivered)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(createdAgents.length, agentsBeforeLc + 1, 'a pushed long-connection event should reach an agent')
  assert.equal(createdAgents[createdAgents.length - 1].agent.messages[0].content[0].text, 'hi over ws')

  // A conversation that already carries its channel prefix (the adapters strip it when
  // sending, so inbound conversations look like "lark:oc_x") must not be prefixed again.
  const sessionStatus = await invoke('GET', '/__dsh-messaging/status')
  const larkSession = sessionStatus.json.sessions.find((entry) => entry.channel === 'lark')
  assert.ok(larkSession, 'the lark session should exist')
  assert.equal(larkSession.key, larkSession.conversation, 'the session key carries the prefixed conversation once')
  assert.equal(larkSession.key.startsWith('lark:lark:'), false, 'the session key must not double the channel prefix')
  assert.equal(larkSession.sessionId.startsWith('dsh-msg-lark-lark-'), false, 'the session id must not double the prefix')

  // A settings save (or a process restart) clears the in-memory conversation map while
  // the durable DSH session stays on disk. The next message must RESUME that session:
  // re-issuing `create` for the same id rejects with SessionAlreadyExistsError, which
  // would silently drop the message.
  const wsSessionId = sessionIdForKey('lark:oc_ws')
  assert.equal(persistedSessions.has(wsSessionId), true, 'the ws session was created durably')
  const resumedBefore = resumedAgents.length
  const createdBefore = createdAgents.length
  await invoke('POST', '/__dsh-messaging/reload', { body: '{}', headers: loopbackHeaders() })
  await tick()
  await larkEventHandler({
    schema: '2.0',
    header: { event_id: 'ev_2', event_type: 'im.message.receive_v1', create_time: '2', app_id: 'cli_test' },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: 'om_ws_2',
        chat_id: 'oc_ws',
        message_type: 'text',
        content: JSON.stringify({ text: 'second over ws' }),
      },
    },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(createdAgents.length, createdBefore, 'no second session may be created for the same chat')
  assert.equal(resumedAgents.length, resumedBefore + 1, 'the persisted session must be resumed instead of created')
  const resumed = resumedAgents[resumedAgents.length - 1]
  assert.equal(resumed.options.resumeSessionId, wsSessionId)
  assert.equal(resumed.agent.messages.map((m) => m.content[0].text).includes('second over ws'), true, 'the resumed agent received the message')
  const afterResume = await invoke('GET', '/__dsh-messaging/status')
  assert.equal(
    afterResume.json.errors.some((entry) => String(entry.message).includes('already exists')),
    false,
    'the message must not fail with a duplicate-session error',
  )

  // Disabling the channel must close the connection rather than leak it.
  lcConfig.adapters.lark.enabled = false
  await invoke('POST', '/__dsh-messaging/config', {
    body: JSON.stringify(lcConfig),
    headers: loopbackHeaders({ 'content-type': 'application/json' }),
  })
  await tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(ws.closed, true, 'disabling the adapter must close the long connection')


  // 生命周期回归：UI 路由必须随 fiber 注销。真实 webServer 对 exact 重复注册会抛错
  // （上面的 mock 已对齐），因此「停用不注销 → 再启用必撞 duplicate exact route」
  // 会在这里以二次 apply 抛错的形式暴露——这正是真机上 disable→enable 后插件
  // 在本进程内永久无法激活的缺陷。
  assert.equal(routes.has('/__dsh-messaging/status'), true, 'UI route registered while active')
  assert.equal(routes.has('/messaging/onebot'), true, 'onebot webhook registered while active')
  for (const dispose of effectDisposers.slice().reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
  assert.equal(routes.has('/__dsh-messaging/status'), false, 'UI routes must be disposed with the plugin fiber')
  assert.equal(routes.has('/__dsh-messaging/ilink/login/start'), false, 'every UI route must be disposed')
  assert.equal(routes.has('/messaging/onebot'), false, 'webhook routes are disposed via disposeAdapters')
  await plugin.apply(ctx) // 二次激活（等价 disable→enable）：不得再撞 duplicate exact route
  await tick()
  assert.equal(routes.has('/__dsh-messaging/status'), true, 're-apply must re-register the UI routes')
  assert.equal(routes.has('/__dsh-messaging/ilink/login/start'), true, 'all UI routes return after re-apply')

  fs.rmSync(fixtureDshHome, { recursive: true, force: true })
  console.log('host-smoke: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
