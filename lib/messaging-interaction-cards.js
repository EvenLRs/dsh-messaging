import { randomBytes } from 'node:crypto'
import { larkDedupUserMessageId } from './lark-dedup.js'
import { platformCreateTime, INTERACTION_RETENTION_MS } from './messaging-interaction-receipts.js'
import { validateCardDto, renderInteractionCard, cardInput } from './messaging-card-dto.js'
export const CARD_CALLBACK = 'card.action.trigger'
export const cardToast = (code='accepted') => ({toast:{type:['accepted','cancelled'].includes(code)?'info':'error',content:code==='accepted'?'已收到，后台处理中；不代表已执行。':code==='cancelled'?'已取消。':code==='needs_resubmission'?'需要重新确认；请先检查原输入是否已处理，不会自动重放。（needs_resubmission）':code==='paused'?'处理状态待确认，后台重试已暂停；请勿重复提交。（paused）':'未处理：'+code}})
const object=x=>x&&typeof x==='object'&&!Array.isArray(x)
const short=x=>typeof x==='string'&&x.length>0&&x.length<=512
const workflow=x=>typeof x==='string'&&/^workflow_[a-f0-9]{40}$/.test(x)
const keys=(o,allow)=>object(o)&&Object.keys(o).every(k=>allow.includes(k))
export function createMessagingCards(h) {
  const {binding,live,resolve,provider,store,bounded,extensions,observed,remember,issue,lookup,hash,now,preflight,rejected,unknown,admit}=h
  const entries=new Map(),jobs=new Map(),identities=new WeakMap(),workers=new Set()
  let stopped=false
  function bindingKey(b){let x=identities.get(b.agent);if(!x||!h.same(x.binding,b)){x={binding:b,key:hash(randomBytes(32).toString('hex'))};identities.set(b.agent,x)}return x.key}
  const valid=e=>!stopped&&live(e.binding)&&now()<e.row.expires&&e.row.phase!=='invalidated'&&!e.messageItem?.invalidated&&!e.originItem?.invalidated
  const callbackHash=(e,operator)=>hash(['card/operator/v1',e.binding.appId,operator.tenant_key,operator.open_id])
  async function save(e,phase,extra={},pin){const row={...e.row,...extra,phase};await store.with(row.bucket,async tx=>{const prior=tx.get(row.id);if(prior&&prior.version!==row.version)throw new Error('card state conflict');await tx.put(row)},pin);e.row=row}
  function prune(){for(const [ref,e]of entries)if(now()>=e.row.expires&&!jobs.has(e.row.id))entries.delete(ref)}
  function schedule(e,input,pin,ownerToken,uuid){
    const job={e,input,pin,ownerToken,uuid,attempt:0,timer:null,running:false,stopped:false};jobs.set(e.row.id,job)
    const run=async()=>{
      if(job.stopped||stopped||!valid(e)){jobs.delete(e.row.id);await pin.release();return}
      job.running=true;let timer
      try{
        if(e.originItem)await observed(e.binding,e.originItem)
        if(e.messageItem)await observed(e.binding,e.messageItem)
        if(!valid(e)||job.stopped)return
        const result=await Promise.race([Promise.resolve().then(()=>admit(e.binding,e.row.umid,job.input)),new Promise(r=>{timer=setTimeout(()=>r({state:'retry'}),h.admissionTimeoutMs??5000)})])
        if(!valid(e)||job.stopped)return
        if(result?.state==='input_admitted'){
          await save(e,'input_admitted',{},pin)
          // The durable host admission + workflow metadata are authoritative.
          // A receipt finish failure cannot turn a proved input into a request
          // to submit it again, nor may a recovery fabricate an old owner token.
          if(ownerToken)try{await pin.store.finish({uuid,ownerToken,state:'sent',messageId:e.row.umid})}catch{/* retained pending receipt, no replay of input */}
          job.input=null;return
        }
        if(result?.state==='needs_resubmission'){await save(e,'needs_resubmission',{},pin);job.input=null;return}
        job.attempt++
        if(job.attempt>=5){await save(e,'paused',{},pin);job.input=null;return}
        job.timer=setTimeout(()=>launch(job),Math.min(8000,(h.retryDelayMs??1000)*2**(job.attempt-1)));job.timer.unref?.()
      }catch{if(valid(e)){try{await save(e,'paused',{},pin)}catch{/* durable original accepted remains fail-closed */}}job.input=null}
      finally{clearTimeout(timer);job.running=false;if(!job.timer||job.stopped||!valid(e)){jobs.delete(e.row.id);await pin.release()}}
    }
    job.run=run
    setImmediate(()=>launch(job))
  }
  function launch(job){if(jobs.get(job.e.row.id)!==job)return;job.timer=null;const p=job.run();workers.add(p);p.finally(()=>workers.delete(p)).catch(()=>{})}
  async function route(operation,agent,args,signal,guard){
    const found=binding(agent),b=found&&{...found,guard};if(!b||!live(b)||stopped)return preflight('not_bound')
    if(operation==='card.status'){
      if(!keys(args,['workflow'])||!workflow(args.workflow))return preflight('invalid_arguments')
      const e=entries.get(args.workflow);if(!e||!h.same(e.binding,b)||!live(e.binding))return preflight('workflow_unverified')
      if(e.messageItem){try{if(e.originItem)await observed(e.binding,e.originItem);await observed(e.binding,e.messageItem)}catch{return preflight('unavailable')}if(!live(e.binding))return preflight('stale_generation');if((e.messageItem.invalidated||e.originItem?.invalidated)&&e.row.phase!=='invalidated')try{await save(e,'invalidated')}catch{return preflight('receipt_unavailable')}}
      if(now()>=e.row.expires)return {ok:true,status:'succeeded',phase:'expired',version:e.row.version,remoteApproval:'host_principal_mapping_unverified'}
      return {ok:true,status:'succeeded',phase:e.row.phase,version:e.row.version,remoteApproval:'host_principal_mapping_unverified'}
    }
    const publish=operation==='card.publish'
    if(!keys(args,publish?['operation_id','target','card','ttl_seconds']:['operation_id','workflow','expected_version','card'])||!short(args.operation_id)||!validateCardDto(args.card)
      ||(publish&&args.ttl_seconds!==undefined&&(!Number.isInteger(args.ttl_seconds)||args.ttl_seconds<5||args.ttl_seconds>600)))return preflight('invalid_arguments')
    let e,item,ref
    if(publish){
      if(args.target!==undefined&&!short(args.target))return preflight('invalid_arguments')
      const selected=resolve(b,args.target);if(!selected.item)return preflight(selected.error);item=selected.item
      if(!item.originatorHash||!item.appTenantHash||item.botAuthored)return preflight('originator_unverified')
      if(item.createTime===null||item.timeConflict)return preflight('target_unverified')
      if(now()-item.createTime>INTERACTION_RETENTION_MS)return preflight('target_expired')
      ref='workflow_'+hash(['cards/publish/ref/v1',b.appId,b.chatId,b.sessionId,item.messageId,args.operation_id]).slice(0,40)
    }else{
      if(!workflow(args.workflow)||!Number.isInteger(args.expected_version))return preflight('invalid_arguments')
      ref=args.workflow;e=entries.get(ref)
      if(!e||!h.same(e.binding,b)||!live(e.binding))return preflight('workflow_unverified')
      item=e.messageItem
      if(!item)return preflight('workflow_unverified')
    }
    return extensions.serializeTarget(b,item,async()=>{
      if(!live(b)||stopped||signal?.aborted)return preflight(signal?.aborted?'cancelled':'stale_generation')
      if(extensions.targetBlocked(b,item))return preflight('operation_inflight')
      try{await observed(b,item);if(e?.originItem&&e.originItem!==item)await observed(b,e.originItem)}catch{return preflight('unavailable')}
      if(item.invalidated||e?.originItem?.invalidated)return preflight('not_found_or_recalled')
      const uuid=hash(['cards/write/v1',operation,b.appId,b.chatId,b.sessionId,item.messageId,args.operation_id])
      const digest=hash([operation,args.card,publish?(args.ttl_seconds??600):args.expected_version])
      const created=publish?now():e.row.created, bucket=publish?item.createTime:e.row.bucket
      let pin,begun,pending,row,prepared,acceptedWrite=false
      try{
        pin=await store.pin(bucket)
        const prior=pin.store.get(uuid)
        if(!prior){
          prune();if(publish&&entries.size>=2000)return preflight('capacity_exhausted')
          if(!publish&&(!valid(e)||e.row.phase!=='active'||jobs.has(e.row.id)||e.row.version!==args.expected_version||e.row.version>=20))return preflight('conflict')
          const old=await store.with(bucket,tx=>tx.get(hash(ref)),pin)
          if(publish&&old)return preflight('workflow_unverified')
          row=publish?{id:hash(ref),created,bucket,expires:Math.min(created+(args.ttl_seconds??600)*1000,item.createTime+INTERACTION_RETENTION_MS),version:1,phase:'publishing',binding:bindingKey(b),operator:item.originatorHash,appTenant:item.appTenantHash,origin:hash([b.appId,b.chatId,item.messageId]),message:null,nonce:hash(randomBytes(32).toString('hex'))}:{...e.row,version:e.row.version+1,phase:'updating',nonce:hash(randomBytes(32).toString('hex'))}
          if(!publish)for(const key of ['umid','digest','action','seq'])delete row[key]
          const nonce=randomBytes(32).toString('hex');row.nonce=hash(nonce)
          const rendered=renderInteractionCard(args.card,{ref,nonce,version:row.version})
          const checked=provider.validateCard(b,item,publish,rendered,uuid.slice(0,50));if(!checked.ok)return preflight(checked.code)
          prepared=await bounded(b,signal,call=>provider.prepareCard(b,item,publish,rendered,uuid.slice(0,50),call))
          if(!prepared.ok)return preflight(prepared.code||'unavailable')
          if(!live(b)||signal?.aborted)return preflight(signal?.aborted?'cancelled':'stale_generation')
          begun=await store.with(bucket,async tx=>{
            const current=tx.get(row.id)
            if(!publish&&(current?.version!==args.expected_version||current?.phase!=='active'||jobs.has(row.id)))return {outcome:'workflow_conflict'}
            const acquired=await pin.store.begin({uuid,digest,now:now()})
            if(acquired.outcome==='acquired'){
              if(!short(acquired.record?.ownerToken))throw new Error('card unavailable')
              await tx.put(row)
            }
            return acquired
          },pin)
          if(begun.outcome==='workflow_conflict')return preflight('conflict')
          if(begun.outcome==='acquired'){
            // Publish/update state becomes non-actionable durably before wire.
            if(publish){e={ref,binding:b,row,originItem:item,dto:structuredClone(args.card),nonce,messageItem:null};entries.set(ref,e)}else{e.row=row;e.nonce=nonce;e.dto=structuredClone(args.card)}
            acceptedWrite=true
            const result=await bounded(b,signal,call=>{call.check();if(item.invalidated)throw Object.assign(new Error('unavailable'),{code:'not_found_or_recalled'});pending=provider.cardWrite(b,item,publish,call,prepared);return pending})
            const state=result.ok&&live(b)?'sent':result.unknown||result.ok?'unknown':'rejected'
            if(state==='rejected')await pin.annotate(uuid,{code:result.code||'platform_rejected',dispatched:result.dispatched})
            if(state==='sent'){
              const messageId=publish?result.messageId:item.messageId
              if(publish){remember({appId:b.appId,chatId:b.chatId,messageId,createTime:result.createTime,botAuthored:true,messageType:'workflow_card',updateMulti:true,chatType:item.chatType});e.messageItem=lookup(b.appId,b.chatId,messageId)}
              row={...row,message:hash([b.appId,b.chatId,messageId])}
            }else await save(e,state==='unknown'?'unknown':'invalidated',{},pin)
            const fin=await pin.store.finish({uuid,ownerToken:begun.record.ownerToken,state,...(state==='sent'?{messageId:publish?result.messageId:item.messageId}:{reason:state==='unknown'?'interrupted':'platform_error'})})
            if(fin?.state!==state)throw new Error('card receipt unavailable')
            if(state==='sent')await save(e,'active',{message:row.message},pin)
            if(state==='unknown'||!live(b))return unknown('delivery_unknown')
            if(state==='rejected')return rejected(result.code||'platform_rejected',result.dispatched)
            return {ok:true,status:'succeeded',dispatched:true,replayed:false,workflowRef:ref,version:row.version,...(e.messageItem?{messageRef:issue(b,e.messageItem)}:{})}
          }
        }else begun=await pin.store.begin({uuid,digest,now:now()})
        if(begun.outcome==='conflict')return preflight('conflict')
        if(begun.outcome==='sent')return {ok:true,status:'succeeded',dispatched:false,replayed:true,workflowRef:ref}
        if(begun.outcome==='rejected'){const note=await pin.note(uuid);return note?rejected(note.code,note.dispatched):unknown('receipt_unavailable')}
        return unknown('delivery_unknown')
      }catch(error){if(acceptedWrite&&e){e.row={...e.row,phase:'unknown'};try{await save(e,'unknown',{},pin)}catch{/* unknown cannot become active */}}return begun?unknown('receipt_unavailable'):preflight(error?.code==='at_capacity'?'capacity_exhausted':error?.code==='bucket_busy'?'bucket_busy':error?.code==='target_expired'?'target_expired':'receipt_unavailable')}
      finally{await extensions.drain(pending,b,item);if(pin)await pin.release()}
    })
  }
  async function callback(envelope,appId,isCurrent){
    let active=true,timer
    const current=()=>active&&!stopped&&isCurrent()
    const work=async()=>{
      const head=envelope?.header,body=envelope?.event,action=body?.action,value=action?.value
      if(envelope?.schema!=='2.0'||head?.event_type!==CARD_CALLBACK)return cardToast('legacy_callback_unsupported')
      if(!current()||head.app_id!==appId||!short(head.event_id)||!object(body?.operator)||!short(body.operator.open_id)||!short(body.operator.tenant_key)||!short(head.tenant_key)
        ||!keys(value,['workflow','version','nonce','action','choice'])||!workflow(value.workflow)||!Number.isInteger(value.version)||typeof value.nonce!=='string'||!/^[a-f0-9]{64}$/.test(value.nonce)||action.tag!=='button')return cardToast('not_authorized')
      const e=entries.get(value.workflow),id=hash(value.workflow)
      if(!e){
        const old=await store.find(id)
        if(!current())throw new Error('card callback unavailable')
        if(!old)return cardToast('workflow_unverified')
        if(old.operator!==hash(['card/operator/v1',appId,body.operator.tenant_key,body.operator.open_id])||old.appTenant!==hash(head.tenant_key)
          ||old.message!==hash([appId,body.context?.open_chat_id,body.context?.open_message_id])||old.version!==value.version||old.nonce!==hash(value.nonce))return cardToast('not_authorized')
        if(old.phase==='accepted')await store.with(old.bucket,async tx=>{const row=tx.get(id);if(current()&&row?.phase==='accepted')await tx.put({...row,phase:'needs_resubmission'})})
        return cardToast('needs_resubmission')
      }
      if(!valid(e)||!current())return cardToast((e.messageItem?.invalidated||e.originItem?.invalidated)?'not_found_or_recalled':now()>=e.row.expires?'expired':'stale_generation')
      if(e.binding.appId!==appId||body.context?.open_chat_id!==e.binding.chatId||body.context?.open_message_id!==e.messageItem?.messageId
        ||hash(head.tenant_key)!==e.row.appTenant||callbackHash(e,body.operator)!==e.row.operator||value.version!==e.row.version||hash(value.nonce)!==e.row.nonce)return cardToast('not_authorized')
      const expectedName=value.action==='choice'?'c_'+value.choice:value.action
      // Only cancel is rendered outside the form; the SDK permits its form-only
      // name to be absent. Explicit names and all submit/choice names stay exact.
      if(action.name!==expectedName&&!(value.action==='cancel'&&action.name===undefined))return cardToast('invalid_input')
      const input=cardInput(e.dto,value.action,value.choice,action.form_value);if(!input)return cardToast('invalid_input')
      if(e.originItem)await observed(e.binding,e.originItem)
      await observed(e.binding,e.messageItem)
      if(!current()||!live(e.binding))return cardToast('stale_generation')
      if(e.messageItem.invalidated||e.originItem?.invalidated){await save(e,'invalidated');return cardToast('not_found_or_recalled')}
      if(!valid(e))return cardToast('expired')
      const digest=hash(input),eventId=hash(['cards/event/v1',appId,head.event_id]),actionId=hash(['cards/action/v1',id,value.version])
      let pin,transferred=false
      try{
        pin=await store.pin(e.row.bucket)
        return await store.with(e.row.bucket,async tx=>{
          if(!current()||!valid(e))return cardToast('stale_generation')
          const row=tx.get(id);if(!row||row.version!==value.version||row.nonce!==hash(value.nonce))return cardToast('not_authorized')
          const event=await pin.store.begin({uuid:eventId,digest:hash([id,value.version,digest]),now:now()})
          if(!current()||!valid(e))throw new Error('card callback unavailable')
          if(event.outcome==='conflict')return cardToast('conflict')
          if(['accepted','paused','input_admitted','cancelled','needs_resubmission'].includes(row.phase)){
            if(row.digest!==digest)return cardToast('conflict')
            e.row=row
            if(event.outcome==='acquired'){
              if(!short(event.record?.ownerToken))throw new Error('card callback unavailable')
              const fin=await pin.store.finish({uuid:eventId,ownerToken:event.record.ownerToken,state:'sent',messageId:row.phase==='cancelled'?'cancelled':'accepted'})
              if(fin?.state!=='sent')throw new Error('card callback unavailable')
            }
            if(!current()||!valid(e))throw new Error('card callback unavailable')
            if(row.phase==='accepted'&&!jobs.has(id)){
              if(jobs.size>=100)throw new Error('card callback unavailable')
              // Payload-free recovery probes the real projection first. It can
              // flush an already admitted input; it must never invent values.
              schedule(e,undefined,pin,null,actionId);transferred=true
            }
            return cardToast(row.phase==='cancelled'?'cancelled':row.phase==='needs_resubmission'?'needs_resubmission':row.phase==='paused'?'paused':'accepted')
          }
          if(row.phase!=='active')return cardToast('workflow_unavailable')
          if(jobs.size>=100)throw new Error('card callback unavailable')
          const claimed=await pin.store.begin({uuid:actionId,digest,now:now()})
          if(!current()||!valid(e))throw new Error('card callback unavailable')
          if(claimed.outcome!=='acquired'){
            await tx.put({...row,phase:'needs_resubmission'});e.row={...row,phase:'needs_resubmission'};return cardToast('needs_resubmission')
          }
          if(!short(claimed.record?.ownerToken))throw new Error('card callback unavailable')
          const seq=Math.floor(now()/86400000)*1000000+tx.ordinal()
          const umid=larkDedupUserMessageId(hash(['cards/admission/v1',appId]).slice(0,8),seq,appId,id+'/'+value.version)
          const next={...row,phase:input.action==='cancel'?'cancelled':'accepted',umid,digest,action:input.action,seq}
          if(!current())throw new Error('card callback unavailable')
          await tx.put(next);e.row=next
          if(!current()||!valid(e))throw new Error('card callback unavailable')
          if(event.outcome==='acquired'){const fin=await pin.store.finish({uuid:eventId,ownerToken:event.record.ownerToken,state:'sent',messageId:input.action==='cancel'?'cancelled':'accepted'});if(fin?.state!=='sent')throw new Error('card callback unavailable')}
          if(input.action==='cancel'){
            const fin=await pin.store.finish({uuid:actionId,ownerToken:claimed.record.ownerToken,state:'sent',messageId:'cancelled'});if(fin?.state!=='sent')throw new Error('card callback unavailable')
            return cardToast('cancelled')
          }
          if(!current())throw new Error('card callback unavailable')
          schedule(e,JSON.stringify({workflowRef:e.ref,version:e.row.version,...input}),pin,claimed.record.ownerToken,actionId);transferred=true
          return cardToast('accepted')
        },pin)
      }finally{if(pin&&!transferred)await pin.release()}
    }
    try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(new Error('card callback unavailable'))},2500)})])}
    catch{throw new Error('card callback unavailable')}
    finally{active=false;clearTimeout(timer)}
  }
  function reset(){for(const job of jobs.values()){job.stopped=true;clearTimeout(job.timer);job.timer=null;if(!job.running){jobs.delete(job.e.row.id);void job.pin.release().catch(()=>{})}}entries.clear()}
  return {route,callback,reset,knownItems(){return [...entries.values()].filter(e=>valid(e)).flatMap(e=>[e.originItem,e.messageItem].filter(Boolean))},retire(agent){for(const e of entries.values())if(e.binding.agent===agent)e.row={...e.row,phase:'invalidated'}},async close(){stopped=true;reset();await Promise.allSettled([...workers]);await store.close()}}
}
