import './_guard.cjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { createMessagingInteractions,createInteractionReceipts,interactionOriginator } from '../lib/messaging-interactions.js'
import { createMessagingCardStore } from '../lib/messaging-card-store.js'
import { createLarkInteractions } from '../lib/lark-interactions.js'
import { cardInput } from '../lib/messaging-card-dto.js'
const home=await fs.mkdtemp(path.join(os.tmpdir(),'card-cancel-')),hosts=[]
const dto={title:'Synthetic cancel',text:'Synthetic required form',fields:[{id:'answer',label:'Answer',type:'text',required:true,max_length:20,enum:['one','two']}],choices:[{id:'yes',label:'Yes'}]}
const secret='CANCEL_PRIVATE_SENTINEL'
const tick=()=>new Promise(r=>setTimeout(r,5))
async function fixture(){
 const root=path.join(home,String(hosts.length)),agent={},b={agent,record:{},runtime:{},generation:1,appId:'app',chatId:'chat',sessionId:'session'}
 let clock=Date.now();const now=()=>clock,state={binding:b,calls:[],admissions:[],current:true}
 const provider=createLarkInteractions({async prepare(_b,call){call.check();return{}},async request(_b,method,url,payload,call){call.check();call.onDispatch();state.calls.push({method,url,payload});return{ok:true,status:200,json:{code:0,data:{message_id:'card-1',chat_id:'chat',create_time:String(now())}}}}})
 const host=createMessagingInteractions({bindingOf:a=>a===agent?state.binding:null,provider,receipts:createInteractionReceipts(path.join(root,'writes'),{now}),cardStore:createMessagingCardStore(path.join(root,'cards'),{now}),now,async admitCardInput(_b,_umid,input){state.admissions.push(input);return{state:'input_admitted'}}});hosts.push(host)
 host.remember({appId:'app',chatId:'chat',messageId:'incoming',createTime:now(),messageType:'text',chatType:'p2p',...interactionOriginator('app',{sender_type:'user',sender_id:{open_id:'operator'},tenant_key:'operator-tenant'},'app-tenant')})
 const run=(op,args)=>host.route('lark',op,agent,args),published=await run('card.publish',{target:host.select(agent,'incoming'),operation_id:'publish',card:dto,ttl_seconds:5});assert.equal(published.ok,true)
 const card=JSON.parse(state.calls[0].payload.content),form=card.body.elements.find(e=>e.tag==='form'),cancel=card.body.elements.find(e=>e.tag==='button')
 assert.equal(cancel.behaviors[0].value.action,'cancel');assert.equal(cancel.form_action_type,undefined);assert.ok(!form.elements.includes(cancel));assert.equal(form.elements.find(e=>e.name==='submit').form_action_type,'submit')
 const dispatcher=new EventDispatcher({verificationToken:'synthetic-verification',logger:{debug(){},info(){},warn(){},error(){},trace(){}}})
 dispatcher.register({'card.action.trigger':data=>host.callback({schema:'2.0',header:{event_type:'card.action.trigger',event_id:data.event_id,app_id:'app',tenant_key:data.tenant_key},event:data},'app',()=>state.current)})
 let sequence=0
 function body(action='cancel',options={}){
  const button=action==='cancel'?cancel:form.elements.find(e=>e.name===(action==='choice'?'c_yes':action))
  const a={tag:'button',value:structuredClone(button.behaviors[0].value)}
  if(Object.hasOwn(options,'name'))a.name=options.name;else if(action!=='cancel')a.name=button.name
  if(Object.hasOwn(options,'form'))a.form_value=options.form;else if(action!=='cancel')a.form_value={answer:'one'}
  return{schema:'2.0',header:{event_type:'card.action.trigger',event_id:'event-'+(++sequence),app_id:'app',tenant_key:'app-tenant',token:'synthetic-verification'},event:{operator:{open_id:'operator',tenant_key:'operator-tenant'},context:{open_message_id:'card-1',open_chat_id:'chat'},action:a}}
 }
 return{root,state,host,run,published,body,dispatch:e=>dispatcher.invoke(e),setTime:t=>clock=t,now}
}
async function zero(f){await tick();assert.equal(f.state.admissions.length,0);assert.equal(f.state.calls.length,1,'cancel/rejected input must issue no provider write or read')}
try{
 // Form-external button callbacks need not carry the form-only name or values.
 // Local input state never enters that callback: no required-field validation.
 for(const localState of ['untouched-required','filled-required','empty-required'])for(const options of [{},{name:'cancel'},{form:{}},{name:'cancel',form:{}}]){
  const f=await fixture(),event=f.body('cancel',options)
  assert.match((await f.dispatch(event)).toast.content,/已取消/,localState+': missing outside-form name must not be invalid_input')
  assert.equal((await f.run('card.status',{workflow:f.published.workflowRef})).phase,'cancelled')
  assert.match((await f.dispatch(event)).toast.content,/已取消/)
  assert.match((await f.dispatch(f.body('cancel',{form:{}}))).toast.content,/已取消/,'new event id and empty form use the same payload-free cancel digest')
  assert.equal((await f.dispatch(f.body('submit'))).toast.type,'error');assert.equal((await f.dispatch(f.body('choice'))).toast.type,'error');await zero(f)
 }
 // No contract evidence for nonempty form_value on this form-external button:
 // retain fail-closed DTO validation, including null and malformed structures.
 for(const form of [null,[],[secret],'',secret,0,false,{answer:secret},{answer:''},{extra:secret},{answer:{nested:secret}}]){
  const f=await fixture();assert.match((await f.dispatch(f.body('cancel',{form}))).toast.content,/invalid_input/);assert.equal((await f.run('card.status',{workflow:f.published.workflowRef})).phase,'active');await zero(f)
 }
 for(const name of ['submit','c_yes','',null,0,{},[]]){
  const f=await fixture();assert.match((await f.dispatch(f.body('cancel',{name}))).toast.content,/invalid_input/);await zero(f)
 }
 // All authority checks still precede the optional-name compatibility case.
 const corrupt=[e=>e.event.operator.open_id='foreign',e=>e.event.operator.tenant_key='foreign',e=>e.header.tenant_key='foreign',e=>e.event.context.open_chat_id='foreign',e=>e.event.context.open_message_id='foreign',e=>e.event.action.value.workflow='workflow_'+'0'.repeat(40),e=>e.event.action.value.version=99,e=>e.event.action.value.nonce='0'.repeat(64),e=>e.event.action.tag='input',e=>e.event.action.value.choice='yes']
 for(const change of corrupt){const f=await fixture(),event=f.body();change(event);assert.equal((await f.dispatch(event)).toast.type,'error');await zero(f);assert.match((await f.dispatch(f.body())).toast.content,/已取消/);await zero(f)}
 // Identity outranks the name gate: an unauthorized caller never learns input validity.
 for(const name of ['submit','']){const f=await fixture(),event=f.body('cancel',{name});event.event.operator.open_id='foreign';assert.match((await f.dispatch(event)).toast.content,/not_authorized/);await zero(f)}
 const app=await fixture(),badApp=app.body();badApp.header.app_id='foreign';assert.equal((await app.host.callback(badApp,'app',()=>true)).toast.type,'error');await zero(app)
 const expired=await fixture();expired.setTime(expired.now()+5001);assert.match((await expired.dispatch(expired.body())).toast.content,/expired/);await zero(expired)
 const stale=await fixture();stale.state.binding={...stale.state.binding,generation:2};assert.equal((await stale.dispatch(stale.body())).toast.type,'error');await zero(stale)
 const retired=await fixture();retired.host.retire(retired.state.binding.agent);assert.equal((await retired.dispatch(retired.body())).toast.type,'error');await zero(retired)
 const oldTransport=await fixture();oldTransport.state.current=false;assert.equal((await oldTransport.dispatch(oldTransport.body())).toast.type,'error');await zero(oldTransport)
 for(const action of ['submit','choice']){
  const f=await fixture(),missing=f.body(action);delete missing.event.action.name;assert.match((await f.dispatch(missing)).toast.content,/invalid_input/)
  for(const form of [{},{answer:''},{answer:'not-allowed'},{answer:'one',extra:secret},null,[],secret])assert.equal((await f.dispatch(f.body(action,{form}))).toast.type,'error')
  assert.equal((await f.dispatch(f.body(action))).toast.type,'info');for(let i=0;!f.state.admissions.length&&i<50;i++)await tick();assert.equal(f.state.admissions.length,1);assert.equal(JSON.parse(f.state.admissions[0]).action,action)
 }
 assert.deepEqual(cardInput(dto,'cancel',undefined,undefined),{action:'cancel'});assert.equal(cardInput(dto,'cancel',undefined,{answer:secret}),null)
 for(const f of await fs.readdir(home,{recursive:true})){if(f.endsWith('.jsonl'))assert.ok(!(await fs.readFile(path.join(home,f),'utf8')).includes(secret),'cancel values must not be persisted')}
 console.log('messaging-card-cancel: ok | real SDK optional outside-form name; cancel/replay/late-submit; strict form/name/auth/state negatives; submit+choice retained; no cancelled admission/provider IO/plaintext')
}finally{await Promise.all(hosts.map(h=>h.close()));await fs.rm(home,{recursive:true,force:true})}
