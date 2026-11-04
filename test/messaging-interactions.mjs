import './_guard.cjs'
import { renderInteractionResult } from '../lib/messaging-interaction-tools.js'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMessagingInteractions, createInteractionReceipts, INTERACTION_OPERATIONS } from '../lib/messaging-interactions.js'
import { interactionBucket, INTERACTION_RETENTION_MS } from '../lib/messaging-interaction-receipts.js'
import { openLarkDedupStore } from '../lib/lark-dedup.js'
import { createLarkInteractions } from '../lib/lark-interactions.js'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'messaging-interactions-'))
const open = []
async function fixture(extra = {}) {
  const root = path.join(home, String(open.length))
  const receipts = createInteractionReceipts(root, { now: extra.now || Date.now, ...extra.storeOptions })
  const agent = {}, b = { agent, appId: 'synthetic-app', chatId: 'synthetic-chat', sessionId: 'synthetic-session', record: {}, runtime: {}, generation: 1 }
  const state = { binding: b, calls: [], raw: null, gate: null, throw: false }
  const provider = createLarkInteractions({ async prepare() { if (state.tokenFailure) throw new Error('raw-secret-token'); return {} }, async request(binding, method, url, payload, call) {
    if (state.gate) await state.gate
    call.check(); call.onDispatch(); state.calls.push({ method, url, payload })
    if (state.afterDispatch) await state.afterDispatch
    if (state.throw) throw new Error('raw-secret-error')
    if (typeof state.raw === 'function') return state.raw({binding,method,url})
    if (state.raw) return state.raw
    return method === 'GET'
      ? { ok: true, status: 200, json: { code: 0, data: { items: [{ message_id: 'parent', chat_id: b.chatId, msg_type: 'text', body: { content: JSON.stringify({ text: 'untrusted quoted text' }) } }] } } }
      : { ok: true, status: 200, json: { code: 0, data: { message_id: 'sent-' + state.calls.length, chat_id: b.chatId, create_time: String((extra.now || Date.now)()) } } }
  } })
  const host = createMessagingInteractions({ bindingOf: a => a === agent ? state.binding : null, provider, receipts: extra.receipts ? extra.receipts(receipts) : receipts, timeoutMs: extra.timeoutMs || 1000, maxReferences: extra.maxReferences || 2000, perChatReferences: extra.perChatReferences || 200, now: extra.now || Date.now })
  const created = (extra.now || Date.now)()
  host.remember({ appId: b.appId, chatId: b.chatId, messageId: 'incoming', createTime: created }); host.select(agent, 'incoming')
  open.push(host)
  return { host, agent, b, state, root, receipts, provider, created }
}
const args = (id = 'action') => ({ operation_id: id, text: 'synthetic reply' })
try {
  const f = await fixture()
  for (const channel of ['onebot', 'telegram', 'discord', 'slack', 'wecom', 'wechat']) {
    for (const operation of INTERACTION_OPERATIONS) assert.equal((await f.host.route(channel, operation, f.agent, args())).error.code, 'unsupported_operation')
  }
  for (const operation of INTERACTION_OPERATIONS.filter(x => !['message.reply', 'quote.context', 'message.edit', 'message.recall', 'reaction.add', 'reaction.remove', 'reaction.list', 'read.query', 'read.events', 'card.publish', 'card.update', 'card.status'].includes(x))) assert.equal(f.host.capabilities('lark')[operation].supported, false)
  assert.equal(f.state.calls.length, 0)
  assert.equal((await f.host.reply({}, args())).error.code, 'not_bound')
  const context = await f.host.context(f.agent)
  assert.match(context.messageRef, /^msgref_[0-9a-f]{40}$/)
  assert.equal(context.quote.reason, 'no_quote')
  for (const bad of [{ ...args(), chat_id: 'bad' }, { ...args(), target: 'incoming' }, { ...args(), text: '\ud800' }, { ...args(), reply_in_thread: 'true' }, { ...args(), text: 'x'.repeat(12001) }]) assert.equal((await f.host.reply(f.agent, bad)).ok, false)
  assert.equal(f.state.calls.length, 0)
  const sent = await f.host.reply(f.agent, { ...args(), target: context.messageRef })
  assert.equal(sent.ok, true); assert.ok(sent.messageRef); assert.ok(!JSON.stringify(sent).includes('sent-'))
  assert.equal(f.state.calls[0].url, '/im/v1/messages/incoming/reply')
  assert.equal(f.state.calls[0].payload.msg_type, 'text'); assert.equal(f.state.calls[0].payload.reply_in_thread, false)
  assert.equal(JSON.parse(f.state.calls[0].payload.content).text, args().text)
  assert.equal(f.state.calls[0].payload.uuid.length, 50)
  assert.equal((await f.host.reply(f.agent, { ...args(), target: context.messageRef })).replayed, true)
  assert.equal((await f.host.reply(f.agent, { ...args(), target: context.messageRef, text: 'changed' })).error.code, 'conflict')
  assert.equal(f.state.calls.length, 1)
  const journal = await fs.readFile(path.join(f.root, interactionBucket(Date.now()), 'journal.jsonl'), 'utf8')
  assert.ok(!journal.includes('synthetic reply') && !journal.includes('synthetic-chat') && !journal.includes('incoming'))

  // Same verified chat only; unknown or other-chat parents never cause GET.
  f.host.remember({ appId: f.b.appId, chatId: 'other-chat', messageId: 'foreign' })
  f.host.remember({ appId: f.b.appId, chatId: f.b.chatId, messageId: 'quote-foreign', parentId: 'foreign' })
  const before = f.state.calls.length
  assert.ok((await f.host.enrich(f.agent, 'quote-foreign', 'original input')).startsWith('original input'))
  assert.equal(f.state.calls.length, before)
  f.host.remember({ appId: f.b.appId, chatId: f.b.chatId, messageId: 'parent' })
  f.host.remember({ appId: f.b.appId, chatId: f.b.chatId, messageId: 'quote', parentId: 'parent' })
  const enriched = await f.host.enrich(f.agent, 'quote', 'original input')
  assert.ok(enriched.includes('untrusted quoted text')); assert.ok(enriched.startsWith('original input'))
  const quoteRef = f.host.select(f.agent, 'quote')
  const quote = await f.host.context(f.agent, { target: quoteRef }); assert.equal(quote.quote.available, true)
  assert.equal(f.state.calls.at(-1).url, '/im/v1/messages/parent?card_msg_content_type=user_card_content')
  f.state.raw = { ok: true, status: 200, json: { code: 0, data: { items: [{ message_id: 'parent', chat_id: 'wrong', msg_type: 'text', body: { content: '{"text":"must not escape"}' } }] } } }
  const wrong = await f.host.context(f.agent, { target: quoteRef }); assert.equal(wrong.quote.available, false); assert.ok(!JSON.stringify(wrong).includes('must not escape'))
  f.state.binding = { ...f.b, generation: 2 }; assert.equal((await f.host.reply(f.agent, { ...args('old-ref'), target: context.messageRef })).error.code, 'target_unverified')
  f.state.binding = { ...f.b, chatId: 'other' }; assert.equal((await f.host.context(f.agent, { target: context.messageRef })).error.code, 'target_unverified')
  f.state.binding = { ...f.b, appId: 'other-app' }; assert.equal((await f.host.context(f.agent, { target: context.messageRef })).error.code, 'target_unverified')

  for (const raw of [null, { ok: true, status: 200, json: {} }, { ok: true, status: 200, json: { code: '0' } }, { ok: false, status: 500 }, { ok: false, status: 429 }, { ok: true, status: 200, json: { code: 0, data: {} } }]) {
    const t = await fixture(); t.state.raw = raw; t.state.throw = raw === null
    const uncertain = await t.host.reply(t.agent, args()); assert.equal(uncertain.status, 'unknown'); assert.ok(!JSON.stringify(uncertain).includes('raw-secret')); assert.ok(!JSON.stringify(renderInteractionResult({}, uncertain)).includes('raw-secret')); assert.ok(JSON.stringify(renderInteractionResult({}, uncertain)).includes('do NOT retry'))
    assert.equal((await t.host.reply(t.agent, args())).status, 'unknown'); assert.equal(t.state.calls.length, 1)
  }
  for (const [code, expected] of [[99991672, 'permission_denied'], [230027, 'access_denied'], [230054, 'unsupported_context'], [1234, 'platform_rejected']]) {
    const t = await fixture(); t.state.raw = { ok: true, status: 200, json: { code, msg: 'raw-private-error' } }
    const res = await t.host.reply(t.agent, args()); assert.equal(res.error.code, expected); assert.equal(res.dispatched, true); assert.equal(res.error.retryable, false); assert.ok(!JSON.stringify(res).includes('raw-private')); assert.ok(JSON.stringify(renderInteractionResult({}, res)).includes('platform explicitly rejected'))
    await t.host.reply(t.agent, args()); assert.equal(t.state.calls.length, 1)
  }
  const cancelled = await fixture(); const abort = new AbortController(); abort.abort()
  assert.equal((await cancelled.host.reply(cancelled.agent, args(), abort.signal)).error.code, 'cancelled'); assert.equal(cancelled.state.calls.length, 0)
  const late = await fixture(); let release
  late.state.gate = new Promise(r => { release = r })
  const pending = late.host.reply(late.agent, args())
  await new Promise(r => setTimeout(r, 25)); late.state.binding = null; release()
  assert.equal((await pending).error.code, 'stale_generation'); assert.equal(late.state.calls.length, 0)
  const inflight = await fixture(); let finish
  inflight.state.afterDispatch = new Promise(r => { finish = r })
  const p = inflight.host.reply(inflight.agent, args())
  while (!inflight.state.calls.length) await new Promise(r => setTimeout(r, 1))
  inflight.state.binding = { ...inflight.b, generation: 2 }; finish()
  assert.equal((await p).status, 'unknown')
  inflight.host.select(inflight.agent, 'incoming'); assert.equal((await inflight.host.reply(inflight.agent, args())).status, 'unknown'); assert.equal(inflight.state.calls.length, 1)
  const timeout = await fixture({ timeoutMs: 20 }); timeout.state.afterDispatch = new Promise(() => {})
  assert.equal((await timeout.host.reply(timeout.agent, args())).status, 'unknown')
  assert.equal((await timeout.host.reply(timeout.agent, args())).status, 'unknown'); assert.equal(timeout.state.calls.length, 1)

  // Concurrent logical retries share the durable acquired owner; no second dispatch.
  const concurrent = await fixture(); concurrent.b.time = Date.now(); concurrent.host.remember({ appId: concurrent.b.appId, chatId: concurrent.b.chatId, messageId: 'restart-target', createTime: concurrent.b.time }); concurrent.host.select(concurrent.agent, 'restart-target'); const concurrentRef = concurrent.host.select(concurrent.agent, 'restart-target'); let releaseConcurrent
  concurrent.state.afterDispatch = new Promise(r => { releaseConcurrent = r })
  const firstConcurrent = concurrent.host.reply(concurrent.agent, { ...args('concurrent'), target: concurrentRef })
  while (!concurrent.state.calls.length) await new Promise(r => setTimeout(r, 1))
  assert.equal((await concurrent.host.reply(concurrent.agent, { ...args('concurrent'), target: concurrentRef })).status, 'unknown')
  assert.equal(concurrent.state.calls.length, 1)
  releaseConcurrent(); assert.equal((await firstConcurrent).ok, true)
  await concurrent.host.close()
  const reopened = createMessagingInteractions({ bindingOf: a => a === concurrent.agent ? concurrent.b : null,
    provider: { reply() { assert.fail('durable sent replay must not dispatch after restart') } },
    receipts: createInteractionReceipts(concurrent.root) })
  open.push(reopened)
  reopened.remember({ appId: concurrent.b.appId, chatId: concurrent.b.chatId, messageId: 'restart-target', createTime: concurrent.b.time }); reopened.select(concurrent.agent, 'restart-target')
  assert.equal((await reopened.reply(concurrent.agent, args('concurrent'))).replayed, true)

  const escaped = await fixture()
  assert.equal((await escaped.host.reply(escaped.agent, { operation_id: 'escaped', text: 'x' + '\u0000'.repeat(9000) })).error.code, 'invalid_arguments')
  assert.equal(escaped.state.calls.length, 0, 'serialized body budget checked before HTTP dispatch')
  let flushRelease, flushEntered
  const entered = new Promise(r => { flushEntered = r })
  const pendingFlush = new Promise(r => { flushRelease = r })
  let durableAppends = 0
  const awaited = await fixture({ storeOptions: { fs: { async open(...a) {
    const h = await fs.open(...a)
    if (String(a[0]).endsWith('journal.jsonl') && a[1] === 'a') {
      const sync = h.sync.bind(h)
      h.sync = async () => { if (++durableAppends === 1) { flushEntered(); await pendingFlush }; return sync() }
    }
    return h
  } } } })
  const waitingReply = awaited.host.reply(awaited.agent, args())
  await entered; assert.equal(awaited.state.calls.length, 0, 'await real begin fsync before dispatch')
  flushRelease(); assert.equal((await waitingReply).ok, true); assert.equal(durableAppends, 2)

  const beginFault = await fixture({ storeOptions: { fs: { async open(...a) {
    const h = await fs.open(...a)
    if (String(a[0]).endsWith('journal.jsonl') && a[1] === 'a') h.sync = async () => { throw new Error('synthetic begin fsync fault') }
    return h
  } } } })
  assert.equal((await beginFault.host.reply(beginFault.agent, args())).error.code, 'receipt_unavailable')
  assert.equal(beginFault.state.calls.length, 0, 'failed durable begin never reaches provider')

  // Real journal fsync failure on the second (finish) durable append, not a literal receipt stub.
  let syncCount = 0
  const fault = await fixture({ storeOptions: { fs: { async open(...a) {
    const h = await fs.open(...a)
    if (String(a[0]).endsWith('journal.jsonl') && a[1] === 'a') {
      const sync = h.sync.bind(h)
      h.sync = async () => { if (++syncCount === 2) throw new Error('synthetic fsync fault'); return sync() }
    }
    return h
  } } } })
  assert.equal((await fault.host.reply(fault.agent, args())).status, 'unknown'); assert.equal(fault.state.calls.length, 1)
  assert.equal((await fault.host.reply(fault.agent, args())).ok, false); assert.equal(fault.state.calls.length, 1)
  assert.equal((await fault.host.reply(fault.agent, args())).status, 'unknown', 'poisoned replay does not imply a fresh safe retry')
  const card = await fixture(); card.b.interactiveCard = true
  assert.equal((await card.host.reply(card.agent, args())).ok, true)
  assert.equal(card.state.calls[0].payload.msg_type, 'interactive', 'card=true explicit reply stays interactive')
  assert.ok(card.state.calls[0].payload.content.includes('synthetic reply'))
  const full = await fixture({ storeOptions: { sendCapacity: 1 } })
  const fullRef = full.host.select(full.agent, 'incoming'); await full.host.reply(full.agent, { ...args('one'), target: fullRef })
  assert.equal((await full.host.reply(full.agent, { ...args('two'), target: fullRef })).error.code, 'capacity_exhausted'); assert.equal(full.state.calls.length, 1)
  const boundedRefs = await fixture({ maxReferences: 1 }); const evictedRef = boundedRefs.host.select(boundedRefs.agent, 'incoming')
  assert.equal(boundedRefs.host.remember({ appId: boundedRefs.b.appId, chatId: boundedRefs.b.chatId, messageId: 'overflow', createTime: Date.now() }), true)
  const overflowRef = boundedRefs.host.select(boundedRefs.agent, 'overflow')
  assert.equal((await boundedRefs.host.context(boundedRefs.agent, { target: evictedRef })).error.code, 'target_unverified')
  assert.equal((await boundedRefs.host.reply(boundedRefs.agent, { ...args(), target: overflowRef })).ok, true)
  // C1/C2: bounded daily capacity, immutable platform time and target-scoped ids.
  let clock = Date.UTC(2026, 9, 28, 12)
  const day = await fixture({ now: () => clock, storeOptions: { sendCapacity: 3 } })
  const originalTime = clock, originalRef = day.host.select(day.agent, 'incoming')
  for (let i = 0; i < 3; i++) assert.equal((await day.host.reply(day.agent, { ...args('daily-' + i), target: originalRef })).ok, true)
  assert.equal((await day.host.reply(day.agent, { ...args('daily-full'), target: originalRef })).error.code, 'capacity_exhausted')
  clock += 86400000
  day.host.remember({ appId: day.b.appId, chatId: day.b.chatId, messageId: 'tomorrow', createTime: clock })
  const tomorrowRef = day.host.select(day.agent, 'tomorrow')
  assert.equal((await day.host.reply(day.agent, { ...args('daily-0'), target: tomorrowRef })).ok, true, 'same id on a DIFFERENT target is a separate target-scoped action')
  assert.equal((await day.host.reply(day.agent, { ...args('daily-0'), target: originalRef })).replayed, true, 'same target remains in its original day bucket')
  assert.equal((await day.host.reply(day.agent, { ...args('daily-0'), target: originalRef, text: 'changed' })).error.code, 'conflict')
  const noTime = 'no-time'
  day.host.remember({ appId: day.b.appId, chatId: day.b.chatId, messageId: noTime })
  assert.equal((await day.host.reply(day.agent, { ...args(), target: day.host.select(day.agent, noTime) })).error.code, 'target_unverified')
  await day.host.close()
  const dailyRestart = createMessagingInteractions({ bindingOf: () => day.b, provider: day.provider, now: () => clock,
    receipts: createInteractionReceipts(day.root, { now: () => clock, sendCapacity: 3 }) })
  open.push(dailyRestart); day.host = dailyRestart
  dailyRestart.remember({ appId: day.b.appId, chatId: day.b.chatId, messageId: 'incoming', createTime: originalTime })
  dailyRestart.remember({ appId: day.b.appId, chatId: day.b.chatId, messageId: 'tomorrow', createTime: originalTime + 86400000 })
  const restartOriginalRef = dailyRestart.select(day.agent, 'incoming'), restartTomorrowRef = dailyRestart.select(day.agent, 'tomorrow')
  assert.equal((await dailyRestart.reply(day.agent, { ...args('daily-full'), target: restartOriginalRef })).error.code, 'capacity_exhausted')
  assert.equal((await dailyRestart.reply(day.agent, { ...args('daily-0'), target: restartTomorrowRef })).replayed, true)
  assert.equal((await dailyRestart.reply(day.agent, { ...args('tomorrow-new'), target: restartTomorrowRef })).ok, true)
  const invalidTimes = await fixture()
  for (const [i, value] of [0, '1600000000', 'not-a-time', Date.UTC(2019, 11, 31), Date.now() + 600000, Number.MAX_SAFE_INTEGER].entries()) {
    invalidTimes.host.remember({ appId: invalidTimes.b.appId, chatId: invalidTimes.b.chatId, messageId: 'bad-time-' + i, createTime: value })
    const ref = invalidTimes.host.select(invalidTimes.agent, 'bad-time-' + i)
    assert.equal((await invalidTimes.host.reply(invalidTimes.agent, { ...args('bad-time-' + i), target: ref })).error.code, 'target_unverified')
  }
  assert.equal(invalidTimes.state.calls.length, 0)
  const beforeExpired = day.state.calls.length
  clock = originalTime + INTERACTION_RETENTION_MS + 1
  assert.equal((await day.host.reply(day.agent, { ...args('daily-0'), target: restartOriginalRef })).error.code, 'target_expired')
  assert.equal(day.state.calls.length, beforeExpired)
  await day.host.close()
  // No automatic GC. Simulate an absent old test-only bucket: expiry must still
  // reject before acquire/begin rather than resurrect an old id in a fresh root.
  await fs.rm(path.join(day.root, interactionBucket(originalTime)), { recursive: true })
  let expiredAcquire = 0
  const expired = createMessagingInteractions({ now: () => clock, bindingOf: () => day.b,
    provider: day.provider, receipts: { acquire() { expiredAcquire++; assert.fail('expired target acquired storage') }, async close() {} } })
  open.push(expired)
  expired.remember({ appId: day.b.appId, chatId: day.b.chatId, messageId: 'incoming', createTime: originalTime }); expired.select(day.agent, 'incoming')
  assert.equal((await expired.reply(day.agent, args('daily-0'))).error.code, 'target_expired'); assert.equal(expiredAcquire, 0)

  // C4: a busy chat exceeds both per-chat and global budgets without permanent
  // failure. Another chat's one retained reference survives 2100 new messages.
  const lru = await fixture({ maxReferences: 210, perChatReferences: 200 })
  const otherAgent = {}, otherBinding = { ...lru.b, agent: otherAgent, chatId: 'quiet-chat' }
  const memory = createMessagingInteractions({ bindingOf: a => a === otherAgent ? otherBinding : lru.b,
    provider: lru.provider, receipts: lru.receipts, maxReferences: 210, perChatReferences: 200 })
  open.push(memory)
  memory.remember({ appId: lru.b.appId, chatId: 'quiet-chat', messageId: 'quiet', createTime: Date.now() })
  const quietRef = memory.select(otherAgent, 'quiet')
  let lastRef, firstRef
  for (let i = 0; i < 2101; i++) {
    memory.remember({ appId: lru.b.appId, chatId: lru.b.chatId, messageId: 'busy-' + i, createTime: Date.now() })
    lastRef = memory.select(lru.agent, 'busy-' + i); if (!i) firstRef = lastRef
  }
  assert.equal((await memory.context(otherAgent, { target: quietRef })).ok, true)
  assert.equal((await memory.context(lru.agent, { target: firstRef })).error.code, 'target_unverified')
  assert.equal((await memory.reply(lru.agent, { ...args('after-2100'), target: lastRef })).ok, true)
  assert.equal((await memory.reply(lru.agent, args('ambiguous-overflow'))).error.code, 'target_required')

  // C8: token failure is before ANY begin; a same-id retry is then safe. Local
  // invalid input needs correction, not an automatic retry instruction.
  const token = await fixture(); token.state.tokenFailure = true
  const failedToken = await token.host.reply(token.agent, args())
  assert.equal(failedToken.dispatched, false); assert.equal(failedToken.error.retryable, true); assert.equal(failedToken.retry, 'same_operation_id'); assert.ok(JSON.stringify(renderInteractionResult({}, failedToken)).includes('Reuse the same operation_id'))
  const tokenPin = await token.receipts.acquire(token.created)
  const tokenUuid = createHash('sha256').update(JSON.stringify(['interactions/reply/target-v2', token.b.appId, token.b.chatId, token.b.sessionId, 'incoming', 'action'])).digest('hex')
  assert.equal(tokenPin.store.get(tokenUuid), null, 'token failure creates no operation receipt'); await tokenPin.release()

  token.state.tokenFailure = false; assert.equal((await token.host.reply(token.agent, args())).ok, true)
  token.state.tokenFailure = true; assert.equal((await token.host.reply(token.agent, { ...args(), target: token.host.select(token.agent, 'incoming') })).replayed, true, 'sent replay does not need a live token service')
  for (const cardMode of [false, true]) {
    const budget = await fixture(); budget.b.interactiveCard = cardMode
    const text = '"\\'.repeat(6000) // exactly 12000 UTF-8 bytes, maximal JSON escaping
    const result = await budget.host.reply(budget.agent, { operation_id: 'worst-budget', text })
    if (!result.ok) { assert.equal(result.dispatched, false); assert.equal(result.error.code, 'invalid_arguments'); assert.equal(result.error.retryable, false); assert.deepEqual(await fs.readdir(budget.root).catch(() => []), []) }
    else assert.ok(Buffer.byteLength(JSON.stringify(budget.state.calls[0].payload)) <= 30 * 1024)
  }
  // Cancel at real begin fsync: acquired receipt persists a zero-dispatch class,
  // including after close/open. Do not confuse this with platform rejection.
  const afterBeginAbort = new AbortController()
  const zero = await fixture({ storeOptions: { fs: { async open(...a) {
    const h = await fs.open(...a)
    if (String(a[0]).endsWith('journal.jsonl') && a[1] === 'a') {
      const sync = h.sync.bind(h); h.sync = async () => { await sync(); afterBeginAbort.abort() }
    }
    return h
  } } } })
  const zref = zero.host.select(zero.agent, 'incoming'), ztime = Date.now()
  const zr = await zero.host.reply(zero.agent, { ...args('zero'), target: zref }, afterBeginAbort.signal)
  assert.equal(zr.dispatched, false); assert.equal(zr.retry, 'new_operation_id'); assert.ok(JSON.stringify(renderInteractionResult({}, zr)).includes('new operation_id is allowed')); assert.equal(zero.state.calls.length, 0)
  assert.equal((await zero.host.reply(zero.agent, { ...args('zero'), target: zref })).retry, 'new_operation_id')
  await zero.host.close()
  const zeroRestart = createMessagingInteractions({ bindingOf: () => zero.b, provider: zero.provider, receipts: createInteractionReceipts(zero.root) })
  open.push(zeroRestart)
  zeroRestart.remember({ appId: zero.b.appId, chatId: zero.b.chatId, messageId: 'incoming', createTime: zero.created }); zeroRestart.select(zero.agent, 'incoming')
  const zeroReplay = await zeroRestart.reply(zero.agent, args('zero'))
  assert.equal(zeroReplay.dispatched, false); assert.equal(zeroReplay.retry, 'new_operation_id'); assert.equal(zeroReplay.error.code, 'cancelled'); assert.equal(zero.state.calls.length, 0)
  for (const raw of [{ ok: true, status: 200, json: { code: 0, data: {} } }, { ok: true, status: 200, json: { code: 0, data: { message_id: 'must-not-register', chat_id: 'foreign-chat', create_time: String(Date.now()) } } }]) {
    const mismatch = await fixture(); mismatch.state.raw = raw
    const result = await mismatch.host.reply(mismatch.agent, args())
    assert.equal(result.status, 'unknown'); assert.equal(result.dispatched, true); assert.equal(result.messageRef, undefined)
    mismatch.host.remember({ appId: mismatch.b.appId, chatId: mismatch.b.chatId, messageId: 'quote-missing', parentId: 'must-not-register' })
    const qref = mismatch.host.select(mismatch.agent, 'quote-missing'), count = mismatch.state.calls.length
    assert.equal((await mismatch.host.context(mismatch.agent, { target: qref })).quote.reason, 'target_unverified'); assert.equal(mismatch.state.calls.length, count)
  }
  // A replay awaiting a real store begin cannot return success into a new
  // generation, even though no provider request is required for that replay.
  let replayBlock = false, replayRelease, replayEntered
  const replayGate = new Promise(r => { replayRelease = r }), replayReady = new Promise(r => { replayEntered = r })
  const staleReplay = await fixture({ receipts: real => ({
    async acquire(time) {
      const p = await real.acquire(time), store = p.store
      return { ...p, store: { get: id => store.get(id), finish: value => store.finish(value), async begin(value) {
        const result = await store.begin(value)
        if (replayBlock) { replayEntered(); await replayGate }
        return result
      } } }
    }, close: () => real.close(),
  }) })
  const stableRef = staleReplay.host.select(staleReplay.agent, 'incoming')
  assert.equal((await staleReplay.host.reply(staleReplay.agent, { ...args('stale-replay'), target: stableRef })).ok, true)
  replayBlock = true
  const oldReplay = staleReplay.host.reply(staleReplay.agent, { ...args('stale-replay'), target: stableRef })
  await replayReady; staleReplay.state.binding = { ...staleReplay.b, generation: 2 }; replayRelease()
  assert.equal((await oldReplay).error.code, 'stale_generation'); assert.equal(staleReplay.state.calls.length, 1)
  // T7: kernel dispatching survives close/open across time; then the real router
  // sees that exact pending operation and never calls provider, even 2h later.
  let pendingClock = Date.UTC(2026, 9, 28, 12)
  const pendingHome = path.join(home, 'pending-reopen'), pendingAgent = {}, pb = { ...f.b, agent: pendingAgent }
  const targetTime = pendingClock, op = 'pending-op', sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex')
  const uuid = sha(['interactions/reply/target-v2', pb.appId, pb.chatId, pb.sessionId, 'pending-target', op])
  const digest = sha(['pending-target', targetTime, args(op).text, false, false])
  const pool = createInteractionReceipts(pendingHome, { now: () => pendingClock })
  const pin = await pool.acquire(targetTime), began = await pin.store.begin({ uuid, digest, now: pendingClock })
  assert.equal(began.outcome, 'acquired'); await pin.release(); await pool.close()
  pendingClock += 7200000
  const rawLease = await openLarkDedupStore(path.join(pendingHome, interactionBucket(targetTime)))
  assert.equal((await rawLease.sendReceipts.begin({ uuid, digest, now: pendingClock })).outcome, 'unknown')
  await rawLease.close() // real flock handoff BEFORE the wrapper reopens the root
  let pendingCalls = 0
  const pendingEngine = createMessagingInteractions({ bindingOf: () => pb, now: () => pendingClock,
    provider: { reply() { pendingCalls++; assert.fail('pending replay dispatched') } }, receipts: createInteractionReceipts(pendingHome, { now: () => pendingClock }) })
  open.push(pendingEngine); pendingEngine.remember({ appId: pb.appId, chatId: pb.chatId, messageId: 'pending-target', createTime: targetTime }); pendingEngine.select(pendingAgent, 'pending-target')
  assert.equal((await pendingEngine.reply(pendingAgent, args(op))).status, 'unknown'); assert.equal(pendingCalls, 0)
  assert.equal((await pendingEngine.reply(pendingAgent, { ...args(op), text: 'conflicting' })).error.code, 'conflict')

  // Three pinned buckets cannot be evicted; close waits. After releasing pins,
  // a different OS process can acquire the exact root (not shared-process lease).
  const poolRoot = path.join(home, 'pool-lifecycle'), poolNow = Date.UTC(2026, 9, 28, 12)
  const pinsPool = createInteractionReceipts(poolRoot, { now: () => poolNow })
  const pins = await Promise.all([0, 1, 2].map(i => pinsPool.acquire(poolNow - i * 86400000)))
  await assert.rejects(pinsPool.acquire(poolNow - 3 * 86400000), e => e.code === 'bucket_busy')
  const kernelUrl = new URL('../lib/lark-dedup.js', import.meta.url).href
  const bucketRoot = path.join(poolRoot, interactionBucket(poolNow))
  const probe = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import {openLarkDedupStore} from ${JSON.stringify(kernelUrl)}; try {const s=await openLarkDedupStore(${JSON.stringify(bucketRoot)});await s.close();console.log('acquired')}catch(e){console.log(e.code);process.exitCode=7}`], { encoding: 'utf8' })
  assert.equal(probe().stdout.trim(), 'lock_held')
  let closed = false; const closing = pinsPool.close().then(() => { closed = true })
  await new Promise(r => setTimeout(r, 10)); assert.equal(closed, false)
  await Promise.all(pins.map(p => p.release())); await closing
  const handedOff = probe(); assert.equal(handedOff.status, 0); assert.equal(handedOff.stdout.trim(), 'acquired')
  // Idle LRU repeatedly closes/reopens four days while preserving sent receipts.
  const rotating = createInteractionReceipts(path.join(home, 'rotating'), { now: () => poolNow, maxOpen: 3 })
  for (let round = 0; round < 2; round++) for (let i = 0; i < 4; i++) {
    const pinned = await rotating.acquire(poolNow - i * 86400000), uid = sha(['rotation', i])
    const found = await pinned.store.begin({ uuid: uid, digest: 'd'.repeat(64), now: poolNow })
    assert.equal(found.outcome, round ? 'sent' : 'acquired')
    if (!round) await pinned.store.finish({ uuid: uid, ownerToken: found.record.ownerToken, state: 'sent', messageId: 'synthetic-rotation' })
    await pinned.release()
  }
  await rotating.close()
  // Authenticated ingress anchors a historical quote even after catalogue loss.
  // Merely registering a model-like unknown parent above still performs no GET.
  const historical=await fixture()
  historical.host.remember({appId:historical.b.appId,chatId:historical.b.chatId,messageId:'historical-question',parentId:'parent',trustedQuote:true})
  const htext=await historical.host.enrich(historical.agent,'historical-question','current question')
  assert.ok(htext.includes('untrusted quoted text'))
  assert.ok(htext.includes('explicitly quoted target'))
  historical.host.remember({appId:historical.b.appId,chatId:historical.b.chatId,messageId:'root-question',rootId:'parent',trustedQuote:true})
  assert.ok((await historical.host.enrich(historical.agent,'root-question','root current question')).includes('untrusted quoted text'))
  const href=historical.host.select(historical.agent,'historical-question')
  const hc=await historical.host.context(historical.agent,{target:href})
  assert.equal(hc.quote.available,true)
  assert.equal(hc.quote.message.botAuthored,false,'reading a historical bot-like message does not grant own-send authority')
  assert.equal((await historical.host.route('lark','message.edit',historical.agent,{target:hc.quote.messageRef,operation_id:'not-own',text:'no'})).error.code,'not_owned')
  const neverRead=historical.state.calls.length
  assert.equal((await historical.host.context(historical.agent,{target:'arbitrary-platform-id'})).ok,false)
  assert.equal(historical.state.calls.length,neverRead)
  for(const [kind,body,expected] of [
    ['text',{text:'EARLIER_TOPIC two paths'},true],
    ['interactive',{header:{title:{tag:'plain_text',content:'Older title'}},elements:[{tag:'div',text:{tag:'lark_md',content:'EARLIER_TOPIC two paths'}}]},true],
    ['interactive',{title:'Default card',elements:[[{tag:'text',text:'EARLIER_TOPIC two paths'}]]},true],
    ['interactive',{schema:'2.0',body:{elements:[{tag:'markdown',content:'EARLIER_TOPIC two paths'}]}},true],
    ['interactive',{type:'card',data:{card_id:'PRIVATE-CARD-ID'}},false],
  ]){
    historical.state.raw={ok:true,status:200,json:{code:0,data:{items:[{message_id:'parent',chat_id:historical.b.chatId,msg_type:kind,create_time:String(Date.now()),body:{content:JSON.stringify(body)}}]}}}
    const value=await historical.host.enrich(historical.agent,'historical-question','current question')
    assert.equal(value.includes('EARLIER_TOPIC'),expected)
    if(!expected){assert.ok(value.includes('Do not substitute the latest answer'));assert.ok(!value.includes('PRIVATE-CARD-ID'))}
  }
  // Live failure shape: default IM card projection is a compatibility notice,
  // while the same authorized message GET can request the original card JSON.
  const notice={title:null,elements:[[{tag:'img',image_key:'IMGKEY_MARKER'},{tag:'text',text:'请升级至最新版本客户端，以查看内容'},{tag:'text',text:''}]]}
  const rawCard={schema:'2.0',body:{elements:[{tag:'markdown',content:'EARLIER_JIO_GOOGLE_TOPIC: two paths'}]}}
  historical.state.raw=({url})=>({ok:true,status:200,json:{code:0,data:{items:[{message_id:'parent',chat_id:historical.b.chatId,msg_type:'interactive',updated:true,body:{content:JSON.stringify(url.endsWith('?card_msg_content_type=user_card_content')?rawCard:notice)}}]}}})
  const restoredQuote=await historical.host.enrich(historical.agent,'historical-question','How many paths in this quoted message?')
  assert.ok(restoredQuote.includes('EARLIER_JIO_GOOGLE_TOPIC'),'original card JSON replaces compatibility-only default projection')
  assert.ok(!restoredQuote.includes('请升级至'))
  assert.ok(historical.state.calls.at(-1).url.endsWith('/parent?card_msg_content_type=user_card_content'))
  for(const body of [notice,{type:'card',data:{card_id:'PRIVATE-OPAQUE-CARD'}}]){
    historical.state.raw={ok:true,status:200,json:{code:0,data:{items:[{message_id:'parent',chat_id:historical.b.chatId,msg_type:'interactive',body:{content:JSON.stringify(body)}}]}}}
    const unavailable=await historical.host.enrich(historical.agent,'historical-question','quoted question')
    assert.ok(unavailable.includes('"available":false'),'compatibility-only and opaque cards are unreadable')
    assert.ok(unavailable.includes('Do not substitute the latest answer'))
    assert.ok(!unavailable.includes('请升级至'));assert.ok(!unavailable.includes('PRIVATE-OPAQUE-CARD'))
  }
  historical.state.raw={ok:true,status:200,json:{code:0,data:{items:[{message_id:'parent',chat_id:'foreign-chat',msg_type:'text',body:{content:'{"text":"PRIVATE-WRONG-CHAT"}'}}]}}}
  const deniedQuote=await historical.host.enrich(historical.agent,'historical-question','current question')
  assert.ok(deniedQuote.includes('Do not substitute the latest answer'));assert.ok(!deniedQuote.includes('PRIVATE-WRONG-CHAT'))
  historical.state.throw=true;historical.state.raw=null
  const unreadable=await historical.host.enrich(historical.agent,'historical-question','current question')
  assert.ok(unreadable.startsWith('current question'));assert.ok(unreadable.includes('Do not substitute the latest answer'));assert.ok(!unreadable.includes('raw-secret-error'))
  console.log('messaging-interactions: ok | daily pinned receipts and expiry, target-scoped conflicts/pending restart, LRU >2100, preflight/preDispatch/platform/unknown semantics, fsync, same-chat quotes, six unsupported; fake provider wire')
} finally {
  for (const h of open) await h.close()
  await fs.rm(home, { recursive: true, force: true })
}
