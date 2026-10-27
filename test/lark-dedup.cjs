require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// unhandled rejection 必须显式失败（回调 reject 一律走 onError，不允许泄漏）。
const unhandled = []
process.on('unhandledRejection', (err) => {
  unhandled.push(err)
})

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function collectExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
}

// 真实 fs 之上的故障注入包装（fs.promises 同名方法全量委托，可按开关抛错/短写）。
function faultyFs(flags = {}) {
  const wrapHandle = (handle, kind) => ({
    write: async (...args) => {
      if (flags.failWrite && flags.failWrite(kind, args)) {
        // 短写：只落盘前 N 字节再抛（部分写场景）。
        const buf = args[0]
        const partial = typeof buf === 'string' ? buf.slice(0, 20) : buf.subarray(0, Math.min(20, buf.length))
        await handle.write(partial)
        const error = new Error(flags.writeError || 'EIO injected write failure')
        error.code = flags.writeCode || 'ENOSPC'
        throw error
      }
      return handle.write(...args)
    },
    sync: async (...args) => {
      if (flags.failSync && flags.failSync(kind)) {
        flags.failSync = null // 一次性
        const error = new Error('EIO injected fsync failure')
        error.code = 'EIO'
        throw error
      }
      if (flags.syncAlwaysFail && flags.syncAlwaysFail(kind)) {
        const error = new Error('EIO injected persistent fsync failure')
        error.code = 'EIO'
        throw error
      }
      return handle.sync(...args)
    },
    close: (...args) => handle.close(...args),
    truncate: (...args) => handle.truncate(...args),
    write2: (...args) => handle.write(...args),
    stat: (...args) => handle.stat(...args),
    fd: handle.fd,
  })
  const base = {
    mkdir: fsp.mkdir, rename: fsp.rename, readFile: fsp.readFile, stat: fsp.stat,
    truncate: fsp.truncate, unlink: fsp.unlink, chmod: fsp.chmod, link: fsp.link,
    open: async (target, atFlags, mode) => {
      if (flags.failDirSync && flags.failDirSync(target, atFlags)) {
        // 目录 fsync 场景：压缩后 dir handle 的 sync 抛错。
        const handle = await fsp.open(target, atFlags, mode)
        return {
          ...wrapHandle(handle, 'dir'),
          sync: async () => {
            const error = new Error('EIO injected directory fsync failure')
            error.code = 'EIO'
            throw error
          },
        }
      }
      if (flags.openFail && flags.openFail(target, atFlags)) {
        const error = new Error('EIO injected open failure')
        error.code = 'EIO'
        throw error
      }
      const handle = await fsp.open(target, atFlags, mode)
      if (atFlags === 'a') return wrapHandle(handle, 'journal')
      if (atFlags === 'w' && flags.failTmpWrite) return wrapHandle(handle, 'tmp')
      return wrapHandle(handle, 'other')
    },
  }
  if (flags.failRename) {
    base.rename = async (from, to) => {
      if (flags.failRename(from, to)) {
        const error = new Error('EIO injected rename failure')
        error.code = 'EIO'
        throw error
      }
      return fsp.rename(from, to)
    }
  }
  return base
}

async function main() {
  const {
    openLarkDedupStore,
    larkDedupKey,
    larkSendKey,
    larkSendDigest,
    larkDedupUserMessageId,
    parseLarkUserMessageId,
    LarkDedupError,
    LARK_DEDUP_JOURNAL_NAME,
    LARK_DEDUP_LOCK_NAME,
    LARK_SEND_REASONS,
    LARK_COMPACT_ERROR_STAGES,
  } = await import(pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href)

  const tempRoots = []
  const makeRoot = async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lark-dedup-test-'))
    tempRoots.push(dir)
    return dir
  }

  // ---------- 键与 id 编码：JSON 元组，无拼接歧义 ----------
  {
    assert.notEqual(larkDedupKey('a:b', 'c'), larkDedupKey('a', 'b:c'), 'tuple encoding must not collide on colon splits')
    assert.match(larkDedupKey('app', 'om_1'), /^[0-9a-f]{64}$/, 'key is sha256 hex')
    const umid = larkDedupUserMessageId('ab12cd34', 7, 'app', 'om_1')
    assert.match(umid, /^lark-[0-9a-f]{8}-7-[0-9a-f]{16}$/, 'user message id carries ns + seq + tuple hash16')
    const parsed = parseLarkUserMessageId(umid)
    assert.deepEqual(parsed, { ns: 'ab12cd34', seq: 7, hash16: umid.slice(-16) }, 'user message id parses back')
    assert.equal(parseLarkUserMessageId('lark-XX-1-yy'), null, 'malformed ids rejected')
    // send digest：版本化元组绑定全部要素，任一变化都变。
    const dgst = larkSendDigest({ imageSha256: 'aa'.repeat(32), mode: 'card', caption: 'hi', appId: 'cli', conversation: 'oc_1' })
    assert.match(dgst, /^[0-9a-f]{64}$/, 'send digest is sha256 hex')
    assert.equal(dgst, larkSendDigest({ imageSha256: 'aa'.repeat(32), mode: 'card', caption: 'hi', appId: 'cli', conversation: 'oc_1' }), 'digest deterministic')
    assert.notEqual(dgst, larkSendDigest({ imageSha256: 'bb'.repeat(32), mode: 'card', caption: 'hi', appId: 'cli', conversation: 'oc_1' }), 'image bytes bind the digest')
    assert.notEqual(dgst, larkSendDigest({ imageSha256: 'aa'.repeat(32), mode: 'text', caption: 'hi', appId: 'cli', conversation: 'oc_1' }), 'mode binds the digest')
    assert.notEqual(dgst, larkSendDigest({ imageSha256: 'aa'.repeat(32), mode: 'card', caption: 'other', appId: 'cli', conversation: 'oc_1' }), 'caption binds the digest')
    assert.notEqual(dgst, larkSendDigest({ imageSha256: 'aa'.repeat(32), mode: 'card', caption: 'hi', appId: 'cli', conversation: 'oc_2' }), 'target binds the digest')
    assert.notEqual(larkSendKey('u1'), larkSendKey('u2'), 'send keys differ per uuid')
  }

  // ---------- 基本入站生命周期 ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    assert.equal(store.stats().lockMode, 'flock', 'OS flock 是唯一实现（声明依赖 node-addon-system，无回退）')
    const first = await store.claim({
      appId: 'cli_app', messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p',
      sessionId: 'session-abc', sessionExisted: false,
    })
    assert.equal(first.outcome, 'claimed', 'fresh key claims')
    assert.equal(first.record.ledgerSeq, 1, 'first claim gets seq 1')
    assert.equal(first.record.sessionId, 'session-abc', 'route persisted with the claim')
    const dup = await store.claim({ appId: 'cli_app', messageId: 'om_1' })
    assert.equal(dup.outcome, 'duplicate-inflight', 'inflight duplicate dedups')
    const settled = await store.settleDelivered(first.record.key, { flushed: true, admission: 'admitted' })
    assert.equal(settled.state, 'delivered', 'flushed+admitted evidence settles delivered')
    const after = await store.claim({ appId: 'cli_app', messageId: 'om_1' })
    assert.equal(after.outcome, 'duplicate-terminal', 'terminal dedups later events')
    await store.close()
    assert.equal(await store.claim({ appId: 'cli_app', messageId: 'om_2' }).then(() => 'ok', (e) => e.code), 'closed', 'closed handle refuses work')
  }

  // ---------- M1：bindRoute 首绑/幂等/冲突；sessionExisted 不降级 ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    const c = await store.claim({ appId: 'cli_app', messageId: 'm1_bind', chatId: 'oc_1' })
    const bound = await store.bindRoute(c.record.key, { sessionId: 'sess-A', sessionExisted: true })
    assert.equal(bound.sessionId, 'sess-A', 'first bind wins')
    assert.equal(bound.sessionExisted, true, 'checkpoint written')
    const again = await store.bindRoute(c.record.key, { sessionId: 'sess-A', sessionExisted: true })
    assert.equal(again.sessionId, 'sess-A', 'same binding is idempotent')
    await assert.rejects(() => store.bindRoute(c.record.key, { sessionId: 'sess-B', sessionExisted: false }), (error) => error.code === 'route_conflict', 'different session is refused, never overwritten')
    await assert.rejects(() => store.bindRoute(c.record.key, { sessionId: 'sess-A', sessionExisted: false }), (error) => error.code === 'route_conflict', 'sessionExisted never changes once written (true→false refused)')
    // claim 时未知 checkpoint（null）→ 首次绑定写入，之后同样不可变更。
    const c2 = await store.claim({ appId: 'cli_app', messageId: 'm2_bind' })
    assert.equal(c2.record.sessionExisted, null, 'unknown checkpoint stays null at claim')
    const firstBind = await store.bindRoute(c2.record.key, { sessionId: 'sess-C', sessionExisted: false })
    assert.equal(firstBind.sessionExisted, false, 'checkpoint written on first bind')
    await assert.rejects(() => store.bindRoute(c2.record.key, { sessionId: 'sess-C', sessionExisted: true }), (error) => error.code === 'route_conflict', 'written checkpoint never changes in any direction')
    await store.close()
  }

  // ---------- M2：每 open 独立 lease 句柄，close 各自幂等，不互相关闭 ----------
  {
    const dir = await makeRoot()
    const a = await openLarkDedupStore(dir)
    const b = await openLarkDedupStore(dir)
    assert.notEqual(a, b, 'each open returns an independent lease handle')
    assert.equal(a.stats().liveRecords, 0, 'both share the same underlying store state view')
    await a.claim({ appId: 'cli_app', messageId: 'lease1', chatId: 'oc_1' })
    await a.close()
    await a.close() // 重复 close 幂等：只减一次引用
    const claim = await b.claim({ appId: 'cli_app', messageId: 'lease2', chatId: 'oc_1' })
    assert.equal(claim.outcome, 'claimed', 'b survives a double close')
    assert.equal(b.stats().liveRecords, 2, 'shared store still live through b')
    await b.close()
    const c = await openLarkDedupStore(dir)
    assert.equal(c.stats().liveRecords, 2, 'fresh lease after full close sees the journal')
    await c.close()
    // 关闭中重开（N2）：close 的 drain 期间 open 不得复用 closing 实例。
    const d = await openLarkDedupStore(dir)
    const closing = d.close()
    const e = await openLarkDedupStore(dir) // 等 drain 后开新实例
    assert.notEqual(d, e, 'open during close waits and returns a fresh handle')
    assert.equal(e.stats().liveRecords, 2, 'fresh store reloaded from journal')
    await closing
    await e.claim({ appId: 'cli_app', messageId: 'after-reopen', chatId: 'oc_1' })
    await e.close()
  }

  // ---------- 证据门：flushed + admission 双严格（M4）----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    const c1 = await store.claim({ appId: 'cli_app', messageId: 'ev1', chatId: 'oc_1' })
    await assert.rejects(() => store.settleDelivered(c1.record.key, { flushed: true }), (error) => error.code === 'bad_evidence', 'admission missing → refuse delivered')
    await assert.rejects(() => store.settleDelivered(c1.record.key, { flushed: false, admission: 'admitted' }), (error) => error.code === 'bad_evidence', 'flushed:false → refuse')
    await assert.rejects(() => store.settleDelivered(c1.record.key, { flushed: true, admission: 'uncertain' }), (error) => error.code === 'bad_evidence', 'uncertain admission → refuse')
    await assert.rejects(() => store.settleDelivered(c1.record.key, { flushed: true, admission: { verdict: 'not_admitted' } }), (error) => error.code === 'bad_evidence', 'verdict object must say admitted')
    await store.settleDelivered(c1.record.key, { flushed: true, admission: { verdict: 'admitted', reason: 'projection' } })
    assert.equal(store.get(c1.record.key).state, 'delivered', 'verdict object form accepted')
    const c2 = await store.claim({ appId: 'cli_app', messageId: 'ev2', chatId: 'oc_1' })
    await assert.rejects(() => store.settleRejected(c2.record.key, { noticeDelivered: false }), (error) => error.code === 'bad_evidence', 'rejected needs noticeDelivered')
    await store.settleRejected(c2.record.key, { noticeDelivered: true })
    await store.close()
  }

  // ---------- 处理权与 recoverable：失败保持 claimed、可再取得 ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    const c = await store.claim({ appId: 'cli_app', messageId: 'f1', chatId: 'oc_1', chatType: 'group' })
    await assert.rejects(() => store.recordFailure(c.record.key, 'free text'), (error) => error.code === 'invalid_key', 'free-form error rejected')
    const failed = await store.recordFailure(c.record.key, 'agent_busy')
    assert.equal(failed.state, 'claimed', 'retryable failure keeps claimed')
    assert.equal(store.isProcessing(c.record.key), false, 'failure releases processing')
    await assert.rejects(() => store.settleDelivered(c.record.key, { flushed: true, admission: 'admitted' }), (error) => error.code === 'not_owner', 'settle requires ownership')
    const retaken = await store.claim({ appId: 'cli_app', messageId: 'f1' })
    assert.equal(retaken.outcome, 'recoverable', 'reclaim takes processing again')
    assert.equal(retaken.record.ledgerSeq, c.record.ledgerSeq, 'seq reused, never reallocated')
    assert.equal(retaken.record.userMessageId, c.record.userMessageId, 'id reused')
    assert.equal(retaken.record.attempts, 1, 'attempts bumped')
    await store.settleDelivered(c.record.key, { flushed: true, admission: 'admitted' })
    await store.close()
  }

  // ---------- orphaned ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    const c = await store.claim({ appId: 'cli_old', messageId: 'o1', chatId: 'oc_1' })
    await store.markOrphaned(c.record.key)
    const dup = await store.claim({ appId: 'cli_old', messageId: 'o1' })
    assert.equal(dup.outcome, 'duplicate-terminal', 'orphaned is terminal for dedup')
    assert.equal(store.recover().length, 0, 'orphaned not re-scheduled')
    await store.close()
  }

  // ---------- D1：fsync 失败（字节可能已落盘）→ store poisoned、seq 不复用、重开恢复 ----------
  {
    const dir = await makeRoot()
    let failOnce = true
    const fsImpl = faultyFs({
      failSync: (kind) => kind === 'journal' && failOnce ? (failOnce = false) || true : false,
    })
    // failSync 的一次性语义：包装内已处理，这里直接传函数。
    fsImpl.open = async (target, atFlags, mode) => {
      const handle = await fsp.open(target, atFlags, mode)
      if (atFlags !== 'a') return handle
      let failed = false
      return {
        write: (...args) => handle.write(...args),
        sync: async () => {
          if (!failed) {
            failed = true
            const error = new Error('EIO injected fsync failure')
            error.code = 'EIO'
            throw error
          }
          return handle.sync()
        },
        close: (...args) => handle.close(...args),
        truncate: (...args) => handle.truncate(...args),
        stat: (...args) => handle.stat(...args),
        fd: handle.fd,
      }
    }
    const store = await openLarkDedupStore(dir, { fs: fsImpl })
    await assert.rejects(
      () => store.claim({ appId: 'a', messageId: 'm1' }),
      (error) => error instanceof LarkDedupError && error.code === 'write_failed',
      'D1: fsync failure rejects the claim (durability uncertain)',
    )
    assert.equal(store.stats().poisoned, true, 'D1: store poisoned after write failure')
    assert.equal(store.recover().length, 0, 'D1: memory not committed for the failed claim')
    await assert.rejects(
      () => store.claim({ appId: 'a', messageId: 'm2' }),
      (error) => error.code === 'store_poisoned',
      'D1: all shared holders refuse further writes after poison',
    )
    await store.close()
    // 重开：撕裂尾截断/完整行保留，seq 唯一单调（不复用失败行的 seq——若字节已落盘该行存活，counter 读回它；若半行被截断该 seq 连同记录一起消失）。
    const reopened = await openLarkDedupStore(dir)
    const journalLines = fs.readFileSync(path.join(dir, LARK_DEDUP_JOURNAL_NAME), 'utf8').split('\n').filter(Boolean)
    const seqs = journalLines.map((line) => JSON.parse(line)).filter((o) => o.k === 'd').map((o) => o.q)
    assert.equal(new Set(seqs).size, seqs.length, 'D1: journal seq values are unique after recovery')
    const m2 = await reopened.claim({ appId: 'a', messageId: 'm2' })
    assert.equal(m2.outcome, 'claimed', 'D1: reopen recovers a usable store')
    assert.equal(seqs.includes(m2.record.ledgerSeq), false, 'D1: the new seq does not collide with any surviving journal seq')
    await reopened.close()
  }

  // ---------- D2：部分写（残行）后不继续 append → poison；重开截断修复 ----------
  {
    const dir = await makeRoot()
    let partialOnce = true
    const fsImpl = faultyFs()
    const realOpen = fsImpl.open
    fsImpl.open = async (target, atFlags, mode) => {
      const handle = await realOpen(target, atFlags, mode)
      if (atFlags !== 'a' || !partialOnce) return handle
      partialOnce = false
      return {
        write: async (buf, offset, length) => {
          // 只写 20 字节（残行）再抛。
          await handle.write(buf, offset, Math.min(20, length === undefined ? buf.length : length))
          const error = new Error('EIO injected partial write')
          error.code = 'ENOSPC'
          throw error
        },
        sync: (...args) => handle.sync(...args),
        close: (...args) => handle.close(...args),
        truncate: (...args) => handle.truncate(...args),
        stat: (...args) => handle.stat(...args),
        fd: handle.fd,
      }
    }
    const store = await openLarkDedupStore(dir, { fs: fsImpl })
    await assert.rejects(() => store.claim({ appId: 'a', messageId: 'p1' }), (error) => error.code === 'write_failed', 'D2: partial write rejects the claim')
    await assert.rejects(() => store.claim({ appId: 'a', messageId: 'p2' }), (error) => error.code === 'store_poisoned', 'D2: no append lands after a torn line (poison, not appended-after-fragment)')
    await store.close()
    const reopened = await openLarkDedupStore(dir) // 截断到完整偏移（本例只剩残行 → 空 journal）
    const content = fs.readFileSync(path.join(dir, LARK_DEDUP_JOURNAL_NAME), 'utf8')
    const parses = content.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true } catch { return false } })
    assert.equal(parses, true, 'D2: torn tail truncated; every remaining line parses')
    assert.equal(content.split('\n').filter(Boolean).length, 0, 'D2: the 20-byte fragment is gone, not left as a middle-corrupt line')
    const p2 = await reopened.claim({ appId: 'a', messageId: 'p2' })
    assert.equal(p2.outcome, 'claimed', 'D2: reopen + append works after repair')
    await reopened.close()
  }

  // ---------- D3：rename 成功 + 目录 fsync 失败 → 换新 fd/不写旧 inode/poison；重开恢复 ----------
  {
    const dir = await makeRoot()
    let failDir = false
    const fsImpl = faultyFs({ failDirSync: (target, atFlags) => failDir && atFlags === 'r' })
    const store = await openLarkDedupStore(dir, { fs: fsImpl })
    for (let i = 0; i < 3; i += 1) await store.claim({ appId: 'a', messageId: 'c' + i })
    failDir = true
    await assert.rejects(() => store.compact(), (error) => error.code === 'write_failed', 'D3: explicit compact surfaces dirsync failure')
    assert.equal(store.stats().poisoned, true, 'D3: dirsync failure after rename poisons (durability uncertain)')
    failDir = false
    await assert.rejects(() => store.claim({ appId: 'a', messageId: 'after' }), (error) => error.code === 'store_poisoned', 'D3: never writes through the stale fd — claim refused, no phantom success')
    await store.close()
    const reopened = await openLarkDedupStore(dir)
    const lines = fs.readFileSync(path.join(dir, LARK_DEDUP_JOURNAL_NAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.filter((o) => o.k === 'd').length, 3, 'D3: compaction result durable; reopen sees all three records')
    assert.equal(reopened.stats().liveRecords, 3, 'D3: reopen recovers')
    await reopened.close()
  }

  // ---------- D4：自动压缩失败不改变 claim/settle 的 durable 结果（计数不 throw）----------
  {
    const dir = await makeRoot()
    let failRename = false
    const fsImpl = faultyFs({ failRename: (from) => failRename && String(from).includes('.tmp.') })
    const store = await openLarkDedupStore(dir, { fs: fsImpl, ttlMs: 1 })
    // 先正常跑一轮（压缩成功重置行数）。
    for (let i = 0; i < 40; i += 1) {
      const r = await store.claim({ appId: 'a', messageId: 'g' + i })
      await store.settleDelivered(r.record.key, { flushed: true, admission: 'admitted' })
    }
    // 开启压缩故障，继续 claim+settle：行数增长（终态从内存逐出→live 小）越过阈值后
    // 自动压缩必然被触发并失败（被 #maintain 吸收）。
    failRename = true
    for (let i = 0; i < 200 && store.stats().compactionErrors === 0; i += 1) {
      const r = await store.claim({ appId: 'a', messageId: 'warm' + i })
      await pause(2)
      await store.settleDelivered(r.record.key, { flushed: true, admission: 'admitted' })
    }
    assert.ok(store.stats().compactionErrors >= 1, 'D4: auto-compaction failure happens and is counted (not swallowed silently)')
    assert.ok(LARK_COMPACT_ERROR_STAGES.includes(store.stats().lastCompactionError), 'D4: compaction error recorded as a fixed enum')
    assert.equal(store.stats().poisoned, false, 'D4: pre-rename compaction failure does NOT poison (previous journal kept)')
    // claim 路径：记录 append 成功即真实成功；压缩失败只计数（不改变返回、不杀 inFlight）。
    const victim = await store.claim({ appId: 'a', messageId: 'victim' })
    assert.equal(victim.outcome, 'claimed', 'D4: claim succeeds even when auto-compaction fails (caller holds responsibility)')
    assert.equal(store.isProcessing(victim.record.key), true, 'D4: processing right held — no orphaned inFlight')
    // 平台重投：调用方拿到 claimed 会处理 → duplicate-inflight（不是死锁）。
    const redeliver = await store.claim({ appId: 'a', messageId: 'victim' })
    assert.equal(redeliver.outcome, 'duplicate-inflight', 'D4: redelivery after a *successful* claim dedups as inflight (caller owns processing)')
    // settle 路径：durable 后压缩失败不改返回。
    const settled = await store.settleDelivered(victim.record.key, { flushed: true, admission: 'admitted' })
    assert.equal(settled.state, 'delivered', 'D4: durable settle result unchanged by maintenance failure')
    // settle 后立即验盘：delivered 行已 fsync 进 journal（后续 TTL 逐出/压缩属合法保留策略）。
    const diskLines = fs.readFileSync(path.join(dir, LARK_DEDUP_JOURNAL_NAME), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const victimRow = diskLines.filter((o) => o.k === 'd' && o.key === victim.record.key).pop()
    assert.equal(victimRow && victimRow.st, 'delivered', 'D4: durable delivered row lands on disk despite maintenance failure')
    // TTL 极短 + 持续压缩失败：不得背压锁死（原 p6 反向断言）。
    for (let i = 0; i < 20; i += 1) {
      const r = await store.claim({ appId: 'a', messageId: 'ttl' + i })
      await pause(2)
      await store.settleDelivered(r.record.key, { flushed: true, admission: 'admitted' })
    }
    assert.ok(store.stats().claims >= 61, 'D4: short-TTL churn never wedges on repeated compaction failure')
    failRename = false
    await store.compact() // 显式压缩恢复（维护失败后可正常收敛）
    const seqBeforeClose = store.stats().ledgerSeq
    await store.close()
    const reopened = await openLarkDedupStore(dir)
    assert.ok(reopened.stats().ledgerSeq >= seqBeforeClose, 'D4: reopen recovers journal + retains the seq watermark after failed-compaction churn')
    const postChurn = await reopened.claim({ appId: 'a', messageId: 'post-churn' })
    assert.equal(postChurn.outcome, 'claimed', 'D4: store fully functional after recovery')
    await reopened.close()
  }

  // ---------- M4 变体 + 证据门在 D4 后仍严格（admission 不能被压缩失败带过）----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    const c = await store.claim({ appId: 'a', messageId: 'strict' })
    await assert.rejects(() => store.settleDelivered(c.record.key, { flushed: true }), (error) => error.code === 'bad_evidence', 'admission gate stays strict regardless of maintenance state')
    await store.close()
  }

  // ---------- 发送 receipt（kind:'send'）----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    const imageSha = 'a1'.repeat(32)
    const digest = larkSendDigest({ imageSha256: imageSha, mode: 'card', caption: '', appId: 'cli', conversation: 'oc_1' })

    // 并发 begin：同 uuid 仅一个 acquired。
    const [b1, b2] = await Promise.all([
      store.sendReceipts.begin({ uuid: 'call-1', digest, now: 1000 }),
      store.sendReceipts.begin({ uuid: 'call-1', digest, now: 1001 }),
    ])
    const outcomes = [b1.outcome, b2.outcome].sort()
    assert.deepEqual(outcomes, ['acquired', 'in_progress'], 'send: two concurrent begins yield exactly one acquired')
    const acquired = b1.outcome === 'acquired' ? b1 : b2
    assert.equal(acquired.record.firstDispatchAt, b1.outcome === 'acquired' ? 1000 : 1001, 'firstDispatchAt is the authoritative begin time')
    assert.equal(typeof acquired.record.ownerToken, 'string', 'acquired carries an owner token')
    // 同 uuid 不同 digest → conflict。
    const otherDigest = larkSendDigest({ imageSha256: 'b2'.repeat(32), mode: 'card', caption: '', appId: 'cli', conversation: 'oc_1' })
    const conflicted = await store.sendReceipts.begin({ uuid: 'call-1', digest: otherDigest, now: 2000 })
    assert.equal(conflicted.outcome, 'conflict', 'same uuid with a different digest refuses the new trade')
    // finish 校验 owner：伪造 token 拒绝。
    await assert.rejects(
      () => store.sendReceipts.finish({ uuid: 'call-1', ownerToken: 'forged', state: 'sent', messageId: 'om_fake' }),
      (error) => error.code === 'send_not_owner',
      'finish requires the live owner token',
    )
    // 平台成功但 receipt 写失败 → poison + throw（不假成功）。
    const dir2 = await makeRoot()
    let syncCalls = 0
    const writeFailFs = faultyFs()
    const baseOpen = writeFailFs.open
    writeFailFs.open = async (target, atFlags, mode) => {
      const handle = await baseOpen(target, atFlags, mode)
      if (atFlags !== 'a') return handle
      return {
        write: (...args) => handle.write(...args),
        sync: async () => {
          syncCalls += 1
          if (syncCalls === 2) { // 第1次=begin 落盘，第2次=finish 落盘
            const error = new Error('EIO injected fsync failure on finish')
            error.code = 'EIO'
            throw error
          }
          return handle.sync()
        },
        close: (...args) => handle.close(...args),
        truncate: (...args) => handle.truncate(...args),
        stat: (...args) => handle.stat(...args),
        fd: handle.fd,
      }
    }
    const store2 = await openLarkDedupStore(dir2, { fs: writeFailFs })
    const b = await store2.sendReceipts.begin({ uuid: 'call-x', digest, now: 100 })
    assert.equal(b.outcome, 'acquired', 'begin durable before any platform call')
    await assert.rejects(
      () => store2.sendReceipts.finish({ uuid: 'call-x', ownerToken: b.record.ownerToken, state: 'sent', messageId: 'om_plat' }),
      (error) => error.code === 'write_failed',
      'finish fsync failure throws (caller reports unknown outward; never fake success)',
    )
    assert.equal(store2.stats().poisoned, true, 'finish write failure poisons the store')
    await store2.close()
    const store2r = await openLarkDedupStore(dir2)
    // fsync 失败=不确定落盘：进程内绝不返回成功（上面已 throw）；重开后以 durable journal
    // 为准——字节已在则 journal 权威为 sent（平台确实成功，不是假成功），否则仍是
    // dispatching→unknown（可核实）。两种都合法，关键是内存从未谎报。
    const recovered = store2r.sendReceipts.get('call-x')
    assert.ok(['sent', 'unknown', 'dispatching'].includes(recovered.state), 'recovery follows the durable journal, never an in-memory fiction: ' + recovered.state)
    if (recovered.state === 'sent') {
      assert.equal(recovered.messageId, 'om_plat', 'if the journal landed, it carries the real platform messageId')
      const replayAfterCrash = await store2r.sendReceipts.begin({ uuid: 'call-x', digest, now: 5000 })
      assert.equal(replayAfterCrash.outcome, 'sent', 'replayed from journal as sent (zero re-acquire)')
      assert.equal(store2r.stats().sendAcquired, 0, 'zero new acquisitions on replay')
    } else {
      const beginAgain = await store2r.sendReceipts.begin({ uuid: 'call-x', digest, now: 5000 })
      assert.equal(beginAgain.outcome, 'unknown', 'unfinished business is unknown, never auto re-dispatched')
    }
    await store2r.close()

    // 崩溃遗留 dispatching（begin 已 durable、进程未 finish 就死）→ unknown，不自动重派。
    const dirCrash = await makeRoot()
    const crashStore = await openLarkDedupStore(dirCrash)
    const left = await crashStore.sendReceipts.begin({ uuid: 'call-crash', digest, now: 100 })
    assert.equal(left.outcome, 'acquired', 'begin durable before the crash')
    await crashStore.close() // 模拟进程死亡（不 finish）
    const crashReopen = await openLarkDedupStore(dirCrash)
    const crashedRow = crashReopen.sendReceipts.get('call-crash')
    assert.equal(crashedRow.state, 'unknown', 'restart leftover dispatching is normalized to unknown')
    assert.equal(crashedRow.reason, 'interrupted', 'leftover carries the interrupted reason')
    assert.equal(crashedRow.firstDispatchAt, 100, 'firstDispatchAt never restarts after a crash')
    assert.equal(crashedRow.messageId, null, 'no messageId invented')
    const retryAfterCrash = await crashReopen.sendReceipts.begin({ uuid: 'call-crash', digest, now: 5000 })
    assert.equal(retryAfterCrash.outcome, 'unknown', 'restart leftover is never auto re-dispatched (returns a verification hint state)')
    assert.equal(retryAfterCrash.record.firstDispatchAt, 100, 'firstDispatchAt stays authoritative across the retry')
    await assert.rejects(
      () => crashReopen.sendReceipts.finish({ uuid: 'call-crash', ownerToken: left.record.ownerToken, state: 'sent', messageId: 'om_late' }),
      (error) => error.code === 'send_not_owner',
      'a pre-crash ownerToken cannot finish after restart',
    )
    await crashReopen.close()

    // sent 后重复 begin → 返回原结果、零新增 acquired（幂等零重发）。
    const fin = await store.sendReceipts.finish({ uuid: 'call-1', ownerToken: acquired.record.ownerToken, state: 'sent', messageId: 'om_real' })
    assert.equal(fin.state, 'sent', 'owner finish lands sent')
    assert.equal(fin.messageId, 'om_real', 'messageId recorded internally')
    const again = await store.sendReceipts.begin({ uuid: 'call-1', digest, now: 9999 })
    assert.equal(again.outcome, 'sent', 'sent receipt replays the original result')
    assert.equal(again.record.messageId, 'om_real', 'original messageId returned')
    assert.equal(again.record.firstDispatchAt, acquired.record.firstDispatchAt, 'firstDispatchAt never restarts on replay')
    assert.equal(store.stats().sendAcquired, 1, 'replay performs zero new acquisitions')
    // get：未知 uuid → null；journal 坏记录 → 打开即抛，不当新交易。
    assert.equal(store.sendReceipts.get('nope'), null, 'unknown uuid is null, not a new trade')
    // reason 固定枚举。
    const r2 = await store.sendReceipts.begin({ uuid: 'call-2', digest, now: 10 })
    await assert.rejects(() => store.sendReceipts.finish({ uuid: 'call-2', ownerToken: r2.record.ownerToken, state: 'rejected', reason: 'my reason' }), (error) => error.code === 'invalid_key', 'free-form finish reasons rejected')
    assert.ok(LARK_SEND_REASONS.includes('scope_missing'), 'fixed reason enum exported')
    await store.sendReceipts.finish({ uuid: 'call-2', ownerToken: r2.record.ownerToken, state: 'rejected', reason: 'scope_missing' })
    const replay2 = await store.sendReceipts.begin({ uuid: 'call-2', digest, now: 11 })
    assert.equal(replay2.outcome, 'rejected', 'rejected receipt replays as rejected')
    // 满容量背压（不 FIFO/TTL 静默删）。
    const dir3 = await makeRoot()
    const small = await openLarkDedupStore(dir3, { sendCapacity: 2 })
    await small.sendReceipts.begin({ uuid: 'cap-1', digest, now: 1 })
    await small.sendReceipts.begin({ uuid: 'cap-2', digest, now: 2 })
    await assert.rejects(() => small.sendReceipts.begin({ uuid: 'cap-3', digest, now: 3 }), (error) => error.code === 'at_capacity', 'send capacity backpressures instead of silently evicting')
    assert.equal(small.sendReceipts.get('cap-1').state, 'dispatching', 'no receipt evicted under pressure')
    assert.equal(small.stats().sendCapacityErrors, 1, 'capacity refusal counted anonymously')
    // stats 匿名分桶：send 与入站互不混淆、不泄漏。
    const statsText = JSON.stringify(store.stats())
    assert.equal(statsText.includes('om_real'), false, 'stats never leak messageIds')
    assert.equal(statsText.includes('call-1'), false, 'stats never leak uuids')
    assert.ok(Number.isSafeInteger(store.stats().sendSent), 'send buckets exist in stats')
    await small.close()
    await store.close()
  }

  // ---------- 发送记录 kind 隔离：journal 坏 kind 拒开 ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    await store.claim({ appId: 'a', messageId: 'k1' })
    const digest = larkSendDigest({ imageSha256: 'c3'.repeat(32), mode: 'card', caption: '', appId: 'a', conversation: 'oc' })
    await store.sendReceipts.begin({ uuid: 'kind-check', digest, now: 1 })
    await store.close()
    const journal = path.join(dir, LARK_DEDUP_JOURNAL_NAME)
    // kind 字段被改 → 严格 schema 拒开，两类记录互不误认。
    const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const sendRow = lines.find((o) => o.k === 's')
    sendRow.k = 'd' // 冒充入站记录
    fs.writeFileSync(journal, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    await assert.rejects(() => openLarkDedupStore(dir), (error) => error.code === 'corrupt_journal', 'send record cannot pass as a dedup record (strict field sets)')
  }

  // ---------- 冷恢复：claimed/终态/seq/namespace/route 保留 ----------
  {
    const dir = await makeRoot()
    let firstId = null
    let ns = null
    {
      const store = await openLarkDedupStore(dir)
      const c1 = await store.claim({ appId: 'cli_app', messageId: 'c1', chatId: 'oc_1', chatType: 'p2p', sessionId: 'sess-c1', sessionExisted: true })
      firstId = c1.record.userMessageId
      ns = c1.record.namespace
      const c2 = await store.claim({ appId: 'cli_app', messageId: 'c2', chatId: 'oc_1' })
      await store.settleDelivered(c2.record.key, { flushed: true, admission: 'admitted' })
      await store.close()
    }
    {
      const store = await openLarkDedupStore(dir)
      const rows = store.recover()
      assert.equal(rows.length, 1, 'cold rebuild lists only claimed')
      assert.equal(rows[0].userMessageId, firstId, 'id survives restart')
      assert.equal(rows[0].sessionId, 'sess-c1', 'route survives restart')
      const c3 = await store.claim({ appId: 'cli_app', messageId: 'c3', chatId: 'oc_1' })
      assert.equal(c3.record.ledgerSeq, 3, 'seq continues across cold rebuild')
      assert.equal(c3.record.namespace, ns, 'namespace survives restart')
      await store.close()
    }
  }

  // ---------- 高水位：压缩/全淘汰/空 journal 后不回退；safe 整数耗尽拒绝 ----------
  {
    const dir = await makeRoot()
    let lastSeq = 0
    let ns = null
    {
      const store = await openLarkDedupStore(dir, { ttlMs: 1, now: () => Date.now() })
      for (let i = 0; i < 5; i += 1) {
        const c = await store.claim({ appId: 'a', messageId: 'hw' + i })
        lastSeq = c.record.ledgerSeq
        ns = c.record.namespace
        await store.settleDelivered(c.record.key, { flushed: true, admission: 'admitted' })
        await pause(3)
      }
      await store.compact() // 全终态 + TTL 过期淘汰 → journal 只剩 meta
      assert.ok(store.stats().journalLines <= 1, 'compaction reduced journal to meta when all records evicted')
      await store.close()
    }
    {
      const store = await openLarkDedupStore(dir)
      const c = await store.claim({ appId: 'a', messageId: 'hw-after' })
      assert.ok(c.record.ledgerSeq > lastSeq, 'seq never regresses after compaction + total eviction')
      assert.equal(c.record.namespace, ns, 'namespace survives via meta')
      await store.close()
    }
    // meta 高水位顶到边界 → 明确拒绝（不静默回绕）。
    {
      const journal = path.join(dir, LARK_DEDUP_JOURNAL_NAME)
      const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      for (const line of lines) if (line.meta === 'seq') line.q = Number.MAX_SAFE_INTEGER
      for (const line of lines) if (line.k === 'd') line.q = Number.MAX_SAFE_INTEGER
      fs.writeFileSync(journal, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      const store = await openLarkDedupStore(dir)
      await assert.rejects(() => store.claim({ appId: 'a', messageId: 'exhausted' }), (error) => error.code === 'seq_exhausted', 'safe-integer exhaustion is explicit')
      await store.close()
    }
  }

  // ---------- 撕裂尾修复后再 append ----------
  {
    const dir = await makeRoot()
    {
      const store = await openLarkDedupStore(dir)
      await store.claim({ appId: 'a', messageId: 't1' })
      await store.close()
    }
    const journal = path.join(dir, LARK_DEDUP_JOURNAL_NAME)
    const before = fs.readFileSync(journal, 'utf8')
    fs.appendFileSync(journal, '{"v":1,"k":"d","key":"dead')
    {
      const store = await openLarkDedupStore(dir)
      assert.equal(fs.readFileSync(journal, 'utf8'), before, 'torn tail truncated to last complete offset')
      const t2 = await store.claim({ appId: 'a', messageId: 't2' })
      assert.equal(t2.outcome, 'claimed', 'append works after repair')
      await store.close()
    }
    {
      const store = await openLarkDedupStore(dir)
      assert.equal(store.recover().length, 2, 'clean parse after repair+append')
      await store.close()
    }
  }

  // ---------- 完整坏行/未知 kind/namespace 混用：拒开不清空 ----------
  {
    const dir = await makeRoot()
    {
      const store = await openLarkDedupStore(dir)
      await store.claim({ appId: 'a', messageId: 'x1' })
      await store.close()
    }
    const journal = path.join(dir, LARK_DEDUP_JOURNAL_NAME)
    const good = fs.readFileSync(journal, 'utf8')
    const goodRecord = JSON.parse(good.trim().split('\n').pop())
    const badLine = (obj) => JSON.stringify(obj) + '\n'
    const cases = [
      { name: 'garbage', raw: '{"v":1,,}\n' },
      { name: 'unknown version', raw: badLine({ ...goodRecord, v: 99 }) },
      { name: 'extra field', raw: badLine({ ...goodRecord, extra: 1 }) },
      { name: 'key mismatch', raw: badLine({ ...goodRecord, msg: 'other' }) },
      { name: 'foreign namespace', raw: badLine({ ...goodRecord, ns: 'deadbeef' }) },
      { name: 'unknown kind', raw: badLine({ ...goodRecord, k: 'x' }) },
      { name: 'blank line', raw: '\n' },
    ]
    for (const testCase of cases) {
      fs.appendFileSync(journal, testCase.raw)
      await assert.rejects(() => openLarkDedupStore(dir), (error) => error.code === 'corrupt_journal', 'corrupt refuses to open: ' + testCase.name)
      const after = fs.readFileSync(journal, 'utf8')
      assert.ok(after.endsWith(testCase.raw), 'journal never silently cleared: ' + testCase.name)
      fs.writeFileSync(journal, after.slice(0, -testCase.raw.length))
    }
    const store = await openLarkDedupStore(dir)
    assert.equal(store.recover().length, 1, 'valid prefix loads')
    await store.close()
  }

  // ---------- 容量背压（入站）：不吞新消息也不动旧记录 ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir, { maxClaimed: 2 })
    const a = await store.claim({ appId: 'a', messageId: 'bp1' })
    await store.claim({ appId: 'a', messageId: 'bp2' })
    await assert.rejects(() => store.claim({ appId: 'a', messageId: 'bp3' }), (error) => error.code === 'at_capacity', 'claimed capacity backpressures')
    assert.equal(store.recover().length, 2, 'existing claimed untouched')
    await store.settleDelivered(a.record.key, { flushed: true, admission: 'admitted' })
    const freed = await store.claim({ appId: 'a', messageId: 'bp3' })
    assert.equal(freed.outcome, 'claimed', 'settling frees capacity')
    await store.close()
  }

  // ---------- 终态 TTL/容量淘汰；claimed 永不逐出 ----------
  {
    const dir = await makeRoot()
    let clock = 1_000_000
    const store = await openLarkDedupStore(dir, { now: () => clock, ttlMs: 10_000, terminalCapacity: 2 })
    const t1 = await store.claim({ appId: 'a', messageId: 'ttl1' })
    await store.settleDelivered(t1.record.key, { flushed: true, admission: 'admitted' })
    clock += 100
    const t2 = await store.claim({ appId: 'a', messageId: 'ttl2' })
    await store.settleRejected(t2.record.key, { noticeDelivered: true })
    clock += 100
    const t3 = await store.claim({ appId: 'a', messageId: 'ttl3' })
    await store.settleDelivered(t3.record.key, { flushed: true, admission: 'admitted' })
    assert.equal(store.stats().evictedTerminal, 1, 'terminal capacity evicts oldest terminal')
    const stuck = await store.claim({ appId: 'a', messageId: 'stuck' })
    clock += 1_000_000
    await store.claim({ appId: 'a', messageId: 'other' })
    assert.ok(store.recover().some((row) => row.key === stuck.record.key), 'claimed never TTL-evicted')
    await store.close()
  }

  // ---------- 入参严格校验 / stats 匿名 ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    await assert.rejects(() => store.claim({ appId: '', messageId: 'x' }), (error) => error.code === 'invalid_key')
    await assert.rejects(() => store.claim({ appId: 'a', messageId: 'x'.repeat(600) }), (error) => error.code === 'invalid_key')
    const c = await store.claim({ appId: 'cli_secret', messageId: 'om_secret', chatId: 'oc_secret' })
    await store.recordFailure(c.record.key, 'interrupted')
    const statsText = JSON.stringify(store.stats())
    for (const secret of ['cli_secret', 'om_secret', 'oc_secret', c.record.userMessageId]) {
      assert.equal(statsText.includes(secret), false, 'stats anonymous: no ' + secret)
    }
    await store.close()
  }

  // ---------- 持锁文件永不删除（宿主 lease.ts 策略）；内容仅诊断 ----------
  {
    const dir = await makeRoot()
    const store = await openLarkDedupStore(dir)
    const lockPath = path.join(dir, LARK_DEDUP_LOCK_NAME)
    assert.ok(fs.existsSync(lockPath), 'lock file exists while holding')
    // 持锁期人为改写内容（诊断元数据，内核锁不受影响）。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'foreign', at: 1 }) + '\n')
    await store.claim({ appId: 'cli_app', messageId: 'metadata' })
    await store.close()
    assert.ok(fs.existsSync(lockPath), 'close never unlinks the lock file (POSIX lock binds the inode; unlink/replace would split two flock-able inodes)')
    const rows = fs.readdirSync(dir).filter((n) => n.includes('.stale.') || n.includes('.steal.') || n.includes('.tmp.'))
    assert.deepEqual(rows, [], 'no takeover/publish residue exists in the flock-only protocol')
  }

  // ---------- 子进程：存活 writer 拒绝 + 进程崩溃后内核自动释放 ----------
  {
    const dir = await makeRoot()
    const moduleUrl = pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href
    const holderScript = path.join(dir, 'holder.mjs')
    fs.writeFileSync(holderScript, [
      `import { openLarkDedupStore } from ${JSON.stringify(moduleUrl)}`,
      `const store = await openLarkDedupStore(${JSON.stringify(dir)})`,
      "await store.claim({ appId: 'cli_app', messageId: 'held' })",
      'process.stdout.write("HELD\\n")',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const holder = spawn(process.execPath, [holderScript], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise((resolve) => holder.stdout.once('data', resolve))
    await assert.rejects(() => openLarkDedupStore(dir), (error) => error.code === 'lock_held', 'live second writer refused (kernel flock contention)')
    holder.kill('SIGKILL') // 崩溃（不 close、不释放 fd）
    await collectExit(holder)
    await pause(60)
    // 内核随进程死亡自动释放锁：直接接管成功，无需任何“偷锁”路径。
    const store = await openLarkDedupStore(dir)
    assert.equal(store.recover().length, 1, 'claim survives crash (kernel released the flock)')
    assert.equal(store.stats().lockMode, 'flock', 'reopened under flock')
    assert.ok(fs.existsSync(path.join(dir, LARK_DEDUP_LOCK_NAME)), 'lock file persists across acquire/release (host policy: never removed)')
    await store.close()
    assert.ok(fs.existsSync(path.join(dir, LARK_DEDUP_LOCK_NAME)), 'close still does not unlink')
  }

  // ---------- D5：多子进程同时争抢 + 崩溃释放后无阻塞，多轮恰一写者 ----------
  {
    const moduleUrl = pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href
    let badRounds = 0
    for (let round = 0; round < 3; round += 1) {
      const dir = await makeRoot()
      fs.writeFileSync(path.join(dir, LARK_DEDUP_JOURNAL_NAME), '')
      const childScript = path.join(dir, 'child.mjs')
      fs.writeFileSync(childScript, [
        `import { openLarkDedupStore } from ${JSON.stringify(moduleUrl)}`,
        `try { const s = await openLarkDedupStore(${JSON.stringify(dir)})`,
        'console.log("OPEN " + process.pid)',
        'await new Promise(r => setTimeout(r, 250))',
        'await s.close()',
        'console.log("DONE")',
        '} catch (e) { console.log("FAIL " + e.code) }',
      ].join('\n'))
      const runs = await Promise.all([1, 2, 3, 4].map(() => new Promise((resolve) => {
        const p = spawn(process.execPath, [childScript])
        let out = ''
        p.stdout.on('data', (d) => { out += d })
        p.on('close', () => resolve(out.trim()))
      })))
      const winners = runs.filter((r) => r.startsWith('OPEN'))
      const failures = runs.filter((r) => r.startsWith('FAIL')).map((r) => r.split(' ')[1])
      const ok = winners.length === 1 && failures.every((code) => code === 'lock_held')
      if (!ok) badRounds += 1
      assert.equal(ok, true, 'round ' + String(round) + ': exactly one concurrent winner, losers all lock_held (winners=' + String(winners.length) + ', fails=' + failures.join(',') + ')')
      // 赢家进程崩溃（不 close）→ 后续进程必须能直接拿到锁（内核释放，无人工介入）。
      const winnerPid = Number(winners[0].split('\n')[0].split(' ')[1])
      const crashScript = path.join(dir, 'crasher.mjs')
      fs.writeFileSync(crashScript, [
        `import { openLarkDedupStore } from ${JSON.stringify(moduleUrl)}`,
        `const s = await openLarkDedupStore(${JSON.stringify(dir)})`,
        'process.stdout.write("ACQUIRED\\n")',
        'process.exit(9)', // 不 close：崩溃遗留 fd（若内核不释放，后续必阻）
      ].join('\n'))
      void winnerPid
      const crasher = spawn(process.execPath, [crashScript])
      let crashOut = ''
      crasher.stdout.on('data', (d) => { crashOut += d })
      await collectExit(crasher)
      assert.ok(crashOut.includes('ACQUIRED'), 'round ' + String(round) + ': crasher acquired after the round')
      const after = spawn(process.execPath, [childScript])
      let afterOut = ''
      after.stdout.on('data', (d) => { afterOut += d })
      await collectExit(after)
      assert.ok(afterOut.includes('OPEN'), 'round ' + String(round) + ': kernel flock released on process death (no manual takeover needed): ' + afterOut.trim())
    }
    assert.equal(badRounds, 0, 'D5: no round produced two simultaneous writers')
  }

  // ---------- 能力缺失：lock_unavailable 拒绝启用（绝不回退不可靠锁）+ 空锁内容不阻塞 ----------
  {
    const dir = await makeRoot()
    await assert.rejects(
      () => openLarkDedupStore(dir, { flock: null }),
      (error) => error instanceof LarkDedupError && error.code === 'lock_unavailable',
      'missing flock capability refuses to start the ledger (no silent fallback)',
    )
    assert.equal(fs.existsSync(path.join(dir, LARK_DEDUP_LOCK_NAME)), false, 'failed open leaves no lock file')
    // 空/异主内容的锁文件：内核锁是唯一仲裁，元数据仅诊断，不阻塞。
    fs.writeFileSync(path.join(dir, LARK_DEDUP_LOCK_NAME), '')
    const store = await openLarkDedupStore(dir)
    const claimed = await store.claim({ appId: 'cli_app', messageId: 'empty-lock' })
    assert.equal(claimed.outcome, 'claimed', 'empty lock content never blocks the kernel lock (metadata is diagnostic only)')
    await store.close()
  }

  await Promise.all(tempRoots.map((dir) => fsp.rm(dir, { recursive: true, force: true })))
  assert.deepEqual(unhandled, [], 'no unhandled rejections leaked')
  console.log('lark-dedup: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
