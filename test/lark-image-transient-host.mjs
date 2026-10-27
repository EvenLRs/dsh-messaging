// Real Cordis plugin scopes/services; transient LLM capability and projection failures.
// Only synthetic Feishu network and model metadata are fake. No desktop access.
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
  const wire = { uploads: 0, sends: 0, notices: 0 }
  // SDK 出站（axios 面）fake：仅 Feishu 网络 fake——默认 adapter 兑底到模块内
  // axios.create({timeout}) 实例（凭据/图片/消息三类 URL 计数）。
  const axios = (await import('axios')).default
  wire.lastUrl = null
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || '')
    wire.lastUrl = url
    if (url.includes('/auth/v3/tenant_access_token')) return { data: { code: 0, tenant_access_token: 't-1', expire: 7200 }, status: 200, headers: {}, config }
    if (url.includes('/im/v1/images')) { wire.uploads += 1; return { data: { code: 0, data: { image_key: 'img_v3_real' } }, status: 200, headers: {}, config } }
    if (url.includes('/resources/')) { downloads++; return {data: Readable.from([PNG]),status:200,headers:{'content-type':'image/png'},config} }
    if (url.includes('/im/v1/messages')) { wire.sends += 1; return { data: { code: 0, data: { message_id: 'om_real_1' } }, status: 200, headers: {}, config } }
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
      else if (stdin.includes('/im/v1/messages')) wire.sends += 1
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
  let llmFiber = await ctx.plugin(llmPkg.default)
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
  const rawError = 'SYNTHETIC_PRIVATE_PROJECTION_ERROR'
  if (process.env.DSH_TEST_PROJECTION_FAILURE) {
    ctx.get('sessionProjections').register = () => { throw new Error(rawError) }
  }
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

  const status = async () => {
    let result
    await routes.get('/__dsh-messaging/status')({method:'GET',headers:{host:'127.0.0.1:1'}},{writeHead(){},end(body){result=JSON.parse(body)}})
    return result
  }
  if (process.env.DSH_TEST_PROJECTION_FAILURE) {
    const serialized = JSON.stringify(await status())
    assert.ok(serialized.includes('admission projection registration failed'))
    assert.equal(serialized.includes(rawError), false)
    await ctx.fiber.dispose()
    console.log('projection failure fixed anonymous status diagnostic: ok')
    return
  }
  const wait = async (label, test, ms=18000) => {
    const deadline=Date.now()+ms
    while (!test()) { assert.ok(Date.now()<deadline,label); await tick() }
  }
  const { openLarkDedupStore, larkDedupKey } = await import('../lib/lark-dedup.js')
  const lease = await openLarkDedupStore(path.join(home,'lark-dedup'))
  const key = id => larkDedupKey('cli_realtool', id)
  const ids=[]
  const unhandled=[]
  const onUnhandled=e=>unhandled.push(e)
  process.on('unhandledRejection',onUnhandled)
  let downloads=0
  // Real SDK resource GET consumes a fake axios response stream; host attachments remain real.
  const unknown = async (id) => {
    console.log('transient case:',id)
    ids.push(id)
    await postInbound(id,'oc_transient','image')
    await wait(id+' released',()=>lease.get(key(id)) && !lease.isProcessing(key(id)))
    assert.equal(lease.get(key(id)).state,'claimed',id)
    assert.equal(downloads,0)
    assert.equal(wire.uploads+wire.sends,0,'unknown metadata has no network side effects')
  }
  let service=ctx.get('llm')
  if (!process.env.DSH_TEST_REPLACEMENT_ONLY) {
    await llmFiber.dispose(); await tick()
    await unknown('om_missing_llm')
    llmFiber=await ctx.plugin(llmPkg.default); await tick()
    service=ctx.get('llm')
    service.resolveModelInfo=async()=>{throw new Error('SYNTHETIC_PRIVATE_MODEL_ERROR')}
    await unknown('om_resolve_throw')
    for (const [i,info] of [undefined,{}, {inputModalities:null},{inputModalities:'image'},
        {inputModalities:[]},{inputModalities:['garbage']},{inputModalities:['image',42]}, {inputModalities:new Array(1)}].entries()) {
      service.resolveModelInfo=async()=>info
      await unknown('om_invalid_'+i)
    }
    service.resolveModelInfo=async()=>({inputModalities:['text','image']})
    await wait('initial queue recovery',()=>ids.every(id=>lease.get(key(id)).state==='delivered'),60000)
    console.log('initial queue recovered')
  }
  const recoveredDownloads=downloads
  let resolveOld, entered=false
  const oldPending = new Promise(r=>{resolveOld=r})
  service.resolveModelInfo=async()=>{entered=true; return oldPending}
  ids.push('om_replaced')
  const pendingPost = postInbound('om_replaced','oc_transient','image')
  await wait('metadata pending',()=>entered)
  await llmFiber.dispose(); await tick()
  llmFiber=await ctx.plugin(llmPkg.default); await tick()
  service=ctx.get('llm')
  service.resolveModelInfo=async()=>({inputModalities:['text','image']})
  resolveOld({inputModalities:['text']})
  await pendingPost
  await wait('replacement releases',()=>!lease.isProcessing(key('om_replaced')))
  assert.equal(lease.get(key('om_replaced')).state,'claimed')
  assert.equal(downloads,recoveredDownloads)
  assert.equal(wire.sends+wire.uploads,0)
  await wait('bounded queue recovers all',()=>ids.every(id=>lease.get(key(id)).state==='delivered'),30000)
  const {sessionIdForKey}=await import('../lib/session-id-migration.js')
  const agent=ctx.get('agents').get(sessionIdForKey('lark:oc_transient'))
  const events=agent.session.snapshotEvents()
  for(const id of ids){
    const uid=lease.get(key(id)).userMessageId
    const inserted=events.flatMap(e=>e.type==='agent/inbox/spliced' ? e.data.inserted : []).filter(m=>m.id===uid)
    assert.equal(inserted.length,1,'exactly one durable admission per recovered image')
  }
  assert.equal(downloads,ids.length)
  assert.equal(wire.uploads+wire.sends,0)
  assert.deepEqual(unhandled,[])
  await lease.close()
  await ctx.fiber.dispose()
  process.removeListener('unhandledRejection',onUnhandled)
  console.log('transient metadata true host scopes: '+ids.length+' claimed -> delivered once; zero notices/uploads; fake network/model only')
}
main().catch(err=>{console.error(err);process.exit(1)})
