// Independent D: fake provider/network; real Cordis, Agent loop, Tools, ApprovalService.
import { spawnSync } from 'node:child_process'
import { createHash, createCipheriv, randomBytes } from 'node:crypto'
// Scoped tool bodies are reached only through the real loop scheduler.
// The native approval answerer is synthetic; it is never a Feishu identity mapping.
import './_guard.cjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
const root = path.resolve(process.env.DSH_HOSTX_ROOT || '/tmp/dsh-hostx', 'dsh/node_modules/@deepseek-ai')
const imp = name => import(pathToFileURL(path.join(root, name, 'lib/index.js')))
await fs.access(path.join(root, 'dsh-tools/lib/index.js')) // missing real host is a failure
const { Context } = await imp('cordis')
const llm = await imp('dsh-llm'), Tools = await imp('dsh-tools'), Agent = await imp('dsh-agent')
const plugin = await import('../lib/index.js')
const { sessionIdForKey } = await import('../lib/session-id-migration.js')
const { openLarkDedupStore, larkDedupKey } = await import('../lib/lark-dedup.js')
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'messaging-interactions-host-'))
const routes = new Map(), replies = [], messages = new Map(), refs = new Map(), drains = []
const tick = () => new Promise(r => setTimeout(r, 25))
let ledger
const ctx = new Context(), restoreFetch = globalThis.fetch
const axios = (await import('axios')).default, oldAxiosAdapter = axios.defaults.adapter
let pendingTool; const modelRequests = [], executions = [], results = [], approvals = []
const names = ['messaging_context', 'messaging_reply', 'messaging_capabilities', 'messaging_edit', 'messaging_recall', 'messaging_reaction_add', 'messaging_reaction_remove', 'messaging_reactions', 'messaging_read', 'messaging_read_events', 'messaging_card_publish', 'messaging_card_update', 'messaging_card_status']
try {
  axios.defaults.adapter = async config => {
    const url = String(config.url || '')
    if (url.includes('/auth/v3/')) return { data: { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }, status: 200, headers: {}, config }
    assert.fail('unexpected synthetic SDK wire')
  }
  await ctx.plugin((await imp('cordis-plugin-timer')).default)
  ctx.provide('dsh.home', home); ctx.provide('dshMessaging.root', home)
  ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'm' }) })
  ctx.provide('shell', { resolve: x => x, async run(req) {
    const stdin = String(req.stdin || '')
    if(String(req.command||'').includes('crypto-helper.cjs')) {
      const op=String(req.command).includes("'decrypt'")?'decrypt':'verify'
      const child=spawnSync(process.execPath,[path.resolve('companion/crypto-helper.cjs'),'lark',op],{input:stdin,encoding:'utf8'})
      return {exitCode:child.status,timedOut:false,aborted:false,stdout:{text:child.stdout},stderr:{text:child.stderr}}
    }
    let data = { code: 0 }, code = 200
    if (stdin.includes('/auth/v3/')) data = { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
    else if (stdin.includes('/application/v6/scopes')) data = { code: 0, data: { scopes: [{ scope_name: 'im:resource' }, { scope_name: 'im:message:readonly' }, { scope_name: 'im:message.group_msg' }] } }
    else if (stdin.includes('/reply')) {
      const url = stdin.split('\n').find(x => x.startsWith('url = ')); const body = stdin.split('\n').find(x => x.startsWith('data-binary = '))
      const payload = JSON.parse(body.slice('data-binary = '.length).slice(1, -1).replace(/\\(["\\])/g, '$1'))
      replies.push({ url, payload }); data = { code: 0, data: { message_id: 'synthetic-sent-' + replies.length, create_time: String(Date.now()) } }
    } else if (stdin.includes('/im/v1/messages/')) {
      const id = [...messages.keys()].find(k => stdin.includes('/messages/' + k + '"'))
      data = { code: 0, data: { items: id ? [messages.get(id)] : [] } }
    } else assert.fail('unexpected synthetic curl endpoint')
    return { exitCode: 0, timedOut: false, aborted: false, stdout: { text: JSON.stringify(data) + '\n__DSH_STATUS__:' + code }, stderr: { text: '' } }
  } })
  await ctx.plugin(llm.default)
  await ctx.plugin((await imp('dsh-session')).default)
  await ctx.plugin((await imp('dsh-fs-local')).default)
  await ctx.plugin((await imp('dsh-session-projection')).default)
  await ctx.plugin((await imp('dsh-sandbox-policy')).default, { workspaceRoot: home })
  await ctx.plugin((await imp('dsh-attachment-local')).default, { dshHome: home })
  await ctx.plugin((await imp('dsh-system-prompt')).default)
  class Mock extends llm.LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] } }
    async *stream(request) {
      if (pendingTool && JSON.stringify(request.messages).includes(pendingTool.marker)) {
        assert.ok(JSON.stringify(request.messages).includes('Messaging card input'))
        assert.ok(request.tools.some(t=>t.name==='synthetic_guarded'),'real prompt exposes scoped synthetic tool')
        const job=pendingTool; pendingTool=null; modelRequests.push(job.label)
        const block={type:'tool-call',id:'call-'+job.label,name:'synthetic_guarded',arguments:'{}'}
        yield {type:'block-start',index:0,blockType:'tool-call'}
        yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:'{}'}
        yield {type:'block-end',index:0,block}
        yield {type:'finish',reason:{kind:'tool-calls'}}
        return
      }
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['mock'], new Mock())
  await ctx.plugin(Tools.default)
  await ctx.plugin(Agent.default)
  await ctx.plugin((await imp('dsh-session-persistence-jsonl')), { root: path.join(home, 'sessions') })
  await ctx.plugin((await imp('dsh-agent-loop')).default, { agents: [] })
  let approvalFiber = await ctx.plugin((await imp('dsh-user-approval')).default, {policy:'ask'})
  const config = plugin.defaultConfig(home)
  Object.assign(config.adapters.lark, { enabled: true, mode: 'webhook', appId: 'synthetic-app', appSecret: 'synthetic-secret', verificationToken: 'synthetic-verification', encryptKey:'synthetic-encryption-key' })
  Object.assign(config.agent, { provider: 'mock', model: 'm', cwd: home })
  let fiber = await ctx.plugin(plugin, config)
  ledger = await openLarkDedupStore(path.join(home, 'lark-dedup'))
  const http = async (body, badSignature=false) => {
    const key=createHash('sha256').update(config.adapters.lark.encryptKey).digest(),iv=randomBytes(16)
    const cipher=createCipheriv('aes-256-cbc',key,iv)
    const raw=JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(JSON.stringify(body)),cipher.final()]).toString('base64')})
    const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomBytes(8).toString('hex')
    const signature=createHash('sha256').update(timestamp+nonce+config.adapters.lark.encryptKey+raw).digest('hex')
    const req=Readable.from([Buffer.from(raw)]);req.method='POST';req.headers={'content-type':'application/json','x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,'x-lark-signature':badSignature?'0'.repeat(64):signature}
    let code,result; const start=performance.now()
    await routes.get('/messaging/lark/events')(req,{writeHead(n){code=n},end(v){result=JSON.parse(String(v||'{}'))}})
    return {code,result,elapsed:performance.now()-start}
  }
  const post = async (id, chat = 'synthetic-chat', parent, typed = false, alreadyAdmitted = false) => {
    messages.set(id, { message_id: id, chat_id: chat, create_time: String(Date.now()), msg_type: 'text', body: { content: JSON.stringify({ text: 'synthetic ' + id }) } })
    const body = { schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'event-' + id, app_id:'synthetic-app', tenant_key:'synthetic-app-tenant', token: 'synthetic-verification' }, event: { message: { message_id: id, chat_id: chat, create_time: messages.get(id).create_time, chat_type: 'p2p', message_type: typed ? 'image' : 'text', content: JSON.stringify(typed ? { image_key: 'img_v3_synthetic' } : { text: 'synthetic ' + id }), ...(parent ? { parent_id: parent } : {}) }, sender: { sender_type: 'user', tenant_key:'synthetic-user-tenant', sender_id: { open_id: 'synthetic-user' } } } }
    const {code}=await http(body)
    assert.equal(code, 200)
    for (let i = 0; i < 80; i++) {
      const a = ctx.agents.get(sessionIdForKey('lark:' + chat))
      if (a && ctx.tools.get('messaging_context', a) && ledger.get(larkDedupKey('synthetic-app', id))?.state === 'delivered') {
        const row = ledger.get(larkDedupKey('synthetic-app', id))
        const admitted = Array.from({ length: a.session.seq }, (_, n) => a.session.eventAt(n))
          .filter(e => e?.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted || []).find(m => m.id === row.userMessageId)
        const ref = JSON.stringify(admitted || '').match(/\[message ref: (msgref_[a-f0-9]+)\]/)?.[1]
        if (ref) refs.set(id, ref)
        const result = (ref || alreadyAdmitted) && await ctx.tools.execute({ agent: a, callId: 'wait-' + id, name: 'messaging_context', arguments: ref ? { target: ref } : {}, signal: new AbortController().signal })
        if (result?.value?.ok) return a
      }
      await tick()
    }
    assert.fail('normal plugin ingress did not expose usable current message reference')
  }
  const wait = async (fn, label) => {const deadline=Date.now()+8000;while(!fn()){assert.ok(Date.now()<deadline,label);await tick()}}
  const events=a=>Array.from({length:a.session.seq},(_,i)=>a.session.eventAt(i))
  const inputs=a=>events(a).filter(e=>e?.type==='agent/inbox/spliced').flatMap(e=>e.data.inserted||[]).filter(m=>JSON.stringify(m).includes('Messaging card input'))
  const call=(a,name,args={})=>ctx.tools.execute({agent:a,callId:'setup-'+name, name,arguments:args,signal:new AbortController().signal})
  const bound=await post('D-incoming','D-chat')
  await wait(()=>bound.status==='idle','initial turn completes')
  const probeName='synthetic_guarded'
  bound.ctx.get('tools').register({name:probeName,description:'Synthetic no-effect counter requiring normal host approval',parameters:{type:'object',properties:{},required:[],additionalProperties:false},
    output:{schema:{type:'object',properties:{count:{type:'number'}},required:['count'],additionalProperties:false},render:v=>[{type:'text',text:JSON.stringify(v)}]},
    execute(_args,exec){assert.equal(exec.agent,bound);executions.push(exec.callId);return {count:executions.length}}})
  ctx.on('tools/pre-execute',(exec,next)=>exec.name===probeName?Promise.resolve({kind:'ask',reason:'synthetic approval required'}):next())
  ctx.on('tools/result',(exec,result)=>{if(exec.name===probeName)results.push({callId:exec.callId,isError:result.isError===true})},{global:true})
  let answer='allowed-once',holdAnswer,releaseAnswer
  bound.ctx.on('approval/request',async req=>{
    assert.equal(req.agent,bound);assert.equal(req.toolName,probeName)
    assert.ok(events(bound).some(e=>e.type==='approval/asked'&&e.data.callId===req.callId),'real audit asked before answer')
    approvals.push(req.callId)
    if(holdAnswer)await new Promise(r=>{releaseAnswer=r;drains.push(r)})
    return answer
  })
  const cardDto={title:'D synthetic workflow',text:'Only synthetic input',fields:[{id:'answer',label:'Answer',type:'text',required:true,max_length:20,enum:['one','two']}],choices:[{id:'choose',label:'Choose'}]}
  const publish=async label=>{
    const p=(await call(bound,'messaging_card_publish',{operation_id:'D-'+label,target:refs.get('D-incoming'),card:cardDto})).value
    assert.equal(p.ok,true)
    assert.equal((await call(bound,'messaging_card_status',{workflow:p.workflowRef})).value.remoteApproval,'host_principal_mapping_unverified')
    return {...p,card:JSON.parse(replies.at(-1).payload.content),message:'synthetic-sent-'+replies.length}
  }
  const callback=(p,label,buttonName='submit')=>{
    const button=buttonName==='cancel'?p.card.body.elements.find(e=>e.tag==='button'):p.card.body.elements.find(e=>e.tag==='form').elements.find(e=>e.name===buttonName)
    return {schema:'2.0',header:{event_type:'card.action.trigger',event_id:'D-event-'+label,app_id:'synthetic-app',tenant_key:'synthetic-app-tenant',token:'synthetic-verification'},event:{token:'PRIVATE-D-CALLBACK-TOKEN',operator:{open_id:'synthetic-user',tenant_key:'synthetic-user-tenant'},context:{open_message_id:p.message,open_chat_id:'D-chat'},action:{tag:'button',name:button.name,value:button.behaviors[0].value,form_value:buttonName==='cancel'?{}:{answer:'one'}}}}
  }
  const arm=(p,label)=>{pendingTool={marker:p.workflowRef,label}}
  // A new, active encrypted form; signature/decrypt are the actual companion,
  // not a test replacement. ACK is measured while the host approver is pending.
  const allowed=await publish('allowed-form'),allowedBody=callback(allowed,'allowed-form')
  const before=inputs(bound).length
  arm(allowed,'allowed-form');holdAnswer=true
  const bad=await http(allowedBody,true)
  assert.equal(bad.code,401);assert.equal(inputs(bound).length,before);assert.equal(executions.length,0)
  const ack=await http(allowedBody)
  assert.equal(ack.code,200);assert.equal(ack.result.toast.type,'info');assert.ok(ack.elapsed<3000)
  await wait(()=>releaseAnswer,'real open-turn approval pending')
  assert.equal(executions.length,0,'callback receipt is not tool approval')
  assert.equal(inputs(bound).length,before+1)
  const stableUmid=inputs(bound).at(-1).id
  await http(allowedBody);await http({...allowedBody,header:{...allowedBody.header,event_id:'D-double-click'}})
  assert.equal(inputs(bound).length,before+1);assert.equal(inputs(bound).at(-1).id,stableUmid)
  releaseAnswer();holdAnswer=false
  await wait(()=>results.some(r=>r.callId==='call-allowed-form'),'normal tool result observed')
  await wait(()=>bound.status==='idle','allowed turn completes')
  assert.deepEqual(executions,['call-allowed-form'])
  assert.equal(results.find(r=>r.callId==='call-allowed-form').isError,false)
  const asked=events(bound).find(e=>e.type==='approval/asked'&&e.data.callId==='call-allowed-form')
  assert.ok(asked)
  const allowedDecision=events(bound).find(e=>e.type==='approval/decided'&&e.data.id===asked.data.id)
  assert.equal(allowedDecision.data.outcome,'allowed-once')
  const enclosingStart=events(bound).filter(e=>e.type==='turn/start'&&e.seq<asked.seq).at(-1)
  const enclosingEnd=events(bound).find(e=>e.type==='turn/end'&&e.seq>asked.seq)
  assert.ok(enclosingStart&&enclosingEnd&&allowedDecision.seq<enclosingEnd.seq,'actual approval audit pair is turn-enclosed')
  assert.ok(events(bound).some(e=>e.type==='tool/call'&&JSON.stringify(e.data).includes('call-allowed-form')))
  assert.ok(events(bound).some(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('call-allowed-form')))
  await http(allowedBody);await tick();assert.equal(executions.length,1,'completed encrypted form replay does not execute again')
  const cases=[]
  for(const [label,outcome,policy,button] of [['rejected','rejected','ask','c_choose'],['never','allowed-once','never','submit'],['cancelled','cancelled','ask','submit']]){
    ctx.approval.setPolicy(bound,policy);await wait(()=>bound.status==='idle','policy turn completes')
    answer=outcome
    const p=await publish(label),n=executions.length;arm(p,label)
    const response=await http(callback(p,label,button));assert.equal(response.code,200);assert.equal(response.result.toast.type,'info');assert.ok(response.elapsed<3000)
    await wait(()=>results.some(r=>r.callId==='call-'+label),label+' reaches real Tools result')
    await wait(()=>bound.status==='idle',label+' turn completes');assert.equal(executions.length,n)
    const a=events(bound).find(e=>e.type==='approval/asked'&&e.data.callId==='call-'+label)
    assert.ok(a);const decision=events(bound).find(e=>e.type==='approval/decided'&&e.data.id===a.data.id).data.outcome
    assert.equal(decision,policy==='never'?'rejected':outcome);assert.equal(results.find(r=>r.callId==='call-'+label).isError,true)
    cases.push({label,decision,executions:0,elapsedMs:response.elapsed})
  }
  // Cancellation of the live execution signal is separate from an answerer
  // returning cancelled. A late allowed answer must not revive the call.
  ctx.approval.setPolicy(bound,'ask');await wait(()=>bound.status==='idle','ask policy ready')
  answer='allowed-once';holdAnswer=true;releaseAnswer=null
  const aborted=await publish('aborted');arm(aborted,'aborted')
  const abortAck=await http(callback(aborted,'aborted'));assert.ok(abortAck.elapsed<3000)
  await wait(()=>releaseAnswer,'cancellable approval pending')
  bound.cancel({kind:'user'});releaseAnswer();holdAnswer=false
  await wait(()=>bound.status==='idle','cancelled turn completes');assert.equal(executions.length,1)
  const abortAsked=events(bound).find(e=>e.type==='approval/asked'&&e.data.callId==='call-aborted')
  assert.equal(events(bound).find(e=>e.type==='approval/decided'&&e.data.id===abortAsked.data.id).data.outcome,'cancelled')
  await approvalFiber.dispose()
  const missing=await publish('missing-service');arm(missing,'missing-service')
  await http(callback(missing,'missing-service'))
  await wait(()=>results.some(r=>r.callId==='call-missing-service'),'missing approval fails closed')
  await wait(()=>bound.status==='idle','missing-service turn completes');assert.equal(executions.length,1)
  assert.equal(events(bound).some(e=>e.type==='approval/asked'&&e.data.callId==='call-missing-service'),false)
  assert.equal(results.find(r=>r.callId==='call-missing-service').isError,true)
  // The cancel button is outside the form: its real callback may omit name
  // and form_value even while required fields are empty or contain local text.
  for(const localState of ['untouched-required','filled-required','empty-required']){
    const cancelled=await publish('workflow-cancel-'+localState),cancelBefore=inputs(bound).length,modelBefore=modelRequests.length,wireBefore=replies.length,approvalBefore=approvals.length
    const cancel=callback(cancelled,'workflow-cancel-'+localState,'cancel');delete cancel.event.action.name;delete cancel.event.action.form_value
    const foreign=structuredClone(cancel);foreign.header.event_id+='-foreign';foreign.event.operator.open_id='foreign'
    assert.equal((await http(foreign)).result.toast.type,'error')
    for(const form of [null,[],{answer:'CANCEL_PRIVATE_SENTINEL'}]){
      const malformed=structuredClone(cancel);malformed.header.event_id+='-bad-'+JSON.stringify(form);malformed.event.action.form_value=form
      assert.match((await http(malformed)).result.toast.content,/invalid_input/)
    }
    assert.match((await http(cancel)).result.toast.content,/已取消/)
    assert.match((await http(cancel)).result.toast.content,/已取消/)
    const duplicate=structuredClone(cancel);duplicate.header.event_id+='-duplicate';duplicate.event.action.form_value={}
    assert.match((await http(duplicate)).result.toast.content,/已取消/)
    assert.equal((await call(bound,'messaging_card_status',{workflow:cancelled.workflowRef})).value.phase,'cancelled')
    assert.equal((await http(callback(cancelled,'after-cancel-'+localState))).result.toast.type,'error')
    await tick();assert.equal(inputs(bound).length,cancelBefore);assert.equal(executions.length,1);assert.equal(modelRequests.length,modelBefore);assert.equal(replies.length,wireBefore);assert.equal(approvals.length,approvalBefore);assert.ok(!JSON.stringify(events(bound)).includes('CANCEL_PRIVATE_SENTINEL'))
  }
  // Runtime package exists, but this fixture deliberately has neither subprocess
  // nor sandbox service; do not replace confinement with unrestricted execution.
  const ptcNode=await imp('dsh-ptc-runtime-node')
  assert.ok(ptcNode.default.inject.includes('sandbox')&&ptcNode.default.inject.includes('subprocess'))
  assert.equal(ctx.get('sandbox'),undefined);assert.equal(ctx.get('subprocess'),undefined)
  // Native and PTC presentation/execution guard, no language container claimed.
  const ordinary=(await ctx.agents.create({sessionId:'D-ordinary',meta:{cwd:home},agentOptions:{provider:'mock',model:'m'}})).agent
  const {bindScopeParent}=await imp('dsh-scope')
  const child=(await bound.ctx.get('agents').create({sessionId:'D-child',meta:{cwd:home},agentOptions:{provider:'mock',model:'m'},parentAgent:bound,setup(_ctx,a){bindScopeParent(a,bound)}})).agent
  const isolatedWire=replies.length
  for(const a of [ordinary,child]){
    for(const name of names)assert.equal(ctx.tools.get(name,a),undefined)
    const forced=await call(a,'messaging_card_publish',{operation_id:'no',card:cardDto});assert.equal(forced.isError,true)
  }
  ctx.provide('ptcRuntime',{language:'typescript',programFormat:'function-body'})
  for(const a of [ordinary,child]){
    const off=a.ctx.get('tools').presentAs('ptc')
    const assembled=await ctx.systemPrompt.assemble({scope:a})
    assert.deepEqual(assembled.tools.map(t=>t.name),['run_code'])
    for(const name of names)assert.equal(JSON.stringify(assembled).includes(name),false)
    const forced=await call(a,'messaging_card_publish',{operation_id:'ptc-no',card:cardDto});assert.equal(forced.isError,true)
    off()
  }
  assert.equal(executions.length,1);assert.equal(replies.length,isolatedWire,'ordinary/child/native/PTC forced calls dispatch zero wire')
  const late=await publish('late'),lateBody=callback(late,'late'),lateInputs=inputs(bound).length
  await fiber.dispose();fiber=await ctx.plugin(plugin,config)
  const lateResponse=await http(lateBody);assert.equal(lateResponse.result.toast.type,'error')
  await tick();assert.equal(inputs(bound).length,lateInputs);assert.equal(executions.length,1)
  const approvalEvents=events(bound).filter(e=>['approval/asked','approval/decided'].includes(e.type))
  for(const event of approvalEvents.filter(e=>e.type==='approval/asked'))assert.equal(approvalEvents.filter(e=>e.type==='approval/decided'&&e.data.id===event.data.id).length,1,'no orphan or duplicated approval decision')
  assert.equal(modelRequests.length,6)
  const summary={host:'0.2.1-rc.3',real:['Cordis plugin','encrypted HTTP signature/decrypt','Agent open turn','model tool-call scheduling','ToolsRuntime','ApprovalService','session approval audit'],fake:['model provider','Feishu curl','native approval answerer'],allowedExecutions:executions.length,stableUmidDuplicate:true,encryptedBadSignature:bad.code,encryptedAckMs:ack.elapsed,cases,toolResults:results,approvalAsked:events(bound).filter(e=>e.type==='approval/asked').length,approvalDecisions:events(bound).filter(e=>e.type==='approval/decided').map(e=>e.data.outcome),remoteApproval:'host_principal_mapping_unverified',ptc:'presentation and direct-call guard only; no language container execution',lateCallback:'rejected'}
  if(process.env.DSH_D_EVIDENCE)await fs.writeFile(process.env.DSH_D_EVIDENCE,JSON.stringify(summary,null,2)+'\n')
  console.log('messaging-interactions-tools-host: ok | real encrypted form/button -> stable umid -> normal model turn -> Tools/Approval/audit; one allowed, rejection/never/cancel/missing/late zero; native/PTC child isolation; fake model/network/approver')
} finally {
  globalThis.fetch = restoreFetch
  axios.defaults.adapter = oldAxiosAdapter
  for(const release of drains)release()
  await ctx.fiber.dispose()
  if (ledger) await ledger.close()
  await fs.rm(home, { recursive: true, force: true })
}
