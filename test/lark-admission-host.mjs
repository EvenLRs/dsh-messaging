// 真实宿主准入探针（手动运行，不进 npm test 链——package.json 未改）。
//
// 依赖一次性解包的已装宿主（默认 /tmp/dsh-hostx，可用 DSH_HOSTX_ROOT 覆盖）。
// 环境不存在时**明确失败并说明**（不静默 SKIP、不 mock 冒充真实宿主）。
// 验证面：真实 sessionProjections 注册/折叠、真实 SessionStore flush 布尔、
// 崩溃恢复（flush 过→admitted / 未 flush→not_admitted）、compaction replace 后
// 投影保留（deriveMessages 会丢）、投影缺失 fail-closed。
//
// 用法：node test/lark-admission-host.mjs
import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOSTX = resolve(process.env.DSH_HOSTX_ROOT || '/tmp/dsh-hostx')
const hostModules = join(HOSTX, 'dsh', 'node_modules', '@deepseek-ai')
if (!existsSync(hostModules)) {
  console.error('lark-admission-host: FATAL — unpacked installed host not found at ' + hostModules)
  console.error('This probe requires the read-only unpack of the installed app (app.asar 0.2.0-rc.2).')
  console.error('Set DSH_HOSTX_ROOT to the unpack root or re-extract; refusing to mock the host.')
  process.exit(1)
}

const imp = (p) => import(join(hostModules, p, 'lib', 'index.js'))
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

const repo = resolve(import.meta.dirname, '..')
const admission = await import(pathToFileURL(join(repo, 'lib', 'lark-admission.js')).href)
const dedup = await import(pathToFileURL(join(repo, 'lib', 'lark-dedup.js')).href)

class Mock extends llm.LlmAdapter {
  constructor() { super(); this.n = 0 }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream() { this.n += 1; const t = 'ok' + this.n
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: t }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: t } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } } }
}

const AO = { provider: 'mock', model: 'm' }
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''))
}

async function mount(root, registerDefinition) {
  const ctx = new Context()
  await ctx.plugin(llm.default); await ctx.plugin(sess.default); await ctx.plugin(Proj)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root }); await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new Mock())
  if (registerDefinition) ctx.sessionProjections.register(registerDefinition)
  return ctx
}

const um = (id, text) => ({ id: llm.MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const def = admission.createLarkAdmissionDefinition()

// ---------- P1：真实注册 + 前置判据 not_admitted → followup → 真实投影 admitted ----------
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p1-'))
  // ledger 必须在 session root 之外：JSONL 后端拒绝 root 下的 flat 文件布局。
  const ledgerDir = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p1-ledger-'))
  const store = await dedup.openLarkDedupStore(ledgerDir)
  const ctx = await mount(root, def)
  const { agent } = await ctx.agents.create({ sessionId: sess.SessionId('s1'), meta: { cwd: root }, agentOptions: AO })
  const claim = await store.claim({ appId: 'cli_probe', messageId: 'om_p1', chatId: 'oc_1', chatType: 'p2p', sessionId: 's1', sessionExisted: false })
  const umid = claim.record.userMessageId
  const before = admission.larkAdmissionVerdict({
    userMessageId: umid,
    inboxIds: admission.larkAdmissionInboxIds(agent),
    projectionState: ctx.sessionProjections.stateOf(agent.session, admission.LARK_ADMISSION_KEY),
  })
  check('P1 pre-followup verdict not_admitted', before.verdict === 'not_admitted', JSON.stringify(before))
  agent.followup(um(umid, 'probe'))
  const after = admission.larkAdmissionVerdict({
    userMessageId: umid,
    inboxIds: admission.larkAdmissionInboxIds(agent),
    projectionState: ctx.sessionProjections.stateOf(agent.session, admission.LARK_ADMISSION_KEY),
  })
  check('P1 post-followup admitted via real projection', after.verdict === 'admitted', JSON.stringify(after))
  const flushed = await ctx.sessions.flush(agent.session)
  check('P1 real flush returns true', flushed === true, 'flushed=' + String(flushed))
  await store.settleDelivered(claim.record.key, { flushed: flushed === true, admission: after })
  check('P1 settleDelivered accepted real evidence (flushed + admitted verdict)', store.get(claim.record.key).state === 'delivered')
  await ctx.fiber.dispose()
  await store.close()
}

// ---------- P2：崩溃恢复：flush 过 → admitted；未 flush → not_admitted（可安全重投） ----------
// 真实崩溃必须子进程 process.exit（主进程 dispose 会排空 write-behind，等于 flush 过）。
{
  for (const mode of ['flush', 'noflush']) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p2-' + mode + '-'))
    const ledgerDir = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p2-' + mode + '-ledger-'))
    const childScript = join(root, 'crash-child.mjs')
    const childSource = [
      "import { mkdtemp } from 'node:fs/promises'",
      "import { tmpdir } from 'node:os'",
      "import { join } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      `const admission = await import(${JSON.stringify(pathToFileURL(join(repo, 'lib', 'lark-admission.js')).href)})`,
      `const dedup = await import(${JSON.stringify(pathToFileURL(join(repo, 'lib', 'lark-dedup.js')).href)})`,
      `const [root, ledgerDir, mode] = process.argv.slice(2)`,
      'const host = await import(' + JSON.stringify(pathToFileURL(join(hostModules, 'dsh-session', 'lib', 'index.js')).href) + ')',
      'const llmMod = await import(' + JSON.stringify(pathToFileURL(join(hostModules, 'dsh-llm', 'lib', 'index.js')).href) + ')',
      // 复用探针 mount（由本脚本内联同构装配）
      `const { Context } = await import(${JSON.stringify(pathToFileURL(join(hostModules, 'cordis', 'lib', 'index.js')).href)})`,
      `const llm = llmMod; const sess = host`,
      `const SystemPrompt = (await import(${JSON.stringify(pathToFileURL(join(hostModules, 'dsh-system-prompt', 'lib', 'index.js')).href)})).default`,
      `const ToolRuntime = (await import(${JSON.stringify(pathToFileURL(join(hostModules, 'dsh-tools', 'lib', 'index.js')).href)})).default`,
      `const AgentRegistry = (await import(${JSON.stringify(pathToFileURL(join(hostModules, 'dsh-agent', 'lib', 'index.js')).href)})).default`,
      `const jm = await import(${JSON.stringify(pathToFileURL(join(hostModules, 'dsh-session-persistence-jsonl', 'lib', 'index.js')).href)}); const Jsonl = jm.default || jm`,
      `const AgentLoop = (await import(${JSON.stringify(pathToFileURL(join(hostModules, 'dsh-agent-loop', 'lib', 'index.js')).href)})).default`,
      `const Proj = (await import(${JSON.stringify(pathToFileURL(join(hostModules, 'dsh-session-projection', 'lib', 'index.js')).href)})).default`,
      'class Mock extends llm.LlmAdapter { constructor(){ super(); this.n=0 } resolveModel(p,m){ return Promise.resolve({provider:p,id:m,name:m}) } async *stream(){ this.n++; const t="ok"+this.n; yield {type:"block-start",index:0,blockType:"text"}; yield {type:"text-delta",index:0,text:t}; yield {type:"block-end",index:0,block:{type:"text",text:t}}; yield {type:"usage",usage:{inputTokens:1,outputTokens:1}}; yield {type:"finish",reason:{kind:"stop"}} } }',
      'const ctx = new Context()',
      'await ctx.plugin(llm.default); await ctx.plugin(sess.default); await ctx.plugin(Proj)',
      'await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)',
      'await ctx.plugin(Jsonl, { root }); await ctx.plugin(AgentLoop, { agents: [] })',
      'ctx.llm.registerAdapter(["mock"], new Mock())',
      'ctx.sessionProjections.register(admission.createLarkAdmissionDefinition())',
      'const store = await dedup.openLarkDedupStore(ledgerDir)',
      "const claim = await store.claim({ appId: 'cli_probe', messageId: 'om_crash_' + mode, chatId: 'oc_1', sessionId: 's1', sessionExisted: false })",
      'const { agent } = await ctx.agents.create({ sessionId: sess.SessionId("s1"), meta: { cwd: root }, agentOptions: { provider: "mock", model: "m" } })',
      'await ctx.sessions.flush(agent.session)', // 会话本身先落盘（区分“曾存在后删除”与“从未创建”两种恢复形态）
      'agent.followup({ id: llm.MessageId(claim.record.userMessageId), role: "user", content: [{ type: "text", text: "crash probe" }], source: { kind: "user" } })',
      'if (mode === "flush") await ctx.sessions.flush(agent.session)',
      'process.exit(9)', // 真实崩溃：不 dispose（write-behind 未排空即退出）
    ].join('\n')
    const { spawnSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(childScript, childSource)
    const child = spawnSync(process.execPath, [childScript, root, ledgerDir, mode], { encoding: 'utf8' })
    check('P2 child crashed with exit 9 (' + mode + ')', child.status === 9, 'status=' + String(child.status) + (child.stderr ? ' stderr=' + child.stderr.slice(0, 200) : ''))
    // 冷恢复：父进程重开同一 ledgerDir + resume。
    // noflush 崩溃的真实形态：会话本身也从未落盘（create+followup 全在 write-behind）
    // → resume 抛 SessionPersistenceNotFoundError；ledger 的 sessionExisted 检查点
    // （本探针为 false）正是接线区分“从未创建（可按原规则 create）”与“曾存在后删除
    // （不得新建补投）”的依据。
    const store = await dedup.openLarkDedupStore(ledgerDir)
    const rows = store.recover()
    check('P2 ledger survives crash (' + mode + ')', rows.length === 1, 'rows=' + String(rows.length))
    const ctx = await mount(root, def)
    let resumeError = null
    let handle = null
    try {
      handle = await ctx.agents.resume({ resumeSessionId: sess.SessionId('s1'), agentOptions: AO })
    } catch (error) {
      resumeError = error
    }
    if (mode === 'noflush' && resumeError && resumeError.name === 'SessionPersistenceNotFoundError') {
      check('P2 unflushed crash → session never materialized (sessionExisted=false permits recreate)', rows[0].sessionExisted === false, 'sessionExisted=' + String(rows[0].sessionExisted))
      const verdict = admission.larkAdmissionVerdict({
        userMessageId: rows[0].userMessageId,
        inboxIds: [],
        projectionState: undefined,
      })
      check('P2 unflushed crash → uncertain with no session (safe: recreate once, never double-admit)', verdict.verdict === 'uncertain', JSON.stringify(verdict))
      await ctx.fiber.dispose()
      await store.close()
      continue
    }
    if (resumeError) {
      check('P2 unexpected resume failure (' + mode + ')', false, String(resumeError.message).slice(0, 160))
      await ctx.fiber.dispose()
      await store.close()
      continue
    }
    const verdict = admission.larkAdmissionVerdict({
      userMessageId: rows[0].userMessageId,
      inboxIds: admission.larkAdmissionInboxIds(handle.agent),
      projectionState: ctx.sessionProjections.stateOf(handle.agent.session, admission.LARK_ADMISSION_KEY),
    })
    if (mode === 'flush') {
      check('P2 flushed crash → admitted (no redelivery)', verdict.verdict === 'admitted', JSON.stringify(verdict))
    } else {
      check('P2 unflushed crash with live session → not_admitted (safe redelivery)', verdict.verdict === 'not_admitted', JSON.stringify(verdict))
    }
    await ctx.fiber.dispose()
    await store.close()
  }
}

// ---------- P3：compaction replace 后 deriveMessages 丢、投影保留 ----------
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p3-'))
  const ledgerDir = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p3-ledger-'))
  const store = await dedup.openLarkDedupStore(ledgerDir)
  const ctx = await mount(root, def)
  const { agent } = await ctx.agents.create({ sessionId: sess.SessionId('s2'), meta: { cwd: root }, agentOptions: AO })
  const c1 = await store.claim({ appId: 'cli_probe', messageId: 'om_c1', sessionId: 's2', sessionExisted: false })
  const c2 = await store.claim({ appId: 'cli_probe', messageId: 'om_c2', sessionId: 's2', sessionExisted: false })
  agent.followup(um(c1.record.userMessageId, 'c1'))
  await ctx.sessions.flush(agent.session)
  agent.followup(um(c2.record.userMessageId, 'c2'))
  await ctx.sessions.flush(agent.session)
  await agent.whenIdle()
  const session = agent.session
  // 照 dsh-compaction-basic 同形：surface replace 覆盖除首节点外的全部节点。
  const end = session.seq - 1
  const surf = session.surface
  const nodes = [...surf.nodes]
  const shadowed0 = nodes.map((n) => (typeof n === 'number' ? n : (n.seq ?? (n.event && n.event.seq)))).filter((x) => x !== undefined && x <= end)
  const shadowed = shadowed0.slice(1)
  let appendError = null
  try {
    session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: 'SUMMARY' }], source: { kind: 'compaction' } }), {
      surfaceOp: { op: 'replace', startSeq: sess.SessionSeq(shadowed[0]), endSeq: sess.SessionSeq(shadowed[shadowed.length - 1]) },
      sourceEventSeqs: shadowed,
    })
  } catch (error) {
    appendError = String(error && error.message).slice(0, 200)
  }
  if (appendError) {
    check('P3 compaction-shaped replace accepted', false, appendError)
  } else {
    const projState = ctx.sessionProjections.stateOf(agent.session, admission.LARK_ADMISSION_KEY)
    const derivedUsers = session.deriveMessages().filter((m) => m.role === 'user').map((m) => m.id)
    const v1 = admission.larkAdmissionVerdict({ userMessageId: c1.record.userMessageId, inboxIds: [], projectionState: projState })
    const v2 = admission.larkAdmissionVerdict({ userMessageId: c2.record.userMessageId, inboxIds: [], projectionState: projState })
    check('P3 deriveMessages lost c1 after replace', !derivedUsers.includes(c1.record.userMessageId), JSON.stringify(derivedUsers))
    check('P3 projection still admits c1', v1.verdict === 'admitted', JSON.stringify(v1))
    check('P3 projection still admits c2', v2.verdict === 'admitted', JSON.stringify(v2))
  }
  await ctx.fiber.dispose()
  await store.close()
}

// ---------- P4：投影服务缺失（未注册）→ uncertain（fail-closed），绝不当未命中 ----------
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p4-'))
  const ledgerDir = await mkdtemp(join(tmpdir(), 'dsh-dedup-host-p4-ledger-'))
  const store = await dedup.openLarkDedupStore(ledgerDir)
  const ctx = await mount(root, null)
  const { agent } = await ctx.agents.create({ sessionId: sess.SessionId('s3'), meta: { cwd: root }, agentOptions: AO })
  const claim = await store.claim({ appId: 'cli_probe', messageId: 'om_noproj', sessionId: 's3', sessionExisted: false })
  const verdict = admission.larkAdmissionVerdict({
    userMessageId: claim.record.userMessageId,
    inboxIds: admission.larkAdmissionInboxIds(agent),
    projectionState: ctx.sessionProjections.stateOf(agent.session, admission.LARK_ADMISSION_KEY),
  })
  check('P4 missing projection → uncertain fail-closed', verdict.verdict === 'uncertain' && verdict.reason === 'projection_missing', JSON.stringify(verdict))
  await ctx.fiber.dispose()
  await store.close()
}

const failed = results.filter((r) => !r.ok)
console.log('----')
console.log('real-host probe: ' + String(results.length - failed.length) + '/' + String(results.length) + ' passed')
if (failed.length > 0) process.exit(1)
