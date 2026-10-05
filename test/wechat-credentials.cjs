'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P2b 回归：微信 bot token 迁到凭据 record。
// 覆盖：扫码登录写入 record、record-updated 触发重建、重启后从 record 恢复、
// 内部回写 baseUrl 不触发「改地址清凭据」、外部改 baseUrl 会清、record 从不进响应、
// 缺 credentials 服务时登录明确报错且不回退写 Config。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const ENTRY_ID = 'dsh-messaging'
const KEY = 'dsh-messaging/wechat-bot'
const BOT_TOKEN = 'wechat-botToken-PLAINTEXT-0001'
const ROTATED_TOKEN = 'wechat-botToken-ROTATED-0002'

// P5 轮询节流回归的开关：网关对 getupdates 的响应模式与调用计数。
// 'fail'（默认）让长轮询在首次请求后自然退出；'ok' 模拟**秒回 200 + 空结果**。
let getupdatesMode = 'fail'
let getupdatesCalls = 0

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deepMerge(under, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over
  const result = Object.assign({}, under)
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    result[key] = (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object')
      ? deepMerge(result[key], value)
      : value
  }
  return result
}

function setPath(target, keys, value) {
  let cursor = target
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
  return target
}

function applyToConfig(config, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!config[key] || typeof config[key] !== 'object') config[key] = {}
      applyToConfig(config[key], value)
    } else {
      config[key] = value
    }
  }
}

function createSettings(getLoaderConfig, listeners) {
  const state = { revision: 0, values: {}, updateCalls: [], mutateCalls: [] }
  const emit = (paths) => {
    for (const handler of listeners.get('loader/volatile-update') || []) handler(paths)
  }
  return {
    state,
    describe() { return [{ ns: ENTRY_ID, revision: state.revision, value: clone(state.values), schema: {} }] },
    async update(ns, patch, expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw new Error(`settings namespace "${ns}" changed since it was read (expected revision ${expectedRevision}, now ${state.revision})`)
      }
      state.updateCalls.push(clone(patch))
      state.values = deepMerge(state.values, patch)
      state.revision += 1
      applyToConfig(getLoaderConfig(), patch)
      emit(Object.keys(patch))
    },
    async mutate(ns, ops, expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw new Error(`settings namespace "${ns}" changed since it was read (expected revision ${expectedRevision}, now ${state.revision})`)
      }
      state.mutateCalls.push(clone(ops))
      for (const op of ops) {
        if (op.op !== 'set') throw new Error('unsupported op ' + op.op)
        setPath(state.values, op.path, op.value)
      }
      state.revision += 1
      applyToConfig(getLoaderConfig(), state.values)
      emit(ops.map((op) => op.path.join('.')))
    },
  }
}

function createCredentials(listeners, store) {
  const records = store || new Map()
  const notify = (key) => {
    for (const handler of listeners.get('credentials/record-updated') || []) handler(key)
  }
  return {
    records,
    readRecord(key) { return Promise.resolve(records.get(key)) },
    modifyRecord(key, mutate) {
      return Promise.resolve(mutate(records.get(key))).then((next) => {
        if (next === undefined) return records.get(key)
        records.set(key, next)
        notify(key)
        return next
      })
    },
    deleteRecord(key) {
      if (records.has(key)) {
        records.delete(key)
        notify(key)
      }
      return Promise.resolve()
    },
  }
}

function runResult(text, exitCode) {
  return {
    exitCode: exitCode === undefined ? 0 : exitCode,
    timedOut: false,
    aborted: false,
    timeoutMs: 60000,
    stdout: { text: exitCode ? '' : text, truncated: false },
    stderr: { text: exitCode ? 'curl: (7) gateway refused' : '', truncated: false },
  }
}

function createHarness(options) {
  const opts = options || {}
  const routes = new Map()
  const listeners = opts.listeners || new Map()
  const services = {}
  const shellCommands = []
  if (opts.settings) services.settings = opts.settings
  if (opts.credentials) services.credentials = opts.credentials

  const ctx = {
    get(name) {
      if (name === 'dshMessaging.root') return opts.root
      if (name === 'dshMessaging.entryId') return ENTRY_ID
      if (name === 'dsh.home') return opts.root
      if (name === 'sandboxPolicy') return { workspaceRoot: opts.root }
      return undefined
    },
    inject(names, callback) {
      const service = services[names[0]]
      if (!service) return
      callback({ get(key) { return services[key] }, effect(fn) { return fn() } })
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect() { return () => {} },
    interval() { return () => {} },
    // 必须尊重传入的延时：wechatPollLoop 的最小轮询间隔（500ms）靠它落地；
    // 写死 1ms 会把节流变成空转，用例测不出自旋。
    timeout(fn, ms) { const handle = setTimeout(fn, ms || 1); return () => clearTimeout(handle) },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    shell: {
      resolve(spec) { return spec },
      async run(spec) {
        // P5：URL 进了 stdin 的 curl 配置，记录与分发都用「命令行 + 配置」。
        const command = String(spec && spec.command)
        const blob = command + '\n' + String((spec && spec.stdin) || '')
        shellCommands.push(blob)
        if (blob.includes('crypto-helper.cjs')) return runResult('{"ok":true}')
        if (blob.includes('get_bot_qrcode')) {
          return runResult(JSON.stringify({ qrcode: 'QR-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/1' }) + '\n__DSH_STATUS__:200')
        }
        if (blob.includes('get_qrcode_status')) {
          const status = opts.gateway && opts.gateway.status ? opts.gateway.status() : { status: 'wait' }
          return runResult(JSON.stringify(status) + '\n__DSH_STATUS__:200')
        }
        // 微信长轮询：默认失败（200 + 空体会让 wechatPollLoop 自旋，产品侧已加
        // ILINK_MIN_POLL_GAP_MS；'ok' 模式是用例故意触发自旋场景的入口）。
        if (blob.includes('getupdates')) {
          getupdatesCalls += 1
          if (getupdatesMode === 'ok') {
            return runResult(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: '' }) + '\n__DSH_STATUS__:200')
          }
          return runResult('', 1)
        }
        return runResult('\n__DSH_STATUS__:200')
      },
      start() { return { status: 'running', kill() { return false } } },
    },
    fs: {
      async resolve(target) { return { displayPath: target, targetKey: target } },
      async readText(target) {
        const existing = opts.memoryFiles.get(target.displayPath)
        if (existing !== undefined) return existing
        const error = new Error('not found')
        error.code = 'FS_NOT_FOUND'
        throw error
      },
      async writeText(target, content) {
        opts.memoryFiles.set(target.displayPath, content)
        return { version: 'v1' }
      },
    },
    agentDefaultModel: { currentSelection: () => null },
    agents: {
      async create(options) { return { agent: { id: options.sessionId, followup() {} }, async dispose() {} } },
      async resume() {
        const error = new Error('not found')
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      },
    },
  }

  return { ctx, routes, listeners, shellCommands }
}

async function invoke(routes, method, routePath, opts) {
  const handler = routes.get(routePath)
  assert.ok(handler, 'missing route ' + routePath)
  const req = new EventEmitter()
  req.method = method
  req.url = routePath
  req.headers = Object.assign({ host: '127.0.0.1:3080' }, (opts && opts.headers) || {})
  req.socket = { encrypted: false }
  req.destroy = () => {}
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {}; res.headersSent = true }
  res.end = (body) => { res.body = body; res.finished = true }
  queueMicrotask(() => {
    if (opts && opts.body) req.emit('data', Buffer.from(opts.body))
    req.emit('end')
  })
  await handler(req, res)
  await settle()
  let json = null
  if (res.body) { try { json = JSON.parse(res.body) } catch { json = res.body } }
  return { status: res.statusCode, json, text: res.body }
}

function loopback(extra) {
  return Object.assign({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' }, extra || {})
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unwrap(mod, raw) {
  const result = mod['~standard'].validate(raw)
  if (result.issues) throw new Error('seed config invalid: ' + JSON.stringify(result.issues))
  const VW = Symbol.for('cosmokit.volatile.write')
  const walk = (value) => {
    if (value && typeof value === 'object' && VW in value) return walk(value.get())
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]))
    }
    return value
  }
  return walk(result.value)
}

async function scanAndConfirm(routes) {
  const start = await invoke(routes, 'POST', '/__dsh-messaging/ilink/login/start', { headers: loopback(), body: '{}' })
  assert.equal(start.status, 200)
  assert.equal(start.json.ok, true, 'the QR session must start: ' + String(start.text))
  const status = await invoke(routes, 'POST', '/__dsh-messaging/ilink/login/status', {
    headers: loopback(),
    body: JSON.stringify({ sessionKey: start.json.sessionKey }),
  })
  return status
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  const { Config } = plugin
  const clientSource = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

  const tempRoots = []
  const makeRoot = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-p2b-wechat-'))
    tempRoots.push(dir)
    return dir
  }

  // ── A. 登录写入 record / 内部回写 baseUrl 不清凭据 / record 不进响应 ───────
  const rootA = makeRoot()
  const listenersA = new Map()
  const credentialsA = createCredentials(listenersA)
  let gatewayConfirmed = true
  const settingsA = createSettings(() => loaderA, listenersA)
  let loaderA = unwrap(Config, { adapters: { wechat: { enabled: true } } })
  settingsA.state.values = { adapters: { wechat: { enabled: true, baseUrl: 'https://ilinkai.weixin.qq.com' } } }
  const harnessA = createHarness({
    root: rootA,
    settings: settingsA,
    credentials: credentialsA,
    listeners: listenersA,
    memoryFiles: new Map(),
    gateway: { status: () => (gatewayConfirmed ? { status: 'confirmed', bot_token: ROTATED_TOKEN, ilink_bot_id: 'bot-9', baseurl: 'https://scanned-base.example.test' } : { status: 'wait' }) },
  })
  await plugin.apply(harnessA.ctx, loaderA)
  await settle()
  const generationBefore = (await invoke(harnessA.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })).json.generation

  const confirmed = await scanAndConfirm(harnessA.routes)
  assert.equal(confirmed.json.status, 'confirmed', 'the login must confirm: ' + String(confirmed.text))
  await settle()
  const record = credentialsA.records.get(KEY)
  assert.ok(record, 'a confirmed scan must write the credentials record')
  assert.equal(record.kind, 'grant')
  assert.equal(record.payload.token, ROTATED_TOKEN, 'the record carries the fresh token')
  // 内部回写 baseUrl 不触发「改地址清凭据」
  assert.equal(credentialsA.records.has(KEY), true, 'the internal baseUrl write-back must NOT clear the record')
  assert.equal(settingsA.state.values.adapters.wechat.baseUrl, 'https://scanned-base.example.test', 'the gateway baseurl is saved')
  const generationAfter = (await invoke(harnessA.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })).json.generation
  assert.ok(generationAfter >= generationBefore, 'record-updated must trigger a rebuild')

  // record 不出现在任何响应里；Config / defaultConfig 都不再携带 wechat.token
  // P5：配置的 HTTP 读取面已删除；「配置里没有 wechat.token 槽」改从设置页那条通道守护
  // （settings 的 volatile 视图 + describe 行），「record token 不上网」由 /status 守护。
  assert.equal(harnessA.routes.has('/__dsh-messaging/config'), false, 'the legacy config route must be gone (P5)')
  const settingsRow = settingsA.describe().find((entry) => entry.ns === ENTRY_ID)
  assert.ok(settingsRow, 'the settings row must describe our entry')
  assert.equal(settingsRow.value.adapters.wechat.token, undefined, 'the volatile view carries no wechat.token slot')
  assert.equal(JSON.stringify(settingsRow).includes(ROTATED_TOKEN), false, 'the settings wire carries no record token')
  const statusView = await invoke(harnessA.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })
  assert.equal(statusView.text.includes(ROTATED_TOKEN), false, 'the record token must not appear in GET /status')

  // 出站：适配器从 record 取 token（curl 命令里能看到，但状态接口看不到）
  const sendA = await invoke(harnessA.routes, 'POST', '/__dsh-messaging/send', {
    headers: loopback(),
    body: JSON.stringify({ channel: 'wechat', conversation: 'wechat:user-1', text: 'hello' }),
  })
  assert.equal(sendA.status, 200)
  const sendCommand = harnessA.shellCommands.find((command) => command.includes('sendmessage'))
  assert.ok(sendCommand, 'the outbound call must be issued')
  assert.ok(sendCommand.includes(ROTATED_TOKEN), 'the adapter must use the token from the credentials record')
  assert.equal(sendA.text.includes(ROTATED_TOKEN), false, 'the outbound response must not echo the token')

  // ── B. record-updated：外部改动 → 插件重建并接上新 token ───────────────────
  const generationBeforeExternal = (await invoke(harnessA.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })).json.generation
  await credentialsA.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 1, token: 'wechat-botToken-EXTERNAL-0003' } }))
  await settle()
  const generationAfterExternal = (await invoke(harnessA.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })).json.generation
  assert.ok(generationAfterExternal > generationBeforeExternal, 'an external record change must rebuild the adapter')
  harnessA.shellCommands.length = 0
  await invoke(harnessA.routes, 'POST', '/__dsh-messaging/send', {
    headers: loopback(),
    body: JSON.stringify({ channel: 'wechat', conversation: 'wechat:user-1', text: 'again' }),
  })
  const externalCommand = harnessA.shellCommands.find((command) => command.includes('sendmessage'))
  assert.ok(externalCommand && externalCommand.includes('wechat-botToken-EXTERNAL-0003'), 'the rebuilt adapter picks up the new record')

  // ── C. 外部改 baseUrl（设置页路径）→ record 被清，渠道回到需重新扫码 ───────
  await settingsA.mutate(ENTRY_ID, [{ op: 'set', path: ['adapters', 'wechat', 'baseUrl'], value: 'https://other-base.example.test' }])
  await settle()
  await settle()
  assert.equal(credentialsA.records.has(KEY), false, 'an externally driven address change must clear the record')
  const afterClear = await invoke(harnessA.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })
  assert.ok(afterClear.json.errors.some((entry) => /WeChat credential was cleared|已清除微信凭据/.test(entry.message)), 'the clear must be announced')
  assert.equal(afterClear.text.includes('wechat-botToken-EXTERNAL-0003'), false, 'no token leaks while reporting the clear')

  // ── C2. P5：wechatPollLoop 的最小轮询间隔（防自旋回归）─────────────────
  // 网关**秒回** 200 + 空结果时：循环必须被 ILINK_MIN_POLL_GAP_MS(500) 节流，
  // 且事件循环必须还活着（能醒来）。若没有该间隔，这里会变成微任务风暴：
  // 下面的 sleep 永远醒不来、进程空转烧 CPU——正是 9/24 残留进程的成因。
  getupdatesMode = 'ok'
  getupdatesCalls = 0
  // 触发一次 wechat 作用域重建（pollIntervalMs 是 wechat 的 volatile 字段），
  // 让已经停下的长轮询循环重新起跑。
  await settingsA.mutate(ENTRY_ID, [{ op: 'set', path: ['adapters', 'wechat', 'pollIntervalMs'], value: 6000 }])
  await settle()
  await settle()
  assert.ok(getupdatesCalls >= 1, 'the rebuilt wechat channel must start polling again')
  const callsBefore = getupdatesCalls
  await sleep(300) // 小于 500ms 的最小间隔：窗口内最多再发一次
  const callsInWindow = getupdatesCalls - callsBefore
  assert.ok(callsInWindow <= 1, 'the loop must be paced by the min poll gap (got ' + callsInWindow + ' calls in 300ms)')
  // 换回失败响应 → 下一次请求抛错，循环自然退出（测试结束不留任何轮询/定时器）。
  getupdatesMode = 'fail'
  await sleep(800) // 跨过一个间隔，让循环吃到失败
  const callsAtStop = getupdatesCalls
  await sleep(300)
  assert.equal(getupdatesCalls, callsAtStop, 'the loop must exit once the gateway starts failing')

  // ── D. 重启后从 record 恢复 ───────────────────────────────────────────────
  const rootB = makeRoot()
  const listenersB = new Map()
  const credentialsB = createCredentials(listenersB, credentialsA.records)
  // 重新放回一条 record，模拟重启时凭据存储里已有凭据
  credentialsB.records.set(KEY, { kind: 'grant', payload: { version: 1, token: BOT_TOKEN } })
  const settingsB = createSettings(() => loaderB, listenersB)
  let loaderB = unwrap(Config, { adapters: { wechat: { enabled: true, baseUrl: 'https://scanned-base.example.test' } } })
  const harnessB = createHarness({
    root: rootB,
    settings: settingsB,
    credentials: credentialsB,
    listeners: listenersB,
    memoryFiles: new Map(),
    gateway: { status: () => ({ status: 'wait' }) },
  })
  await plugin.apply(harnessB.ctx, loaderB)
  await settle()
  await invoke(harnessB.routes, 'POST', '/__dsh-messaging/send', {
    headers: loopback(),
    body: JSON.stringify({ channel: 'wechat', conversation: 'wechat:user-1', text: 'after restart' }),
  })
  const restartCommand = harnessB.shellCommands.find((command) => command.includes('sendmessage'))
  assert.ok(restartCommand, 'the restarted adapter sends')
  assert.ok(restartCommand.includes(BOT_TOKEN), 'the restarted adapter restores the token from the record')

  // ── E. 缺 credentials 服务：登录明确报错，不回退写 Config ──────────────────
  const rootC = makeRoot()
  const listenersC = new Map()
  const settingsC = createSettings(() => loaderC, listenersC)
  let loaderC = unwrap(Config, { adapters: { wechat: { enabled: true } } })
  const loaderBefore = clone(loaderC)
  const harnessC = createHarness({
    root: rootC,
    settings: settingsC,
    credentials: undefined, // 宿主没有凭据服务
    listeners: listenersC,
    memoryFiles: new Map(),
    gateway: { status: () => ({ status: 'confirmed', bot_token: BOT_TOKEN, ilink_bot_id: 'bot-3', baseurl: 'https://scanned-base.example.test' }) },
  })
  await plugin.apply(harnessC.ctx, loaderC)
  await settle()
  const failed = await scanAndConfirm(harnessC.routes)
  assert.equal(failed.json.status, 'failed', 'a missing credentials store must fail the login')
  assert.equal(failed.json.code, 'CREDENTIALS_UNAVAILABLE', 'the failure carries a machine-readable code')
  assert.match(String(failed.json.error), /credentials service is unavailable/, 'the error is bilingual and explicit: ' + String(failed.json.error))
  assert.match(String(failed.json.error), /缺少凭据存储服务/, 'the Chinese half is present too')
  assert.deepEqual(clone(loaderC), loaderBefore, 'nothing may be written back into Config')
  assert.equal(settingsC.state.updateCalls.length, 0, 'the failed login must not write settings either')
  // 客户端有对应中英文案
  assert.match(clientSource, /'wechat\.login\.noCredentials': '保存失败：宿主未提供凭据存储服务/, 'the zh copy must exist')
  assert.match(clientSource, /'wechat\.login\.noCredentials': 'Save failed: the host provides no credentials store/, 'the en copy must exist')
  assert.match(clientSource, /CREDENTIALS_UNAVAILABLE/, 'the client must switch copy on the machine code')

  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
  console.log('wechat-credentials: ok')
  console.log('record updates observed:', settingsA.state.mutateCalls.length, '| settings writes:', settingsA.state.updateCalls.length)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
