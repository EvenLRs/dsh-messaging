// 合理总时长（含 P 阶段 5 次尝试真退避链 ≈75s；各阶段均为完成条件 poll，非固定 sleep）。
process.env.DSH_TEST_TIMEOUT_MS = process.env.DSH_TEST_TIMEOUT_MS || '240000'
require('./_guard.cjs') // 统一超时兜底（见 test/_guard.cjs）
const path = require('node:path')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// 隔离的 DSH 宿主存储根：入站的会话 id 迁移探测绝不能指向真实家目录。
const fixtureDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-int-home-'))

const routes = new Map()
const listeners = new Map() // name -> [{ fn, options }]（真实 ctx.on 支持同名多监听器）
const effectDisposers = []
const shellCalls = []
const writtenFiles = new Map()
const createdAgents = []
const persistedSessions = new Set()

// ── wire 记录：每个 curl 调用的 method/url/headers/body（body 是字符串）──────────
const wire = []
let wireIdSeq = 0
let holdNext = null // { match, deferred } —— 挂住下一个命中的请求（reload 在途用例）
let throwNext = null // (entry) => boolean —— 下一个命中的请求直接抛网络错误（无响应）
let failNext = null // (entry) => boolean —— 下一个命中的请求返回明确的 API 失败响应
let timeoutNext = null // (entry) => boolean —— 下一个命中的请求返回式超时（exitCode28/timedOut/status0，非 throw）

// 手动 well-formed 校验（与实现同口径，不依赖较新 API）。
const isWellFormedStr = (str) => {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = str.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

// 注入式 fake clock：驱动飞书 9/10 分钟卡片窗口，不真实等待。
// advance(ms, {fire:false}) 可模拟 timer 错过（直接跳时），专测 publish 到期兑底。
const fakeClock = {
  nowMs: Date.now(),
  timers: new Map(),
  nextHandle: 1,
  now() { return fakeClock.nowMs },
  setTimeout(fn, ms) {
    const handle = fakeClock.nextHandle++
    fakeClock.timers.set(handle, { fn, at: fakeClock.nowMs + ms })
    return handle
  },
  clearTimeout(handle) { fakeClock.timers.delete(handle) },
  advance(ms, { fire = true } = {}) {
    fakeClock.nowMs += ms
    if (!fire) return 0
    const due = []
    for (const [handle, timer] of [...fakeClock.timers.entries()]) {
      if (timer.at <= fakeClock.nowMs) { fakeClock.timers.delete(handle); due.push(timer.fn) }
    }
    for (const fn of due) fn()
    return due.length
  },
}

// busy/borrow：resume 被拒且宿主有活 agent 时，插件必须复用外部 agent（handle:null），
// 且 agent/disposed 绝不能 dispose 借来的 agent 对象。
const sessionBusy = { mode: 'off', live: null }
function makeExternalAgent(id) {
  return {
    id,
    session: { id },
    messages: [],
    inbox: { nextTurn: fakeInboxOf(id), nextStep: [] },
    disposals: 0,
    followup(message) { this.messages.push(message); this.inbox.nextTurn.push(message); projectionSplice(this.session.id, message) },
    dispose() { this.disposals += 1 },
  }
}

// ── P1：真实 lark-admission 投影定义的最小宿主 runtime（fake-ctx 版）──────
// register/stateOf 语义与宿主一致；followup 入队即派发真实
// 'agent/inbox/spliced' 事件（与真实 inbox.splice 同步语义），验证的是
// 真实定义/判据/settle 门，而非伪造 verdict。
const projectionDefs = new Map()
const projectionStates = new Map() // sessionId -> { key: state }
// C-4：每会话持久 inbox（宿主真实语义：resume 后 pending 保留、idle 等新输入）。
const fakeInboxes = new Map()
function fakeInboxOf(id) {
  let arr = fakeInboxes.get(id)
  if (!arr) { arr = []; fakeInboxes.set(id, arr) }
  return arr
}
// E：视觉能力开关（非视觉固定告知测试用）。
const llmModalities = ['text', 'image']
// followup 先入队后 throw（真宿主异常形态）与告知网络 unknown 的测试开关。
let followupThrowOnce = false
let noticeFailMode = false
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
// E：真实附件服务面（validateImage + admitPromptContent typed blocks；与
// dsh-attachment 接口同形：image→同序 refs，blocks 保留原顺序）。
const fakeAttachments = {
  imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 },
  async validateImage() {},
  async admitPromptContent(parts) {
    let n = 0
    return parts.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text }
      if (part.type === 'image') return { type: 'image', attachment: { id: 'sha256:fake' + (n++) } }
      return part
    })
  },
}
//（默认下载实现内置于 fakeLarkSdk.__downloadImpl，见下；测试可切换/破坏。）
function projectionSplice(sessionId, message) {
  const store = projectionStates.get(sessionId) || {}
  projectionStates.set(sessionId, store)
  const event = { type: 'agent/inbox/spliced', data: { inserted: [message] } }
  for (const def of projectionDefs.values()) {
    const prev = Object.prototype.hasOwnProperty.call(store, def.key) ? store[def.key] : def.init()
    store[def.key] = def.apply(prev, event) // 引用相等短路与宿主一致
  }
}

function parseCurlConfig(stdin) {
  const out = { url: '', method: 'GET', headers: {}, body: null }
  for (const line of String(stdin || '').split('\n')) {
    const idx = line.indexOf(' = ')
    if (idx < 0) continue
    const key = line.slice(0, idx)
    let value = line.slice(idx + 3)
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\])/g, '$1')
    if (key === 'url') out.url = value
    else if (key === 'request') out.method = value
    else if (key === 'header') {
      const colon = value.indexOf(': ')
      out.headers[colon >= 0 ? value.slice(0, colon) : value] = colon >= 0 ? value.slice(colon + 2) : ''
    } else if (key === 'data-binary') out.body = value
  }
  return out
}

function routeResponseBody(parsed) {
  const url = parsed.url
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    // token 按 app_id 派生：区分 OLD/NEW 应用身份，供 token 按 runtime 隔离回归。
    let appId = 'unknown'
    try {
      appId = (JSON.parse(parsed.body || '{}').app_id) || 'unknown'
    } catch {
      appId = 'unknown'
    }
    return JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 'tk_' + appId, expire: 7200 })
  }
  if (parsed.method === 'POST' && url.includes('/cardkit/v1/cards')) {
    return JSON.stringify({ code: 0, msg: 'ok', data: { card_id: 'ck_' + (++wireIdSeq) } })
  }
  if (process.env.DSH_AUDIT_REGRESSION_ONLY === '1' && parsed.method === 'GET' && /\/im\/v1\/messages\/om_(bind_fault|bind_webhook|generation_resume|r1_)/.test(url)) {
    return JSON.stringify({ code: 0, data: { items: [{ msg_type: 'text', body: { content: JSON.stringify({ text: 'synthetic recovered body' }) } }] } })
  }
  if (parsed.method === 'GET' && url.includes('/im/v1/messages/om_rec_b')) {
    // C：恢复取正文（message GET 只读）——恢复调度用真实 wire 路径验证。
    return JSON.stringify({ code: 0, msg: 'ok', data: { items: [{ message_id: 'om_rec_b', msg_type: 'text', body: { content: JSON.stringify({ text: '恢复正文' }) } }] } })
  }
  if (parsed.method === 'GET' && url.includes('/im/v1/messages/om_rec_g')) {
    // E：恢复 image（GET 重建 parts → 统一内容管线）。
    return JSON.stringify({ code: 0, msg: 'ok', data: { items: [{ message_id: 'om_rec_g', msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_v3_k9' }) } }] } })
  }
  if (parsed.method === 'POST' && url.includes('/im/v1/messages')) {
    return JSON.stringify({ code: 0, msg: 'ok', data: { message_id: 'om_' + (++wireIdSeq) } })
  }
  // PUT elements content / PATCH settings
  return JSON.stringify({ code: 0, msg: 'ok', data: {} })
}

const fakeShell = {
  resolve(request) { return request },
  async run(request) {
    shellCalls.push(request)
    const parsed = parseCurlConfig(request.stdin)
    const entry = { method: parsed.method, url: parsed.url, headers: parsed.headers, body: parsed.body, held: false }
    wire.push(entry)
    if (holdNext && holdNext.match(entry)) {
      const deferred = holdNext.deferred
      holdNext = null
      entry.held = true
      await deferred.promise
    }
    if (throwNext && throwNext(entry)) {
      // 网络层拒绝：wire 上只留请求、没有响应（模拟连接中断/超时）。
      throwNext = null
      const error = new Error('simulated socket reset')
      error.code = 'ECONNRESET'
      throw error
    }
    if (noticeFailMode && String(entry.url).includes('receive_id_type=chat_id')) {
      // 告知网络 unknown（无响应）：unknown 通知零重派断言用。
      const err = new Error('simulated notice reset')
      err.code = 'ECONNRESET'
      throw err
    }
    let responseBody = routeResponseBody(parsed)
    if (failNext && failNext(entry)) {
      failNext = null
      responseBody = JSON.stringify({ code: 999, msg: 'segment boom' })
    }
    if (timeoutNext && timeoutNext(entry)) {
      // 返回式超时（真实 shell 常见形态：结构化结果而非 throw）：无 HTTP 状态、无 JSON。
      timeoutNext = null
      return {
        exitCode: 28,
        signal: null,
        timedOut: true,
        aborted: false,
        timeoutMs: request.timeoutMs || 60000,
        stdout: { text: '\n__DSH_STATUS__:0', truncated: false },
        stderr: { text: 'curl: (28) operation timed out', truncated: false },
      }
    }
    entry.response = JSON.parse(responseBody) // 记录响应：create 的 card_id 只在响应里
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: request.timeoutMs || 60000,
      stdout: { text: responseBody + '\n__DSH_STATUS__:200', truncated: false },
      stderr: { text: '', truncated: false },
    }
  },
  start() {
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

// 注入的飞书 SDK 替身：WSClient + EventDispatcher（长连接模式入口）。
const larkHandlers = {}
let larkMessageHandler = null
const fakeLarkSdk = {
  LoggerLevel: { info: 'info', debug: 'debug' },
  // E：入站图片下载的真实调用面（im.v1.messageResource.get + 可读流；getter
  // 每次读取当前 __downloadImpl，避免客户端缓存吃掉测试切换）。
  Client: class FakeLarkClient {
    constructor(params) {
      this.httpInstance = params && params.httpInstance
    }
    get im() {
      const impl = fakeLarkSdk.__downloadImpl || (() => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
      const api = { get: async (args) => impl(args) }
      return { v1: { message: api, messageResource: api } }
    }
  },
  __downloadImpl: () => ({ headers: {}, getReadableStream: () => Readable.from([PNG_1x1]) }),
  EventDispatcher: class {
    register(handlers) {
      Object.assign(larkHandlers, handlers)
      larkMessageHandler = handlers['im.message.receive_v1']
      return this
    }
  },
  WSClient: class {
    constructor(params) { this.params = params; this.started = false; this.closed = false }
    async start({ eventDispatcher }) {
      this.started = true
      this.eventDispatcher = eventDispatcher
      if (typeof this.params.onReady === 'function') this.params.onReady()
    }
    close() { this.closed = true }
  },
}

const ctx = {
  get(name) {
    if (name === 'dshMessaging.root') return '/mock/workspace'
    if (name === 'sandboxPolicy') return { workspaceRoot: '/mock/workspace' }
    if (name === 'dshMessaging.larkSdk') return fakeLarkSdk
    if (name === 'dshMessaging.larkClock') return fakeClock
    if (name === 'dsh.home') return fixtureDshHome
    if (name === 'attachments') return fakeAttachments // E：真实附件服务面
    return undefined
  },
  on(name, fn, options) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push({ fn, options })
    return () => {}
  },
  effect(fn) { const dispose = fn(); effectDisposers.push(dispose); return dispose },
  interval() { return () => {} },
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error('webserver: duplicate exact route "' + route.path + '"')
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  sessions: { async flush(session) { assert.ok(session && session.id, 'flush receives actual agent session'); return true } },
  shell: fakeShell,
  fs: fsService,
  agentDefaultModel: { currentSelection() { return { provider: 'test-provider', model: 'test-model' } } },
  sessionProjections: {
    register(definition) { projectionDefs.set(definition.key, definition) },
    stateOf(session, key) {
      // 对齐真实宿主（dsh-session-projection.stateOf → cell.state）：已注册定义
      // 无值时返回 init() 默认态（fresh session=空投影=可证缺席→not_admitted）；
      // 未注册才 undefined（服务缺失→uncertain，绝不当准入）。
      const def = projectionDefs.get(key)
      if (!def) return undefined
      const store = projectionStates.get(session && session.id)
      return store && Object.prototype.hasOwnProperty.call(store, key) ? store[key] : def.init()
    },
    onChanged() { return () => {} },
  },
  // E：视觉能力路由（read_image 同源：selection→resolveModelInfo.inputModalities）。
  llm: { resolveModelInfo: async () => ({ inputModalities: [...llmModalities] }) },
  agents: {
    async create(options) {
      const id = options.sessionId
      if (persistedSessions.has(id)) {
        const error = new Error('session "' + id + '" already exists')
        error.name = 'SessionAlreadyExistsError'
        throw error
      }
      persistedSessions.add(id)
      const agent = { id, session: { id }, messages: [], inbox: { nextTurn: fakeInboxOf(id), nextStep: [] }, followup(message) { agent.messages.push(message); agent.inbox.nextTurn.push(message); projectionSplice(id, message); if (followupThrowOnce) { followupThrowOnce = false; throw new Error('followup boom') } } }
      const handle = { agent, async dispose() {} }
      createdAgents.push({ options, agent, handle })
      return handle
    },
    async resume(options) {
      const id = options.resumeSessionId
      if (sessionBusy.mode !== 'off') {
        // busy：宿主里已有活 agent 持有写句柄（真实 SessionAlreadyOwnedError 形态）。
        const error = new Error('session "' + id + '" is already owned by an active write handle')
        error.name = 'SessionAlreadyOwnedError'
        throw error
      }
      if (!persistedSessions.has(id)) {
        const error = new Error('session "' + id + '" not found')
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      }
      const agent = { id, session: { id }, messages: [], inbox: { nextTurn: fakeInboxOf(id), nextStep: [] }, followup(message) { agent.messages.push(message); agent.inbox.nextTurn.push(message); projectionSplice(id, message) } }
      return { agent, async dispose() {} }
    },
    // 宿主的 agents.get(id)：busy 时返回真实的外部活 agent（借用源）。
    get(id) {
      if (sessionBusy.mode !== 'reuse') return undefined
      if (!sessionBusy.live || sessionBusy.live.id !== id) sessionBusy.live = makeExternalAgent(id)
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
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function fakeResponse() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {} }
  res.end = (body) => { res.body = body; res.finished = true }
  return res
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => wait(0)
const THROTTLE_WAIT = 320 // 引擎节流 200ms，留足余量

function loopbackHeaders(extra) {
  return Object.assign({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, extra || {})
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
  if (res.body) { try { json = JSON.parse(res.body) } catch { json = res.body } }
  return { status: res.statusCode, json }
}

function emit(name, ...args) {
  for (const entry of listeners.get(name) || []) entry.fn(...args)
}

const configFileKey = () => [...writtenFiles.keys()].filter((key) => key.includes('.dsh-messaging/config.json'))[0]
function readConfig() { return JSON.parse(writtenFiles.get(configFileKey())) }
async function saveConfig(config) {
  writtenFiles.set(configFileKey(), JSON.stringify(config))
  const reload = await invoke('POST', '/__dsh-messaging/reload')
  assert.equal(reload.status, 200, 'reload must succeed: ' + JSON.stringify(reload.json))
  return reload
}

// ── wire 查询助手 ──────────────────────────────────────────────────────────────
const bodyOf = (entry) => JSON.parse(entry.body)
const msgs = (list = wire) => list.filter((w) => w.method === 'POST' && w.url.includes('/im/v1/messages'))
const creates = (list = wire) => list.filter((w) => w.method === 'POST' && w.url.includes('/cardkit/v1/cards'))
const puts = (list = wire) => list.filter((w) => w.method === 'PUT' && w.url.includes('/elements/'))
const settingsPatches = (list = wire) => list.filter((w) => w.method === 'PATCH' && w.url.includes('/settings'))
const textMsgs = (list) => msgs(list).filter((m) => bodyOf(m).msg_type === 'text')
const interactiveMsgs = (list) => msgs(list).filter((m) => bodyOf(m).msg_type === 'interactive')

// ── 入站 / 帧 / session 事件发射 ───────────────────────────────────────────────
let inboundSeq = 0
async function larkInbound(chatId, text) {
  assert.equal(typeof larkMessageHandler, 'function', 'im.message.receive_v1 must be registered')
  const before = createdAgents.length
  larkMessageHandler({
    type: 'im.message.receive_v1',
    message: {
      message_id: 'om_in_' + (++inboundSeq),
      message_type: 'text',
      chat_type: 'p2p',
      chat_id: chatId,
      content: JSON.stringify({ text }),
    },
  })
  await wait(30) // ensureAgent（resume/create）是异步链
  if (createdAgents.length > before) return createdAgents[createdAgents.length - 1].agent
  // 未新建 → busy 借用路径：返回宿主侧外部 agent（同样必须已绑定到会话）
  assert.ok(sessionBusy.mode === 'reuse' && sessionBusy.live, 'inbound must bind an agent for ' + chatId)
  return sessionBusy.live
}

// E：image 入站（真实事件形状；下载经 fakeLarkSdk.Client 返回真 PNG 流）。
async function larkInboundImage(chatId, imageKey, messageId) {
  assert.equal(typeof larkMessageHandler, 'function', 'im.message.receive_v1 must be registered')
  larkMessageHandler({
    type: 'im.message.receive_v1',
    message: {
      message_id: messageId || ('om_img_' + (++inboundSeq)),
      message_type: 'image',
      chat_type: 'p2p',
      chat_id: chatId,
      content: JSON.stringify({ image_key: imageKey }),
    },
  })
  await wait(40)
  return createdAgents.length ? createdAgents[createdAgents.length - 1] && createdAgents[createdAgents.length - 1].agent : null
}

function frameStart(agent, { attemptId, revision, turn, step }) {
  emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId, revision, turn, step } })
}
function frameChunk(agent, { attemptId, revision, index, text }) {
  emit('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', attemptId, revision, index, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } },
  })
}
function frameEnd(agent, { attemptId, revision, index, committed = true }) {
  emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'end',
      attemptId,
      revision,
      index,
      outcome: committed
        ? { kind: 'committed', eventType: 'assistant/message', seq: 1 }
        : { kind: 'abandoned' },
    },
  })
}
function finalMessage(agent, turn, step, text) {
  emit('session/event', { id: agent.session.id }, {
    type: 'assistant/message',
    data: { turn, step, message: { content: [{ type: 'text', text }] } },
  })
}
function turnEnd(agent, turn, kind) {
  emit('session/event', { id: agent.session.id }, { type: 'turn/end', data: { turn, reason: { kind } } })
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  const { sessionIdForKey } = await import(pathToFileURL(path.join(root, 'lib', 'session-id-migration.js')).href)
  // live 卡体预算/收尾终态重建 helper（与 index larkCardWireMeasure / larkSummary 同口径）
  const { createStreamingCard } = await import(pathToFileURL(path.join(root, 'lib', 'lark-card-layout.js')).href)
  const { splitText } = await import(pathToFileURL(path.join(root, 'lib', 'lark-text-splitter.js')).href)
  const WORST_SUMMARY_SAMPLE = String.fromCharCode(1).repeat(50) // 与 index 一致：JSON 2+50×6=302B 上界
  // 与 index larkSummary 同口径：单行 ≤50 UTF16 码元，截断点避代理对
  const larkSummaryLike = (text) => {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
    if (!cleaned) return undefined
    if (cleaned.length <= 50) return cleaned
    let cut = cleaned.slice(0, 49)
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    return cut + '…'
  }
  // close settings 合并原 config 后的**完整终态卡**：summary 被替换、
  // streaming_mode:false，其余 config（streaming_config/update_multi 等）原样保留。
  const terminalCard = (content, summaryContent) => {
    const card = createStreamingCard(content)
    const config = { ...card.config, streaming_mode: false }
    if (summaryContent !== undefined) config.summary = { content: summaryContent }
    return { ...card, config }
  }
  const terminalWireBytes = (content, summaryContent) => Buffer.byteLength(
    JSON.stringify({ type: 'card_json', data: JSON.stringify(terminalCard(content, summaryContent)) }),
    'utf8',
  )
  const assertTerminalBudget = (content, summaryContent, label) => {
    const schema = Buffer.byteLength(JSON.stringify(terminalCard(content, summaryContent)), 'utf8')
    const wrapper = terminalWireBytes(content, summaryContent)
    assert.ok(schema <= 30 * 1024, label + ': terminal schema must fit 30KB, got ' + schema)
    assert.ok(wrapper <= 30 * 1024, label + ': terminal create-wrapper must fit 30KB, got ' + wrapper)
  }
  await plugin.apply(ctx)
  await tick()

  // 启动：lark 长连接 + interactiveCard 开（卡片模式），全部使用假凭据（无真实网络）。
  const config = readConfig()
  config.adapters.lark = Object.assign({}, config.adapters.lark, {
    enabled: true,
    mode: 'long-connection',
    appId: 'cli_int_test',
    appSecret: 'int-secret',
    interactiveCard: true,
  })
  await saveConfig(config)
  await wait(30) // 长连接异步启动
  {
    const status = await invoke('GET', '/__dsh-messaging/status')
    const lark = status.json.channels.find((c) => c.key === 'lark')
    assert.equal(lark.state, 'running', 'lark channel must run: ' + JSON.stringify(lark))
  }

  if (process.env.DSH_AUDIT_REGRESSION_ONLY === '1') {
    const dd = await import(pathToFileURL(path.join(root, 'lib/lark-dedup.js')).href)
    const storeRoot = path.join(fixtureDshHome, 'lark-dedup')
    let lease = await dd.openLarkDedupStore(storeRoot)
    const keyOf = (id) => dd.larkDedupKey('cli_int_test', id)
    const event = (id) => ({ type: 'im.message.receive_v1', message: { message_id: id, message_type: 'text', chat_type: 'p2p', chat_id: 'oc_' + id, content: JSON.stringify({ text: 'synthetic regression' }) } })
    const until = async (label, fn) => {
      for (let i = 0; i < 600; i++) { if (fn()) return; await wait(25) }
      throw new Error('timeout: ' + label)
    }
    const pending = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
    const originalFlush = ctx.sessions.flush
    const originalResume = ctx.agents.resume
    const runR1Cases = async () => {
      const originalGet = ctx.agents.get
      const unhandled = []
      const onUnhandled = error => unhandled.push(error)
      process.on('unhandledRejection', onUnhandled)
      const busy = () => Object.assign(new Error('synthetic busy'), { name: 'SessionAlreadyOwnedError' })
      const seed = async id => {
        const sid = sessionIdForKey('lark:oc_' + id)
        persistedSessions.add(sid)
        const claimed = await lease.claim({ appId: 'cli_int_test', messageId: id, chatId: 'oc_' + id, sessionId: sid, sessionExisted: true })
        lease.release(claimed.record.key)
        return sid
      }
      try {
        {
          const id = 'om_r1_attach'; const sid = await seed(id)
          const live = makeExternalAgent(sid)
          let resumes = 0; let faultAt = 0
          ctx.agents.get = key => key === sid && faultAt ? live : originalGet(key)
          ctx.agents.resume = async opts => {
            if (opts.resumeSessionId !== sid) return originalResume(opts)
            resumes++
            if (resumes === 2) { faultAt = Date.now(); throw new Error('synthetic private attach resume fault /fake/token') }
            throw busy()
          }
          await larkMessageHandler(event(id))
          await until('R1 attach retry resume throws', () => faultAt > 0)
          await wait(100)
          assert.equal(lease.get(keyOf(id)).state, 'claimed')
          if (process.env.DSH_R1_EXPECT_BROKEN === '1') {
            assert.equal(lease.isProcessing(keyOf(id)), true)
            const before = lease.stats().duplicateInflight
            await larkMessageHandler(event(id))
            assert.equal(lease.stats().duplicateInflight, before + 1)
            assert.equal(live.messages.length, 0)
            assert.equal(unhandled.length, 0, 'timer catch masks rejection without releasing owner')
            console.log('CONFIRMED R1 before fix: actual attachBusySession retry-resume throws; timer swallows rejection; claimed+processing remains; replay duplicate-inflight; zero admission')
            return
          }
          await until('R1 failed attachment releases processing', () => !lease.isProcessing(keyOf(id)))
          const before = lease.stats().recoverable
          await larkMessageHandler(event(id))
          assert.equal(lease.stats().recoverable, before + 1, 'retry reacquires recoverable ownership instead of duplicate-inflight')
          await wait(100)
          assert.equal(live.messages.length, 0, 'existing backoff respected')
          await until('R1 bounded timer retries via live busy reuse', () => lease.get(keyOf(id)).state === 'delivered')
          assert.ok(Date.now() - faultAt >= 4000, 'timer observes retry backoff')
          assert.equal(live.messages.length, 1)
          assert.equal(fakeInboxOf(sid).length, 1)
          const status = await invoke('GET', '/__dsh-messaging/status')
          assert.equal(JSON.stringify(status.json.errors).includes('/fake/token'), false, 'fixed attachment error does not expose raw injected error')
          console.log('PASS R1 recovery: attach retry-resume fault releases; claimed+backoff; replay recoverable; busy reuse admits exactly once')
        }
        ctx.agents.get = originalGet; ctx.agents.resume = originalResume
        {
          const id = 'om_r1_generation'; const sid = await seed(id)
          const gate = pending(); let resumes = 0; let held = false
          ctx.agents.resume = async opts => {
            if (opts.resumeSessionId !== sid) return originalResume(opts)
            resumes++
            if (resumes === 1) throw busy()
            held = true; await gate.promise
            throw new Error('synthetic stale attach fault')
          }
          await larkMessageHandler(event(id))
          await until('R1 attach retry held', () => held)
          await lease.close(); await invoke('POST', '/__dsh-messaging/reload')
          lease = await dd.openLarkDedupStore(storeRoot)
          const freshOwner = await lease.claim({ appId: 'cli_int_test', messageId: id, chatId: 'oc_' + id, sessionId: sid, sessionExisted: true })
          assert.equal(freshOwner.outcome, 'recoverable')
          ctx.agents.resume = originalResume
          gate.resolve(); await wait(150)
          assert.equal(lease.isProcessing(keyOf(id)), true, 'stale catch cannot release the explicitly acquired new lease owner')
          assert.equal(lease.get(keyOf(id)).state, 'claimed')
          lease.release(keyOf(id)) // release only the test's explicitly acquired new owner
          await larkMessageHandler(event(id))
          await until('R1 new lease recovers after stale catch', () => lease.get(keyOf(id)).state === 'delivered')
          assert.equal(fakeInboxOf(sid).length, 1)
          console.log('PASS R1 generation: attach throws after reload; new owner retained; new lease subsequently admits once')
        }
        {
          const id = 'om_r1_fresh'; const sid = sessionIdForKey('lark:oc_' + id)
          persistedSessions.add(sid)
          let thrown = false
          ctx.agents.resume = async opts => { if (opts.resumeSessionId === sid && !thrown) throw busy(); return originalResume(opts) }
          ctx.agents.get = key => { if (key === sid && !thrown) { thrown = true; throw new Error('synthetic fresh attach get fault') } return originalGet(key) }
          const input = event(id); input.message.message_type = 'image'; input.message.content = JSON.stringify({ image_key: 'img_v3_r1' })
          await larkMessageHandler(input)
          await until('R1 fresh ensureAgent catches attachment fault', () => thrown && !lease.isProcessing(keyOf(id)))
          assert.equal(lease.get(keyOf(id)).state, 'claimed')
          ctx.agents.get = originalGet; ctx.agents.resume = originalResume
          const before = lease.stats().recoverable
          await larkMessageHandler(input)
          assert.equal(lease.stats().recoverable, before + 1)
          await until('R1 fresh content recovers', () => lease.get(keyOf(id)).state === 'delivered')
          assert.equal(fakeInboxOf(sid).length, 1)
          console.log('PASS R1 neighboring fresh content: existing ensureAgent catch already releases and retries; no extra product catch needed')
        }
        await wait(50)
        assert.deepEqual(unhandled, [], 'no unhandled promise rejection across timer/catch/reload')
      } finally {
        ctx.agents.get = originalGet; ctx.agents.resume = originalResume
        process.off('unhandledRejection', onUnhandled)
      }
    }
    await runR1Cases()
    if (process.env.DSH_R1_REGRESSION_ONLY === '1') {
      await lease.close()
      for (const dispose of effectDisposers.slice().reverse()) if (typeof dispose === 'function') await dispose()
      console.log('lark-r1-regressions complete')
      return
    }
    // Interface spy: plugin must await pending flush; false/throw/non-boolean/missing
    // keep the real ledger claimed and release processing. Retried admission never followups again.
    for (const mode of ['false', 'throw', 'undefined', 'missing', 'true', 'image']) {
      const id = 'om_flush_' + mode
      const input = event(id)
      if (mode === 'image') { input.message.message_type = 'image'; input.message.content = JSON.stringify({ image_key: 'img_v3_flush' }) }
      const gate = pending()
      let calls = 0
      ctx.sessions.flush = async (session) => { assert.equal(session.id, sessionIdForKey('lark:oc_' + id)); calls++; return gate.promise }
      await larkMessageHandler(input)
      await until('flush entered', () => calls === 1)
      assert.equal(lease.get(keyOf(id)).state, 'claimed', 'pending flush is not delivered')
      assert.equal(lease.isProcessing(keyOf(id)), true)
      if (mode === 'throw') gate.resolve(Promise.reject(new Error('synthetic flush fault')))
      else gate.resolve(mode === 'true' ? true : mode === 'false' ? false : undefined)
      if (mode === 'true') await until('true settles', () => lease.get(keyOf(id)).state === 'delivered')
      else {
        await until('failed flush releases', () => !lease.isProcessing(keyOf(id)))
        assert.equal(lease.get(keyOf(id)).state, 'claimed')
        const inbox = fakeInboxOf(sessionIdForKey('lark:oc_' + id))
        assert.equal(inbox.length, 1)
        if (mode === 'missing') {
          const saved = ctx.sessions; delete ctx.sessions
          await larkMessageHandler(input)
          await wait(100)
          assert.equal(lease.get(keyOf(id)).state, 'claimed', 'missing service is fail closed')
          ctx.sessions = saved
        }
        ctx.sessions.flush = async (session) => { calls++; return originalFlush(session) }
        await larkMessageHandler(input)
        await until('retry flush settles', () => lease.get(keyOf(id)).state === 'delivered')
        assert.equal(inbox.length, 1, 'admitted retry has zero duplicate followup')
        assert.ok(calls >= 2, 'retry really flushes admission')
      }
    }
    ctx.sessions.flush = originalFlush
    console.log('A2 flush: pending/false/throw/undefined/missing/true and admitted retry PASS (real ledger, fake sessions interface)')
    // Real successful durable claim followed by injected bind failure must throw and release.
    const proto = Object.getPrototypeOf(lease)
    const originalBind = proto.bindRoute
    const id = 'om_bind_fault'
    persistedSessions.add(sessionIdForKey('lark:oc_' + id))
    proto.bindRoute = async function(key, route) { if (key === keyOf(id)) throw new Error('synthetic bind write failure'); return originalBind.call(this, key, route) }
    try { await assert.rejects(() => larkMessageHandler(event(id)), /synthetic bind/) }
    finally { proto.bindRoute = originalBind }
    assert.equal(lease.get(keyOf(id)).state, 'claimed')
    assert.equal(lease.isProcessing(keyOf(id)), false, 'failed bind relinquishes only acquired ownership')
    await larkMessageHandler(event(id))
    await until('bind retry admitted', () => lease.get(keyOf(id)).state === 'delivered')
    assert.equal(fakeInboxOf(sessionIdForKey('lark:oc_' + id)).length, 1)
    console.log('A1: claim succeeds -> bind throws -> WS rejects -> releases -> same event exactly once PASS')
    // Hold recovery resume across reload. The old handle must never followup, flush or notify.
    {
      const id = 'om_generation_resume'; const sid = sessionIdForKey('lark:oc_' + id)
      persistedSessions.add(sid)
      const claimed = await lease.claim({ appId: 'cli_int_test', messageId: id, chatId: 'oc_' + id, sessionId: sid, sessionExisted: true })
      lease.release(claimed.record.key)
      const gate = pending(); let entered = false; let oldFollowups = 0
      ctx.agents.resume = async function(opts) {
        if (opts.resumeSessionId === sid && !entered) {
          entered = true; await gate.promise
          return { agent: { session: { id: sid }, followup() { oldFollowups++ } } }
        }
        return originalResume(opts)
      }
      await larkMessageHandler(event(id)); await until('recovery resume held', () => entered)
      await lease.close(); await invoke('POST', '/__dsh-messaging/reload')
      lease = await dd.openLarkDedupStore(storeRoot)
      const before = msgs().filter(w => bodyOf(w).receive_id === 'oc_' + id).length
      gate.resolve(); await wait(150)
      assert.equal(oldFollowups, 0)
      assert.equal(msgs().filter(w => bodyOf(w).receive_id === 'oc_' + id).length, before, 'stale resume sends no notice to this chat')
      ctx.agents.resume = originalResume
      await larkMessageHandler(event(id))
      await until('new generation recovers', () => lease.get(keyOf(id)).state === 'delivered')
      assert.equal(oldFollowups, 0)
    }
    // Hold actual plugin flush across reload; new generation can settle, old completion cannot.
    {
      const id = 'om_generation_flush'; const gate = pending(); let entered = false
      ctx.sessions.flush = async () => { entered = true; return gate.promise }
      await larkMessageHandler(event(id)); await until('flush held', () => entered)
      assert.equal(lease.get(keyOf(id)).state, 'claimed')
      const nextGate = pending()
      ctx.sessions.flush = async () => nextGate.promise
      await lease.close(); await invoke('POST', '/__dsh-messaging/reload')
      lease = await dd.openLarkDedupStore(storeRoot)
      gate.resolve(true); await wait(100)
      assert.equal(lease.get(keyOf(id)).state, 'claimed', 'stale flush cannot settle new lease')
      nextGate.resolve(true)
      ctx.sessions.flush = originalFlush
      await larkMessageHandler(event(id))
      await until('new generation flushes', () => lease.get(keyOf(id)).state === 'delivered')
      assert.equal(fakeInboxOf(sessionIdForKey('lark:oc_' + id)).length, 1)
    }
    // Actual recovery notice: suspend before wire (receipt begin) and after wire,
    // reload, then resume the old callback. It cannot reject the inbound or send again.
    for (const stage of ['before', 'after']) {
      const id = 'om_generation_notice_' + stage
      const chat = 'oc_' + id
      const claimed = await lease.claim({ appId: 'cli_int_test', messageId: id, chatId: chat, sessionId: 'missing-' + stage })
      lease.release(claimed.record.key)
      const gate = pending(); let entered = false
      const receipts = lease.sendReceipts
      const begin = receipts.begin
      const { larkNoticeUuid } = await import(pathToFileURL(path.join(root, 'lib/lark-notice.js')).href)
      if (stage === 'before') receipts.begin = async function(args) { const r = await begin.call(this, args); if (args.uuid === larkNoticeUuid(keyOf(id), 'session_missing')) { entered = true; await gate.promise } return r }
      else holdNext = { match: entry => entry.url.includes('/im/v1/messages?') && bodyOf(entry).receive_id === chat, deferred: gate }
      await larkMessageHandler(event(id))
      await until('notice held ' + stage, () => stage === 'before' ? entered : wire.some(w => w.held && w.url.includes('/im/v1/messages?') && bodyOf(w).receive_id === chat))
      const beforeSends = msgs().filter(w => bodyOf(w).receive_id === chat).length
      receipts.begin = begin
      await lease.close(); await invoke('POST', '/__dsh-messaging/reload')
      lease = await dd.openLarkDedupStore(storeRoot)
      gate.resolve(); await wait(100)
      assert.equal(lease.get(keyOf(id)).state, 'claimed', 'old notice cannot reject in new generation')
      assert.equal(msgs().filter(w => bodyOf(w).receive_id === chat).length, beforeSends, 'no old/new blind redispatch')
      await larkMessageHandler(event(id)); await wait(150)
      assert.equal(lease.get(keyOf(id)).state, 'claimed', 'unknown receipt remains recoverable pending')
    }
    console.log('A2 notice: held before/after wire across reload; no stale reject or redispatch PASS')
    console.log('A2 generation: held resume and flush across actual reload, new lease recovers PASS')
    // Plain webhook confirms the same body is not cached as a success on bind failure.
    {
      const cfg = readConfig(); cfg.adapters.lark.mode = 'webhook'; cfg.adapters.lark.verificationToken = 'tok_regression'
      await saveConfig(cfg); await wait(50)
      const id = 'om_bind_webhook'; persistedSessions.add(sessionIdForKey('lark:oc_' + id))
      const body = JSON.stringify({ ...event(id), token: 'tok_regression' })
      proto.bindRoute = async function(key, route) { if (key === keyOf(id)) throw new Error('synthetic webhook bind failure'); return originalBind.call(this, key, route) }
      try {
        const first = await invoke('POST', '/messaging/lark/events', { body, headers: { 'content-type': 'application/json' } })
        assert.equal(first.status, 500, 'bind failure is webhook 500')
        assert.equal(lease.isProcessing(keyOf(id)), false)
      } finally { proto.bindRoute = originalBind }
      const retry = await invoke('POST', '/messaging/lark/events', { body, headers: { 'content-type': 'application/json' } })
      assert.equal(retry.status, 200)
      await until('same webhook body recovered', () => lease.get(keyOf(id)).state === 'delivered')
      const replay = await invoke('POST', '/messaging/lark/events', { body, headers: { 'content-type': 'application/json' } })
      assert.equal(replay.status, 200)
      assert.equal(fakeInboxOf(sessionIdForKey('lark:oc_' + id)).length, 1)
      console.log('A1 webhook: bind failure 500; same body retry/replay exactly one admission PASS')
    }
    await lease.close()
    for (const dispose of effectDisposers.slice().reverse()) if (typeof dispose === 'function') await dispose()
    console.log('lark-install-regressions ok | fake SDK/network/agents; real plugin, admission and durable ledger')
    return
  }

  // ══ 场景 1：卡片模式实时流（3 批 text-delta 早于任何 final/end）══════════════
  const agent1 = await larkInbound('oc_1', 'hi there')
  const sid1 = sessionIdForKey('lark:oc_1')
  assert.equal(agent1.session.id, sid1)
  const mark0 = wire.length

  frameStart(agent1, { attemptId: 'att1', revision: 1, turn: 1, step: 0 })
  frameChunk(agent1, { attemptId: 'att1', revision: 2, index: 0, text: 'Hello, ' })
  await wait(THROTTLE_WAIT)
  frameChunk(agent1, { attemptId: 'att1', revision: 3, index: 1, text: '世界 ' })
  await wait(THROTTLE_WAIT)
  frameChunk(agent1, { attemptId: 'att1', revision: 4, index: 2, text: 'emoji😀' })
  await wait(THROTTLE_WAIT)

  {
    const section = wire.slice(mark0)
    const c = creates(section)
    const p = puts(section)
    const s = settingsPatches(section)
    assert.equal(c.length, 1, 'live streaming must create exactly one CardKit entity before final/end')
    assert.equal(s.length, 0, 'no finish before any final/end frame')
    assert.ok(p.length >= 2, 'the three delta batches must produce multiple card updates before final/end, got ' + p.length)
    // create 即首个内容写入（spec 携带首段正文），随后 PUT 累计全文、sequence 严格递增
    const seed = bodyOf(c[0])
    assert.equal(seed.type, 'card_json')
    const seedCard = JSON.parse(seed.data)
    assert.equal(seedCard.schema, '2.0')
    assert.equal(seedCard.config.streaming_mode, true)
    assert.equal(seedCard.body.elements[0].element_id, 'dsh_streaming_text')
    assert.equal(seedCard.body.elements[0].content, 'Hello, ')
    const seqs = p.map((entry) => bodyOf(entry).sequence)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence must be increasing: ' + JSON.stringify(seqs))
    assert.equal(new Set(seqs).size, seqs.length, 'sequence must not repeat')
    assert.equal(bodyOf(p[0]).content, 'Hello, 世界 ', 'card content must be the accumulated snapshot')
    assert.equal(bodyOf(p[p.length - 1]).content, 'Hello, 世界 emoji😀')
    assert.ok(String(bodyOf(p[0]).uuid).startsWith('c_'), 'PUT uuid follows the c_<cardId>_<sequence> shape')
    // 引用消息：开卡的所有出站必须是 interactive
    const ref = interactiveMsgs(section)
    assert.equal(ref.length, 1, 'exactly one reference message for the created card')
    assert.equal(bodyOf(ref[0]).receive_id, 'oc_1')
    assert.equal(bodyOf(ref[0]).msg_type, 'interactive')
    const card1 = c[0].response.data.card_id
    assert.equal(typeof card1, 'string')
    assert.deepEqual(JSON.parse(bodyOf(ref[0]).content), { type: 'card', data: { card_id: card1 } })
    assert.ok(bodyOf(p[0]).uuid.startsWith('c_' + card1 + '_'), 'uuid derives from cardId + sequence')
  }

  // 重复帧（同 revision 同 index）与回退 revision 都必须被拒绝——真实递增 revision/index 生效
  const beforeDup = wire.length
  frameChunk(agent1, { attemptId: 'att1', revision: 4, index: 2, text: 'EVIL' })
  frameChunk(agent1, { attemptId: 'att1', revision: 2, index: 3, text: 'REGRESSION' })
  await wait(THROTTLE_WAIT)
  assert.equal(wire.length, beforeDup, 'duplicate index / regressed revision frames must not produce output')
  {
    // 引擎明确上报 revision 不前进（协议违约），而非静默接受
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(
      st.json.errors.some((e) => String(e.message).includes('revision not advancing')),
      'regressed revision must be reported by the stream engine'
    )
  }

  // 最终 message（先于 end）：与已发布快照一致 → 去重，不再发全文
  finalMessage(agent1, 1, 0, 'Hello, 世界 emoji😀')
  await wait(80)
  assert.equal(wire.length, beforeDup, 'final message equal to the published snapshot must be deduplicated')

  // live end：收卡一次，正文不再重复
  const putsBeforeEnd = puts(wire.slice(mark0)).length
  frameEnd(agent1, { attemptId: 'att1', revision: 5, index: 3 })
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark0)
    assert.equal(puts(section).length, putsBeforeEnd, 'live end must not push more content')
    const s = settingsPatches(section)
    assert.equal(s.length, 1, 'exactly one settings close for the live card')
    const settings = JSON.parse(bodyOf(s[0]).settings)
    assert.equal(settings.config.streaming_mode, false, 'close must disable streaming_mode')
    const cardId = creates(section)[0].response.data.card_id
    assert.equal(bodyOf(s[0]).sequence, 3, 'close continues the shared sequence (2 PUTs then close)')
    assert.ok(bodyOf(s[0]).uuid.startsWith('s_' + cardId + '_'), 'close uuid shares the card sequence')
    assert.equal(interactiveMsgs(section).length, 1, 'card mode: the only message is the card reference')
  }
  const afterEnd = wire.length

  // turn/end：幂等，不再产生任何出站
  turnEnd(agent1, 1, 'completed')
  await wait(THROTTLE_WAIT)
  assert.equal(wire.length, afterEnd, 'turn/end after the live end frame must not send anything again')

  // ══ 场景 2：第二 turn（独立卡 + 最终文本补尾，不重复第一 turn 正文）═══════
  const mark1 = wire.length
  // revision 是 Agent lifecycle 级单调：turn2 的帧必须大于 turn1 的 end（5）。
  frameStart(agent1, { attemptId: 'att2', revision: 6, turn: 2, step: 0 })
  frameChunk(agent1, { attemptId: 'att2', revision: 7, index: 0, text: 'Second ' })
  await wait(THROTTLE_WAIT) // 节流先发 'Second '，开卡
  finalMessage(agent1, 2, 0, 'Second answer') // 最终文本比已发布快照长 → 补尾而非重发
  await wait(80)
  frameEnd(agent1, { attemptId: 'att2', revision: 8, index: 1 })
  await wait(THROTTLE_WAIT)
  turnEnd(agent1, 2, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark1)
    const c = creates(section)
    assert.equal(c.length, 1, 'turn 2 opens its own card')
    const card1Id = creates(wire.slice(mark0))[0].response.data.card_id
    const card2Id = c[0].response.data.card_id
    assert.notEqual(card1Id, card2Id, 'turn 2 must use a fresh card entity')
    const seedCard = JSON.parse(bodyOf(c[0]).data)
    assert.equal(seedCard.body.elements[0].content, 'Second ', 'turn 2 card starts from its own live snapshot')
    const p = puts(section)
    assert.equal(p.length, 1, 'final message must append the missing tail exactly once')
    assert.equal(bodyOf(p[0]).content, 'Second answer', 'tail append delivers the full accumulated text')
    assert.ok(bodyOf(p[0]).uuid.startsWith('c_' + card2Id + '_'))
    assert.equal(settingsPatches(section).length, 1, 'turn 2 card is closed exactly once')
    assert.equal(bodyOf(settingsPatches(section)[0]).sequence, 2, 'close continues turn 2 shared sequence')
    assert.equal(interactiveMsgs(section).length, 1, 'card mode: one reference message per card')
    for (const entry of puts(section)) {
      assert.equal(bodyOf(entry).content.includes('Hello'), false, 'turn 2 never replays turn 1 text')
    }
  }

  // ══ 场景 2b：全文超双重预算（本地30000字符 / 终态wire30KB）→ 安全 rollover，不丢正文 ══
  const markR = wire.length
  frameStart(agent1, { attemptId: 'attR', revision: 9, turn: 3, step: 0 })
  frameChunk(agent1, { attemptId: 'attR', revision: 10, index: 0, text: 'H'.repeat(31000) })
  await wait(THROTTLE_WAIT)
  frameEnd(agent1, { attemptId: 'attR', revision: 11, index: 1 })
  await wait(THROTTLE_WAIT)
  turnEnd(agent1, 3, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markR)
    const c = creates(section)
    assert.equal(c.length, 2, 'over-budget content must roll over to a second card')
    const seed1 = JSON.parse(bodyOf(c[0]).data).body.elements[0].content
    const seed2 = JSON.parse(bodyOf(c[1]).data).body.elements[0].content
    // 最坏终态 measure 下 ASCII head 由 wire 预算先约束（≈29976），不再恰为 30000
    assert.ok(seed1.length < 31000 && seed1.length >= 29900, 'first card holds the budget-bound head, got ' + seed1.length)
    assert.equal(seed2.length, 31000 - seed1.length, 'second card continues with the remaining tail')
    const p = puts(section)
    assert.equal(p.length, 1, 'rollover pins the head exactly once on the old card')
    assert.equal(bodyOf(p[0]).content.length, seed1.length, 'pin content equals the head')
    const cl = settingsPatches(section)
    assert.equal(cl.length, 2, 'old card closed at rollover, new card closed at end')
    assert.equal(bodyOf(cl[0]).sequence, 2, 'old card: pin(seq 1) then close(seq 2) share the sequence')
    assert.equal(bodyOf(cl[1]).sequence, 1, 'fresh card restarts its own sequence')
    assert.equal(seed1.length + seed2.length, 31000, 'rollover must not lose or duplicate content')
    assert.equal(interactiveMsgs(section).length, 2, 'each rolled-over card gets its reference message')
  }

  // ══ 场景 3：非流式（无 live 帧）→ 静态 interactive 卡，一卡一发 ═════════════
  const mark2 = wire.length
  finalMessage(agent1, 4, 0, 'Static only reply')
  await wait(THROTTLE_WAIT)
  turnEnd(agent1, 4, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark2)
    assert.equal(creates(section).length, 0, 'non-stream turn must not create a CardKit entity')
    assert.equal(puts(section).length, 0, 'non-stream turn must not PUT element content')
    const m = interactiveMsgs(section)
    assert.equal(m.length, 1, 'non-stream final with interactiveCard on sends exactly one static card')
    const spec = JSON.parse(bodyOf(m[0]).content)
    assert.equal(spec.schema, '2.0', 'static card is full JSON 2.0')
    assert.equal(spec.body.elements[0].content, 'Static only reply')
    assert.equal(bodyOf(m[0]).receive_id, 'oc_1')
    assert.equal(settingsPatches(section).length, 0, 'nothing to close for a never-opened card')
  }

  // ══ 场景 4：abort → 收卡一次、不留尾巴，且不污染下一 turn ═══════════════════
  const mark3 = wire.length
  frameStart(agent1, { attemptId: 'att5', revision: 12, turn: 5, step: 0 })
  frameChunk(agent1, { attemptId: 'att5', revision: 13, index: 0, text: 'Partial output' })
  await wait(THROTTLE_WAIT)
  turnEnd(agent1, 5, 'aborted')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark3)
    assert.equal(settingsPatches(section).length, 1, 'abort must close the open card exactly once')
    assert.equal(JSON.parse(bodyOf(settingsPatches(section)[0]).settings).config.streaming_mode, false)
    const writesAfterAbort = puts(section).length
    assert.equal(interactiveMsgs(section).length, 1, 'abort sends only the reference message')
    // 下一 turn 独立工作（aborted 不污染）：两批正文 → 开卡 + 一次补写
    frameStart(agent1, { attemptId: 'att6', revision: 14, turn: 6, step: 0 })
    frameChunk(agent1, { attemptId: 'att6', revision: 15, index: 0, text: 'After ' })
    await wait(THROTTLE_WAIT)
    frameChunk(agent1, { attemptId: 'att6', revision: 16, index: 1, text: 'abort' })
    await wait(THROTTLE_WAIT)
    frameEnd(agent1, { attemptId: 'att6', revision: 17, index: 2 })
    await wait(THROTTLE_WAIT)
    turnEnd(agent1, 6, 'completed')
    await wait(THROTTLE_WAIT)
    const section2 = wire.slice(mark3)
    assert.equal(creates(section2).length, 2, 'abort then a fresh turn opens exactly one more card')
    assert.equal(settingsPatches(section2).length, 2, 'both cards closed exactly once')
    assert.ok(puts(section2).length > writesAfterAbort, 'the next turn still streams content')
    const lastCreate = creates(section2)[creates(section2).length - 1]
    assert.equal(JSON.parse(bodyOf(lastCreate).data).body.elements[0].content, 'After ')
    const lastPut = puts(section2)[puts(section2).length - 1]
    assert.equal(bodyOf(lastPut).content, 'After abort', 'post-abort turn streams its own full text')
    assert.equal(puts(section2).length - writesAfterAbort, 1, 'exactly one incremental PUT after abort')
  }

  // ══ 场景 5：并发两会话互不串扰 ═════════════════════════════════════════════
  const agent2 = await larkInbound('oc_2', 'second chat')
  const mark4 = wire.length
  frameStart(agent1, { attemptId: 'att7a', revision: 18, turn: 7, step: 0 })
  frameChunk(agent1, { attemptId: 'att7a', revision: 19, index: 0, text: 'AAA1' })
  frameStart(agent2, { attemptId: 'att7b', revision: 1, turn: 1, step: 0 }) // agent2 流独立计数
  frameChunk(agent2, { attemptId: 'att7b', revision: 2, index: 0, text: 'BBB1' })
  await wait(THROTTLE_WAIT)
  frameChunk(agent1, { attemptId: 'att7a', revision: 20, index: 1, text: 'AAA2' })
  frameChunk(agent2, { attemptId: 'att7b', revision: 3, index: 1, text: 'BBB2' })
  await wait(THROTTLE_WAIT)
  frameEnd(agent1, { attemptId: 'att7a', revision: 21, index: 2 })
  frameEnd(agent2, { attemptId: 'att7b', revision: 4, index: 2 })
  await wait(THROTTLE_WAIT)
  turnEnd(agent1, 7, 'completed')
  turnEnd(agent2, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark4)
    const c = creates(section)
    assert.equal(c.length, 2, 'each concurrent session opens its own card')
    const id1 = c[0].response.data.card_id
    const id2 = c[1].response.data.card_id
    assert.notEqual(id1, id2)
    // 引用消息把 cardId 落到正确的会话
    const refs = interactiveMsgs(section).filter((m) => JSON.parse(bodyOf(m).content).type === 'card')
    const ref1 = refs.find((m) => JSON.parse(bodyOf(m).content).data.card_id === id1)
    const ref2 = refs.find((m) => JSON.parse(bodyOf(m).content).data.card_id === id2)
    assert.equal(bodyOf(ref1).receive_id, 'oc_1', 'card 1 must reference conversation oc_1')
    assert.equal(bodyOf(ref2).receive_id, 'oc_2', 'card 2 must reference conversation oc_2')
    // 内容不串：每张卡的正文只含自己的批次
    for (const entry of puts(section)) {
      const uuid = bodyOf(entry).uuid
      const cardId = uuid.slice(2, uuid.lastIndexOf('_'))
      const text = bodyOf(entry).content
      if (cardId === id1) assert.match(text, /^AAA/, 'card on oc_1 must only carry AAA content: ' + text)
      if (cardId === id2) assert.match(text, /^BBB/, 'card on oc_2 must only carry BBB content: ' + text)
    }
    assert.equal(settingsPatches(section).length, 2, 'both concurrent cards closed')
  }

  // ══ 场景 6：agent/disposed → 只清自己的流并收卡，不 dispose 借用 agent ══════
  const mark5 = wire.length
  frameStart(agent2, { attemptId: 'att8', revision: 5, turn: 2, step: 0 })
  frameChunk(agent2, { attemptId: 'att8', revision: 6, index: 0, text: 'open then gone' })
  await wait(THROTTLE_WAIT)
  assert.equal(settingsPatches(wire.slice(mark5)).length, 0, 'card still open before dispose')
  emit('agent/disposed', { agent: agent2 })
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark5)
    assert.equal(settingsPatches(section).length, 1, 'agent disposal must close the open card exactly once')
    assert.equal(JSON.parse(bodyOf(settingsPatches(section)[0]).settings).config.streaming_mode, false)
    assert.equal(await ctx.agents.get(agent2.session.id), undefined, 'disposal must not touch external agent handles')
  }

  // ══ 场景 7：手动出站（错误提示/手动发送同路）也走 interactive 静态卡 ════════
  const mark6 = wire.length
  {
    const sent = await invoke('POST', '/__dsh-messaging/send', {
      body: JSON.stringify({ channel: 'lark', conversation: 'lark:oc_1', text: 'hint body' }),
    })
    assert.equal(sent.status, 200, JSON.stringify(sent.json))
    const section = wire.slice(mark6)
    const m = interactiveMsgs(section)
    assert.equal(m.length, 1, 'manual outbound with interactiveCard on must be an interactive card')
    assert.equal(JSON.parse(bodyOf(m[0]).content).body.elements[0].content, 'hint body')
    assert.equal(creates(section).length, 0, 'manual outbound does not open a CardKit entity')
  }

  // ══ 场景 7b：引用发送抛错（投递未知）→ 只关闭已知 cardId，绝不创建第二卡 ══
  const markU = wire.length
  throwNext = (entry) => entry.method === 'POST' && entry.url.includes('/im/v1/messages')
  frameStart(agent1, { attemptId: 'attU', revision: 22, turn: 8, step: 0 })
  frameChunk(agent1, { attemptId: 'attU', revision: 23, index: 0, text: 'unknown delivery' })
  await wait(THROTTLE_WAIT)
  turnEnd(agent1, 8, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markU)
    const c = creates(section)
    assert.equal(c.length, 1, 'exactly one card is created; unknown delivery must never open a second card')
    const cardId = c[0].response.data.card_id
    const refs = msgs(section)
    assert.equal(refs.length, 1, 'the reference send is attempted exactly once (thrown), never resent')
    assert.equal(refs[0].response, undefined, 'a thrown send has no response on the wire')
    const cl = settingsPatches(section)
    assert.equal(cl.length, 1, 'the known cardId is closed exactly once')
    assert.equal(bodyOf(cl[0]).sequence, 1)
    assert.ok(bodyOf(cl[0]).uuid.startsWith('s_' + cardId + '_'), 'close targets the known cardId')
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(
      st.json.errors.some((e) => String(e.message).includes('simulated socket reset')),
      'the thrown network error must surface through the engine error channel'
    )
  }

  // ══ 场景 7c：最终文本含孤立代理 → 只投最长合法前缀、明确报错、正常收尾 ═════
  const markF = wire.length
  finalMessage(agent1, 9, 0, 'Broken\ud800tail')
  await wait(THROTTLE_WAIT)
  turnEnd(agent1, 9, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markF)
    assert.equal(creates(section).length, 0, 'a malformed final must not open a CardKit entity')
    const m = interactiveMsgs(section)
    assert.equal(m.length, 1, 'the well-formed prefix is delivered as exactly one static card')
    assert.equal(JSON.parse(bodyOf(m[0]).content).body.elements[0].content, 'Broken', 'only the well-formed prefix is delivered')
    assert.equal(settingsPatches(section).length, 0, 'nothing to close: no card was opened')
    assert.ok(!section.some((w) => typeof w.body === 'string' && w.body.includes('tail')), 'the malformed remainder must never reach the wire')
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(
      st.json.errors.some((e) => String(e.message).includes('lone UTF-16 surrogate')),
      'the malformed final must be reported explicitly, not silently dropped'
    )
  }

  // ══ P2：手动/直接出站畸形文本明确失败，绝不 trim 后静默成功 ═══════════
  const markBad = wire.length
  {
    const bad = await invoke('POST', '/__dsh-messaging/send', {
      body: JSON.stringify({ channel: 'lark', conversation: 'lark:oc_1', text: 'bad\ud800tail' }),
    })
    assert.equal(bad.status, 200)
    assert.equal(bad.json.ok, false, 'malformed manual send must fail explicitly, not return ok')
    assert.ok(String(bad.json.error).includes('malformed'), 'the refusal must name the malformed text: ' + bad.json.error)
    assert.equal(wire.length, markBad, 'malformed text must never reach the wire')
  }

  // ══ 场景 7d：10 分钟官方窗口——9min timer 主动收尾 + 11min 到期先关旧再建新，绝不过期 PUT ══
  const agentW = await larkInbound('oc_8', 'window chat')
  const markW = wire.length
  assert.equal(fakeClock.timers.size, 0, 'no lingering card timers before the window test')
  frameStart(agentW, { attemptId: 'win1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentW, { attemptId: 'win1', revision: 2, index: 0, text: 'window history' })
  await wait(THROTTLE_WAIT) // 开卡（createdAt = fake now）
  assert.equal(fakeClock.timers.size, 1, 'an expiry timer is scheduled when the card opens')
  const firedTimers = fakeClock.advance(9 * 60 * 1000 + 1000) // 9min+1s：早于官方 10 分钟的主动收尾
  assert.equal(firedTimers, 1, 'the 9-minute proactive close timer must fire')
  await wait(80)
  frameChunk(agentW, { attemptId: 'win1', revision: 3, index: 1, text: ' after window' })
  await wait(THROTTLE_WAIT)
  frameEnd(agentW, { attemptId: 'win1', revision: 4, index: 2 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentW, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markW)
    const c = creates(section)
    assert.equal(c.length, 2, 'expiry closes the old card and a fresh card continues')
    assert.equal(puts(section).length, 0, 'expired card must never receive a PUT/pin (11min probe)')
    const cl = settingsPatches(section)
    assert.equal(cl.length, 2, 'both cards closed: old by timer, new by end')
    const card1 = c[0].response.data.card_id
    const card2 = c[1].response.data.card_id
    assert.ok(bodyOf(cl[0]).uuid.startsWith('s_' + card1 + '_'), 'the expired card is closed first (timer)')
    assert.ok(bodyOf(cl[1]).uuid.startsWith('s_' + card2 + '_'), 'the continuation card closes at end')
    const seed2 = JSON.parse(bodyOf(c[1]).data).body.elements[0].content
    assert.equal(seed2, ' after window', 'the new card continues from old lastText without replaying history')
    // timer 收尾与正常 finish 同受终态预算约束（真实 close.summary 重建完整卡体）
    assertTerminalBudget('window history', larkSummaryLike('window history'), 'scenario7d timer close terminal')
    assertTerminalBudget(' after window', larkSummaryLike(' after window'), 'scenario7d finish terminal')
    assert.equal(fakeClock.timers.size, 0, 'expiry/close must clear the card timers')
  }

  // 子情形：timer 错过（事件循环阻塞等）→ publish 内 10 分钟到期检查兑底，仍绝不 PUT 旧卡
  const markW2 = wire.length
  frameStart(agentW, { attemptId: 'win2', revision: 5, turn: 2, step: 0 })
  frameChunk(agentW, { attemptId: 'win2', revision: 6, index: 0, text: 'second window' })
  await wait(THROTTLE_WAIT)
  assert.equal(fakeClock.timers.size, 1, 'continuation card schedules its own timer')
  fakeClock.advance(11 * 60 * 1000, { fire: false }) // 直接跳过 10 分钟且不触发 timer
  frameChunk(agentW, { attemptId: 'win2', revision: 7, index: 1, text: ' tail' })
  await wait(THROTTLE_WAIT)
  frameEnd(agentW, { attemptId: 'win2', revision: 8, index: 2 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentW, 2, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markW2)
    const c = creates(section)
    assert.equal(c.length, 2, 'timer missed: publish expiry check closes old and opens continuation')
    assert.equal(puts(section).length, 0, 'a stale card must not receive the first PUT after 11 minutes')
    const card3 = c[0].response.data.card_id
    const cl = settingsPatches(section)
    assert.equal(cl.length, 2, 'stale card closed without PUT; continuation card closed at end')
    assert.ok(bodyOf(cl[0]).uuid.startsWith('s_' + card3 + '_'), 'the expired card closed without any PUT')
    assert.equal(fakeClock.timers.size, 0, 'all card timers cleaned after close')
  }

  // ══ 场景 7e：同 SID 换新 Agent（真实 busy 借用路径）→ 卡/进度按 Agent 对象+attempt 隔离；借用 agent 不可 dispose ══
  const createdBeforeIso = createdAgents.length
  sessionBusy.mode = 'reuse'
  const agentA = await larkInbound('oc_iso', 'iso first')
  assert.equal(createdAgents.length, createdBeforeIso, 'busy reuse must borrow the external agent instead of creating one')
  assert.equal(sessionBusy.live, agentA, 'the borrowed agent is the host-owned external object')
  const markIso = wire.length
  frameStart(agentA, { attemptId: 'iso1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentA, { attemptId: 'iso1', revision: 2, index: 0, text: 'AAA' })
  await wait(THROTTLE_WAIT)
  // 宿主换会话主人：busy 关闭后下一次入站解析出全新的 owned agent（同 SID）
  sessionBusy.mode = 'off'
  sessionBusy.live = null
  const agentB = await larkInbound('oc_iso', 'iso second')
  assert.notEqual(agentB, agentA, 'same sessionId must resolve to a different Agent object')
  frameStart(agentB, { attemptId: 'iso1', revision: 1, turn: 2, step: 0 }) // 同 attemptId 字符串、不同 Agent 对象
  frameChunk(agentB, { attemptId: 'iso1', revision: 2, index: 0, text: 'BBB1' })
  await wait(THROTTLE_WAIT)
  frameChunk(agentB, { attemptId: 'iso1', revision: 3, index: 1, text: 'BBB2' })
  await wait(THROTTLE_WAIT)
  // 旧 A 的 end 只能收 A 自己的卡
  frameEnd(agentA, { attemptId: 'iso1', revision: 3, index: 1 })
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markIso)
    const c = creates(section)
    assert.equal(c.length, 2, 'each Agent object opens its own card despite the shared sessionId')
    const cardAId = c[0].response.data.card_id
    const cardBId = c[1].response.data.card_id
    assert.notEqual(cardAId, cardBId)
    const p = puts(section)
    assert.equal(p.length, 1, 'only Agent B produced an incremental PUT')
    assert.ok(bodyOf(p[0]).uuid.startsWith('c_' + cardBId + '_'), 'B 的 PUT 只落在 B 的卡上（Agent+attempt 隔离，不共用 SID 槽）')
    assert.equal(bodyOf(p[0]).content, 'BBB1BBB2')
    const cl = settingsPatches(section)
    assert.equal(cl.length, 1, "old A's end closes exactly A's card")
    assert.ok(bodyOf(cl[0]).uuid.startsWith('s_' + cardAId + '_'), "old A's end must close A's card, not B's")
    // 借用（外部）agent：agent/disposed 绝不 dispose
    emit('agent/disposed', { agent: agentA })
    await wait(THROTTLE_WAIT)
    assert.equal(agentA.disposals, 0, 'a borrowed external agent must never be disposed by the plugin')
    assert.equal(settingsPatches(wire.slice(markIso)).length, 1, 'disposal must not close any other card')
  }
  // B 正常收尾
  frameEnd(agentB, { attemptId: 'iso1', revision: 4, index: 2 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentB, 2, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markIso)
    const cl = settingsPatches(section)
    assert.equal(cl.length, 2, 'B closes its own card at end/turn-end')
    const cardBId = creates(section)[1].response.data.card_id
    assert.ok(bodyOf(cl[1]).uuid.startsWith('s_' + cardBId + '_'), 'second close targets B card')
  }

  // ══ 场景 7f：完整序列化 IM body ≤30KB —— CJK/emoji/引号/反斜线/换行 JSON 膨胀下可靠分段 ══
  const agentBu = await larkInbound('oc_budget', 'big card budget')
  const markBu = wire.length
  const bigMixed = ('汉"😀\\\n').repeat(3000) // 单元含 CJK/emoji/引号/反斜线/控制换行 → JSON 膨胀
  finalMessage(agentBu, 1, 0, bigMixed)
  await wait(THROTTLE_WAIT)
  turnEnd(agentBu, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markBu)
    const m = interactiveMsgs(section)
    assert.ok(m.length >= 2, 'oversized static content must split into multiple cards, got ' + m.length)
    let totalInner = 0
    let joined = ''
    for (const entry of section) {
      assert.ok(Buffer.byteLength(entry.body, 'utf8') <= 30 * 1024, 'FULL serialized wire body must fit 30KB, got ' + Buffer.byteLength(entry.body, 'utf8'))
    }
    for (const one of m) {
      const cardJson = bodyOf(one).content
      const cardBytes = Buffer.byteLength(cardJson, 'utf8')
      assert.ok(cardBytes <= 30 * 1024, 'serialized card content must fit 30KB, got ' + cardBytes)
      totalInner += cardBytes
      joined += JSON.parse(cardJson).body.elements[0].content
    }
    assert.ok(totalInner > 30 * 1024, 'input must actually exceed one-card budget so splitting is exercised (total ' + totalInner + ')')
    assert.equal(joined, bigMixed, 'segmented cards must reconstruct the original text exactly')
    assert.equal(creates(section).length, 0, 'static path never opens CardKit entities')
  }

  // ══ 场景 7g：P1-2 PUT 在途跨 9min 到期——timer 进同 attempt 传输串行链，
  // close 序号严格接在已成功 PUT 之后，后续 C/final 不中断、不重复序号 ══
  const agentP = await larkInbound('oc_exp2', 'expiry race')
  const markRace = wire.length
  assert.equal(fakeClock.timers.size, 0, 'no lingering card timers before the race test')
  frameStart(agentP, { attemptId: 'px1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentP, { attemptId: 'px1', revision: 2, index: 0, text: 'A' })
  await wait(THROTTLE_WAIT) // 开卡 seed 'A'（无 PUT），排 9min timer
  assert.equal(fakeClock.timers.size, 1)
  const holdP = deferred()
  holdNext = { match: (entry) => entry.method === 'PUT' && entry.url.includes('/elements/'), deferred: holdP }
  frameChunk(agentP, { attemptId: 'px1', revision: 3, index: 1, text: 'B' })
  await wait(THROTTLE_WAIT) // PUT 'AB'（seq1）已派发并挂起
  {
    const held = wire.slice(markRace).filter((w) => w.method === 'PUT' && w.held)
    assert.equal(held.length, 1, 'the AB PUT must be in flight')
  }
  fakeClock.advance(9 * 60 * 1000 + 1000) // timer 触发 → 到期任务进入传输串行链，等在途 PUT
  await wait(20)
  holdP.resolve() // 释放 PUT：明确 200/code0 成功响应
  await wait(THROTTLE_WAIT)
  frameChunk(agentP, { attemptId: 'px1', revision: 4, index: 2, text: 'C' })
  await wait(THROTTLE_WAIT)
  finalMessage(agentP, 1, 0, 'ABC')
  await wait(THROTTLE_WAIT)
  frameEnd(agentP, { attemptId: 'px1', revision: 5, index: 3 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentP, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markRace)
    const c = creates(section)
    assert.equal(c.length, 2, 'expired card closed, continuation card opened')
    const card1 = c[0].response.data.card_id
    const card2 = c[1].response.data.card_id
    const p = puts(section)
    assert.equal(p.length, 1, 'exactly one body PUT (AB); C/final 不重复 PUT')
    assert.equal(bodyOf(p[0]).content, 'AB')
    assert.equal(bodyOf(p[0]).sequence, 1)
    const cl = settingsPatches(section)
    assert.equal(cl.length, 2)
    // 关键：close 严格接在已成功 PUT 之后（seq1 之后是 seq2，不是冲突的 seq1）
    assert.equal(bodyOf(cl[0]).sequence, 2, 'expiry close must be the strict next sequence after the in-flight PUT')
    assert.ok(bodyOf(cl[0]).uuid.startsWith('s_' + card1 + '_'))
    assert.equal(bodyOf(cl[1]).sequence, 1)
    assert.ok(bodyOf(cl[1]).uuid.startsWith('s_' + card2 + '_'))
    const seed2 = JSON.parse(bodyOf(c[1]).data).body.elements[0].content
    assert.equal(seed2, 'C', 'continuation card starts after the delivered AB — no loss, no replay')
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(!st.json.errors.some((e) => String(e.message).includes('Cannot read properties')), 'the expiry/PUT race must not produce a null-reference error')
    assert.ok(!st.json.errors.some((e) => String(e.message).includes('delivery unknown')), 'a successful PUT must not be misreported as unknown (which would stop later body)')
    assert.equal(fakeClock.timers.size, 0, 'all card timers cleaned after close')
  }

  // ══ 场景 8：reload 在途请求 —— 旧链不派发到新配置，旧卡被收尾 ═════════════
  const mark7 = wire.length
  frameStart(agent1, { attemptId: 'att9', revision: 26, turn: 10, step: 0 })
  frameChunk(agent1, { attemptId: 'att9', revision: 27, index: 0, text: 'closing before reload' })
  await wait(THROTTLE_WAIT)
  assert.equal(creates(wire.slice(mark7)).length, 1, 'card open before reload')

  // interactiveCard 关 → 文本模式；POST /reload 整体重建
  const config2 = readConfig()
  config2.adapters.lark.interactiveCard = false
  const reloadPromise = saveConfig(config2) // 在途：先发起
  await reloadPromise
  {
    const section = wire.slice(mark7)
    const closed = settingsPatches(section)
    assert.equal(closed.length, 1, 'reload must close the card left open by the old adapter')
    assert.equal(JSON.parse(bodyOf(closed[0]).settings).config.streaming_mode, false)
    assert.equal(creates(section).length, 1, 'reload must not open new cards')
  }

  // 文本模式：挂住下一个 text POST，制造「请求在途时 reload」
  const agent3 = await larkInbound('oc_3', 'text mode chat')
  const hold = deferred()
  holdNext = { match: (entry) => entry.url.includes('/im/v1/messages'), deferred: hold }
  const mark8 = wire.length
  frameStart(agent3, { attemptId: 'att10', revision: 1, turn: 1, step: 0 })
  frameChunk(agent3, { attemptId: 'att10', revision: 2, index: 0, text: 'held1' })
  await wait(THROTTLE_WAIT) // 此刻首个 text POST 已挂起
  const heldEntries = wire.slice(mark8).filter((e) => e.url.includes('/im/v1/messages'))
  assert.equal(heldEntries.length, 1, 'the first text send must be in flight')
  assert.equal(heldEntries[0].held, true)
  frameChunk(agent3, { attemptId: 'att10', revision: 3, index: 1, text: 'held2' })
  await wait(THROTTLE_WAIT) // 第二段排在串行链上（前一个仍挂起）

  const config3 = readConfig()
  config3.adapters.lark.interactiveCard = false
  const reload2 = saveConfig(config3)
  await wait(60) // 让 reload 走到 stopAdapter（等在途请求）
  hold.resolve() // 释放挂起的请求
  await reload2
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark8)
    const texts = textMsgs(section)
    assert.equal(texts.length, 1, 'only the in-flight segment may complete; the queued one must not dispatch to the reloaded adapter')
    assert.equal(JSON.parse(bodyOf(texts[0]).content).text, 'held1')
    assert.equal(creates(section).length, 0, 'text mode never creates cards')
  }

  // ══ 场景 9：文本模式实时多段 text（拼接不重复、无卡片调用）════════════════
  const agent4 = await larkInbound('oc_4', 'live text')
  const mark9 = wire.length
  frameStart(agent4, { attemptId: 'att11', revision: 1, turn: 1, step: 0 })
  frameChunk(agent4, { attemptId: 'att11', revision: 2, index: 0, text: 'Text A' })
  await wait(THROTTLE_WAIT)
  frameChunk(agent4, { attemptId: 'att11', revision: 3, index: 1, text: 'B😀' })
  await wait(THROTTLE_WAIT)
  frameChunk(agent4, { attemptId: 'att11', revision: 4, index: 2, text: ' C' })
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark9)
    const texts = textMsgs(section)
    assert.equal(texts.length, 3, 'three delta batches must produce three independent texts before any final/end, got ' + texts.length)
    assert.equal(JSON.parse(bodyOf(texts[0]).content).text, 'Text A')
    assert.equal(JSON.parse(bodyOf(texts[1]).content).text, 'B😀')
    assert.equal(JSON.parse(bodyOf(texts[2]).content).text, ' C')
    assert.equal(texts.map((m) => JSON.parse(bodyOf(m).content).text).join(''), 'Text AB😀 C', 'concatenation must reconstruct without repetition')
    for (const m of texts) assert.equal(bodyOf(m).receive_id, 'oc_4')
    assert.equal(creates(section).length, 0, 'text mode must not touch CardKit')
    assert.equal(puts(section).length, 0, 'text mode must not PUT element content')
  }
  // 重复/回退帧拒绝
  const beforeDup2 = wire.length
  frameChunk(agent4, { attemptId: 'att11', revision: 4, index: 2, text: 'EVIL' })
  await wait(THROTTLE_WAIT)
  assert.equal(wire.length, beforeDup2, 'duplicate frames produce no extra text')
  // 最终 message 去重（已全部投递）
  finalMessage(agent4, 1, 0, 'Text AB😀 C')
  await wait(80)
  assert.equal(wire.length, beforeDup2, 'final message must not resend already delivered text')
  frameEnd(agent4, { attemptId: 'att11', revision: 5, index: 3 })
  turnEnd(agent4, 1, 'completed')
  await wait(THROTTLE_WAIT)
  assert.equal(wire.length, beforeDup2, 'end/turn-end add no content in text mode')

  // ══ 场景 10：非流式长文本 → 按预算分多段，拼接完整 ═════════════════════════
  const agent5 = await larkInbound('oc_5', 'long reply')
  const longText = 'x'.repeat(5000)
  const mark10 = wire.length
  finalMessage(agent5, 1, 0, longText)
  await wait(THROTTLE_WAIT)
  turnEnd(agent5, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(mark10)
    const texts = textMsgs(section)
    assert.equal(texts.length, 2, '5000 chars split into two messages at the char cap, got ' + texts.length)
    const joined = texts.map((m) => JSON.parse(bodyOf(m).content).text).join('')
    assert.equal(joined, longText, 'split must not lose or duplicate characters')
    for (const entry of section) {
      assert.ok(Buffer.byteLength(entry.body, 'utf8') <= 30 * 1024, 'every wire body must fit the 30KB budget')
    }
  }

  // ══ 场景 11：部分分段成功 → 适配层进度补试只发剩余段，绝不重复前段 ════════
  const agent6 = await larkInbound('oc_6', 'partial retry')
  const markP = wire.length
  const partialText = 'A'.repeat(4200) // 4096 字符上限 → 两段：4096 + 104
  failNext = (entry) => {
    if (!entry.url.includes('/im/v1/messages')) return false
    try {
      const body = JSON.parse(entry.body)
      if (body.msg_type !== 'text') return false
      return JSON.parse(body.content).text.length === 104
    } catch {
      return false
    }
  }
  finalMessage(agent6, 1, 0, partialText)
  await wait(THROTTLE_WAIT) // 第一次：seg1 成功、seg2 明确失败（引擎记账不推进 sent）
  turnEnd(agent6, 1, 'completed')
  await wait(THROTTLE_WAIT) // endTurn 显式补试 → 适配层进度只发剩余 104 段
  {
    const section = wire.slice(markP)
    const texts = textMsgs(section)
    assert.equal(texts.length, 3, 'seg1 + failed seg2 + retried seg2 = 3 wire attempts, got ' + texts.length)
    const seg1Count = texts
      .filter((m) => JSON.parse(bodyOf(m).content).text.length === 4096)
      .length
    assert.equal(seg1Count, 1, 'the already-delivered first segment must never be re-sent')
    const delivered = texts
      .filter((m) => m.response && m.response.code === 0)
      .map((m) => JSON.parse(bodyOf(m).content).text)
      .join('')
    assert.equal(delivered, partialText, 'delivered segments reconstruct the full text without gaps or duplicates')
    assert.equal(creates(section).length, 0, 'text mode never creates cards')
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(
      st.json.errors.some((e) => String(e.message).includes('segment boom')),
      'the failed segment must be reported explicitly'
    )
  }

  // ══ 场景 12：P1① 实时 5000 delta 部分失败 + 更长 final → 只发未发的 908，绝不重发首段 4096 ══
  const agentG = await larkInbound('oc_g', 'growth final')
  const markG = wire.length
  const liveG = 'x'.repeat(5000)
  failNext = (entry) => {
    if (!entry.url.includes('/im/v1/messages')) return false
    try {
      const b = JSON.parse(entry.body)
      return b.msg_type === 'text' && JSON.parse(b.content).text.length === 904
    } catch {
      return false
    }
  }
  frameStart(agentG, { attemptId: 'g1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentG, { attemptId: 'g1', revision: 2, index: 0, text: liveG })
  await wait(THROTTLE_WAIT) // 段1(4096)成功、段2(904)明确失败 → 引擎不推进 sent
  const grownG = liveG + 'tail' // 最终目标比实时正文更长（目标增长）
  finalMessage(agentG, 1, 0, grownG)
  await wait(THROTTLE_WAIT) // 补试：按已送达前缀只发 904+tail=908
  turnEnd(agentG, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markG)
    const texts = textMsgs(section)
    assert.equal(texts.length, 3, '4096 ok + 904 fail + 908 retry = 3 attempts, got ' + texts.length)
    const lengths = texts.map((m) => JSON.parse(bodyOf(m).content).text.length)
    assert.deepEqual(lengths, [4096, 904, 908], 'grown final must send only the unsent remainder, got ' + JSON.stringify(lengths))
    const delivered = texts
      .filter((m) => m.response && m.response.code === 0)
      .map((m) => JSON.parse(bodyOf(m).content).text)
      .join('')
    assert.equal(delivered, grownG, 'delivered content reconstructs the grown final exactly once')
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(st.json.errors.some((e) => String(e.message).includes('segment boom')), 'the failed middle segment is reported')
  }

  // ══ 场景 13：P1② 返回式 timeout（非 throw）→ deliveryUnknown，final/end 永不盲重发 ══
  const agentT = await larkInbound('oc_t', 'timeout chat')
  const markT = wire.length
  timeoutNext = (entry) => entry.url.includes('/im/v1/messages')
  frameStart(agentT, { attemptId: 't1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentT, { attemptId: 't1', revision: 2, index: 0, text: 'timeout me' })
  await wait(THROTTLE_WAIT) // 首次 text POST 返回 exitCode28/timedOut/status0 → 投递未知
  finalMessage(agentT, 1, 0, 'timeout me done')
  await wait(THROTTLE_WAIT)
  turnEnd(agentT, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markT)
    const attempts = msgs(section)
    assert.equal(attempts.length, 1, 'unknown delivery must stop ALL further body sends (final/end included), got ' + attempts.length)
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(st.json.errors.some((e) => String(e.message).includes('delivery unknown')), 'the no-response timeout must surface as delivery unknown')
  }

  // ══ 场景 14：P1④ 多段同 callback 在途 + reload → 在途段可完成，下一腿立即失效不再派发 ══
  const agentR2 = await larkInbound('oc_r2', 'inflight reload')
  const markR2 = wire.length
  const holdR = deferred()
  holdNext = { match: (entry) => entry.url.includes('/im/v1/messages'), deferred: holdR }
  frameStart(agentR2, { attemptId: 'r1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentR2, { attemptId: 'r1', revision: 2, index: 0, text: 'q'.repeat(4200) })
  await wait(THROTTLE_WAIT) // 段1(4096)已派发并挂起；段2(104)在同 callback 内等待
  {
    const inflight = textMsgs(wire.slice(markR2))
    assert.equal(inflight.length, 1, 'first segment must be in flight')
    assert.equal(inflight[0].held, true)
  }
  const reloadPromise2 = saveConfig(readConfig()) // 发起 reload（同配置，仅重建）
  await wait(120) // 逆序 disposer 首位的 invalidateLarkRuntime 已同步执行
  holdR.resolve()
  await reloadPromise2
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markR2)
    const texts = textMsgs(section)
    assert.equal(texts.length, 1, 'old multi-segment callback must not dispatch its next segment after reload, got ' + texts.length)
    assert.equal(JSON.parse(bodyOf(texts[0]).content).text.length, 4096, 'only the already-in-flight segment completes; the queued 104 must never hit the wire')
  }

  // ══ 场景 15：同 turn 两 step——step0 部分失败（4096 成/104 败）后 step1 先成功，
  // turn 收尾只补 step0 剩余 104；已发绝对前缀按 attempt 保留，不重发 4096、不碰 step1 ══
  const agentS = await larkInbound('oc_s', 'step prefix')
  const markS = wire.length
  const step0Text = 'y'.repeat(4200)
  failNext = (entry) => {
    if (!entry.url.includes('/im/v1/messages')) return false
    try {
      const b = JSON.parse(entry.body)
      return b.msg_type === 'text' && JSON.parse(b.content).text.length === 104
    } catch {
      return false
    }
  }
  frameStart(agentS, { attemptId: 's0', revision: 1, turn: 1, step: 0 })
  frameChunk(agentS, { attemptId: 's0', revision: 2, index: 0, text: step0Text })
  await wait(THROTTLE_WAIT) // step0：段 4096 成功、段 104 明确失败
  // 同 turn 另一 step 先成功（不得清掉 step0 的已发前缀）
  frameStart(agentS, { attemptId: 's1', revision: 3, turn: 1, step: 1 })
  frameChunk(agentS, { attemptId: 's1', revision: 4, index: 0, text: 'step1 body' })
  await wait(THROTTLE_WAIT)
  // turn 收尾：只补 step0 的剩余 104
  turnEnd(agentS, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markS)
    const texts = textMsgs(section)
    assert.equal(texts.length, 4, '4096 + 104(fail) + step1 + 补发104 = 4 attempts, got ' + texts.length)
    const lens = texts.map((m) => JSON.parse(bodyOf(m).content).text.length).sort((a, b) => a - b)
    assert.deepEqual(lens, [10, 104, 104, 4096], 'got lengths ' + JSON.stringify(lens))
    const okLen4096 = texts.filter((m) => JSON.parse(bodyOf(m).content).text.length === 4096 && m.response && m.response.code === 0)
    assert.equal(okLen4096.length, 1, 'the delivered 4096 prefix must never be re-sent')
    const yOk = texts
      .filter((m) => m.response && m.response.code === 0)
      .map((m) => JSON.parse(bodyOf(m).content).text)
      .filter((t) => t.length !== 10)
      .join('')
    assert.equal(yOk, step0Text, 'step0 content delivered exactly once across prefix + 补发')
    const step1 = texts.filter((m) => JSON.parse(bodyOf(m).content).text === 'step1 body')
    assert.equal(step1.length, 1, 'step1 output is untouched by step0 retries')
    const fail104 = texts.filter((m) => JSON.parse(bodyOf(m).content).text.length === 104 && m.response && m.response.code === 999)
    assert.equal(fail104.length, 1, 'exactly one explicit 104 failure')
  }

  // ══ 场景 16：迟到旧 turn aborted 只中止自己——abort({turn}) 不取消新 turn 的在途输出 ══
  const agentX = await larkInbound('oc_x', 'abort identity')
  const markX = wire.length
  frameStart(agentX, { attemptId: 'x1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentX, { attemptId: 'x1', revision: 2, index: 0, text: 'A' })
  await wait(THROTTLE_WAIT) // turn1 的 'A' 已发出
  frameStart(agentX, { attemptId: 'x2', revision: 3, turn: 2, step: 0 })
  frameChunk(agentX, { attemptId: 'x2', revision: 4, index: 0, text: 'B' })
  // 迟到的旧 turn1 aborted（真实事件带 turn=1）：只中止 turn1
  emit('session/event', { id: agentX.session.id }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'aborted' } },
  })
  await wait(THROTTLE_WAIT) // 新 turn 的节流窗口也过了
  finalMessage(agentX, 2, 0, 'B') // 兑底：即使节流被误杀，final 也必须能补 B
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markX)
    const texts = textMsgs(section).map((m) => JSON.parse(bodyOf(m).content).text)
    assert.ok(texts.includes('A'), 'turn1 output before its abort')
    assert.ok(texts.includes('B'), 'late old-turn abort must NOT cancel the new turn output, got ' + JSON.stringify(texts))
    assert.equal(texts.filter((t) => t === 'B').length, 1, 'B is delivered exactly once')
  }
  turnEnd(agentX, 2, 'completed')
  await wait(THROTTLE_WAIT)

  // ══ 场景 17：P1-1 跨批代理对——缓冲的合法尾不被原始 target 污染，
  // 合法批次永不禁声（不误标 unknown 吞正文） ══
  const agentY = await larkInbound('oc_pair', 'pair buffer')
  const markY = wire.length
  frameStart(agentY, { attemptId: 'y1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentY, { attemptId: 'y1', revision: 2, index: 0, text: 'A\ud83d' }) // 引擎缓冲尾部高代理 → 实发 'A'
  await wait(THROTTLE_WAIT)
  frameChunk(agentY, { attemptId: 'y1', revision: 3, index: 1, text: '\ude00B' }) // 补低代理 → 实发 '\ud83d\ude00B'
  await wait(THROTTLE_WAIT)
  finalMessage(agentY, 1, 0, 'A😀B')
  await wait(THROTTLE_WAIT)
  turnEnd(agentY, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markY)
    const texts = textMsgs(section).map((m) => JSON.parse(bodyOf(m).content).text)
    assert.equal(texts.length, 2, 'legit batches must both deliver: got ' + JSON.stringify(texts))
    assert.equal(texts.join(''), 'A😀B', 'buffered pair completes without loss')
    for (const t of texts) assert.equal(isWellFormedStr(t), true, 'each delivered text is independently well-formed')
    // 关键：原始 target 含半代理时不得因 splitter 局部错误被标 unknown 而永久吞后续
    const st = await invoke('GET', '/__dsh-messaging/status')
    assert.ok(!st.json.errors.some((e) => String(e.message).includes('well-formed Unicode')), 'the raw target must never reach the splitter as malformed input')
    assert.ok(!st.json.errors.some((e) => String(e.message).includes('delivery unknown')), 'local validation must never be misreported as unknown delivery')
  }

  const markTextEnd = wire.length // 至此全部为 text 模式出站（全局 phaseText 范围右界）

  // ══ 场景 18：P1-4 token 按 runtime 隔离——旧 auth 迟到不污染新代，新 PUT 只用新 token ══
  // reload A：切 OLD appId + 开卡片模式
  const cfgOld = readConfig()
  cfgOld.adapters.lark.appId = 'cli_old1'
  cfgOld.adapters.lark.interactiveCard = true
  await saveConfig(cfgOld)
  assert.equal(readConfig().adapters.lark.appId, 'cli_old1', 'OLD appId persisted through save+reload')
  const markA = wire.length
  const agentO = await larkInbound('oc_auth_old', 'old auth')
  const holdAuth = deferred()
  holdNext = { match: (entry) => entry.url.includes('/tenant_access_token/internal'), deferred: holdAuth }
  frameStart(agentO, { attemptId: 'oa1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentO, { attemptId: 'oa1', revision: 2, index: 0, text: 'old flow' })
  await wait(THROTTLE_WAIT) // OLD auth 已派发并挂起（尚未 create）
  {
    const auths = wire.slice(markA).filter((w) => w.url.includes('/tenant_access_token/internal'))
    assert.equal(auths.length, 1, 'OLD auth must be in flight')
    assert.equal(auths[0].held, true)
    assert.equal(JSON.parse(auths[0].body).app_id, 'cli_old1')
  }
  // reload B：切 NEW appId；旧 auth 悬挂 → 5s 有界清理放行
  const cfgNew = readConfig()
  cfgNew.adapters.lark.appId = 'cli_new2'
  const reloadP4 = saveConfig(cfgNew)
  await reloadP4 // ≈ LARK_CLEANUP_WAIT_MS 有界等待（旧 auth 仍挂起）
  assert.equal(readConfig().adapters.lark.appId, 'cli_new2')
  // NEW runtime：全新会话开卡 → NEW auth → create/ref/PUT 均应为 NEW token
  const agentN = await larkInbound('oc_auth_new', 'new auth')
  frameStart(agentN, { attemptId: 'na1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentN, { attemptId: 'na1', revision: 2, index: 0, text: 'NEWDATA' })
  await wait(THROTTLE_WAIT)
  // 释放旧 auth：迟到响应只准写旧 runtime 自己的字段
  holdAuth.resolve()
  await wait(80)
  frameChunk(agentN, { attemptId: 'na1', revision: 3, index: 1, text: ' MORE' })
  await wait(THROTTLE_WAIT)
  frameEnd(agentN, { attemptId: 'na1', revision: 4, index: 2 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentN, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markA)
    const auths = section.filter((w) => w.url.includes('/tenant_access_token/internal'))
    // markA 起：OLD 业务 auth（挂起）+ reload B 后新代只读 scope 查询的 auth
    //（诊断专用 token 通道，不读写业务缓存）+ NEW 业务 auth；scope 的 token
    // 绝不被任何业务请求使用（下方 tokened 断言覆盖）。
    assert.equal(auths.length, 3, 'OLD business + NEW scope-read + NEW business auth, got ' + auths.length)
    assert.equal(JSON.parse(auths[0].body).app_id, 'cli_old1')
    assert.equal(JSON.parse(auths[1].body).app_id, 'cli_new2')
    assert.equal(JSON.parse(auths[2].body).app_id, 'cli_new2')
    // NEW 会话的所有带 token 请求（create/ref/PUT/settings）只用 NEW token
    const tokened = section.filter((w) => w.url.includes('/cardkit/') || w.url.includes('/im/v1/messages'))
    assert.ok(tokened.length >= 3, 'NEW session must create + reference + PUT')
    for (const w of tokened) {
      assert.equal(w.headers['Authorization'], 'Bearer tk_cli_new2', 'NEW-generation requests must use only the NEW token: ' + w.method + ' ' + w.url)
    }
    // 迟到的旧 token 不得出现在任何请求上（旧流程在 auth 后被 generation 闸拦下，零建卡）
    assert.ok(!section.some((w) => String(w.headers['Authorization'] || '').includes('tk_cli_old1')), 'the late OLD token must never appear on the wire')
    assert.equal(creates(section).length, 1, 'only the NEW session creates a card (OLD stale flow never dispatches create)')
  }

  // ══ 场景 19：P1-3 create 在途 reload——已知 cardId 立即 cleanup 收尾，
  // 不遗留 create1/ref0/close0，不建第二卡 ══
  const markC = wire.length
  const holdC = deferred()
  holdNext = { match: (entry) => entry.method === 'POST' && entry.url.includes('/cardkit/v1/cards'), deferred: holdC }
  const agentCc = await larkInbound('oc_create2', 'create in flight') // 无 wire
  frameStart(agentCc, { attemptId: 'cx1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentCc, { attemptId: 'cx1', revision: 2, index: 0, text: 'create pending' })
  await wait(THROTTLE_WAIT) // create POST 已派发并挂起
  {
    const held = wire.slice(markC).filter((w) => w.method === 'POST' && w.url.includes('/cardkit/v1/cards') && w.held)
    assert.equal(held.length, 1, 'the create must be in flight')
  }
  const reloadP5 = saveConfig(readConfig()) // 同配置 reload：先 invalidate，create 才返回
  await wait(120)
  holdC.resolve() // create 返回已知 card_id；send 被 generation 闸拦下
  await reloadP5
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markC)
    const c = creates(section)
    assert.equal(c.length, 1, 'exactly one create attempt')
    const knownId = c[0].response && c[0].response.data && c[0].response.data.card_id
    assert.equal(typeof knownId, 'string', 'create resolved with a known card_id')
    const refMsgs = msgs(section).filter((m) => {
      try { return JSON.parse(bodyOf(m).content).type === 'card' } catch { return false }
    })
    assert.equal(refMsgs.length, 0, 'reference send must be blocked by the generation gate')
    const cl = settingsPatches(section)
    assert.equal(cl.length, 1, 'the KNOWN created cardId must be closed via the cleanup path')
    assert.ok(bodyOf(cl[0]).uuid.startsWith('s_' + knownId + '_'), 'cleanup close targets the known id')
    assert.equal(fakeClock.timers.size, 0, 'no orphan expiry timer for the failed open')
  }

  // ══ 场景 20：P2 live 卡体 30KB 预算——长中文/emoji/转义 3 批 delta + final 早期分卡；
  // 每张 create 卡 JSON 与累计更新重建卡体均 ≤30KB，分区拼接唯一无损，全部收尾 ══
  const cardWireBytes = (content) => terminalWireBytes(content, WORST_SUMMARY_SAMPLE) // 与 index 最坏终态 measure 同口径
  const agentL = await larkInbound('oc_livebudget', 'live budget')
  const markL = wire.length
  const unitL = '汉😀"\\\n' // CJK + emoji + 引号 + 反斜线 + 控制换行 → 真实 JSON 转义膨胀
  const part1 = unitL.repeat(1100)
  const part2 = unitL.repeat(1100)
  const part3 = unitL.repeat(200)
  const fullLive = part1 + part2 + part3
  frameStart(agentL, { attemptId: 'lb1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentL, { attemptId: 'lb1', revision: 2, index: 0, text: part1 })
  await wait(THROTTLE_WAIT) // 开卡（seed ≤30KB wire 预算）
  frameChunk(agentL, { attemptId: 'lb1', revision: 3, index: 1, text: part2 })
  await wait(THROTTLE_WAIT) // 累计超卡体预算 → 早期 rollover（pin head + 关旧 + 新卡续尾）
  frameChunk(agentL, { attemptId: 'lb1', revision: 4, index: 2, text: part3 })
  await wait(THROTTLE_WAIT) // 新卡上的累计 PUT（同样 ≤30KB 预算）
  finalMessage(agentL, 1, 0, fullLive)
  await wait(THROTTLE_WAIT)
  frameEnd(agentL, { attemptId: 'lb1', revision: 5, index: 3 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentL, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markL)
    const c = creates(section)
    assert.ok(c.length >= 2, 'live CJK budget must split cards early (before final), got ' + c.length)
    const cl = settingsPatches(section)
    assert.equal(cl.length, c.length, 'every created card must be closed')
    // 每张 create：完整创建 wire ≤30KB，data 内完整 schema 卡 JSON ≤30KB
    const lastByCard = new Map()
    for (const entry of c) {
      assert.ok(Buffer.byteLength(entry.body, 'utf8') <= 30 * 1024, 'create wire must fit 30KB, got ' + Buffer.byteLength(entry.body, 'utf8'))
      const cardJson = entry.body ? JSON.parse(entry.body).data : ''
      assert.ok(Buffer.byteLength(cardJson, 'utf8') <= 30 * 1024, 'create card JSON must fit 30KB, got ' + Buffer.byteLength(cardJson, 'utf8'))
      const id = entry.response.data.card_id
      lastByCard.set(id, JSON.parse(cardJson).body.elements[0].content)
    }
    // 每次累计元素更新：重建完整卡 JSON（config/summary/element 全字段 + 转义）≤30KB
    const p = puts(section)
    assert.ok(p.length >= 1, 'the rollover pin/accumulation must produce PUT updates')
    const lastPutSeq = new Map() // cardId → 该卡最后一次成功 PUT 的 sequence
    for (const entry of p) {
      const content = bodyOf(entry).content
      assert.ok(content.length <= 30000, 'content field must keep the local/SDK conservative 30000-char guard (official content limit is 100000)')
      assert.ok(cardWireBytes(content) <= 30 * 1024, 'reconstructed card body must fit 30KB, got ' + cardWireBytes(content))
      const uuid = bodyOf(entry).uuid // c_<cardId>_<sequence>
      const id = uuid.slice(2, uuid.lastIndexOf('_'))
      assert.ok(lastByCard.has(id), 'PUT targets a card created in this section')
      lastByCard.set(id, content) // 分区终态：该卡最后一次展示内容
      lastPutSeq.set(id, bodyOf(entry).sequence)
    }
    // seq 收尾严格性：每张卡 close 的 sequence = 该卡最后一次成功 PUT+1（无 PUT 则 1）
    for (const entry of cl) {
      const uuid = bodyOf(entry).uuid // s_<cardId>_<sequence>
      const id = uuid.slice(2, uuid.lastIndexOf('_'))
      const expected = (lastPutSeq.get(id) || 0) + 1
      assert.equal(bodyOf(entry).sequence, expected, 'close sequence must be the strict next after the last successful PUT of that card')
    }
    // 收尾终态预算：真实 close.summary（larkSummary 口径）应用到 PATCH 合并原 config
    // 后的**完整终态 schema + create wrapper** 均 ≤30KB——rollover 关旧卡与正常 finish 同约束
    for (const content of lastByCard.values()) {
      assertTerminalBudget(content, larkSummaryLike(content), 'scenario20 rollover/finish terminal')
    }
    // 分区拼接唯一无损：各卡终态按创建顺序 join === 原文
    const joined = [...lastByCard.values()].join('')
    assert.equal(joined, fullLive, 'per-card final partition must reconstruct the original exactly once')
    // 单字符超预算 → splitter 明确 RangeError（同款 measure），绝不截断
    assert.throws(
      () => splitText('汉', { maxLength: 30000, maxBytes: 10, measure: cardWireBytes }),
      (err) => err instanceof RangeError && /maxBytes 10/.test(err.message),
      'a single character over budget must raise an explicit RangeError, never truncate'
    )
  }

  // ══ 场景 21：P1 late-success reference——reference 成功迟到跨 5s 有界清理，
  // 仍以捕获旧 token/runtime 的 cleanup 幂等关卡；新 runtime 正常发送，绝不重复 create/ref ══
  const cfgO2 = readConfig()
  cfgO2.adapters.lark.appId = 'cli_refold'
  await saveConfig(cfgO2)
  const markLS = wire.length
  const holdRef = deferred()
  holdNext = { match: (entry) => entry.method === 'POST' && entry.url.includes('/im/v1/messages'), deferred: holdRef }
  const agentLs = await larkInbound('oc_refold', 'late reference')
  frameStart(agentLs, { attemptId: 'ls1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentLs, { attemptId: 'ls1', revision: 2, index: 0, text: 'late reference body' })
  await wait(THROTTLE_WAIT) // OLD auth→create 成功，reference POST 在途挂住
  const ckLs = (() => {
    const c = creates(wire.slice(markLS))
    assert.equal(c.length, 1, 'OLD create succeeds once')
    assert.equal(c[0].headers['Authorization'], 'Bearer tk_cli_refold', 'OLD create uses the OLD token')
    const held = msgs(wire.slice(markLS)).filter((m) => m.held)
    assert.equal(held.length, 1, 'the reference POST must be in flight')
    return c[0].response.data.card_id
  })()
  // reload 换 appId → 5s 有界清理（attempt owner 表与 larkClosing 均已清空）
  const cfgN2 = readConfig()
  cfgN2.adapters.lark.appId = 'cli_refnew'
  await saveConfig(cfgN2) // 有界等待：engine 队列被挂住的 reference 阻塞，5s 后放行
  assert.equal(readConfig().adapters.lark.appId, 'cli_refnew')
  holdRef.resolve() // 释放：reference 迟到 200/code0（om2）
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markLS)
    assert.equal(creates(section).length, 1, 'exactly one create — no duplicate card')
    const refs = msgs(section).filter((m) => {
      try { return JSON.parse(bodyOf(m).content).type === 'card' } catch { return false }
    })
    assert.equal(refs.length, 1, 'exactly one reference attempt — no blind resend')
    const cl = settingsPatches(section)
    assert.equal(cl.length, 1, 'late-success card must be closed via the captured old runtime/token cleanup path')
    assert.ok(bodyOf(cl[0]).uuid.startsWith('s_' + ckLs + '_'), 'close targets the known late-success cardId')
    assert.equal(bodyOf(cl[0]).sequence, 1, 'fresh card closes at sequence 1')
    assertTerminalBudget('late reference body', larkSummaryLike('late reference body'), 'scenario21 cleanup close terminal')
    assert.equal(cl[0].headers['Authorization'], 'Bearer tk_cli_refold', 'cleanup close must use the captured OLD token')
    assert.equal(fakeClock.timers.size, 0, 'no owner/timer left behind (owner table was cleared by the bounded cleanup)')
  }
  // 新 runtime 正常发送（新 appId token），旧卡不被重复关闭（幂等）
  const agentLs2 = await larkInbound('oc_refnew', 'new runtime send')
  frameStart(agentLs2, { attemptId: 'ns1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentLs2, { attemptId: 'ns1', revision: 2, index: 0, text: 'new runtime body' })
  await wait(THROTTLE_WAIT)
  frameEnd(agentLs2, { attemptId: 'ns1', revision: 3, index: 1 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentLs2, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markLS)
    assert.equal(creates(section).length, 2, 'NEW runtime creates its own card (no reuse, no duplicate)')
    const tokened = section.filter((w) => w.url.includes('/cardkit/') || w.url.includes('/im/v1/messages'))
    const newAuth = tokened.filter((w) => w.headers['Authorization'] === 'Bearer tk_cli_refnew')
    assert.ok(newAuth.length >= 2, 'NEW runtime create+reference use the new token, got ' + newAuth.length)
    const allCl = settingsPatches(section)
    assert.equal(allCl.length, 2, 'old card + new card each closed exactly once')
    const oldCloses = allCl.filter((m) => bodyOf(m).uuid.startsWith('s_' + ckLs + '_'))
    assert.equal(oldCloses.length, 1, 'old card close is idempotent — never re-closed')
    assert.equal(fakeClock.timers.size, 0)
  }

  // ══ 场景 22：P2 measure 预留最坏 summary——饱和纯 CJK 真实 close 终态 + 超预算分卡回退钉子 ══
  // 与 index 同口径的最坏终态 measure 求饱和 N（固定 50 码元最坏摘要预留，保持单调）
  const worstTerminalWire = (content) => terminalWireBytes(content, WORST_SUMMARY_SAMPLE)
  let loN = 1
  let hiN = 20000
  while (loN < hiN) {
    const mid = Math.ceil((loN + hiN) / 2)
    if (worstTerminalWire('字'.repeat(mid)) <= 30 * 1024) loN = mid
    else hiN = mid - 1
  }
  const satN = loN
  assert.ok(worstTerminalWire('字'.repeat(satN)) <= 30 * 1024, 'saturation point must fit, got ' + worstTerminalWire('字'.repeat(satN)))
  assert.ok(worstTerminalWire('字'.repeat(satN + 1)) > 30 * 1024, 'saturation must be tight: +1 char exceeds, got ' + worstTerminalWire('字'.repeat(satN + 1)))

  const agentZ = await larkInbound('oc_satsum', 'saturation summary')
  // turn1：恰好饱和的纯 CJK 单卡 → 正常 finish 收尾，真实 close.summary 终态仍 ≤30KB
  const markZ1 = wire.length
  frameStart(agentZ, { attemptId: 'zs1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentZ, { attemptId: 'zs1', revision: 2, index: 0, text: '字'.repeat(satN) })
  await wait(THROTTLE_WAIT)
  frameEnd(agentZ, { attemptId: 'zs1', revision: 3, index: 1 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentZ, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markZ1)
    const c = creates(section)
    assert.equal(c.length, 1, 'exactly saturated content opens a single card, got ' + c.length)
    assert.ok(Buffer.byteLength(c[0].body, 'utf8') <= 30 * 1024, 'saturated create wire ≤30KB, got ' + Buffer.byteLength(c[0].body, 'utf8'))
    const content = JSON.parse(JSON.parse(c[0].body).data).body.elements[0].content
    assert.equal(content.length, satN, 'seed is exactly the saturated length')
    const realSummary = larkSummaryLike(content)
    // 真实 close.summary 应用 PATCH 合并原 config 的完整终态 schema+wrapper 预算
    assertTerminalBudget(content, realSummary, 'saturated pure-CJK real close summary')
    assert.equal(settingsPatches(section).length, 1, 'saturated card closed exactly once')
    const settings = JSON.parse(bodyOf(settingsPatches(section)[0]).settings)
    assert.equal(settings.config.streaming_mode, false)
    assert.equal(settings.config.summary.content, realSummary, 'real close summary matches the larkSummary口径')
  }

  // 回退钉子：略超预算必须分卡——若 measure 退回默认 summary，整块 overN 会被放行成单卡
  const overN = satN + 20
  const markZ2 = wire.length
  frameStart(agentZ, { attemptId: 'zs2', revision: 4, turn: 2, step: 0 })
  frameChunk(agentZ, { attemptId: 'zs2', revision: 5, index: 0, text: '字'.repeat(overN) })
  await wait(THROTTLE_WAIT)
  frameEnd(agentZ, { attemptId: 'zs2', revision: 6, index: 1 })
  await wait(THROTTLE_WAIT)
  turnEnd(agentZ, 2, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const section = wire.slice(markZ2)
    const c = creates(section)
    assert.equal(c.length, 2, 'over-saturation must split into rollover cards, got ' + c.length)
    const seed1 = JSON.parse(JSON.parse(c[0].body).data).body.elements[0].content
    assert.ok(seed1.length <= satN, 'seed must respect the worst-summary budget (a default-summary measure would allow all ' + overN + '), got ' + seed1.length)
    assert.ok(seed1.length >= satN - 10, 'seed should still saturate near the budget, got ' + seed1.length)
    const lastBy = new Map()
    for (const entry of c) {
      assert.ok(Buffer.byteLength(entry.body, 'utf8') <= 30 * 1024)
      assert.ok(Buffer.byteLength(JSON.parse(entry.body).data, 'utf8') <= 30 * 1024)
      lastBy.set(entry.response.data.card_id, JSON.parse(JSON.parse(entry.body).data).body.elements[0].content)
    }
    const lastPutSeq = new Map()
    for (const entry of puts(section)) {
      const snapshot = bodyOf(entry).content
      assert.ok(cardWireBytes(snapshot) <= 30 * 1024, 'PUT snapshot worst-terminal wire ≤30KB, got ' + cardWireBytes(snapshot))
      const uuid = bodyOf(entry).uuid
      const id = uuid.slice(2, uuid.lastIndexOf('_'))
      lastBy.set(id, snapshot)
      lastPutSeq.set(id, bodyOf(entry).sequence)
    }
    for (const snapshot of lastBy.values()) {
      assertTerminalBudget(snapshot, larkSummaryLike(snapshot), 'scenario22 terminal')
    }
    assert.equal([...lastBy.values()].join(''), '字'.repeat(overN), 'lossless partition across the split')
    const cl = settingsPatches(section)
    assert.equal(cl.length, c.length, 'all cards closed')
    for (const entry of cl) {
      const uuid = bodyOf(entry).uuid
      const id = uuid.slice(2, uuid.lastIndexOf('_'))
      assert.equal(bodyOf(entry).sequence, (lastPutSeq.get(id) || 0) + 1, 'close sequence strict next per card')
    }
  }

  // 最坏 summary 形态（控制符/引号/反斜线/emoji）：真实 larkSummary 口径仍 ≤ 预留 302B
  {
    const jsonBytes = (s) => Buffer.byteLength(JSON.stringify(s), 'utf8')
    const ctrlSummary = larkSummaryLike(String.fromCharCode(1).repeat(60))
    assert.ok(jsonBytes(ctrlSummary) <= 2 + 50 * 6, 'control-char summary STRING within the 302B reserve: ' + jsonBytes(ctrlSummary))
    const nastyInput = ('"' + String.fromCharCode(92) + String.fromCharCode(1) + '😀汉 ').repeat(30)
    const nastySummary = larkSummaryLike(nastyInput)
    assert.ok(jsonBytes(nastySummary) <= 2 + 50 * 6, 'quotes/backslash/control/emoji summary STRING within reserve: ' + jsonBytes(nastySummary))
    const emojiSummary = larkSummaryLike('😀'.repeat(40)) // >50 码元 → 截断点避代理对
    assert.ok(jsonBytes(emojiSummary) <= 2 + 50 * 6, 'emoji summary STRING within reserve: ' + jsonBytes(emojiSummary))
    assert.ok(emojiSummary.length <= 51, 'summary stays bounded (≤50 + ellipsis)')
    const satContent = '字'.repeat(satN)
    assertTerminalBudget(satContent, ctrlSummary, 'worst control summary terminal')
    assertTerminalBudget(satContent, nastySummary, 'nasty quotes/backslash summary terminal')
    assertTerminalBudget(satContent, emojiSummary, 'emoji summary terminal')
  }

  // ══ 全局 wire 形状：body 是字符串、Content-Type 存在、卡片接口 charset 精确 ══
  assert.ok(wire.length > 20, 'the run must have produced real wire traffic, got ' + wire.length)
  for (const entry of wire) {
    assert.equal(typeof entry.body, 'string', 'wire body must be a JSON string, not an object: ' + entry.url)
    const contentType = entry.headers['Content-Type'] || entry.headers['content-type']
    assert.ok(contentType, 'every request must carry Content-Type: ' + entry.url)
    assert.ok(contentType.startsWith('application/json'), 'unexpected Content-Type ' + contentType + ' for ' + entry.url)
    if (entry.url.includes('/cardkit/')) {
      assert.equal(contentType, 'application/json; charset=utf-8', 'card API wire must use the exact charset')
    }
    if (entry.method !== 'GET') assert.ok(entry.body.length > 0, 'non-GET requests must carry a body')
    JSON.parse(entry.body) // wire body 必须是合法 JSON
  }
  // 卡片模式阶段（场景1-7）的全部消息出站都是 interactive；文本模式阶段全是 text
  {
    const phaseCard = wire.slice(0, mark8)
    for (const m of msgs(phaseCard)) {
      assert.equal(bodyOf(m).msg_type, 'interactive', 'card-mode outbound must stay interactive: ' + m.url)
    }
    const phaseText = wire.slice(mark9, markTextEnd) // 至 markTextEnd 均为 text 模式出站
    assert.ok(phaseText.length > 0)
    for (const m of msgs(phaseText)) {
      assert.equal(bodyOf(m).msg_type, 'text', 'text-mode outbound must be plain text')
    }
  }

  // ── P1 dedup 真实账本核验：claim→bind→admission→settle 全链（防自动 settle） ──
  {
    const dd = await import(pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href)
    const storeRoot = path.join(fixtureDshHome, 'lark-dedup')
    const lease = await dd.openLarkDedupStore(storeRoot) // 进程内共享单写者 lease（索引持有）
    // 计数器在 reload（journal 重开）后会归零重建；appId 随 reload A/B 切换 →
    // 跨 appId 扫描（cli_int_test → cli_old1 → cli_new2）。
    const APP_IDS = ['cli_int_test', 'cli_old1', 'cli_new2']
    const recFor = (msgId) => {
      for (const a of APP_IDS) {
        const r = lease.get(dd.larkDedupKey(a, msgId))
        if (r) return r
      }
      return null
    }
    let delivered = 0
    let claimedSeen = 0
    const failed = []
    for (let i = 1; i <= 96; i += 1) {
      const rec = recFor('om_in_' + i)
      if (!rec) continue
      claimedSeen += 1
      if (rec.state === 'delivered') delivered += 1
      if (rec.error) failed.push('om_in_' + i + '->' + rec.state + ':' + rec.error + ':sx=' + rec.sessionExisted)
    }
    const stats = lease.stats()
    assert.ok(claimedSeen >= 4, '入站真实 claim 落盘（记录扫描）: ' + claimedSeen)
    assert.ok(stats.sendAcquired === 0 && stats.sendSent === 0, '本轮无出站图片 receipt（P4 未接）')
    assert.equal(failed.length, 0, '干净链路零失败记录；明细: ' + JSON.stringify(failed))
    assert.equal(delivered, claimedSeen, '每条入站均经真实 admitted 后 settle delivered（非自动 settle）: '
      + delivered + '/' + claimedSeen)
    assert.ok(delivered >= 1, '真实 admission admitted 后 settle delivered（非自动 settle）: ' + delivered)
    // 陷阱实测：settle 三重门（in-flight / flushed:true / admitted）全部由 API 强制，
    // 任何一缺就抛错——不存在“未过判据就自动 settle”的路径。
    const trapKey = dd.larkDedupKey('cli_int_test', 'om_trap_settle_1')
    const trapClaim = await lease.claim({ appId: 'cli_int_test', messageId: 'om_trap_settle_1', chatId: 'oc_trap', chatType: 'p2p' })
    assert.equal(trapClaim.outcome, 'claimed', '陷阱用临时 claim')
    await assert.rejects(
      () => lease.settleDelivered(trapKey, { flushed: true, admission: 'uncertain' }),
      /admission/, '未证 admitted 不得 settle（bad_evidence）')
    await assert.rejects(
      () => lease.settleDelivered(trapKey, { flushed: false, admission: 'admitted' }),
      /flushed/, '缺 flushed:true 不得 settle')
    await assert.rejects(
      () => lease.settleDelivered(dd.larkDedupKey('cli_int_test', 'om_never_claimed'), { flushed: true, admission: 'admitted' }),
      /in-flight|unknown record/, '无在途 claim 不得 settle')
    const okSettle = await lease.settleDelivered(trapKey, { flushed: true, admission: 'admitted' })
    assert.equal(okSettle.state, 'delivered', '三重门齐备才放行')
    // B-3：route 证据只复用——绝不写 false、sid 确定性绑定（入口+入站不二次推导）。
    for (let i = 1; i <= 96; i += 1) {
      const rec = recFor('om_in_' + i)
      if (!rec) continue
      assert.ok(rec.sessionExisted !== false, 'B-3 sx 绝不写 false: om_in_' + i)
      assert.ok(typeof rec.sessionId === 'string' && rec.sessionId, 'B-3 sid 确定性绑定: om_in_' + i)
    }
    // B-1：坏投影缓存（非法 shape）→ uncertain → 0 次 followup + admission_failed 终态。
    const mig = await import(pathToFileURL(path.join(root, 'lib', 'session-id-migration.js')).href)
    const adMod = await import(pathToFileURL(path.join(root, 'lib', 'lark-admission.js')).href)
    projectionStates.set(mig.sessionIdForKey('lark:oc_badcache'), { [adMod.LARK_ADMISSION_KEY]: { corrupted: true } })
    const nextId = 'om_in_' + (inboundSeq + 1)
    const appIdNow = readConfig().adapters.lark.appId // 当前生效（reload B 后）
    const agentBad = await larkInbound('oc_badcache', '坏缓存探针')
    assert.equal(agentBad.messages.length, 0, 'B-1 坏投影缓存 → uncertain → 0 次 followup（不入队）')
    const badRec = lease.get(dd.larkDedupKey(appIdNow, nextId))
    // C-1 语义：uncertain → 固定无正文告知；**送达后** settleRejected（非 delivered、
    // 不再 admission_failed 静默终态）。
    assert.ok(badRec, 'B-1 记录存在（当前 appId=' + appIdNow + '）')
    assert.equal(badRec.state, 'rejected', 'B-1 uncertain → 告知送达后 settleRejected')
    assert.equal(badRec.error, null, 'B-1 不落 admission_failed 静默终态')
    // ── C：崩溃残留本地完结（主动 recover；不靠平台重投）────────────────
    const sidRec = mig.sessionIdForKey('lark:oc_recover')
    const agentPreRec = await larkInbound('oc_recover', '恢复会话前置') // 先建真实会话（正常链路 settle）
    const preUmid = agentPreRec.messages[0] && agentPreRec.messages[0].id // 正常入队项（inbox 首项）
    // (a) admitted 命中（入队后未 settle 的崩溃残留）：人工 claim+release，投影已证
    const recA = await lease.claim({ appId: appIdNow, messageId: 'om_rec_a', chatId: 'oc_recover', chatType: 'p2p', sessionId: sidRec, sessionExisted: true })
    assert.equal(recA.outcome, 'claimed', 'C 阶段a 人工 claim')
    lease.release(recA.record.key)
    projectionSplice(sidRec, { id: recA.record.userMessageId }) // 真投影：已入队事实
    // (b) not_admitted（未入队）：正文经 message GET（harness 真 wire mock）
    const recB = await lease.claim({ appId: appIdNow, messageId: 'om_rec_b', chatId: 'oc_recover', chatType: 'p2p', sessionId: sidRec, sessionExisted: true })
    assert.equal(recB.outcome, 'claimed', 'C 阶段b 人工 claim')
    lease.release(recB.record.key)
    // 触发：显式 reload → close/drain → start → warm → runLarkDedupRecovery（本地取权）
    const reloadRec = await invoke('POST', '/__dsh-messaging/reload')
    assert.equal(reloadRec.status, 200, 'C 触发 reload')
    let settledA = null
    let settledB = null
    for (let i = 0; i < 120; i += 1) {
      await wait(50)
      settledA = lease.get(recA.record.key)
      settledB = lease.get(recB.record.key)
      if (settledA && settledA.state === 'delivered' && settledB && settledB.state === 'delivered') break
    }
    assert.equal(settledA && settledA.state, 'delivered', 'C (a) admitted 命中 → 本地 settle（无需平台重投）')
    assert.equal(settledB && settledB.state, 'delivered', 'C (b) message GET 正文 → followup → admitted → settle')
    // ── C-1 端到端：会话已删 → 固定无正文告知 → 送达后才 settleRejected ──
    const recC = await lease.claim({ appId: appIdNow, messageId: 'om_rec_c', chatId: 'oc_gone', chatType: 'p2p', sessionId: 'dsh-deleted-session-zz', sessionExisted: true })
    assert.equal(recC.outcome, 'claimed', 'C-1 场景 claim')
    lease.release(recC.record.key)
    const noticeCountBase = wire.filter((w) => String(w.url).includes('receive_id_type=chat_id')).length
    await invoke('POST', '/__dsh-messaging/reload')
    let settledC = null
    for (let i = 0; i < 140; i += 1) {
      await wait(50)
      settledC = lease.get(recC.record.key)
      if (settledC && settledC.state === 'rejected') break
    }
    assert.equal(settledC && settledC.state, 'rejected', 'C-1 通知送达后才 settleRejected（会话已删）')
    const noticeWires = wire.filter((w) => String(w.url).includes('receive_id_type=chat_id'))
    assert.ok(noticeWires.length > noticeCountBase, 'C-1 真实发出固定告知')
    const noticeUuids = noticeWires.map((w) => { try { return String(JSON.parse(w.body || '{}').uuid || '') } catch { return '' } })
    assert.ok(noticeUuids.some((u) => u.startsWith('lkn_')), 'C-1 lkn_ 独立域 uuid 真实入 wire')
    // crash/重放零重复：再次 reload 不入 recover（terminal）→ 通知计数不变
    const noticeCountAfter = wire.filter((w) => String(w.url).includes('receive_id_type=chat_id')).length
    await invoke('POST', '/__dsh-messaging/reload')
    await wait(1500)
    assert.equal(wire.filter((w) => String(w.url).includes('receive_id_type=chat_id')).length, noticeCountAfter, 'C-1 重放零重复通知')
    // ── C-4：冷 resume pending（inbox 仍有该 ID）→ delivered+waiting 告知；已消费 → 不报 ──
    const recE = await lease.claim({ appId: appIdNow, messageId: 'om_rec_e', chatId: 'oc_recover', chatType: 'p2p', sessionId: sidRec, sessionExisted: true })
    assert.equal(recE.outcome, 'claimed', 'C-4 E 场景 claim')
    lease.release(recE.record.key)
    projectionSplice(sidRec, { id: recE.record.userMessageId })
    fakeInboxOf(sidRec).push({ id: recE.record.userMessageId, role: 'user', content: [] }) // 未消费 pending
    const recF = await lease.claim({ appId: appIdNow, messageId: 'om_rec_f', chatId: 'oc_recover', chatType: 'p2p', sessionId: sidRec, sessionExisted: true })
    assert.equal(recF.outcome, 'claimed', 'C-4 F 场景 claim')
    lease.release(recF.record.key)
    projectionSplice(sidRec, { id: recF.record.userMessageId }) // 仅历史投影命中（已消费/压缩）
    await invoke('POST', '/__dsh-messaging/reload')
    let settledE = null
    let settledF = null
    for (let i = 0; i < 140; i += 1) {
      await wait(50)
      settledE = lease.get(recE.record.key)
      settledF = lease.get(recF.record.key)
      if (settledE && settledE.state === 'delivered' && settledF && settledF.state === 'delivered') break
    }
    assert.equal(settledE && settledE.state, 'delivered', 'C-4 pending：账本 delivered（持久准入，非 rejected）')
    assert.equal(settledF && settledF.state, 'delivered', 'C-4 已消费：账本 delivered')
    const waitNotices = wire.filter((w) => String(w.url).includes('receive_id_type=chat_id') && String(w.body || '').includes('已入队'))
    assert.equal(waitNotices.length, 1, 'C-4 仅 pending（inbox 仍有 ID）发一次 waiting 告知；已消费不报')
    assert.deepEqual(fakeInboxOf(sidRec).map((m) => m.id), [preUmid, recB.record.userMessageId, recE.record.userMessageId], 'C-4 不重复入队、不调用私有方法（inbox 内容=前置+GET入队+E pending，无新增）')
    // ── E 入站图片管线（fresh 下载→admitPromptContent typed blocks→umid 准入）──
    fakeLarkSdk.__downloadImpl = () => ({ headers: {}, getReadableStream: () => Readable.from([PNG_1x1]) })
    const imgMsgId = 'om_img_e1'
    const agentI = await larkInboundImage('oc_img1', 'img_v3_k1', imgMsgId)
    let recI = null
    for (let i = 0; i < 100; i += 1) {
      await wait(50)
      recI = lease.get(dd.larkDedupKey(appIdNow, imgMsgId))
      if (recI && recI.state === 'delivered') break
    }
    let dbgMsg = 'E fresh 图片：下载→admitPromptContent→umid 准入→settle delivered'
    if (!(recI && recI.state === 'delivered')) {
      const stE = await invoke('GET', '/__dsh-messaging/status')
      dbgMsg += ' | dbg notices=' + JSON.stringify(wire.filter((w) => String(w.url).includes('receive_id_type=chat_id')).map((w) => String(w.body || '').slice(0, 70)))
      dbgMsg += ' | errs=' + JSON.stringify((stE.json.errors || []).slice(-3).map((e) => String(e.message).slice(0, 90)))
      dbgMsg += ' | img1notice=' + JSON.stringify(wire.filter((w) => String(w.url).includes('receive_id_type=chat_id') && String(w.body || '').includes('oc_img1')).map((w) => { try { return JSON.parse(JSON.parse(w.body).content).body.elements[0].text.content } catch { return '?' } }))
    }
    assert.equal(recI && recI.state, 'delivered', dbgMsg)
    const msgI = agentI && agentI.messages[0]
    assert.ok(msgI && String(msgI.id).startsWith('lark-'), 'E 用账本原 userMessageId')
    assert.equal(msgI && msgI.content[0].type, 'image', 'E 真实 typed image block（非 key/base64/path 文本）')
    // T5 口径拆分：attachmentId 内容寻址 ≠ UserMessage 去重——以账本 umid 的
    // followup 计数恰一为入口级证据（真实插件 fresh 入口+真实账本+真实 admission）。
    assert.equal(agentI.messages.filter((m) => m.id === recI.userMessageId).length, 1, 'followup 恰一（UserMessage 层：umid 计数=1）')
    // E 非视觉：固定可见告知（告知送达后才 rejected；不自动切模型）
    llmModalities.splice(0, llmModalities.length, 'text')
    const imgMsgId2 = 'om_img_e2'
    await larkInboundImage('oc_img2', 'img_v3_k2', imgMsgId2)
    let recI2 = null
    for (let i = 0; i < 100; i += 1) {
      await wait(50)
      recI2 = lease.get(dd.larkDedupKey(appIdNow, imgMsgId2))
      if (recI2 && recI2.state === 'rejected') break
    }
    assert.equal(recI2 && recI2.state, 'rejected', 'E 非视觉：告知送达后才 rejected')
    assert.ok(wire.some((w) => String(w.url).includes('receive_id_type=chat_id') && String(w.body || '').includes('不支持图片')), 'E 非视觉固定告知（不自动切模型、不记图片成功）')
    llmModalities.splice(0, llmModalities.length, 'text', 'image')
    // E 临时下载失败：claimed 保留可见 pending（有界重试），不静默丢不 rejected
    fakeLarkSdk.__downloadImpl = () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }
    const imgMsgId3 = 'om_img_e3'
    await larkInboundImage('oc_img3', 'img_v3_k3', imgMsgId3)
    await wait(400)
    const recI3 = lease.get(dd.larkDedupKey(appIdNow, imgMsgId3))
    assert.equal(recI3 && recI3.state, 'claimed', 'E 临时下载失败：claimed 保留可见 pending（不丢不 rejected）')
    assert.equal(recI3 && recI3.error, null, 'E 临时失败不落失败终态')
    fakeLarkSdk.__downloadImpl = () => ({ headers: {}, getReadableStream: () => Readable.from([PNG_1x1]) })
    // E 恢复分支 image（替换 content_image_pending）：GET→parts→同管线
    const sidImg1 = mig.sessionIdForKey('lark:oc_img1')
    const recG = await lease.claim({ appId: appIdNow, messageId: 'om_rec_g', chatId: 'oc_img1', chatType: 'p2p', sessionId: sidImg1, sessionExisted: true })
    assert.equal(recG.outcome, 'claimed', 'E 恢复场景 claim')
    lease.release(recG.record.key)
    await invoke('POST', '/__dsh-messaging/reload')
    let recG2 = null
    for (let i = 0; i < 140; i += 1) {
      await wait(50)
      recG2 = lease.get(recG.record.key)
      if (recG2 && recG2.state === 'delivered') break
    }
    assert.equal(recG2 && recG2.state, 'delivered', 'E 恢复 image：GET→parts→统一管线→settle（content_image_pending 已替换）')
    // 恢复入口同样恰一（真实 recovery 入口+账本+admission；inbox=真实入队记录）。
    assert.equal(fakeInboxOf(sidImg1).filter((m) => m.id === recG.record.userMessageId).length, 1, 'recovery followup 恰一（umid 计数=1，无重复准入）')
    // ── F：followup 先入队后 throw → 重查 admission 仍 settle delivered ──
    followupThrowOnce = true
    const thrMsgId = 'om_in_' + (inboundSeq + 1)
    await larkInbound('oc_fthr', '先入队后抛错')
    let recThr = null
    for (let i = 0; i < 100; i += 1) {
      await wait(50)
      recThr = lease.get(dd.larkDedupKey(appIdNow, thrMsgId))
      if (recThr && recThr.state === 'delivered') break
    }
    assert.equal(recThr && recThr.state, 'delivered', 'F：followup 已入队后 throw → 重查 admitted → settle delivered（不重复入队）')
    // ── U：通知 unknown（网络无响应）→ 保留 claimed；receipts 幂等零重派 ──
    const recU = await lease.claim({ appId: appIdNow, messageId: 'om_rec_u', chatId: 'oc_nw', chatType: 'p2p', sessionId: mig.sessionIdForKey('lark:oc_nw'), sessionExisted: true })
    assert.equal(recU.outcome, 'claimed', 'U 场景 claim')
    lease.release(recU.record.key)
    noticeFailMode = true
    await invoke('POST', '/__dsh-messaging/reload')
    const nwFilter = () => wire.filter((w) => String(w.url).includes('receive_id_type=chat_id') && String(w.body || '').includes('oc_nw')).length
    let nwCount = 0
    let recUState = null
    for (let i = 0; i < 140; i += 1) {
      await wait(50)
      nwCount = nwFilter()
      recUState = lease.get(recU.record.key)
      if (nwCount >= 1 && recUState && recUState.state === 'claimed') break
    }
    assert.equal(nwCount, 1, 'U：unknown 通知仅一次 wire（sendReceipts 幂等）')
    assert.equal(recUState && recUState.state, 'claimed', 'U：unknown 通知保留 claimed（可见 pending，未终态）')
    await wait(6500) // 跨一次 5s 退避重试
    assert.equal(nwFilter(), 1, 'U：unknown 重试零重派（begin=unknown 不再 POST）')
    noticeFailMode = false
    // ── Q：>96 项公平处理（每 32/扇续扇，不饿死、全终态可见）──────
    for (let i = 0; i < 100; i += 1) {
      const mid = 'om_q' + String(i).padStart(3, '0')
      const cq = await lease.claim({ appId: appIdNow, messageId: mid, chatId: 'oc_recover', chatType: 'p2p', sessionId: sidRec, sessionExisted: true })
      assert.equal(cq.outcome, 'claimed', 'Q 场景 claim ' + mid)
      lease.release(cq.record.key)
    }
    await invoke('POST', '/__dsh-messaging/reload') // 全量重新种子（不限 32）
    const qKey = (k) => dd.larkDedupKey(appIdNow, 'om_q' + String(k).padStart(3, '0'))
    let qDone = 0
    for (let i = 0; i < 400 && qDone < 100; i += 1) {
      await wait(50)
      qDone = 0
      for (let k = 0; k < 100; k += 1) {
        const r = lease.get(qKey(k))
        if (r && r.state === 'rejected') qDone += 1
      }
    }
    assert.equal(qDone, 100, 'Q：>96 项全部公平终态（不止前 32，无饿死）')
    // ── P：5 次尝试后明确暂停可见（真退避链；poll 完成条件）──────
    noticeFailMode = true
    const recP = await lease.claim({ appId: readConfig().adapters.lark.appId, messageId: 'om_pause1', chatId: 'oc_nw', chatType: 'p2p', sessionId: mig.sessionIdForKey('lark:oc_nw'), sessionExisted: true })
    assert.equal(recP.outcome, 'claimed', 'P 场景 claim')
    lease.release(recP.record.key)
    await invoke('POST', '/__dsh-messaging/reload')
    let pausedTrace = null
    for (let i = 0; i < 2000 && !pausedTrace; i += 1) { // ≤100s 真退避链完成条件
      await wait(50)
      const stP = await invoke('GET', '/__dsh-messaging/status')
      pausedTrace = (stP.json.recent || []).find((e) => e.kind === 'lark-recovery' && e.outcome === 'paused') || null
    }
    assert.ok(pausedTrace, 'P：5 次尝试后 paused 在产品状态面可见（非仅测试日志）')
    const recP2 = lease.get(recP.record.key)
    assert.equal(recP2 && recP2.state, 'claimed', 'P：paused 记录保留 claimed（可见 pending）')
    noticeFailMode = false
    await lease.close() // 引用计数-1（索引侧 lease 不受影响）
    // ── W：claim 失败（同签名 webhook body）→ 非成功 ACK 且不留成功 replay；
    // 恢复存储 → 同 body 200 + 恰一入队。按**受支持边界**同步：停用（不 warm）→
    // reload 真 close/drain（refcount 归零）→ 注入 journal 故障 → 启用触发真实
    // open 失败 → 修复 → reload 重开。故障严格位于 close 与 open 之间，不在活
    // 句柄阶段外部替换（存储承诺外）。
    const cfgWh = readConfig()
    cfgWh.adapters.lark.enabled = false
    await saveConfig(cfgWh) // rebuild：lark 停用 → 不 warm（store 仍开）
    await invoke('POST', '/__dsh-messaging/reload') // 真 close/drain
    const journalPath = path.join(fixtureDshHome, 'lark-dedup', 'journal.jsonl')
    fs.rmSync(journalPath, { force: true })
    fs.mkdirSync(journalPath, { recursive: true }) // 目录顶替 journal
    const cfgWh2 = readConfig()
    cfgWh2.adapters.lark.enabled = true
    cfgWh2.adapters.lark.mode = 'webhook'
    cfgWh2.adapters.lark.verificationToken = 'tok_wh1'
    await saveConfig(cfgWh2) // 重建 → start → warm → 真实 open 失败（目录顶替）
    // 完成条件：store 真不可用（open 失败可见）后才发 claim，不猜时序。
    let sawUnavailable = false
    for (let i = 0; i < 120; i += 1) {
      await wait(50)
      const stW = await invoke('GET', '/__dsh-messaging/status')
      const ddW = (stW.json.channels || []).find((c) => c.key === 'lark')
      const snap = ddW && ddW.diagnostics && ddW.diagnostics.dedup
      if (snap && snap.available === false) { sawUnavailable = true; break }
    }
    assert.ok(sawUnavailable, 'W：注入命中本次 open（store 不可用可见后才发 claim）')
    const whBody = JSON.stringify({ token: 'tok_wh1', type: 'im.message.receive_v1', message: { message_id: 'om_wh1', message_type: 'text', chat_type: 'p2p', chat_id: 'oc_wh1', content: JSON.stringify({ text: 'webhook重试正文' }) } })
    const whHeaders = { 'Content-Type': 'application/json' }
    const whFail1 = await invoke('POST', '/messaging/lark/events', { body: whBody, headers: whHeaders })
    assert.equal(whFail1.status, 500, 'W：claim 持久失败 → 非成功 ACK（500）')
    const whFail2 = await invoke('POST', '/messaging/lark/events', { body: whBody, headers: whHeaders })
    assert.equal(whFail2.status, 500, 'W：同签名 body 再试仍 500（未留成功 replay）')
    assert.ok(!String(JSON.stringify(whFail1.json)).includes('replayed'), 'W：首次失败不留成功 replay 标记')
    fs.rmSync(journalPath, { recursive: true, force: true }) // 修复（干净新账本）
    await invoke('POST', '/__dsh-messaging/reload') // 重开（open 成功）
    let reopened = false
    for (let i = 0; i < 120; i += 1) {
      await wait(50)
      const stW2 = await invoke('GET', '/__dsh-messaging/status')
      const ddW2 = (stW2.json.channels || []).find((c) => c.key === 'lark')
      const snap2 = ddW2 && ddW2.diagnostics && ddW2.diagnostics.dedup
      if (snap2 && snap2.available === true) { reopened = true; break }
    }
    assert.ok(reopened, 'W：修复后 store 真实重开可见')
    const whOk = await invoke('POST', '/messaging/lark/events', { body: whBody, headers: whHeaders })
    assert.equal(whOk.status, 200, 'W：恢复存储后同已鉴权 body 真 durable 成功（200）')
    const lease2 = await dd.openLarkDedupStore(storeRoot)
    let whRec = null
    for (let i = 0; i < 120; i += 1) {
      await wait(50)
      whRec = lease2.get(dd.larkDedupKey(readConfig().adapters.lark.appId, 'om_wh1'))
      if (whRec && whRec.state === 'delivered') break
    }
    assert.equal(whRec && whRec.state, 'delivered', 'W：durable claim 后正常入站并 settle')
    const whAgent = createdAgents[createdAgents.length - 1].agent
    assert.equal(whAgent.messages.filter((m) => String(m.id).startsWith('lark-')).length, 1, 'W：同 body 重试不重复，恰一入队')
    await lease2.close()
  }

  // ── dispose 卫生可观察：释放后计时器/队列已清——不再产生新告知 wire ──────
  const wireBeforeDispose = wire.length
  for (const dispose of effectDisposers.slice().reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
  await wait(6000)
  assert.equal(wire.length, wireBeforeDispose, 'dispose 后无新 wire（恢复计时器/队列已清，零句柄泄漏）')

  console.log('lark-integration ok | wire calls:', wire.length,
    '| cards created:', creates().length, '| PUTs:', puts().length, '| closes:', settingsPatches().length)
}
main().catch((err) => { console.error(err); process.exit(1) })
