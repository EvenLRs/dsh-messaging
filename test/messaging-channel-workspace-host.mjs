// 0.3.6/0.3.7 渠道默认工作区与成员登记：真实 Cordis 作用域 + 真实宿主工作区栈（dsh-workspace 注册表、
// dsh-api-workspace-controller）+ 真实插件 ctx.plugin(plugin, config)。
// 只 fake：webServer 路由表、shell、fs.resolve、agents（记录 create/resume 的 meta）、
// 默认模型。OneBot 入站为本地签名 webhook，无网络、无模型、无真实 ~/.dsh 或 Documents。
//
// 用法：DSH_HOSTX_ROOT=<解包宿主根> node test/messaging-channel-workspace-host.mjs
import './_guard.cjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOSTX = path.resolve(process.env.DSH_HOSTX_ROOT || '/tmp/dsh-hostx')
const HOST_MODULES = path.join(HOSTX, 'dsh', 'node_modules', '@deepseek-ai')
if (!fs.existsSync(path.join(HOST_MODULES, 'dsh-api-workspace-controller'))) {
  console.error('messaging-channel-workspace-host: FATAL — unpacked host with dsh-api-workspace-controller not found at ' + HOST_MODULES)
  process.exit(1)
}
const imp = async (pkg) => {
  const mod = await import(pathToFileURL(path.join(HOST_MODULES, pkg, 'lib', 'index.js')).href)
  return mod.default ?? mod
}
const { Context } = await import(pathToFileURL(path.join(HOST_MODULES, 'cordis', 'lib', 'index.js')).href)
const plugin = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'index.js')).href)

const SECRET = 'chws-secret'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, label, ms = 5000) {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > ms) throw new Error('timeout waiting for ' + label)
    await sleep(10)
  }
}

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('PASS | ' + name)
  } catch (error) {
    results.push({ name, ok: false })
    console.log('FAIL | ' + name + ' | ' + (error && error.stack ? error.stack : error))
  }
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
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {}; res.headersSent = true }
  res.end = (body) => { res.body = body; res.finished = true }
  return res
}

async function mount({ workspaceStack = true, cwd = '', home: reuseHome, docs: reuseDocs, temp: reuseTemp } = {}) {
  const temp = reuseTemp || await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chws-host-'))
  const home = reuseHome || path.join(temp, 'dsh-home')
  const msgRoot = path.join(temp, 'messaging-root')
  const docs = reuseDocs || path.join(temp, 'Documents')
  for (const dir of [home, msgRoot, docs]) await fsp.mkdir(dir, { recursive: true })

  const routes = new Map()
  const created = []
  const resumed = []
  const persisted = (mount.persisted ||= new Map()) // sessionId -> cwd，跨 mount 模拟持久化
  const live = new Map()
  const makeHandle = (id, cwd) => {
    const agent = {
      id,
      session: { id, header: { cwd } },
      messages: [],
      ctx: { get() { return undefined } },
      followup(message) { agent.messages.push(message) },
    }
    live.set(id, agent)
    return { agent, async dispose() { if (live.get(id) === agent) live.delete(id) } }
  }
  const agents = {
    async create(options) {
      const id = options.sessionId
      if (persisted.has(id)) throw Object.assign(new Error('session exists'), { name: 'SessionAlreadyExistsError' })
      persisted.set(id, options.meta?.cwd)
      created.push(options)
      return makeHandle(id, options.meta?.cwd)
    },
    async resume(options) {
      const id = options.resumeSessionId
      resumed.push(options)
      if (!persisted.has(id)) throw Object.assign(new Error('session not found'), { name: 'SessionPersistenceNotFoundError' })
      return makeHandle(id, persisted.get(id))
    },
    get(id) { return live.get(id) },
    list() { return [...live.values()] },
  }

  const ctx = new Context()
  await ctx.plugin(await imp('cordis-plugin-timer'))
  ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
  ctx.provide('shell', {
    resolve: (request) => request,
    async run(request) {
      const done = (text) => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text, truncated: false }, stderr: { text: '', truncated: false } })
      // OneBot 签名校验走 companion crypto-helper（经 shell）。这里按同一 HMAC-SHA1 规则真算，
      // 不是一律放行：错误签名仍返回 ok:false。
      const command = String(request && request.command || '')
      if (command.includes('crypto-helper.cjs') && command.includes('verify')) {
        const input = JSON.parse(String(request.stdin || '{}'))
        const expected = Buffer.from('sha1=' + crypto.createHmac('sha1', String(input.secret)).update(String(input.rawBody), 'utf8').digest('hex'))
        const actual = Buffer.from(String(input.signature || ''))
        return done(JSON.stringify({ ok: actual.length === expected.length && crypto.timingSafeEqual(actual, expected) }))
      }
      return done('{}\n__DSH_STATUS__:200')
    },
    start() { return { status: 'running', done: Promise.resolve(), readOutput() { return { delta: '', lossy: false } }, kill() { return false } } },
  })
  ctx.provide('fs', { async resolve(p) { return { displayPath: String(p), targetKey: String(p) } } })
  ctx.provide('agents', agents)
  ctx.provide('agentDefaultModel', { currentSelection() { return { provider: 'mock', model: 'm' } } })
  ctx.provide('dsh.home', home)
  ctx.provide('dshMessaging.root', msgRoot)

  if (workspaceStack) {
    ctx.provide('sessionPersistence', {
      list: async () => [...persisted].map(([id, cwd]) => ({ header: { id, cwd } })),
    })
    await ctx.plugin(await imp('dsh-session'))
    await ctx.plugin(await imp('dsh-storage'))
    await ctx.plugin(await imp('dsh-storage-json'), { root: path.join(temp, 'storage') })
    await ctx.plugin(await imp('dsh-storage-domain'), { backend: 'json' })
    await ctx.plugin(await imp('dsh-workspace'))
    await ctx.plugin(await imp('dsh-typert-registry'))
    await ctx.plugin(await imp('dsh-api-remote-access'))
    await ctx.plugin(await imp('dsh-api-workspace-controller'), { documentsDirectory: docs })
    await until(() => ctx.get('workspaceController') && ctx.get('workspaceRegistry'), 'real workspace services')
  }

  const config = plugin.defaultConfig(msgRoot)
  config.agent = { ...config.agent, cwd }
  config.adapters.onebot = { ...config.adapters.onebot, enabled: true, secret: SECRET, accessToken: 'chws-token' }
  const fiber = await ctx.plugin(plugin, config)
  await until(() => routes.has('/messaging/onebot'), 'onebot webhook route')

  async function inbound(userId, text = 'hello from ' + userId) {
    const before = created.length + resumed.length
    const body = JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: userId, self_id: 999,
      raw_message: text, sender: { user_id: userId, nickname: 'chws' },
    })
    const signature = crypto.createHmac('sha1', SECRET).update(body, 'utf8').digest('hex')
    const res = fakeResponse()
    await routes.get('/messaging/onebot')(fakeRequest('POST', '/messaging/onebot', body, {
      'content-type': 'application/json', 'x-signature': 'sha1=' + signature, 'x-self-id': '999',
    }), res)
    await until(() => created.length + resumed.length > before, 'agent create/resume for user ' + userId)
    await until(() => [...live.values()].some(a => a.messages.some(m => m.content?.[0]?.text === text)), 'message delivered for user ' + userId)
  }
  async function status() {
    const res = fakeResponse()
    await routes.get('/__dsh-messaging/status')(fakeRequest('GET', '/__dsh-messaging/status', '', {
      origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080',
    }), res)
    await until(() => res.finished, 'status response')
    return JSON.parse(res.body)
  }
  const registry = () => ctx.get('workspaceRegistry')
  const controller = () => ctx.get('workspaceController')
  const defaultDir = path.join(docs, 'deepseek-harness', 'default-workspace')
  const marker = (channel) => path.join(home, 'messaging-channel-workspaces-v1', channel + '.json')
  async function dispose() { try { fiber.dispose() } catch { /* already disposed */ } try { await ctx.registry?.dispose?.() } catch { /* best effort */ } }
  return { ctx, temp, home, docs, msgRoot, routes, created, resumed, inbound, status, registry, controller, defaultDir, marker, dispose }
}

function noChannelWorkspaceError(snapshot) {
  const errors = (snapshot.errors || []).filter(e => e.context === 'channel workspace')
  const onebot = (snapshot.channels || []).find(c => c.key === 'onebot')
  assert.deepEqual(errors, [], 'no channel workspace error for expected fallback')
  assert.ok(!onebot || !onebot.lastError, 'onebot lastError must stay empty: ' + (onebot && onebot.lastError))
}

await test('required inject list unchanged; workspace services stay optional', () => {
  assert.deepEqual(plugin.inject, ['webServer', 'shell', 'fs', 'agents', 'timer', 'agentDefaultModel'])
})

await test('real host: first OneBot session creates default-workspace/onebot, registers it and uses it as cwd', async () => {
  mount.persisted = new Map()
  const env = await mount()
  try {
    await env.inbound(2001, 'first')
    assert.equal(env.created.length, 1)
    const realDefault = await fsp.realpath(env.defaultDir)
    const expected = path.join(realDefault, 'onebot')
    assert.equal(env.created[0].meta.cwd, expected, 'new session cwd is the channel workspace')
    assert.ok(fs.statSync(expected).isDirectory())
    const list = env.registry().list()
    const paths = list.map(w => w.path)
    assert.ok(paths.includes(realDefault), 'host default workspace initialized via real controller')
    const channelWs = list.find(w => w.path === expected)
    assert.ok(channelWs, 'channel folder registered as its own Workspace (exact cwd match)')
    assert.equal(channelWs.title, 'onebot')
    const row = JSON.parse(fs.readFileSync(env.marker('onebot'), 'utf8'))
    assert.equal(row.workspaceId, channelWs.id ?? channelWs.workspaceId)
    assert.equal(row.path, expected)
    noChannelWorkspaceError(await env.status())

    // 第二个会话（另一私聊）复用同一渠道工作区，不新增登记。
    await env.inbound(2002, 'second')
    assert.equal(env.created.length, 2)
    assert.equal(env.created[1].meta.cwd, expected)
    assert.equal(env.registry().list().length, list.length, 'no duplicate registration')
  } finally { await env.dispose() }
})

await test('real host: resumed session keeps its stored cwd and does not consult channel workspaces', async () => {
  mount.persisted = new Map()
  const first = await mount()
  const keep = { temp: first.temp, home: first.home, docs: first.docs }
  let getCalls = 0
  try {
    await first.inbound(3001, 'before restart')
  } finally { await first.dispose() }
  const env = await mount({ ...keep })
  try {
    const reg = env.registry()
    const original = reg.get.bind(reg)
    reg.get = (id) => { getCalls += 1; return original(id) }
    await env.inbound(3001, 'after restart')
    assert.equal(env.created.length, 0, 'existing session is resumed, not created')
    assert.equal(env.resumed.length, 1)
    assert.equal(env.resumed[0].meta, undefined, 'resume passes no new cwd')
    assert.equal(getCalls, 0, 'resume path never resolves a channel workspace')
  } finally { await env.dispose() }
})

await test('real host: explicit agent.cwd wins; no default or channel workspace is created', async () => {
  mount.persisted = new Map()
  const explicit = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chws-explicit-'))
  const env = await mount({ cwd: explicit })
  try {
    await env.inbound(4001)
    assert.equal(env.created[0].meta.cwd, explicit)
    assert.equal(env.registry().list().length, 0, 'registry untouched')
    assert.equal(fs.existsSync(env.defaultDir), false, 'default workspace not initialized by the plugin')
    assert.equal(fs.existsSync(env.marker('onebot')), false)
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host: explicit agent.cwd equal to workspaceRoot still counts as explicit', async () => {
  mount.persisted = new Map()
  const probe = await mount()
  const root = probe.msgRoot
  await probe.dispose()
  const env = await mount({ cwd: root, temp: probe.temp, home: path.join(probe.temp, 'home2'), docs: path.join(probe.temp, 'docs2') })
  try {
    await env.inbound(4101)
    assert.equal(env.created[0].meta.cwd, root)
    assert.equal(fs.existsSync(env.marker('onebot')), false)
  } finally { await env.dispose() }
})

await test('real host: removing the channel workspace registration falls back silently and never re-registers', async () => {
  mount.persisted = new Map()
  const env = await mount()
  try {
    await env.inbound(5001)
    const expected = env.created[0].meta.cwd
    const ws = env.registry().list().find(w => w.path === expected)
    await env.controller().delete({ workspaceId: ws.id ?? ws.workspaceId })
    await env.inbound(5002)
    assert.equal(env.created[1].meta.cwd, env.msgRoot, 'falls back to the original default cwd')
    assert.ok(!env.registry().list().some(w => w.path === expected), 'not re-registered')
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host: deleting the channel folder falls back silently and does not recreate it', async () => {
  mount.persisted = new Map()
  const env = await mount()
  try {
    await env.inbound(5101)
    const dir = env.created[0].meta.cwd
    fs.rmSync(dir, { recursive: true, force: true })
    await env.inbound(5102)
    assert.equal(env.created[1].meta.cwd, env.msgRoot)
    assert.equal(fs.existsSync(dir), false)
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('host without workspace services: original cwd, no marker, no error', async () => {
  mount.persisted = new Map()
  const env = await mount({ workspaceStack: false })
  try {
    await env.inbound(6001)
    assert.equal(env.created[0].meta.cwd, env.msgRoot)
    assert.equal(fs.existsSync(path.join(env.home, 'messaging-channel-workspaces-v1')), false)
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host: registration failure falls back, records one fixed non-fatal diagnostic without paths', async () => {
  mount.persisted = new Map()
  const env = await mount()
  try {
    const controller = env.controller()
    controller.create = async () => { throw new Error('boom at ' + env.temp) }
    await env.inbound(7001)
    assert.equal(env.created[0].meta.cwd, env.msgRoot, 'session still created with original cwd')
    const snapshot = await env.status()
    const errors = (snapshot.errors || []).filter(e => e.context === 'channel workspace')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'channel workspace unavailable')
    assert.equal(errors[0].channel, 'onebot')
    const text = JSON.stringify([errors, snapshot.channels])
    assert.ok(!text.includes(env.temp) && !text.includes('boom'), 'diagnostic never echoes host error text or paths')
    const onebot = snapshot.channels.find(c => c.key === 'onebot')
    assert.notEqual(onebot.state, 'error', 'non-fatal: channel not marked error')
    assert.equal(fs.existsSync(env.marker('onebot')), false)
  } finally { await env.dispose() }
})

await test('real host: pre-existing default workspace (desktop already initialized) is reused, not duplicated', async () => {
  mount.persisted = new Map()
  const env = await mount()
  try {
    const initialized = await env.controller().initializeDefault(AbortSignal.timeout(10000))
    assert.ok(initialized && initialized.workspace, 'desktop first-use initialization')
    await env.inbound(8001)
    const realDefault = await fsp.realpath(env.defaultDir)
    assert.equal(env.created[0].meta.cwd, path.join(realDefault, 'onebot'))
    assert.equal(env.registry().list().filter(w => w.path === realDefault).length, 1)
  } finally { await env.dispose() }
})

// ---- 0.3.7：会话成员登记（真实 dsh-workspace attachSession / sessionIds）----
async function channelWorkspace(env, channel = 'onebot') {
  const dir = path.join(await fsp.realpath(env.defaultDir), channel)
  return env.registry().resolveByPath(dir)
}
const receipts = (env, channel = 'onebot') => JSON.parse(fs.readFileSync(env.marker(channel), 'utf8')).attachedSessionIds

await test('real host 0.3.7: new channel sessions become members of the channel workspace', async () => {
  mount.persisted = new Map()
  const env = await mount()
  try {
    await env.inbound(9001, 'member one')
    await env.inbound(9002, 'member two')
    const [a, b] = env.created.map(c => c.sessionId)
    assert.ok(a && b && a !== b)
    const ws = await channelWorkspace(env)
    assert.ok(ws, 'channel workspace registered')
    assert.deepEqual([...ws.sessionIds].sort(), [a, b].sort(), 'both sessions are listed under the channel workspace')
    const def = await env.registry().resolveByPath(await fsp.realpath(env.defaultDir))
    assert.ok(!def.sessionIds.includes(a) && !def.sessionIds.includes(b), 'not listed under the parent default workspace')
    assert.deepEqual([...receipts(env)].sort(), [a, b].sort())
    if (process.platform !== 'win32') assert.equal(fs.statSync(env.marker('onebot')).mode & 0o777, 0o600)
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host 0.3.7: membership survives restart (registry reload validates the header)', async () => {
  mount.persisted = new Map()
  const first = await mount()
  const keep = { temp: first.temp, home: first.home, docs: first.docs }
  let sid
  try {
    await first.inbound(9101, 'before restart')
    sid = first.created[0].sessionId
  } finally { await first.dispose() }
  const env = await mount({ ...keep })
  try {
    const ws = await channelWorkspace(env)
    assert.ok(ws.sessionIds.includes(sid), 'still a member after restart')
    await env.inbound(9101, 'after restart')
    assert.equal(env.created.length, 0)
    assert.deepEqual(receipts(env), [sid], 'no duplicate receipt on resume')
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host 0.3.7: a 0.3.6 session (channel cwd, never attached) joins once on resume', async () => {
  mount.persisted = new Map()
  const first = await mount()
  const keep = { temp: first.temp, home: first.home, docs: first.docs }
  let sid
  try {
    await first.inbound(9201, 'made by 0.3.6')
    sid = first.created[0].sessionId
    // 还原成 0.3.6 留下的状态：会话不在工作区里，标记没有 attachedSessionIds。
    await (await channelWorkspace(first)).detachSession(sid)
    const row = JSON.parse(fs.readFileSync(first.marker('onebot'), 'utf8'))
    delete row.attachedSessionIds
    fs.writeFileSync(first.marker('onebot'), JSON.stringify(row), { mode: 0o600 })
    assert.ok(!(await channelWorkspace(first)).sessionIds.includes(sid))
  } finally { await first.dispose() }
  const env = await mount({ ...keep })
  try {
    await env.inbound(9201, 'after upgrade')
    assert.equal(env.created.length, 0, 'resumed, not recreated')
    assert.ok((await channelWorkspace(env)).sessionIds.includes(sid), 'repaired: now a member')
    assert.deepEqual(receipts(env), [sid])
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host 0.3.7: session the user removed from the workspace is not re-added on resume', async () => {
  mount.persisted = new Map()
  const first = await mount()
  const keep = { temp: first.temp, home: first.home, docs: first.docs }
  let sid
  try {
    await first.inbound(9301, 'joined')
    sid = first.created[0].sessionId
    await (await channelWorkspace(first)).detachSession(sid) // 用户在应用里移出
  } finally { await first.dispose() }
  const env = await mount({ ...keep })
  try {
    await env.inbound(9301, 'after manual removal')
    assert.ok(!(await channelWorkspace(env)).sessionIds.includes(sid), 'stays removed')
    assert.deepEqual(receipts(env), [sid])
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host 0.3.7: resumed session whose cwd is not the channel folder is not attached', async () => {
  mount.persisted = new Map()
  // 宿主注册表已初始化（与实机一致：不会再按 cwd 自动归组），渠道工作区已存在。
  const first = await mount()
  const keep = { temp: first.temp, home: first.home, docs: first.docs }
  let channelSid
  try {
    await first.inbound(9401, 'channel session')
    channelSid = first.created[0].sessionId
  } finally { await first.dispose() }
  // 另一会话建在原 cwd（相当于升级前已有的会话）。
  const second = await mount({ ...keep, cwd: path.join(keep.temp, 'messaging-root') })
  let oldSid
  try {
    await second.inbound(9402, 'old cwd')
    oldSid = second.created[0].sessionId
    assert.equal(second.created[0].meta.cwd, second.msgRoot)
  } finally { await second.dispose() }
  const env = await mount({ ...keep })
  try {
    await env.inbound(9402, 'resumed after upgrade')
    assert.equal(env.created.length, 0)
    assert.ok(env.registry().list().every(w => !w.sessionIds.includes(oldSid)), 'not a member of any workspace')
    assert.deepEqual(receipts(env), [channelSid], 'no receipt for the mismatched session')
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host 0.3.7: explicit agent.cwd that is a registered workspace is not auto-joined', async () => {
  mount.persisted = new Map()
  const explicit = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chws-explicit-ws-')))
  const env = await mount({ cwd: explicit })
  try {
    const { workspace } = await env.controller().create({ path: explicit })
    await env.inbound(9501)
    const sid = env.created[0].sessionId
    assert.equal(env.created[0].meta.cwd, explicit)
    assert.ok(!env.registry().get(workspace.workspaceId).sessionIds.includes(sid), 'scope: channel workspaces only')
    noChannelWorkspaceError(await env.status())
  } finally { await env.dispose() }
})

await test('real host 0.3.7: attach failure still delivers, one fixed diagnostic, no receipt, retried after restart', async () => {
  mount.persisted = new Map()
  const first = await mount()
  const keep = { temp: first.temp, home: first.home, docs: first.docs }
  let sid
  try {
    const reg = first.registry()
    const original = reg.resolveByPath.bind(reg)
    reg.resolveByPath = async (p) => {
      const ws = await original(p)
      return ws && { id: ws.id, path: ws.path, sessionIds: ws.sessionIds, attachSession: async () => { throw new Error('boom at ' + first.temp) } }
    }
    await first.inbound(9601, 'delivered anyway') // inbound 内部已等到消息投递
    sid = first.created[0].sessionId
    assert.equal(first.created[0].meta.cwd, path.join(await fsp.realpath(first.defaultDir), 'onebot'), 'cwd still the channel folder')
    const snapshot = await first.status()
    const errors = (snapshot.errors || []).filter(e => e.context === 'channel workspace')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'channel workspace attach failed')
    assert.equal(errors[0].channel, 'onebot')
    const text = JSON.stringify([errors, snapshot.channels])
    assert.ok(!text.includes(first.temp) && !text.includes('boom') && !text.includes(sid), 'no path, host text or session id')
    assert.notEqual(snapshot.channels.find(c => c.key === 'onebot').state, 'error', 'non-fatal')
    assert.equal(receipts(first), undefined, 'no receipt on failure')
    reg.resolveByPath = original
  } finally { await first.dispose() }
  // 失败节流是进程内的；“进程重启”用全新模块实例模拟。
  const fresh = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'messaging-channel-workspace.js')).href + '?restart=' + Date.now())
  const env = await mount({ ...keep })
  try {
    const store = fresh.createChannelWorkspaces({ root: path.dirname(env.marker('onebot')), services: () => ({ registry: env.registry() }) })
    await store.attach('onebot', { sessionId: sid, cwd: path.join(await fsp.realpath(env.defaultDir), 'onebot') })
    assert.ok((await channelWorkspace(env)).sessionIds.includes(sid), 'retry in a new process succeeds')
    assert.deepEqual(receipts(env), [sid])
  } finally { await env.dispose() }
})

const failed = results.filter(r => !r.ok)
console.log('messaging-channel-workspace-host: ' + (results.length - failed.length) + '/' + results.length + ' passed')
process.exit(failed.length ? 1 : 0)
