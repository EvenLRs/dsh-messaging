// Real scoped Cordis/ToolRuntime/attachments/fs/policy lifecycle regression.
// Only temporary storage and fake network/WS; no image tool executions.
// DSH_HOSTX_ROOT is required (default /tmp/dsh-hostx); ordinary npm test is independent.
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

  await ctx.plugin(sessPkg.default)
  await ctx.plugin(FsLocal)
  await ctx.plugin(Proj) // sandboxPolicy 注入依赖 sessionProjections（真契约）
  let policyFiber = await ctx.plugin(SandboxPolicy, { workspaceRoot: ws })
  let attachmentsFiber = await ctx.plugin(AttachmentLocal, { dshHome: home })
  await ctx.plugin(SystemPrompt)

  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root: path.join(home, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })

  const ready = []
  let dispatch
  const realSdk = await import('@larksuiteoapi/node-sdk')
  ctx.provide('dshMessaging.larkSdk', {
    Client:realSdk.Client, LoggerLevel:realSdk.LoggerLevel,
    EventDispatcher:class {register(table){dispatch=table['im.message.receive_v1'];return this}},
    WSClient:class {constructor(p){ready.push(p.onReady)} async start(){} close(){}},
  })
  let registrations=0,disposals=0,lateDispose
  let asyncRegistration=false,failRegister=true
  const register=ToolRuntime.prototype.register
  ToolRuntime.prototype.register=function(tool){
    if(tool.name==='lark_send_image' && failRegister){failRegister=false;throw new Error('fixture registration refusal')}
    const dispose=register.call(this,tool)
    if(tool.name!=='lark_send_image')return dispose
    registrations++
    let done=false
    const exact=()=>{if(!done){done=true;disposals++}return dispose()}
    return asyncRegistration ? new Promise(resolve=>{lateDispose=()=>resolve(exact)}) : exact
  }
  const config=plugin.defaultConfig(ws)
  config.adapters.lark={...config.adapters.lark,enabled:true,mode:'long-connection',appId:'fixture',appSecret:'fake',interactiveCard:true}
  const pluginFiber=await ctx.plugin(plugin,config)
  await tick()
  async function route(url,method='GET',body){
    let output
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))])
    req.method=method;req.headers={host:'127.0.0.1:1','content-type':'application/json'}
    const res={writeHead(){},end(b){output=b}}
    await routes.get(url)(req,res)
    return JSON.parse(output)
  }
  const status=()=>route('/__dsh-messaging/status')
  const view=s=>s.channels.find(c=>c.key==='lark')
  const available=async()=>view(await status()).diagnostics.images.available
  let agent
  const tool=()=>agent && ctx.get('tools')?.get('lark_send_image',agent)
  async function settle(){for(let i=0;i<4;i++)await tick()}
  const unhandled=[];const onUnhandled=e=>unhandled.push(e)
  process.on('unhandledRejection',onUnhandled)
  const {sessionIdForKey}=await import('../lib/session-id-migration.js')
  let msg=0
  const bind=async()=>{
    await dispatch({header:{event_type:'im.message.receive_v1'},event:{message:{message_id:'fixture-'+(++msg),chat_id:'fixture-chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'synthetic'})},sender:{sender_id:{open_id:'synthetic'},sender_type:'user'}}})
    await settle()
    agent=ctx.agents.get(sessionIdForKey('lark:fixture-chat'))
    assert.ok(agent,'live bound agent')
  }
  try {
    const early=view(await status())
    assert.equal(early.diagnostics.operations.scope_read.attempted,1)
    assert.equal(early.diagnostics.images.available,false)
    assert.equal(ready.length,1)
    ready[0]()
    assert.equal(view(await status()).state,'running')
    assert.equal(await available(),false)
    const text=await route('/__dsh-messaging/send','POST',{channel:'lark',conversation:'lark:fixture',text:'fixture text'})
    assert.equal(text.ok,true,'text remains usable without optional services')
    let llmFiber=await ctx.plugin(llmPkg.default)
    await settle()
    assert.equal(await available(),false,'tools absent')
    let toolsFiber=await ctx.plugin(ToolRuntime)
    await settle()
    assert.equal(await available(),true,'ready services with no bound agents is healthy')
    assert.equal(registrations,0,'no global tool even when services ready')
    await bind()
    assert.equal(tool(),undefined)
    assert.equal(await available(),false,'bound scope registration refusal is visible')
    const failed=JSON.stringify(await status())
    assert.ok(failed.includes('image tool registration failed'))
    assert.equal(failed.includes('fixture registration refusal'),false)
    assert.doesNotThrow(()=>ready[0]())
    assert.ok(tool());assert.equal(await available(),true)
    assert.equal(registrations,1)
    ready[0]();ready[0]();await settle()
    assert.equal(registrations,1,'repeated ready is idempotent')
    const oldReady=ready[0],oldAgent=agent,oldTool=tool()
    await route('/__dsh-messaging/reload','POST',{});await settle()
    assert.equal(ready.length,2)
    assert.equal(await available(),false)
    oldReady();assert.equal(await available(),false,'retired WS cannot revive')
    ready[1]();await settle()
    assert.equal(await available(),true)
    assert.equal(tool(),undefined,'reload removed old agent registration')
    await bind()
    assert.notEqual(agent,oldAgent)
    assert.ok(tool());assert.equal(registrations,2)
    assert.equal((await oldTool.execute({file_path:'img.png'},{agent,callId:'stale'})).reason,'not_bound_to_lark')

    await llmFiber.dispose();await settle()
    assert.equal(await available(),false);assert.equal(tool(),undefined)
    const noLlmText=await route('/__dsh-messaging/send','POST',{channel:'lark',conversation:'lark:fixture',text:'fixture text'})
    assert.equal(noLlmText.ok,true)
    llmFiber=await ctx.plugin(llmPkg.default);await settle()
    assert.equal(await available(),true)
    await bind();assert.ok(tool());assert.equal(registrations,3)
    await toolsFiber.dispose();await settle()
    assert.equal(await available(),false);assert.equal(tool(),undefined)
    toolsFiber=await ctx.plugin(ToolRuntime);await settle()
    await bind();assert.ok(tool());assert.equal(await available(),true);assert.equal(registrations,4)
    await attachmentsFiber.dispose();await settle()
    assert.equal(await available(),false);assert.equal(tool(),undefined)
    attachmentsFiber=await ctx.plugin(AttachmentLocal,{dshHome:home});await settle()
    assert.ok(tool());assert.equal(await available(),true);assert.equal(registrations,5)
    await policyFiber.dispose();await settle()
    assert.equal(await available(),false);assert.equal(tool(),undefined)
    policyFiber=await ctx.plugin(SandboxPolicy,{workspaceRoot:ws});await settle()
    assert.ok(tool());assert.equal(await available(),true);assert.equal(registrations,6)

    await toolsFiber.dispose();await settle()
    asyncRegistration=true
    toolsFiber=await ctx.plugin(ToolRuntime);await settle()
    await bind()
    assert.equal(await available(),false,'unsupported async registration never becomes ready')
    assert.equal(typeof lateDispose,'function');assert.equal(registrations,7)
    const oldLate=lateDispose
    await toolsFiber.dispose();await settle()
    asyncRegistration=false
    toolsFiber=await ctx.plugin(ToolRuntime);await settle()
    await bind()
    const replacementTool=tool()
    assert.ok(replacementTool);assert.equal(await available(),true)
    oldLate();await settle()
    assert.equal(tool(),replacementTool,'old late disposer cannot remove replacement scope registration')
    assert.equal(await available(),true)
    await toolsFiber.dispose();await settle()
    asyncRegistration=true
    toolsFiber=await ctx.plugin(ToolRuntime);await settle()
    await bind()
    assert.equal(await available(),false)
    await pluginFiber.dispose();await settle()
    assert.equal(tool(),undefined)
    oldReady();ready[1]();await settle()
    assert.equal(tool(),undefined)
    lateDispose();await settle()
    assert.equal(tool(),undefined)
    assert.equal(registrations,9);assert.equal(disposals,9)
    assert.equal(wire.uploads,0)
    assert.deepEqual(unhandled,[])
    console.log('lark-image-services-host ok | real scoped services | ready with zero bindings; per-agent registration failure/late tools+llm/removal+replacement/WS-ready/reload/dispose/late disposer | fake network, zero image operations')
  } finally {
    process.off('unhandledRejection',onUnhandled)
    ToolRuntime.prototype.register=register
    await ctx.fiber.dispose()
    await fsp.rm(home,{recursive:true,force:true});await fsp.rm(ws,{recursive:true,force:true})
  }
}
main().catch(err=>{console.error(err);process.exit(1)})
