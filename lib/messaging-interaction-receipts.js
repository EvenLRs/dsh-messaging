import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { openLarkDedupStore } from './lark-dedup.js'

export const INTERACTION_RETENTION_MS = 7 * 86400000 // plugin policy, not a Feishu reply limit
export function platformCreateTime(value, now = Date.now()) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d{13}$/.test(value)))) return null
  const time = Number(value)
  return Number.isSafeInteger(time) && time >= Date.UTC(2020, 0, 1) && time <= now + 300000 ? time : null
}
export const interactionBucket = time => new Date(time).toISOString().slice(0, 10).replaceAll('-', '')
const error = code => Object.assign(new Error(code), { code })
const noteCodes = new Set(['cancelled', 'stale_generation', 'timeout', 'unavailable', 'invalid_arguments', 'target_expired', 'permission_denied', 'access_denied', 'not_found_or_recalled', 'unsupported_context', 'platform_rejected', 'not_owned', 'conflict', 'expired', 'unsupported_message_type', 'capacity_exhausted', 'operation_inflight'])

// Daily target-time buckets, no GC. At most maxOpen roots are open; an acquired
// pin spans begin -> external request -> annotation/finish, including exceptions.
// LRU closes only idle buckets. close() drains all pins before releasing flock.
export function createInteractionReceipts(root, options = {}) {
  const { maxOpen = 3, now = Date.now, ...storeOptions } = options
  const entries = new Map()
  let serial = Promise.resolve(), closing = false, closePromise, drained
  const lock = fn => {
    const next = serial.then(fn)
    serial = next.catch(() => {})
    return next
  }
  async function acquire(createTime) {
    if (platformCreateTime(createTime, now()) === null || now() - createTime > INTERACTION_RETENTION_MS) throw error('target_expired')
    const day = interactionBucket(createTime)
    const entry = await lock(async () => {
      if (closing) throw error('closed')
      // An unbucketed A prototype must never silently get a new idempotency root.
      try { await fs.lstat(join(root, 'journal.jsonl')); throw error('legacy_receipts') } catch (e) { if (e.code !== 'ENOENT') throw e }
      let held = entries.get(day)
      if (!held) {
        if (entries.size >= maxOpen) {
          const idle = [...entries.values()].filter(x => !x.pins).sort((a, b) => a.used - b.used)[0]
          if (!idle) throw error('bucket_busy')
          await idle.lease.close(); entries.delete(idle.day)
        }
        const dir = join(root, day)
        // Do not follow a pre-existing bucket symlink into another root.
        try { if ((await fs.lstat(dir)).isSymbolicLink()) throw error('unsafe_bucket') } catch (e) { if (e.code !== 'ENOENT') throw e }
        const lease = await openLarkDedupStore(dir, { sendCapacity: 2000, ...storeOptions })
        const notes = new Map(), noteFile = join(dir, 'interaction-rejections.jsonl')
        try {
          let text = ''
          try { text = await fs.readFile(noteFile, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
          if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw error('bad_annotations')
          for (const line of text.split('\n').filter(Boolean)) {
            const n = JSON.parse(line)
            if (!/^[a-f0-9]{64}$/.test(n.uuid) || typeof n.dispatched !== 'boolean' || !noteCodes.has(n.code)) throw error('bad_annotations')
            notes.set(n.uuid, { dispatched: n.dispatched, code: n.code })
          }
          if (notes.size > (storeOptions.sendCapacity || 2000)) throw error('bad_annotations')
        } catch (e) { await lease.close(); throw e }
        held = { day, lease, notes, noteFile, pins: 0, used: 0, noteSerial: Promise.resolve() }
        entries.set(day, held)
      }
      held.pins++; held.used = now()
      return held
    })
    let released = false
    return {
      store: entry.lease.sendReceipts,
      async note(uuid) {
        if (entry.notes.has(uuid)) return entry.notes.get(uuid)
        // Another in-process lease may have finished after this pool opened.
        // The kernel shares its store but each wrapper owns its annotation cache.
        let text
        try { text = await fs.readFile(entry.noteFile, 'utf8') } catch (e) { if (e.code === 'ENOENT') return; throw e }
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw error('bad_annotations')
        for (const line of text.split('\n').filter(Boolean)) {
          const n = JSON.parse(line)
          if (!/^[a-f0-9]{64}$/.test(n.uuid) || typeof n.dispatched !== 'boolean' || !noteCodes.has(n.code)) throw error('bad_annotations')
          if (n.uuid === uuid) { entry.notes.set(uuid, { dispatched: n.dispatched, code: n.code }); return entry.notes.get(uuid) }
        }
      },
      async annotate(uuid, value) {
        const write = entry.noteSerial.then(async () => {
          if (entry.notes.has(uuid)) return
          if (!/^[a-f0-9]{64}$/.test(uuid) || !noteCodes.has(value.code) || typeof value.dispatched !== 'boolean') throw error('bad_annotations')
          const h = await fs.open(entry.noteFile, 'a', 0o600)
          try { await h.writeFile(JSON.stringify({ uuid, ...value }) + '\n'); await h.sync() } finally { await h.close() }
          // The parent directory already exists durably via the kernel; persist
          // the first sidecar dir entry too before reporting a replayable class.
          const dir = await fs.open(join(root, day), 'r')
          try { await dir.sync() } finally { await dir.close() }
          entry.notes.set(uuid, { ...value })
        })
        entry.noteSerial = write.catch(() => {})
        return write
      },
      async release() {
        if (released) return
        released = true
        await lock(() => {
          entry.pins--
          if (closing && [...entries.values()].every(x => !x.pins)) drained?.()
        })
      },
    }
  }
  return {
    acquire,
    close() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        let wait
        await lock(() => {
          closing = true
          if ([...entries.values()].some(x => x.pins)) wait = new Promise(resolve => { drained = resolve })
        })
        if (wait) await wait
        await lock(async () => { for (const entry of entries.values()) await entry.lease.close(); entries.clear() })
      })()
      return closePromise
    },
  }
}
