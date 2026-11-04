import { randomBytes } from 'node:crypto'
import { INTERACTION_RETENTION_MS } from './messaging-interaction-receipts.js'
export const B_OPERATIONS = Object.freeze(['message.edit', 'message.recall', 'reaction.add', 'reaction.remove', 'reaction.list', 'read.query', 'read.events'])
const short = x => typeof x === 'string' && x.length > 0 && x.length <= 512
const text = x => typeof x === 'string' && x.trim() && Buffer.byteLength(x) <= 12000 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(x)
const object = x => x && typeof x === 'object' && !Array.isArray(x)
const emoji = x => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(x)
const fields = {
  'message.edit': ['operation_id', 'target', 'text'], 'message.recall': ['operation_id', 'target'],
  'reaction.add': ['operation_id', 'target', 'emoji'], 'reaction.remove': ['operation_id', 'target', 'reaction_ref'],
  'reaction.list': ['target'], 'read.query': ['target'], 'read.events': ['target'],
}
export function createMessagingOperations(h) {
  const { binding, live, resolve, provider, receipts, bounded, observed, hash, now, preflight, rejected, unknown, same, timeoutMs = 35000 } = h
  const reactions = new Map(), queues = new Map(), outstanding = new Map()
  const targetKey = (b, item) => hash([b.appId, b.chatId, item.messageId])
  function reactionRef(b, item, reactionId, type) {
    for (const [ref, held] of reactions) if (!held.removed && same(held.binding, b) && held.item === item && held.reactionId === reactionId) return ref
    if (reactions.size >= 2000) reactions.delete(reactions.keys().next().value)
    const ref = 'reactionref_' + randomBytes(20).toString('hex')
    reactions.set(ref, { binding: b, item, reactionId, emoji: type, removed: false }); return ref
  }
  const readonly = code => ({ ...preflight(code), readOnly: true })
  function scopedCall(call, item) {
    const check = () => { call.check(); if (item.invalidated) throw Object.assign(new Error('target unavailable'), { code: 'not_found_or_recalled' }) }
    return { ...call, check, onDispatch() { check(); call.onDispatch() } }
  }
  async function drain(promise, b, item) {
    if (!promise) return
    let timer, settled = false
    const done = Promise.resolve(promise).then(() => { settled = true }, () => { settled = true })
    try { await Promise.race([done, new Promise(r => { timer = setTimeout(r, timeoutMs) })]) } finally { clearTimeout(timer) }
    if (!settled) {
      // A local timeout does not prove that the underlying request ended. Keep
      // this target closed to NEW writes until that exact old request settles.
      // Existing receipt replays still return their original unknown outcome.
      const key = targetKey(b, item), token = {}
      outstanding.set(key, token)
      done.then(() => { if (outstanding.get(key) === token) outstanding.delete(key) })
    }
  }
  function serialized(key, fn) {
    let q = queues.get(key)
    if (!q) { if (queues.size + outstanding.size >= 2000 && !outstanding.has(key)) return Promise.resolve(preflight('capacity_exhausted')); q = { tail: Promise.resolve(), count: 0 }; queues.set(key, q) }
    if (q.count >= 20) return Promise.resolve(preflight('capacity_exhausted'))
    q.count++
    const next = q.tail.then(fn)
    q.tail = next.catch(() => {}).finally(() => { q.count--; if (!q.count && queues.get(key) === q) queues.delete(key) })
    return next
  }
  async function route(operation, agent, args, signal, guard) {
    const found = binding(agent), b = found && { ...found, guard }
    if (!b || !live(b)) return preflight('not_bound')
    if (!object(args) || Object.keys(args).some(k => !fields[operation]?.includes(k)) || !short(args.target)) return preflight('invalid_arguments')
    const write = ['message.edit', 'message.recall', 'reaction.add', 'reaction.remove'].includes(operation)
    if (write && !short(args.operation_id)) return preflight('invalid_arguments')
    if (operation === 'message.edit' && !text(args.text)) return preflight('invalid_arguments')
    if (operation === 'reaction.add' && !emoji(args.emoji)) return preflight('invalid_arguments')
    if (operation === 'reaction.remove' && !short(args.reaction_ref)) return preflight('invalid_arguments')
    const selected = resolve(b, args.target)
    if (!selected.item) return preflight(selected.error)
    const item = selected.item
    if (['message.edit', 'message.recall', 'read.query', 'read.events'].includes(operation) && !item.botAuthored) return preflight('not_owned')
    if (item.createTime === null || item.timeConflict) return preflight('target_unverified')
    if (now() - item.createTime > INTERACTION_RETENTION_MS) return preflight('target_expired')
    if (!write) {
      try {
        const state = await observed(b, item)
        if (!live(b)) return readonly('stale_generation')
        if (operation === 'read.events') {
          if (item.chatType !== 'p2p') return readonly('unsupported_context')
          return { ok: true, status: 'succeeded', readOnly: true, ...state }
        }
        if (item.invalidated) return readonly('not_found_or_recalled')
        const result = await bounded(b, signal, call => provider.paged(b, item, operation, scopedCall(call, item)))
        if (!live(b)) return readonly('stale_generation')
        if (!result.ok) return readonly(result.unknown ? 'unavailable' : result.code || 'unavailable')
        const { own, dispatched, ...safe } = result
        return { ...safe, ok: true, status: 'succeeded', readOnly: true,
          ...(own ? { ownReactions: own.map(r => ({ emoji: r.emoji, reactionRef: reactionRef(b, item, r.reactionId, r.emoji) })) } : {}) }
      } catch { return readonly('unavailable') }
    }
    return serialized(targetKey(b, item), async () => {
      if (!live(b)) return preflight('stale_generation')
      if (resolve(b, args.target).item !== item) return preflight('target_unverified')
      const held = operation === 'reaction.remove' ? reactions.get(args.reaction_ref) : null
      if (operation === 'reaction.remove' && (!held || !live(held.binding) || !same(held.binding, b) || held.item !== item)) return preflight('reaction_unverified')
      const input = operation === 'message.edit' ? { text: args.text } : operation === 'reaction.add' ? { emoji: args.emoji }
        : operation === 'reaction.remove' ? { reactionId: held.reactionId } : {}
      const uuid = hash(['interactions/B/v1', operation, b.appId, b.chatId, b.sessionId, item.messageId, args.operation_id])
      const digest = hash([operation, item.messageId, item.createTime, input, item.messageType, item.updateMulti === true])
      let pin, store, begun, pending
      try {
        const checked = provider.validateOperation(b, item, operation, input)
        if (!checked.ok) return preflight(checked.code)
        pin = await receipts.acquire(item.createTime); store = pin.store
        if (!live(b) || signal?.aborted) return preflight(signal?.aborted ? 'cancelled' : 'stale_generation')
        if (!store.get(uuid)) {
          if (outstanding.has(targetKey(b, item))) return preflight('operation_inflight')
          await observed(b, item)
          if (item.invalidated) return preflight('not_found_or_recalled')
          if (held?.removed) return preflight('reaction_unverified')
          const prepared = await bounded(b, signal, call => provider.prepareOperation(b, item, operation, input, scopedCall(call, item)))
          if (!prepared.ok) return preflight(prepared.code || 'unavailable')
          if (!live(b) || signal?.aborted) return preflight(signal?.aborted ? 'cancelled' : 'stale_generation')
          if (now() - item.createTime > INTERACTION_RETENTION_MS) return preflight('target_expired')
          begun = await store.begin({ uuid, digest, now: now() })
          if (begun.outcome === 'acquired') {
            if (!short(begun.record?.ownerToken)) return unknown('receipt_unavailable')
            const result = await bounded(b, signal, call => {
              const checkedCall = scopedCall(call, item)
              checkedCall.check()
              pending = provider.operate(b, item, operation, input, checkedCall, prepared)
              return pending
            })
            const state = result.ok && live(b) ? 'sent' : result.unknown || (result.ok && !live(b)) ? 'unknown' : 'rejected'
            try {
              if (state === 'rejected') await pin.annotate(uuid, { code: result.code || 'platform_rejected', dispatched: result.dispatched })
              const fin = await store.finish({ uuid, ownerToken: begun.record.ownerToken, state, ...(state === 'sent' ? { messageId: result.messageId } : { reason: state === 'unknown' ? 'interrupted' : 'platform_error' }) })
              if (fin?.state !== state) return unknown('receipt_unavailable')
            } catch { return unknown('receipt_unavailable') }
            if (state === 'unknown' || !live(b)) return unknown('delivery_unknown')
            if (state === 'rejected') return rejected(result.code || 'platform_rejected', result.dispatched)
            if (operation === 'message.recall') item.invalidated = true
            if (operation === 'reaction.remove') held.removed = true
            item.revision = (item.revision || 0) + 1
            return { ok: true, status: 'succeeded', dispatched: true, replayed: false, revision: item.revision,
              ...(operation === 'reaction.add' ? { reactionRef: reactionRef(b, item, result.reactionId, args.emoji) } : {}) }
          }
        } else begun = await store.begin({ uuid, digest, now: now() })
        if (!live(b)) return preflight('stale_generation')
        if (begun.outcome === 'conflict') return preflight('conflict')
        if (begun.outcome === 'sent') {
          if (operation === 'message.recall') item.invalidated = true
          if (operation === 'reaction.remove') held.removed = true
          return { ok: true, status: 'succeeded', dispatched: false, replayed: true }
        }
        if (begun.outcome === 'rejected') { const note = await pin.note(uuid); return note ? rejected(note.code, note.dispatched) : unknown('receipt_unavailable') }
        return unknown('delivery_unknown')
      } catch (e) {
        let prior; try { prior = store?.get(uuid) } catch { /* unavailable durable evidence */ }
        return begun || prior ? unknown('receipt_unavailable') : preflight(e?.code === 'at_capacity' ? 'capacity_exhausted' : e?.code === 'bucket_busy' ? 'bucket_busy' : 'receipt_unavailable')
      }
      finally { await drain(pending, b, item); if (pin) await pin.release() }
    })
  }
  return {
    route,
    serializeTarget(b, item, fn) { return serialized(targetKey(b, item), fn) },
    targetBlocked(b, item) { return outstanding.has(targetKey(b, item)) },
    drain,
    drop(item) { for (const [ref, held] of reactions) if (held.item === item) reactions.delete(ref) },
    retire(agent) { for (const [ref, held] of reactions) if (held.binding.agent === agent) reactions.delete(ref) },
    reset() { reactions.clear() },
  }
}
