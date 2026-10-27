// test/lark-recovery-host.mjs —— 真实宿主恢复专项（编码验证，非独立审核）。
//
// 边界：只用一次性解包的已装宿主包（DSH_HOSTX_ROOT，默认 /tmp/dsh-hostx）+ 临时
// DSH_HOME/workspace（mkdtemp）+ mock LLM adapter；网络（飞书 HTTP/WS）全部 fake，
// 不碰真实 app/profile、不发真实消息、不读凭据/私密历史。被测产品代码为真实
// lib/index.js（apply 入口、真实 webhook 路由、真实恢复队列、真实 admission/ledger
// 模块）；fake 仅限外边界（LLM 流、webServer/shell/fs 桩、agentDefaultModel）。
// 不修改任何现有文件；实现文件 hash 在首尾各记录一次（运行期间实现未被改动）。
//
// 场景（对应 Lead 四项）：
// S1 真实 session-projection + projection-cache + JSONL：flush+checkpoint 后冷恢复，
//    真实插件恢复链仍按插件准入投影判定 admitted 并 settle delivered（不重复 followup）；
//    写坏 cache 文件再冷恢复：判定绝不退化为 not_admitted（backup-and-skip/uncertain 均可）。
// S2 真实 followup 同步插入后再抛错（注入点=包装 agent.followup，真实调用后 throw，
//    模拟 wakeDriver/withInitiator 在 splice 后的异常）→ 重查 admitted → flush → 仅一次准入。
// S3 record.sessionId 对应会话不存在：sessionExisted true/false/null 三态均零 create、
//    进入固定无正文告知流程（session_missing×2 + sid_or_chat_missing×1）；sid null 不猜路由。
// S4 冷恢复 pending（真实 maintenance 占位使 followup 留在 inbox）→ admitted 后
//    waiting_for_input 告知 + 不重复 followup + 无 wake（宿主事实：pending 等后续输入）；
//    仅历史投影命中（turn 已消费）→ delivered 且无 waiting 误报。
'use strict'
import './_guard.cjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dirname, '..')
const HOSTX = resolveHostRoot()
function resolveHostRoot() {
  const fromEnv = process.env.DSH_HOSTX_ROOT
  return fromEnv ? path.resolve(fromEnv) : '/tmp/dsh-hostx'
}
const HOST_MODULES = path.join(HOSTX, 'dsh', 'node_modules', '@deepseek-ai')
if (!existsSync(HOST_MODULES)) {
  // 缺夹具明确失败：不 mock 宿主、不静默跳过。
  console.error('lark-recovery-host: FATAL — unpacked installed host not found at ' + HOST_MODULES)
  console.error('Set DSH_HOSTX_ROOT to the unpack root; this probe needs the real host packages.')
  process.exit(1)
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const implFiles = {
  index: path.join(repo, 'lib', 'index.js'),
  ledger: path.join(repo, 'lib', 'lark-dedup.js'),
  admission: path.join(repo, 'lib', 'lark-admission.js'),
}
// Lead 给定基线（前 16 位）；r0 并发修改只影响打印，不作失败（首末一致断言防运行中改动）。
const BASELINE16 = { index: '4af9cb51e75daf22', ledger: '7faf3b1b073f05bf', admission: '0d2f91de4c49e84f' }
const hashStart = { index: sha256(implFiles.index), ledger: sha256(implFiles.ledger), admission: sha256(implFiles.admission) }
for (const [name, digest] of Object.entries(hashStart)) {
  const mark = digest.startsWith(BASELINE16[name]) ? 'baseline-match' : 'differs-from-lead-baseline(r0 may have edited)'
  console.log('HASH-START ' + name + ' ' + digest.slice(0, 16) + ' (' + mark + ')')
}

// ── 真实宿主组件（与已装 app 同族包；mock 仅 LLM adapter） ──────────────────
const imp = (pkg) => import(pathToFileURL(path.join(HOST_MODULES, pkg, 'lib', 'index.js')).href)
const { Context } = await imp('cordis')
const llm = await imp('dsh-llm')
const sess = await imp('dsh-session')
const SystemPrompt = (await imp('dsh-system-prompt')).default
const ToolRuntime = (await imp('dsh-tools')).default
const AgentRegistry = (await imp('dsh-agent')).default
const jsonlModule = await imp('dsh-session-persistence-jsonl')
const Jsonl = jsonlModule.default || jsonlModule
const AgentLoop = (await imp('dsh-agent-loop')).default
const Proj = (await imp('dsh-session-projection')).default
const ProjCache = (await imp('dsh-session-projection-cache')).default
const StorageHub = (await imp('dsh-storage')).default // storage hub（json 后端的 ctx.storage）
const StorageJson = await imp('dsh-storage-json') // 函数插件（name/apply/Config 导出，非 default）
const StorageDomain = await imp('dsh-storage-domain')
const plugin = await import(pathToFileURL(implFiles.index).href)
const { openLarkDedupStore, larkDedupKey, LARK_DEDUP_JOURNAL_NAME } = await import(pathToFileURL(implFiles.ledger).href)
const { larkAdmissionVerdict, larkAdmissionInboxIds, LARK_ADMISSION_KEY } = await import(pathToFileURL(implFiles.admission).href)

class Mock extends llm.LlmAdapter {
  constructor() { super(); this.n = 0 }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream() {
    this.n += 1
    const t = 'ok' + this.n
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: t }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: t } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const tick = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)) }
async function waitFor(label, fn, timeoutMs = 12000, onPoll = null) {
  const start = Date.now()
  let polls = 0
  for (;;) {
    let value = null
    try { value = fn() } catch { /* 轮询窗口 */ }
    if (value) return value
    polls += 1
    if (onPoll && polls % 80 === 0) { try { onPoll() } catch { /* debug best-effort */ } }
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for ' + label)
    await new Promise((r) => setTimeout(r, 25))
  }
}
// 真实插件状态快照（经 webServer 桩注册的真实 GET /status 路由）。
async function statusOf(env) {
  const handler = env.routes.get('/__dsh-messaging/status')
  if (!handler) return null
  let body = ''
  const req = Readable.from([])
  req.method = 'GET'
  req.headers = { host: '127.0.0.1:5173' } // 同源门禁：回环 Host、无 Origin（浏览器同源 GET 同形）
  const res = { headersSent: false, writeHead() { this.headersSent = true }, end(data) { body = String(data || '') } }
  await handler(req, res)
  try { return JSON.parse(body) } catch { return null }
}

// ── 每场景独立环境：真实栈 + 外边界 fake ──────────────────────────────────
const tmpDirs = []
async function makeEnv(name, opts = {}) {
  const home = opts.home || await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-recovery-' + name + '-'))
  const ws = opts.ws || await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-recovery-' + name + '-ws-'))
  if (!opts.home) tmpDirs.push(home, ws)
  const routes = new Map()
  const shellCalls = []
  const counters = { created: 0, resumed: 0, resumedSids: [] }
  const envHooks = { faultFollowup: false }
  const seenAgents = []
  const fakeShell = {
    resolve: (request) => request,
    async run(request) {
      shellCalls.push(request)
      // 默认：飞书 HTTP API 成功（固定告知可送达）；测试可注入失败答案。
      const payload = '{"code":0,"data":{"message_id":"om_notice_1"}}'
      return {
        exitCode: 0, signal: null, timedOut: false, aborted: false,
        stdout: { text: payload + '__DSH_STATUS__:200', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
  }
  const fsService = {
    async resolve(target) {
      return { displayPath: String(target), targetKey: String(target) }
    },
    async stat(target) {
      if (existsSync(String(target.displayPath || target))) return { type: 'file' }
      const err = new Error('FS_NOT_FOUND')
      err.code = 'FS_NOT_FOUND'
      throw err
    },
    async readText() {
      const err = new Error('FS_NOT_FOUND')
      err.code = 'FS_NOT_FOUND'
      throw err // config 直传（Loader 形态）：无盘上配置可读
    },
    async writeText() {},
  }
  const ctx = new Context()
  // 外边界 fake（插件 inject 面的宿主服务）；其余组件全部真实。
  ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
  ctx.provide('shell', fakeShell)
  ctx.provide('fs', fsService)
  ctx.provide('agentDefaultModel', { currentSelection() { return { provider: 'mock', model: 'm' } } })
  ctx.provide('dsh.home', home) // 真实插件的 ledger 根 seam（临时 DSH_HOME，不碰 ~/.dsh）
  // 真实栈（与生产组合同族、同挂载顺序；storage 层为 cache 冷恢复提供真实介质）。
  await ctx.plugin(llm.default)
  await ctx.plugin(sess.default)
  await ctx.plugin(StorageHub)
  await ctx.plugin(StorageJson, { root: path.join(home, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Proj)
  await ctx.plugin(ProjCache, { writeEveryEvents: 50, writeIntervalMs: 3600000 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root: path.join(home, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new Mock())
  // 真实插件：包一层 create/resume 计数与 followup 故障注入（S2/S3 用）。
  const agents = ctx.get('agents')
  const origCreate = agents.create.bind(agents)
  const origResume = agents.resume.bind(agents)
  const wrapHandle = (handle) => {
    if (handle && handle.agent && seenAgents.indexOf(handle.agent) === -1) seenAgents.push(handle.agent)
    if (envHooks.faultFollowup && handle && handle.agent) {
      const agent = handle.agent
      const orig = agent.followup.bind(agent)
      agent.followup = (message) => {
        orig(message) // 真实同步 splice 先发生
        envHooks.faultFollowup = false
        throw new Error('INJECTED_WAKE_FAILURE (test: wakeDriver/withInitiator throw after splice)')
      }
    }
    return handle
  }
  const env = {
    name, home, ws, ctx, routes, shellCalls, counters, envHooks, seenAgents,
    ledgerPath: path.join(home, 'lark-dedup'),
    agents: {
      async create(options) { counters.created += 1; return wrapHandle(await origCreate(options)) },
      async resume(options) { counters.resumed += 1; counters.resumedSids.push(String(options && (options.resumeSessionId || options.sessionId) || '')); return wrapHandle(await origResume(options)) },
    },
  }
  // 把真实 registry 的 create/resume 换成计数/注入包装（同一实例，其余不变）。
  agents.create = env.agents.create
  agents.resume = env.agents.resume
  const config = plugin.defaultConfig(ws)
  config.adapters.lark = Object.assign({}, config.adapters.lark, {
    enabled: true, mode: 'webhook', appId: 'cli_test', appSecret: 'secret',
    verificationToken: 'tok123', interactiveCard: false,
  })
  config.agent = Object.assign({}, config.agent, { provider: 'mock', model: 'm', cwd: ws })
  if (!opts.skipApply) {
    if (typeof opts.beforeApply === 'function') await opts.beforeApply(env)
    await plugin.apply(ctx, config)
    await tick()
  }
  env.dispose = async () => { await ctx.fiber.dispose() }
  return env
}

// ── 驱动 helper ────────────────────────────────────────────────────────────
function um(id, text) {
  return { id: llm.MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}
function userMsgCount(agent, id) {
  // 测试文件允许 deprecated snapshotEvents（宿主 deprecation note 的测试豁免）。
  return agent.session.snapshotEvents().filter((e) => e.type === 'user/message' && e.data && e.data.id === id).length
}
function assistantCount(agent) {
  return agent.session.snapshotEvents().filter((e) => e.type === 'assistant/message').length
}
function countOccurrences(haystack, needle) {
  let n = 0
  let idx = haystack.indexOf(needle)
  while (idx >= 0) { n += 1; idx = haystack.indexOf(needle, idx + needle.length) }
  return n
}
// 从 fake curl 配置里提取告知文本（两层 JSON：curl data-binary + 平台 content）。
function extractNoticeTexts(shellCalls) {
  const texts = []
  for (const call of shellCalls) {
    const stdin = String(call.stdin || '')
    if (!stdin.includes('/im/v1/messages')) continue
    const match = /data-binary = "((?:[^"\\]|\\.)*)"/.exec(stdin)
    if (!match) continue
    try {
      const outer = JSON.parse(JSON.parse('"' + match[1] + '"'))
      if (outer && typeof outer.content === 'string') texts.push(JSON.parse(outer.content).text)
    } catch { /* 非告知请求（如 GET）跳过 */ }
  }
  return texts
}
async function postText(env, { messageId, chatId, text, chatType = 'p2p' }) {
  const handler = env.routes.get('/messaging/lark/events')
  assert.ok(handler, 'webhook route registered by the real plugin')
  const body = JSON.stringify({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: 'tok123', event_id: 'ev_' + messageId },
    event: {
      message: { message_id: messageId, chat_id: chatId, chat_type: chatType, message_type: 'text', content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: 'ou_probe' }, sender_type: 'user' },
    },
  })
  const req = Readable.from([Buffer.from(body, 'utf8')]) // Buffer chunk：readBody 用 TextDecoder
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  const res = { headersSent: false, writeHead() { this.headersSent = true }, end() {} }
  await handler(req, res)
  await tick()
}

// ── S1：真实 projection + projection-cache + JSONL：flush+checkpoint 冷恢复；坏 cache 不误判 ──
async function scenario1() {
  const s1Home = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-recovery-s1-home-'))
  const s1Ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-recovery-s1-ws-'))
  tmpDirs.push(s1Home, s1Ws)
  const env1 = await makeEnv('s1', { home: s1Home, ws: s1Ws })
  const lease1 = await openLarkDedupStore(env1.ledgerPath)
  // 真实宿主：先建会话，claim 随后绑定真实 route 证据（与真实入站入口同序）。
  const { agent } = await env1.agents.create({
    sessionId: sess.SessionId('s1-cache'),
    meta: { cwd: s1Ws },
    agentOptions: { provider: 'mock', model: 'm' },
  })
  const claim = await lease1.claim({ appId: 'cli_test', messageId: 'om_cache', chatId: 'oc_cache' })
  await lease1.bindRoute(claim.record.key, { sessionId: 's1-cache', sessionExisted: true })
  const umid = claim.record.userMessageId
  // 真实 followup（同步准入）→ flush → 强制 projection checkpoint。
  agent.followup(um(umid, 'cache probe'))
  await env1.ctx.sessions.flush(agent.session)
  await env1.ctx.sessionProjections.checkpoint(agent.session) // registry 强制 checkpoint（cache 监听写盘）
  await tick() // write-behind 落盘窗口
  const projBefore = env1.ctx.sessionProjections.stateOf(agent.session, LARK_ADMISSION_KEY)
  assert.ok(projBefore && projBefore.ids.includes(umid), 'fixture: real projection captured the admitted id')
  await lease1.close()
  await env1.dispose() // 冷 1（真实 flush+checkpoint 已落盘）

  const env2 = await makeEnv('s1', { home: s1Home, ws: s1Ws })
  const lease2 = await openLarkDedupStore(env2.ledgerPath)
  // 真实插件恢复链（apply 后 warm seed 自动跑）在 cache 冷恢复后仍判 admitted 并收敛。
  let delivered = null
  try {
    delivered = await waitFor('s1 recovery delivered', () => {
      const row = lease2.get(claim.record.key)
      return row && row.state === 'delivered' ? row : null
    })
  } catch (error) {
    const snap = await statusOf(env2)
    console.log('DBG-S1-FAIL row=' + JSON.stringify(lease2.get(claim.record.key)))
    console.log('DBG-S1 recent=' + JSON.stringify((snap && snap.recent || []).slice(-4)))
    throw error
  }
  assert.equal(delivered.state, 'delivered', 'real plugin recovery chain settles delivered after cold restore')
  const live2 = env2.ctx.agents.get(sess.SessionId('s1-cache'))
  assert.ok(live2, 'session resumed by the recovery chain')
  const v2 = larkAdmissionVerdict({
    userMessageId: umid,
    inboxIds: larkAdmissionInboxIds(live2),
    projectionState: env2.ctx.sessionProjections.stateOf(live2.session, LARK_ADMISSION_KEY),
  })
  assert.equal(v2.verdict, 'admitted', 'cold restore after flush+checkpoint judges admitted via the real projection')
  assert.equal(userMsgCount(live2, umid), 1, 'no duplicate followup on cold restore (exactly one admitted message)')
  await lease2.close()
  await env2.dispose()

  // 冷 2：写坏磁盘上的 cache 文件（storage-json per-record 目录，glob 不硬编码布局）。
  const cacheRoot = path.join(s1Home, 'storages', 'session_projcache')
  const jsonFiles = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json')) jsonFiles.push(full)
    }
  }
  walk(cacheRoot)
  assert.ok(jsonFiles.length >= 1, 'fixture: projection-cache checkpoint file exists on disk')
  for (const file of jsonFiles) fs.writeFileSync(file, '{broken,,,')
  const env3 = await makeEnv('s1', { home: s1Home, ws: s1Ws })
  const lease3 = await openLarkDedupStore(env3.ledgerPath)
  const agent3 = env3.ctx.agents.get(sess.SessionId('s1-cache')) || (await env3.agents.resume({ resumeSessionId: sess.SessionId('s1-cache'), agentOptions: { provider: 'mock', model: 'm' } })).agent
  const v3 = larkAdmissionVerdict({
    userMessageId: umid,
    inboxIds: larkAdmissionInboxIds(agent3),
    projectionState: env3.ctx.sessionProjections.stateOf(agent3.session, LARK_ADMISSION_KEY),
  })
  // 坏 cache 的安全结局（backup-and-skip 自愈重 fold，或 cache 缺失→uncertain）：
  // 绝不允许 not_admitted（那会导致重复投递）。
  assert.ok(['admitted', 'uncertain'].includes(v3.verdict), 'broken cache verdict stays safe (got ' + v3.verdict + '/' + v3.reason + ')')
  assert.notEqual(v3.verdict, 'not_admitted', 'broken cache must never produce a false not_admitted')
  await lease3.close()
  await env3.dispose()

  // S1c：坏 cache 下走**实际恢复处理**到可观察稳定点（不止 stateOf 断言）。
  // 夹具：向真实 journal 追加一行 claimed（最后一行生效，直接操作持久介质，
  // 真实冷开后插件恢复链接手已准入的 umid）。
  const journalFile = path.join(s1Home, 'lark-dedup', LARK_DEDUP_JOURNAL_NAME)
  const journalRows = fs.readFileSync(journalFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  // 取该消息的**最后一行**（最后一行生效；含 bindRoute 持久化的 route 证据）。
  const cacheRow = journalRows.filter((o) => o.k === 'd' && o.msg === 'om_cache').pop()
  assert.ok(cacheRow && cacheRow.sid === 's1-cache', 'fixture: the last durable row carries the bound route evidence')
  fs.appendFileSync(journalFile, JSON.stringify({ ...cacheRow, st: 'claimed', e: null, u: Date.now() }) + '\n')
  const env4 = await makeEnv('s1', { home: s1Home, ws: s1Ws })
  const lease4 = await openLarkDedupStore(env4.ledgerPath)
  const stable = await waitFor('S1c recovery reaches a stable state', () => {
    const row = lease4.get(claim.record.key)
    return row && (row.state === 'delivered' || row.state === 'rejected') ? row : null
  }, 25000)
  // 两种 Lead 允许的安全路径之一；无论哪条，都不允许第二次 followup/准入。
  let agent4 = null
  try {
    agent4 = await waitFor('S4c/S1c live agent', () => env4.ctx.agents.get(sess.SessionId('s1-cache')) || null, 8000)
  } catch (error) {
    console.log('DBG-S1c stable=' + JSON.stringify(stable))
    console.log('DBG-S1c counters=' + JSON.stringify(env4.counters))
    console.log('DBG-S1c shell=' + JSON.stringify(env4.shellCalls.map((c) => String(c.command || ''))))
    throw error
  }
  assert.ok(agent4, 'S1c: the session is live after the real recovery run')
  assert.equal(userMsgCount(agent4, umid), 1, 'S1c: no second followup/admission of the admitted umid under a corrupt cache')
  if (stable.state === 'rejected') {
    const notices4 = extractNoticeTexts(env4.shellCalls)
    assert.ok(notices4.some((t) => t.includes('暂时无法确认该消息的处理状态')), 'S1c: uncertain path sends the fixed no-body notice')
    // ledger rejected 由产品前置保证（settleRejected 需 noticeDelivered 证据）：送达后才终态。
    console.log('S1c path=uncertain→notice-delivered→rejected')
  } else {
    assert.equal(stable.state, 'delivered', 'S1c: self-healed cache path settles delivered after flush')
    console.log('S1c path=self-healed-admitted→flush→delivered')
  }
  await lease4.close()
  await env4.dispose()
  console.log('PASS S1 projection-cache cold restore + corrupt-cache safety')
}

// ── S2：真实 followup 同步插入后再抛错（注入点：包装 agent.followup） ──────
async function scenario2() {
  const env = await makeEnv('s2')
  const lease = await openLarkDedupStore(env.ledgerPath)
  env.envHooks.faultFollowup = true // 注入：真实 followup（同步 splice）之后 throw，
  // 模拟 wakeDriver/withInitiator 在 splice 后的异常（宿主源码允许该路径）。
  await postText(env, { messageId: 'om_wake1', chatId: 'oc_wake', text: 'wake probe' })
  const key = larkDedupKey('cli_test', 'om_wake1')
  const row = await waitFor('s2 delivered after injected wake failure', () => {
    const r = lease.get(key)
    return r && r.state === 'delivered' ? r : null
  })
  assert.equal(row.state, 'delivered', 'followup throw after splice: re-check admitted → flush → delivered (once)')
  assert.equal(env.envHooks.faultFollowup, false, 'the injected fault fired exactly once')
  const agent = env.seenAgents.find((a) => userMsgCount(a, row.userMessageId) > 0)
  assert.ok(agent, 'the admitted session exists')
  assert.equal(userMsgCount(agent, row.userMessageId), 1, 'exactly one admitted message — no duplicate enqueue despite the throw')
  const v = larkAdmissionVerdict({
    userMessageId: row.userMessageId,
    inboxIds: larkAdmissionInboxIds(agent),
    projectionState: env.ctx.sessionProjections.stateOf(agent.session, LARK_ADMISSION_KEY),
  })
  assert.equal(v.verdict, 'admitted', 'post-throw verdict is admitted via the real projection')
  await lease.close()
  await env.dispose()
  console.log('PASS S2 followup-throw recheck admits once')
}

// ── S3：会话不存在 × sessionExisted true/false/null：零 create + 固定告知；sid null 不猜路由 ──
async function scenario3() {
  let refs = null
  const env = await makeEnv('s3', { beforeApply: async (e) => {
    const lease = await openLarkDedupStore(e.ledgerPath)
    const r1 = await lease.claim({ appId: 'cli_test', messageId: 'om_gone_t', chatId: 'oc_gone_t' })
    await lease.bindRoute(r1.record.key, { sessionId: 's-gone-true', sessionExisted: true })
    const r2 = await lease.claim({ appId: 'cli_test', messageId: 'om_gone_f', chatId: 'oc_gone_f' })
    await lease.bindRoute(r2.record.key, { sessionId: 's-gone-false', sessionExisted: false })
    const r3 = await lease.claim({ appId: 'cli_test', messageId: 'om_nosid', chatId: 'oc_nosid' })
    // r3 故意不绑 sessionId（null）：恢复不得猜路由。
    // r4：非空已存 sid + sessionExisted=null（与 r3 的 sid-null 是不同维度）：
    // 会话缺失时仅按存储 sid resume、零 create、固定告知。
    const r4 = await lease.claim({ appId: 'cli_test', messageId: 'om_gone_n4', chatId: 'oc_gone_n4' })
    await lease.bindRoute(r4.record.key, { sessionId: 's-gone-nullsx' }) // sx 不传 → null
    // 释放处理权（记录保持 claimed）：恢复队列只接无主 claimed（在途项按设计跳过）。
    await lease.release(r1.record.key)
    await lease.release(r2.record.key)
    await lease.release(r3.record.key)
    await lease.release(r4.record.key)
    refs = { lease, keys: [r1.record.key, r2.record.key, r3.record.key, r4.record.key] }
  } })
  const lease = refs.lease
  try {
    await waitFor('s3 three notices settled rejected', () => (
      refs.keys.every((k) => (lease.get(k) || {}).state === 'rejected')
    ), 20000)
  } catch (error) {
    console.log('DBG-S3 rows=' + JSON.stringify(refs.keys.map((k) => lease.get(k))))
    const snap = await statusOf(env)
    console.log('DBG-S3 recent=' + JSON.stringify((snap && snap.recent || []).slice(-6)))
    console.log('DBG-S3 errors=' + JSON.stringify((snap && snap.errors || []).slice(-4)))
    console.log('DBG-S3 shell=' + JSON.stringify(env.shellCalls.map((c) => String(c.command || ''))))
    throw error
  }
  assert.equal(env.counters.created, 0, 'S3: zero session creation for every sessionExisted state (true/false/null)')
  assert.equal(env.counters.resumed, 3, 'S3: sx true/false/null with a stored sid all resume exactly that sid (missing → notice); only sid-null skips resume')
  for (const sid of ['s-gone-true', 's-gone-false', 's-gone-nullsx']) {
    assert.equal(env.counters.resumedSids.filter((s) => s === sid).length, 1, 'S3: resume is issued with the stored sid (' + sid + '), not a re-derived one')
  }
  const notices = extractNoticeTexts(env.shellCalls)
  assert.equal(countOccurrences(notices.join('\n'), '之前发起的会话已不可用'), 3, 'S3: fixed session_missing notice per missing-session record (no body/ids)')
  assert.equal(countOccurrences(notices.join('\n'), '该消息缺少可确认的目标会话'), 1, 'S3: sid null → fixed local-block notice, no route guessing')
  assert.equal(notices.some((t) => t.includes('wake probe') || t.includes('om_')), false, 'notices carry no body or message ids')
  await lease.close()
  await env.dispose()
  console.log('PASS S3 missing-session notice: sx true/false/null resume stored sid; sid null never guesses')
}

// ── S4a：同进程 busy 复用（runMaintenance 占位；**非冷启动**，冷恢复见 S4c）→
// admitted、waiting 通知、不重复 followup、无 wake ──
async function scenario4a() {
  let ref = null
  const env = await makeEnv('s4a', { beforeApply: async (e) => {
    const lease = await openLarkDedupStore(e.ledgerPath)
    const r = await lease.claim({ appId: 'cli_test', messageId: 'om_pending', chatId: 'oc_pending' })
    await lease.bindRoute(r.record.key, { sessionId: 's-pend', sessionExisted: false })
    const { agent } = await e.agents.create({
      sessionId: sess.SessionId('s-pend'),
      meta: { cwd: e.ws },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    // 真实机制占住 idle phase：maintenance 期间 followup 留在 inbox（不 claim）。
    // promise 必须跟随 abort（dispose 会 cancel maintenance；永不 settle 会卡死 fiber dispose）。
    const hold = agent.runMaintenance((signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    }))
    hold.catch(() => {})
    agent.followup(um(r.record.userMessageId, 'pending probe'))
    await e.ctx.sessions.flush(agent.session)
    assert.ok(larkAdmissionInboxIds(agent).includes(r.record.userMessageId), 'fixture: message parked in the durable inbox')
    await lease.release(r.record.key) // 释放处理权：记录 claimed，由插件恢复链接手（在途项会被跳过）
    ref = { lease, key: r.record.key, umid: r.record.userMessageId }
  } })
  await waitFor('s4a delivered', () => (ref.lease.get(ref.key) || {}).state === 'delivered' || null)
  const agent = env.ctx.agents.get(sess.SessionId('s-pend'))
  assert.ok(agent, 'the pending session stays live')
  const inboxIds = larkAdmissionInboxIds(agent)
  assert.equal(inboxIds.filter((id) => id === ref.umid).length, 1, 'S4a: exactly one pending copy in the inbox — recovery never re-followuped it')
  assert.ok(inboxIds.includes(ref.umid), 'S4a: pending still parked in the inbox (host fact: waits for later legitimate input; no public wake API is used)')
  assert.equal(assistantCount(agent), 0, 'S4a: recovery never woke the driver or consumed the pending message (no turn ran)')
  const notices4a = extractNoticeTexts(env.shellCalls)
  assert.equal(countOccurrences(notices4a.join('\n'), '需要后续输入时继续处理'), 1, 'S4a: fixed waiting_for_input notice fired once (inbox hit after admitted)')
  await ref.lease.close()
  await env.dispose()
  console.log('PASS S4a same-process busy reuse: admitted once, waiting notice, no wake (NOT a cold start; cold path is S4c)')
}

// ── S4b：仅历史投影命中 → delivered、无 waiting 误报、无二次驱动 ──────────
async function scenario4b() {
  let ref = null
  const env = await makeEnv('s4b', { beforeApply: async (e) => {
    const lease = await openLarkDedupStore(e.ledgerPath)
    const r = await lease.claim({ appId: 'cli_test', messageId: 'om_hist', chatId: 'oc_hist' })
    await lease.bindRoute(r.record.key, { sessionId: 's-hist', sessionExisted: false })
    const { agent } = await e.agents.create({
      sessionId: sess.SessionId('s-hist'),
      meta: { cwd: e.ws },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    agent.followup(um(r.record.userMessageId, 'hist probe'))
    await e.ctx.sessions.flush(agent.session)
    await agent.whenIdle() // mock turn 完成：消息消费进历史，inbox 清空
    assert.equal(larkAdmissionInboxIds(agent).includes(r.record.userMessageId), false, 'fixture: consumed into history')
    await lease.release(r.record.key) // 同上：无主 claimed 交恢复链
    ref = { lease, key: r.record.key, umid: r.record.userMessageId }
  } })
  await waitFor('s4b delivered', () => (ref.lease.get(ref.key) || {}).state === 'delivered' || null)
  const agent = env.ctx.agents.get(sess.SessionId('s-hist'))
  assert.equal(userMsgCount(agent, ref.umid), 1, 'S4b: history hit does not re-followup')
  assert.equal(assistantCount(agent), 1, 'S4b: no second driver turn was triggered by recovery')
  const notices4b = extractNoticeTexts(env.shellCalls)
  assert.equal(notices4b.some((t) => t.includes('需要后续输入时继续处理')), false, 'S4b: history-only hit never reports a false waiting notice')
  await ref.lease.close()
  await env.dispose()
  console.log('PASS S4b history-hit: delivered without waiting notice or second drive')
}

// 子进程等待（真实 crash 语义：不 dispose、不 abort）。
function collectExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
}

// ── S4c：真正冷恢复——子进程真实崩溃（不 dispose）造持久 pending → 全新 ctx/Agent
// 恢复仍 pending → 独立合法新输入触发消费，旧 pending 恰一次处理（不重复 followup、无私有 wake）──
async function scenario4c() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-recovery-s4c-home-'))
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-recovery-s4c-ws-'))
  tmpDirs.push(home, ws)
  // 子进程：真实栈 + maintenance 占位（followup 留在持久 inbox）+ flush 后 exit(9)。
  // 不能用 dispose 造 pending：dispose 会 abort maintenance → wakeDriver 消费掉 pending。
  const childScript = path.join(home, 'make-pending.mjs')
  fs.writeFileSync(childScript, [
    `import { Context } from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'cordis', 'lib', 'index.js')).href)}`,
    `import * as llm from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-llm', 'lib', 'index.js')).href)}`,
    `import * as sess from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-session', 'lib', 'index.js')).href)}`,
    `import Proj from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-session-projection', 'lib', 'index.js')).href)}`,
    `import SystemPrompt from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-system-prompt', 'lib', 'index.js')).href)}`,
    `import ToolRuntime from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-tools', 'lib', 'index.js')).href)}`,
    `import AgentRegistry from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-agent', 'lib', 'index.js')).href)}`,
    `import * as jsonlModule from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-session-persistence-jsonl', 'lib', 'index.js')).href)}; const Jsonl = jsonlModule.default || jsonlModule`,
    `import AgentLoop from ${JSON.stringify(pathToFileURL(path.join(HOST_MODULES, 'dsh-agent-loop', 'lib', 'index.js')).href)}`,
    `import { openLarkDedupStore } from ${JSON.stringify(pathToFileURL(implFiles.ledger).href)}`,
    'const [home, ws] = process.argv.slice(2)',
    'const ctx = new Context()',
    'await ctx.plugin(llm.default); await ctx.plugin(sess.default); await ctx.plugin(Proj)',
    'await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)',
    "await ctx.plugin(Jsonl, { root: home + '/sessions' }); await ctx.plugin(AgentLoop, { agents: [] })",
    "class Mock extends llm.LlmAdapter { resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m }) } async *stream() { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }; yield { type: 'finish', reason: { kind: 'stop' } } } }",
    "ctx.llm.registerAdapter(['mock'], new Mock())",
    "const lease = await openLarkDedupStore(home + '/lark-dedup')",
    "const r = await lease.claim({ appId: 'cli_test', messageId: 'om_pend_c', chatId: 'oc_pend_c' })",
    "await lease.bindRoute(r.record.key, { sessionId: 's-pend-c', sessionExisted: false })",
    "await lease.release(r.record.key)",
    "const { agent } = await ctx.agents.create({ sessionId: sess.SessionId('s-pend-c'), meta: { cwd: ws }, agentOptions: { provider: 'mock', model: 'm' } })",
    'const hold = agent.runMaintenance((signal) => new Promise((resolve) => { signal.addEventListener(\'abort\', () => resolve(), { once: true }) }))',
    'hold.catch(() => {})',
    "agent.followup({ id: llm.MessageId(r.record.userMessageId), role: 'user', content: [{ type: 'text', text: 'pending cold' }], source: { kind: 'user' } })",
    'await ctx.sessions.flush(agent.session)',
    'process.exit(9)', // 真实崩溃：不 dispose（pending 保留在持久 inbox；dispose 会 wake 消费掉）
  ].join('\n'))
  const child = spawn(process.execPath, [childScript, home, ws], { stdio: ['ignore', 'inherit', 'inherit'] })
  const exitCode = await collectExit(child)
  assert.equal(exitCode.code, 9, 'S4c: crash fixture exits without dispose')

  // 全新 ctx（同 home）：真实插件 apply → 冷恢复。
  const envB = await makeEnv('s4c', { home, ws })
  const leaseB = await openLarkDedupStore(envB.ledgerPath)
  const keyC = larkDedupKey('cli_test', 'om_pend_c')
  const pendRow = await waitFor('S4c ledger row', () => leaseB.get(keyC) || null)
  const umidC = pendRow.userMessageId
  await waitFor('S4c recovery delivered', () => (leaseB.get(keyC) || {}).state === 'delivered' || null, 20000)
  const agentB = await waitFor('S4c live agent after cold restore', () => envB.ctx.agents.get(sess.SessionId('s-pend-c')) || null)
  const inboxAfter = larkAdmissionInboxIds(agentB)
  assert.equal(inboxAfter.filter((x) => x === umidC).length, 1, 'S4c: after a full host teardown + fresh ctx, the pending copy is still exactly one')
  assert.equal(userMsgCount(agentB, umidC), 0, 'S4c: pending is not yet consumed (not re-followuped, not driven)')
  assert.equal(assistantCount(agentB), 0, 'S4c: no private wake happened on restore (no turn ran)')
  const noticesC = extractNoticeTexts(envB.shellCalls)
  assert.ok(noticesC.some((t) => t.includes('需要后续输入时继续处理')), 'S4c: waiting_for_input notice after cold restore admitted')
  // 独立合法新输入触发消费（等价宿主面用户输入→agent.followup；新 id，不是同 id 再 followup）。
  const kickUmid = 'lark-' + umidC.slice(5, 13) + '-99-' + 'feedfacefeedface'
  agentB.followup(um(kickUmid, 'legit new input'))
  await waitFor('S4c pending consumed exactly once', () => userMsgCount(agentB, umidC) === 1 || null, 20000)
  assert.equal(userMsgCount(agentB, umidC), 1, 'S4c: the old pending message is processed exactly once after a legitimate new input')
  assert.equal(userMsgCount(agentB, kickUmid), 1, 'S4c: the new input itself is admitted once (distinct id)')
  assert.ok(assistantCount(agentB) >= 1, 'S4c: a real turn ran after the new input (host-driven, not woken by recovery)')
  assert.equal(larkAdmissionInboxIds(agentB).filter((x) => x === umidC || x === kickUmid).length, 0, 'S4c: both messages left the inbox after the turn')
  await leaseB.close()
  await envB.dispose()
  console.log('PASS S4c full teardown cold restore: pending survives, one-shot consumption via new input')
}

// S5: production plugin waits on the actual host sessions interface, then persists.
async function scenario5() {
  const env = await makeEnv('s5')
  const lease = await openLarkDedupStore(env.ledgerPath)
  const service = env.ctx.sessions
  const original = service.flush.bind(service)
  let release; const pending = new Promise(r => { release = r })
  let calls = 0; let observedSession = null
  service.flush = async (session) => { calls++; observedSession = session; return pending }
  await postText(env, { messageId: 'om_host_flush', chatId: 'oc_host_flush', text: 'synthetic flush barrier' })
  const key = larkDedupKey('cli_test', 'om_host_flush')
  await waitFor('S5 host flush called', () => calls > 0)
  assert.ok(observedSession && typeof observedSession.snapshotEvents === 'function', 'flush sees real host Session')
  assert.equal(lease.get(key).state, 'claimed', 'pending host flush cannot settle')
  release(false)
  await waitFor('S5 false flush releases', () => !lease.isProcessing(key))
  assert.equal(lease.get(key).state, 'claimed', 'host false is non-terminal')
  const messageId = lease.get(key).userMessageId
  service.flush = async (session) => { calls++; return original(session) }
  await postText(env, { messageId: 'om_host_flush', chatId: 'oc_host_flush', text: 'same event retry' })
  await waitFor('S5 true host flush settles', () => lease.get(key).state === 'delivered', 20000)
  assert.ok(calls >= 2)
  const agent = env.ctx.agents.get(observedSession.id)
  assert.equal(userMsgCount(agent, messageId), 1, 'real host admitted retry has exactly one user message')
  service.flush = original
  await lease.close(); await env.dispose()
  console.log('PASS S5 plugin awaits host flush; pending/false stay claimed; real true persists; admitted retry once')
}

// ── 主流程 ────────────────────────────────────────────────────────────────
await scenario1()
await scenario2()
await scenario3()
await scenario4a()
await scenario4b()
await scenario4c()
await scenario5()
await Promise.all(tmpDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })))

// 首末 hash：运行期间实现未被改动（与 Lead 基线的差异只打印，不作失败）。
const hashEnd = { index: sha256(implFiles.index), ledger: sha256(implFiles.ledger), admission: sha256(implFiles.admission) }
for (const key of Object.keys(hashStart)) {
  console.log('HASH-END ' + key + ' ' + hashEnd[key].slice(0, 16))
  assert.equal(hashEnd[key], hashStart[key], 'implementation changed during the run: ' + key)
}
console.log('lark-recovery-host: ok')
