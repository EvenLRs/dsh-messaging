'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P2a 可选集成测试：用真实的 cordis + cordis-plugin-loader（可选再加 dsh-settings）
// 装载本插件，验证官方设置页契约：
//   1. Loader 从 fiber.runtime.Config 发现 schema；
//   2. volatile 字段是引用，改它走 loader/volatile-update、**fiber 不重启**；
//   3. 普通字段变更照旧重启 fiber（apply 重新执行）；
//   4. settings.describe 出现本插件表单，role('secret') 字段被脱敏。
// 找不到 DSH 运行时目录时整体跳过（不失败）。路径优先取 DSH_NODE_MODULES，
// 否则用本包已安装的 node_modules/@deepseek-ai（与 npm install 拉到的同版本）。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const VW = Symbol.for('cosmokit.volatile.write')

// fiber.config 的 volatile 叶子是写时引用（Vw ref）；取运行时真值先解引用。
const plain = (value) => {
  if (value && typeof value === 'object' && VW in value) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  }
  return value
}

function dshModulesDir() {
  const candidates = []
  if (process.env.DSH_NODE_MODULES) candidates.push(process.env.DSH_NODE_MODULES)
  candidates.push(path.join(root, 'node_modules', '@deepseek-ai'))
  for (const candidate of candidates) {
    // DSH_NODE_MODULES 既可能指向 node_modules 本身，也可能直接指向 @deepseek-ai 目录。
    if (has(candidate, 'cordis')) return candidate
    if (has(path.join(candidate, '@deepseek-ai'), 'cordis')) return path.join(candidate, '@deepseek-ai')
  }
  return candidates[0]
}

function has(dir, name) {
  return fs.existsSync(path.join(dir, name, 'package.json'))
}

async function importDsh(dir, name) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, name, 'package.json'), 'utf8'))
  const entry = (pkg.exports && pkg.exports['.'] && (pkg.exports['.'].default || pkg.exports['.'])) || pkg.module || pkg.main
  return import(pathToFileURL(path.join(dir, name, entry)).href)
}

function skip(reason) {
  console.log('loader-integration: SKIPPED — ' + reason)
}

async function main() {
  const dir = dshModulesDir()
  if (!has(dir, 'cordis') || !has(dir, 'cordis-plugin-loader')) {
    return skip('DSH runtime not found at ' + dir + ' (set DSH_NODE_MODULES to a node_modules containing @deepseek-ai/cordis and cordis-plugin-loader)')
  }

  const { Context } = await importDsh(dir, 'cordis')
  const { Loader } = await importDsh(dir, 'cordis-plugin-loader')
  const pluginUrl = pathToFileURL(path.join(root, 'lib', 'index.js')).href
  const pluginModule = await import(pluginUrl)
  const { Config } = pluginModule

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-loader-'))
  const routes = new Map()
  const routeOps = new Map() // path -> { register, unregister }
  const written = []
  // 应用一次会注册多条路由；只关心「注册次数有没有变」（重启才会重新注册）。
  let registerCalls = 0

  const bumpRoute = (routePath, kind) => {
    const record = routeOps.get(routePath) || { register: 0, unregister: 0 }
    record[kind] += 1
    routeOps.set(routePath, record)
  }

  const ctx = new Context()
  ctx.provide('dshMessaging.root', home)
  ctx.provide('dsh.home', home)
  ctx.provide('sandboxPolicy', { workspaceRoot: home })
  ctx.provide('webServer', {
    register(route) {
      // 只统计 UI 路由（apply 里注册）：webhook 路由每次 rebuild 都会重新注册，
      // 混进去就分不清“重启 fiber”和“只是重建适配器”。
      if (String(route.path).startsWith('/__dsh-messaging/')) registerCalls += 1
      routes.set(route.path, route.handler)
      bumpRoute(route.path, 'register')
      return () => {
        routes.delete(route.path)
        bumpRoute(route.path, 'unregister')
      }
    },
  })
  ctx.provide('shell', {
    resolve: (spec) => spec,
    async run() {
      return {
        exitCode: 0, timedOut: false, aborted: false, timeoutMs: 60000,
        stdout: { text: '\n__DSH_STATUS__:200', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
    start() { return { status: 'running', kill() { return false } } },
  })
  ctx.provide('fs', {
    async resolve(target) { return { displayPath: target, targetKey: target } },
    async readText() { const error = new Error('not found'); error.code = 'FS_NOT_FOUND'; throw error },
    async writeText(target, content) { written.push(content); return { version: 'v1' } },
  })
  ctx.provide('agents', {
    async create(options) { return { agent: { id: options.sessionId, followup() {} }, async dispose() {} } },
    async resume() { const error = new Error('not found'); error.name = 'SessionPersistenceNotFoundError'; throw error },
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => null })
  ctx.provide('timer', {
    timeout(fn, ms) { const handle = setTimeout(fn, ms); return () => clearTimeout(handle) },
    interval(fn, ms) { const handle = setInterval(fn, ms); return () => clearInterval(handle) },
  })
  ctx.mixin('timer', ['timeout', 'interval'])

  // ── P2b：内存版 credentials 桩（record 语义对齐 dsh-credentials-local）──
  const credentialRecords = new Map()
  const credentialsStub = {
    readRecord(key) { return Promise.resolve(credentialRecords.get(key)) },
    modifyRecord(key, mutate) {
      return Promise.resolve(mutate(credentialRecords.get(key))).then((next) => {
        if (next === undefined) return credentialRecords.get(key)
        credentialRecords.set(key, next)
        ctx.emit('credentials/record-updated', key)
        return next
      })
    },
    deleteRecord(key) {
      if (credentialRecords.has(key)) {
        credentialRecords.delete(key)
        ctx.emit('credentials/record-updated', key)
      }
      return Promise.resolve()
    },
  }
  ctx.provide('credentials', credentialsStub)

  // ── P2b：先放一份旧 config.json，settings 就绪后插件应当一次性导入 ────
  const legacyDir = path.join(home, '.dsh-messaging')
  fs.mkdirSync(legacyDir, { recursive: true })
  const legacySource = path.join(legacyDir, 'config.json')
  const legacyMarker = path.join(legacyDir, 'config.json.imported')
  fs.writeFileSync(legacySource, JSON.stringify({
    version: 1,
    workspaceRoot: home,
    runtime: { nodePath: '', wsModulePath: '', companionDir: '', pollIntervalMs: 2500, telegramLongPollTimeoutSec: 40, shellTimeoutMs: 60000, stdoutMaxBytes: 2097152 },
    adapters: {
      onebot: {
        enabled: true,
        endpoint: 'http://127.0.0.1:5700',
        accessToken: 'ob-access-PLAINTEXT-0001',
        secret: 'ob-secret-PLAINTEXT-0001',
        webhookPath: '/messaging/onebot',
        selfId: null,
      },
      wechat: { enabled: false, token: 'wechat-botToken-PLAINTEXT-0001', baseUrl: 'https://ilinkai.weixin.qq.com', botAgent: 'dsh-messaging', pollIntervalMs: 2500, longPollTimeoutSec: 35 },
    },
  }, null, 2))

  const loader = new Loader(ctx, {})
  // Loader 构造时才挂上 isolate 钩子（entry-init 会给每个 entry 造独立 isolate），
  // 不等它就建 entry 会撞 "Cyclic __proto__ value"。
  await new Promise((resolve) => setTimeout(resolve, 10))

  const initialConfig = { adapters: { telegram: { enabled: false, webhookPath: '/messaging/telegram/webhook' } } }
  const entryId = await loader.create({ id: 'dsh-messaging', name: pluginUrl, config: clone(initialConfig) })
  await loader.await()
  const entry = loader.resolve(entryId)

  // ── 1. Loader 从 fiber.runtime.Config 发现 schema，fiber 进入活动态 ────────
  assert.equal(entry.fiber.state, 2, 'the plugin fiber must be active')
  assert.equal(entry.fiber.runtime.Config, Config, 'runtime.Config must be the exported schema')
  assert.ok(VW in entry.fiber.config.adapters.telegram.token, 'a volatile leaf must arrive as a reference')
  assert.equal(VW in entry.fiber.config.adapters.discord.intents, true, 'intents is a form field and is volatile')
  const appliesAfterBoot = registerCalls
  assert.ok(appliesAfterBoot > 0, 'apply must have run')

  // P5 收口：/config 路由已删——配置视图不再有任何 HTTP 读取面。同一组不变量改从两条
  // 真实通道读：运行时 = plain(entry.fiber.config)（Loader 组合层）；线上 =
  // settings.describe({ redactSecrets: true })（§4 起，页面 mirror 拿的就是它）。
  const runtimeView = () => plain(entry.fiber.config)

  const before = runtimeView()
  assert.equal(before.adapters.telegram.webhookPath, '/messaging/telegram/webhook')
  assert.equal(Boolean(before.adapters.telegram.token), false, 'no token yet')

  // ── 2. 只改 volatile 字段 → loader/volatile-update，fiber 不重启 ───────────
  const volatilePatch = clone(entry.options.config)
  volatilePatch.adapters.telegram.webhookPath = '/hooks/tg-volatile'
  volatilePatch.adapters.telegram.token = '8001234567:AAE-VOLATILE-UPDATE'
  await entry.update({ config: volatilePatch })
  await settle()

  assert.equal(entry.fiber.state, 2, 'the fiber stays active after a volatile update')
  assert.equal(registerCalls, appliesAfterBoot, 'a volatile-only change must not restart the fiber')
  const afterVolatile = runtimeView()
  assert.equal(afterVolatile.adapters.telegram.webhookPath, '/hooks/tg-volatile', 'the volatile value must reach the running plugin')
  assert.equal(afterVolatile.adapters.telegram.token, '8001234567:AAE-VOLATILE-UPDATE', 'the new secret reaches the runtime; its wire redaction is asserted in §4 via settings.describe')
  assert.equal(Boolean(entry.options.config.adapters.telegram.token), true, 'the new secret must be stored in the profile patch')
  assert.equal(afterVolatile.runtime.nodePath, '', 'ordinary fields are untouched by a volatile write')

  // ── 3. 普通字段变更 → 重启 fiber（apply 重新执行）────────────────────────
  const ordinaryPatch = clone(entry.options.config)
  ordinaryPatch.runtime = Object.assign({}, ordinaryPatch.runtime, { nodePath: 'C:/node.exe' })
  await entry.update({ config: ordinaryPatch })
  await settle()
  assert.ok(registerCalls > appliesAfterBoot, 'an ordinary config change must restart the fiber')
  const afterOrdinary = runtimeView()
  assert.equal(afterOrdinary.runtime.nodePath, 'C:/node.exe', 'the ordinary value must survive the restart')
  assert.equal(afterOrdinary.adapters.telegram.webhookPath, '/hooks/tg-volatile', 'volatile values survive an ordinary restart')
  assert.equal(afterOrdinary.adapters.telegram.token, '8001234567:AAE-VOLATILE-UPDATE', 'secrets survive an ordinary restart')

  // ── 4. settings.describe：表单出现 + 密钥被脱敏 + mutate 触发热更新 ───────
  let settingsChecked = false
  if (has(dir, 'dsh-settings')) {
    const { SettingsForms } = await importDsh(dir, 'dsh-settings')
    const profileHome = path.join(home, 'profile')
    fs.mkdirSync(profileHome, { recursive: true })
    ctx.provide('profileContext', {
      home: profileHome,
      dir: profileHome,
      patchPath: path.join(profileHome, 'package.json'),
      installAnchor: profileHome,
      name: 'test-profile',
    })
    ctx.provide('configEditor', {
      documentPath: path.join(profileHome, 'package.json'),
      configuration() { return [{ entry, inherited: {}, override: {} }] },
      entries() { return [entry] },
      edit(target, change) {
        const next = change(target.options.config, {})
        return target.update({ config: next })
      },
    })
    const settings = await ctx.plugin(SettingsForms)
    await settings

    // ── P2b 导入：settings 一就绪，插件就把旧 config.json 一次性搬进 profile ──
    await settle()
    await settle()
    assert.ok(fs.existsSync(legacyMarker), 'the import must write its marker')
    assert.equal(fs.existsSync(legacySource), false, 'the legacy source must be renamed away')
    const migratedRecord = credentialRecords.get('dsh-messaging/wechat-bot')
    assert.ok(migratedRecord && migratedRecord.payload.token === 'wechat-botToken-PLAINTEXT-0001', 'the legacy WeChat token lands in the credentials record')
    assert.equal(entry.options.config.adapters.onebot.secret, 'ob-secret-PLAINTEXT-0001', 'secrets land in the profile patch')
    assert.equal(entry.options.config.adapters.onebot.accessToken, 'ob-access-PLAINTEXT-0001', 'the outbound token is imported')
    assert.equal(entry.options.config.adapters.wechat && entry.options.config.adapters.wechat.token, undefined, 'the WeChat token is never imported into Config')
    const importedWire = ctx.settings.describe({ redactSecrets: true })
    const importedRow = importedWire.find((row) => row.ns === 'dsh-messaging')
    assert.equal(typeof importedRow.revision, 'number', 'the settings row exposes the real revision')
    assert.ok(
      importedRow.secrets.some((row) => row.path.join('.') === 'adapters.onebot.secret' && row.set === true),
      'the imported secret reaches the sidecar',
    )
    assert.equal(JSON.stringify(importedWire).includes('ob-secret-PLAINTEXT-0001'), false, 'and stays redacted on the wire')

    const descriptors = ctx.settings.describe({ redactSecrets: true })
    const descriptor = descriptors.find((row) => row.ns === 'dsh-messaging')
    assert.ok(descriptor, 'settings.describe must list the dsh-messaging form')
    // describe 回的是 toJSON()（可能带 refs 表），用 schemastery 重建回活 schema 再导航。
    const z = require('@deepseek-ai/schemastery')
    const form = new z(descriptor.schema)
    assert.ok(form.dict.adapters.dict.telegram.dict.token, 'the form must declare the token field')
    assert.equal(form.dict.adapters.dict.telegram.dict.token.meta.role, 'secret', 'the form keeps the secret role')
    assert.equal(form.dict.adapters.dict.telegram.dict.token.meta.default, undefined, 'plainSchema drops secret defaults from the form')
    assert.equal(descriptor.value.adapters.telegram.token, undefined, 'describe must not return the secret plaintext')
    assert.ok(descriptor.secrets.some((entry) => entry.path.join('.') === 'adapters.telegram.token' && entry.set === true), 'the secret sidecar must report "stored"')
    assert.equal(descriptor.value.adapters.telegram.webhookPath, '/hooks/tg-volatile', 'ordinary form fields come back verbatim')

    const appliesBeforeMutate = registerCalls
    const revision = descriptor.revision
    await ctx.settings.mutate('dsh-messaging', [
      { op: 'set', path: ['adapters', 'telegram', 'webhookPath'], value: '/hooks/tg-mutated' },
      { op: 'set', path: ['adapters', 'telegram', 'token'], value: '8001234567:AAE-MUTATED-UPDATE' },
    ], revision)
    await settle()
    assert.equal(registerCalls, appliesBeforeMutate, 'settings.mutate on volatile fields must not restart the fiber')
    const afterMutateRow = ctx.settings.describe({ redactSecrets: true }).find((row) => row.ns === 'dsh-messaging')
    assert.equal(afterMutateRow.value.adapters.telegram.webhookPath, '/hooks/tg-mutated', 'mutate must reach the running plugin')
    assert.ok(
      afterMutateRow.secrets.some((row) => row.path.join('.') === 'adapters.telegram.token' && row.set === true),
      'the mutated secret is stored',
    )
    assert.equal(afterMutateRow.value.adapters.telegram.token, undefined, 'the mutated secret stays redacted')

    // 非 volatile 路径必须被拒绝（dsh-settings 的硬约束）。
    await assert.rejects(
      () => ctx.settings.mutate('dsh-messaging', [{ op: 'set', path: ['runtime', 'nodePath'], value: 'C:/other.exe' }], revision),
      /is not volatile/,
      'writing an ordinary path through the form must be refused',
    )

    // ── P2b 追加需求：改出站地址 → 插件经 settings.mutate 回写清除 ─────────
    const registerCallsBeforeAddress = registerCalls
    const addressRevision = ctx.settings.describe().find((row) => row.ns === 'dsh-messaging').revision
    await ctx.settings.mutate('dsh-messaging', [
      { op: 'set', path: ['adapters', 'onebot', 'endpoint'], value: 'http://127.0.0.1:6000' },
    ], addressRevision)
    await settle()
    await settle()
    assert.equal(
      entry.options.config.adapters.onebot.accessToken,
      '',
      'the plugin must write the token clear back through settings.mutate',
    )
    assert.equal(registerCalls, registerCallsBeforeAddress, 'the write-back must not restart the fiber')
    const addressStatus = await callRoute(routes.get('/__dsh-messaging/status'), 'GET', '/__dsh-messaging/status')
    assert.ok(
      addressStatus.json.errors.some((row) => /outbound address changed|出站地址已变更/.test(row.message)),
      'the clear must be announced in status.errors',
    )
    assert.equal(addressStatus.text.includes('ob-access-PLAINTEXT-0001'), false, 'the announcement must not leak the cleared token')

    // ── P2c：真实 loader/volatile-update 路径同样只重建受影响的渠道 ────────
    const onebotOpsBeforeScope = { ...(routeOps.get('/messaging/onebot') || { register: 0, unregister: 0 }) }
    const uiBeforeScope = registerCalls
    const scopeRevision = ctx.settings.describe().find((row) => row.ns === 'dsh-messaging').revision
    await ctx.settings.mutate('dsh-messaging', [
      { op: 'set', path: ['adapters', 'lark', 'appId'], value: 'cli_p2c_scope' },
    ], scopeRevision)
    await settle()
    await settle()
    assert.deepEqual(
      routeOps.get('/messaging/onebot'),
      onebotOpsBeforeScope,
      'a lark-only change must not tear down the onebot route (incremental rebuild)',
    )
    assert.equal(registerCalls, uiBeforeScope, 'a scoped rebuild must not restart the fiber')
    const scopeStatus = await callRoute(routes.get('/__dsh-messaging/status'), 'GET', '/__dsh-messaging/status')
    const scopeReloads = scopeStatus.json.recent
      .filter((row) => row.kind === 'reload' && row.channel)
      .map((row) => row.channel)
    assert.equal(scopeReloads[scopeReloads.length - 1], 'lark', 'the scoped rebuild is announced for the lark channel')
    assert.equal(entry.options.config.adapters.lark.appId, 'cli_p2c_scope', 'the volatile value landed in the profile')
    settingsChecked = true
  } else {
    console.log('loader-integration: dsh-settings not present at ' + dir + ', skipping the settings.describe part')
  }

  fs.rmSync(home, { recursive: true, force: true })
  console.log('loader-integration: ok')
  console.log('route registrations:', registerCalls, '| settings.describe checked:', settingsChecked)
  process.exit(0)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

async function callRoute(handler, method, url) {
  const { EventEmitter } = require('node:events')
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  req.socket = { encrypted: false }
  req.destroy = () => {}
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = (status, headers) => { res.statusCode = status; res.headersSent = true }
  res.end = (body) => { res.body = body; res.finished = true }
  queueMicrotask(() => req.emit('end'))
  await handler(req, res)
  await new Promise((resolve) => setTimeout(resolve, 5))
  let json = null
  if (res.body) { try { json = JSON.parse(res.body) } catch { json = res.body } }
  return { status: res.statusCode, json, text: res.body }
}

main().catch((error) => {
  console.error(error)
  // 直接退出：宿主侧挂载会留下定时器/ fiber，不能让失败的断言把 npm test 卡死。
  process.exit(1)
})
