'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不会被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// settings profile 动态持久化 + 落盘 + 冷重载回读（真实宿主通道，非 UI mutation mock）：
//   adapters.lark.interactiveCard 默认 false → settings.mutate 保存 true →
//   describe/runtime/profile/【磁盘 JSON】四证 true → 普通字段重启 fiber（热 reload）仍 true →
//   【冷重载】用磁盘 options 在全新 Context/Loader（全新内存，不 clone 原内存）重建 fiber
//   并挂真实 SettingsForms 再 describe/runtime 回读 true →
//   mutate 保存 false → 四证 false → 再次冷重载回读 false。
//
// 证据边界（如实声明）：
//   - dsh-settings（SettingsForms 的 mutate/describe）与 cordis Loader/fiber 为**真实执行**；
//   - 配置编辑器（configEditor）以及 shell / http(webServer) / fs / agents 等外围服务均为
//     测试替身：编辑器替身执行**真实 tmp 文件写读**（edit 时写 profile/package.json，
//     断言用 readFile 读回）；
//   - 冷重建使用全新 Context + 全新 Loader（全新内存，config 取自磁盘 JSON，不 clone
//     原内存），**不是新 OS 进程**；
//   - 本测试**不验证**宿主生产 configEditor 的实现或落盘格式（不在本仓库）。
// 落盘证据 = 保存后直接 readFile 断言 JSON 中 interactiveCard true/false；
// 冷重载证据 = 磁盘 options 重建 harness 后 describe/runtime 回读 true/false。
// 全程临时 home/profile（mkdtemp），不读写真实配置与凭据。
// 找不到 DSH 运行时或 dsh-settings 时整体跳过（与 loader-integration 同口径，不失败）。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const VW = Symbol.for('cosmokit.volatile.write')
const ENTRY_ID = 'dsh-messaging'

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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 本测试 fixture 定义的 profile 落盘形态（宿主生产 editor 的格式不在本仓库，不冒充验证）：
//   { version, entries: [{ id, name, config }] }
const profileShape = (pluginUrl, config) => ({
  version: 1,
  entries: [{ id: ENTRY_ID, name: pluginUrl, config }],
})

async function main() {
  const dir = dshModulesDir()
  if (!has(dir, 'cordis') || !has(dir, 'cordis-plugin-loader')) {
    console.log('lark-settings-persistence: SKIPPED — DSH runtime not found at ' + dir + ' (set DSH_NODE_MODULES)')
    process.exit(0)
  }
  if (!has(dir, 'dsh-settings')) {
    console.log('lark-settings-persistence: SKIPPED — dsh-settings not present at ' + dir)
    process.exit(0)
  }

  const { Context } = await importDsh(dir, 'cordis')
  const { Loader } = await importDsh(dir, 'cordis-plugin-loader')
  const { SettingsForms } = await importDsh(dir, 'dsh-settings')
  const pluginUrl = pathToFileURL(path.join(root, 'lib', 'index.js')).href
  const pluginModule = await import(pluginUrl)
  const { Config } = pluginModule

  // 冷重载独立 harness：全新 Context（全新内存）+ 从磁盘 options 构造的 entry。
  // editor 的 documentPath 指向独立新路径（冷 harness 只读回读，不覆盖一期证据）。
  async function bootHarness({ home, profileHome, documentPath, config }) {
    const routes = new Map()
    let registerCalls = 0
    let entry = null

    const ctx = new Context()
    ctx.provide('dshMessaging.root', home)
    ctx.provide('dsh.home', home)
    ctx.provide('sandboxPolicy', { workspaceRoot: home })
    ctx.provide('webServer', {
      register(route) {
        if (String(route.path).startsWith('/__dsh-messaging/')) registerCalls += 1
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
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
      async writeText() { return { version: 'v1' } },
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
    const credentialRecords = new Map()
    ctx.provide('credentials', {
      readRecord(key) { return Promise.resolve(credentialRecords.get(key)) },
      modifyRecord(key, mutate) {
        return Promise.resolve(mutate(credentialRecords.get(key))).then((next) => {
          if (next === undefined) return credentialRecords.get(key)
          credentialRecords.set(key, next)
          return next
        })
      },
      deleteRecord(key) { credentialRecords.delete(key); return Promise.resolve() },
    })

    // ── configEditor：测试替身（最小真实 fs 落盘；生产 editor 实现/格式不在验证范围）
    // mutate→edit 与 SettingsForms mutate/describe 的服务逻辑由真实 dsh-settings 执行，
    // 这里只补上宿主 editor 的最小等价物：写临时 profile/package.json + 更新内存 entry。
    ctx.provide('profileContext', {
      home: profileHome,
      dir: profileHome,
      patchPath: path.join(profileHome, 'package.json'),
      installAnchor: profileHome,
      name: 'test-profile',
    })
    ctx.provide('configEditor', {
      documentPath,
      configuration() { return [{ entry, inherited: {}, override: {} }] },
      entries() { return [entry] },
      edit(target, change) {
        const next = change(target.options.config, {})
        // 真实写盘（测试 tmp 路径）：保存动作必须留下磁盘证据
        fs.writeFileSync(documentPath, JSON.stringify(profileShape(pluginUrl, next), null, 2))
        return target.update({ config: next })
      },
    })

    const loader = new Loader(ctx, {})
    await sleep(10)
    const entryId = await loader.create({ id: ENTRY_ID, name: pluginUrl, config: clone(config) })
    await loader.await()
    entry = loader.resolve(entryId)
    assert.equal(entry.fiber.state, 2, 'the plugin fiber must be active at ' + home)
    const appliesAfterBoot = registerCalls

    const settings = await ctx.plugin(SettingsForms)
    await settings
    await settle()
    await settle()

    const describeValue = () => {
      const row = ctx.settings.describe({ redactSecrets: true }).find((r) => r.ns === ENTRY_ID)
      assert.ok(row, 'settings.describe must list the dsh-messaging form')
      return row
    }
    return {
      ctx,
      entry: () => entry,
      appliesAfterBoot: () => appliesAfterBoot,
      registerCalls: () => registerCalls,
      describeValue,
      runtimeCard: () => Boolean(plain(entry.fiber.config).adapters.lark.interactiveCard),
      profileCard: () => Boolean(entry.options.config.adapters && entry.options.config.adapters.lark && entry.options.config.adapters.lark.interactiveCard),
    }
  }

  // ── 一期 harness（真实 mutate 链路 + 真实落盘）──────────────────────────
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-settings-'))
  const profileHome = path.join(home, 'profile')
  fs.mkdirSync(profileHome, { recursive: true })
  const documentPath = path.join(profileHome, 'package.json')
  const readDiskConfig = () => {
    const doc = JSON.parse(fs.readFileSync(documentPath, 'utf8'))
    const row = doc.entries.find((e) => e.id === ENTRY_ID)
    assert.ok(row, 'the profile document must contain the dsh-messaging entry')
    return row.config
  }

  const h = await bootHarness({
    home,
    profileHome,
    documentPath,
    config: { adapters: { lark: { enabled: false } } },
  })
  assert.equal(h.entry().fiber.runtime.Config, Config, 'runtime.Config must be the exported schema')
  assert.ok(h.registerCalls() > 0, 'apply must have run')
  const bootRegisters = h.registerCalls()

  // ── 0) 默认：设置默认否；编辑器尚未写盘 ─────────────────────────────────
  assert.equal(typeof h.describeValue().revision, 'number', 'the settings row exposes the real revision')
  assert.equal(Boolean(h.describeValue().value.adapters.lark.interactiveCard), false, 'settings form 默认 interactiveCard=false')
  assert.equal(h.runtimeCard(), false, 'runtime 默认关闭')
  assert.equal(h.profileCard(), false, 'profile 默认未保存 true')
  assert.equal(fs.existsSync(documentPath), false, '保存前编辑器尚未落盘')

  // ── 1) 保存 true：真实 SettingsForms mutate → 热生效 + 编辑器真实落盘 ────
  const revision1 = h.describeValue().revision
  await h.ctx.settings.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'lark', 'interactiveCard'], value: true },
  ], revision1)
  await settle()
  await settle()
  assert.equal(Boolean(h.describeValue().value.adapters.lark.interactiveCard), true, 'mutate 保存 true 后 describe 回读 true')
  assert.equal(h.runtimeCard(), true, '运行时热生效 true')
  assert.equal(h.profileCard(), true, '内存 profile patch 持久化 true')
  assert.equal(h.registerCalls(), bootRegisters, 'volatile 保存不重启 fiber')
  assert.equal(fs.existsSync(documentPath), true, '保存后 profile/package.json 已真实写入 tmp')
  assert.equal(readDiskConfig().adapters.lark.interactiveCard, true, '磁盘 JSON 中 interactiveCard=true（直接 readFile 证据）')

  // ── 2) 热 reload（普通字段重启 fiber）→ 回读仍 true ─────────────────────
  const beforeReload1 = h.registerCalls()
  const reloadPatch1 = clone(h.entry().options.config)
  reloadPatch1.runtime = Object.assign({}, reloadPatch1.runtime, { nodePath: 'C:/reload-on.exe' })
  await h.entry().update({ config: reloadPatch1 })
  await settle()
  await settle()
  assert.ok(h.registerCalls() > beforeReload1, 'reload 必须真的重启 fiber')
  assert.equal(Boolean(h.describeValue().value.adapters.lark.interactiveCard), true, '热 reload 后 describe 回读 true')
  assert.equal(h.runtimeCard(), true, '热 reload 后运行时 true')
  assert.equal(readDiskConfig().adapters.lark.interactiveCard, true, '热 reload 不破坏磁盘证据')

  // ── 3) 冷重载 #1：全新 Context/Loader，config 取自磁盘 JSON（非 clone 内存）─
  const coldHome1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-cold1-'))
  const coldProfile1 = path.join(coldHome1, 'profile')
  fs.mkdirSync(coldProfile1, { recursive: true })
  const cold1 = await bootHarness({
    home: coldHome1,
    profileHome: coldProfile1,
    documentPath: path.join(coldProfile1, 'package.json'),
    config: clone(readDiskConfig()), // 从磁盘 options 重建，不引用一期内存对象
  })
  assert.equal(cold1.describeValue().value.adapters.lark.interactiveCard, true, '冷重载后 describe 回读 true')
  assert.equal(cold1.runtimeCard(), true, '冷重载后运行时 true')
  assert.equal(cold1.profileCard(), true, '冷重载 entry 的 profile 值 true')
  fs.rmSync(coldHome1, { recursive: true, force: true })

  // ── 4) 保存 false → 四证 false（含磁盘）────────────────────────────────
  const revision2 = h.describeValue().revision
  await h.ctx.settings.mutate(ENTRY_ID, [
    { op: 'set', path: ['adapters', 'lark', 'interactiveCard'], value: false },
  ], revision2)
  await settle()
  await settle()
  assert.equal(Boolean(h.describeValue().value.adapters.lark.interactiveCard), false, 'mutate 保存 false 后 describe 回读 false')
  assert.equal(h.runtimeCard(), false, '运行时热生效 false')
  assert.equal(h.profileCard(), false, '内存 profile patch 持久化 false')
  assert.equal(readDiskConfig().adapters.lark.interactiveCard, false, '磁盘 JSON 中 interactiveCard=false（直接 readFile 证据）')

  // ── 5) 冷重载 #2（磁盘 options）→ 回读 false；并恢复 nodePath ───────────
  const coldHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-cold2-'))
  const coldProfile2 = path.join(coldHome2, 'profile')
  fs.mkdirSync(coldProfile2, { recursive: true })
  const diskConfig2 = clone(readDiskConfig())
  diskConfig2.runtime = Object.assign({}, diskConfig2.runtime, { nodePath: '' }) // 冷配置自带恢复
  const cold2 = await bootHarness({
    home: coldHome2,
    profileHome: coldProfile2,
    documentPath: path.join(coldProfile2, 'package.json'),
    config: diskConfig2,
  })
  assert.equal(cold2.describeValue().value.adapters.lark.interactiveCard, false, '再次冷重载后回读 false')
  assert.equal(cold2.runtimeCard(), false, '再次冷重载后运行时 false')
  fs.rmSync(coldHome2, { recursive: true, force: true })

  // 一期痕迹恢复：nodePath 归零（普通字段，触发最后一次重启）
  const finalPatch = clone(h.entry().options.config)
  finalPatch.runtime = Object.assign({}, finalPatch.runtime, { nodePath: '' })
  await h.entry().update({ config: finalPatch })
  await settle()
  await settle()
  assert.equal(plain(h.entry().fiber.config).runtime.nodePath, '', 'nodePath 已恢复，不留测试残留')
  assert.equal(Boolean(h.describeValue().value.adapters.lark.interactiveCard), false, '最终回读 false')

  // 0.3.3 newly surfaced defaults/capacity are actually volatile writable Host fields.
  const defaultsOps = [
    { op: 'set', path: ['agent', 'agentPreset'], value: 'standard' },
    { op: 'set', path: ['agent', 'cwd'], value: profileHome },
    { op: 'set', path: ['agent', 'provider'], value: 'fixture-provider' },
    { op: 'set', path: ['agent', 'model'], value: 'fixture-model' },
    { op: 'set', path: ['adapters', 'lark', 'sendCapacity'], value: 3000 },
  ]
  await h.ctx.settings.mutate(ENTRY_ID, defaultsOps, h.describeValue().revision)
  await settle(); await settle()
  const defaultsView = h.describeValue().value
  for (const op of defaultsOps) {
    const read = (root) => op.path.reduce((node, key) => node[key], root)
    assert.equal(read(defaultsView), op.value, 'new UI field is accepted by real SettingsForms')
    assert.equal(read(readDiskConfig()), op.value, 'new UI field persisted to synthetic profile disk')
  }
  fs.rmSync(home, { recursive: true, force: true })
  console.log('lark-settings-persistence: ok (false→true→disk true→warm/cold reload true→false→disk false→cold reload false; agent defaults + sendCapacity accepted/persisted)')
  // 宿主侧 fiber 会留定时器，成功/失败都直接退出，不挂 npm test。
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
