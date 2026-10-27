// Current-host regression for session-only Lark tool visibility and wire schemas.
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
      else if (stdin.includes('/im/v1/messages/om_cold_scope')) body = JSON.stringify({code:0,data:{items:[{msg_type:'text',body:{content:JSON.stringify({text:'synthetic recovered'})}}]}})
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
  let toolsFiber=await ctx.plugin(ToolRuntime)
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
  const handles=new WeakMap()
  let busyHits=0
  for(const method of ['create','resume']) {
    const original=AgentRegistry.prototype[method]
    ctx.agents[method]=async function(...args){try{const h=await Reflect.apply(original,this,args);handles.set(h.agent,h);return h}catch(e){if(e.name==='SessionAlreadyOwnedError')busyHits++;throw e}}
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
  const ordinaryHandle=await ctx.agents.create({sessionId:'synthetic-ordinary',meta:{cwd:ws},agentOptions:{provider:'mock',model:'m'}})
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
  assert.equal((await assemble(ordinary)).tools.length,0)
  toolsPkg.assertObjectJsonSchema(def.parameters)
  assert.equal(def.parameters.type,'object')
  assert.deepEqual(def.parameters.required,[],'source alternatives are checked by execute; neither individually required')
  assert.equal(def.parameters.additionalProperties,false)
  assert.deepEqual(Object.keys(def.parameters.properties),['attachment_id','file_path','caption'])
  const legacy={file_path:{type:'string',required:false}}
  assert.throws(()=>toolsPkg.assertObjectJsonSchema(legacy),e=>e.code==='UNSUPPORTED_SCHEMA','old raw shorthand is rejected')
  for(const args of [{file_path:'img.png'},{attachment_id:'synthetic'},{file_path:'img.png',caption:'synthetic'}])assert.deepEqual(toolsPkg.validateJsonSchemaValue(def.parameters,args),[])
  for(const args of [{file_path:1},{file_path:'img.png',url:'https://invalid.test'}])assert.ok(toolsPkg.validateJsonSchemaValue(def.parameters,args).length)
  const call=(agent,args,id)=>ctx.tools.execute({callId:id,name:'lark_send_image',arguments:args,agent,signal:new AbortController().signal})
  for(const [args,reason] of [[{},'no_image_source'],[{file_path:'',attachment_id:''},'no_image_source'],[{file_path:'img.png',attachment_id:'synthetic'},'single_source_required'],[{attachment_id:'synthetic'},'no_attachment_authz'],[{file_path:'img.png',extra:'hidden'},'forbidden_parameter']]) {
    const result=await call(bound,args,'source-'+reason)
    assert.equal(result.value?.reason,reason)
  }
  const direct=await def.execute({file_path:'img.png'},{agent:ordinary,callId:'forced-call'})
  assert.equal(direct.reason,'not_bound_to_lark','forcing captured scoped function still cannot use another agent')
  const hidden=await call(ordinary,{file_path:'img.png'},'not-visible')
  assert.equal(hidden.isError,true,'runtime rejects invisible name before body')
  assert.equal(counts.readBytes,0);assert.equal(wire.uploads+wire.sends,0)
  // Native and PTC are separate host contracts. In both presentations unrelated
  // and child scopes must not receive the Lark capability/schema/SDK declaration.
  const {bindScopeParent,scopeParentOf}=await imp('dsh-scope')
  const childHandle=await bound.ctx.get('agents').create({sessionId:'synthetic-child',meta:{cwd:ws},agentOptions:{provider:'mock',model:'m'},parentAgent:bound,setup(_ctx,agent){bindScopeParent(agent,bound)}})
  const child=childHandle.agent
  assert.equal(scopeParentOf(child),bound,'real public scope chain established before publication')
  assert.equal(definition(child),undefined,'unbound child cannot inherit Lark tool')
  ctx.provide('ptcRuntime',{language:'typescript',programFormat:'function-body'})
  const ptc=[]
  for(const agent of [ordinary,bound,child])ptc.push(agent.ctx.get('tools').presentAs('ptc'))
  for(const agent of [ordinary,bound,child]){
    const a=await assemble(agent)
    assert.deepEqual(a.tools.map(t=>t.name),['run_code'])
    const sdk=a.sections.find(s=>s.name==='tools:sdk').text
    assert.equal(sdk.includes('lark_send_image'),agent===bound,'PTC SDK visibility follows exact binding')
  }
  ptc.forEach(dispose=>dispose())

  const ds=await imp('dsh-llm-deepseek')
  const connection=ds.resolveAdapterOptions({baseURL:'http://synthetic.invalid/anthropic',models:[{id:'m',inputModalities:['text']}],thinking:'disabled'})
  const captures=[]
  globalThis.fetch=async(_url,opts)=>{
    const body=JSON.parse(opts.body);captures.push(body)
    for(const tool of body.tools||[])toolsPkg.assertObjectJsonSchema(tool.input_schema)
    const events=[['message_start',{type:'message_start',message:{id:'synthetic-response',type:'message',role:'assistant',model:'m',content:[],usage:{input_tokens:1,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic answer'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}}],['message_stop',{type:'message_stop'}]]
    return new Response(events.map(([k,v])=>'event: '+k+'\ndata: '+JSON.stringify(v)+'\n\n').join(''),{status:200,headers:{'content-type':'text/event-stream'}})
  }
  const adapter=new ds.DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveFiles:()=>({}),resolveUserId:()=> 'synthetic',prepareExtensions:async()=>({fields:{},accept:async()=>{}})})
  ctx.llm.registerAdapter(['isolated'],adapter)
  for(const agent of [ordinary,bound,child]){
    const assembly=await assemble(agent),chunks=[]
    const request={provider:'isolated',model:'m',messages:[llmPkg.createUserMessage({content:[{type:'text',text:'synthetic hello'}],source:{kind:'user'}})],tools:assembly.tools,signal:new AbortController().signal,reasoningEffort:'off'}
    for await(const c of ctx.llm.stream(request))chunks.push(c)
    assert.ok(chunks.some(c=>JSON.stringify(c).includes('synthetic answer')),'actual LLM+adapter request answers without tool calls')
    assert.equal(captures.at(-1).tools.some(t=>t.name==='lark_send_image'),agent===bound)
  }
  assert.deepEqual(captures[1].tools[0].input_schema,def.parameters,'actual Messages serializer uses full object schema')
  const refused=await call(bound,{},'refusal-next-request')
  const next={provider:'isolated',model:'m',tools:(await assemble(bound)).tools,reasoningEffort:'off',signal:new AbortController().signal,messages:[llmPkg.createUserMessage({content:[{type:'text',text:'synthetic'}],source:{kind:'user'}}),llmPkg.createAssistantMessage({source:{provider:'isolated',model:'m'},content:[{type:'tool-call',id:'refusal-next-request',name:'lark_send_image',arguments:'{}'}]}),llmPkg.createToolResultMessage({callId:'refusal-next-request',content:refused.content,isError:refused.isError})]}
  const chunks=[];for await(const c of ctx.llm.stream(next))chunks.push(c)
  assert.ok(chunks.some(c=>JSON.stringify(c).includes('synthetic answer')),'schema + renderer survive next real request')
  const [sent,denied]=await Promise.all([call(bound,{file_path:'img.png'},'bound-image'),call(ordinary,{file_path:'img.png'},'ordinary-image')])
  assert.equal(sent.value?.ok,true);assert.equal(denied.isError,true)
  assert.equal(wire.uploads,1);assert.equal(wire.images,1);assert.equal(wire.sends,1)
  // Reopen outside the plugin's ownership before inbound: ensureAgent must
  // really hit the host's SessionAlreadyOwnedError and reuse the foreground agent.
  await handles.get(bound).dispose();await tick()
  const shared=await ctx.agents.resume({resumeSessionId:sid,agentOptions:{provider:'mock',model:'m'}})
  bound=shared.agent;def=definition(bound)
  const beforeBusy=busyHits
  await postInbound('om_bind_2','oc_rt1')
  assert.equal(busyHits,beforeBusy+1,'actual host busy resume branch exercised')
  assert.equal(ctx.agents.get(sid),bound);assert.equal(definition(bound),def)
  const oldAgent=bound,oldDef=def
  // Reusing the real agent via registry resume first hits SessionAlreadyOwned.
  assert.equal(ctx.tools.schemas(bound).filter(t=>t.name==='lark_send_image').length,1)
  await handles.get(bound).dispose()
  await tick()
  assert.equal(definition(oldAgent),undefined)
  await postInbound('om_bind_3','oc_rt1')
  bound=ctx.agents.get(sid);def=definition(bound)
  assert.ok(bound && bound!==oldAgent && def)
  assert.equal((await oldDef.execute({file_path:'img.png'},{agent:bound,callId:'old-def'})).reason,'not_bound_to_lark')
  // A delayed old dispose event must not remove the new instance registration.
  await ctx.parallel('agent/disposed',{agent:oldAgent})
  assert.equal(definition(bound),def)
  const stale=def
  await pluginFiber.dispose();await tick()
  assert.equal(definition(bound),undefined);assert.equal(definition(ordinary),undefined)
  pluginFiber=await ctx.plugin(plugin,config);await tick()
  assert.equal(ctx.tools.get('lark_send_image'),undefined)
  await postInbound('om_bind_4','oc_rt1')
  bound=ctx.agents.get(sid);assert.ok(definition(bound))
  assert.equal((await stale.execute({file_path:'img.png'},{agent:bound,callId:'old-plugin'})).reason,'not_bound_to_lark')
  await toolsFiber.dispose();await tick()
  toolsFiber=await ctx.plugin(ToolRuntime);await tick()
  await postInbound('om_bind_5','oc_rt1')
  bound=ctx.agents.get(sid)
  assert.equal(ctx.tools.schemas(bound).filter(t=>t.name==='lark_send_image').length,1)
  assert.equal(definition(ordinary),undefined)
  assert.equal(wire.uploads,1);assert.equal(wire.images,1)
  // Cold ledger recovery, without a new inbound event, must publish in the
  // actual resumed scope; a subsequent foreground resume keeps that binding.
  const {openLarkDedupStore,larkDedupKey}=await import('../lib/lark-dedup.js')
  const lease=await openLarkDedupStore(path.join(home,'lark-dedup'))
  const claimed=await lease.claim({appId:'cli_realtool',messageId:'om_cold_scope',chatId:'oc_rt1',chatType:'p2p',sessionId:sid,sessionExisted:true})
  assert.equal(claimed.record.state,'claimed')
  lease.release(claimed.record.key) // yield the fixture owner before recovery takes responsibility
  await pluginFiber.dispose();await tick()
  pluginFiber=await ctx.plugin(plugin,config)
  const until=Date.now()+10000
  while(!ctx.agents.get(sid)||!definition(ctx.agents.get(sid))||lease.get(larkDedupKey('cli_realtool','om_cold_scope')).state!=='delivered'){
    assert.ok(Date.now()<until,'cold recovery: '+JSON.stringify({agent:!!ctx.agents.get(sid),tool:!!(ctx.agents.get(sid)&&definition(ctx.agents.get(sid))),state:lease.get(larkDedupKey('cli_realtool','om_cold_scope'))?.state}));await tick()
  }
  const cold=ctx.agents.get(sid),coldDef=definition(cold)
  assert.ok(coldDef)
  await handles.get(cold).dispose();await tick()
  const foreground=await ctx.agents.resume({resumeSessionId:sid,agentOptions:{provider:'mock',model:'m'}})
  assert.ok(definition(foreground.agent),'known cold route also binds foreground resume at agent/created')
  assert.equal((await coldDef.execute({file_path:'img.png'},{agent:foreground.agent,callId:'cold-old'})).reason,'not_bound_to_lark')
  assert.equal(definition(ordinary),undefined)
  assert.equal(wire.uploads,1);assert.equal(wire.images,1)
  await lease.close()
  await ctx.fiber.dispose()
  await fsp.rm(home,{recursive:true,force:true});await fsp.rm(ws,{recursive:true,force:true})
  console.log('lark-image-scope-host ok | real current host plugin/Tools/SystemPrompt/LLM/DeepSeek serializer | native/PTC sibling+child isolation, schema/source branches, busy/resume/dispose/service replacement | synthetic image+fake network/model only')
}
main().catch(err=>{console.error(err);process.exit(1)})
