import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createInteractionReceipts, interactionBucket, INTERACTION_RETENTION_MS, platformCreateTime } from './messaging-interaction-receipts.js'
export const INTERACTION_EVENTS = Object.freeze(['im.message.recalled_v1', 'im.message.reaction.created_v1', 'im.message.reaction.deleted_v1', 'im.message.message_read_v1'])
export const interactionIdentityHash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const hash = interactionIdentityHash, hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
const fail = () => { throw new Error('interaction event unavailable') }
// Only hashes, fixed enums, emoji and platform times are durable. No body, user
// id, chat id, message id or token is persisted. No agent/Tools/network consumer.
export function createInteractionEvents(root, { now = Date.now, capacity = 2000 } = {}) {
  const pool = createInteractionReceipts(root, { now, sendCapacity: capacity })
  let chain = Promise.resolve(), stopped = false, queued = 0
  const serial = fn => {
    if (queued >= 2000) return Promise.reject(new Error('interaction event unavailable'))
    queued++
    const next = chain.then(fn).finally(() => { queued-- }); chain = next.catch(() => {}); return next
  }
  const filename = time => join(root, interactionBucket(time), 'interaction-events.jsonl')
  function valid(f) {
    return f && hex(f.id) && hex(f.identity) && ['recall', 'reaction.add', 'reaction.remove', 'read'].includes(f.kind)
      && Number.isSafeInteger(f.at) && Array.isArray(f.targets) && f.targets.length <= 100 && f.targets.every(hex)
      && (f.operator === null || hex(f.operator)) && (f.emoji === null || /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f.emoji))
  }
  async function read(time) {
    let text
    try {
      const directory = await fs.lstat(join(root, interactionBucket(time)))
      if (!directory.isDirectory() || directory.isSymbolicLink()) fail()
      const h = await fs.open(filename(time), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { const stat = await h.stat(); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) fail(); text = await h.readFile('utf8') } finally { await h.close() }
    } catch (e) { if (e.code === 'ENOENT') return new Map(); throw e }
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) fail()
    const facts = new Map()
    for (const line of text.split('\n').filter(Boolean)) { const f = JSON.parse(line); if (!valid(f)) fail(); facts.set(f.id, f) }
    if (facts.size > capacity) fail()
    return facts
  }
  return {
    accept(fact, isCurrent) {
      return serial(async () => {
        if (stopped || !isCurrent() || !valid(fact) || platformCreateTime(fact.at, now()) === null || now() - fact.at > INTERACTION_RETENTION_MS) fail()
        const pin = await pool.acquire(fact.at)
        try {
          const facts = await read(fact.at), digest = hash({ ...fact, targets: [] })
          const existing = facts.get(fact.id)
          if (existing && hash({ ...existing, targets: [] }) !== digest) fail()
          // Independent namespace/root: never claim the original incoming id.
          const begun = await pin.store.begin({ uuid: fact.id, digest, now: now() })
          if (begun.outcome === 'conflict' || !isCurrent()) fail()
          if (!existing) {
            if (facts.size >= capacity) fail()
            const h = await fs.open(filename(fact.at), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
            try { if (!(await h.stat()).isFile()) fail(); await h.writeFile(JSON.stringify(fact) + '\n'); await h.sync() } finally { await h.close() }
            const d = await fs.open(join(root, interactionBucket(fact.at)), 'r')
            try { await d.sync() } finally { await d.close() }
          }
          // A crash between begin and fact append can be taken over safely: the
          // immutable fact itself is durable before ACK, with no external action.
          // Unknown old owners are NOT finished with a fabricated owner token.
          if (begun.outcome === 'acquired') {
            const fin = await pin.store.finish({ uuid: fact.id, ownerToken: begun.record.ownerToken, state: 'sent', messageId: fact.id })
            if (fin?.state !== 'sent') fail()
          }
          if (!isCurrent()) fail()
          return { duplicate: Boolean(existing), targets: existing ? existing.targets : fact.targets }
        } finally { await pin.release() }
      })
    },
    snapshot(targetHash) {
      return serial(async () => {
        if (stopped || !hex(targetHash)) fail()
        let recalled = false, lastReadAt = null, readers = new Set(), reactions = new Map(), events = 0
        const times = []
        for (let i = 8; i >= -1; i--) times.push(now() - i * 86400000)
        const days = new Set()
        for (const time of times) {
          const day = interactionBucket(time); if (days.has(day)) continue; days.add(day)
          for (const f of (await read(time)).values()) {
            if (!f.targets.includes(targetHash) || now() - f.at > INTERACTION_RETENTION_MS) continue
            events++
            if (f.kind === 'recall') recalled = true
            if (f.kind === 'read' && f.operator) { readers.add(f.operator); lastReadAt = Math.max(lastReadAt || 0, f.at) }
            if (f.kind.startsWith('reaction.') && f.operator && f.emoji) {
              const k = f.operator + '/' + f.emoji, prior = reactions.get(k)
              if (!prior || f.at > prior.at || (f.at === prior.at && f.kind === 'reaction.remove')) reactions.set(k, { at: f.at, emoji: f.emoji, present: f.kind === 'reaction.add' })
            }
          }
        }
        const counts = Object.create(null)
        for (const r of reactions.values()) if (r.present) counts[r.emoji] = (counts[r.emoji] || 0) + 1
        return { recalled, observedReaders: readers.size, lastReadAt, reactions: counts, observedEvents: events, source: 'events', complete: false, partial: true, unread: 'unknown' }
      })
    },
    async close() { stopped = true; await chain; await pool.close() },
  }
}
