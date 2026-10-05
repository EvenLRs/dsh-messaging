'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P2b 回归：旧 config.json 导入（状态机 + 幂等 + 坏值丢弃）、POST /config 收敛到
// settings、以及「改出站地址就清随行密钥」的地址策略。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const ENTRY_ID = 'dsh-messaging'

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

// 内存版 settings：语义对齐 dsh-settings 的 write() —— 只收 volatile 路径、
// expectedRevision 不符抛 SettingsConflictError、写完广播 loader/volatile-update。
function createSettings(getLoaderConfig, listeners) {
  const state = {
    revision: 0,
    values: {},
    updateCalls: [],
    mutateCalls: [],
    failNextUpdate: null,
  }
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
        const error = new Error(`settings namespace "${ns}" changed since it was read (expected revision ${expectedRevision}, now ${state.revision})`)
        error.name = 'SettingsConflictError'
        throw error
      }
      if (state.failNextUpdate) {
        const error = state.failNextUpdate
        state.failNextUpdate = null
        throw error
      }
      state.updateCalls.push(clone(patch))
      state.values = deepMerge(state.values, patch)
      state.revision += 1
      // 真实 Loader 会把 volatile 值写回 fiber.config 再广播；这里直接改 loaderConfig。
      applyToConfig(getLoaderConfig(), patch)
      emit(Object.keys(patch))
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, ENTRY_ID, 'settings.mutate must target our entry id')
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        const error = new Error(`settings namespace "${ns}" changed since it was read (expected revision ${expectedRevision}, now ${state.revision})`)
        error.name = 'SettingsConflictError'
        throw error
      }
      state.mutateCalls.push(clone(ops))
      for (const op of ops) {
        if (op.op === 'unset') {
          // 与真实 settings 一致：unset = 删用户覆盖、回落组合层。桩里没有组合层，
          // 密钥字段的 schema 默认是 ''，所以直接落成 ''（就是「清空」）。
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

// 原地写入嵌套路径（模拟 settings.mutate 的 set 操作）。
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

// 内存版 credentials：对齐 dsh-credentials-local 的 readRecord/modifyRecord/deleteRecord，
// 并在真实变更后广播 credentials/record-updated。
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
  const listeners = opts.listeners || new Map()
  const services = {}
  const writes = []

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
    // 可选注入：服务缺席时**不**回调（模拟宿主没装该服务）。
    inject(names, callback) {
      const service = services[names[0]]
      if (!service) return
      callback({
        get(key) { return services[key] },
        effect(fn) { return fn() },
      })
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect() { return () => {} },
    interval() { return () => {} },
    timeout(fn) { const handle = setTimeout(fn, 1); return () => clearTimeout(handle) },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    shell: {
      resolve(spec) { return spec },
      async run(spec) {
        // P5：URL 进了 stdin 的 curl 配置，分发要看命令行 + 配置。
        const command = String(spec && spec.command)
        const blob = command + '\n' + String((spec && spec.stdin) || '')
        if (blob.includes('crypto-helper.cjs')) {
          return okRun('{"ok":true}')
        }
        if (blob.includes('get_qrcode_status')) {
          const status = (opts.gateway && opts.gateway.status) || 'wait'
          return okRun(JSON.stringify(status === 'confirmed'
            ? { status: 'confirmed', bot_token: 'wechat-botToken-PLAINTEXT-0001', ilink_bot_id: 'bot-1', baseurl: 'https://new-base.example.test' }
            : { status }) + '\n__DSH_STATUS__:200')
        }
        if (blob.includes('get_bot_qrcode')) {
          return okRun(JSON.stringify({ qrcode: 'QR-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/1' }) + '\n__DSH_STATUS__:200')
        }
        // 微信长轮询：必须返回失败，否则 200 + 空体会让 wechatPollLoop 在微任务里
        // 空转（事件循环被饿死，测试会“卡住”而不是报错）。
        if (blob.includes('getupdates')) {
          return {
            exitCode: 1,
            timedOut: false,
            aborted: false,
            timeoutMs: 60000,
            stdout: { text: '', truncated: false },
            stderr: { text: 'curl: (7) gateway refused', truncated: false },
          }
        }
        if (opts.shellRun) return opts.shellRun(command)
        return okRun('\n__DSH_STATUS__:200')
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
        writes.push({ path: target.displayPath, content })
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
    agentsReady: true,
  }

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) || []) handler(payload)
  }

  return { ctx, routes, listeners, services, writes, emit }
}

function okRun(text) {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    timeoutMs: 60000,
    stdout: { text, truncated: false },
    stderr: { text: '', truncated: false },
  }
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

// 与新客户端一致：只提交 volatile 字段。version/workspaceRoot/runtime.* 在 Loader
// 路径下会被 400 NON_VOLATILE_FIELD 拒绝（旧的 apply(ctx) 路径不受此限制）。
function payloadOf(config) {
  const body = clone(config)
  delete body.version
  delete body.workspaceRoot
  delete body.runtime
  return body
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

function legacyDirs(tempRoot) {
  const dir = path.join(tempRoot, '.dsh-messaging')
  fs.mkdirSync(dir, { recursive: true })
  return {
    source: path.join(dir, 'config.json'),
    marker: path.join(dir, 'config.json.imported'),
    backupPrefix: path.join(dir, 'config.json.migrated-'),
  }
}

function listBackups(tempRoot) {
  const dir = path.join(tempRoot, '.dsh-messaging')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.startsWith('config.json.migrated-'))
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  const { Config } = plugin
  await bootstrapPaths(Config)

  const tempRoots = []
  const makeRoot = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-p2b-'))
    tempRoots.push(dir)
    return dir
  }

  // ── 场景 1：成功导入（含坏值丢弃、微信 token 迁移）────────────────────────
  const root1 = makeRoot()
  const paths1 = legacyDirs(root1)
  const legacyConfig = {
    version: 1,
    workspaceRoot: root1,
    runtime: { nodePath: '', wsModulePath: '', companionDir: '', pollIntervalMs: 2500, telegramLongPollTimeoutSec: 40, shellTimeoutMs: 60000, stdoutMaxBytes: 2097152 },
    agent: { cwd: root1, agentPreset: 'standard', provider: null, model: null },
    adapters: {
      onebot: {
        enabled: true,
        // basic-auth 会撞上 P2a 的严格 URL 校验 → 必须被丢弃并告警
        endpoint: 'http://user:pass@127.0.0.1:5700',
        accessToken: 'ob-access-PLAINTEXT-0001',
        secret: 'ob-secret-PLAINTEXT-0001',
        webhookPath: '/messaging/onebot',
        selfId: null,
      },
      telegram: { enabled: true, token: '8001234567:AAE-tgTokenPLAINTEXT0001', mode: 'polling', webhookPath: '/messaging/telegram/webhook', pollIntervalMs: 3000, longPollTimeoutSec: 40, dropPendingUpdates: false },
      discord: { enabled: false, botToken: '', intents: 33281, wsModulePath: '' },
      slack: { enabled: false, botToken: '', signingSecret: '', verificationToken: '', webhookPath: '/messaging/slack/events' },
      lark: { enabled: false, appId: 'cli_test', appSecret: 'lark-appSecret-PLAINTEXT-0001', mode: 'long-connection', verificationToken: '', encryptKey: '', webhookPath: '/messaging/lark/events' },
      wecom: { enabled: false, corpId: '', agentId: '', secret: '', token: '', encodingAESKey: '', webhookPath: '/messaging/wecom/callback' },
      wechat: { enabled: true, baseUrl: 'https://ilinkai.weixin.qq.com', token: 'wechat-botToken-PLAINTEXT-0001', botAgent: 'dsh-messaging', pollIntervalMs: 2500, longPollTimeoutSec: 35 },
    },
  }
  fs.writeFileSync(paths1.source, JSON.stringify(legacyConfig, null, 2))

  const credentials1 = createCredentials(new Map())
  const listeners1 = new Map()
  const settings1 = createSettings(() => loaderConfig1, listeners1)
  let loaderConfig1 = unwrap(Config, {})
  const harness1 = createHarness({ root: root1, settings: settings1, credentials: credentials1, listeners: listeners1, memoryFiles: new Map() })
  await plugin.apply(harness1.ctx, loaderConfig1)
  await settle()

  assert.ok(fs.existsSync(paths1.marker), 'a successful import renames the source to config.json.imported')
  assert.equal(fs.existsSync(paths1.source), false, 'the source file must be renamed away (rename-first pattern)')
  assert.equal(listBackups(root1).length, 0, 'no separate backup file: the renamed file is the archive')
  const archived = fs.readFileSync(paths1.marker, 'utf8')
  assert.equal(archived.includes('wechat-botToken-PLAINTEXT-0001'), false, 'the migrated WeChat token must be stripped from the archive')
  assert.ok(archived.includes('ob-secret-PLAINTEXT-0001'), 'the archive keeps the rest of the legacy values')
  assert.equal(JSON.parse(archived).adapters.wechat.token, undefined, 'the archived copy has no WeChat token either')

  assert.equal(settings1.state.updateCalls.length, 1, 'the import writes the profile exactly once')
  const patch = settings1.state.updateCalls[0]
  assert.equal(patch.adapters.telegram.token, '8001234567:AAE-tgTokenPLAINTEXT0001', 'a secret from the legacy file is imported')
  assert.equal(patch.adapters.onebot.secret, 'ob-secret-PLAINTEXT-0001')
  assert.equal(patch.adapters.lark.appSecret, 'lark-appSecret-PLAINTEXT-0001')
  assert.equal(patch.adapters.telegram.pollIntervalMs, 3000, 'ordinary form values are imported')
  assert.equal(patch.adapters.wechat && patch.adapters.wechat.token, undefined, 'the WeChat token never reaches Config')
  assert.equal(patch.adapters.onebot && patch.adapters.onebot.endpoint, undefined, 'the invalid basic-auth endpoint must be dropped')
  assert.equal(patch.runtime, undefined, 'ordinary runtime fields are not imported (settings only accepts volatile paths)')
  assert.equal(patch.workspaceRoot, undefined, 'workspaceRoot is not imported either')

  const statusAfterImport = await invoke(harness1.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })
  assert.ok(
    statusAfterImport.json.errors.some((entry) => /config import dropped adapters\.onebot\.endpoint:/.test(entry.message)),
    'the dropped field must be reported as a warning in status.errors',
  )

  const record1 = credentials1.records.get('dsh-messaging/wechat-bot')
  assert.ok(record1, 'the legacy WeChat token must land in the credentials record')
  assert.equal(record1.kind, 'grant')
  assert.equal(record1.payload.token, 'wechat-botToken-PLAINTEXT-0001')

  // 导入的值已经通过 volatile-update 进到运行时。
  // P5：配置视图不再走 HTTP——「运行时已就位」改从 Loader 快照读；
  // 「脱敏后的 describe 视图不含导入密钥」由 test/loader-integration.cjs（真实 SettingsForms）守护。
  const importedRuntime = unwrap(Config, loaderConfig1)
  assert.equal(importedRuntime.adapters.telegram.enabled, true, 'imported values reach the runtime')
  assert.equal(importedRuntime.adapters.telegram.pollIntervalMs, 3000)
  assert.equal(JSON.stringify(settings1.describe()).includes('wechat-botToken-PLAINTEXT-0001'), false, 'the record-migrated WeChat token never enters the settings wire')

  // ── 场景 2：重复导入幂等（marker 在 → 不再写 profile、不再改名）────────────
  const settings2 = createSettings(() => loaderConfig2, listeners1)
  let loaderConfig2 = unwrap(Config, {})
  const harness2 = createHarness({ root: root1, settings: settings2, credentials: credentials1, listeners: listeners1, memoryFiles: new Map() })
  await plugin.apply(harness2.ctx, loaderConfig2)
  await settle()
  assert.equal(settings2.state.updateCalls.length, 0, 'an already-imported file must not be imported again')
  assert.equal(fs.existsSync(paths1.marker), true, 'the imported archive stays in place')
  assert.equal(fs.existsSync(paths1.source), false, 'and the source does not come back')
  assert.equal(listBackups(root1).length, 0, 'no extra archive files are created on a re-run')

  // ── 场景 3：只有 runtime 骨架的文件：照改名，但不调 update ──────────────
  const root3 = makeRoot()
  const paths3 = legacyDirs(root3)
  const skeleton = {
    version: 1,
    workspaceRoot: root3,
    runtime: { nodePath: '', wsModulePath: '', companionDir: '', pollIntervalMs: 2500, telegramLongPollTimeoutSec: 40, shellTimeoutMs: 60000, stdoutMaxBytes: 2097152 },
  }
  fs.writeFileSync(paths3.source, JSON.stringify(skeleton, null, 2))
  const settings3 = createSettings(() => loaderConfig3, listeners1)
  let loaderConfig3 = unwrap(Config, {})
  const harness3 = createHarness({ root: root3, settings: settings3, credentials: credentials1, listeners: listeners1, memoryFiles: new Map() })
  await plugin.apply(harness3.ctx, loaderConfig3)
  await settle()
  assert.equal(settings3.state.updateCalls.length, 0, 'a runtime-only file must not be imported')
  assert.equal(fs.existsSync(paths3.source), false, 'a runtime-only file is still renamed away')
  assert.equal(
    fs.readFileSync(paths3.marker, 'utf8'),
    JSON.stringify(skeleton, null, 2),
    'the rename must not rewrite the file (pure rename, no marker content)',
  )
  assert.equal(listBackups(root3).length, 0, 'no separate backup file for a skipped file')

  // ── 场景 4：POST /config 收敛到 settings + revision 冲突 + 密钥语义 ───────
  const root4 = makeRoot()
  const profile4 = {
    adapters: { onebot: { enabled: true, endpoint: 'http://127.0.0.1:5700', accessToken: 'ob-access-PLAINTEXT-0001' } },
  }
  const settings4 = createSettings(() => loaderConfig4, listeners1)
  let loaderConfig4 = unwrap(Config, profile4)
  settings4.state.values = nestedOf(volatileOf(loaderConfig4))
  const harness4 = createHarness({ root: root4, settings: settings4, credentials: credentials1, listeners: listeners1, memoryFiles: new Map() })
  await plugin.apply(harness4.ctx, loaderConfig4)
  await settle()

  // 手工恢复密钥后必须让运行时也同步（emit 一次 volatile-update），否则 state.config
  // 还停在旧值，下一步的地址 diff 会拿到错误的 before。
  const restoreToken = async (value) => {
    settings4.state.values.adapters.onebot.accessToken = value
    applyToConfig(loaderConfig4, { adapters: { onebot: { accessToken: value } } })
    harness4.emit('loader/volatile-update', ['adapters.onebot.accessToken'])
    await settle()
  }
  // 4a) 设置页的写入 = settings.mutate(ops, revision)：只收变更的叶子，不写 config.json。
  //     （旧 POST /config 的「不带 revision 就记 warn」随路由一起删除——页面永远带 revision。）
  const beforeWrites = harness4.writes.length
  const read = () => {
    const row = settings4.describe().find((entry) => entry.ns === ENTRY_ID)
    assert.ok(row, 'the settings row must describe our entry')
    return row
  }
  assert.equal(typeof read().revision, 'number', 'the settings row must expose the revision')
  await settings4.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'telegram', 'pollIntervalMs'], value: 4000 },
    { op: 'unset', path: ['adapters', 'telegram', 'token'] },
  ], read().revision)
  await settle()
  assert.equal(settings4.state.values.adapters.telegram.pollIntervalMs, 4000, 'ordinary form values are saved')
  assert.equal(settings4.state.values.adapters.onebot.accessToken, 'ob-access-PLAINTEXT-0001', 'an untouched secret keeps its stored value')
  assert.equal(harness4.writes.length, beforeWrites, 'the Loader path must not write config.json')
  assert.equal(typeof read().revision, 'number', 'the row carries a fresh revision after the save')
  const noRevisionWarn = await invoke(harness4.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })
  assert.equal(
    noRevisionWarn.json.errors.some((entry) => entry.context === 'config revision'),
    false,
    'the route-only no-revision warning died with the route',
  )

  // 4a'/4a'') 非 volatile 字段的拒收不再由本插件的路由负责：
  //   · 页面只能枚举表单里的 volatile 字段（test/client-smoke.cjs 守护 ops 只含 volatile 路径）；
  //   · 真正的整树校验由官方 settings.validatePaths 承担，
  //     见 test/loader-integration.cjs（真实 SettingsForms 直接拒绝 version/runtime.*）。

  // 4b) 显式清除仍然生效：设置页那条通道的「清空」就是 op:'unset'
  //     （掩码视图时代的 __clearSecrets 保留键已随 /config 路由一起删除）。
  await settings4.mutate(ENTRY_ID, [
    { op: 'unset', path: ['adapters', 'onebot', 'accessToken'] },
  ], read().revision)
  await settle()
  assert.equal(settings4.state.values.adapters.onebot.accessToken, '', 'an explicit unset must still empty the secret')

  // 恢复一个密钥，供后面的地址策略用
  await restoreToken('ob-access-PLAINTEXT-0001')

  // 4c) revision 冲突：stale revision 必须被 settings 拒绝（客户端把同一个错误映射成 409
  //     SETTINGS_CONFLICT，见 test/client-smoke.cjs），且被拒的写入改不动任何东西。
  const staleRevision = read().revision
  let staleError = null
  try {
    await settings4.mutate(ENTRY_ID, [
      { op: 'set', path: ['adapters', 'telegram', 'pollIntervalMs'], value: 5000 },
    ], staleRevision - 1)
  } catch (error) {
    staleError = error
  }
  assert.ok(staleError, 'a stale revision must be rejected')
  assert.equal(staleError.name, 'SettingsConflictError', 'the settings service must reject a stale revision: ' + staleError.message)
  assert.equal(settings4.state.values.adapters.telegram.pollIntervalMs, 4000, 'a refused write changes nothing')

  // 带上当前 revision → 成功（客户端拿到 revision 后的下一次保存）
  await settings4.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'telegram', 'pollIntervalMs'], value: 4500 },
  ], read().revision)
  await settle()
  assert.equal(settings4.state.values.adapters.telegram.pollIntervalMs, 4500, 'the write lands')

  // ── 场景 5：地址策略 ─────────────────────────────────────────────────────
  // 5a) 只改 endpoint → accessToken 被清空（规则入口：loader/volatile-update → diffAddressSecrets）
  await settings4.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'onebot', 'endpoint'], value: 'http://127.0.0.1:6000' },
  ], read().revision)
  await settle()
  assert.equal(settings4.state.values.adapters.onebot.accessToken, '', 'changing the endpoint must clear the outbound token')
  const afterAddr = await invoke(harness4.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })
  assert.ok(afterAddr.json.errors.some((entry) => /outbound address changed|出站地址已变更/.test(entry.message)), 'the clear must be announced in errors[]')

  // 5b) 改 endpoint 且同时给了新 token → 保留新 token
  await restoreToken('ob-access-PLAINTEXT-0001')
  await settings4.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'onebot', 'endpoint'], value: 'http://127.0.0.1:6001' },
    { op: 'set', path: ['adapters', 'onebot', 'accessToken'], value: 'ob-access-ROTATED-0002' },
  ], read().revision)
  await settle()
  assert.equal(settings4.state.values.adapters.onebot.accessToken, 'ob-access-ROTATED-0002', 'a new token supplied with the address must survive')

  // 5c) 地址不变（规范化后相同：尾斜杠 + 默认端口）→ 不清空
  await settings4.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'onebot', 'endpoint'], value: 'http://127.0.0.1:6001/' },
  ], read().revision)
  await settle()
  assert.equal(settings4.state.values.adapters.onebot.accessToken, 'ob-access-ROTATED-0002', 'an equivalent address is not a change')

  // 5d) 设置页 form.mutate 路径（volatile-update 里回写）
  await restoreToken('ob-access-PLAINTEXT-0001')
  await settings4.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'onebot', 'endpoint'], value: 'http://127.0.0.1:7000' },
  ])
  await settle()
  await settle()
  assert.equal(settings4.state.values.adapters.onebot.accessToken, '', 'a form-driven address change must clear the token too')
  assert.ok(settings4.state.mutateCalls.some((ops) => ops.some((op) => op.path.join('.') === 'adapters.onebot.accessToken')), 'the clear is written back through settings.mutate')

  // 5e) 归一化等价的地址改动（form 路径）→ 不清空
  await restoreToken('ob-access-PLAINTEXT-0001')
  await settings4.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'onebot', 'endpoint'], value: 'http://127.0.0.1:7000/' },
  ])
  await settle()
  await settle()
  assert.equal(settings4.state.values.adapters.onebot.accessToken, 'ob-access-PLAINTEXT-0001', 'a trailing slash is the same address')

  // ── 场景 6：profile 写入失败 → 把 .imported 改回 config.json，下次重试 ────
  const root6 = makeRoot()
  const paths6 = legacyDirs(root6)
  const failingSource = {
    version: 1,
    workspaceRoot: root6,
    runtime: Object.assign({}, skeleton.runtime),
    adapters: { telegram: { enabled: true, pollIntervalMs: 6000 } },
  }
  fs.writeFileSync(paths6.source, JSON.stringify(failingSource, null, 2))
  const listeners6 = new Map()
  const settings6 = createSettings(() => loaderConfig6, listeners6)
  settings6.state.failNextUpdate = new Error('profile write refused')
  let loaderConfig6 = unwrap(Config, {})
  const harness6 = createHarness({ root: root6, settings: settings6, credentials: credentials1, listeners: listeners6, memoryFiles: new Map() })
  await plugin.apply(harness6.ctx, loaderConfig6)
  await settle()
  assert.equal(settings6.state.updateCalls.length, 0, 'the failed write must not count as a successful import')
  assert.equal(fs.existsSync(paths6.source), true, 'the source must be restored after a failed profile write')
  assert.equal(fs.existsSync(paths6.marker), false, 'and no .imported may be left behind')
  const failureView = await invoke(harness6.routes, 'GET', '/__dsh-messaging/status', { headers: loopback() })
  assert.ok(
    failureView.json.errors.some((entry) => entry.context === 'config import profile write'),
    'the failed profile write is recorded for the operator',
  )

  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
  console.log('config-migration: ok')
  console.log('imports:', settings1.state.updateCalls.length, '| profile writes:', settings4.state.updateCalls.length, '| mutates:', settings4.state.mutateCalls.length)
}

// loaderConfig 是 validate 出来的普通快照；这里只挑 volatile 字段当作 profile 现值。
function volatileOf(config) {
  const out = {}
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      const next = prefix.concat(key)
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, next)
      else if (pluginVolatilePaths.has(next.join('.'))) out[next.join('.')] = value
    }
  }
  walk(config, [])
  return out
}

// volatileOf 产出点号键（与 volatile 清单同形）；settings 的 values 是嵌套对象，
// 写入前先归位——否则 applyToConfig 会把点号键当成字面属性写进 loader。
function nestedOf(flat) {
  const out = {}
  for (const [key, value] of Object.entries(flat)) setPath(out, key.split('.'), value)
  return out
}

let pluginVolatilePaths = new Set()

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

async function bootstrapPaths(Config) {
  const collect = (node, prefix, out) => {
    if (!node || (typeof node !== 'object' && typeof node !== 'function')) return out
    if (node.dict && Object.keys(node.dict).length) {
      for (const key of Object.keys(node.dict)) collect(node.dict[key], prefix.concat(key), out)
      return out
    }
    if (node.meta && node.meta.volatile) out.add(prefix.join('.'))
    return out
  }
  pluginVolatilePaths = collect(Config, [], new Set())
  return pluginVolatilePaths
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
