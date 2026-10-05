'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P2c 回归：配置变化时只重建受影响的部分（按渠道作用域 diff + 按渠道代际）。
// P5 收口后 /config 路由已删：这里改成与线上一致的 settings 通道（Loader 快照 +
// settings.mutate → loader/volatile-update → diffConfigScopes），作用域判定就发生在真入口上。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const WECHAT_KEY = 'dsh-messaging/wechat-bot'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function okResult(text) {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    timeoutMs: 60000,
    stdout: { text, truncated: false },
    stderr: { text: '', truncated: false },
  }
}

function failResult(text) {
  return {
    exitCode: 1,
    timedOut: false,
    aborted: false,
    timeoutMs: 60000,
    stdout: { text: '', truncated: false },
    stderr: { text, truncated: false },
  }
}

// 内存版 credentials：语义对齐 dsh-credentials-local，并在变更后广播 record-updated。
function createCredentials(listeners) {
  const records = new Map()
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

function createHarness(options) {
  const opts = options || {}
  const routes = new Map()
  const routeOps = new Map() // path -> { register, unregister }
  const intervals = [] // { fn, ms, disposed }
  const shellCalls = []
  const telegramPolls = []
  const agentCreates = []
  const listeners = opts.listeners || new Map()
  const services = {}
  if (opts.settings) services.settings = opts.settings
  if (opts.credentials) services.credentials = opts.credentials

  const bump = (routePath, kind) => {
    const record = routeOps.get(routePath) || { register: 0, unregister: 0 }
    record[kind] += 1
    routeOps.set(routePath, record)
  }

  const ctx = {
    get(name) {
      if (name === 'dshMessaging.root') return opts.root
      if (name === 'dshMessaging.entryId') return ENTRY_ID
      if (name === 'dsh.home') return opts.root
      if (name === 'sandboxPolicy') return { workspaceRoot: opts.root }
      return undefined
    },
    // 可选注入：credentials + settings（两个都给 → 与线上 Loader 路径一致）。
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
    // 记录而不自动触发：测试手动 fire 来模拟一次轮询 tick。
    interval(fn, ms) {
      const handle = { fn, ms, disposed: false }
      intervals.push(handle)
      return () => { handle.disposed = true }
    },
    timeout(fn, ms) { const handle = setTimeout(fn, ms); return () => clearTimeout(handle) },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        bump(route.path, 'register')
        return () => {
          routes.delete(route.path)
          bump(route.path, 'unregister')
        }
      },
    },
    shell: {
      resolve(spec) { return spec },
      async run(spec) {
        // P5：URL 进了 stdin 的 curl 配置，记录与分发都用「命令行 + 配置」。
        const command = String(spec && spec.command)
        const blob = command + '\n' + String((spec && spec.stdin) || '')
        shellCalls.push(blob)
        if (blob.includes('crypto-helper.cjs')) return okResult('{"ok":true}')
        if (blob.includes('getMe')) return okResult('{"ok":true,"result":{"id":999}}\n__DSH_STATUS__:200')
        if (blob.includes('getUpdates')) {
          telegramPolls.push(blob)
          if (opts.telegramDefer && opts.telegramDefer.pending) {
            return new Promise((resolve) => {
              opts.telegramDefer.resolve = (payload) => resolve(okResult(JSON.stringify(payload) + '\n__DSH_STATUS__:200'))
            })
          }
          return okResult(JSON.stringify(opts.telegramPayload || { ok: true, result: [] }) + '\n__DSH_STATUS__:200')
        }
        // 微信长轮询必须失败，否则 200 + 空体会在微任务里空转。
        if (blob.includes('getupdates')) return failResult('curl: (7) gateway refused')
        return okResult('\n__DSH_STATUS__:200')
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
    agentDefaultModel: { currentSelection: () => ({ provider: 'base', model: 'base-model' }) },
    agents: {
      async create(options) {
        agentCreates.push(options)
        return { agent: { id: options.sessionId, followup() {} }, async dispose() {} }
      },
      async resume() {
        const error = new Error('not found')
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      },
    },
  }

  return {
    ctx, routes, routeOps, intervals, shellCalls, telegramPolls, agentCreates, listeners, bump,
    setTelegramPayload(payload) { opts.telegramPayload = payload },
  }
}

async function invoke(routes, method, routePath, opts) {
  const handler = routes.get(routePath)
  assert.ok(handler, 'missing route ' + routePath)
  const req = new EventEmitter()
  req.method = method
  req.url = (opts && opts.url) || routePath
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

const ENTRY_ID = 'dsh-messaging'

// P5：/config 路由已删，配置写入只剩设置页那条通道。这里提供一个最小 settings 桩：
// update/mutate 合并进 values → 回写 loaderConfig → 广播 loader/volatile-update——
// 插件的 diffConfigScopes（按渠道作用域重建）正是从这条事件里取快照的。
function createSettings(getLoaderConfig, listeners) {
  const state = { revision: 0, values: {}, updateCalls: [], mutateCalls: [] }
  const emit = (paths) => {
    for (const handler of listeners.get('loader/volatile-update') || []) handler(paths)
  }
  return {
    state,
    describe() {
      return [{ ns: ENTRY_ID, revision: state.revision, value: clone(state.values), schema: {} }]
    },
    async update(ns, patch, expectedRevision) {
      assert.equal(ns, ENTRY_ID, 'settings.update must target our entry id')
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        const error = new Error('settings namespace "' + ns + '" changed since it was read')
        error.name = 'SettingsConflictError'
        throw error
      }
      state.updateCalls.push(clone(patch))
      state.values = deepMergeValues(state.values, patch)
      state.revision += 1
      applyToConfig(getLoaderConfig(), patch)
      emit(Object.keys(patch))
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, ENTRY_ID, 'settings.mutate must target our entry id')
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        const error = new Error('settings namespace "' + ns + '" changed since it was read')
        error.name = 'SettingsConflictError'
        throw error
      }
      state.mutateCalls.push(clone(ops))
      for (const op of ops) {
        if (op.op === 'unset') {
          // 真实 settings：unset = 删用户覆盖、回落组合层；桩里落成 schema 默认 ''。
          setPath(state.values, op.path, '')
          continue
        }
        if (op.op !== 'set') throw new Error('unsupported op ' + op.op)
        setPath(state.values, op.path, op.value)
      }
      state.revision += 1
      applyToConfig(getLoaderConfig(), state.values)
      emit(ops.map((op) => op.path.join('.')))
    },
  }
}

function deepMergeValues(base, patch) {
  const out = clone(base)
  const walk = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== 'object') target[key] = {}
        walk(target[key], value)
      } else {
        target[key] = value
      }
    }
  }
  walk(out, patch)
  return out
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

// 原地写入嵌套路径（模拟真实 settings 把 ops 落进 profile patch）。
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

// 「读当前配置 → 改一个字段 → 保存」的旧语义，改成 ops：只有变更的叶子会被送出去。
function diffOps(oldValue, nextValue, prefix) {
  const ops = []
  const isObj = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  const walk = (a, b, path) => {
    if (isObj(a) && isObj(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path.concat(key))
      return
    }
    if (JSON.stringify(a) === JSON.stringify(b)) return
    if (b === undefined) ops.push({ op: 'unset', path })
    else ops.push({ op: 'set', path, value: b })
  }
  walk(oldValue, nextValue, prefix)
  return ops
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

function payloadOf(config) {
  const body = clone(config)
  delete body.version
  delete body.workspaceRoot
  delete body.runtime
  return body
}

function liveIntervals(intervals) {
  return intervals.filter((handle) => !handle.disposed)
}

function reloadChannels(status) {
  return status.json.recent
    .filter((entry) => entry.kind === 'reload' && entry.channel)
    .map((entry) => entry.channel)
}

// 只看新出现的 reload 条目，避免“之前就重建过同渠道”的假阳性。
function newReloads(before, after) {
  return after.slice(before.length)
}

// agent.* 的作用域没有 channel 字段，单独取。
function reloadScopes(status) {
  return status.json.recent
    .filter((entry) => entry.kind === 'reload' && entry.scope)
    .map((entry) => entry.scope)
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-p2c-'))
  // 事件监听器要共用同一张表：插件用 ctx.on 注册，凭据桩用它广播。
  const listeners = new Map()
  const credentials = createCredentials(listeners)
  const telegramDefer = { pending: false, resolve: null }
  // Loader 路径：loaderConfig 是真源，settings 桩把 ops 回写它并广播 volatile-update。
  let loaderConfig = unwrap(plugin.Config, {})
  const settings = createSettings(() => loaderConfig, listeners)
  const harness = createHarness({
    root: tempRoot,
    credentials,
    settings,
    listeners,
    memoryFiles: new Map(),
    telegramDefer,
  })
  await plugin.apply(harness.ctx, loaderConfig)
  await settle()

  const getStatus = () => invoke(harness.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })
  // 读 = Loader 快照（页面拿到的 value 就是它投影出来的）。
  const readLoader = () => unwrap(plugin.Config, JSON.parse(JSON.stringify(loaderConfig)))
  const getConfig = async () => ({ json: { config: readLoader() } })
  // 写 = settings.mutate(ops, revision)：不带 revision 的写入用于「连续两次保存」这种场景，
  // revision 冲突语义由 test/config-migration.cjs 4c 单独守护。
  const postConfig = async (mutate) => {
    const current = readLoader()
    const next = clone(current)
    mutate(next)
    const ops = diffOps(current, next, [])
    await settings.mutate(ENTRY_ID, ops)
    await settle()
    await settle()
    const snapshot = await getStatus()
    return { status: snapshot.status, json: snapshot.json, text: String(snapshot.text || '') }
  }

  // ── 基线：telegram（轮询）+ onebot（入站路由）+ lark（webhook 路由）────────
  const seeded = await postConfig((body) => {
    body.adapters.telegram = Object.assign({}, body.adapters.telegram, {
      enabled: true, mode: 'polling', pollIntervalMs: 500, longPollTimeoutSec: 1,
    })
    body.adapters.onebot = Object.assign({}, body.adapters.onebot, {
      enabled: true, secret: 'ob-secret-PLAINTEXT-0001', endpoint: 'http://127.0.0.1:5700',
    })
    body.adapters.lark = Object.assign({}, body.adapters.lark, {
      enabled: true, mode: 'webhook', appId: 'cli_app_base',
    })
  })
  assert.equal(seeded.status, 200, 'seed save must succeed: ' + String(seeded.text))
  assert.equal(harness.routes.has('/messaging/onebot'), true, 'onebot webhook route is up')
  assert.equal(harness.routes.has('/messaging/lark/events'), true, 'lark webhook route is up')

  // 跑一次轮询：投递一条消息，建立 telegram 会话并推进 offset。
  const telegramHandle = liveIntervals(harness.intervals)[0]
  assert.ok(telegramHandle, 'telegram polling interval exists')
  harness.setTelegramPayload({
    ok: true,
    result: [{ update_id: 42, message: { message_id: 1, chat: { id: 777, type: 'private' }, from: { id: 555, is_bot: false, first_name: 'u' }, date: 1, text: 'hi telegram' } }],
  })
  telegramHandle.fn()
  await settle()
  const baselinePolls = harness.telegramPolls.length
  assert.equal(baselinePolls, 1, 'the first poll ran')
  const statusBaseline = await getStatus()
  assert.ok(statusBaseline.json.sessions.some((entry) => entry.key === 'telegram:777'), 'the telegram session exists')

  // ── 1. 改 lark.appId：只重建 lark ─────────────────────────────────────────
  const liveBeforeLark = liveIntervals(harness.intervals)
  // routeOps 记录是就地更新的同一对象，必须快照副本才能做前后比较。
  const onebotOpsBefore = { ...harness.routeOps.get('/messaging/onebot') }
  const larkRouteBefore = { ...harness.routeOps.get('/messaging/lark/events') }
  const reloadsBeforeLark = reloadChannels(await getStatus())
  const larkChange = await postConfig((body) => { body.adapters.lark.appId = 'cli_app_changed' })
  assert.equal(larkChange.status, 200, 'the lark change must save: ' + String(larkChange.text))
  await settle()

  assert.deepEqual(
    liveIntervals(harness.intervals),
    liveBeforeLark,
    'a lark-only change must not touch the telegram polling interval',
  )
  assert.deepEqual(harness.routeOps.get('/messaging/onebot'), onebotOpsBefore, 'onebot route untouched by a lark change')
  assert.ok(
    harness.routeOps.get('/messaging/lark/events').register > larkRouteBefore.register,
    'lark was actually rebuilt (route re-registered)',
  )
  assert.deepEqual(
    newReloads(reloadsBeforeLark, reloadChannels(await getStatus())),
    ['lark'],
    'only the lark rebuild is announced',
  )
  // telegram 轮询照常继续，且 offset 仍然是上一次的 43（没有被重置）
  const pollsBeforeSecond = harness.telegramPolls.length
  telegramHandle.fn()
  await settle()
  assert.equal(harness.telegramPolls.length, pollsBeforeSecond + 1, 'telegram polling still runs after the lark change')
  assert.ok(harness.telegramPolls[pollsBeforeSecond].includes('offset=43'), 'telegram offset survived the lark rebuild')
  const statusAfterLark = await getStatus()
  assert.ok(statusAfterLark.json.sessions.some((entry) => entry.key === 'telegram:777'), 'the telegram session survived')

  // ── 2. 改 agent.model：不重建任何适配器，已有会话保留，新会话用新 model ────
  const liveBeforeAgent = liveIntervals(harness.intervals)
  const routeOpsBeforeAgent = JSON.stringify([...harness.routeOps])
  const sessionsBeforeAgent = (await getStatus()).json.sessions.map((entry) => entry.key).sort()
  const reloadsBeforeAgent = reloadChannels(await getStatus())
  const scopesBeforeAgent = reloadScopes(await getStatus())
  const agentChange = await postConfig((body) => { body.agent = Object.assign({}, body.agent, { model: 'model-new' }) })
  assert.equal(agentChange.status, 200, 'the agent change must save: ' + String(agentChange.text))
  await settle()
  assert.deepEqual(liveIntervals(harness.intervals), liveBeforeAgent, 'agent.* must not restart any adapter')
  assert.equal(JSON.stringify([...harness.routeOps]), routeOpsBeforeAgent, 'agent.* must not touch any route')
  assert.deepEqual(
    (await getStatus()).json.sessions.map((entry) => entry.key).sort(),
    sessionsBeforeAgent,
    'agent.* must keep the existing sessions',
  )
  assert.deepEqual(
    newReloads(scopesBeforeAgent, reloadScopes(await getStatus())),
    ['agent'],
    'agent.* announces a scoped reload and nothing else',
  )
  assert.deepEqual(
    newReloads(reloadsBeforeAgent, reloadChannels(await getStatus())),
    [],
    'agent.* must not rebuild any channel',
  )
  // 新会话用上新 model
  const newConversationPayload = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 2002,
    self_id: 999,
    raw_message: 'fresh conversation',
    sender: { user_id: 2002, nickname: 'smoke' },
  })
  const signature = 'sha1=' + require('node:crypto').createHmac('sha1', 'ob-secret-PLAINTEXT-0001').update(newConversationPayload, 'utf8').digest('hex')
  await invoke(harness.routes, 'POST', '/messaging/onebot', {
    headers: loopback({ 'x-signature': signature, 'x-self-id': '999' }),
    body: newConversationPayload,
  })
  const lastCreate = harness.agentCreates[harness.agentCreates.length - 1]
  assert.ok(lastCreate, 'a new session was created')
  assert.equal(lastCreate.agentOptions.model, 'model-new', 'the new session must use the new model')

  // ── 3. telegram.mode polling → webhook：旧轮询退出（代际保护）+ 路由切换 ────
  const staleHandle = telegramHandle
  telegramDefer.pending = true // 让下一次 poll 挂起，制造“在途请求”
  staleHandle.fn()
  await new Promise((resolve) => setTimeout(resolve, 5)) // 让请求发出但未完成
  assert.equal(telegramDefer.resolve !== null, true, 'the telegram request is in flight')

  const modeChange = await postConfig((body) => { body.adapters.telegram.mode = 'webhook' })
  assert.equal(modeChange.status, 200, 'the mode change must save: ' + String(modeChange.text))
  await settle()
  assert.equal(staleHandle.disposed, true, 'the old polling interval is disposed')
  assert.equal(harness.routes.has('/messaging/telegram/webhook'), true, 'the telegram webhook route is registered')
  assert.equal(harness.routes.has('/messaging/onebot'), true, 'other channels keep their routes')

  // 在途的旧请求此刻才返回：代际保护必须让它的结果被丢弃（不产生新会话）
  telegramDefer.resolve({
    ok: true,
    result: [{ update_id: 43, message: { message_id: 2, chat: { id: 888, type: 'private' }, from: { id: 555, is_bot: false, first_name: 'u' }, date: 1, text: 'stale update' } }],
  })
  telegramDefer.pending = false
  await settle()
  const statusAfterMode = await getStatus()
  assert.equal(
    statusAfterMode.json.sessions.some((entry) => entry.key === 'telegram:888'),
    false,
    'a stale in-flight poll must be dropped after the channel generation moved',
  )

  // ── 4. enabled 开关：只启停该渠道 ────────────────────────────────────────
  const larkRouteBeforeDisable = { ...harness.routeOps.get('/messaging/lark/events') }
  const telegramIntervalsBeforeDisable = liveIntervals(harness.intervals)
  const reloadsBeforeDisable = reloadChannels(await getStatus())
  const disableLark = await postConfig((body) => { body.adapters.lark.enabled = false })
  assert.equal(disableLark.status, 200, 'disabling lark must save: ' + String(disableLark.text))
  await settle()
  assert.equal(harness.routes.has('/messaging/lark/events'), false, 'the lark route is gone')
  const larkOps = harness.routeOps.get('/messaging/lark/events')
  assert.equal(larkOps.register, larkOps.unregister, 'no residual lark route registration')
  assert.deepEqual(liveIntervals(harness.intervals), telegramIntervalsBeforeDisable, 'disabling lark must not touch telegram')
  assert.deepEqual(newReloads(reloadsBeforeDisable, reloadChannels(await getStatus())), ['lark'], 'only the lark stop is announced')

  const telegramRoutesBeforeEnable = { ...harness.routeOps.get('/messaging/telegram/webhook') }
  const enableLark = await postConfig((body) => { body.adapters.lark.enabled = true })
  assert.equal(enableLark.status, 200, 'enabling lark must save: ' + String(enableLark.text))
  await settle()
  assert.equal(harness.routes.has('/messaging/lark/events'), true, 'the lark route is back')
  assert.ok(
    harness.routeOps.get('/messaging/lark/events').register > larkRouteBeforeDisable.register,
    'lark registered again when re-enabled',
  )
  assert.equal(
    harness.routeOps.get('/messaging/telegram/webhook').register,
    telegramRoutesBeforeEnable.register,
    're-enabling lark must not touch telegram',
  )

  // ── 5. 连续两次快速修改：队列串行，最终状态与最后一次一致，无残留 ──────────
  const [firstSave, secondSave] = await Promise.all([
    postConfig((body) => { body.adapters.telegram.pollIntervalMs = 700 }),
    postConfig((body) => {
      body.adapters.telegram.enabled = false
      body.adapters.lark.enabled = false
      body.adapters.lark.appId = 'cli_app_final'
    }),
  ])
  assert.equal(firstSave.status, 200, 'the first of the pair must save: ' + String(firstSave.text))
  assert.equal(secondSave.status, 200, 'the second of the pair must save: ' + String(secondSave.text))
  await settle()
  await settle()

  const finalConfig = (await getConfig()).json.config
  assert.equal(finalConfig.adapters.telegram.enabled, false, 'the final state matches the last write')
  assert.equal(finalConfig.adapters.lark.enabled, false, 'the final state matches the last write (lark)')
  assert.equal(finalConfig.adapters.lark.appId, 'cli_app_final', 'the last appId wins')
  assert.equal(harness.routes.has('/messaging/lark/events'), false, 'no residual lark route')
  assert.equal(harness.routes.has('/messaging/telegram/webhook'), false, 'no residual telegram webhook route')
  for (const routePath of ['/messaging/lark/events', '/messaging/telegram/webhook']) {
    const ops = harness.routeOps.get(routePath)
    if (ops) assert.equal(ops.register, ops.unregister, 'balanced register/unregister for ' + routePath)
  }
  assert.equal(
    liveIntervals(harness.intervals).length,
    0,
    'no polling interval survives when both polling channels are off',
  )

  // ── 6. credentials/record-updated：只重建 wechat ─────────────────────────
  // 先把 wechat 打开（它会注册一个看门狗 interval）
  const enableWechat = await postConfig((body) => { body.adapters.wechat.enabled = true })
  assert.equal(enableWechat.status, 200, 'enabling wechat must save: ' + String(enableWechat.text))
  await settle()
  assert.ok(liveIntervals(harness.intervals).length >= 1, 'the wechat watchdog interval exists')

  const liveBeforeRecord = liveIntervals(harness.intervals)
  const onebotRoutesBeforeRecord = { ...harness.routeOps.get('/messaging/onebot') }
  const reloadsBeforeRecord = reloadChannels(await getStatus())
  await credentials.modifyRecord(WECHAT_KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 1, token: 'wechat-token-P2C' } }))
  await settle()
  await settle()

  assert.deepEqual(
    newReloads(reloadsBeforeRecord, reloadChannels(await getStatus())),
    ['wechat'],
    'record-updated rebuilds exactly the wechat channel',
  )
  assert.equal(
    liveIntervals(harness.intervals).length,
    liveBeforeRecord.length,
    'wechat gets one fresh watchdog and no other channel\'s interval is touched',
  )
  assert.deepEqual(harness.routeOps.get('/messaging/onebot'), onebotRoutesBeforeRecord, 'record-updated must not touch onebot routes')

  fs.rmSync(tempRoot, { recursive: true, force: true })
  console.log('incremental-rebuild: ok')
  console.log('telegram polls:', harness.telegramPolls.length, '| route ops:', JSON.stringify([...harness.routeOps]))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
