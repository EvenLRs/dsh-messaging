import './_guard.cjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createMessagingInteractions, createInteractionReceipts, INTERACTION_OPERATIONS } from '../lib/messaging-interactions.js'
import { createInteractionEvents, interactionIdentityHash as hash } from '../lib/messaging-interaction-events.js'
import { createLarkInteractions } from '../lib/lark-interactions.js'
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-B-')), opened = []
async function fixture(options = {}) {
 const root = path.join(home, String(opened.length)), agent = {}, b = { agent, record: {}, runtime: {}, generation: 1, appId: 'fixture-app', chatId: 'fixture-chat', sessionId: 'fixture-sid' }
 const state = { binding: b, calls: [], raw: null, gate: null, hook: null, throw: false }
 const receipts = createInteractionReceipts(path.join(root, 'writes'))
 const provider = createLarkInteractions({ async request(binding, method, url, body, call) {
  call.check(); call.onDispatch(); state.calls.push({ method, url, body }); state.hook?.()
  if(state.gate) await state.gate
  if(state.throw) throw new Error('private-error-token')
  if(state.raw) return typeof state.raw === 'function' ? state.raw(method,url,body) : state.raw
  return {ok:true,status:200,json:{code:0,data: url.includes('/reactions') && method === 'POST' ? {reaction_id:'fixture-reaction',operator:{operator_type:'app',operator_id:b.appId}} : method === 'GET' ? {items:[],has_more:false} : {message_id:'bot-answer',create_time:String(Date.now())}}}
 } })
 const events = createInteractionEvents(path.join(root,'events'))
 const host = createMessagingInteractions({ bindingOf:a=>a===agent?state.binding:null,provider, receipts:options.wrap ? options.wrap(receipts) : receipts, events,timeoutMs:options.timeoutMs || 500 })
 function add(id, meta={}) {host.remember({appId:b.appId,chatId:b.chatId,messageId:id,createTime:Date.now(),messageType:'text',chatType:'p2p',...meta});return host.select(agent,id)}
 const incoming=add('incoming'), own=add('own',{botAuthored:true})
 const run=(op,input={},target=own)=>host.route('lark',op,agent,{target,...input})
 opened.push(host);return {host,b,agent,state,root,events,receipts,add,own,incoming,run}
}
const action=(id='op')=>({operation_id:id})
const event=(f,type,id,body)=>({header:{event_type:type,event_id:id,app_id:f.b.appId},event:body})
try {
 const f=await fixture()
 for(const channel of ['onebot','telegram','discord','slack','wecom','wechat']) for(const op of INTERACTION_OPERATIONS) assert.equal((await f.host.route(channel,op,f.agent,{})).error.code,'unsupported_operation')
 assert.equal(f.state.calls.length,0)
 for(const op of ['message.edit','message.recall','read.query','read.events']) assert.equal((await f.run(op,{...(op.startsWith('read.')?{}:action()),...(op==='message.edit'?{text:'replace'}:{})},f.incoming)).error.code,'not_owned')
 assert.equal(f.state.calls.length,0)
 assert.equal((await f.run('message.edit',{...action('edit'),text:'replace'})).ok,true)
 assert.deepEqual(f.state.calls[0],{method:'PUT',url:'/im/v1/messages/own',body:{msg_type:'text',content:'{"text":"replace"}'}})
 assert.equal((await f.run('message.edit',{...action('edit'),text:'replace'})).replayed,true)
 assert.equal((await f.run('message.edit',{...action('edit'),text:'different'})).error.code,'conflict')
 const post=f.add('post',{botAuthored:true,messageType:'post'})
 await f.run('message.edit',{...action(),text:'post'},post);assert.equal(f.state.calls.at(-1).method,'PUT');assert.equal(JSON.parse(f.state.calls.at(-1).body.content).zh_cn.content[0][0].text,'post')
 const card=f.add('card',{botAuthored:true,messageType:'static_card',updateMulti:true})
 await f.run('message.edit',{...action(),text:'card'},card);assert.equal(f.state.calls.at(-1).method,'PATCH');assert.equal(JSON.parse(f.state.calls.at(-1).body.content).config.update_multi,true)
 for(const type of ['cardkit','image','unknown']) {const ref=f.add(type,{botAuthored:true,messageType:type});assert.equal((await f.run('message.edit',{...action(),text:'no'},ref)).error.code,'unsupported_message_type')}
 const reaction=await f.run('reaction.add',{...action('react'),emoji:'THUMBSUP'},f.incoming)
 assert.match(reaction.reactionRef,/^reactionref_[a-f0-9]{40}$/)
 assert.equal(f.state.calls.at(-1).method,'POST');assert.deepEqual(f.state.calls.at(-1).body,{reaction_type:{emoji_type:'THUMBSUP'}})
 const beforeRemove=f.state.calls.length
 assert.equal((await f.run('reaction.remove',{...action(),reaction_ref:'fixture-reaction'},f.incoming)).error.code,'reaction_unverified')
 assert.equal((await f.run('reaction.remove',{...action(),reaction_ref:reaction.reactionRef})).error.code,'reaction_unverified')
 assert.equal(f.state.calls.length,beforeRemove)
 assert.equal((await f.run('reaction.remove',{...action(),reaction_ref:reaction.reactionRef},f.incoming)).ok,true)
 assert.equal(f.state.calls.at(-1).url,'/im/v1/messages/incoming/reactions/fixture-reaction');assert.equal(f.state.calls.at(-1).method,'DELETE')
 assert.equal((await f.run('reaction.remove',{...action(),reaction_ref:reaction.reactionRef},f.incoming)).replayed,true)
 assert.equal((await f.run('reaction.remove',{...action('new'),reaction_ref:reaction.reactionRef},f.incoming)).error.code,'reaction_unverified')
 // Own reaction references come only from app-owned real response entries.
 f.state.raw={ok:true,status:200,json:{code:0,data:{items:[{reaction_id:'mine',operator:{operator_type:'app',operator_id:f.b.appId},reaction_type:{emoji_type:'SMILE'}},{reaction_id:'foreign',operator:{operator_type:'user',operator_id:'private-user'},reaction_type:{emoji_type:'SMILE'}}],has_more:false}}}
 const listed=await f.run('reaction.list');assert.equal(listed.counts.SMILE,2);assert.equal(listed.ownReactions.length,1);assert.equal(listed.complete,true);assert.ok(!JSON.stringify(listed).includes('private-user'));assert.ok(!JSON.stringify(listed).includes('foreign'))
 // Three bounded pages; empty is an observation, never a negative/full statistic.
 f.state.raw=(method,url)=>({ok:true,status:200,json:{code:0,data:{items:[{user_id_type:'open_id',user_id:url.includes('page_token')?'reader2':'reader1',timestamp:String(Date.now())}],has_more:true,page_token:url.includes('page_token=next2')?'next3':url.includes('page_token=next')?'next2':'next'}}})
 const readers=await f.run('read.query');assert.equal(readers.pages,3);assert.equal(readers.partial,true);assert.equal(readers.observedReaders,2);assert.equal(readers.unread,'unknown');assert.ok(!JSON.stringify(readers).includes('reader1'))
 f.state.raw={ok:true,status:200,json:{code:0,data:{items:[],has_more:false}}};const empty=await f.run('read.query');assert.equal(empty.observedReaders,0);assert.equal(empty.unread,'unknown')
 let readPage=0
 f.state.raw=()=>++readPage===1?{ok:true,status:200,json:{code:0,data:{items:[{user_id_type:'open_id',user_id:'private-partial',timestamp:String(Date.now())}],has_more:true,page_token:'more'}}}:{ok:true,status:200,json:{code:99991672,msg:'private-scope-error'}}
 const partial=await f.run('read.query');assert.equal(partial.partial,true);assert.equal(partial.observedReaders,1);assert.equal(partial.reason,'permission_denied')
 assert.ok(!JSON.stringify(partial).includes('private-'))
 f.state.raw=null
 // Independent operation domains and target-scoped ids: same id is not a recall replay.
 assert.equal((await f.run('message.recall',action('edit'))).ok,true);assert.equal(f.state.calls.at(-1).method,'DELETE')
 assert.equal((await f.run('message.recall',action('edit'))).replayed,true)
 const n=f.state.calls.length;assert.equal((await f.run('message.edit',{...action('new'),text:'no'})).error.code,'not_found_or_recalled');assert.equal(f.state.calls.length,n)
 const another=f.add('another',{botAuthored:true});assert.equal((await f.run('message.edit',{...action('edit'),text:'replace'},another)).ok,true)
 for(const [code,want] of [[99991672,'permission_denied'],[230027,'access_denied'],[231015,'conflict'],[230110,'not_found_or_recalled']]) {
  const t=await fixture();t.state.raw={ok:true,status:200,json:{code,msg:'private-error-token'}}
  const result=await t.run('message.edit',{...action(),text:'x'});assert.equal(result.error.code,want);assert.equal(result.dispatched,true);assert.ok(!JSON.stringify(result).includes('private'))
  assert.equal((await t.run('message.edit',{...action(),text:'x'})).error.code,want);assert.equal(t.state.calls.length,1)
 }
 for(const op of ['message.edit','message.recall','reaction.add','reaction.remove']) {
  const t=await fixture({timeoutMs:20});let ref
  if(op==='reaction.remove') ref=(await t.run('reaction.add',{...action('first'),emoji:'SMILE'})).reactionRef
  t.state.gate=new Promise(()=>{}); const args={...action(),...(op==='message.edit'?{text:'x'}:op==='reaction.add'?{emoji:'SMILE'}:op==='reaction.remove'?{reaction_ref:ref}:{})}
  assert.equal((await t.run(op,args)).status,'unknown');const count=t.state.calls.length
  assert.equal((await t.run(op,args)).status,'unknown');assert.equal(t.state.calls.length,count)
  assert.equal((await t.run('message.edit',{operation_id:'different-after-unknown',text:'no'})).error.code,'operation_inflight')
  assert.equal(t.state.calls.length,count,'a timed-out underlying request must block NEW same-target writes')
 }
 const latePending=await fixture({timeoutMs:15});let endLate
 latePending.state.gate=new Promise(r=>endLate=r)
 assert.equal((await latePending.run('message.edit',{...action('late'),text:'x'})).status,'unknown')
 assert.equal((await latePending.run('message.recall',action('later'))).error.code,'operation_inflight')
 endLate();await new Promise(r=>setTimeout(r,5));latePending.state.gate=null
 assert.equal((await latePending.run('message.recall',action('later'))).ok,true)
 // Same-target lock spans underlying pending HTTP, not only its local timeout.
 const serial=await fixture();let release;serial.state.gate=new Promise(r=>release=r)
 const p=serial.run('message.edit',{...action('e'),text:'x'});while(!serial.state.calls.length) await new Promise(r=>setTimeout(r,1))
 const q=serial.run('message.recall',action('r'));await new Promise(r=>setTimeout(r,15));assert.equal(serial.state.calls.length,1)
 release();assert.equal((await p).ok,true);assert.equal((await q).ok,true);assert.deepEqual(serial.state.calls.map(x=>x.method),['PUT','DELETE'])
 const stale=await fixture();stale.state.hook=()=>{stale.state.binding={...stale.b,generation:2}}
 assert.equal((await stale.run('message.edit',{...action(),text:'x'})).status,'unknown')
 assert.equal((await stale.run('message.edit',{...action('new'),text:'x'})).error.code,'target_unverified');assert.equal(stale.state.calls.length,1)
 const ordinary=await fixture();assert.equal((await ordinary.host.route('lark','message.recall',{}, {target:ordinary.own,...action()})).error.code,'not_bound');assert.equal(ordinary.state.calls.length,0)
 for(const malformed of [{},{code:'0'},null]) {
  const t=await fixture();t.state.raw={ok:true,status:200,json:malformed}
  assert.equal((await t.run('message.edit',{...action(),text:'x'})).status,'unknown')
  assert.equal((await t.run('message.edit',{...action(),text:'x'})).status,'unknown');assert.equal(t.state.calls.length,1)
 }
 // Receipt persistence failure after dispatch stays unknown, including replay.
 const broken=await fixture({wrap:base=>({async acquire(t){const pin=await base.acquire(t);return {...pin,store:{get:pin.store.get.bind(pin.store),begin:pin.store.begin.bind(pin.store),async finish(){throw new Error('private-disk-error')}}}},close:()=>base.close()})})
 assert.equal((await broken.run('message.edit',{...action(),text:'x'})).status,'unknown')
 assert.equal((await broken.run('message.edit',{...action(),text:'x'})).status,'unknown');assert.equal(broken.state.calls.length,1)
 const durable=await fixture();const created=Date.now(), durableRef=durable.add('durable',{botAuthored:true,createTime:created})
 durable.state.throw=true
 assert.equal((await durable.run('message.edit',{...action('durable'),text:'x'},durableRef)).status,'unknown')
 await durable.host.close()
 const restart=createMessagingInteractions({bindingOf:a=>a===durable.agent?durable.b:null,provider:{validateOperation:()=>({ok:true}),prepareOperation(){assert.fail('unknown replay must not prepare')},operate(){assert.fail('unknown replay must never redispatch')}},receipts:createInteractionReceipts(path.join(durable.root,'writes'))})
 opened.push(restart);restart.remember({appId:durable.b.appId,chatId:durable.b.chatId,messageId:'durable',createTime:created,botAuthored:true,messageType:'text'})
 const restartedRef=restart.select(durable.agent,'durable')
 assert.equal((await restart.route('lark','message.edit',durable.agent,{target:restartedRef,operation_id:'durable',text:'x'})).status,'unknown')
 // Shared target queue also orders explicit A replies against B recalls, while
 // A's acquired-owner replay remains immediate and does not redispatch.
 const mixed=await fixture();let mixedRelease;mixed.state.gate=new Promise(r=>mixedRelease=r)
 const mixedReply=mixed.host.reply(mixed.agent,{target:mixed.own,operation_id:'reply',text:'x'})
 while(!mixed.state.calls.length)await new Promise(r=>setTimeout(r,1))
 const mixedRecall=mixed.run('message.recall',action('recall'))
 await new Promise(r=>setTimeout(r,15));assert.equal(mixed.state.calls.length,1)
 mixedRelease();assert.equal((await mixedReply).ok,true);assert.equal((await mixedRecall).ok,true)
 assert.deepEqual(mixed.state.calls.map(x=>x.method),['POST','DELETE'])
 const missingOperator=await fixture();missingOperator.state.raw={ok:true,status:200,json:{code:0,data:{reaction_id:'unverified'}}}
 assert.equal((await missingOperator.run('reaction.add',{...action(),emoji:'SMILE'})).status,'unknown')
 // Durable event domain is separate, has no agent consumer and stores no raw ids.
 const e=await fixture();const at=String(Date.now()), current=()=>true
 const read=event(e,'im.message.message_read_v1','read1',{reader:{reader_id:{open_id:'private-reader'},read_time:at},message_id_list:['own']})
 assert.equal((await e.host.event(read,e.b.appId,current)).duplicate,false);assert.equal((await e.host.event(read,e.b.appId,current)).duplicate,true)
 let obs=await e.run('read.events');assert.equal(obs.observedReaders,1);assert.equal(obs.complete,false);assert.equal(obs.unread,'unknown');assert.ok(!JSON.stringify(obs).includes('private-reader'))
 const group=e.add('group-own',{botAuthored:true,chatType:'group'});assert.equal((await e.run('read.events',{},group)).error.code,'unsupported_context')
 await e.host.event(event(e,'im.message.message_read_v1','group-read',{reader:{reader_id:{open_id:'private-reader'},read_time:at},message_id_list:['group-own']}),e.b.appId,current)
 const reactionBody={message_id:'own',operator_type:'user',user_id:{open_id:'private-user'},reaction_type:{emoji_type:'SMILE'},action_time:at}
 await e.host.event(event(e,'im.message.reaction.created_v1','rc',reactionBody),e.b.appId,current)
 assert.equal((await e.run('read.events')).reactions.SMILE,1)
 await e.host.event(event(e,'im.message.reaction.deleted_v1','rd',reactionBody),e.b.appId,current)
 assert.equal((await e.run('read.events')).reactions.SMILE,undefined)
 await e.host.event(event(e,'im.message.recalled_v1','wrongchat',{message_id:'own',chat_id:'foreign-chat',recall_time:at}),e.b.appId,current)
 assert.equal((await e.run('message.edit',{...action('still'),text:'x'})).ok,true)
 await e.host.event(event(e,'im.message.recalled_v1','recalled',{message_id:'own',chat_id:e.b.chatId,recall_time:at}),e.b.appId,current)
 assert.equal((await e.run('message.edit',{...action('blocked'),text:'x'})).error.code,'not_found_or_recalled')
 assert.equal((await e.host.context(e.agent,{target:e.own})).error.code,'not_found_or_recalled')
 assert.equal(e.state.calls.length,1)
 await assert.rejects(e.host.event(read,'wrong-app',current),/interaction event unavailable/)
 await assert.rejects(e.host.event(read,e.b.appId,()=>false),/interaction event unavailable/)
 const files=await fs.readdir(path.join(e.root,'events'),{recursive:true});for(const name of files.filter(n=>n.endsWith('.jsonl'))) {const data=await fs.readFile(path.join(e.root,'events',name),'utf8');for(const secret of ['private-reader','private-user','fixture-chat','fixture-app','"own"']) assert.ok(!data.includes(secret))}
 // Persisted pending claim can be safely taken over because only an immutable
 // local fact is applied; there is never an external replay or fabricated owner.
 const eventRoot=path.join(home,'pending-event'), atPending=Date.now()
 const fact={id:hash('pending-event'),identity:hash('pending-identity'),kind:'read',at:atPending,targets:[hash('target')],operator:hash('reader'),emoji:null}
 const pendingPool=createInteractionReceipts(eventRoot),pin=await pendingPool.acquire(atPending)
 await pin.store.begin({uuid:fact.id,digest:hash({...fact,targets:[]}),now:atPending});await pin.release();await pendingPool.close()
 const takeover=createInteractionEvents(eventRoot)
 assert.equal((await takeover.accept(fact,()=>true)).duplicate,false);assert.equal((await takeover.accept(fact,()=>true)).duplicate,true)
 assert.equal((await takeover.snapshot(hash('target'))).observedReaders,1);await takeover.close()
 // An ACKed immutable event is idempotent even when catalogue eviction means
 // a later retry has a different derived set of currently verifiable targets.
 const retryRoot=path.join(home,'retry-event'), eventStore=createInteractionEvents(retryRoot)
 const retryFact={...fact,id:hash('retry-event'),identity:hash('same-payload')}
 await eventStore.accept(retryFact,()=>true)
 const retry=await eventStore.accept({...retryFact,targets:[]},()=>true)
 assert.equal(retry.duplicate,true);assert.deepEqual(retry.targets,retryFact.targets)
 await assert.rejects(eventStore.accept({...retryFact,identity:hash('changed-payload')},()=>true))
 await eventStore.close()
 const eventFailure=createMessagingInteractions({bindingOf:()=>e.b,provider:{},receipts:createInteractionReceipts(path.join(home,'event-failure-writes')),events:{async accept(){throw new Error('private-storage-path-token')},async close(){}}})
 opened.push(eventFailure)
 await assert.rejects(eventFailure.event(read,e.b.appId,()=>true),err=>err.message==='interaction event unavailable'&&!err.message.includes('private-'))
 const capacityEvents=createInteractionEvents(path.join(home,'capacity-events'),{capacity:1})
 await capacityEvents.accept(fact,()=>true)
 await assert.rejects(capacityEvents.accept({...fact,id:hash('overflow'),identity:hash('overflow-identity')},()=>true))
 assert.equal((await capacityEvents.snapshot(hash('target'))).observedReaders,1);await capacityEvents.close()
 const targetHash=hash([e.b.appId,e.b.chatId,'own']);await e.host.close();opened.splice(opened.indexOf(e.host),1)
 const reopened=createInteractionEvents(path.join(e.root,'events'));assert.equal((await reopened.snapshot(targetHash)).recalled,true);await reopened.close()
 console.log('messaging-interactions-B: ok | edit text/post/static, recall, reactions ownership, scoped operation receipts/replay/errors/unknown, target serialization, bounded read aggregation, durable independent authenticated event facts, stale/cross-chat/six-channel guards; fake transport')
} finally {await Promise.all(opened.map(h=>h.close()));await fs.rm(home,{recursive:true,force:true})}
