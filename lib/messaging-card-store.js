import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInteractionReceipts, interactionBucket } from './messaging-interaction-receipts.js'
const shared = new Map(), hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)
const phases = ['publishing','active','updating','unknown','accepted','paused','input_admitted','cancelled','needs_resubmission','expired','invalidated']
const allowed = ['id','created','bucket','expires','version','phase','binding','operator','appTenant','origin','message','nonce','umid','digest','action','seq']
const fail=()=>{throw new Error('card store unavailable')}
function valid(row) {
  return row && Object.keys(row).every(k=>allowed.includes(k)) && ['id','binding','operator','appTenant','origin','nonce'].every(k=>hex(row[k]))
    && (row.message===null||hex(row.message)) && Number.isSafeInteger(row.bucket) && Number.isSafeInteger(row.created) && Number.isSafeInteger(row.expires) && row.expires>=row.created && row.expires-row.created<=600000
    && Number.isInteger(row.version)&&row.version>=1&&row.version<=20&&phases.includes(row.phase)
    && (row.umid===undefined||/^lark-[a-f0-9]{8}-\d{1,16}-[a-f0-9]{16}$/.test(row.umid))
    && (row.digest===undefined||hex(row.digest)) && (row.action===undefined||['submit','choice','cancel'].includes(row.action))
    && (row.seq===undefined||Number.isSafeInteger(row.seq))
}
// Separate root and receipt domains. Only bounded metadata/hash records, never
// freeform inputs, callback tokens, arbitrary user/chat ids or card body copies.
export function createMessagingCardStore(root,{now=Date.now,capacity=2000}={}) {
  root=resolve(root)
  let gate=shared.get(root);if(!gate){gate={chain:Promise.resolve(),refs:0,queued:0};shared.set(root,gate)}gate.refs++
  const pool=createInteractionReceipts(root,{now,sendCapacity:capacity})
  let stopped=false
  function serial(fn){if(stopped||gate.queued>=2000)return Promise.reject(new Error('card store unavailable'));gate.queued++
    const p=gate.chain.then(fn).finally(()=>gate.queued--);gate.chain=p.catch(()=>{});return p}
  async function read(time){
    const dir=join(root,interactionBucket(time)),file=join(dir,'workflows.jsonl');let lines=[],bytes=0
    try{const d=await fs.lstat(dir);if(!d.isDirectory()||d.isSymbolicLink())fail()
      const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
      try{const stat=await h.stat();if(!stat.isFile()||stat.size>32*1024*1024)fail();bytes=stat.size;lines=(await h.readFile('utf8')).split('\n').filter(Boolean)}finally{await h.close()}
    }catch(e){if(e.code!=='ENOENT')throw e}
    if(lines.length>50000)fail()
    const rows=new Map();for(const line of lines){const r=JSON.parse(line);if(!valid(r))fail();rows.set(r.id,r)}
    if(rows.size>capacity)fail();return{rows,lines:lines.length,bytes,dir,file}
  }
  return {
    pin(time){if(stopped)return Promise.reject(new Error('card store unavailable'));return pool.acquire(time)},
    with(time,fn,held){return serial(async()=>{const pin=held||await pool.acquire(time)
      try{const data=await read(time)
        return await fn({store:pin.store,note:pin.note,annotate:pin.annotate,get:id=>data.rows.get(id),ordinal:()=>data.lines+1,
          async put(row){const encoded=JSON.stringify(row)+'\n';if(!valid(row)||data.lines>=50000||data.bytes+Buffer.byteLength(encoded)>32*1024*1024||(!data.rows.has(row.id)&&data.rows.size>=capacity))fail()
            const h=await fs.open(data.file,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600)
            try{if(!(await h.stat()).isFile())fail();await h.writeFile(encoded);await h.sync()}finally{await h.close()}
            const d=await fs.open(data.dir,'r');try{await d.sync()}finally{await d.close()}
            data.rows.set(row.id,{...row});data.lines++;data.bytes+=Buffer.byteLength(encoded)
          }})
      }finally{if(!held)await pin.release()}})},
    // Callback only carries an opaque ref; scan at most ten target-date buckets. Workflows
    // expire after ten minutes. Read-only lookup never creates an unknown bucket.
    find(id){return serial(async()=>{for(const t of Array.from({length:10},(_,i)=>now()-(i-1)*86400000)){const r=(await read(t)).rows.get(id);if(r)return r}return null})},
    async close(){stopped=true;await gate.chain;await pool.close();if(!--gate.refs&&shared.get(root)===gate)shared.delete(root)},
  }
}
