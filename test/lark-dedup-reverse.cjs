// 原始故障探针 /tmp/dsh-dedup-probe/{p1,p2,p4,p5,p6}.mjs 的逐项反向断言（适配冻结后 API）。
// 原探针按旧契约编写（settle 无 admission、失败后继续写），直接跑会在新语义处抛错；
// 本文件把每个场景重放并断言"修复后的行为"，输出逐项 REVERSE 结果。
// 真实临时磁盘 + 故障注入；不碰 index/image/client/package。
require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const unhandled = []
process.on('unhandledRejection', (err) => { unhandled.push(err) })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''))
}

// 包装真实 fs.promises：按开关注入写/fsync/rename/目录同步故障。
function inject(base, hooks) {
  const wrap = (handle) => ({
    write: async (...args) => {
      if (hooks.shortWrite) {
        hooks.shortWrite = false
        const buf = args[0]
        await handle.write(typeof buf === 'string' ? buf.slice(0, 20) : buf.subarray(0, 20))
        const error = new Error('ENOSPC injected short write')
        error.code = 'ENOSPC'
        throw error
      }
      return handle.write(...args)
    },
    sync: async (...args) => {
      if (hooks.syncFail) {
        hooks.syncFail = false
        const error = new Error('EIO injected fsync failure')
        error.code = 'EIO'
        throw error
      }
      return handle.sync(...args)
    },
    close: (...args) => handle.close(...args),
    truncate: (...args) => handle.truncate(...args),
    stat: (...args) => handle.stat(...args),
    fd: handle.fd,
  })
  return {
    mkdir: base.mkdir, rename: base.rename, readFile: base.readFile, stat: base.stat,
    truncate: base.truncate, unlink: base.unlink, chmod: base.chmod, link: base.link,
    open: async (target, flags, mode) => {
      const handle = await base.open(target, flags, mode)
      if (flags === 'a' && (hooks.syncFail || hooks.shortWrite)) return wrap(handle)
      if (flags === 'r' && hooks.dirSyncFail) {
        return { ...wrap(handle), sync: async () => { throw new Error('EIO injected directory fsync failure') } }
      }
      return handle
    },
    rename: hooks.renameFail
      ? async (from, to) => {
        if (String(from).includes('.tmp.')) { throw new Error('EIO injected rename failure') }
        return base.rename(from, to)
      }
      : base.rename,
  }
}

async function main() {
  const dedup = await import(pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href)
  const { openLarkDedupStore, larkDedupKey, larkSendDigest, LARK_DEDUP_LOCK_NAME } = dedup
  const tmpRoots = []
  const mk = async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dedup-reverse-'))
    tmpRoots.push(dir)
    return dir
  }
  const base = {
    mkdir: fsp.mkdir, rename: fsp.rename, readFile: fsp.readFile, stat: fsp.stat,
    truncate: fsp.truncate, unlink: fsp.unlink, chmod: fsp.chmod, link: fsp.link, open: fsp.open,
  }
  const readSeqs = (dir) => fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))

  // ===== R1（原 p1-A）：fsync 失败后不复用 seq、不假成功 =====
  {
    const dir = await mk()
    const hooks = { syncFail: true }
    const store = await openLarkDedupStore(dir, { fs: inject(base, hooks) })
    let firstCode = null
    try { await store.claim({ appId: 'a', messageId: 'm1' }) } catch (e) { firstCode = e.code }
    check('R1 p1-A fsync failure → write_failed (never a fake success)', firstCode === 'write_failed', 'code=' + String(firstCode))
    check('R1 p1-A store poisoned after durability-uncertain write', store.stats().poisoned === true)
    let secondCode = null
    try { await store.claim({ appId: 'a', messageId: 'm2' }) } catch (e) { secondCode = e.code }
    check('R1 p1-A next claim refuses (store_poisoned, not a duplicate-seq write)', secondCode === 'store_poisoned', 'code=' + String(secondCode))
    await store.close()
    const reopened = await openLarkDedupStore(dir)
    const seqs = readSeqs(dir).filter((o) => o.k === 'd').map((o) => o.q)
    check('R1 p1-A journal seq unique after reopen', new Set(seqs).size === seqs.length, 'seqs=' + JSON.stringify(seqs))
    const m2 = await reopened.claim({ appId: 'a', messageId: 'm2' })
    check('R1 p1-A reopen recovers; new seq collides with none in journal', m2.outcome === 'claimed' && !seqs.includes(m2.record.ledgerSeq), 'seq=' + String(m2.record.ledgerSeq))
    await reopened.close()
  }

  // ===== R2（原 p2-B）：短写残行后不继续 append；重开截断修复 =====
  {
    const dir = await mk()
    const hooks = { shortWrite: true }
    const store = await openLarkDedupStore(dir, { fs: inject(base, hooks) })
    let code = null
    try { await store.claim({ appId: 'a', messageId: 'p1' }) } catch (e) { code = e.code }
    check('R2 p2-B partial write → write_failed', code === 'write_failed', 'code=' + String(code))
    let code2 = null
    try { await store.claim({ appId: 'a', messageId: 'p2' }) } catch (e) { code2 = e.code }
    check('R2 p2-B no append lands after the torn line (poisoned, not middle-corrupt)', code2 === 'store_poisoned', 'code=' + String(code2))
    await store.close()
    const reopened = await openLarkDedupStore(dir)
    const lines = readSeqs(dir)
    check('R2 p2-B reopen: torn tail truncated, every line valid JSON', lines.length === 0 || lines.every((o) => o.k === 'd' || o.meta === 'seq'), 'lines=' + String(lines.length))
    const again = await reopened.claim({ appId: 'a', messageId: 'p2' })
    check('R2 p2-B append works after repair', again.outcome === 'claimed')
    await reopened.close()
  }

  // ===== R3（原 p2-C）：rename 成功 + 目录 fsync 失败 → 换 fd/不写旧 inode/poison =====
  {
    const dir = await mk()
    const hooks = { dirSyncFail: false }
    const store = await openLarkDedupStore(dir, { fs: inject(base, hooks) })
    for (let i = 0; i < 3; i += 1) await store.claim({ appId: 'a', messageId: 'c' + i })
    hooks.dirSyncFail = true
    let compactCode = null
    try { await store.compact() } catch (e) { compactCode = e.code }
    check('R3 p2-C dirsync failure after rename → write_failed + poisoned', compactCode === 'write_failed' && store.stats().poisoned === true, 'code=' + String(compactCode))
    hooks.dirSyncFail = false
    let claimCode = null
    try { await store.claim({ appId: 'a', messageId: 'after' }) } catch (e) { claimCode = e.code }
    check('R3 p2-C subsequent claim refused (old-fd write impossible, no phantom success)', claimCode === 'store_poisoned', 'code=' + String(claimCode))
    await store.close()
    const reopened = await openLarkDedupStore(dir)
    const rows = readSeqs(dir).filter((o) => o.k === 'd')
    check('R3 p2-C journal intact after reopen (compaction result durable, nothing lost)', rows.length === 3, 'rows=' + String(rows.length))
    await reopened.close()
  }

  // ===== R4（原 p2-E 反向断言，flock 改造后语义）：空锁内容不阻塞内核锁；能力缺失→固定 lock_unavailable =====
  {
    const dir = await mk()
    // 能力缺失：固定 lock_unavailable 拒绝启用，绝不回退不可靠锁。
    let unavailableCode = null
    try { await openLarkDedupStore(dir, { flock: null }) } catch (e) { unavailableCode = e.code }
    check('R4 p2-E missing flock capability → lock_unavailable (no silent fallback)', unavailableCode === 'lock_unavailable', 'code=' + String(unavailableCode))
    check('R4 p2-E failed open leaves no lock file', fs.existsSync(path.join(dir, 'journal.lock')) === false)
    // 空/异主锁内容：元数据仅诊断，内核 flock 是唯一仲裁，不阻塞。
    fs.writeFileSync(path.join(dir, 'journal.lock'), '')
    const store = await openLarkDedupStore(dir)
    const r = await store.claim({ appId: 'a', messageId: 'empty-lock' })
    check('R4 p2-E empty lock content never blocks (kernel flock is the arbiter, metadata diagnostic only)', r.outcome === 'claimed', 'outcome=' + String(r.outcome))
    await store.close()
    check('R4 p2-E lock file persists after close (host lease policy: never unlink)', fs.existsSync(path.join(dir, 'journal.lock')) === true)
  }

  // ===== R5（原 p2-F）：双 close 不影响其他持有者（M2） =====
  {
    const dir = await mk()
    const a = await openLarkDedupStore(dir)
    const b = await openLarkDedupStore(dir)
    await a.claim({ appId: 'a', messageId: 'lease1' })
    await a.close()
    await a.close()
    let bCode = null
    let bOutcome = null
    try { bOutcome = (await b.claim({ appId: 'a', messageId: 'lease2' })).outcome } catch (e) { bCode = e.code }
    check('R5 p2-F b survives a double-close of a', bOutcome === 'claimed', 'outcome=' + String(bOutcome) + ' code=' + String(bCode))
    await b.close()
  }

  // ===== R6（原 p4-H）：bindRoute 覆盖 → route_conflict（M1） =====
  {
    const dir = await mk()
    const store = await openLarkDedupStore(dir)
    const r = await store.claim({ appId: 'a', messageId: 'h', sessionId: 'sess-A', sessionExisted: true })
    let code = null
    try { await store.bindRoute(r.record.key, { sessionId: 'sess-B', sessionExisted: false }) } catch (e) { code = e.code }
    check('R6 p4-H rebinding to another session refused (route_conflict, no overwrite)', code === 'route_conflict', 'code=' + String(code))
    const still = store.get(r.record.key)
    check('R6 p4-H original binding intact', still.sessionId === 'sess-A' && still.sessionExisted === true)
    await store.close()
  }

  // ===== R7（原 p4-G）：自动压缩失败后 claim 真实成功、平台重投持权不丢 =====
  {
    const dir = await mk()
    const hooks = { renameFail: false }
    const fsImpl = { ...base, rename: async (from, to) => {
      if (hooks.renameFail && String(from).includes('.tmp.')) throw new Error('EIO injected rename failure')
      return base.rename(from, to)
    } }
    const store = await openLarkDedupStore(dir, { fs: fsImpl, ttlMs: 1 })
    let sawCompactionError = false
    for (let i = 0; i < 200 && !sawCompactionError; i += 1) {
      const r = await store.claim({ appId: 'a', messageId: 'warm' + i })
      await pause(2)
      await store.settleDelivered(r.record.key, { flushed: true, admission: 'admitted' })
      sawCompactionError = store.stats().compactionErrors >= 1
    }
    hooks.renameFail = true
    const victim = await store.claim({ appId: 'a', messageId: 'victim' })
    check('R7 p4-G claim succeeds despite auto-compaction failure (caller holds responsibility)', victim.outcome === 'claimed', 'outcome=' + String(victim.outcome))
    check('R7 p4-G processing right held after the failure (no orphaned inFlight)', store.isProcessing(victim.record.key) === true)
    const redeliver = await store.claim({ appId: 'a', messageId: 'victim' })
    check('R7 p4-G redelivery dedups as duplicate-inflight (caller owns processing; not a silent drop)', redeliver.outcome === 'duplicate-inflight', 'outcome=' + String(redeliver.outcome))
    check('R7 p4-G compaction failure counted as fixed enum', store.stats().lastCompactionError === null || typeof store.stats().lastCompactionError === 'string', 'last=' + String(store.stats().lastCompactionError))
    hooks.renameFail = false
    const settled = await store.settleDelivered(victim.record.key, { flushed: true, admission: 'admitted' })
    check('R7 p4-G durable settle unaffected by maintenance failure', settled.state === 'delivered', 'state=' + String(settled && settled.state))
    await store.close()
  }

  // ===== R8（原 p5/p6）：settle durable 后压缩失败不改返回；TTL 极短不背压锁死 =====
  {
    const dir = await mk()
    const hooks = { renameFail: false }
    const fsImpl = { ...base, rename: async (from, to) => {
      if (hooks.renameFail && String(from).includes('.tmp.')) throw new Error('EIO injected rename failure')
      return base.rename(from, to)
    } }
    const store = await openLarkDedupStore(dir, { fs: fsImpl, ttlMs: 1 })
    hooks.renameFail = true // 全程压缩失败
    let failed = null
    for (let i = 0; i < 200 && failed === null; i += 1) {
      try {
        const r = await store.claim({ appId: 'a', messageId: 'g' + i })
        await pause(2)
        await store.settleDelivered(r.record.key, { flushed: true, admission: 'admitted' })
      } catch (e) {
        failed = { at: i, code: e.code }
      }
    }
    check('R8 p5/p6 short-TTL churn with persistent compaction failure never throws (no wedge, no backpressure lockup)', failed === null, failed ? JSON.stringify(failed) : '200 claim+settle cycles clean')
    check('R8 p5/p6 compaction failures counted, store healthy', store.stats().compactionErrors >= 1 && store.stats().poisoned === false, 'errors=' + String(store.stats().compactionErrors))
    await store.close()
  }

  // ===== R9（原 p4-I 对应的 ledger 侧；投影侧在 lark-admission.cjs） =====
  {
    const dir = await mk()
    const store = await openLarkDedupStore(dir)
    const digest = larkSendDigest({ imageSha256: 'a1'.repeat(32), mode: 'card', caption: '', appId: 'a', conversation: 'oc' })
    const begin = await store.sendReceipts.begin({ uuid: 'u1', digest, now: 100 })
    check('R9 send begin acquired with owner token', begin.outcome === 'acquired' && typeof begin.record.ownerToken === 'string')
    let code = null
    try { await store.sendReceipts.finish({ uuid: 'u1', ownerToken: 'forged', state: 'sent', messageId: 'om_x' }) } catch (e) { code = e.code }
    check('R9 forged finish refused (send_not_owner)', code === 'send_not_owner', 'code=' + String(code))
    await store.close()
  }

  await Promise.all(tmpRoots.map((dir) => fsp.rm(dir, { recursive: true, force: true })))
  assert.deepEqual(unhandled, [], 'no unhandled rejections leaked')
  const failedResults = results.filter((r) => !r.ok)
  console.log('----')
  console.log('reverse probes: ' + String(results.length - failedResults.length) + '/' + String(results.length) + ' passed')
  if (failedResults.length > 0) process.exit(1)
  console.log('lark-dedup-reverse: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
