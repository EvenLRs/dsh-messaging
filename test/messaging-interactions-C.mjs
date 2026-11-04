import './_guard.cjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createMessagingInteractions,createInteractionReceipts,interactionOriginator,INTERACTION_OPERATIONS } from '../lib/messaging-interactions.js'
import { createMessagingCardStore } from '../lib/messaging-card-store.js'
import { createLarkInteractions } from '../lib/lark-interactions.js'
import { validateCardDto,renderInteractionCard,cardInput } from '../lib/messaging-card-dto.js'
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const home=await fs.mkdtemp(path.join(os.tmpdir(),'interactions-C-')),open=[]
const dto={title:'Synthetic choices',text:'Choose or submit untrusted data',fields:[{id:'answer',label:'Answer',type:'text',required:true,max_length:20,enum:['one','two']}],choices:[{id:'yes',label:'Yes'}]}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function fixture(options={}){
 const root=path.join(home,String(open.length)),agent={},b={agent,record:{},runtime:{},generation:1,appId:'app',chatId:'chat',sessionId:'session',interactiveCard:false}
 let clock=options.now??Date.now();const now=()=>clock
 const state={binding:b,calls:[],admissions:[],raw:null,gate:null,admitGate:null,admitState:'input_admitted',admitHook:null}
 const provider=createLarkInteractions({async prepare(binding,call){if(state.prepareGate)await state.prepareGate;call.check();return{}},async request(binding,method,url,payload,call){call.check();call.onDispatch();state.calls.push({method,url,payload});if(state.gate)await state.gate;if(state.raw)return state.raw
  return {ok:true,status:200,json:{code:0,data:{message_id:'card-'+state.calls.length,chat_id:b.chatId,create_time:String(now())}}}}})
 const base=createMessagingCardStore(path.join(root,'cards'),{now,...options.storeOptions}),cardStore=options.wrap?options.wrap(base):base
 const host=createMessagingInteractions({bindingOf:a=>a===agent?state.binding:null,provider,receipts:createInteractionReceipts(path.join(root,'writes'),{now}),cardStore,now,timeoutMs:50,
  cardOptions:{retryDelayMs:5,admissionTimeoutMs:40},async admitCardInput(binding,umid,input){state.admissions.push({umid,input});state.admitHook?.();if(state.admitGate)await state.admitGate;return {state:state.admitState}}})
 const origin=interactionOriginator(b.appId,{sender_type:'user',sender_id:{open_id:'original-user'},tenant_key:'operator-tenant'},'app-tenant')
 host.remember({appId:b.appId,chatId:b.chatId,messageId:'incoming',createTime:now(),messageType:'text',chatType:'p2p',...origin})
 const target=host.select(agent,'incoming'),run=(op,args)=>host.route('lark',op,agent,args)
 const publish=(id='publish',extra={})=>run('card.publish',{target,operation_id:id,card:dto,...extra})
 function envelope(id='event',action='submit',fields={answer:'one'},wire=state.calls.at(-1)){
  const card=JSON.parse(wire.payload.content),form=card.body.elements.find(e=>e.tag==='form'),button=action==='cancel'?card.body.elements.find(e=>e.tag==='button'):form.elements.find(e=>e.tag==='button'&&e.name===action)
  const value=button.behaviors[0].value
  return {schema:'2.0',header:{event_type:'card.action.trigger',event_id:id,app_id:b.appId,tenant_key:'app-tenant'},event:{operator:{open_id:'original-user',tenant_key:'operator-tenant'},context:{open_message_id:'card-1',open_chat_id:b.chatId},token:'private-callback-token',action:{tag:'button',name:button.name,value,form_value:fields}}}
 }
 // Wire message identity corresponds to the fake successful publish response.
 const callback=(id='event',action='submit',fields={answer:'one'},wire=state.calls.at(-1),message='card-1')=>{const e=envelope(id,action,fields,wire);e.event.context.open_message_id=message;return e}
 open.push(host);return {root,agent,b,state,host,base,cardStore,target,run,publish,callback,now,setTime:v=>clock=v}
}
async function phase(f,ref,want){for(let i=0;i<100;i++){const v=await f.run('card.status',{workflow:ref});if(v.phase===want)return v;await wait(5)}assert.fail('workflow did not reach '+want)}
try{
 assert.equal(validateCardDto(dto),true)
 for(const bad of [{...dto,url:'https://bad.invalid'},{...dto,fields:[{id:'__proto__',type:'text',label:'bad'}]},{...dto,choices:[{id:'bad-url',label:'bad'}]},{...dto,fields:[{id:'x',type:'password',label:'secret'}]},{...dto,fields:[{id:'x',type:'text',label:'x',max_length:0}]},{...dto,fields:[{id:'submit',type:'text',label:'collision'}]},{...dto,fields:[{id:'c_yes',type:'text',label:'collision'}]}])assert.equal(validateCardDto(bad),false)
 assert.equal(cardInput(dto,'submit',undefined,{answer:'not-allowed'}),null);assert.equal(cardInput(dto,'submit',undefined,{answer:'one',extra:'no'}),null)
 const render=renderInteractionCard(dto,{ref:'workflow_'+'a'.repeat(40),nonce:'b'.repeat(64),version:1});assert.equal(render.schema,'2.0');assert.equal(render.config.update_multi,true)
 const f=await fixture();for(const c of ['onebot','telegram','discord','slack','wecom','wechat'])for(const op of INTERACTION_OPERATIONS)assert.equal((await f.host.route(c,op,f.agent,{})).error.code,'unsupported_operation')
 assert.equal(f.state.calls.length,0)
 const sent=await f.publish();assert.equal(sent.ok,true);assert.match(sent.workflowRef,/^workflow_[a-f0-9]{40}$/);assert.ok(sent.messageRef);assert.equal(sent.version,1)
 assert.equal(f.state.calls[0].method,'POST');assert.equal(f.state.calls[0].url,'/im/v1/messages/incoming/reply');assert.equal(f.state.calls[0].payload.msg_type,'interactive','explicit cards ignore automatic interactiveCard=false')
 const publishWire=f.state.calls[0],good=f.callback('event','submit',{answer:'one'},publishWire)
 assert.equal((await f.publish()).replayed,true);assert.equal(f.state.calls.length,1)
 assert.equal((await f.publish('publish',{card:{...dto,title:'different'}})).error.code,'conflict')
 for(const change of [e=>e.event.operator.open_id='foreign',e=>e.event.operator.tenant_key='other',e=>e.header.app_id='other',e=>e.event.context.open_chat_id='foreign',e=>e.event.context.open_message_id='wrong',e=>e.event.action.value.nonce='0'.repeat(64),e=>e.event.action.value.version=99,e=>e.event.action.form_value.extra='no',e=>e.event.action.form_value.answer='not-allowed']){
  const bad=structuredClone(good);change(bad);assert.equal((await f.host.callback(bad,'app',()=>true)).toast.type,'error')
 }
 assert.equal(f.state.admissions.length,0)
 let release;f.state.admitGate=new Promise(r=>release=r)
 const start=performance.now();assert.equal((await f.host.callback(good,'app',()=>true)).toast.type,'info');assert.ok(performance.now()-start<1000)
 await wait(5);assert.equal(f.state.admissions.length,1);assert.match(f.state.admissions[0].umid,/^lark-[a-f0-9]{8}-\d+-[a-f0-9]{16}$/)
 assert.equal((await f.run('card.status',{workflow:sent.workflowRef})).phase,'accepted')
 await f.host.callback(good,'app',()=>true);await f.host.callback({...good,header:{...good.header,event_id:'double-click'}},'app',()=>true)
 assert.equal(f.state.admissions.length,1)
 const changed=structuredClone(good);changed.header.event_id='different-input';changed.event.action.form_value.answer='two';assert.match((await f.host.callback(changed,'app',()=>true)).toast.content,/conflict/)
 release();await phase(f,sent.workflowRef,'input_admitted');assert.equal(f.state.admissions.length,1)
 const files=await fs.readdir(path.join(f.root,'cards'),{recursive:true});for(const file of files.filter(x=>x.endsWith('.jsonl'))){const text=await fs.readFile(path.join(f.root,'cards',file),'utf8');for(const secret of ['original-user','private-callback-token','Synthetic choices','"answer"','"one"'])assert.ok(!text.includes(secret))}
 // Update owns only its own shared static workflow, rotates the nonce/version.
 const u=await fixture();const us=await u.publish(),old=u.callback()
 const updated=await u.run('card.update',{operation_id:'update',workflow:us.workflowRef,expected_version:1,card:{...dto,text:'updated'}})
 assert.equal(updated.ok,true);assert.equal(updated.version,2);assert.equal(u.state.calls[1].method,'PATCH');assert.equal(JSON.parse(u.state.calls[1].payload.content).config.update_multi,true)
 assert.equal((await u.host.callback(old,'app',()=>true)).toast.type,'error')
 assert.equal((await u.run('card.update',{operation_id:'stale',workflow:us.workflowRef,expected_version:1,card:dto})).error.code,'conflict')
 const cancel=u.callback('cancel','cancel',{},u.state.calls[1]);assert.match((await u.host.callback(cancel,'app',()=>true)).toast.content,/已取消/)
 assert.equal(u.state.admissions.length,0);assert.equal((await u.run('card.status',{workflow:us.workflowRef})).phase,'cancelled')
 assert.equal((await u.host.callback(u.callback('late','submit',{answer:'one'},u.state.calls[1]),'app',()=>true)).toast.type,'error')
 const choose=await fixture();const choicePublished=await choose.publish();await choose.host.callback(choose.callback('choice','c_yes',{answer:'two'}),'app',()=>true);await phase(choose,choicePublished.workflowRef,'input_admitted');assert.equal(JSON.parse(choose.state.admissions[0].input).choice,'yes')
 const updateUnknown=await fixture();const updatePub=await updateUnknown.publish();updateUnknown.state.raw={ok:false,status:500};const updateArgs={operation_id:'unknown-update',workflow:updatePub.workflowRef,expected_version:1,card:dto}
 assert.equal((await updateUnknown.run('card.update',updateArgs)).status,'unknown');assert.equal((await updateUnknown.run('card.update',updateArgs)).status,'unknown');assert.equal(updateUnknown.state.calls.length,2)
 const paused=await fixture();const pausedPub=await paused.publish();paused.state.admitState='retry';await paused.host.callback(paused.callback(),'app',()=>true);await phase(paused,pausedPub.workflowRef,'paused');assert.match((await paused.host.callback(paused.callback(),'app',()=>true)).toast.content,/paused/)
 const buttons=await fixture();const onlyButtons={...dto,fields:[]};const pureButtons=await buttons.publish('buttons',{card:onlyButtons});await buttons.host.callback(buttons.callback('buttons','c_yes',{}),'app',()=>true);await phase(buttons,pureButtons.workflowRef,'input_admitted')
 assert.equal(cardInput(onlyButtons,'submit',undefined,{}),null)
 const expired=await fixture();await expired.publish('expiry',{ttl_seconds:5});const expiredCb=expired.callback();expired.setTime(expired.now()+5001);assert.match((await expired.host.callback(expiredCb,'app',()=>true)).toast.content,/expired/);assert.equal(expired.state.admissions.length,0)
 const stale=await fixture();await stale.publish();const staleCb=stale.callback();stale.state.binding={...stale.b,generation:2};assert.match((await stale.host.callback(staleCb,'app',()=>true)).toast.content,/stale/);assert.equal(stale.state.admissions.length,0)
 const unknown=await fixture();unknown.state.raw={ok:false,status:500};assert.equal((await unknown.publish()).status,'unknown');assert.equal((await unknown.publish()).status,'unknown');assert.equal(unknown.state.calls.length,1)
 const biz=await fixture();biz.state.raw={ok:true,status:200,json:{code:99991672,msg:'private-error'}};assert.equal((await biz.publish()).error.code,'permission_denied');await biz.publish();assert.equal(biz.state.calls.length,1)
 const day=await fixture();const dayResult=await day.publish();day.setTime(day.now()+86400000);assert.equal((await day.publish()).replayed,true);assert.equal(day.state.calls.length,1)
 const dayUnknown=await fixture();dayUnknown.state.raw={ok:false,status:500};await dayUnknown.publish();dayUnknown.setTime(dayUnknown.now()+86400000);assert.equal((await dayUnknown.publish()).status,'unknown');assert.equal(dayUnknown.state.calls.length,1)
 const capacity=await fixture({storeOptions:{capacity:1}});await capacity.publish();await assert.rejects(capacity.host.callback(capacity.callback(),'app',()=>true),/card callback unavailable/);assert.equal(capacity.state.admissions.length,0)
 const recalled=await fixture();const recalledPub=await recalled.publish();await recalled.run('message.recall',{operation_id:'recall',target:recalledPub.messageRef});assert.match((await recalled.host.callback(recalled.callback('event','submit',{answer:'one'},recalled.state.calls[0]),'app',()=>true)).toast.content,/not_found_or_recalled/);assert.equal(recalled.state.admissions.length,0)
 const race=await fixture();const raceSent=await race.publish(),raceCallback=race.callback();let releasePrepare;race.state.prepareGate=new Promise(r=>releasePrepare=r)
 const updating=race.run('card.update',{operation_id:'race',workflow:raceSent.workflowRef,expected_version:1,card:dto})
 await wait(5);await race.host.callback(raceCallback,'app',()=>true);releasePrepare();assert.equal((await updating).error.code,'conflict');assert.equal(race.state.calls.length,1)
 let holdIO=false,releaseIO;const ioGate=new Promise(r=>releaseIO=r)
 const slow=await fixture({wrap:base=>({...base,async with(...args){if(holdIO)await ioGate;return base.with(...args)}})})
 await slow.publish();holdIO=true;const timeoutStart=performance.now()
 await assert.rejects(slow.host.callback(slow.callback(),'app',()=>true),/card callback unavailable/)
 assert.ok(performance.now()-timeoutStart<2900,'callback deadline stays below the platform 3 second budget')
 assert.equal(slow.state.admissions.length,0);holdIO=false;releaseIO();await wait(10);assert.equal(slow.state.admissions.length,0,'late durable work cannot enqueue after timeout')
 const another=await f.publish('another-workflow'),anotherEvent=f.callback('event','submit',{answer:'one'},f.state.calls.at(-1),'card-2')
 assert.ok(another.ok);assert.match((await f.host.callback(anotherEvent,'app',()=>true)).toast.content,/conflict/);assert.equal(f.state.admissions.length,1)
 assert.equal((await f.run('card.status',{workflow:sent.workflowRef})).remoteApproval,'host_principal_mapping_unverified')
 const missing=await fixture();missing.host.remember({appId:'app',chatId:'chat',messageId:'historical',createTime:missing.now()});const historical=missing.host.select(missing.agent,'historical');assert.equal((await missing.run('card.publish',{operation_id:'history',target:historical,card:dto})).error.code,'originator_unverified');assert.equal(missing.state.calls.length,0)
 // Flush retry is represented as a repeated projection probe of the same umid,
 // never an automatic second user input. Real host exercises actual projection.
 const retry=await fixture();const rs=await retry.publish();retry.state.admitState='retry';await retry.host.callback(retry.callback(),'app',()=>true);await wait(15);retry.state.admitState='input_admitted';await phase(retry,rs.workflowRef,'input_admitted');assert.equal(new Set(retry.state.admissions.map(x=>x.umid)).size,1)
 const rebuild=await fixture();await rebuild.publish();const cb=rebuild.callback();rebuild.host.reset();assert.match((await rebuild.host.callback(cb,'app',()=>true)).toast.content,/needs_resubmission/);assert.equal(rebuild.state.admissions.length,0)
 const lost=await fixture();await lost.publish();const lostCb=lost.callback();lost.state.admitGate=new Promise(()=>{})
 await lost.host.callback(lostCb,'app',()=>true);await wait(5);const beforeLost=lost.state.admissions.length
 lost.host.reset();await wait(50)
 assert.match((await lost.host.callback(lostCb,'app',()=>true)).toast.content,/needs_resubmission/);assert.equal(lost.state.admissions.length,beforeLost,'rebuild cannot invent or replay lost freeform input')
 assert.match((await f.host.callback({schema:'1.0',header:{event_type:'card.action.trigger_v1'}},'app',()=>true)).toast.content,/legacy_callback_unsupported/)
 console.log('messaging-interactions-C: ok | finite JSON2 DTO, explicit publish/update, sender/tenant/chat/nonce/version, bounded durable claim, callback ACK independent of admission, replay/doubleclick/cancel/expiry/rebuild, unknown and no plaintext sidecar; fake transport/host admission')
}finally{await Promise.all(open.map(x=>x.close()));await fs.rm(home,{recursive:true,force:true})}
