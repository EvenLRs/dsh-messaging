// lark-image-tool-real.cjs —— 真实组合验收（Lead 终项）：真实 ToolRuntime + 真实
// dsh-sandbox-policy + 真实 dsh-fs-local + 真实 dsh-attachment-local(sharp) + 真实插件
// 注册的 lark_send_image；仅 Feishu 网络（curl 壳）与 LLM adapter 为 fake。
// 夹具：DSH_HOSTX_ROOT（默认 /tmp/dsh-hostx）；缺失明确失败。
// 断言：exec 缺失/策略拒绝/取消 → 零读取零上传；会话 cwd 权威；合法路径恰一上传一发送；
// 真实 sandboxPolicy.resolve 签名与接线调用一致（不自造）。
'use strict'
import './_guard.cjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dirname, '..')
const HOSTX = process.env.DSH_HOSTX_ROOT ? path.resolve(process.env.DSH_HOSTX_ROOT) : '/tmp/dsh-hostx'
const HOST_MODULES = path.join(HOSTX, 'dsh', 'node_modules', '@deepseek-ai')
if (!existsSync(path.join(HOST_MODULES, 'dsh-tools'))) {
  console.error('lark-image-tool-real: FATAL — unpacked installed host not found at ' + HOST_MODULES)
  process.exit(1)
}
const imp = (pkg) => import(pathToFileURL(path.join(HOST_MODULES, pkg, 'lib', 'index.js')).href)
const tick = () => new Promise((r) => setTimeout(r, 25))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const { Context } = await imp('cordis')
const llmPkg = await imp('dsh-llm')
const sessPkg = await imp('dsh-session')
const SystemPrompt = (await imp('dsh-system-prompt')).default
const ToolRuntime = (await imp('dsh-tools')).default
const AgentRegistry = (await imp('dsh-agent')).default
const jsonlModule = await imp('dsh-session-persistence-jsonl')
const Jsonl = jsonlModule.default || jsonlModule
const AgentLoop = (await imp('dsh-agent-loop')).default
const Proj = (await imp('dsh-session-projection')).default
const FsLocal = (await imp('dsh-fs-local')).default
const SandboxPolicy = (await imp('dsh-sandbox-policy')).default
const AttachmentLocal = (await imp('dsh-attachment-local')).default
const plugin = (await import(pathToFileURL(path.join(repo, 'lib', 'index.js')).href))

async function main() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-imgtool-'))
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-imgtool-ws-'))
  fs.writeFileSync(path.join(ws, 'img.png'), PNG)

  const routes = new Map()
  const wire = { uploads: 0, sends: 0, images: 0, notices: 0 }
  const classify = (raw) => {
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw
    const content = JSON.parse(body.content)
    if (body.msg_type === 'image' && content.image_key) wire.images++
    else if (body.msg_type === 'text' && content.text.includes('不支持图片输入')) wire.notices++
    else assert.fail('unexpected synthetic message class')
  }
  // SDK 出站（axios 面）fake：仅 Feishu 网络 fake——默认 adapter 兑底到模块内
  // axios.create({timeout}) 实例（凭据/图片/消息三类 URL 计数）。
  const axios = (await import('axios')).default
  wire.lastUrl = null
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || '')
    wire.lastUrl = url
    if (url.includes('/auth/v3/tenant_access_token')) return { data: { code: 0, tenant_access_token: 't-1', expire: 7200 }, status: 200, headers: {}, config }
    if (url.includes('/im/v1/images')) { wire.uploads += 1; return { data: { code: 0, data: { image_key: 'img_v3_real' } }, status: 200, headers: {}, config } }
    if (url.includes('/im/v1/messages')) { wire.sends += 1; classify(config.data); return { data: { code: 0, data: { message_id: 'om_real_1' } }, status: 200, headers: {}, config } }
    const err = new Error('unexpected feishu url ' + url); throw err
  }
  const fakeShell = {
    resolve: (r) => r,
    async run(request) {
      const stdin = String(request.stdin || '')
      // 仅 fake 飞书网络面：upload/send 计数 + 成功应答（body+marker 约定）。
      let body = '{"code":0,"data":{"message_id":"om_real_1"}}'
      if (stdin.includes('/open-apis/auth/')) body = '{"code":0,"tenant_access_token":"t-1","expire":7200}'
      else if (stdin.includes('/im/v1/images')) { wire.uploads += 1; body = '{"code":0,"data":{"image_key":"img_v3_real"}}' }
      else if (stdin.includes('/im/v1/messages')) {
        wire.sends += 1
        const line = stdin.split('\n').find(line => line.startsWith('data-binary = '))
        classify(line.slice('data-binary = '.length).slice(1, -1).replace(/\\(["\\])/g, '$1'))
      }
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: body + '\n__DSH_STATUS__:200', truncated: false }, stderr: { text: '', truncated: false } }
    },
    start() { return { status: 'running', done: Promise.resolve(), readOutput() { return { delta: '', lossy: false } }, kill() { return false } } },
  }

  const ctx = new Context()
  await ctx.plugin((await imp('cordis-plugin-timer')).default)
  ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
  ctx.provide('shell', fakeShell)
  ctx.provide('agentDefaultModel', { currentSelection() { return { provider: 'mock', model: 'm' } } })
  ctx.provide('dsh.home', home)
  ctx.provide('dshMessaging.root', home)
  // 真实授权/文件/附件栈（不 fake）。
  await ctx.plugin(llmPkg.default)
  await ctx.plugin(sessPkg.default)
  await ctx.plugin(FsLocal)
  await ctx.plugin(Proj) // sandboxPolicy 注入依赖 sessionProjections（真契约）
  await ctx.plugin(SandboxPolicy, { workspaceRoot: ws })
  await ctx.plugin(AttachmentLocal, { dshHome: home })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root: path.join(home, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  // mock LLM adapter（允许的 fake 边界；视觉能力如实由 catalog 决定）。
  try {
    const MockAdapter = class { get id() { return 'mock' } async list() { return [] } async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } }
    ctx.llm.registerAdapter(['mock'], new MockAdapter())
  } catch { /* dsh-llm 版本差异：以下用 tool 拒绝结果如实反映能力缺失 */ }

  // 真实 fs 计数包装（方法级，底层仍为真 fs-local）。
  const counts = { readBytes: 0 }
  const realFs = ctx.fs
  const origReadBytes = realFs.readBytes.bind(realFs)
  realFs.readBytes = (...args) => { counts.readBytes += 1; return origReadBytes(...args) }

  // 真实 sandboxPolicy 契约核验：resolve({session}) → {mode, workspaceRoot}；
  // per-call root = session.header.cwd（真实会话对象在用例5 内再验，需真 cursor）。
  const sp = ctx.get('sandboxPolicy')
  assert.ok(sp && typeof sp.resolve === 'function', '真实 sandboxPolicy 服务存在且带 resolve（非自造 resolvePolicy）')
  const barePol = sp.resolve({})
  assert.equal(typeof barePol.workspaceRoot, 'string', '无会话调用返回部署默认 workspaceRoot')
  assert.ok(String(barePol.workspaceRoot).endsWith(path.basename(ws)), '部署默认 = 配置 root（宿主规范化；macOS /var 不强求 symlink 展开）')

  // 真实插件应用（webhook 模式；appId/verificationToken 供入站绑定会话）。
  const config = plugin.defaultConfig(ws)
  config.adapters.lark = Object.assign({}, config.adapters.lark, {
    enabled: true, mode: 'webhook', appId: 'cli_realtool', appSecret: 'secret', verificationToken: 'tok_rt', interactiveCard: false,
  })
  config.agent = Object.assign({}, config.agent, { provider: 'mock', model: 'm', cwd: ws })
  await ctx.plugin(plugin, config) // production Cordis scope: exercises inject guards
  await tick()

  const handler = routes.get('/messaging/lark/events')
  assert.ok(handler, '真实插件注册 webhook 路由')
  const postInbound = async (messageId, chatId, type = 'text') => {
    const body = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'tok_rt', event_id: 'ev_' + messageId },
      event: { message: { message_id: messageId, chat_id: chatId, chat_type: 'p2p', message_type: type, content: JSON.stringify(type === 'image' ? { image_key: 'img_fixture_text_only' } : { text: 'bind' }) }, sender: { sender_id: { open_id: 'ou_rt' }, sender_type: 'user' } },
    })
    const req = Readable.from([Buffer.from(body, 'utf8')])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json' }
    const res = { headersSent: false, writeHead() { this.headersSent = true }, end() {} }
    await handler(req, res)
    await tick()
    await tick()
  }
  await postInbound('om_bind_1', 'oc_rt1')
  // 真实 registry 取绑定 agent：会话 id 确定性推导（与插件一致）。
  const { sessionIdForKey } = await import(pathToFileURL(path.join(repo, 'lib', 'session-id-migration.js')).href)
  const sid1 = sessionIdForKey('lark:oc_rt1')
  const agent1x = ctx.agents.get(sid1)
  assert.ok(agent1x, '真实 registry 取回绑定会话 agent（真实组合）')
  assert.equal(ctx.tools.get('lark_send_image'), undefined, 'no global tool publication')
  assert.ok(ctx.tools.get('lark_send_image', agent1x), 'bound agent scope owns tool')

  const exec = (agent, extra = {}) => ctx.tools.execute({ callId: 'ct-' + crypto.randomBytes(4).toString('hex'), name: 'lark_send_image', arguments: extra.args || { file_path: 'img.png' }, agent, signal: extra.signal || new AbortController().signal })

  // 1) exec 缺失（无 agent）→ 拒绝且零读取零上传
  {
    const beforeR = counts.readBytes; const beforeU = wire.uploads; const beforeS = wire.sends
    const res = await ctx.tools.execute({ callId: 'noagent', name: 'lark_send_image', arguments: { file_path: 'img.png' }, signal: new AbortController().signal })
    assert.notEqual(res.value && res.value.ok, true, 'exec 缺失不成功')
    assert.equal(counts.readBytes, beforeR, 'exec 缺失零读取')
    assert.equal(wire.uploads + wire.sends, beforeU + beforeS, 'exec 缺失零上传零发送')
  }
  // 2) 策略拒绝（绝对路径出界）→ 零读取零上传
  {
    const beforeR = counts.readBytes; const beforeU = wire.uploads
    const res = await exec(agent1x, { args: { file_path: '/etc/hosts' } })
    assert.notEqual(res.value && res.value.ok, true, '出界不成功')
    assert.equal(counts.readBytes, beforeR, '策略拒绝零读取')
    assert.equal(wire.uploads, beforeU, '策略拒绝零上传')
  }
  // 3) 取消（预先中止）→ 零上传零发送
  {
    const beforeU = wire.uploads; const beforeS = wire.sends
    const ctl = new AbortController()
    ctl.abort()
    const res = await exec(agent1x, { signal: ctl.signal })
    assert.notEqual(res.value && res.value.ok, true, '取消不成功')
    assert.equal(wire.uploads + wire.sends, beforeU + beforeS, '取消零上传零发送')
  }
  // Non-boolean contains answers must deny before file bytes or upload.
  {
    const contains = realFs.contains
    for (const answer of [undefined, null, 1, 'true', {}, Promise.resolve(undefined)]) {
      realFs.contains = () => answer
      const beforeR = counts.readBytes; const beforeU = wire.uploads
      const res = await exec(agent1x)
      assert.notEqual(res.value && res.value.ok, true)
      assert.equal(counts.readBytes, beforeR, 'contains non-boolean: zero reads')
      assert.equal(wire.uploads, beforeU, 'contains non-boolean: zero uploads')
      assert.equal(JSON.stringify(res.value).includes(ws), false, 'failure hides path')
      assert.equal(JSON.stringify(res.value).includes('t-1'), false, 'failure hides token')
    }
    realFs.contains = contains
  }
  // 4) 合法路径：真实授权链 → 恰一次上传 + 一次发送
  {
    const res = await exec(agent1x)
    assert.equal(res.value && res.value.ok, true, '真实组合合法路径成功：' + JSON.stringify(res.value).slice(0, 160) + ' lastUrl=' + String(wire.lastUrl).slice(0, 110))
    assert.equal(wire.uploads, 1, '恰一次上传（真附件服务解码+真策略放行）')
    assert.equal(wire.sends, 1, '恰一次发送')
    assert.equal(JSON.stringify(res.value).includes(ws), false, 'success hides local path')
    assert.equal(JSON.stringify(res.value).includes('t-1'), false, 'success hides token')
  }
  // 5) 会话 cwd 权威：另一会话（cwd=其它目录）下同名文件不可见（真实 fs base=cwd）
  {
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-imgtool-ws2-'))
    const sid2 = 's-othercwd-' + crypto.randomBytes(3).toString('hex')
    const handle2 = await ctx.agents.create({ sessionId: sid2, meta: { cwd: other }, agentOptions: { provider: 'mock', model: 'm' } })
    // 真实会话对象上的 per-call 契约：root 跟随该会话 cwd。
    const pol2 = sp.resolve({ session: handle2.agent.session })
    assert.ok(String(pol2.workspaceRoot).endsWith(path.basename(other)), '真实会话 per-call root = session.header.cwd（隔离）')
    const beforeR = counts.readBytes
    const res = await exec(handle2.agent, { args: { file_path: 'img.png' } }) // other 目录下无此文件
    assert.notEqual(res.value && res.value.ok, true, '另一会话 cwd 下缺文件不成功')
    assert.equal(counts.readBytes, beforeR, '会话 cwd 隔离：零读取')
  }

  // A real scoped plugin must reach the currently bound LLM metadata service.
  // Explicit text-only metadata refuses inbound images before any decode/download.
  let modelReads = 0
  const llmService = ctx.get('llm')
  const modelInfo = llmService.resolveModelInfo
  llmService.resolveModelInfo = async () => { modelReads++; return { inputModalities: ['text'] } }
  const readBefore = counts.readBytes; const uploadsBefore = wire.uploads
  await postInbound('om_text_only', 'oc_rt1', 'image')
  assert.ok(modelReads > 0, 'scoped inbound path reaches real LLM service (response fake), no inject guard swallowed')
  assert.equal(counts.readBytes, readBefore)
  assert.equal(wire.uploads, uploadsBefore)
  let snapshot
  await routes.get('/__dsh-messaging/status')({method:'GET', headers:{host:'127.0.0.1:1'}}, {writeHead(){},end(body){snapshot=JSON.parse(body)}})
  assert.equal(snapshot.channels.find(c=>c.key==='lark').diagnostics.images.operations.image_download.attempted,0)
  assert.equal(wire.images, 1, 'wire: exactly one legal image payload')
  assert.equal(wire.notices, 1, 'wire: exactly one text-only notice payload')
  llmService.resolveModelInfo = modelInfo

  await ctx.fiber.dispose()
  console.log('lark-image-tool-real ok | real ToolRuntime+sandboxPolicy+fs-local+attachments | fake: feishu-network/llm | uploads=' + wire.uploads + ' sends=' + wire.sends)
}

main().catch((err) => { console.error(err); process.exit(1) })
