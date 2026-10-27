// lark-diagnostics.cjs —— 匿名诊断（schemaVersion 1）+ 只读 scope 查询（grant 域）
// 的宿主级回归。与 lark-integration.cjs 同源 harness，但独立文件：
//   ① scope 查询：granted/denied(2)/缺scope(unknown)/失败保留旧证据/分页防御/
//      刷新 API 契约（单飞+限频）/status GET 零网络；
//   ② 缺权（官方 99991672 真实形状）：card_create denied + 静态 interactive 兜底 +
//      reason=permission_denied + 无 text 降级 + 无盲重发；
//   ③ 三批 live：final 前 PUT 计数、close、firstDeliveryAckMs、completed；
//   ④ 非流式静态 vs 缺权兜底分界、unknown 投递、恶意错误文本不落库；
//   ⑤ 并发 Agent 回合隔离 + reload 旧代迟到结果不污染新代。
// 不改任何真实配置/凭据；全部走假 shell（无真实网络）。
process.env.DSH_TEST_TIMEOUT_MS = process.env.DSH_TEST_TIMEOUT_MS || '120000'
require('./_guard.cjs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const fixtureDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diag-home-'))

const routes = new Map()
const listeners = new Map()
const shellCalls = []
const writtenFiles = new Map()
const createdAgents = []
const persistedSessions = new Set()

const wire = []
let holdNext = null
let throwNext = null
let failNext = null // 一次性失败匹配
let failWhile = null // 持续失败匹配（不清除），配合 failWhileBody
let failWhileBody = null // failWhile 命中时使用的响应体（持续生效直到手动清除）
let failBody = null
let timeoutNext = null

// scope 查询响应（官方形状）：默认 cardkit:card:write 已授权。
let scopeListBody = JSON.stringify({
  code: 0,
  msg: 'success',
  data: { scopes: [{ scope_name: 'cardkit:card:write', grant_status: 1 }] },
})
// 分页场景：page_token → 响应体；null = 单页模式。
let scopePagesByToken = null

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
  if (url.includes('/application/v6/scopes')) {
    if (scopePagesByToken) {
      const match = /[?&]page_token=([^&]*)/.exec(url)
      const token = match ? decodeURIComponent(match[1]) : 'main'
      return scopePagesByToken[token] || JSON.stringify({ code: 1, msg: 'bad page', data: {} })
    }
    return scopeListBody
  }
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    let appId = 'unknown'
    try { appId = (JSON.parse(parsed.body || '{}').app_id) || 'unknown' } catch { appId = 'unknown' }
    return JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 'tk_' + appId, expire: 7200 })
  }
  if (parsed.method === 'POST' && url.includes('/cardkit/v1/cards')) {
    return JSON.stringify({ code: 0, msg: 'ok', data: { card_id: 'ck_' + (++wireIdSeq) } })
  }
  if (parsed.method === 'POST' && url.includes('/im/v1/messages')) {
    return JSON.stringify({ code: 0, msg: 'ok', data: { message_id: 'om_' + (++wireIdSeq) } })
  }
  return JSON.stringify({ code: 0, msg: 'ok', data: {} })
}
let wireIdSeq = 0

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
      throwNext = null
      const error = new Error('simulated socket reset')
      error.code = 'ECONNRESET'
      throw error
    }
    let responseBody = routeResponseBody(parsed)
    if (failWhile && failWhile(entry)) {
      responseBody = failWhileBody ? failWhileBody : JSON.stringify({ code: 999, msg: 'segment boom' })
    }
    if (failNext && failNext(entry)) {
      failNext = null
      responseBody = failBody ? failBody : JSON.stringify({ code: 999, msg: 'segment boom' })
      failBody = null
    }
    if (timeoutNext && timeoutNext(entry)) {
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
    entry.response = JSON.parse(responseBody)
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

const larkHandlers = {}
let larkMessageHandler = null
const fakeLarkSdk = {
  LoggerLevel: { info: 'info', debug: 'debug' },
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
    return undefined
  },
  on(name, fn, options) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push({ fn, options })
    return () => {}
  },
  effect(fn) { return fn() },
  interval() { return () => {} },
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error('webserver: duplicate exact route "' + route.path + '"')
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  shell: fakeShell,
  fs: fsService,
  agentDefaultModel: { currentSelection() { return { provider: 'test-provider', model: 'test-model' } } },
  agents: {
    async create(options) {
      const id = options.sessionId
      if (persistedSessions.has(id)) {
        const error = new Error('session "' + id + '" already exists')
        error.name = 'SessionAlreadyExistsError'
        throw error
      }
      persistedSessions.add(id)
      const agent = { id, session: { id }, messages: [], followup(message) { agent.messages.push(message) } }
      const handle = { agent, async dispose() {} }
      createdAgents.push({ options, agent, handle })
      return handle
    },
    async resume(options) {
      const id = options.resumeSessionId
      if (!persistedSessions.has(id)) {
        const error = new Error('session "' + id + '" not found')
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      }
      const agent = { id, session: { id }, messages: [], followup(message) { agent.messages.push(message) } }
      return { agent, async dispose() {} }
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
const THROTTLE_WAIT = 320

function loopbackHeaders(extra) {
  return Object.assign({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, extra || {})
}

async function invoke(method, routePath, { body, headers, routesMap } = {}) {
  const handler = (routesMap || routes).get(routePath)
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

async function readDiagnostics() {
  const status = await invoke('GET', '/__dsh-messaging/status')
  const lark = status.json.channels.find((c) => c.key === 'lark')
  assert.ok(lark, 'lark channel present in status')
  return { lark, diag: lark.diagnostics }
}

const bodyOf = (entry) => JSON.parse(entry.body)
const msgs = (list = wire) => list.filter((w) => w.method === 'POST' && w.url.includes('/im/v1/messages'))
const creates = (list = wire) => list.filter((w) => w.method === 'POST' && w.url.includes('/cardkit/v1/cards'))
const puts = (list = wire) => list.filter((w) => w.method === 'PUT' && w.url.includes('/elements/'))
const settingsPatches = (list = wire) => list.filter((w) => w.method === 'PATCH' && w.url.includes('/settings'))
const textMsgs = (list) => msgs(list).filter((m) => bodyOf(m).msg_type === 'text')
const interactiveMsgs = (list) => msgs(list).filter((m) => bodyOf(m).msg_type === 'interactive')

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
  await wait(30)
  assert.ok(createdAgents.length > before, 'inbound must create an agent for ' + chatId)
  return createdAgents[createdAgents.length - 1].agent
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
function finalMessage(agent, turn, step, text, extra) {
  emit('session/event', { id: agent.session.id }, {
    type: 'assistant/message',
    data: Object.assign({ turn, step, message: { content: [{ type: 'text', text }] } }, extra || {}),
  })
}
function turnEnd(agent, turn, kind) {
  emit('session/event', { id: agent.session.id }, { type: 'turn/end', data: { turn, reason: { kind } } })
}

const OUTCOMES = new Set(['in_progress', 'completed', 'canceled', 'aborted', 'failed'])
const FAILURE_REASONS = new Set(['cards_unclosed', 'delivery_unknown', 'engine_incomplete', 'transport_failure', 'local_refusal'])
const END_KINDS = new Set(['committed', 'abandoned'])
const SETTLEMENTS = new Set(['assistant_message', 'assistant_attempt'])
const USER_STATES = new Set(['waiting_new_request', 'receiving_no_output', 'live_card', 'multi_text', 'static_final', 'missing_scope', 'rate_limited', 'unknown_delivery', 'failed', 'completed'])
const CATEGORIES = new Set(['scope_denied', 'card_identity', 'rate_limited', 'http_error', 'network_unknown', 'no_id', 'shape_mismatch', 'budget_exceeded', 'malformed', 'stale_generation'])
const EVENT_KINDS = new Set(['start', 'delta_accepted', 'delta_rejected', 'create_ok', 'create_fail', 'ref_ok', 'ref_fail', 'put_ok', 'put_fail', 'close_ok', 'close_fail', 'static_ok', 'static_fail', 'final', 'live_end', 'turn_end', 'dispose', 'reload'])

function assertSchemaShape(diag, label) {
  assert.equal(diag.schemaVersion, 1, label + ': schemaVersion')
  assert.ok(Number.isInteger(diag.generation) && diag.generation >= 0, label + ': generation')
  assert.ok(['card', 'text'].includes(diag.configuredMode), label + ': configuredMode')
  const perm = diag.permissions.cardkitWrite
  assert.ok(['unknown', 'granted', 'denied'].includes(perm.grant), label + ': grant')
  assert.ok(perm.source === 'scope_read' || perm.source === null, label + ': source')
  assert.ok(['never', 'in_flight', 'ok', 'failed'].includes(perm.queryState), label + ': queryState')
  assert.ok(perm.failedCategory === null || ['network', 'timeout', 'http_error', 'malformed'].includes(perm.failedCategory), label + ': failedCategory enum')
  assert.equal(typeof perm.stale, 'boolean', label + ': stale')
  assert.equal(diag.cardkit.requiredScope, 'cardkit:card:write', label + ': requiredScope')
  assert.ok(['unknown', 'denied', 'observed_success'].includes(diag.cardkit.state), label + ': cardkit.state')
  if (diag.cardkit.lastFailure) {
    const f = diag.cardkit.lastFailure
    assert.ok(CATEGORIES.has(f.category), label + ': lastFailure category enum: ' + f.category)
    assert.ok(f.httpStatus === null || Number.isInteger(f.httpStatus), label + ': lastFailure httpStatus')
    assert.ok(f.apiCode === null || Number.isInteger(f.apiCode), label + ': lastFailure apiCode')
  }
  assert.ok(['pending', 'live_card', 'static_interactive', 'text', 'failed'].includes(diag.stream.observedMode), label + ': observedMode')
  if (diag.userState !== undefined) assert.ok(USER_STATES.has(diag.userState), label + ': userState enum: ' + diag.userState)
  if (diag.turn) {
    assert.ok(Number.isInteger(diag.turn.turnId) && diag.turn.turnId >= 0, label + ': turnId non-negative int')
    assert.ok(OUTCOMES.has(diag.turn.outcome), label + ': outcome enum')
    // 新增解释字段：固定枚举/数值/布尔，无自由字符串
    assert.ok(diag.turn.failureReason === null || FAILURE_REASONS.has(diag.turn.failureReason), label + ': failureReason enum: ' + diag.turn.failureReason)
    assert.ok(diag.turn.endKind === null || END_KINDS.has(diag.turn.endKind), label + ': endKind enum')
    assert.ok(diag.turn.settlementType === null || SETTLEMENTS.has(diag.turn.settlementType), label + ': settlementType enum')
    assert.ok(diag.turn.interrupted === null || typeof diag.turn.interrupted === 'boolean', label + ': interrupted null|bool')
    const c = diag.turn.completion
    assert.ok(c && ['pendingTasks', 'pendingOps', 'enginesPending', 'cardsOpened', 'cardsClosed', 'incompleteSteps'].every((k) => Number.isInteger(c[k]) && c[k] >= 0), label + ': completion snapshot shape')
    if (diag.turn.delivery) {
      const dv = diag.turn.delivery
      assert.ok(dv.targetSource === null || ['final', 'delta'].includes(dv.targetSource), label + ': delivery.targetSource enum')
      for (const k of ['targetLength', 'publishedLength', 'sentLength']) assert.ok(dv[k] === null || (Number.isInteger(dv[k]) && dv[k] >= 0), label + ': delivery.' + k)
      for (const k of ['exactTargetMatch', 'delivered', 'failed', 'unknown', 'authoritative', 'cancelled', 'outputBlocked']) assert.ok(typeof dv[k] === 'boolean', label + ': delivery.' + k + ' bool')
    }
    for (const k of ['firstPutDispatchMs', 'lastPutDispatchMs']) assert.ok(diag.turn.timings[k] === null || (Number.isInteger(diag.turn.timings[k]) && diag.turn.timings[k] >= 0), label + ': timings.' + k)
    for (const k of ['putDispatchedBeforeFinal', 'putDispatchedBeforeTurnEnd']) assert.ok(Number.isInteger(diag.turn.counts[k]) && diag.turn.counts[k] >= 0, label + ': counts.' + k)
    assert.ok(diag.turn.events.length <= 16, label + ': events bounded')
    for (const e of diag.turn.events) assert.ok(EVENT_KINDS.has(e.kind), label + ': event kind enum: ' + e.kind)
  }
  assert.ok(diag.recentTurns.length <= 8, label + ': recentTurns bounded')
  // 出口不得携带任何自由字符串：全部字段为枚举/数值/null/布尔。
  const json = JSON.stringify(diag)
  assert.ok(!/Bearer |open-apis\/|https?:/.test(json), label + ': no tokens/URLs in diagnostics')
  return json
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  await plugin.apply(ctx)
  await tick()

  // ── 场景0：禁用态也有 diagnostics（UI 旧安装兼容不适用，字段齐备）──────────
  {
    const { lark, diag } = await readDiagnostics()
    assertSchemaShape(diag, 'disabled')
    assert.equal(lark.state, 'disabled', 'lark starts disabled')
    assert.equal(diag.userState, undefined, 'no userState when channel not running')
    assert.equal(diag.permissions.cardkitWrite.queryState, 'never', 'no scope query before enable')
  }

  // ── 启用 lark（card 模式）→ 每代一次异步 scope 查询 ────────────────────────
  const config = readConfig()
  config.adapters.lark = Object.assign({}, config.adapters.lark, {
    enabled: true,
    mode: 'long-connection',
    appId: 'cli_int_diag',
    appSecret: 'diag-secret',
    interactiveCard: true,
  })
  await saveConfig(config)
  await wait(80) // scope read（token + GET）异步落地

  // ── 场景1：scope 查询 granted + operations.scope_read + status GET 零网络 ──
  {
    const { diag } = await readDiagnostics()
    assertSchemaShape(diag, 'enabled')
    assert.equal(diag.permissions.cardkitWrite.grant, 'granted', 'grant granted from scope_read')
    assert.equal(diag.permissions.cardkitWrite.queryState, 'ok', 'queryState ok')
    assert.equal(diag.permissions.cardkitWrite.source, 'scope_read', 'source scope_read')
    assert.ok(diag.permissions.cardkitWrite.checkedAt > 0, 'checkedAt recorded')
    assert.equal(diag.operations.scope_read.succeeded, 1, 'scope_read counted')
    assert.equal(diag.operations.scope_read.state, 'observed_success', 'scope_read observed_success')
    // 图片三项：真实查询成功但组成员未列出 → unknown（不以未返回判 denied）
    assert.equal(diag.images.permissions.upload.grant, 'unknown', 'im 成员未列出 → upload unknown（非 denied）')
    assert.equal(diag.images.permissions.download.grant, 'unknown', 'im 成员未列出 → download unknown')
    assert.equal(diag.images.permissions.groupHistory.grant, 'unknown', 'groupHistory 独立 unknown')
    assert.equal(diag.images.permissions.upload.source, 'scope_read', '图片三项 source=scope_read')
    assert.ok(diag.images.permissions.upload.checkedAt > 0, '图片三项 checkedAt 已记录')
    assert.equal(diag.images.available, false, 'available=接线可用（未接图片 false）')
    // P1：dedup status 来自真实接线 seam（渠道 running 已 warm-open 真盘 store）
    await wait(250)
    const dd1 = (await readDiagnostics()).diag.dedup
    assert.equal(dd1.available, true, 'dedup.available 来自真实打开的 store（非初始化真值）')
    assert.equal(dd1.lockMode, 'flock', '本机真实 flock lease')
    assert.deepEqual(dd1.capacity, { sendReceipts: 2000, source: 'default' }, '真实 reader 透出容量+来源（默认 default）')
    assert.equal(dd1.poisoned, false, '新 store 非 poisoned')
    assert.equal(dd1.reopen, 'none')
    // status GET 不得触发任何外网请求
    const before = shellCalls.length
    for (let i = 0; i < 5; i += 1) await invoke('GET', '/__dsh-messaging/status')
    assert.equal(shellCalls.length, before, 'status GET must not trigger network')
  }

  // ── 场景2：刷新 API 契约（单飞 + 5s 限频 + granted→denied→缺scope→失败保留）─
  {
    // 限频：立即二次刷新 → rate_limited（不打网络）
    const first = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(first.status, 200, 'refresh route responds 200')
    assert.equal(typeof first.json.ok, 'boolean', 'refresh has ok')
    assert.equal(typeof first.json.refreshed, 'boolean', 'refresh has refreshed')
    assert.ok(Number.isInteger(first.json.generation), 'refresh has generation')
    assert.ok(first.json.permissions && typeof first.json.permissions.grant === 'string', 'refresh has permissions.grant')
    const second = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(second.json.ok, false, 'second immediate refresh rejected')
    assert.equal(second.json.error, 'rate_limited', 'rate_limited contract string')
    // grant=2 → denied
    scopeListBody = JSON.stringify({ code: 0, msg: 'success', data: { scopes: [{ scope_name: 'cardkit:card:write', grant_status: 2 }] } })
    await wait(5100)
    const denied = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(denied.json.ok, true, 'forced refresh ok')
    assert.equal(denied.json.permissions.grant, 'denied', 'grant denied from grant_status=2')
    // 缺 scope（完整枚举）→ unknown，不是 denied
    scopeListBody = JSON.stringify({ code: 0, msg: 'success', data: { scopes: [{ scope_name: 'other:scope', grant_status: 1 }] } })
    await wait(5100)
    const missing = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(missing.json.permissions.grant, 'unknown', 'missing scope → unknown (not denied)')
    assert.equal(missing.json.permissions.queryState, 'ok', 'complete enumeration is ok')
    // 图片 OR 组真查询路径：upload 任一成员 status1 → granted；download 部分列出
    // 不构成充分拒绝 → unknown；groupHistory 不从 download 外推。
    scopeListBody = JSON.stringify({ code: 0, msg: 'success', data: { scopes: [
      { scope_name: 'cardkit:card:write', grant_status: 1 },
      { scope_name: 'im:resource:upload', grant_status: 1 },
      { scope_name: 'im:message', grant_status: 2 },
    ] } })
    await wait(5100)
    const imgStep = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(imgStep.json.ok, true, '图片 OR 组刷新 ok')
    const idg = (await readDiagnostics()).diag.images.permissions
    assert.equal(idg.upload.grant, 'granted', 'upload OR 任一 status1 → granted（真实查询）')
    assert.equal(idg.download.grant, 'unknown', 'download 部分列出（仅 im:message status2，其余未列出）→ 不充分拒绝 = unknown')
    assert.equal(idg.groupHistory.grant, 'unknown', 'groupHistory 未列出 → unknown（不从 download 外推）')
    // 分页（官方未定义，防御处理）：两页找到 scope
    scopePagesByToken = {
      main: JSON.stringify({ code: 0, msg: 'ok', data: { scopes: [{ scope_name: 'x:y', grant_status: 1 }], has_more: true, page_token: 'p2' } }),
      p2: JSON.stringify({ code: 0, msg: 'ok', data: { scopes: [{ scope_name: 'cardkit:card:write', grant_status: 1 }] } }),
    }
    await wait(5100)
    const paged = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(paged.json.permissions.grant, 'granted', 'pagination handled: scope found on page 2')
    scopePagesByToken = null
    // 查询失败：保留旧 grant/checkedAt + queryState failed + 分类；操作证据不受影响
    scopeListBody = JSON.stringify({ code: 212100, msg: 'app not install', data: {} })
    await wait(5100)
    const failed = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(failed.json.ok, false, 'failed query ok=false')
    const { diag } = await readDiagnostics()
    const perm = diag.permissions.cardkitWrite
    assert.equal(perm.queryState, 'failed', 'queryState failed')
    assert.equal(perm.failedCategory, 'http_error', 'failedCategory http_error')
    assert.equal(perm.grant, 'granted', 'previous grant retained on failure')
    assert.ok(perm.checkedAt > 0, 'previous checkedAt retained on failure')
    // A/6：查询失败对新三权限可见——即使旧 checkedAt 未到 TTL 也强制 stale。
    const imgPerm = diag.images.permissions
    assert.equal(imgPerm.upload.stale, true, '查询失败 → images.upload stale=true（旧 granted 不装 fresh）')
    assert.equal(imgPerm.download.stale, true, '查询失败 → images.download stale=true')
    assert.equal(imgPerm.groupHistory.stale, true, '查询失败 → images.groupHistory stale=true')
    assert.equal(imgPerm.upload.grant, 'unknown', '失败不回写新 grant（保留旧证据+stale 标记）')
    assert.equal(diag.operations.scope_read.failed, 1, 'scope_read failure counted')
    scopeListBody = JSON.stringify({ code: 0, msg: 'success', data: { scopes: [{ scope_name: 'cardkit:card:write', grant_status: 1 }] } })
    await wait(5100)
    await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' }) // 恢复 granted
  }

  // ── 场景3：官方形状缺权（turn1）：denied + 静态 interactive 兜底 + 无 text ──
  const agentA = await larkInbound('oc_diag_1', 'denial turn')
  const mark3 = wire.length
  failBody = JSON.stringify({
    code: 99991672,
    msg: 'Access denied. One of the following scopes is required: [cardkit:card:write].',
  })
  failNext = (entry) => entry.method === 'POST' && entry.url.includes('/cardkit/v1/cards')
  frameStart(agentA, { attemptId: 'att-d1', revision: 1, turn: 1, step: 0 })
  frameChunk(agentA, { attemptId: 'att-d1', revision: 2, index: 0, text: '缺权实时文本' })
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assertSchemaShape(diag, 'denied-live')
    assert.equal(diag.operations.card_create.state, 'denied', 'card_create denied')
    assert.equal(diag.operations.card_create.lastCategory, 'scope_denied', 'category scope_denied')
    assert.equal(diag.operations.card_create.lastApiCode, 99991672, 'apiCode retained (numeric only)')
    assert.equal(diag.operations.card_reference.attempted, 0, 'reference never attempted after denied create')
    assert.equal(diag.cardkit.state, 'denied', 'cardkit denied')
    assert.ok(!diag.cardkit.operationsVerified.includes('card_create'), 'create not verified')
    assert.equal(diag.userState, 'missing_scope', 'userState missing_scope during denial turn')
    assert.equal(diag.turn.staticFinal.used, false, 'static fallback not yet')
    assert.equal(diag.stream.observedMode, 'failed', 'no output yet after denied create (failure evidence)')
    assert.ok(diag.stream.engineAccepted.textDelta >= 1, 'accepted textDelta counted')
  }
  finalMessage(agentA, 1, 0, '缺权实时文本。结尾。')
  await wait(THROTTLE_WAIT)
  turnEnd(agentA, 1, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { lark, diag } = await readDiagnostics()
    assertSchemaShape(diag, 'denied-final')
    const section = wire.slice(mark3)
    assert.equal(creates(section).length, 1, 'exactly one create attempt (no blind retry)')
    assert.equal(textMsgs(section).length, 0, 'NO automatic plain-text fallback')
    assert.ok(interactiveMsgs(section).length >= 1, 'static fallback is interactive')
    assert.equal(diag.turn.staticFinal.used, true, 'static fallback recorded')
    assert.equal(diag.turn.staticFinal.reason, 'permission_denied', 'reason permission_denied (evidence-based)')
    assert.equal(diag.stream.finalStatic.lastReason, 'permission_denied', 'stream-level reason')
    assert.equal(diag.turn.outcome, 'completed', 'turn completed via real final+turnEnd (no card opened)')
    assert.equal(diag.userState, 'completed', 'userState completed')
    assert.equal(lark.inboundCount, 1, 'one inbound')
    assert.equal(lark.outboundCount, 1, 'one static outbound')
  }

  // ── 场景4：三批 live（turn2）：final 前 PUT、close、firstDeliveryAckMs ──────
  const agentB = await larkInbound('oc_diag_2', 'live turn')
  const mark4 = wire.length
  frameStart(agentB, { attemptId: 'att-l2', revision: 1, turn: 2, step: 0 })
  frameChunk(agentB, { attemptId: 'att-l2', revision: 2, index: 0, text: 'Hello, ' })
  await wait(THROTTLE_WAIT)
  frameChunk(agentB, { attemptId: 'att-l2', revision: 3, index: 1, text: '世界 ' })
  await wait(THROTTLE_WAIT)
  frameChunk(agentB, { attemptId: 'att-l2', revision: 4, index: 2, text: 'emoji😀' })
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assertSchemaShape(diag, 'live-mid')
    assert.equal(diag.operations.card_create.state, 'observed_success', 'create verified (newer success restores evidence)')
    assert.equal(diag.operations.card_reference.state, 'observed_success', 'reference verified')
    assert.ok(diag.operations.card_put.succeeded >= 2, 'at least two PUTs succeeded, got ' + diag.operations.card_put.succeeded)
    assert.equal(diag.cardkit.state, 'observed_success', 'cardkit state restored by newer success')
    assert.ok(diag.cardkit.operationsVerified.includes('card_create') && diag.cardkit.operationsVerified.includes('card_put'), 'verified ops listed')
    assert.equal(diag.userState, 'live_card', 'userState live_card')
    assert.equal(diag.stream.observedMode, 'live_card', 'observedMode live_card')
    assert.ok(typeof diag.turn.timings.firstDeliveryAckMs === 'number' && diag.turn.timings.firstDeliveryAckMs >= 0, 'firstDeliveryAckMs numeric')
    assert.equal(diag.turn.counts.putBeforeFinal, diag.turn.counts.putTotal, 'all PUTs so far before final')
    assert.ok(diag.turn.counts.putBeforeFinal >= 2, 'putBeforeFinal >= 2')
  }
  finalMessage(agentB, 2, 0, 'Hello, 世界 emoji😀')
  await wait(THROTTLE_WAIT)
  turnEnd(agentB, 2, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assertSchemaShape(diag, 'live-final')
    const section = wire.slice(mark4)
    assert.equal(creates(section).length, 1, 'one card entity')
    assert.equal(settingsPatches(section).length, 1, 'one close')
    assert.ok(interactiveMsgs(section).length >= 1, 'reference is interactive')
    assert.equal(diag.turn.outcome, 'completed', 'completed via real close callback')
    assert.equal(diag.turn.staticFinal.used, false, 'no static fallback in live turn')
    assert.equal(diag.turn.timings.terminalCloseMs !== null, true, 'terminal close timestamp')
    const all = section.concat([])
    assert.ok(textMsgs(all).length === 0, 'no text messages in card mode')
    assert.equal(diag.userState, 'completed', 'completed after close')
  }

  // ── 场景5：非流式静态出站（无 live 帧）：static_interactive 计数、无 turn 污染 ──
  {
    const before = (await readDiagnostics()).diag.operations.static_interactive.succeeded
    const send = await invoke('POST', '/__dsh-messaging/send', { body: JSON.stringify({ channel: 'lark', conversation: 'lark:oc_diag_1', text: '手动静态卡' }) })
    assert.equal(send.json.ok, true, 'manual static send ok')
    const { diag } = await readDiagnostics()
    assert.ok(diag.operations.static_interactive.succeeded >= before + 1, 'static_interactive counted')
    assert.equal(diag.turn.counts.acceptedTextDelta, 3, 'manual send does not pollute turn counters')
    assert.ok(diag.stream.finalStatic.count === 1, 'static fallback count unchanged by manual send')
  }

  // ── 场景6：unknown 投递（turn3 create 超时）：deliveryUnknown + delivery_unknown ──
  const agentC = await larkInbound('oc_diag_3', 'timeout turn')
  timeoutNext = (entry) => entry.method === 'POST' && entry.url.includes('/cardkit/v1/cards')
  frameStart(agentC, { attemptId: 'att-t3', revision: 1, turn: 3, step: 0 })
  frameChunk(agentC, { attemptId: 'att-t3', revision: 2, index: 0, text: '未知投递' })
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.operations.card_create.state, 'unknown', 'unknown state for no-response create')
    assert.equal(diag.operations.card_create.deliveryUnknown, 1, 'deliveryUnknown counted')
    assert.equal(diag.operations.card_create.lastCategory, 'network_unknown', 'category network_unknown')
    assert.equal(diag.userState, 'unknown_delivery', 'userState unknown_delivery')
  }
  finalMessage(agentC, 3, 0, '未知投递。收尾。')
  await wait(THROTTLE_WAIT)
  turnEnd(agentC, 3, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    // unknown 投递按引擎契约禁止一切重发/兑底：final 补试也被闸，static 兑底不发生；
    // 未知分支**不得假 completed**：终局记 failed，userState 显示 unknown_delivery。
    assert.equal(diag.turn.staticFinal.used, false, 'unknown delivery blocks fallback (engine no-resend contract)')
    assert.equal(diag.turn.outcome, 'failed', 'unknown delivery turn ends failed (never fake completed)')
    assert.equal(diag.userState, 'unknown_delivery', 'userState stays unknown_delivery after unknown turn')
  }

  // ── 场景7：恶意错误文本（turn4）：数值/枚举落库，秘密不落库 ─────────────────
  const agentD = await larkInbound('oc_diag_4', 'malicious turn')
  failBody = JSON.stringify({
    code: 99991672, // 无白名单 scope 证据：不得判 scope_denied（不依赖数字 code 唯一判据）
    msg: 'Access denied. Contact Bearer sk-LEAKSECRET123 at https://open.feishu.cn/app/cli_LEAKID/auth for om_LEAKMSG',
  })
  failNext = (entry) => entry.method === 'POST' && entry.url.includes('/cardkit/v1/cards')
  frameStart(agentD, { attemptId: 'att-m4', revision: 1, turn: 4, step: 0 })
  frameChunk(agentD, { attemptId: 'att-m4', revision: 2, index: 0, text: '恶意错误' })
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    const json = assertSchemaShape(diag, 'malicious')
    assert.ok(!json.includes('sk-LEAKSECRET123'), 'no secret in diagnostics')
    assert.ok(!json.includes('cli_LEAKID'), 'no app id in diagnostics')
    assert.ok(!json.includes('om_LEAKMSG'), 'no message id in diagnostics')
    assert.equal(diag.operations.card_create.state, 'failed', '99991672 without scope evidence → failed (not denied)')
    assert.equal(diag.operations.card_create.lastCategory, 'http_error', 'category http_error')
    assert.notEqual(diag.userState, 'missing_scope', 'not mislabeled missing_scope')
  }
  finalMessage(agentD, 4, 0, '恶意错误。收尾。')
  await wait(THROTTLE_WAIT)
  turnEnd(agentD, 4, 'completed')
  await wait(THROTTLE_WAIT)

  // ── 场景8：并发两个 Agent 回合隔离（turn5/turn6）────────────────────────────
  const agentE = await larkInbound('oc_diag_5', 'parallel A')
  const agentF = await larkInbound('oc_diag_6', 'parallel B')
  frameStart(agentE, { attemptId: 'att-p5', revision: 1, turn: 5, step: 0 })
  frameStart(agentF, { attemptId: 'att-p6', revision: 2, turn: 6, step: 0 })
  frameChunk(agentE, { attemptId: 'att-p5', revision: 3, index: 0, text: '并行一' })
  frameChunk(agentF, { attemptId: 'att-p6', revision: 4, index: 0, text: '并行二' })
  await wait(THROTTLE_WAIT)
  frameChunk(agentE, { attemptId: 'att-p5', revision: 5, index: 1, text: '续' })
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    // 最近活跃回合 = turn5（最后被 touch）；其计数只含自己的两批，不串 turn6。
    assert.equal(diag.turn.counts.acceptedTextDelta, 2, 'parallel turn isolation: latest turn counts only own deltas')
    finalMessage(agentE, 5, 0, '并行一续。')
    finalMessage(agentF, 6, 0, '并行二。')
    await wait(THROTTLE_WAIT)
    turnEnd(agentE, 5, 'completed')
    turnEnd(agentF, 6, 'completed')
    await wait(THROTTLE_WAIT)
  }

  // ── 场景9：reload 代际隔离：旧代在途 create 迟到成功不污染新代 ─────────────
  {
    const held = deferredWire()
    holdNext = { match: (entry) => entry.method === 'POST' && entry.url.includes('/cardkit/v1/cards'), deferred: held }
    const agentG = await larkInbound('oc_diag_7', 'reload race')
    frameStart(agentG, { attemptId: 'att-r7', revision: 1, turn: 7, step: 0 })
    frameChunk(agentG, { attemptId: 'att-r7', revision: 2, index: 0, text: '重载竞态' })
    await wait(THROTTLE_WAIT) // create 已派发并被挂起
    const reload = await invoke('POST', '/__dsh-messaging/reload')
    assert.equal(reload.status, 200, 'reload ok')
    held.resolve() // 旧代 create 迟到成功（引用消息+cleanup close 都会在新代 wire 出现）
    await wait(THROTTLE_WAIT)
    await wait(THROTTLE_WAIT)
    const { diag } = await readDiagnostics()
    assert.ok(diag.generation >= 2, 'generation bumped by reload')
    assert.equal(diag.operations.card_create.attempted, 0, 'new generation has zero create attempts (old-gen settled in own store)')
    assert.equal(diag.operations.card_close.attempted, 0, 'late old-gen cleanup close must not settle in new generation')
    assert.equal(diag.stream.engineAccepted.textDelta, 0, 'new generation stream counters fresh')
  }

  // ── 场景10：text 模式（turn8）：text_send 计数、multi_text、firstDeliveryAckMs null 判定 ──
  {
    const cfg = readConfig()
    cfg.adapters.lark = Object.assign({}, cfg.adapters.lark, { interactiveCard: false })
    await saveConfig(cfg) // rebuild → 新代
    await wait(50)
    const agentH = await larkInbound('oc_diag_8', 'text mode turn')
    frameStart(agentH, { attemptId: 'att-x8', revision: 1, turn: 8, step: 0 })
    frameChunk(agentH, { attemptId: 'att-x8', revision: 2, index: 0, text: '文本模式一' })
    await wait(THROTTLE_WAIT)
    frameChunk(agentH, { attemptId: 'att-x8', revision: 3, index: 1, text: '文本模式二' })
    await wait(THROTTLE_WAIT)
    {
      const { diag } = await readDiagnostics()
      assertSchemaShape(diag, 'text-mode')
      assert.equal(diag.configuredMode, 'text', 'configuredMode text')
      assert.ok(diag.operations.text_send.succeeded >= 1, 'text_send counted')
      assert.equal(diag.userState, 'multi_text', 'userState multi_text')
      assert.equal(diag.stream.observedMode, 'text', 'observedMode text')
      assert.ok(typeof diag.turn.timings.firstDeliveryAckMs === 'number', 'firstDeliveryAckMs from text ACK')
    }
    finalMessage(agentH, 8, 0, '文本模式一文本模式二。收尾。')
    await wait(THROTTLE_WAIT)
    turnEnd(agentH, 8, 'completed')
    await wait(THROTTLE_WAIT)
    {
      const { diag } = await readDiagnostics()
      assert.equal(diag.turn.outcome, 'completed', 'text turn completed')
      assert.equal(diag.operations.card_create.attempted, 0, 'no card ops in text mode')
      // 非流式静态（无 delta）→ firstDeliveryAckMs 必须为 null，不与流式同名混用
      assert.ok(typeof diag.turn.timings.firstAcceptedTextDeltaMs === 'number', 'accepted delta timing present for stream turn')
    }
  }

  // ══ 场景11（P2⑥）：reload 在途的旧代 scope 刷新响应必须回 stale，不冒充新代 ══
  {
    const preStatus = await invoke('GET', '/__dsh-messaging/status')
    const preEpoch = preStatus.json.instanceEpoch
    const preGen = (await readDiagnostics()).diag.generation
    const held = deferredWire()
    holdNext = { match: (entry) => entry.url.includes('/application/v6/scopes'), deferred: held }
    const refreshP = invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    await wait(30) // 刷新的 scope GET 已派发并挂起
    const reload = await invoke('POST', '/__dsh-messaging/reload')
    assert.equal(reload.status, 200, 'reload ok')
    held.resolve()
    const resp = await refreshP
    assert.equal(resp.status, 200, 'refresh responds 200')
    assert.equal(resp.json.ok, false, 'stale response must not claim ok')
    assert.equal(resp.json.refreshed, false, 'stale response must not claim refreshed')
    assert.equal(resp.json.error, 'stale_generation', 'fixed stale_generation error')
    assert.equal(resp.json.generation, preGen, 'generation is the captured (old) one, not the new gen')
    assert.equal(resp.json.instanceEpoch, preEpoch, 'stale 响应携带捕获的（同实例）instanceEpoch')
    const postStatus = await invoke('GET', '/__dsh-messaging/status')
    assert.equal(postStatus.json.instanceEpoch, preEpoch, '同实例 reload：instanceEpoch 不变（不靠数值升降推断重启）')
    await wait(80) // 新代自动 scope 查询落地
  }

  // 回到 card 模式（后续多卡/悬挂回归需要）
  {
    const cfg = readConfig()
    cfg.adapters.lark = Object.assign({}, cfg.adapters.lark, { interactiveCard: true })
    await saveConfig(cfg)
    await wait(80)
  }

  // ══ 场景12（P1①）：多卡 rollover + 悬挂终态 close —— 3开/2收不得 completed ══
  const agentR = await larkInbound('oc_diag_9', 'rollover turn')
  frameStart(agentR, { attemptId: 'att-rl9', revision: 1, turn: 20, step: 0 })
  frameChunk(agentR, { attemptId: 'att-rl9', revision: 2, index: 0, text: '第一批正文' })
  await wait(THROTTLE_WAIT)
  fakeClock.advance(9.5 * 60 * 1000) // 触发到期滚动：close 旧卡 + 开新卡
  frameChunk(agentR, { attemptId: 'att-rl9', revision: 3, index: 1, text: '第二批正文' })
  await wait(THROTTLE_WAIT)
  fakeClock.advance(9.5 * 60 * 1000)
  frameChunk(agentR, { attemptId: 'att-rl9', revision: 4, index: 2, text: '第三批正文' })
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.ok(diag.operations.card_create.succeeded >= 3, 'three cards opened (rollover), got ' + diag.operations.card_create.succeeded)
    assert.ok(diag.operations.card_close.succeeded >= 2, 'two rollover closes done, got ' + diag.operations.card_close.succeeded)
  }
  const holdFinalClose = deferredWire()
  holdNext = { match: (entry) => entry.method === 'PATCH' && entry.url.includes('/settings'), deferred: holdFinalClose }
  finalMessage(agentR, 20, 0, '第一批正文第二批正文第三批正文。结尾。')
  await wait(THROTTLE_WAIT)
  turnEnd(agentR, 20, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    const stableId = diag.turn.turnId
    assert.equal(diag.turn.outcome, 'in_progress', '3 opened / 2 closed must NOT be completed while final close is in flight')
    assert.ok(diag.turn.counts.acceptedTextDelta > 0, 'identity kept (same turn record, counts intact)')
    holdFinalClose.resolve()
    await wait(THROTTLE_WAIT)
    const after = (await readDiagnostics()).diag
    assert.equal(after.turn.turnId, stableId, 'turn identity stable across pending close (no re-birth)')
    assert.equal(after.turn.outcome, 'completed', 'completed only after the final card close ACK')
    assert.ok(after.turn.timings.terminalCloseMs !== null, 'terminal close timestamp recorded')
    assert.ok(after.turn.counts.acceptedTextDelta >= 3, 'final/end records not lost when close resolves late')
  }

  // ══ 场景13/14（P1①）：静态在途不可完成 + 迟到重复 final 不复活 ══════════
  const agentS = await larkInbound('oc_diag_10', 'static pending turn')
  const holdStatic = deferredWire()
  holdNext = { match: (entry) => entry.method === 'POST' && entry.url.includes('/im/v1/messages'), deferred: holdStatic }
  finalMessage(agentS, 21, 0, '非流式最终文本')
  await wait(THROTTLE_WAIT)
  turnEnd(agentS, 21, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'in_progress', 'static POST未 ACK 不得 completed')
    assert.equal(diag.userState, 'static_final', 'userState static_final while static send in flight')
    assert.equal(diag.turn.staticFinal.used, true, 'static fallback recorded')
    holdStatic.resolve()
    await wait(THROTTLE_WAIT)
    const after = (await readDiagnostics()).diag
    assert.equal(after.turn.outcome, 'completed', 'completed after real static ACK')
    const stableId = after.turn.turnId
    // 重复迟到 final（引擎去重、无新输出）：不复活、不换身份
    finalMessage(agentS, 21, 0, '非流式最终文本')
    turnEnd(agentS, 21, 'completed')
    await wait(THROTTLE_WAIT)
    const replay = (await readDiagnostics()).diag
    assert.equal(replay.turn.turnId, stableId, 'late duplicate final keeps identity (no re-birth)')
    assert.equal(replay.turn.outcome, 'completed', 'completed identity not revived to in_progress')
    assert.equal(replay.userState, 'completed', 'userState stays completed')
  }

  // ══ 场景15（P1②）：交错旧 PUT 晚 ACK 不得覆盖较新 deny；新代成功才恢复 ════
  const agentX = await larkInbound('oc_diag_11', 'held put turn')
  const agentY = await larkInbound('oc_diag_12', 'deny turn')
  const heldPut = deferredWire()
  holdNext = { match: (entry) => entry.method === 'PUT' && entry.url.includes('/elements/'), deferred: heldPut }
  frameStart(agentX, { attemptId: 'att-wx', revision: 1, turn: 30, step: 0 })
  frameChunk(agentX, { attemptId: 'att-wx', revision: 2, index: 0, text: '旧请求正文' })
  await wait(THROTTLE_WAIT) // 旧 PUT 已派发并挂起
  failBody = JSON.stringify({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [cardkit:card:write]' })
  failNext = (entry) => entry.method === 'POST' && entry.url.includes('/cardkit/v1/cards')
  frameStart(agentY, { attemptId: 'att-wy', revision: 3, turn: 31, step: 0 })
  frameChunk(agentY, { attemptId: 'att-wy', revision: 4, index: 0, text: '较新拒绝' })
  await wait(THROTTLE_WAIT) // 较新 create 已被 deny
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.cardkit.state, 'denied', 'newer denied evidence wins')
  }
  heldPut.resolve() // 较旧 PUT 晚到成功 ACK
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.operations.card_put.state, 'observed_success', 'old PUT success recorded in its own bucket')
    assert.equal(diag.cardkit.state, 'denied', 'older late success must NOT overwrite newer denial (dispatch-order watermark)')
  }
  const agentZ = await larkInbound('oc_diag_13', 'recover turn')
  frameStart(agentZ, { attemptId: 'att-wz', revision: 5, turn: 32, step: 0 })
  frameChunk(agentZ, { attemptId: 'att-wz', revision: 6, index: 0, text: '恢复成功' })
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.cardkit.state, 'observed_success', 'genuinely newer success recovers evidence')
    // 收尾各回合，避免悬挂影响后续场景
    finalMessage(agentX, 30, 0, '旧请求正文。')
    turnEnd(agentX, 30, 'completed')
    finalMessage(agentY, 31, 0, '较新拒绝。')
    turnEnd(agentY, 31, 'completed')
    finalMessage(agentZ, 32, 0, '恢复成功。')
    turnEnd(agentZ, 32, 'completed')
    await wait(THROTTLE_WAIT)
  }

  // ══ 场景16（P2④）：拒绝帧归属实际 Agent/回合，不猜最近 B ═══════════════
  const agentP = await larkInbound('oc_diag_14', 'reject P')
  const agentQ = await larkInbound('oc_diag_15', 'reject Q')
  frameStart(agentP, { attemptId: 'att-pg', revision: 1, turn: 40, step: 0 })
  frameStart(agentQ, { attemptId: 'att-qg', revision: 2, turn: 41, step: 0 })
  frameChunk(agentP, { attemptId: 'att-pg', revision: 3, index: 0, text: 'P 批一' })
  frameChunk(agentQ, { attemptId: 'att-qg', revision: 4, index: 0, text: 'Q 批一' })
  await wait(THROTTLE_WAIT)
  const rejBefore = (await readDiagnostics()).diag.stream.engineRejected.denseIndexGap
  frameChunk(agentP, { attemptId: 'att-pg', revision: 5, index: 3, text: 'P 跳号帧' }) // denseIndexGap
  await wait(THROTTLE_WAIT)
  {
    const diagQ = (await readDiagnostics()).diag
    assert.equal(diagQ.stream.engineRejected.denseIndexGap, rejBefore + 1, 'global reject counted')
    // 把 Q 置为 latest：其事件流不得含 delta_rejected
    frameChunk(agentQ, { attemptId: 'att-qg', revision: 6, index: 1, text: 'Q 批二' })
    await wait(THROTTLE_WAIT)
    const diagQ2 = (await readDiagnostics()).diag
    assert.ok(!diagQ2.turn.events.some((e) => e.kind === 'delta_rejected'), 'B(Q) turn must NOT receive the rejected event')
    // 把 P 置为 latest：其事件流必须含 delta_rejected（归属正确）
    frameChunk(agentP, { attemptId: 'att-pg', revision: 7, index: 1, text: 'P 批二' })
    await wait(THROTTLE_WAIT)
    const diagP = (await readDiagnostics()).diag
    assert.ok(diagP.turn.events.some((e) => e.kind === 'delta_rejected'), 'rejected frame attributed to its own turn (P)')
    finalMessage(agentP, 40, 0, 'P 批一批二。')
    turnEnd(agentP, 40, 'completed')
    finalMessage(agentQ, 41, 0, 'Q 批一批二。')
    turnEnd(agentQ, 41, 'completed')
    await wait(THROTTLE_WAIT)
  }

  // ══ 场景17（P2⑦）：纯本地拒绝不伪造 API attempted、零 wire ════════════
  {
    const before = await readDiagnostics()
    const wireBefore = wire.length
    const send = await invoke('POST', '/__dsh-messaging/send', {
      body: JSON.stringify({ channel: 'lark', conversation: 'lark:oc_diag_1', text: 'A\ud800' }),
    })
    assert.equal(send.json.ok, false, 'local malformed refusal returns ok:false')
    const after = await readDiagnostics()
    assert.equal(wire.length, wireBefore, 'local refusal must not dispatch any network request')
    assert.equal(after.diag.operations.static_interactive.attempted, before.diag.operations.static_interactive.attempted,
      'local refusal must NOT count as static_interactive attempted')
    assert.equal(after.diag.operations.text_send.attempted, before.diag.operations.text_send.attempted,
      'local refusal must NOT count as text_send attempted')
    assert.ok(after.diag.stream.localRefusals.count >= before.diag.stream.localRefusals.count + 1, 'local refusal counted separately')
    assert.equal(after.diag.stream.localRefusals.lastCategory, 'malformed', 'local refusal category malformed')
  }

  // ══ 场景18（复验P1）：紧邻 final/end（同一同步批次）+ token 在途：不得提前 completed ══
  {
    // 冷 token：重建 runtime（新代）确保静态出站必须先取 auth，才能真实挂住 token await。
    const cfg = readConfig()
    cfg.adapters.lark = Object.assign({}, cfg.adapters.lark, { interactiveCard: true })
    await saveConfig(cfg)
    await wait(80)
  }
  const agentV = await larkInbound('oc_diag_16', 'adjacent final end')
  const heldAuth = deferredWire()
  holdNext = { match: (entry) => entry.url.includes('/tenant_access_token/internal'), deferred: heldAuth }
  finalMessage(agentV, 50, 0, '紧邻终局文本')
  turnEnd(agentV, 50, 'completed') // 与 final 同步批次，无任何等待
  await wait(120)
  {
    const { diag } = await readDiagnostics()
    assert.notEqual(diag.turn.outcome, 'completed', 'final/end 紧邻且 token 在途：不得提前 completed')
    assert.equal(diag.turn.staticFinal.used, true, 'static fallback already recorded')
    assert.equal(diag.userState, 'static_final', 'userState static_final while token/static in flight')
    heldAuth.resolve()
    await wait(THROTTLE_WAIT)
    const after = (await readDiagnostics()).diag
    assert.equal(after.turn.outcome, 'completed', 'completed only after static ACK + engine finish')
    assert.equal(after.stream.observedMode, 'static_interactive', '完成后不允许 mode pending')
    assert.equal(after.turn.staticFinal.used, true, 'staticUsed true at completion')
  }

  // ══ 场景19（复验P1）：部分文本尾段确定失败 → 不得 completed ══════════════
  {
    const cfg = readConfig()
    cfg.adapters.lark = Object.assign({}, cfg.adapters.lark, { interactiveCard: false })
    await saveConfig(cfg) // text 模式（新代）
    await wait(150) // 等渠道回到 running（否则 status 不输出 userState）
    const longTail = '汉'.repeat(5000) // 4096 + 904 分段
    const agentW = await larkInbound('oc_diag_17', 'partial tail failure')
    const markW = wire.length
    failWhileBody = JSON.stringify({ code: 999, msg: 'tail boom' })
    failWhile = (entry) => {
      if (!entry.url.includes('/im/v1/messages')) return false
      try { return JSON.parse(bodyOf(entry).content).text.length === 904 } catch { return false }
    }
    finalMessage(agentW, 51, 0, longTail)
    await wait(THROTTLE_WAIT)
    turnEnd(agentW, 51, 'completed')
    await wait(THROTTLE_WAIT)
    await wait(THROTTLE_WAIT)
    failWhile = null
    failWhileBody = null
    {
      const { diag } = await readDiagnostics()
      const attempts = textMsgs(wire.slice(markW)).map((m) => JSON.parse(bodyOf(m).content).text.length)
      assert.deepEqual(attempts, [4096, 904, 904], '首段成功 + 尾段两次有限补试失败，got ' + JSON.stringify(attempts))
      assert.notEqual(diag.turn.outcome, 'completed', '尾文未送达不得 completed')
      assert.equal(diag.turn.outcome, 'failed', '确定失败终局 failed')
      // 频道因 outbound 失败进入 error 态时，status 按原设计隐藏 userState（回落
      // channel.state）；出现时必须是 failed 而非 completed/unknown 混淆。
      assert.ok(diag.userState === undefined || diag.userState === 'failed',
        'userState hidden-by-error or failed, got ' + diag.userState)
    }
  }

  // ══ 场景23（复验P1）：同 turn 不同 step —— step0 尾文失败不得被 step1 成功覆盖 ══
  {
    const agentX1 = await larkInbound('oc_diag_22x', 'cross step turn')
    const markX = wire.length
    failWhileBody = JSON.stringify({ code: 999, msg: 'tail boom' })
    failWhile = (entry) => {
      if (!entry.url.includes('/im/v1/messages')) return false
      try { return JSON.parse(bodyOf(entry).content).text.length === 904 } catch { return false }
    }
    frameStart(agentX1, { attemptId: 'att-x0', revision: 1, turn: 60, step: 0 })
    frameChunk(agentX1, { attemptId: 'att-x0', revision: 2, index: 0, text: 'A'.repeat(5000) })
    await wait(THROTTLE_WAIT) // 首段 4096 成功、尾 904 确定失败
    finalMessage(agentX1, 60, 0, 'A'.repeat(5000)) // 有限补试仍失败
    await wait(THROTTLE_WAIT)
    frameEnd(agentX1, { attemptId: 'att-x0', revision: 3, index: 1, committed: true })
    await wait(THROTTLE_WAIT)
    failWhile = null
    failWhileBody = null
    frameStart(agentX1, { attemptId: 'att-x1', revision: 4, turn: 60, step: 1 })
    frameChunk(agentX1, { attemptId: 'att-x1', revision: 5, index: 0, text: 'B' })
    await wait(THROTTLE_WAIT)
    finalMessage(agentX1, 60, 1, 'B')
    await wait(THROTTLE_WAIT)
    turnEnd(agentX1, 60, 'completed')
    await wait(THROTTLE_WAIT)
    const { diag } = await readDiagnostics()
    const lens = textMsgs(wire.slice(markX)).map((m) => JSON.parse(bodyOf(m).content).text.length)
    assert.deepEqual(lens, [4096, 904, 904, 1], 'step0 [4096,904,904] + step1 [1]，got ' + JSON.stringify(lens))
    assert.notEqual(diag.turn.outcome, 'completed', 'step0 已提交尾文未送达，step1 成功不得覆盖')
    assert.equal(diag.turn.outcome, 'failed', '按 step 归集：任一已提交 step 失败 → 整轮 failed')
  }

  // ══ 场景24（复验P1正例）：同 step 先失败后补齐 → completed（失败不永久 sticky）══
  {
    const agentY1 = await larkInbound('oc_diag_24', 'same step recovery')
    const markY = wire.length
    failBody = JSON.stringify({ code: 999, msg: 'tail boom' })
    failNext = (entry) => {
      if (!entry.url.includes('/im/v1/messages')) return false
      try { return JSON.parse(bodyOf(entry).content).text.length === 904 } catch { return false }
    }
    frameStart(agentY1, { attemptId: 'att-y0', revision: 1, turn: 61, step: 0 })
    frameChunk(agentY1, { attemptId: 'att-y0', revision: 2, index: 0, text: 'C'.repeat(5000) })
    await wait(THROTTLE_WAIT) // 4096 成功 + 904 一次性失败
    finalMessage(agentY1, 61, 0, 'C'.repeat(5000)) // 显式补试：失败已消耗 → 补齐
    await wait(THROTTLE_WAIT)
    turnEnd(agentY1, 61, 'completed')
    await wait(THROTTLE_WAIT)
    const { diag } = await readDiagnostics()
    const lens = textMsgs(wire.slice(markY)).map((m) => JSON.parse(bodyOf(m).content).text.length)
    assert.deepEqual(lens, [4096, 904, 904], '首段 + 失败尾段 + 补齐尾段，got ' + JSON.stringify(lens))
    assert.equal(diag.turn.outcome, 'completed', '同 step 真正补齐 → completed（不永久 sticky 失败）')
    // 频道曾因一次性失败进入 error 态时 status 隐藏 userState；出现时必须 completed。
    assert.ok(diag.userState === undefined || diag.userState === 'completed',
      'userState hidden-by-error or completed, got ' + diag.userState)
  }

  // 回到 card 模式（后续场景需要；新代）
  {
    const cfg = readConfig()
    cfg.adapters.lark = Object.assign({}, cfg.adapters.lark, { interactiveCard: true })
    await saveConfig(cfg)
    await wait(80)
  }

  // ══ 场景20（复验P1）：expiry close curl28 + final/end → 失败终态，不永久 in_progress ══
  const agentU = await larkInbound('oc_diag_18', 'expiry close unknown')
  frameStart(agentU, { attemptId: 'att-eu', revision: 1, turn: 52, step: 0 })
  frameChunk(agentU, { attemptId: 'att-eu', revision: 2, index: 0, text: '到期卡正文' })
  await wait(THROTTLE_WAIT)
  timeoutNext = (entry) => entry.method === 'PATCH' && entry.url.includes('/settings')
  fakeClock.advance(9.5 * 60 * 1000) // 到期收尾：close 返回式超时（unknown）
  await wait(THROTTLE_WAIT)
  finalMessage(agentU, 52, 0, '到期卡正文。收尾。')
  await wait(THROTTLE_WAIT)
  turnEnd(agentU, 52, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.operations.card_close.deliveryUnknown, 1, 'expiry close unknown recorded')
    assert.equal(diag.turn.outcome, 'failed', '已无在途且无法确认关闭：失败终态，不永久 in_progress')
    assert.equal(diag.userState, 'unknown_delivery', 'userState unknown_delivery')
    assert.equal(diag.turn.timings.terminalCloseMs, null, '失败/未知关闭不展示成功终态 ACK')
  }

  // ══ 场景21（复验P2）：terminalCloseMs 属于最后一张卡的 close ACK ══════════
  const agentT3 = await larkInbound('oc_diag_19', 'two card close time')
  frameStart(agentT3, { attemptId: 'att-tc', revision: 1, turn: 53, step: 0 })
  frameChunk(agentT3, { attemptId: 'att-tc', revision: 2, index: 0, text: '卡一正文' })
  await wait(THROTTLE_WAIT)
  fakeClock.advance(9.5 * 60 * 1000)
  frameChunk(agentT3, { attemptId: 'att-tc', revision: 3, index: 1, text: '卡二正文' })
  await wait(THROTTLE_WAIT)
  finalMessage(agentT3, 53, 0, '卡一正文卡二正文。结尾。')
  await wait(THROTTLE_WAIT)
  turnEnd(agentT3, 53, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'completed', 'two-card turn completed')
    const closeEvents = diag.turn.events.filter((e) => e.kind === 'close_ok')
    assert.equal(closeEvents.length, 2, '两张卡各自 close_ok，got ' + closeEvents.length)
    const terminalAbs = diag.turn.startedAt + diag.turn.timings.terminalCloseMs
    assert.equal(terminalAbs, closeEvents[closeEvents.length - 1].atMs, 'terminalCloseMs 属于最后一张卡的 close ACK')
    assert.notEqual(terminalAbs, closeEvents[0].atMs, '不得取首张 rollover close 的 ACK')
  }

  // ══ 场景22（复验P2）：历史压缩 + 结算水位防复活 + dispose 终局压缩 ══════
  const agentT = await larkInbound('oc_diag_20', 'history watermark')
  for (let turn = 60; turn <= 75; turn += 1) {
    finalMessage(agentT, turn, 0, '历史回合 ' + turn)
    await wait(40)
    turnEnd(agentT, turn, 'completed')
    await wait(40)
  }
  {
    const before = (await readDiagnostics()).diag
    const beforeId = before.turn.turnId
    assert.equal(before.turn.outcome, 'completed', 'loop turn completed')
    assert.ok(before.recentTurns.length <= 8, '终态历史有界')
    // 重放最老已淘汰的 final（turn60）：不得复活/新建身份（结算水位）
    finalMessage(agentT, 60, 0, '历史回合 60')
    turnEnd(agentT, 60, 'completed')
    await wait(THROTTLE_WAIT)
    const after = (await readDiagnostics()).diag
    assert.equal(after.turn.turnId, beforeId, '淘汰后旧 final 不复活、不换身份')
    assert.equal(after.turn.outcome, 'completed', '当前身份保持终态')
  }
  {
    // 40 个真实在途（未终局）身份必须保留；Agent dispose 后终局并压缩
    const agentT2 = await larkInbound('oc_diag_21', 'forty open')
    for (let turn = 80; turn <= 119; turn += 1) {
      frameStart(agentT2, { attemptId: 'att-o' + turn, revision: turn - 78, turn, step: 0 })
    }
    await wait(THROTTLE_WAIT)
    const open = (await readDiagnostics()).diag
    assert.equal(open.turn.outcome, 'in_progress', '真实在途身份保留（不强制逐出）')
    emit('agent/disposed', { agent: agentT2 })
    await wait(THROTTLE_WAIT)
    const disposed = (await readDiagnostics()).diag
    assert.notEqual(disposed.turn.outcome, 'in_progress', 'dispose 后不留悬挂 in_progress')
    assert.ok(disposed.recentTurns.length <= 8, 'dispose 后终态压缩有界')
    // 已结算水位：dispose 后重放旧 final 不复活
    finalMessage(agentT2, 80, 0, '重放旧回合')
    await wait(THROTTLE_WAIT)
    const replay = (await readDiagnostics()).diag
    assert.notEqual(replay.turn.outcome, 'in_progress', '水位拒绝已结算旧身份复活')
  }

  // ══ 场景25（复验P2）：首 close 成功 + 末 close 失败 → terminalCloseMs 必须 null ══
  const agentC7 = await larkInbound('oc_diag_25', 'close combo turn')
  frameStart(agentC7, { attemptId: 'att-c7', revision: 1, turn: 70, step: 0 })
  frameChunk(agentC7, { attemptId: 'att-c7', revision: 2, index: 0, text: '第一卡正文' })
  await wait(THROTTLE_WAIT) // card1 opened
  fakeClock.advance(9.5 * 60 * 1000) // close1 成功（rollover）
  frameChunk(agentC7, { attemptId: 'att-c7', revision: 3, index: 1, text: '第二卡正文' })
  await wait(THROTTLE_WAIT) // card2 opened → 旧 ACK 失去终态资格
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.timings.terminalCloseMs, null, '新卡待收：旧 rollover 成功 ACK 不得展示为终态时间')
    assert.equal(diag.turn.events.filter((e) => e.kind === 'close_ok').length, 1, '首个 rollover close 成功仅事件表达')
  }
  failBody = JSON.stringify({ code: 999, msg: 'close boom' })
  failNext = (entry) => entry.method === 'PATCH' && entry.url.includes('/settings')
  finalMessage(agentC7, 70, 0, '第一卡正文第二卡正文。结尾。')
  await wait(THROTTLE_WAIT)
  turnEnd(agentC7, 70, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'failed', '末 close 确定失败 → failed 终态')
    assert.equal(diag.turn.timings.terminalCloseMs, null, '失败终态不得展示任何旧成功 ACK 时间')
    assert.equal(diag.turn.events.filter((e) => e.kind === 'close_fail').length, 1, 'close 失败有事件')
  }

  // ══ 场景26（复验P2白盒）：直接真实 stream 模块 —— 取消/throw 遥测恰好一次配对 ══
  {
    const { createLarkStream } = await import(pathToFileURL(path.join(root, 'lib', 'lark-stream.js')).href)
    const mkStream = (evts, overrides = {}) => createLarkStream(Object.assign({
      agentId: 'a1', sessionId: 's1', mode: 'text',
      sendTextDelta: async () => {}, updateCardText: async () => {}, finishCard: async () => {},
      throttleMs: 5,
      telemetry: (kind, detail) => evts.push({ kind, detail }),
    }, overrides))
    const count = (evts, kind) => evts.filter((e) => e.kind === kind).length
    // (a) 排队正文 + 立即 dispose：非 final 任务被跳过，仍恰好一次 settled；
    //     未开正文 attempt 由 finish（已排队）结算，opened/finished 配对。
    {
      const evts = []
      const s = mkStream(evts)
      s.handleStart({ type: 'start', attemptId: 'x1', revision: 1, turn: 1, step: 0 })
      s.handleChunk({ type: 'chunk', attemptId: 'x1', revision: 2, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: 'hello' } })
      s.endTurn({ turn: 1 }) // 同步入队 flush+finish（尚未微任务执行）
      s.dispose()
      await s.idle()
      assert.equal(count(evts, 'task_settled'), count(evts, 'task_enqueued'), '每任务恰好一次 settled（dispose 跳过不双计）')
      assert.equal(count(evts, 'attempt_finished'), count(evts, 'attempt_opened'), 'attempt opened/finished 配对（含取消）')
    }
    // (b) 仅 start 后 dispose（未开正文、无排队收尾）：非权威 finished 配对一次。
    {
      const evts = []
      const s = mkStream(evts)
      s.handleStart({ type: 'start', attemptId: 'x2', revision: 1, turn: 1, step: 0 })
      s.dispose()
      await s.idle()
      assert.equal(count(evts, 'attempt_finished'), 1, '未开正文取消补一次非权威 finished')
      assert.equal(count(evts, 'task_settled'), count(evts, 'task_enqueued'), '无任务时 0/0 平衡')
    }
    // (c) 回调 throw + telemetry 同步 throw：业务照常发起，遥测抛错不影响链路。
    {
      let sends = 0
      const evts = []
      const s = mkStream(evts, {
        sendTextDelta: async () => { sends += 1; throw new Error('cb boom') },
        telemetry: () => { throw new Error('telemetry boom') },
        onError: () => {},
      })
      s.handleStart({ type: 'start', attemptId: 'x3', revision: 1, turn: 1, step: 0 })
      s.handleChunk({ type: 'chunk', attemptId: 'x3', revision: 2, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: 'go' } })
      s.flushTurn()
      await s.idle()
      assert.equal(sends, 1, 'telemetry 抛错不影响正文发起')
      s.dispose()
      await s.idle()
    }
  }

  // ══ 场景29（实机同形竞态回归）：final→committed end→turnEnd 零 await 连发，
  // reference 挂起 + close 再挂：close ACK 前必须 in_progress，不许提前 failed ══
  const agentR1 = await larkInbound('oc_diag_29a', 'sync race turn')
  const heldRef = deferredWire()
  holdNext = {
    match: (entry) => entry.method === 'POST' && entry.url.includes('/im/v1/messages')
      && (() => { try { const c = JSON.parse(bodyOf(entry).content); return c.type === 'card' } catch { return false } })(),
    deferred: heldRef,
  }
  frameStart(agentR1, { attemptId: 'att-sr', revision: 1, turn: 600, step: 0 })
  frameChunk(agentR1, { attemptId: 'att-sr', revision: 2, index: 0, text: '竞态实时正文' })
  await wait(THROTTLE_WAIT) // create 已 ACK，reference 已派发并挂起
  const heldClose = deferredWire()
  holdNext = { match: (entry) => entry.method === 'PATCH' && entry.url.includes('/settings'), deferred: heldClose }
  // 同一同步批次：final → committed end → turnEnd（零 await，不 sleep 掩盖）
  finalMessage(agentR1, 600, 0, '竞态实时正文。结尾。')
  frameEnd(agentR1, { attemptId: 'att-sr', revision: 3, index: 1, committed: true })
  turnEnd(agentR1, 600, 'completed')
  await wait(120) // reference 仍在途
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'in_progress', 'reference 在途：终局不得提前结算')
    assert.equal(diag.turn.failureReason, null, '进行中 failureReason=null')
    assert.ok(diag.turn.completion.pendingTasks >= 1, 'finish/close 任务在队：pendingTasks>=1')
    assert.equal(diag.turn.delivery, null, 'attempt 未结算前 delivery=null')
  }
  heldRef.resolve()
  await wait(THROTTLE_WAIT) // ref ACK → final PUT → finish → close 派发并挂起
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'in_progress', 'close ACK 前：仍在途')
    assert.equal(diag.turn.failureReason, null, 'close 在途不判失败')
    assert.ok(diag.turn.completion.pendingOps >= 1 || diag.turn.completion.pendingTasks >= 1, 'close 在途计数可见')
    assert.equal(diag.turn.completion.cardsClosed, 0, '本回合 close 尚未 ACK（终局快照口径）')
  }
  heldClose.resolve()
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assertSchemaShape(diag, 'sync-race-final')
    assert.equal(diag.turn.outcome, 'completed', 'close ACK 后 completed（修复前此形必 failed）')
    assert.equal(diag.turn.failureReason, null, 'completed 无失败原因')
    assert.equal(diag.turn.endKind, 'committed', 'endKind=committed')
    assert.equal(diag.turn.settlementType, 'assistant_message', 'settlementType=assistant_message')
    assert.equal(diag.turn.interrupted, null, '缺 message 布尔 → null（真实语义，不由 completed 结束原因伪造 false）')
    assert.equal(diag.turn.delivery && diag.turn.delivery.delivered, true, 'delivery 视图 delivered=true')
    assert.equal(diag.turn.delivery && diag.turn.delivery.exactTargetMatch, true, 'exactTargetMatch')
    assert.equal(diag.turn.delivery && diag.turn.delivery.targetSource, 'final', 'targetSource=final')
    assert.equal(diag.turn.counts.putDispatchedBeforeFinal, 0, '本形 PUT 派发在 final 后（派发计数与 ACK 分离）')
    assert.ok(diag.turn.timings.firstPutDispatchMs !== null && diag.turn.timings.firstPutDispatchMs > diag.turn.timings.finalReceivedMs, 'firstPutDispatchMs 晚于 final（真实派发时刻）')
    assert.equal(diag.turn.completion.pendingTasks, 0, '终态冻结快照：队列已清')
    assert.equal(diag.turn.completion.cardsOpened, 1, '终态冻结快照：cardsOpened=1')
    assert.equal(diag.turn.completion.cardsClosed, 1, '终态冻结快照：cardsClosed=1')
  }

  // ── 场景29B：生成期真实 PUT（派发早于 final，与 ACK/派发字段互证）──────
  const agentR2 = await larkInbound('oc_diag_29b', 'midgen put turn')
  frameStart(agentR2, { attemptId: 'att-mp', revision: 1, turn: 601, step: 0 })
  frameChunk(agentR2, { attemptId: 'att-mp', revision: 2, index: 0, text: '首批正文' })
  await wait(THROTTLE_WAIT) // create+ref 完成
  frameChunk(agentR2, { attemptId: 'att-mp', revision: 3, index: 1, text: '追加正文' })
  await wait(THROTTLE_WAIT) // 生成期 PUT 派发+ACK
  finalMessage(agentR2, 601, 0, '首批正文追加正文。尾。')
  frameEnd(agentR2, { attemptId: 'att-mp', revision: 4, index: 2, committed: true })
  turnEnd(agentR2, 601, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'completed', 'mid-gen PUT turn completed')
    assert.ok(diag.turn.counts.putDispatchedBeforeFinal >= 1, '派发在 final 前：putDispatchedBeforeFinal>=1')
    assert.ok(diag.turn.counts.putBeforeFinal >= 1, 'ACK 在 final 前：putBeforeFinal>=1')
    assert.ok(diag.turn.timings.firstPutDispatchMs < diag.turn.timings.finalReceivedMs, '派发时刻早于 final（与 ACK 字段分离）')
    assert.ok(diag.turn.timings.firstPutDispatchMs <= diag.turn.timings.firstPutSuccessMs, '派发不晚于其 ACK')
  }

  // ── 场景29C/D：close 确定失败/未知 → failed + failureReason 分类 ──────────
  const agentR3 = await larkInbound('oc_diag_29c', 'close fail turn')
  failBody = JSON.stringify({ code: 999, msg: 'close boom' })
  failNext = (entry) => entry.method === 'PATCH' && entry.url.includes('/settings')
  frameStart(agentR3, { attemptId: 'att-cf', revision: 1, turn: 602, step: 0 })
  frameChunk(agentR3, { attemptId: 'att-cf', revision: 2, index: 0, text: '收尾失败正文' })
  await wait(THROTTLE_WAIT)
  finalMessage(agentR3, 602, 0, '收尾失败正文。尾。')
  frameEnd(agentR3, { attemptId: 'att-cf', revision: 3, index: 1, committed: true })
  turnEnd(agentR3, 602, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'failed', 'close 确定失败 → failed')
    assert.equal(diag.turn.failureReason, 'transport_failure', 'failureReason=transport_failure')
    assert.equal(diag.turn.completion.cardsOpened, 1, '冻结快照 cardsOpened=1')
    assert.equal(diag.turn.completion.cardsClosed, 0, '冻结快照 cardsClosed=0')
    assert.equal(diag.turn.timings.terminalCloseMs, null, '失败无终态 ACK 时间')
  }
  const agentR4 = await larkInbound('oc_diag_29d', 'close unknown turn')
  timeoutNext = (entry) => entry.method === 'PATCH' && entry.url.includes('/settings')
  frameStart(agentR4, { attemptId: 'att-cu', revision: 1, turn: 603, step: 0 })
  frameChunk(agentR4, { attemptId: 'att-cu', revision: 2, index: 0, text: '收尾未知正文' })
  await wait(THROTTLE_WAIT)
  finalMessage(agentR4, 603, 0, '收尾未知正文。尾。')
  frameEnd(agentR4, { attemptId: 'att-cu', revision: 3, index: 1, committed: true })
  turnEnd(agentR4, 603, 'completed')
  await wait(THROTTLE_WAIT)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'failed', 'close 未知 → failed')
    assert.equal(diag.turn.failureReason, 'delivery_unknown', 'failureReason=delivery_unknown')
    assert.equal(diag.turn.timings.terminalCloseMs, null, '未知关闭无终态 ACK 时间')
  }

  // ── 场景29E：close 已入队后 Agent dispose → 幂等终局，后续回合计数不受污染 ──
  const agentR5 = await larkInbound('oc_diag_29e', 'dispose close turn')
  const heldClose2 = deferredWire()
  holdNext = { match: (entry) => entry.method === 'PATCH' && entry.url.includes('/settings'), deferred: heldClose2 }
  frameStart(agentR5, { attemptId: 'att-dc', revision: 1, turn: 604, step: 0 })
  frameChunk(agentR5, { attemptId: 'att-dc', revision: 2, index: 0, text: 'dispose 前正文' })
  await wait(THROTTLE_WAIT)
  finalMessage(agentR5, 604, 0, 'dispose 前正文。尾。')
  frameEnd(agentR5, { attemptId: 'att-dc', revision: 3, index: 1, committed: true })
  turnEnd(agentR5, 604, 'completed')
  await wait(120) // finish 已入队且 close 已派发挂起
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'in_progress', 'close 挂起时仍 in_progress')
  }
  emit('agent/disposed', { agent: agentR5 })
  await wait(80)
  {
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'aborted', 'dispose 幂等终局 aborted（不卡住）')
    assert.equal(diag.turn.failureReason, null, 'aborted 无 failureReason')
  }
  heldClose2.resolve() // 迟到 close ACK：不得复活/改写终态
  await wait(THROTTLE_WAIT)
  {
    const after = (await readDiagnostics()).diag
    assert.equal(after.turn.outcome, 'aborted', '迟到 close ACK 不改写终态')
  }
  {
    // 后续新回合仍能正常完成（任务/attempt 计数未被 dispose 污染）
    const agentR6 = await larkInbound('oc_diag_29f', 'after dispose turn')
    frameStart(agentR6, { attemptId: 'att-ad', revision: 1, turn: 605, step: 0 })
    frameChunk(agentR6, { attemptId: 'att-ad', revision: 2, index: 0, text: '恢复后正文' })
    await wait(THROTTLE_WAIT)
    finalMessage(agentR6, 605, 0, '恢复后正文。尾。')
    frameEnd(agentR6, { attemptId: 'att-ad', revision: 3, index: 1, committed: true })
    turnEnd(agentR6, 605, 'completed')
    await wait(THROTTLE_WAIT)
    const { diag } = await readDiagnostics()
    assert.equal(diag.turn.outcome, 'completed', 'dispose 后新回合正常 completed（配对未污染）')
    assert.equal(diag.turn.failureReason, null, '正常回合无失败原因')
  }

  // ── 场景29F–I：interrupted 严格布尔语义（仅 final/message 域，不从 turnEnd 猜）──
  {
    // F 真实宿主形状：message interrupted:true → committed end → turnEnd aborted → 保留 true
    const agentI1 = await larkInbound('oc_diag_29g', 'interrupted msg')
    frameStart(agentI1, { attemptId: 'att-in1', revision: 1, turn: 606, step: 0 })
    frameChunk(agentI1, { attemptId: 'att-in1', revision: 2, index: 0, text: '中断消息正文' })
    await wait(THROTTLE_WAIT)
    finalMessage(agentI1, 606, 0, '中断消息正文。尾。', { interrupted: true })
    frameEnd(agentI1, { attemptId: 'att-in1', revision: 3, index: 1, committed: true })
    turnEnd(agentI1, 606, 'aborted')
    await wait(THROTTLE_WAIT)
    const dF = (await readDiagnostics()).diag
    assert.equal(dF.turn.outcome, 'aborted', 'host 形状：turnEnd aborted → outcome aborted')
    assert.equal(dF.turn.interrupted, true, 'message interrupted:true 不被 aborted 结束原因覆盖')
    // G 显式 false + completed → false
    const agentI2 = await larkInbound('oc_diag_29h', 'explicit false msg')
    frameStart(agentI2, { attemptId: 'att-in2', revision: 1, turn: 607, step: 0 })
    frameChunk(agentI2, { attemptId: 'att-in2', revision: 2, index: 0, text: '显式false正文' })
    await wait(THROTTLE_WAIT)
    finalMessage(agentI2, 607, 0, '显式false正文。尾。', { interrupted: false })
    frameEnd(agentI2, { attemptId: 'att-in2', revision: 3, index: 1, committed: true })
    turnEnd(agentI2, 607, 'completed')
    await wait(THROTTLE_WAIT)
    const dG = (await readDiagnostics()).diag
    assert.equal(dG.turn.outcome, 'completed', 'explicit false turn completed')
    assert.equal(dG.turn.interrupted, false, '明确 false 才 false')
    // H 缺字段 + completed → null（不伪造 false）
    const agentI3 = await larkInbound('oc_diag_29i', 'missing flag msg')
    frameStart(agentI3, { attemptId: 'att-in3', revision: 1, turn: 608, step: 0 })
    frameChunk(agentI3, { attemptId: 'att-in3', revision: 2, index: 0, text: '缺字段正文' })
    await wait(THROTTLE_WAIT)
    finalMessage(agentI3, 608, 0, '缺字段正文。尾。')
    frameEnd(agentI3, { attemptId: 'att-in3', revision: 3, index: 1, committed: true })
    turnEnd(agentI3, 608, 'completed')
    await wait(THROTTLE_WAIT)
    const dH = (await readDiagnostics()).diag
    assert.equal(dH.turn.outcome, 'completed', 'missing flag turn completed')
    assert.strictEqual(dH.turn.interrupted, null, '缺字段 → null（非法/缺失不转布尔）')
    // I 非法字符串拒绝：null 且不序列化原文
    const agentI4 = await larkInbound('oc_diag_29j', 'malicious flag msg')
    frameStart(agentI4, { attemptId: 'att-in4', revision: 1, turn: 609, step: 0 })
    frameChunk(agentI4, { attemptId: 'att-in4', revision: 2, index: 0, text: '非法字段正文' })
    await wait(THROTTLE_WAIT)
    finalMessage(agentI4, 609, 0, '非法字段正文。尾。', { interrupted: 'INTERRUPTED_LEAK_XYZ' })
    frameEnd(agentI4, { attemptId: 'att-in4', revision: 3, index: 1, committed: true })
    turnEnd(agentI4, 609, 'completed')
    await wait(THROTTLE_WAIT)
    const dI = (await readDiagnostics()).diag
    assert.strictEqual(dI.turn.interrupted, null, '非法字符串 → null（不透传、不转布尔）')
    assert.ok(!JSON.stringify(dI.turn).includes('INTERRUPTED_LEAK_XYZ'), '非法值不序列化原文')
  }

  // ══ 场景27（实例身份 instanceEpoch）：同实例 reload 不变；重新 apply 必不同 ══
  {
    const { createLarkInstanceEpoch } = await import(pathToFileURL(path.join(root, 'lib', 'lark-diagnostics.js')).href)
    const st1 = await invoke('GET', '/__dsh-messaging/status')
    const epoch1 = st1.json.instanceEpoch
    assert.ok(Number.isSafeInteger(epoch1) && epoch1 >= 0, 'instanceEpoch 为非负安全整数')
    const reload1 = await invoke('POST', '/__dsh-messaging/reload')
    assert.equal(reload1.status, 200, 'reload ok')
    assert.equal(reload1.json.instanceEpoch, epoch1, '同实例 reload：instanceEpoch 保持不变')
    const refresh1 = await invoke('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(refresh1.json.instanceEpoch, epoch1, '刷新响应携带捕获的 instanceEpoch（成功/失败一致）')
    // 生成器确定性（固定词源，避免偶然相等断言）
    assert.equal(createLarkInstanceEpoch(() => [1, 2, 3]), createLarkInstanceEpoch(() => [1, 2, 3]), '固定词源 → 确定值')
    assert.notEqual(createLarkInstanceEpoch(() => [1, 2, 3]), createLarkInstanceEpoch(() => [1, 2, 4]), '词源不同 → 值不同')
    const maxV = createLarkInstanceEpoch(() => [0xffff, 0xffff, 0xffff])
    assert.ok(Number.isSafeInteger(maxV) && maxV >= 0 && maxV < 2 ** 48, '48-bit 上界且安全整数')
    // 重新 apply（新实例）：epoch 不同；新实例内 reload 仍不变（旧客户端可忽略加法字段）
    const routes2 = new Map()
    const ctx2 = Object.assign({}, ctx, {
      on() { return () => {} },
      effect(fn) { return fn() },
      webServer: {
        register(route) {
          if (routes2.has(route.path)) throw new Error('dup ' + route.path)
          routes2.set(route.path, route.handler)
          return () => routes2.delete(route.path)
        },
      },
    })
    await plugin.apply(ctx2)
    await tick()
    const inv2 = (method, p, opts = {}) => invoke(method, p, Object.assign({ routesMap: routes2 }, opts))
    const st2 = await inv2('GET', '/__dsh-messaging/status')
    const epoch2 = st2.json.instanceEpoch
    assert.ok(Number.isSafeInteger(epoch2) && epoch2 >= 0, '第二实例 epoch 合法')
    assert.notEqual(epoch2, epoch1, '重新 apply → 新实例不同 instanceEpoch')
    const reload2 = await inv2('POST', '/__dsh-messaging/reload')
    assert.equal(reload2.json.instanceEpoch, epoch2, '第二实例内 reload 不变')
  }

  // ══ 场景28（随机源故障边界）：熵源异常不得阻断 apply；instanceEpoch=null 明确未知 ══
  {
    const { createLarkInstanceEpoch } = await import(pathToFileURL(path.join(root, 'lib', 'lark-diagnostics.js')).href)
    // (a) 生成器 total：词源 throw / 坏形状 / NaN → null，绝不抛出
    assert.equal(createLarkInstanceEpoch(() => { throw new Error('entropy boom') }), null, '词源 throw → null')
    assert.equal(createLarkInstanceEpoch(() => [NaN, 1, 2]), null, 'NaN 词源 → null')
    assert.equal(createLarkInstanceEpoch(() => [1, 2]), null, '词源不足 → null')
    // (b) 真实 apply 故障注入：WebCrypto getRandomValues 同步 throw（短窗口内注入，finally 恢复）
    const { webcrypto } = await import('node:crypto')
    const originalRandom = webcrypto.getRandomValues
    const makeCtxWith = (routesMap) => Object.assign({}, ctx, {
      on() { return () => {} },
      effect(fn) { return fn() },
      webServer: {
        register(route) {
          if (routesMap.has(route.path)) throw new Error('dup ' + route.path)
          routesMap.set(route.path, route.handler)
          return () => routesMap.delete(route.path)
        },
      },
    })
    const routes3 = new Map()
    const ctx3 = makeCtxWith(routes3)
    let applyRejected = false
    webcrypto.getRandomValues = () => { throw new Error('injected entropy failure') }
    try {
      await plugin.apply(ctx3)
    } catch {
      applyRejected = true
    } finally {
      webcrypto.getRandomValues = originalRandom
    }
    assert.equal(applyRejected, false, '随机源故障不得 reject apply（诊断纯观察，不破坏启动）')
    const inv3 = (method, p, opts = {}) => invoke(method, p, Object.assign({ routesMap: routes3 }, opts))
    const st3 = await inv3('GET', '/__dsh-messaging/status')
    assert.equal(st3.status, 200, 'status 路由已注册且 200（既有消息能力入口保持）')
    assert.equal(st3.json.instanceEpoch, null, 'instanceEpoch=null 明确未知身份（不冒用 generation/Date.now）')
    const raw3 = JSON.stringify(st3.json)
    assert.ok(!raw3.includes('injected entropy failure') && !raw3.includes('getRandomValues') && !raw3.includes('at Object'),
      '不回显原异常/堆栈/secret')
    const rf3 = await inv3('POST', '/__dsh-messaging/diagnostics/refresh-scope', { body: '{}' })
    assert.equal(rf3.json.instanceEpoch, null, 'refresh 响应带捕获的 null（成功/失败一致）')
    assert.equal(typeof rf3.json.ok, 'boolean', '刷新业务字段在 epoch=null 时仍可用')
    // (c) 恢复熵源后新 apply → 合法 epoch；典型非诊断出站仍正常
    const routes4 = new Map()
    await plugin.apply(makeCtxWith(routes4))
    await tick()
    const st4 = await invoke('GET', '/__dsh-messaging/status', { routesMap: routes4 })
    assert.ok(Number.isSafeInteger(st4.json.instanceEpoch) && st4.json.instanceEpoch >= 0,
      '恢复熵源后新 apply 获合法 48-bit epoch')
    const send = await invoke('POST', '/__dsh-messaging/send', { body: JSON.stringify({ channel: 'lark', conversation: 'lark:oc_diag_28', text: '故障边界出站' }) })
    assert.equal(send.json.ok, true, '随机源故障不影响典型非诊断出站')
  }

  // ── P1 reload 显式重开：close/drain → rebuild 后 start 重新 open 真盘 ────
  {
    const before = (await readDiagnostics()).diag.dedup
    assert.equal(before.available, true, 'reload 前 store 打开')
    const reload = await invoke('POST', '/__dsh-messaging/reload')
    assert.equal(reload.status, 200, 'reload 200')
    await wait(500)
    const after = (await readDiagnostics()).diag.dedup
    assert.equal(after.available, true, '显式 reload 重开后 available 恢复（不清账本）')
    assert.equal(after.lockMode, 'flock', '重开仍为真实 flock')
    assert.ok(after.counts.journalLines >= before.counts.journalLines, '账本连续（不清空，行数单调）')
  }

  // ── status 增量契约（冻结 v1）：channels.lark.diagnostics.dedup / images ────
  {
    const dg = await import(pathToFileURL(path.join(root, 'lib', 'lark-diagnostics.js')).href)
    const { createLarkDiagnostics, normalizeLarkDedupStatus, deriveImageScopeGrants, LARK_IMAGE_SCOPE_GROUPS, LARK_IMAGE_GROUP_HISTORY_SCOPE, LARK_SEND_RECEIPT_CAPACITY_DEFAULT } = dg
    const d = createLarkDiagnostics('contract')
    // 未接线默认：available:false + 零计数 + 容量默认 2000 + reopen none
    const s0 = d.serialize({ configuredMode: 'card', running: false, now: Date.now() })
    assert.equal(s0.dedup.schemaVersion, 1)
    assert.equal(s0.dedup.available, false)
    assert.equal(s0.dedup.poisoned, false)
    assert.equal(s0.dedup.lockMode, null)
    assert.deepEqual(s0.dedup.capacity, { sendReceipts: null, source: null }, '未接线容量=null/null（不伪造 2000，UI 隐藏）')
    assert.equal(s0.dedup.counts, null, 'available=false → counts:null（UI 隐藏；可用时才出 counts.*）')
    // 图片：未接线 available:false + 三操作桶（证据域）与三权限项（权限域）分离
    assert.equal(s0.images.schemaVersion, 1)
    assert.equal(s0.images.available, false, 'available=接线/服务可用（≠实际已收发成功）')
    assert.deepEqual(Object.keys(s0.images.permissions), ['upload', 'download', 'groupHistory'], '三权限项固定')
    for (const p of Object.values(s0.images.permissions)) {
      assert.deepEqual({ grant: p.grant, source: p.source, checkedAt: p.checkedAt, stale: p.stale },
        { grant: 'unknown', source: null, checkedAt: null, stale: false },
        '权限项初始 unknown（缺字段/未列出/失败→unknown，不判 denied）')
    }
    assert.deepEqual(LARK_IMAGE_SCOPE_GROUPS.upload, ['im:resource', 'im:resource:upload'], 'upload OR 组固定')
    assert.deepEqual(LARK_IMAGE_SCOPE_GROUPS.download, ['im:message', 'im:message:readonly', 'im:message.history:readonly'], 'download OR 组固定')
    assert.equal(LARK_IMAGE_GROUP_HISTORY_SCOPE, 'im:message.group_msg', 'groupHistory 独立条件')
    assert.deepEqual(Object.keys(s0.images.operations), ['image_download', 'image_upload', 'image_send'])
    for (const op of Object.values(s0.images.operations)) {
      assert.equal(op.state, 'unknown')
      assert.equal(op.attempted, 0)
      assert.equal(op.failed, 0)
    }
    assert.ok(!/[0-9a-f]{32,}|lark:oc_|om_/.test(JSON.stringify({ d: s0.dedup, i: s0.images })), 'dedup/images 无业务 ID/digest')
    // 图片操作桶走通用 opAttempt/opSettle 机器
    const tok = d.opAttempt('image_send', {})
    assert.equal(tok && tok.op, 'image_send', 'opAttempt 接受图片桶')
    d.opSettle(tok, { ok: true, status: 200, apiCode: 0, unknown: false })
    const s1 = d.serialize({ configuredMode: 'card', running: false, now: Date.now() })
    assert.equal(s1.images.operations.image_send.attempted, 1, '证据桶 attempted')
    assert.equal(s1.images.operations.image_send.succeeded, 1)
    assert.equal(s1.images.operations.image_send.state, 'observed_success')
    assert.equal(s1.operations.image_send.succeeded, 1, 'operations 顶层同步含图片桶（加法兼容）')
    // 图片可用性 + receipt 错误计数（接线后由 P4 填充）
    d.setImagesAvailable(true)
    d.noteImageReceiptError()
    const s1b = d.serialize({ configuredMode: 'card', running: false, now: Date.now() })
    assert.equal(s1b.images.available, true)
    assert.equal(s1b.images.receiptErrors, 1)
    assert.equal(s0.dedup.reopen, 'none')
    assert.equal(s0.dedup.lastError, null)
    // 真实临时 store 注入（OS flock 真盘）：available/lockMode/计数每次直读 store
    const dd = await import(pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href)
    const sroot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-diag-dedup-'))
    const lease = await dd.openLarkDedupStore(sroot)
    d.setDedupReader(() => ({ stats: lease.stats(), sendCapacity: 1234, sendCapacitySource: 'configured' }))
    const uuidX = 'lki_contract_' + Date.now()
    const dgst = dd.larkSendDigest({ imageSha256: 'a'.repeat(64), mode: 'card', caption: '', appId: 'cli_t', conversation: 'lark:oc_x' })
    const bgn = await lease.sendReceipts.begin({ uuid: uuidX, digest: dgst, now: Date.now() })
    assert.equal(bgn.outcome, 'acquired', '真实 begin（契约测试用）')
    await lease.sendReceipts.finish({ uuid: uuidX, ownerToken: bgn.record.ownerToken, state: 'sent', messageId: 'om_c1' })
    const s2 = d.serialize({ configuredMode: 'card', running: false, now: Date.now() })
    assert.equal(s2.dedup.available, true, '真实 store 注入 available')
    assert.equal(s2.dedup.lockMode, 'flock', '真实 store 为 flock；非 flock 一律 null（不假称 link 能力）')
    assert.deepEqual(s2.dedup.capacity, { sendReceipts: 1234, source: 'configured' }, '真实 reader 透出实际容量+来源（不猜默认）')
    assert.equal(s2.dedup.counts.sendAcquired, 1)
    assert.equal(s2.dedup.counts.sendSent, 1)
    assert.equal(s2.dedup.counts.sendRecords, 1)
    await lease.close()
    // poisoned → reopen:'needed'（显式 reload 重开，不清空账本；不自动反复重开）
    d.setDedupReader(() => ({ stats: { poisoned: true, lockMode: 'flock' }, sendCapacity: 2000 }))
    const s3 = d.serialize({ configuredMode: 'card', running: false, now: Date.now() })
    assert.equal(s3.dedup.poisoned, true)
    assert.equal(s3.dedup.reopen, 'needed', 'poisoned → 需用户显式重开')
    assert.equal(s3.dedup.lastError, 'store_poisoned')
    // reader 抛错 → available:false（status 降级不失败、不透传原始错误）
    d.setDedupReader(() => { throw new Error('disk gone') })
    const s4 = d.serialize({ configuredMode: 'card', running: false, now: Date.now() })
    assert.equal(s4.dedup.available, false, 'reader 故障降级 available:false')
    assert.equal(s4.dedup.counts, null, 'reader 故障 → counts:null（不伪造健康）')
    assert.deepEqual(s4.dedup.capacity, { sendReceipts: null, source: null }, 'reader 故障 → 容量 null/null（不伪造 2000）')
    assert.ok(!JSON.stringify(s4.dedup).includes('disk'), 'reader 原始错误不透传')
    // 纯函数白名单：未知 lastError→null；非法容量回默认
    const nz = normalizeLarkDedupStatus({ stats: {}, sendCapacity: -5, lastError: '/path/secret' })
    assert.equal(nz.lastError, null, '非白名单 lastError 归 null')
    assert.deepEqual(nz.capacity, { sendReceipts: null, source: null }, '非法容量 → null/null（不伪造默认）')
    assert.equal(nz.lastErrorUnknown, true, 'unknown error remains visible without disclosing original value')
    assert.equal(normalizeLarkDedupStatus({ stats: {}, lastError: 'seq_exhausted' }).lastError, 'seq_exhausted', '九枚举含 seq_exhausted')
    assert.equal(normalizeLarkDedupStatus({ stats: { lockMode: 'link' } }).lockMode, null, 'link 不假称能力→null')
    // OR 组判定规则（Lead 裁定）：任一 status1→granted；整组显式 status2→denied；
    // 缺字段/未列出/部分拒绝→unknown；groupHistory 独立不从 download 外推。
    assert.deepEqual(deriveImageScopeGrants([
      { scope_name: 'im:resource:upload', grant_status: 1 },
      { scope_name: 'im:message', grant_status: 2 },
      { scope_name: 'im:message:readonly', grant_status: 1 },
    ]), { upload: 'granted', download: 'granted', groupHistory: 'unknown' }, '任一 OR 成员 status1→granted；groupHistory 不外推')
    assert.deepEqual(deriveImageScopeGrants([
      { scope_name: 'im:resource', grant_status: 2 },
      { scope_name: 'im:resource:upload', grant_status: 2 },
      { scope_name: 'im:message', grant_status: 2 },
      { scope_name: 'im:message:readonly', grant_status: 2 },
      { scope_name: 'im:message.history:readonly', grant_status: 2 },
      { scope_name: 'im:message.group_msg', grant_status: 2 },
    ]), { upload: 'denied', download: 'denied', groupHistory: 'denied' }, '整组显式拒绝才 denied')
    assert.deepEqual(deriveImageScopeGrants([
      { scope_name: 'im:resource', grant_status: 2 },
      { scope_name: 'im:message', grant_status: 1 },
    ]), { upload: 'unknown', download: 'granted', groupHistory: 'unknown' }, 'OR 组部分列出→不充分拒绝=unknown（不以未返回判 denied）')
    assert.deepEqual(deriveImageScopeGrants([]), { upload: 'unknown', download: 'unknown', groupHistory: 'unknown' }, '空列表全 unknown')
    assert.deepEqual(deriveImageScopeGrants(null), { upload: 'unknown', download: 'unknown', groupHistory: 'unknown' }, '非数组容错 unknown')
    // 三项显式 setPermissions 输入（旧 single imagesGrant 已废弃）
    d.setPermissions({ images: {
      upload: { grant: 'granted', source: 'scope_read', checkedAt: 1000 },
      download: { grant: 'denied', source: 'scope_read', checkedAt: 1001 },
      groupHistory: { grant: 'unknown' },
    } })
    const sp = d.serialize({ configuredMode: 'card', running: false, now: 1000 + 3600 * 1000 + 1 })
    assert.equal(sp.images.permissions.upload.grant, 'granted')
    assert.equal(sp.images.permissions.download.grant, 'denied')
    assert.equal(sp.images.permissions.groupHistory.grant, 'unknown', '三项独立不互相污染')
    assert.equal(sp.images.permissions.upload.source, 'scope_read')
    assert.equal(sp.images.permissions.groupHistory.source, null)
    assert.equal(sp.images.permissions.upload.stale, true, '超 TTL → stale')
    d.setPermissions({ images: { download: { grant: 'unknown', checkedAt: null } } })
    const sp2 = d.serialize({ configuredMode: 'card', running: false, now: Date.now() })
    assert.equal(sp2.images.permissions.upload.grant, 'granted', '缺项不改旧证据')
    assert.equal(sp2.images.permissions.download.grant, 'unknown')
    assert.equal(sp2.images.permissions.download.checkedAt, null)
  }

  console.log('lark-diagnostics ok | wire calls:', wire.length,
    '| scope_read:', (await readDiagnostics()).diag.operations.scope_read.attempted)
}

function deferredWire() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

main().catch((err) => { console.error(err); process.exit(1) })
