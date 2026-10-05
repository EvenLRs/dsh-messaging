require('./_guard.cjs') // 统一超时兜底：挂住即非零退出（见 test/_guard.cjs）
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
// P6（飞书实机排查）：会话被其他界面占用的两种形态，由用例切换。
//   'reuse' —— resume 被拒，但宿主里有活着的 agent（等价于 DSH 桌面端开着该会话）；
//   'stuck' —— resume 被拒且宿主里查不到活 agent（另一进程/瞬时占用）。
const sessionBusy = { mode: 'off', live: null }
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
      // P5：凭据改从 stdin 的 JSON 读，argv 里不再有 --secret。
      const input = JSON.parse(request.stdin || '{}')
      const secret = String(input.secret || '')
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
// 注册的全部 handler（含进单聊空处理器），用例直接调用它模拟 dispatcher 派发。
const larkHandlers = {}
const larkClients = []
const fakeLarkSdk = {
  LoggerLevel: { info: 'info', debug: 'debug' },
  EventDispatcher: class {
    register(handlers) {
      Object.assign(larkHandlers, handlers)
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
      if (sessionBusy.mode !== 'off') {
        const busy = new Error(`session "${id}" is already owned by an active write handle`)
        busy.name = 'SessionAlreadyOwnedError'
        throw busy
      }
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
    // 宿主的 agents.get(id)：返回当前活着的 agent（真实 dsh-agent 就是这个形状）。
    get(id) {
      if (sessionBusy.mode !== 'reuse') return undefined
      if (!sessionBusy.live || sessionBusy.live.id !== id) {
        sessionBusy.live = {
          id,
          messages: [],
          followup(message) { sessionBusy.live.messages.push(message) },
        }
      }
      return sessionBusy.live
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
// P5：`/__dsh-messaging/config` 已删除。配置的真源仍是磁盘上的 config.json
// （loadConfig = defaultConfig + 这份文件），写入后用 POST /reload 生效——
// 这与「设置页保存 → loader/volatile-update → 重建」的线上路径等价（本 harness 没有 Loader）。
const configFileKey = () => [...writtenFiles.keys()].filter((key) => key.includes('.dsh-messaging/config.json'))[0]

function readConfig() {
  const key = configFileKey()
  assert.ok(key, 'config.json must exist after the first start')
  return JSON.parse(writtenFiles.get(key))
}

async function saveConfig(config) {
  const key = configFileKey()
  assert.ok(key, 'config.json must exist before it can be rewritten')
  writtenFiles.set(key, JSON.stringify(config))
  const reload = await invoke('POST', '/__dsh-messaging/reload')
  assert.equal(reload.status, 200, 'reload must pick the new config up: ' + JSON.stringify(reload.json))
  return reload
}

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
  const config = readConfig()
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
  await saveConfig(config)

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

  // P5：curl 改成 `--config -`，URL / 请求头 / 请求体都在 stdin 的配置里。
  const outboundCurl = shellCalls.find((call) => String(call.stdin || '').includes('send_private_msg'))
  assert.equal(Boolean(outboundCurl), true, 'outbound reply should use curl')
  assert.equal(outboundCurl.command, 'curl --config -', 'the argv carries no URL, header or secret')
  assert.equal(String(outboundCurl.stdin).includes('data-binary = '), true, 'outbound JSON body rides in the stdin config')
  assert.equal(String(outboundCurl.stdin).includes('send_private_msg'), true, 'the target URL lives in the stdin config')

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
  assert.equal(readConfig().adapters.onebot.enabled, true)

  // Webhook credentials are user-supplied and must be stored verbatim: the values
  // have to match what the Feishu console holds, so the plugin must not rewrite them.
  // P5 收口：配置视图已经**不提供** HTTP 读取面（路由删除），所以 P1 的「回传必须抹成
  // 空串」断言迁移为两条更强的入口断言：磁盘原样保存；出口（/status）永远拿不到。
  const larkConfig = readConfig().adapters.lark
  assert.equal(larkConfig.verificationToken, 'user-token-abc', 'the console token must be stored verbatim')
  assert.equal(larkConfig.encryptKey, 'user-encrypt-key-xyz', 'the console encrypt key must be stored verbatim')
  assert.equal(routes.has('/__dsh-messaging/config'), false, 'the legacy config read/write route must be gone (P5)')
  const larkStatus = await invoke('GET', '/__dsh-messaging/status', { headers: loopbackHeaders() })
  assert.equal(JSON.stringify(larkStatus.json).includes('user-token-abc'), false, 'the lark token never leaves over /status')
  assert.equal(JSON.stringify(larkStatus.json).includes('user-encrypt-key-xyz'), false, 'the lark encrypt key never leaves over /status')
  const userToken = 'user-token-abc'

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
  const plaintextConfig = readConfig()
  plaintextConfig.adapters.lark.encryptKey = ''
  // 直写磁盘的空串就是「清空」：掩码回传时代的 __clearSecrets 保留键已随路由删除；
  // settings 通道里的清空语义是 op:'unset'（见 test/config-migration.cjs 场景 4b）。
  await saveConfig(plaintextConfig)
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

  // ── 飞书入站痕迹：每个丢弃分支都要在 recent 里留痕（kind=lark-drop）────
  // 只记原因与 message_type / chat_type / 文本长度，**绝不记消息原文**；
  // 富文本 post 则必须摊平成纯文本后照常入站。
  const larkDrops = async () => {
    const st = await invoke('GET', '/__dsh-messaging/status', { headers: loopbackHeaders() })
    return st.json.recent.filter((entry) => entry.kind === 'lark-drop')
  }
  assert.equal((await larkDrops()).length, 0, 'no lark event has been dropped so far')

  // 1) 富文本 post：标题 + 段落摊平（没有文本的图片段被跳过）→ 照常入站。
  const agentsBeforePost = createdAgents.length
  const postEvent = await postLark({
    token: userToken,
    event: {
      type: 'im.message.receive_v1',
      chat_id: 'oc_post',
      message: {
        message_id: 'om_post',
        message_type: 'post',
        chat_id: 'oc_post',
        chat_type: 'p2p',
        content: JSON.stringify({
          title: 'post-title',
          content: [
            [{ tag: 'text', text: 'line-1' }],
            [{ tag: 'img', image_key: 'img-key-not-text' }],
            [{ tag: 'a', text: 'link-label', href: 'https://example.invalid/x' }],
          ],
        }),
      },
    },
  })
  assert.equal(postEvent.statusCode, 200)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(createdAgents.length, agentsBeforePost + 1, 'a rich text post must reach an agent')
  assert.equal(
    createdAgents[createdAgents.length - 1].agent.messages[0].content[0].text,
    'post-title\nline-1\nlink-label',
    'post is flattened to plain text (elements without text are skipped)',
  )
  assert.equal((await larkDrops()).length, 0, 'a delivered post produces no drop record')

  // 2) 图片消息（content 里没有文本）→ 不支持的类型，只留元数据。
  const imageEvent = await postLark({
    token: userToken,
    event: {
      type: 'im.message.receive_v1',
      message: {
        message_id: 'om_img',
        message_type: 'image',
        chat_id: 'oc_img',
        chat_type: 'p2p',
        content: JSON.stringify({ image_key: 'img-key-secret' }),
      },
    },
  })
  assert.equal(imageEvent.statusCode, 200)
  await tick()
  const imageDrop = (await larkDrops())[0]
  assert.equal(imageDrop.reason, 'unsupported message_type')
  assert.equal(imageDrop.messageType, 'image')
  assert.equal(imageDrop.chatType, 'p2p')
  assert.equal(imageDrop.textLen, null)
  assert.equal(JSON.stringify(imageDrop).includes('img-key-secret'), false, 'a drop record must never carry the payload')

  // 3) 空文本 → no text（长度如实记录，文本本身不记）。
  const emptyEvent = await postLark({
    token: userToken,
    event: {
      type: 'im.message.receive_v1',
      message: { message_id: 'om_empty', message_type: 'text', chat_id: 'oc_empty', chat_type: 'p2p', content: JSON.stringify({ text: '   ' }) },
    },
  })
  assert.equal(emptyEvent.statusCode, 200)
  await tick()
  const emptyDrop = (await larkDrops())[1]
  assert.equal(emptyDrop.reason, 'no text')
  assert.equal(emptyDrop.textLen, 3, 'the whitespace length is recorded, the text is not')

  // 4) 缺 chatId → no chatId。
  const noChatEvent = await postLark({
    token: userToken,
    event: {
      type: 'im.message.receive_v1',
      message: { message_id: 'om_noid', message_type: 'text', chat_type: 'p2p', content: JSON.stringify({ text: 'no-chat-id-body' }) },
    },
  })
  assert.equal(noChatEvent.statusCode, 200)
  await tick()
  const noChatDrop = (await larkDrops())[2]
  assert.equal(noChatDrop.reason, 'no chatId')
  assert.equal(noChatDrop.textLen, 'no-chat-id-body'.length)
  assert.equal(JSON.stringify(noChatDrop).includes('no-chat-id-body'), false, 'the text itself is never recorded')

  // 5) 缺 message；6) 非消息事件。
  assert.equal((await postLark({ token: userToken, event: { type: 'im.message.receive_v1' } })).statusCode, 200)
  await tick()
  assert.equal((await larkDrops())[3].reason, 'no message')
  assert.equal((await postLark({ token: userToken, event: { type: 'im.chat.access_event.v1' } })).statusCode, 200)
  await tick()
  const allDrops = await larkDrops()
  assert.equal(allDrops.length, 5, 'every dropped branch leaves exactly one trace')
  assert.equal(allDrops[4].reason, 'not im.message.receive_v1')
  assert.equal(allDrops.some((entry) => JSON.stringify(entry).includes('line-1')), false, 'no drop record ever contains message text')

  // Long connection (WebSocket) subscription: appId + appSecret only, authenticated
  // at connect time, so no public address, no verification token, no encrypt key.
  const lcConfig = readConfig()
  lcConfig.adapters.lark.mode = 'long-connection'
  await saveConfig(lcConfig)
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
  // 飞书入站痕迹：connectedAt 记录 onReady 的时刻（握手成功才有值）。
  assert.equal(typeof lcStatus.detail.connectedAt, 'number', 'connectedAt must record the onReady time')
  const lastEventBeforeWs = lcStatus.detail.lastEventAt

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
  // 长连接送达的事件同样刷新 lastEventAt（connectedAt 不受影响）。
  const larkTraceStatus = await channelStatus('lark')
  assert.equal(typeof larkTraceStatus.detail.lastEventAt, 'number', 'lastEventAt must record the delivered event')
  assert.ok(
    lastEventBeforeWs === null || larkTraceStatus.detail.lastEventAt > lastEventBeforeWs,
    'the event timestamp moves forward when an event arrives',
  )
  assert.equal(typeof larkTraceStatus.detail.connectedAt, 'number', 'connectedAt survives later event updates')

  // ── SDK 层痕迹（lark-event）：日志行只提取字段，绝不落事件体 ─────────────
  // 真实调用形状（回归用例）：EventDispatcher 经 LoggerProxy → logger.warn(['<行>'])
  // 单元素数组；WSClient 是 logger.debug('[ws]', '<行>') → ['[ws]', '<行>'] 双元素。
  // 只取 [0] 会永远拿到 '[ws]' 而漏掉整行——必须逐段分类（实机 ws 痕迹缺失即此因）。
  const sdkLogger = ws.params.logger
  assert.equal(typeof sdkLogger.debug, 'function', 'the SDK logger must be injected for tracing')
  const larkSdkEvents = async () => {
    const st = await invoke('GET', '/__dsh-messaging/status', { headers: loopbackHeaders() })
    return st.json.recent.filter((entry) => entry.kind === 'lark-event')
  }
  assert.equal((await larkSdkEvents()).length, 0, 'no SDK line has been traced yet')

  // a) dispatcher 形状（单元素数组）：未注册类型 → unhandled。
  sdkLogger.warn(['no im.example.unregistered_event.v1 handle'])
  // b) WSClient 真实形状（['[ws]', '…']）：数据帧到达 → frame（修复前会整行漏掉）。
  sdkLogger.debug(['[ws]', 'receive message, message_type: event; message_id: m-frame; trace_id: t-frame; data: {"text":"FRAMED-SECRET-BODY"}'])
  // c) 噪声行：不得入 recent。
  sdkLogger.debug(['register app_ticket handle'])
  sdkLogger.info(['event-dispatch is ready'])
  // d) 我们自己已覆盖的类型：execute 去重，不重复记。
  sdkLogger.debug(['execute im.message.receive_v1 handle'])
  sdkLogger.debug(['execute im.chat.access_event.bot_p2p_chat_entered_v1 handle'])
  await tick()
  const sdkEvents = await larkSdkEvents()
  assert.equal(sdkEvents.length, 2, 'only the two event-bearing lines are traced (execute rows are deduped)')
  const frameEvent = sdkEvents.find((entry) => entry.source === 'ws')
  assert.ok(frameEvent, 'the ws frame arrival must be traced from the ["[ws]", …] shape')
  assert.equal(frameEvent.outcome, 'frame')
  assert.equal(frameEvent.messageType, 'event', 'the frame type is extracted from the header, not the body')
  const dispatcherEvent = sdkEvents.find((entry) => entry.source === 'dispatcher')
  assert.ok(dispatcherEvent, 'the dispatcher line is traced')
  assert.equal(dispatcherEvent.eventType, 'im.example.unregistered_event.v1')
  assert.equal(dispatcherEvent.outcome, 'unhandled', 'an unregistered event type is the thing this trace exists for')
  const traceText = JSON.stringify(sdkEvents)
  assert.equal(traceText.includes('FRAMED-SECRET-BODY'), false, 'the event body must never enter recent')
  assert.equal(traceText.includes('register app_ticket'), false, 'startup noise is not an event')
  assert.equal(traceText.includes('event-dispatch is ready'), false, 'readiness logs are not events')

  // ── 进单聊事件：空处理器（不再打 unhandled 噪声）+ 痕迹只留一次 ──────────
  const chatEntered = larkHandlers['im.chat.access_event.bot_p2p_chat_entered_v1']
  assert.equal(typeof chatEntered, 'function', 'the chat-entered event must have a registered handler')
  await chatEntered({})
  await chatEntered({})
  await tick()
  const afterAccess = await larkSdkEvents()
  assert.equal(afterAccess.length, 3, 'the chat-entered event is noted exactly once')
  const noted = afterAccess.find((entry) => entry.eventType === 'im.chat.access_event.bot_p2p_chat_entered_v1')
  assert.ok(noted, 'the first chat-entered event leaves one trace')
  assert.equal(noted.outcome, 'noted')
  assert.equal(typeof (await channelStatus('lark')).detail.lastEventAt, 'number', 'any event refreshes lastEventAt')

  // ── 消息已读事件：同一张表的空处理器 + 首次 noted；execute 不重复进 recent ──
  const messageRead = larkHandlers['im.message.message_read_v1']
  assert.equal(typeof messageRead, 'function', 'the message-read event must have a registered handler')
  sdkLogger.debug(['execute im.message.message_read_v1 handle']) // 分类器按表去重：不进 recent
  await messageRead({})
  await messageRead({})
  await tick()
  const afterRead = await larkSdkEvents()
  assert.equal(afterRead.length, 4, 'the execute row is skipped and the read event is noted exactly once')
  const readNoted = afterRead.find((entry) => entry.eventType === 'im.message.message_read_v1')
  assert.ok(readNoted, 'the first message-read event leaves one trace')
  assert.equal(readNoted.outcome, 'noted')
  assert.equal(
    afterRead.filter((entry) => entry.eventType === 'im.chat.access_event.bot_p2p_chat_entered_v1').length,
    1,
    'the chat-entered trace stays exactly once (dedupe is per event type)',
  )
  assert.equal(typeof (await channelStatus('lark')).detail.lastEventAt, 'number', 'lastEventAt keeps refreshing for every known event')

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
  await saveConfig(lcConfig)
  await tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(ws.closed, true, 'disabling the adapter must close the long connection')

  // ── 会话被其他界面占用（实机：飞书消息已到达、agent followup 却失败）──────
  const statusBeforeBusy = (await invoke('GET', '/__dsh-messaging/status')).json
  const onebotBeforeBusy = statusBeforeBusy.channels.find((channel) => channel.key === 'onebot')
  const inboundBeforeBusy = onebotBeforeBusy.inboundCount
  const postOnebotAs = async (userId, text) => {
    const payload = JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: userId,
      self_id: 999,
      raw_message: text,
      sender: { user_id: userId, nickname: 'busy' },
    })
    const signature = crypto.createHmac('sha1', 'test-secret-456').update(payload, 'utf8').digest('hex')
    const req = fakeRequest('POST', '/messaging/onebot', payload)
    req.headers = { 'content-type': 'application/json', 'x-signature': 'sha1=' + signature, 'x-self-id': '999' }
    const res = fakeResponse()
    await onebotRoute(req, res)
    await tick()
    return res
  }

  // A) 宿主里有活着的 agent（等价于 DSH 桌面端开着该会话）→ 复用它：
  //    消息必须并入那个会话，渠道不得被标成 error，状态页给出“同时在其他界面打开”。
  sessionBusy.mode = 'reuse'
  const reuseRes = await postOnebotAs(2002, 'busy reuse')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(reuseRes.statusCode < 400, true, 'a shared session must not fail the webhook')
  assert.equal(
    sessionBusy.live && sessionBusy.live.messages.length,
    1,
    'the message must be delivered to the live agent the other surface owns',
  )
  const statusAfterReuse = (await invoke('GET', '/__dsh-messaging/status')).json
  const onebotAfterReuse = statusAfterReuse.channels.find((channel) => channel.key === 'onebot')
  assert.equal(onebotAfterReuse.state, 'running', 'a shared session must not mark the adapter as failed')
  assert.ok(
    statusAfterReuse.errors.some((entry) => entry.context === 'agent followup' && entry.message.includes('已并入该会话')),
    'the shared-session notice must be recorded once',
  )

  // B) 占用方在宿主里查不到（另一进程/瞬时占用）→ 退避重试后给出可操作提示，
  //    渠道仍是 running（不是 error），消息计数照常推进。
  sessionBusy.mode = 'stuck'
  const stuckRes = await postOnebotAs(3003, 'busy stuck')
  await new Promise((resolve) => setTimeout(resolve, 1300)) // 3 × 300ms 退避
  assert.equal(stuckRes.statusCode < 400, true, 'the webhook itself still succeeds')
  const statusAfterStuck = (await invoke('GET', '/__dsh-messaging/status')).json
  const onebotAfterStuck = statusAfterStuck.channels.find((channel) => channel.key === 'onebot')
  assert.equal(onebotAfterStuck.state, 'running', 'a stuck session must not mark the adapter as failed')
  assert.equal(onebotAfterStuck.inboundCount, inboundBeforeBusy + 2, 'both messages were counted as inbound')
  assert.ok(
    statusAfterStuck.errors.some((entry) => entry.context === 'agent followup'
      && entry.message.includes('关闭 DSH 中打开的该会话')),
    'the actionable bilingual guidance must be recorded',
  )
  assert.equal(
    statusAfterStuck.errors.filter((entry) => entry.context === 'agent followup' && entry.message.includes('已并入该会话')).length,
    1,
    'the shared-session notice is recorded once per conversation (B is a different conversation)',
  )
  sessionBusy.mode = 'off'

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
