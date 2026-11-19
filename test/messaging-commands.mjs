import './_guard.cjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMessagingCommand as parse, executeSessionCommand as execute, commandAllowed, commandExpired, commandModels, resolveCommandModel, COMMAND_TEXT } from '../lib/messaging-commands.js'
import { createLarkSessionGenerations } from '../lib/lark-session-generation.js'
import { createTemporaryModels } from '../lib/lark-temporary-model.js'
import { sessionIdForKey } from '../lib/session-id-migration.js'
import { openLarkDedupStore } from '../lib/lark-dedup.js'
import { sendLarkNotice } from '../lib/lark-notice.js'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-'))
const dm = text => parse({text, messageType:'text', chatType:'p2p'})
try {
  for (const text of ['/help',' /HELP\n','／help']) assert.deepEqual(dm(text),{name:'help',argument:null})
  for (const text of ['/stop 一下','/status extra','/new x','/help x','/path/to/file','see /stop','/compact']) assert.equal(dm(text),null,text)
  assert.deepEqual(dm('/MODEL switch 2'),{name:'model',argument:'switch 2',action:'switch',mode:'p',target:'2'})
  for (const type of ['post','image','interactive','']) assert.equal(parse({text:'/stop',messageType:type,chatType:'p2p'}),null)
  assert.equal(parse({text:'/stop',messageType:'text',chatType:'p2p',enabled:false}),null)
  const group={messageType:'text',chatType:'group',botOpenId:'ou_bot',mentions:[{key:'@_user_1',id:{open_id:'ou_bot'}}]}
  assert.equal(parse({...group,text:'/stop'}),null)
  assert.equal(parse({...group,text:'@_user_1 /stop'}).name,'stop')
  assert.equal(parse({...group,text:'@_user_1 /stop',botOpenId:'ou_other'}),null)
  assert.equal(parse({...group,text:'@_user_1 /stop',botOpenId:undefined}),null)
  for (const c of [dm('/new'),dm('/stop'),dm('/model switch 2')]) {
    assert.equal(commandAllowed(c,'group','ou_user',[]),false)
    assert.equal(commandAllowed(c,'group','ou_user',['ou_other']),false)
    assert.equal(commandAllowed(c,'group','ou_user',['ou_user']),true)
    assert.equal(commandAllowed(c,'p2p','ou_user',[]),true)
    assert.equal(commandExpired(c,1,61002),c.name!=='new')
  }
  for(const text of ['/help','/status','/model'])assert.equal(commandAllowed(dm(text),'group','ou_any',[]),true)
  const journal = createLarkSessionGenerations(path.join(root,'gen')), key='app|lark:chat'
  assert.equal(journal.current(key,'lark:chat').sessionId,sessionIdForKey('lark:chat'))
  journal.advance(key,'message-1',1000);const first=journal.current(key,'lark:chat').sessionId
  assert.notEqual(first,sessionIdForKey('lark:chat'))
  journal.advance(key,'message-1',2000);assert.equal(journal.current(key,'lark:chat').sessionId,first)
  assert.equal(createLarkSessionGenerations(path.join(root,'gen')).current(key,'lark:chat').sessionId,first)
  journal.advance(key,'message-2',3000);assert.equal(journal.current(key,'lark:chat').generation,2)
  const genfile=path.join(root,'gen',fs.readdirSync(path.join(root,'gen'))[0]),bytes=fs.readFileSync(genfile,'utf8')
  assert.ok(!bytes.includes('lark:chat')&&!bytes.includes('message-'))
  assert.equal(fs.readdirSync(path.join(root,'gen')).some(s=>s.includes('.tmp-')),false)
  fs.writeFileSync(genfile,'{"version":1,"generation":-1}')
  assert.throws(()=>journal.current(key,'lark:chat'),/generation_store_invalid/)
  for (const invalid of ['null','[]','true','0']) {
    fs.writeFileSync(genfile,invalid)
    assert.throws(()=>journal.current(key,'lark:chat'),error=>error.message==='generation_store_invalid')
  }
  fs.writeFileSync(genfile,'RAW_PRIVATE_SENTINEL')
  assert.throws(()=>journal.current(key,'lark:chat'),error=>error.message==='generation_store_invalid')
  fs.unlinkSync(genfile);fs.symlinkSync(path.join(root,'outside'),genfile)
  assert.throws(()=>journal.current(key,'lark:chat'),/generation_store_invalid/)
  let active=null,cancel=0,resumes=0,switched=0,fresh=0,selection={provider:'mock',model:'a'},globalWrites=0
  const llm={listProviders:()=>[{id:'mock'}],listModels:async()=>[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}],resolveCallConfig:async x=>x}
  const agent={status:'idle',model:{current:()=>selection,select:x=>{selection=x;switched++}},cancel(cause,opts){assert.deepEqual(cause,{kind:'user'});assert.deepEqual(opts,{keepInbox:true});cancel++;this.status='idle'}}
  const env={current:()=>true,chatType:'p2p',senderOpenId:'ou_user',allowedOpenIds:[],recovery:false,createTime:1000,now:()=>1000,llm,getAgent:()=>active,agentCurrent:a=>a===active,defaultSelection:()=>({provider:'mock',model:'a'}),startedAt:()=>1000,flush:async()=>true,resumeAgent:async()=>{resumes++;active=agent;return agent},newSession:async()=>{fresh++;active=null;selection={provider:'mock',model:'a'}},saveSelection:()=>globalWrites++}
  assert.equal(await execute(dm('/stop'),env),COMMAND_TEXT.idle);assert.equal(resumes,0)
  active=agent;agent.status='running';assert.equal(await execute(dm('/stop'),env),COMMAND_TEXT.stopped);assert.equal(cancel,1)
  agent.status='running';assert.equal(await execute(dm('/model switch 2'),env),COMMAND_TEXT.busy);assert.equal(switched,0)
  agent.status='idle';assert.equal(await execute(dm('/model switch 2'),env),'已切换为 mock/b（Beta），仅对当前会话生效');assert.equal(selection.model,'b');assert.equal(globalWrites,0)
  assert.equal(await execute(dm('/model switch missing'),env),COMMAND_TEXT.unavailable)
  assert.equal(await execute(dm('/model switch 2'),{...env,recovery:true,now:()=>62000}),COMMAND_TEXT.expired)
  assert.equal(await execute(dm('/stop'),{...env,recovery:true,now:()=>62000}),COMMAND_TEXT.expired);assert.equal(cancel,1)
  assert.equal(await execute(dm('/new'),env),COMMAND_TEXT.fresh);assert.equal(fresh,1);assert.equal(selection.model,'a')
  assert.match(await execute(dm('/status'),env),/ou_user/)
  assert.ok(!(await execute(dm('/status'),{...env,chatType:'group'})).includes('ou_'))
  assert.equal(await execute(dm('/new'),{...env,chatType:'group'}),COMMAND_TEXT.denied);assert.equal(fresh,1)
  active=null
  const coldStatus=await execute(dm('/status'),{...env,resumeAgent:async allowCreate=>{assert.equal(allowCreate,false);active=agent;return agent}})
  assert.ok(coldStatus.includes('当前模型：mock/Alpha'),'cold read-only status uses persistent selection, not defaults')
  active=null
  assert.match(await execute(dm('/status'),{...env,resumeAgent:async()=>null}),/当前模型：未知/)
  active=agent;agent.status='idle'
  const racing={...env,llm:{...llm,resolveCallConfig:async()=>{agent.status='running'}}}
  assert.equal(await execute(dm('/model switch 1'),racing),COMMAND_TEXT.busy);assert.equal(switched,1)
  agent.status='idle'
  let lateNow=1000
  assert.equal(await execute(dm('/model switch 2'),{...env,recovery:true,now:()=>lateNow,llm:{...llm,resolveCallConfig:async()=>{lateNow=62001}}}),COMMAND_TEXT.expired,'recovery expiry is checked again after asynchronous validation')
  assert.equal(switched,1,'late validation cannot execute an expired selection')
  const commandFailures = []
  const reportFailure = reason => commandFailures.push(reason)
  assert.equal(await execute(dm('/model switch 2'),{...env,flush:async()=>false,reportFailure}),COMMAND_TEXT.failed)
  const catalogCommands = ['/model list', '/model switch 2', '/model switch -p 2', '/model switch -t 2']
  for (const text of catalogCommands) {
    assert.equal(await execute(dm(text),{...env,llm:undefined,reportFailure}),'模型服务暂不可用，请稍后重试')
  }
  assert.match(await execute(dm('/help'),{...env,llm:undefined,reportFailure}),/查看帮助/)
  assert.deepEqual(commandFailures,['model_flush_unconfirmed', ...catalogCommands.map(() => 'model_catalog_unavailable')])
  const models=await commandModels(llm);assert.equal(resolveCommandModel(models,'1').model,'a');assert.equal(resolveCommandModel([...models,{...models[0],provider:'other'}],'Alpha'),null)
  assert.equal((await commandModels({...llm,listModels:async()=>Array.from({length:30},(_,i)=>({id:String(i),name:'Model '+i}))})).length,30)
  for (const text of ['/model 2','/model foo bar','/model switch','/model switch -x 1','/model switch 1 -t','/model switch -t -p 1']) {
    assert.equal(dm(text).action,'usage');assert.match(await execute(dm(text),env),/用法/)
  }
  assert.equal(dm('/MODEL SWITCH -T mock/b').mode,'t')
  assert.equal(commandAllowed(dm('/model list'),'group','ou_any',[]),true)
  assert.equal(await execute(dm('/model list'),env),'1:mock/a\n2:mock/b\n用法：/model；/model list；/model switch [-p|-t] <编号 | 供应商id/模型id>')
  assert.equal(resolveCommandModel(models,'mock/b').model,'b')
  assert.equal(resolveCommandModel(models,'Mock/b'),null)
  assert.equal(resolveCommandModel([{provider:'router',model:'vendor/name'}],'router/vendor/name').model,'vendor/name')
  const tempRoot=path.join(root,'temporary')
  let durable=0
  const flushTemp=async()=>{durable++;return true}
  let temporary=createTemporaryModels(tempRoot,flushTemp)
  agent.session={id:'private-session-sentinel'};selection={provider:'mock',model:'a'}
  await temporary.recover(agent)
  for (const outcome of ['normal','error','stop']) {
    await temporary.switch(agent,{provider:'mock',model:'b'},'t','private-trigger-sentinel')
    assert.equal(selection.model,'a');assert.equal(temporary.pending(agent.session.id).model,'b')
    await temporary.begin(agent);assert.equal(selection.model,'b')
    await assert.rejects(temporary.begin(agent),/temporary_model_busy/)
    await temporary.end(agent.session.id);assert.equal(selection.model,'a',outcome);assert.equal(temporary.pending(agent.session.id),null)
  }
  await temporary.switch(agent,{provider:'mock',model:'b'},'t','trigger')
  await temporary.begin(agent)
  temporary=createTemporaryModels(tempRoot,flushTemp)
  await temporary.recover(agent);assert.equal(selection.model,'a','restart restores original')
  await temporary.switch(agent,{provider:'mock',model:'b'},'t','trigger')
  await temporary.switch(agent,{provider:'mock',model:'a'},'t','trigger2')
  assert.equal(temporary.pending(agent.session.id).model,'a','new temporary overrides')
  await temporary.switch(agent,{provider:'mock',model:'b'},'p','trigger3')
  assert.equal(selection.model,'b');assert.equal(temporary.pending(agent.session.id),null)
  await temporary.switch(agent,{provider:'mock',model:'a'},'t','trigger4')
  await temporary.reset(agent,agent.session.id);assert.equal(temporary.pending(agent.session.id),null)
  assert.ok(durable>0)
  const many={...env,llm:{...llm,listModels:async()=>Array.from({length:51},(_,i)=>({id:'model'+i}))}}
  const listing=await execute(dm('/model list'),many)
  assert.ok(listing.includes('50:mock/model49'));assert.ok(!listing.includes('51:mock/model50'));assert.ok(listing.includes('仅显示前 50 个'))
  assert.match(await execute(dm('/model'),env),/当前模型：mock\/Beta/)
  await temporary.switch(agent,{provider:'mock',model:'a'},'t','private-trigger-sentinel')
  const tempFile=path.join(tempRoot,fs.readdirSync(tempRoot)[0]),tempBytes=fs.readFileSync(tempFile,'utf8')
  assert.ok(!tempBytes.includes('private-trigger-sentinel')&&!tempBytes.includes('private-session-sentinel'))
  fs.writeFileSync(tempFile,'null')
  assert.throws(()=>temporary.pending(agent.session.id),/temporary_model_store_invalid/)
  const localDate = new Date(2026, 10, 18, 9, 30, 45)
  const reporting = {
    ...env, startedAt: () => localDate.getTime(),
    runtimeInfo: () => ({ hostVersion: '0.2.2-rc.3', uptime: 53 * 3600, pluginVersion: '0.3.5' }),
  }
  const modelLine = await execute(dm('/model'), reporting)
  assert.equal(modelLine, '当前模型：mock/Beta')
  assert.deepEqual((await execute(dm('/status'), reporting)).split('\n'), [
    '会话状态：空闲', modelLine, '会话开始时间：2026-11-18 09:30',
    'DeepSeek Harness：0.2.2-rc.3，已运行 2 天 5 小时', 'dsh-messaging：0.3.5', '你的 open_id：ou_user',
  ])
  for (const [uptime, text] of [[0, '不到 1 小时'], [3599, '不到 1 小时'], [3600, '1 小时'], [86399, '23 小时'], [86400, '1 天 0 小时'], [undefined, '未知']]) {
    const status = await execute(dm('/status'), {
      ...reporting, chatType: 'group', runtimeInfo: () => ({ uptime, pluginVersion: '0.3.5' }),
    })
    assert.equal(status.split('\n').length, 5)
    assert.ok(status.includes('DeepSeek Harness：未知，已运行 ' + text))
    assert.ok(status.includes('dsh-messaging：0.3.5'))
    assert.ok(!status.includes('ou_user'))
  }
  const metadata = {
    ...llm, listProviders: () => [{ id: 'mock', name: 'Mock Provider' }],
    listModels: async () => [{ id: 'b' }],
    resolveModelInfo: async (provider, model) => {
      assert.equal(provider, 'mock')
      return { name: model === 'b' ? 'Resolved Beta' : model === 'alias' ? 'Alias Name' : model }
    },
  }
  assert.equal(await execute(dm('/model'), { ...env, llm: metadata }), '当前模型：Mock Provider/Resolved Beta')
  assert.equal(await execute(dm('/model switch -t mock/b'), {
    ...env, llm: metadata, switchModel: async (_agent, _selection, mode) => assert.equal(mode, 't'),
  }), '已切换为 mock/b（Resolved Beta），仅下一条消息生效')
  selection = { provider: 'mock', model: 'alias' }
  assert.equal(await execute(dm('/model'), { ...env, llm: metadata }), '当前模型：Mock Provider/Alias Name')
  const unnamed = { ...metadata, listModels: async () => [{ id: 'unnamed' }] }
  assert.equal(await execute(dm('/model switch mock/unnamed'), { ...env, llm: unnamed }), '已切换为 mock/unnamed，仅对当前会话生效')
  assert.equal(await execute(dm('/model'), { ...env, llm: unnamed }), '当前模型：Mock Provider/unnamed')
  // Durable receipt is acquired before side effects: replay or unknown never executes again.
  const lease=await openLarkDedupStore(path.join(root,'dedup'));let actions=0,wires=0
  const request={receipts:lease.sendReceipts,key:'receipt-command',kind:'command',appId:'app',conversation:'lark:chat',chatId:'chat',commandReply:async()=>{actions++;return '已停止当前回复'},wire:async()=>{wires++;return {ok:true,json:{code:0,data:{message_id:'synthetic'}}}}}
  assert.equal((await sendLarkNotice(request)).outcome,'delivered');assert.equal((await sendLarkNotice(request)).outcome,'delivered');assert.equal(actions,1);assert.equal(wires,1)
  const unknown={...request,key:'command-unknown',wire:async()=>null}
  assert.equal((await sendLarkNotice(unknown)).outcome,'unknown');assert.equal((await sendLarkNotice(unknown)).outcome,'unknown');assert.equal(actions,2)
  const diagnostics = [], replies = []
  const failureCases = [
    ['reply_exception', async () => { throw Error('private-error-sentinel') }],
    ['invalid_reply', async () => ''],
    ['invalid_reply', async () => '字'.repeat(4000)],
  ]
  for (const [index, [reason, commandReply]] of failureCases.entries()) {
    const input = {
      ...request, key:'failed-command-'+index, commandReply,
      onCommandFailure: value => diagnostics.push(value),
      wire: async (_method, _url, _headers, body) => {
        replies.push(JSON.parse(body.content).text)
        return {ok:true,json:{code:0,data:{message_id:'synthetic'}}}
      },
    }
    assert.equal((await sendLarkNotice(input)).outcome,'delivered')
    assert.equal((await sendLarkNotice(input)).outcome,'delivered')
    assert.equal(diagnostics.at(-1), reason)
  }
  assert.deepEqual(diagnostics,['reply_exception','invalid_reply','invalid_reply'])
  assert.deepEqual(replies,Array(3).fill(COMMAND_TEXT.failed))
  await lease.close()
  console.log('messaging-commands: ok | grammar/auth/expiry/generation0+idempotent+corruption/model-idle-race/global-zero/receipt replay-zero; fake host/wire')
} finally {fs.rmSync(root,{recursive:true,force:true})}
