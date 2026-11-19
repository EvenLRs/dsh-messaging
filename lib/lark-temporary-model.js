// Single lease writer. Persist intent before changing the session model; fail closed.
import { createHash } from 'node:crypto'
import { mkdirSync, lstatSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const hash = x => createHash('sha256').update(String(x)).digest('hex')
const modelBusy = () => Object.assign(Error('temporary_model_busy'), { code: 'temporary_model_busy' })
const selection = x => x && typeof x.provider === 'string' && x.provider && typeof x.model === 'string' && x.model
export function createTemporaryModels(root, flush, onRestored = () => {}) {
  const seen = new WeakSet(), active = new Map(), restoring = new Map()
  const file = sid => join(root, hash(sid) + '.json')
  function load(sid) {
    try {
      if (!lstatSync(file(sid)).isFile()) throw Error()
      const row = JSON.parse(readFileSync(file(sid), 'utf8'))
      if (row.version !== 1 || !selection(row.before) || !selection(row.temporary) || !/^[a-f0-9]{64}$/.test(row.trigger)) throw Error()
      return row
    } catch (e) { if (e.code === 'ENOENT') return null; throw Error('temporary_model_store_invalid') }
  }
  function syncDir() { const fd = openSync(root,'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
  function save(sid,row) {
    mkdirSync(root,{recursive:true,mode:0o700})
    const tmp = file(sid)+'.tmp-'+process.pid
    try {
      writeFileSync(tmp,JSON.stringify(row),{flag:'wx',mode:0o600})
      const fd=openSync(tmp,'r');try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp,file(sid));syncDir()
    } finally { if(existsSync(tmp)) unlinkSync(tmp) }
  }
  function clear(sid) {
    if (load(sid)) { unlinkSync(file(sid)); syncDir() }
    if (active.delete(sid)) onRestored(sid)
  }
  async function restore(agent) {
    const sid=agent.session.id,row=load(sid)
    if (!row) return
    agent.model.select(row.before)
    if (await flush(agent) !== true) throw Error('temporary_model_flush_failed')
    clear(sid)
  }
  return {
    isActive(sid) { return active.has(sid) },
    pending(sid) { return load(sid)?.temporary || null },
    async recover(agent) {
      if (seen.has(agent)) return
      if (load(agent.session.id) && agent.status !== 'idle') throw modelBusy()
      await restore(agent); seen.add(agent)
    },
    async switch(agent, target, mode, trigger) {
      const sid=agent.session.id
      await restoring.get(sid)
      const old=load(sid)
      if (mode === 't') {
        save(sid,{version:1,before:old?.before || agent.model.current(),temporary:target,trigger:hash(trigger)})
        if (active.delete(sid)) onRestored(sid)
      } else {
        // Restore first so a failed permanent write cannot strand the temporary model.
        await restore(agent)
        agent.model.select(target)
      }
    },
    async begin(agent) {
      await restoring.get(agent.session.id)
      const row=load(agent.session.id)
      if (!row) return
      if (active.has(agent.session.id)) throw modelBusy()
      active.set(agent.session.id,agent)
      try {
        agent.model.select(row.temporary)
        if (await flush(agent) !== true) throw Error('temporary_model_flush_failed')
      } catch { await restore(agent); throw Error('temporary_model_flush_failed') }
      return true
    },
    async end(sid) {
      if (restoring.has(sid)) return restoring.get(sid)
      const agent=active.get(sid)
      if (!agent) return
      // Session append listeners cannot append reentrantly. Leave the event dispatch first.
      const pending=new Promise(resolve => setImmediate(resolve)).then(() => restore(agent)); restoring.set(sid,pending)
      try { await pending } finally { restoring.delete(sid) }
    },
    async reset(agent, sid) { await restoring.get(sid); if (agent) await restore(agent); else clear(sid) },
  }
}
