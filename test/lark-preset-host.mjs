// Real 0.2.1-rc.3 Loader/PresetRegistry/Agent/Tools/FS/bash/subprocess.
// Feishu and model responses are fake; all paths and images are temporary.
// Native bash actually generates a PNG. PTC below checks presentation/SDK only.
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
const Jsonl = await imp('dsh-session-persistence-jsonl')
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
    if (url.includes('/im/v1/messages') && String(config.method).toLowerCase()==='get') return {data:{code:0,data:{items:[{msg_type:'text',body:{content:JSON.stringify({text:'synthetic recovered'})}}]}},status:200,headers:{},config}
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
      else if (stdin.includes('/im/v1/messages/om_')) body = JSON.stringify({code:0,data:{items:[{msg_type:'text',body:{content:JSON.stringify({text:'synthetic recovered'})}}]}})
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
  await ctx.plugin((await imp('dsh-subprocess-local')).default)
  await ctx.plugin((await imp('dsh-bash-local')).default,{cwd:ws})
  // Only legacy messaging HTTP bridge is fake. bash.execute uses the real
  // LocalBashExecutor + LocalSubprocessRuntime below, never this network shim.
  ctx.shell.run=fakeShell.run

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
  await ctx.plugin((await imp('dsh-working-directory')).default,{defaultDirectory:ws})
  await ctx.plugin((await imp('dsh-shell-env')).ShellEnvRegistry,{dshHome:home})

  let toolsFiber=await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root: path.join(home, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const {Loader}=await imp('cordis-plugin-loader')
  const loader=new Loader(ctx,{baseUrl:pathToFileURL(path.join(HOSTX,'dsh','package.json')).href})
  const presetsModule=await imp('dsh-agent-preset-registry')
  let presetsFiber=await ctx.plugin(presetsModule.default,{default:'fixture'})
  const moduleUrl=n=>pathToFileURL(path.join(HOST_MODULES,n,'lib','index.js')).href
  const unregister=await ctx.agentPresets.register({id:'fixture',plugins:[
    {name:moduleUrl('dsh-tool-fs'),config:{readImage:false}},
    {name:moduleUrl('dsh-tool-bash'),config:{enableRunInBackground:false}},
  ]})
  const readOnly=await ctx.agentPresets.register({id:'readonly',plugins:[
    {name:moduleUrl('dsh-tool-fs'),config:{readImage:false,write:false,edit:false}},
  ]})
  assert.equal((await ctx.agentPresets.resolve()).id,'fixture')
  assert.equal((await ctx.agentPresets.resolve()).broken,undefined)
  const originalMount=ctx.agentPresets.mount
  let mounts=0,mountHook=null
  ctx.agentPresets.mount=async function(...args){mounts++;if(mountHook)await mountHook(...args);return Reflect.apply(originalMount,this,args)}
  const hostSetup=async(agentCtx)=>{await ctx.agentPresets.mount(agentCtx,(await ctx.agentPresets.resolve()).id)}
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
  config.adapters.onebot.enabled=false
  config.agent = Object.assign({}, config.agent, { provider: 'mock', model: 'm', cwd: ws })
  const handles=new WeakMap(),followupCounts=new Map(),instrumented=new WeakSet()
  let busyHits=0
  for(const method of ['create','resume']) {
    const original=AgentRegistry.prototype[method]
    ctx.agents[method]=async function(...args){try{const h=await Reflect.apply(original,this,args);handles.set(h.agent,h);if(!instrumented.has(h.agent)){instrumented.add(h.agent);const followup=h.agent.followup.bind(h.agent);h.agent.followup=(m)=>{followupCounts.set(m.id,(followupCounts.get(m.id)||0)+1);return followup(m)}}return h}catch(e){if(e.name==='SessionAlreadyOwnedError')busyHits++;throw e}}
  }
  let pluginFiber=await ctx.plugin(plugin, config) // production Cordis scope: exercises inject guards
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
    await routes.get('/messaging/lark/events')(req, res)
    await tick()
    await tick()
  }

  const toolsPkg=await imp('dsh-tools')
  const {sessionIdForKey}=await import('../lib/session-id-migration.js')
  const sid=sessionIdForKey('lark:oc_rt1')
  const ordinaryHandle=await ctx.agents.create({sessionId:'synthetic-ordinary',meta:{cwd:ws,agentPreset:'fixture'},agentOptions:{provider:'mock',model:'m'},setup:hostSetup})
  const ordinary=ordinaryHandle.agent
  const assemble=agent=>ctx.systemPrompt.assemble({scope:agent})
  const definition=agent=>ctx.tools.get('lark_send_image',agent)
  const view=async()=>{let s;await routes.get('/__dsh-messaging/status')({method:'GET',headers:{host:'127.0.0.1:1'}},{writeHead(){},end(v){s=JSON.parse(v)}});return s.channels.find(c=>c.key==='lark').diagnostics.images}
  assert.equal((await view()).available,true,'services ready even with zero bound agents')
  assert.equal(definition(ordinary),undefined)
  assert.equal(ctx.tools.get('lark_send_image'),undefined,'no context-global publication')
  await postInbound('om_bind_1','oc_rt1')
  let bound=ctx.agents.get(sid)
  assert.ok(bound)
  let def=definition(bound)
  assert.ok(def,'new bound agent has scoped tool')

  const names=async agent=>(await assemble(agent)).tools.map(t=>t.name).sort()
  for(const agent of [ordinary,bound]){
    for(const n of ['read','write','edit','bash'])assert.ok((await names(agent)).includes(n),n+' mounted from real preset')
    assert.equal(ctx.agentPresets.composedPreset(agent.ctx),'fixture')
    assert.equal(ctx.sessionProjections.stateOf(agent.session,'agentPreset'),'fixture')
    assert.equal(agent.session.header.cwd,ws)
  }
  assert.equal(definition(ordinary),undefined)
  assert.equal(definition(bound),def)
  assert.equal(ctx.tools.get('write'),undefined,'no global fs tool fallback')
  assert.equal(ctx.tools.get('bash'),undefined,'no global shell tool fallback')
  const call=(agent,name,args,id)=>ctx.tools.execute({callId:id,name,arguments:args,agent,signal:new AbortController().signal})
  // Write a generator through the real file tool, then run it through the real
  // bash tool/local executor/subprocess chain in the ordinary scoped preset.
  const program="require('node:fs').writeFileSync('generated.png',Buffer.from('"+PNG.toString('base64')+"','base64'))"
  const write=await call(ordinary,'write',{file_path:'generate.cjs',content:program},'write-generator')
  assert.equal(write.isError,false,JSON.stringify(write))
  const generated=await call(ordinary,'bash',{command:JSON.stringify(process.execPath)+' generate.cjs',description:'Generate one synthetic PNG',timeoutMs:10000},'generate-png')
  assert.equal(generated.isError,false,JSON.stringify(generated))
  assert.deepEqual(fs.readFileSync(path.join(ws,'generated.png')),PNG)
  const [sent,denied]=await Promise.all([
    call(bound,'lark_send_image',{file_path:'generated.png'},'bound-generated'),
    call(ordinary,'lark_send_image',{file_path:'generated.png'},'ordinary-forced'),
  ])
  assert.equal(sent.value?.ok,true);assert.equal(denied.isError,true)
  assert.equal(wire.uploads,1);assert.equal(wire.images,1);assert.equal(wire.sends,1)
  // Sibling/child inherits preset only when host explicitly composes it, never
  // the Lark destination capability.
  const {scopeOf}=await imp('dsh-scope')
  const childHandle=await bound.ctx.get('agents').create({sessionId:'preset-child',meta:{cwd:ws},agentOptions:{provider:'mock',model:'m'},parentAgent:bound,setup(agentCtx,agent){ctx.agentPresets.composeFrom(agentCtx,bound.ctx)}})
  const child=childHandle.agent
  assert.ok((await names(child)).includes('bash'));assert.equal(definition(child),undefined)
  const mountedBefore=mounts
  await postInbound('om_preset_cached','oc_rt1')
  assert.equal(ctx.agents.get(sid),bound);assert.equal(mounts,mountedBefore,'cached agent never double-mounted')
  await handles.get(bound).dispose();await tick()
  const shared=await ctx.agents.resume({resumeSessionId:sid,agentOptions:{provider:'mock',model:'m'},setup:hostSetup})
  const busyMounts=mounts,busyBefore=busyHits
  await postInbound('om_preset_busy','oc_rt1')
  assert.equal(ctx.agents.get(sid),shared.agent);assert.equal(mounts,busyMounts,'busy live agent keeps exact preset revision')
  assert.equal(busyHits,busyBefore+1)
  await shared.dispose();await tick()
  await postInbound('om_preset_resume','oc_rt1')
  bound=ctx.agents.get(sid)
  assert.ok((await names(bound)).includes('bash'))
  assert.equal(ctx.agentPresets.composedPreset(bound.ctx),'fixture')
  // A durable selection event overrides the frozen original header on resume.
  bound.session.append('agent-preset/selected',{agentPreset:'readonly'})
  assert.equal(await ctx.sessions.flush(bound.session),true)
  await handles.get(bound).dispose();await tick()
  await postInbound('om_preset_selected','oc_rt1')
  bound=ctx.agents.get(sid)
  assert.equal(ctx.agentPresets.composedPreset(bound.ctx),'readonly')
  assert.ok((await names(bound)).includes('read'));assert.ok(!(await names(bound)).includes('write'))
  assert.ok(!(await names(bound)).includes('bash'))
  assert.ok(definition(bound))
  // Invalid persisted selection: zero new admission, no fallback or live agent.
  bound.session.append('agent-preset/selected',{agentPreset:'missing-fixture'})
  assert.equal(await ctx.sessions.flush(bound.session),true)
  await handles.get(bound).dispose();await tick()
  await postInbound('om_preset_missing','oc_rt1')
  assert.equal(ctx.agents.get(sid),undefined)
  // Unknown live binding must not be patched after publication by the plugin.
  const repair=await ctx.agents.resume({resumeSessionId:sid,agentOptions:{provider:'mock',model:'m'}})
  repair.agent.session.append('agent-preset/selected',{agentPreset:'readonly'})
  assert.equal(await ctx.sessions.flush(repair.agent.session),true)
  await repair.dispose()
  const unmounted=await ctx.agents.resume({resumeSessionId:sid,agentOptions:{provider:'mock',model:'m'}})
  const badBusyMounts=mounts
  await postInbound('om_preset_busy_unmounted','oc_rt1')
  assert.equal(mounts,badBusyMounts);assert.equal(ctx.agentPresets.composedPreset(unmounted.agent.ctx),undefined)
  await unmounted.dispose()
  // Cold claimed row resumes from durable routing with no new user event.
  const {openLarkDedupStore,larkDedupKey}=await import('../lib/lark-dedup.js')
  const lease=await openLarkDedupStore(path.join(home,'lark-dedup'))
  const cold=await lease.claim({appId:'cli_realtool',messageId:'om_preset_cold',chatId:'oc_rt1',chatType:'p2p',sessionId:sid,sessionExisted:true})
  lease.release(cold.record.key)
  await pluginFiber.dispose();await tick()
  pluginFiber=await ctx.plugin(plugin,config)
  const until=async(label,predicate)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>=end){let status;await routes.get('/__dsh-messaging/status')({method:'GET',headers:{host:'127.0.0.1:1'}},{writeHead(){},end(v){status=JSON.parse(v)}});throw new Error(label+': '+JSON.stringify({rows:lease.recover().map(r=>({state:r.state,error:r.error,attempts:r.attempts,hasSid:Boolean(r.sessionId)})),channels:status.channels?.map(c=>({key:c.key,state:c.state,lastError:c.lastError})),errors:status.errors,recent:status.recent?.slice(-8)}))}await tick()}}
  await until('cold preset recovery',()=>lease.get(cold.record.key).state==='delivered')
  bound=ctx.agents.get(sid)
  assert.equal(ctx.agentPresets.composedPreset(bound.ctx),'readonly')
  assert.ok((await names(bound)).includes('read'));assert.ok(!(await names(bound)).includes('write'));assert.ok(definition(bound))
  const inbox=bound.inbox?.nextTurn||[]
  assert.ok(Array.isArray(inbox))
  assert.equal(followupCounts.get(cold.record.userMessageId),1)
  // Failed mount rolls back pre-publication, preserves claimed, and retries
  // exactly once after the service recovers; no raw diagnostic string escapes.
  let failedMount=false
  mountHook=async()=>{failedMount=true;throw new Error('RAW_PRESET_SECRET_MUST_NOT_ESCAPE')}
  await postInbound('om_preset_mount_failure','oc_mount_failure')
  assert.equal(failedMount,true)
  const failKey=larkDedupKey('cli_realtool','om_preset_mount_failure')
  const failedRow=lease.get(failKey)
  assert.equal(failedRow.state,'claimed')
  assert.equal(lease.isProcessing(failKey),false,'failed setup releases its processing owner')
  assert.equal(ctx.agents.get(sessionIdForKey('lark:oc_mount_failure')),undefined)
  let status
  await routes.get('/__dsh-messaging/status')({method:'GET',headers:{host:'127.0.0.1:1'}},{writeHead(){},end(v){status=JSON.parse(v)}})
  assert.ok(!JSON.stringify(status).includes('RAW_PRESET_SECRET_MUST_NOT_ESCAPE'))
  assert.ok(JSON.stringify(status).includes('agent preset unavailable'))
  mountHook=null
  await until('mount failure retry',()=>lease.get(failKey).state==='delivered')
  const recovered=ctx.agents.get(sessionIdForKey('lark:oc_mount_failure'))
  assert.equal(followupCounts.get(failedRow.userMessageId),1)
  // Hold setup across plugin disposal; old async setup must not publish or
  // enqueue after the new plugin instance starts.
  let enter,release
  const entered=new Promise(r=>{enter=r}),gate=new Promise(r=>{release=r})
  await handles.get(recovered).dispose();await tick()
  mountHook=async(agentCtx)=>{if(scopeOf(agentCtx)?.session.id===recovered.session.id){enter();await gate}}
  const pending=postInbound('om_preset_stale','oc_mount_failure')
  await entered
  mountHook=null
  await pluginFiber.dispose()
  release();await pending;await tick()
  assert.equal(ctx.agents.get(sessionIdForKey('lark:oc_mount_failure')),undefined)
  assert.equal(lease.get(larkDedupKey('cli_realtool','om_preset_stale')).state,'claimed')
  pluginFiber=await ctx.plugin(plugin,config)
  await until('new generation owns recovered setup',()=>lease.get(larkDedupKey('cli_realtool','om_preset_stale')).state==='delivered')
  const newAgent=ctx.agents.get(sessionIdForKey('lark:oc_mount_failure'))
  assert.equal(ctx.agentPresets.composedPreset(newAgent.ctx),'fixture')
  assert.equal(followupCounts.get(lease.get(larkDedupKey('cli_realtool','om_preset_stale')).userMessageId),1)
  assert.equal(wire.uploads,1);assert.equal(wire.images,1)
  // PTC is a separate presentation: validate real SDK capability projection,
  // without mistaking this fake runtime metadata for a PTC execution test.
  ctx.provide('ptcRuntime',{language:'typescript',programFormat:'function-body'})
  const ptcMode=path.join(home,'ptc-mode.mjs')
  fs.writeFileSync(ptcMode,"export const inject=['tools']; export function apply(ctx){ctx.tools.presentAs('ptc')}\n")
  await ctx.agentPresets.register({id:'ptc-fixture',plugins:[
    {name:moduleUrl('dsh-tool-fs'),config:{readImage:false}},
    {name:pathToFileURL(ptcMode).href},
  ]})
  const ptcHandle=await ctx.agents.create({sessionId:'preset-ptc',meta:{cwd:ws,agentPreset:'ptc-fixture'},agentOptions:{provider:'mock',model:'m'},async setup(agentCtx){await ctx.agentPresets.mount(agentCtx,'ptc-fixture')}})
  const ptcAssembly=await assemble(ptcHandle.agent)
  assert.deepEqual(ptcAssembly.tools.map(t=>t.name),['run_code'])
  const sdk=ptcAssembly.sections.find(s=>s.name==='tools:sdk').text
  assert.ok(sdk.includes('write'));assert.ok(!sdk.includes('lark_send_image'))
  assert.ok((await names(ordinary)).includes('bash'),'sibling native presentation unchanged')
  await ptcHandle.dispose()
  // Registry loss is not permission to run a new tool-free agent. It keeps
  // the message claimed, releases this processing owner and exposes a fixed error.
  await presetsFiber.dispose();await tick()
  await postInbound('om_preset_service_missing','oc_service_missing')
  const missingService=lease.get(larkDedupKey('cli_realtool','om_preset_service_missing'))
  assert.equal(missingService.state,'claimed');assert.equal(lease.isProcessing(missingService.key),false)
  assert.equal(ctx.agents.get(sessionIdForKey('lark:oc_service_missing')),undefined)
  assert.equal(followupCounts.get(missingService.userMessageId),undefined)
  // Replacement registry must own a new binding; retire the old live instance
  // through its exact handle, never hot-mount onto another surface's agent.
  presetsFiber=await ctx.plugin(presetsModule.default,{default:'fixture'})
  await ctx.agentPresets.register({id:'fixture',plugins:[{name:moduleUrl('dsh-tool-fs'),config:{readImage:false}}]})
  await until('replacement preset service',()=>lease.get(missingService.key).state==='delivered')
  assert.equal(followupCounts.get(missingService.userMessageId),1)
  assert.equal(ctx.agentPresets.composedPreset(ctx.agents.get(sessionIdForKey('lark:oc_service_missing')).ctx),'fixture')
  assert.equal(wire.uploads,1);assert.equal(wire.images,1)
  // Explicit plugin configuration must beat a different host default. This
  // is a fresh synthetic inbound through ctx.plugin, not agents.create(meta).
  // Keep every preceding default/readonly/recovery/busy/lifecycle assertion.
  await pluginFiber.dispose();await tick()
  await ctx.agentPresets.register({id:'standard',plugins:[
    {name:moduleUrl('dsh-tool-fs'),config:{readImage:false}},
    {name:moduleUrl('dsh-tool-bash'),config:{enableRunInBackground:false}},
  ]})
  assert.equal((await ctx.agentPresets.resolve()).id,'fixture','host default remains different')
  const ordinaryControl=await ctx.agents.create({sessionId:'explicit-standard-control',meta:{cwd:ws,agentPreset:'fixture'},agentOptions:{provider:'mock',model:'m'},setup:hostSetup})
  assert.ok(!(await names(ordinaryControl.agent)).includes('bash'),'default replacement preset has no bash')
  const standardConfig={...config,agent:{...config.agent,agentPreset:'standard'}}
  const standardSid=sessionIdForKey('lark:oc_explicit_standard')
  const resolveRequests=[]
  const explicitResolve=ctx.agentPresets.resolve,explicitMount=ctx.agentPresets.mount
  let standardMounts=0,enterStandard,releaseStandard
  const standardEntered=new Promise(r=>{enterStandard=r})
  const standardGate=new Promise(r=>{releaseStandard=r})
  ctx.agentPresets.resolve=async function(id){
    const result=await Reflect.apply(explicitResolve,this,[id])
    resolveRequests.push({requested:id,resolved:result.id})
    return result
  }
  ctx.agentPresets.mount=async function(agentCtx,id){
    if(scopeOf(agentCtx)?.session.id===standardSid){
      assert.equal(id,'standard','plugin resolved explicit standard before mount')
      assert.equal(ctx.agents.get(standardSid),undefined,'mount is pre-publication')
      standardMounts++
      enterStandard()
      await standardGate
    }
    return Reflect.apply(explicitMount,this,[agentCtx,id])
  }
  pluginFiber=await ctx.plugin(plugin,standardConfig)
  const standardPending=postInbound('om_explicit_standard','oc_explicit_standard')
  await standardEntered
  const standardKey=larkDedupKey('cli_realtool','om_explicit_standard')
  const standardRow=lease.get(standardKey)
  assert.equal(standardRow.state,'claimed','pending mount is not delivered')
  assert.equal(lease.isProcessing(standardKey),true,'pending mount keeps this processing owner')
  assert.equal(ctx.agents.get(standardSid),undefined,'await mount before agent publication')
  assert.equal(followupCounts.get(standardRow.userMessageId),undefined,'no followup before mounted')
  assert.equal(definition(ordinaryControl.agent),undefined,'ordinary remains unbound while mount waits')
  releaseStandard()
  await standardPending
  await until('explicit standard delivered',()=>lease.get(standardKey).state==='delivered')
  const standardAgent=ctx.agents.get(standardSid)
  assert.ok(standardAgent,'real plugin inbound created bound agent')
  assert.equal(standardAgent.session.header.agentPreset,'standard')
  assert.equal(ctx.sessionProjections.stateOf(standardAgent.session,'agentPreset'),'standard')
  assert.equal(ctx.agentPresets.composedPreset(standardAgent.ctx),'standard')
  assert.equal(standardMounts,1,'exactly one mount for explicit binding')
  assert.ok(resolveRequests.filter(r=>r.requested==='standard'&&r.resolved==='standard').length>=2,'fresh selection and setup resolve standard, not default')
  for(const tool of ['read','write','edit','bash'])assert.ok((await names(standardAgent)).includes(tool),'explicit standard allows '+tool)
  assert.ok(definition(standardAgent),'bound standard agent retains scoped image sender')
  assert.equal(definition(ordinaryControl.agent),undefined,'ordinary gets no Lark destination')
  assert.equal(definition(ordinary),undefined,'earlier ordinary still unbound')
  assert.equal(ctx.tools.get('lark_send_image'),undefined,'no global image publication')
  assert.equal(ctx.tools.get('write'),undefined,'no global file publication')
  assert.equal(ctx.tools.get('bash'),undefined,'no global shell publication')
  assert.equal(followupCounts.get(standardRow.userMessageId),1,'explicit binding admits once')
  assert.equal(wire.uploads,1);assert.equal(wire.images,1);assert.equal(wire.sends,1)
  ctx.agentPresets.resolve=explicitResolve
  ctx.agentPresets.mount=explicitMount
  await ordinaryControl.dispose()
  await lease.close()
  await childHandle.dispose()
  await ctx.fiber.dispose()
  await fsp.rm(home,{recursive:true,force:true});await fsp.rm(ws,{recursive:true,force:true})
  console.log('lark-preset-host ok | real Loader/PresetRegistry/Agent/Tools/FS/bash/subprocess | synthetic PNG generated + one fake send | fresh/cache/resume/cold/busy/projection/read-only/missing/mount-failure/stale-setup/service-loss+replacement/child isolation; PTC SDK only; explicit standard overrides default and awaits mount before admission | teardown complete')
}
main().catch(err=>{console.error(err);process.exit(1)})
