// 飞书消息持久账本（独立模块，不接线）：入站去重 + 发送 receipt 共用同一
// fsync journal / lease / 串行写链内核。
//
// == 内核不变量 ==
// - journal：append-only JSONL，每行一个完整对象；行分三类（kind 分派，严格字段集）：
//     meta      {v, meta:'seq', ns, q}                 —— 压缩必写；seq 高水位 + store namespace
//     kind:'d'  入站去重记录（claimed/delivered/rejected/orphaned）
//     kind:'s'  发送 receipt（dispatching/sent/rejected/unknown）
//   未知 kind/字段集不符 → corrupt_journal 抛错，绝不静默清空、绝不互认。
// - 任何 write/fsync 异常 → store **poisoned**：所有后续写操作抛 store_poisoned，
//   直到 close + 重开（重开时重读 journal、截断撕裂尾）。失败的 append 已烧掉 seq
//   （counter 先推进再写），因此 durable journal 里 seq 永不重复。
// - writeAll：循环 write 直到整行落盘，不假设单次 write 全量。
// - 压缩阶段原子性：tmp 写+fsync（失败=旧 journal 完好，不 poison）→ rename
//   （失败=旧 journal 完好，不 poison）→ **rename 成功后无条件换新 fd**（新 inode）
//   → 目录 fsync（POSIX；失败=poison，rename 可能被崩溃回卷，不可继续）。自动压缩
//   的任何失败都不改变 claim/settle 的返回值（记录已 durable 即真实成功，调度方
//   持有处理责任）；只计数 + 固定枚举 lastCompactionError。显式 compact() 仍抛错。
//
// == 单写者 lease（OS flock，唯一允许实现）==
// - 同进程：root 级 lease，每次 open 返回独立 Lease 句柄（各自 closed 标志、close
//   幂等只减一次引用）；关闭中的 store 从 lease 表摘除前，open 会等其 drain 完成
//   再开新实例（不复用正在关闭的实例）。
// - 跨进程：声明依赖 @deepseek-ai/node-addon-system（~0.1.2，宿主同款）的 ./flock
//   入口 `tryLockExclusive(fd)`：内核非阻塞 flock，竞争→EAGAIN/EWOULDBLOCK，
//   持有=保持 fd 打开，**进程死亡（含崩溃）由内核自动释放**——无陈旧锁、无空锁、
//   无接管竞态，因此**不存在任何自动接管路径**（link/rename 接管已删除，不接受）。
// - 持锁文件永不 unlink/替换（宿主 lease.ts 同策略）：POSIX 锁绑定 inode，持锁期
//   删换会产生两个各可 flock 的 inode 破坏互斥；释放=仅关 fd。文件内容只是诊断
//   元数据：空/异主内容**不阻塞**内核锁（写入元数据尽力而为，失败不影响锁）。
// - 能力缺失（包不可解析/平台不支持/加载失败）→ 固定错误码 lock_unavailable 拒绝
//   启用 ledger，**绝不偷偷回退不可靠锁**；竞争→ lock_held。锁/写/fsync/poison
//   错误一律 throw，绝不与 duplicate 结果混淆。
//
// == 状态机 ==
// 入站：claimed → delivered（settleDelivered 需 {flushed:true, admission:'admitted'}
//       两者都严格；admission 只是调用方证明契约，宿主事实由接线用 lark-admission
//       判据保证）| rejected（settleRejected 需 noticeDelivered:true）| orphaned。
//       可重试失败 recordFailure 保持 claimed + 固定枚举 + 释放处理权；再次 claim
//       得 'recoverable'。
// 发送：begin({uuid,digest,now}) → acquired（先 durable 再返回）| sent（原结果，零
//       重发）| rejected | unknown（本期不自动重试，返回核实提示）| in_progress |
//       conflict（同 uuid 不同 digest）。ownerToken 仅内存持有；finish 校验 owner，
//       先 durable 再对外确认；平台成功但 receipt 写失败 → finish 抛 write_failed
//       （调用方对外按 unknown 报告，不假成功）。重启遗留 dispatching 一律视为
//       unknown('interrupted')，禁止自动重派。容量满 → at_capacity 背压，
//       **不** FIFO/TTL 静默删 receipt（本期至少覆盖官方 1h 窗口；安全淘汰需未来
//       可证 fresh-call 机制，见报告）。
// - 不存正文/原图/凭据：入站仅路由元数据，发送仅 uuid/digest/固定枚举/messageId。
// - digest：JSON 元组 sha256（larkSendDigest），绑定规范图字节 SHA、mode、caption
//   与目标（appId/conversation）；时间只由接线提供，模型不可指定。

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, stat, truncate, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const LARK_DEDUP_RECORD_VERSION = 1
export const LARK_DEDUP_JOURNAL_NAME = 'journal.jsonl'
export const LARK_DEDUP_LOCK_NAME = 'journal.lock'

// 入站失败码固定枚举（自由字符串进不了账本）。
export const LARK_DEDUP_ERROR_CODES = Object.freeze([
  'agent_busy', 'enqueue_failed', 'flush_failed', 'download_failed', 'admission_failed',
  'notice_unknown', 'interrupted', 'host_reconcile_needed', 'refetch_scope_missing', 'refetch_unavailable',
])
// 发送终态 reason 固定枚举。
export const LARK_SEND_REASONS = Object.freeze([
  'invalid_image', 'oversized', 'upload_rejected', 'scope_missing', 'target_gone',
  'platform_error', 'interrupted',
])
// 压缩失败阶段固定枚举（匿名计数用）。
export const LARK_COMPACT_ERROR_STAGES = Object.freeze([
  'compact_write_failed', 'compact_rename_failed', 'compact_reopen_failed', 'compact_dirsync_failed',
])

export const LARK_DEDUP_CLAIM_OUTCOMES = Object.freeze(['claimed', 'duplicate-terminal', 'duplicate-inflight', 'recoverable'])
export const LARK_SEND_BEGIN_OUTCOMES = Object.freeze(['acquired', 'sent', 'rejected', 'unknown', 'in_progress', 'conflict'])
export const LARK_SEND_STATES = Object.freeze(['dispatching', 'sent', 'rejected', 'unknown'])

const LARK_DEDUP_CHAT_TYPES = Object.freeze(['p2p', 'group'])
const CLAIM_STATES = Object.freeze(['claimed', 'delivered', 'rejected', 'orphaned'])
const TERMINAL_STATES = Object.freeze(['delivered', 'rejected', 'orphaned'])
const MAX_FIELD_CHARS = 512
const COMPACT_MIN_LINES = 64
const LOCK_ACQUIRE_ATTEMPTS = 3
const NS_RE = /^[0-9a-f]{8}$/
const KEY_RE = /^[0-9a-f]{64}$/
const USER_MESSAGE_ID_RE = /^lark-([0-9a-f]{8})-(\d{1,16})-([0-9a-f]{16})$/
const FLOCK_SPECIFIER = '@deepseek-ai/node-addon-system/flock'

export class LarkDedupError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LarkDedupError'
    this.code = code
  }
}

function corrupt(message) {
  return new LarkDedupError('corrupt_journal', message)
}

// JSON 元组 → sha256 hex：域分隔标签进元组，杜绝拼接歧义。
function tupleHash(parts) {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}

export function larkDedupKey(appId, messageId) {
  return tupleHash(['dsh-messaging/lark-dedup/v1', String(appId), String(messageId)])
}

// 发送 receipt 键：uuid 命名空间独立于入站。
export function larkSendKey(uuid) {
  return tupleHash(['dsh-messaging/lark-send-key/v1', String(uuid)])
}

// 发送 digest：绑定 规范图字节SHA + mode + caption + 目标（appId/conversation）。
// 只存摘要；同一 uuid 换任一要素 → digest 变化 → begin 返回 conflict。
export function larkSendDigest(input) {
  return tupleHash([
    'dsh-messaging/lark-send/v1',
    String(input && input.imageSha256),
    String(input && input.mode),
    String(input && input.caption === undefined || input.caption === null ? '' : input.caption),
    String(input && input.appId),
    String(input && input.conversation),
  ])
}

// store namespace：8 位 hex，首次写入时生成并随 meta 持久化；跨压缩/重启不变。
export function larkDedupNamespace() {
  return randomBytes(4).toString('hex') // 8 位 hex
}

export function larkDedupUserMessageId(ns, seq, appId, messageId) {
  if (!NS_RE.test(String(ns))) throw new LarkDedupError('invalid_key', 'namespace must be 8 lowercase hex chars')
  if (!Number.isSafeInteger(seq) || seq < 1) throw new LarkDedupError('invalid_key', 'seq must be a positive safe integer')
  const hash16 = tupleHash(['dsh-messaging/lark-user-message/v1', String(appId), String(messageId)]).slice(0, 16)
  return 'lark-' + ns + '-' + String(seq) + '-' + hash16
}

export function parseLarkUserMessageId(value) {
  if (typeof value !== 'string') return null
  const match = USER_MESSAGE_ID_RE.exec(value)
  if (!match) return null
  const seq = Number(match[2])
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  return { ns: match[1], seq, hash16: match[3] }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value || value.length > MAX_FIELD_CHARS) {
    throw new LarkDedupError('invalid_key', field + ' must be a non-empty string (≤' + MAX_FIELD_CHARS + ' chars)')
  }
  return value
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null
  return requireString(value, field)
}

function assertFieldSet(value, expected, subject) {
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    throw corrupt(subject + ' field set mismatch: ' + actual.join(','))
  }
}

const DEDUP_FIELDS = ['app', 'c', 'ct', 'e', 'k', 'key', 'msg', 'n', 'ns', 'o', 'q', 'sid', 'st', 'sx', 'u', 'umid', 'v']
const SEND_FIELDS = ['dgst', 'fd', 'k', 'key', 'mid', 'rsn', 'st', 'u', 'uuid', 'v']
const META_FIELDS = ['meta', 'ns', 'q', 'v']

function validateDedupRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt('dedup record is not an object')
  assertFieldSet(value, DEDUP_FIELDS, 'dedup record')
  if (value.v !== LARK_DEDUP_RECORD_VERSION) throw corrupt('unsupported record version: ' + String(value.v))
  if (value.k !== 'd') throw corrupt('record kind mismatch')
  if (typeof value.key !== 'string' || !KEY_RE.test(value.key)) throw corrupt('record key is not a sha256 hex')
  requireString(value.app, 'app')
  requireString(value.msg, 'msg')
  optionalString(value.o, 'o')
  optionalString(value.sid, 'sid')
  optionalString(value.umid, 'umid')
  if (typeof value.ns !== 'string' || !NS_RE.test(value.ns)) throw corrupt('record namespace is not 8 hex chars')
  if (!Number.isSafeInteger(value.q) || value.q < 1) throw corrupt('record ledgerSeq is not a positive safe integer')
  if (value.ct !== null && !LARK_DEDUP_CHAT_TYPES.includes(value.ct)) throw corrupt('record chatType is not a known enum: ' + String(value.ct))
  if (value.sx !== null && typeof value.sx !== 'boolean') throw corrupt('record sessionExisted is not boolean/null')
  if (!CLAIM_STATES.includes(value.st)) throw corrupt('record state is not a known enum: ' + String(value.st))
  if (value.e !== null && !LARK_DEDUP_ERROR_CODES.includes(value.e)) throw corrupt('record error is not a known enum: ' + String(value.e))
  for (const num of [value.c, value.u, value.n]) {
    if (!Number.isSafeInteger(num) || num < 0) throw corrupt('record numeric field is not a non-negative safe integer')
  }
  return value
}

function validateSendRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt('send record is not an object')
  assertFieldSet(value, SEND_FIELDS, 'send record')
  if (value.v !== LARK_DEDUP_RECORD_VERSION) throw corrupt('unsupported record version: ' + String(value.v))
  if (value.k !== 's') throw corrupt('record kind mismatch')
  if (typeof value.key !== 'string' || !KEY_RE.test(value.key)) throw corrupt('send record key is not a sha256 hex')
  requireString(value.uuid, 'uuid')
  if (typeof value.dgst !== 'string' || !KEY_RE.test(value.dgst)) throw corrupt('send record digest is not a sha256 hex')
  if (!LARK_SEND_STATES.includes(value.st)) throw corrupt('send record state is not a known enum: ' + String(value.st))
  if (value.rsn !== null && !LARK_SEND_REASONS.includes(value.rsn)) throw corrupt('send record reason is not a known enum: ' + String(value.rsn))
  if (value.mid !== null && typeof value.mid !== 'string') throw corrupt('send record messageId is not string/null')
  for (const num of [value.fd, value.u]) {
    if (!Number.isSafeInteger(num) || num < 0) throw corrupt('send record numeric field is not a non-negative safe integer')
  }
  return value
}

function validateMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt('meta line is not an object')
  assertFieldSet(value, META_FIELDS, 'meta line')
  if (value.v !== LARK_DEDUP_RECORD_VERSION || value.meta !== 'seq'
    || typeof value.ns !== 'string' || !NS_RE.test(value.ns)
    || !Number.isSafeInteger(value.q) || value.q < 0) {
    throw corrupt('meta line has unknown shape')
  }
  return value
}

function publicRecord(record) {
  return Object.freeze({
    kind: 'dedup',
    key: record.key,
    appId: record.app,
    messageId: record.msg,
    chatId: record.o,
    chatType: record.ct,
    sessionId: record.sid,
    sessionExisted: record.sx,
    ledgerSeq: record.q,
    userMessageId: record.umid,
    namespace: record.ns,
    state: record.st,
    error: record.e,
    attempts: record.n,
    createdAt: record.c,
    updatedAt: record.u,
  })
}

function publicSend(record) {
  return Object.freeze({
    kind: 'send',
    key: record.key,
    uuid: record.uuid,
    digest: record.dgst,
    state: record.st,
    firstDispatchAt: record.fd,
    messageId: record.mid,
    reason: record.rsn,
    updatedAt: record.u,
  })
}

class LarkSendReceipts {
  constructor(store) {
    this.store = store
  }

  begin(args) {
    return this.store.sendBegin(args)
  }

  finish(args) {
    return this.store.sendFinish(args)
  }

  get(uuid) {
    return this.store.sendGet(uuid)
  }
}

class LarkDedupLease {
  constructor(store) {
    this.store = store
    this.closed = false
  }

  #w(method) {
    if (this.closed) throw new LarkDedupError('closed', 'lease handle is closed')
    return this.store[method].bind(this.store)
  }

  async claim(entry) { return this.#w('claim')(entry) }
  async bindRoute(key, route) { return this.#w('bindRoute')(key, route) }
  async settleDelivered(key, evidence) { return this.#w('settleDelivered')(key, evidence) }
  async settleRejected(key, evidence) { return this.#w('settleRejected')(key, evidence) }
  async recordFailure(key, errorCode) { return this.#w('recordFailure')(key, errorCode) }
  release(key) { if (this.closed) return false; return this.store.release(key) }
  isProcessing(key) { return this.store.isProcessing(key) }
  get(key) { return this.store.get(key) }
  recover() { return this.store.recover() }
  async markOrphaned(key) { return this.#w('markOrphaned')(key) }
  stats() { return this.store.stats() }
  async compact() { return this.#w('compact')() }

  get sendReceipts() {
    if (this.closed) throw new LarkDedupError('closed', 'lease handle is closed')
    return this.store.sendReceipts
  }

  // 每句柄幂等 close：只减一次引用；最后一个句柄触发真正的 drain+放锁。
  close() {
    if (this.closed) return Promise.resolve()
    this.closed = true
    return this.store.releaseLease()
  }
}

class LarkDedupStore {
  constructor(root, options) {
    this.root = resolve(root)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 7 * 24 * 60 * 60 * 1000
    this.terminalCapacity = Number.isSafeInteger(options.terminalCapacity) && options.terminalCapacity > 0 ? options.terminalCapacity : 5000
    this.maxClaimed = Number.isSafeInteger(options.maxClaimed) && options.maxClaimed > 0 ? options.maxClaimed : 5000
    // 发送 receipt 容量：满额背压（本期无淘汰；覆盖官方 ≥1h 重发窗口）。
    this.sendCapacity = Number.isSafeInteger(options.sendCapacity) && options.sendCapacity > 0 ? options.sendCapacity : 2000
    // 测试可注入 fs 包装（真实磁盘之上加故障点）；生产默认 node:fs/promises。
    this.fs = { chmod, mkdir, open, readFile, rename, stat, truncate, unlink, ...options.fs }
    // flock 能力：undefined=运行时解析声明依赖的 ./flock 入口；null=模拟能力缺失
    // （测试专用，→ lock_unavailable）；function=注入替身。不存在其它回退。
    this.flockOption = Object.prototype.hasOwnProperty.call(options, 'flock') ? options.flock : undefined
    this.lockMode = null // 'flock' | 'link'
    this.token = randomBytes(16).toString('hex')

    this.records = new Map() // dedup key → record
    this.sendRecords = new Map() // send key → record
    this.inFlight = new Set()
    this.sendInFlight = new Map() // send key → ownerToken（仅内存：owner 不可伪重用）
    this.namespace = null
    this.counter = 0
    this.journalLines = 0
    this.opened = false
    this.closed = false
    this.closing = false
    this.poisonError = null // {code, message}：所有后续写拒绝，直到重开
    this.journalHandle = null
    this.lockHandle = null // flock 模式持有的锁 fd
    this.tail = Promise.resolve()
    this.leaseRefs = 0
    this.lastCompactionError = null

    this.statsCounters = {
      claims: 0, recoverable: 0, duplicateTerminal: 0, duplicateInflight: 0,
      delivered: 0, rejected: 0, orphaned: 0, failuresRecorded: 0, evictedTerminal: 0,
      writeErrors: 0, compactionErrors: 0,
      sendAcquired: 0, sendSent: 0, sendRejected: 0, sendUnknown: 0, sendConflicts: 0, sendCapacityErrors: 0,
    }

    this.sendReceipts = new LarkSendReceipts(this)
  }

  get journalPath() { return join(this.root, LARK_DEDUP_JOURNAL_NAME) }
  get lockPath() { return join(this.root, LARK_DEDUP_LOCK_NAME) }

  async open() {
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 }).catch(() => {})
    try { await this.fs.chmod(this.root, 0o700) } catch { /* Windows 无 POSIX mode */ }
    await this.#acquireLock()
    try {
      await this.#loadJournal()
      // 重启遗留的 dispatching 一律视为 unknown（不自动重派）；不改写 journal，
      // 重载/压缩时自然落盘（再次崩溃也幂等重推导）。
      for (const [key, record] of this.sendRecords) {
        if (record.st === 'dispatching' && !this.sendInFlight.has(key)) {
          this.sendRecords.set(key, { ...record, st: 'unknown', rsn: 'interrupted', u: this.now() })
          this.statsCounters.sendUnknown += 1
        }
      }
      this.journalHandle = await this.fs.open(this.journalPath, 'a', 0o600)
      this.opened = true
    } catch (error) {
      await this.#releaseLock()
      throw error
    }
  }

  // ---- 锁：OS flock 唯一实现（见文件头不变量）----

  async #resolveFlock() {
    if (this.flockOption !== undefined) {
      if (typeof this.flockOption === 'function') return this.flockOption
      return null // 测试注入 null：模拟能力缺失（→ lock_unavailable）
    }
    try {
      const mod = await import(FLOCK_SPECIFIER)
      if (mod && typeof mod.tryLockExclusive === 'function') return (fd) => mod.tryLockExclusive(fd)
    } catch {
      // 依赖缺失/平台不支持/加载失败 → lock_unavailable，绝不回退其它锁。
    }
    return null
  }

  async #acquireLock() {
    const tryLock = await this.#resolveFlock()
    if (!tryLock) {
      throw new LarkDedupError('lock_unavailable', 'kernel flock capability unavailable (@deepseek-ai/node-addon-system/flock not loadable on ' + process.platform + '-' + process.arch + '); the ledger refuses to start without an OS lock')
    }
    // 宿主 lease.ts 同款：open('w') **不换 inode**（仅截断诊断元数据）→ 非阻塞 flock →
    // 复核持锁 inode 仍是路径上的 inode（外部删换路径则本锁不提供互斥：关 fd 重试）。
    for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
      const handle = await this.fs.open(this.lockPath, 'w', 0o600)
      try {
        await tryLock(handle.fd)
      } catch (error) {
        await handle.close().catch(() => {})
        const code = error && error.code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          throw new LarkDedupError('lock_held', 'dedup journal is locked by another live process (kernel flock)')
        }
        // 平台不支持/内核模块加载失败/其它内核错误 → 能力不可用，不回退。
        throw new LarkDedupError('lock_unavailable', 'kernel flock failed: ' + String(code || (error && error.message) || 'unknown'))
      }
      let inodeStable = false
      try {
        const heldStat = await handle.stat({ bigint: true })
        const pathStat = await this.fs.stat(this.lockPath, { bigint: true })
        inodeStable = pathStat.ino === heldStat.ino && pathStat.dev === heldStat.dev
      } catch {
        inodeStable = false // 路径缺失/读取失败：按 inode 已变处理
      }
      if (inodeStable) {
        // 诊断元数据尽力而为：写不进不影响内核锁（内容仅诊断，空/异主不阻塞）。
        try {
          await handle.write(JSON.stringify({ pid: process.pid, token: this.token, at: this.now() }) + '\n')
        } catch { /* metadata-only */ }
        this.lockHandle = handle
        this.lockMode = 'flock'
        return
      }
      await handle.close().catch(() => {}) // 宿主同款：inode 变了就关锁重试
    }
    throw new LarkDedupError('lock_held', 'lock path inode changed repeatedly; refusing to write (manual check required)')
  }

  async #releaseLock() {
    if (this.lockHandle) {
      // 释放=仅关 fd（内核锁随之释放）；持锁文件**永不 unlink/替换**（宿主 lease.ts
      // 同策略：POSIX 锁绑定 inode，删换会产生两个各可 flock 的 inode）。
      await this.lockHandle.close().catch(() => {})
      this.lockHandle = null
    }
  }

  #poison(code, message) {
    if (!this.poisonError) this.poisonError = { code, message }
    return new LarkDedupError(code, message)
  }

  #ensureOpen() {
    if (this.closed || this.closing) throw new LarkDedupError('closed', 'dedup store is closed')
    if (!this.opened) throw new LarkDedupError('not_open', 'dedup store is not open')
  }

  #ensureWritable() {
    this.#ensureOpen()
    if (this.poisonError) {
      throw new LarkDedupError('store_poisoned', 'store is poisoned after ' + this.poisonError.code + '; close and reopen from the durable journal (' + this.poisonError.message + ')')
    }
  }

  #runExclusive(fn) {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(() => {}, () => {})
    return run
  }

  async #loadJournal() {
    let raw = null
    try {
      raw = await this.fs.readFile(this.journalPath)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const handle = await this.fs.open(this.journalPath, 'w', 0o600)
        await handle.close()
        return
      }
      throw new LarkDedupError('write_failed', 'cannot read dedup journal: ' + String(error && error.message))
    }
    // 撕裂尾：截断到最后完整偏移并 fsync（半行绝不能变成下一次 append 的中间损坏）。
    const lastNewline = raw.lastIndexOf(0x0a)
    const completeLength = lastNewline === -1 ? 0 : lastNewline + 1
    if (raw.length > completeLength) {
      const repair = await this.fs.open(this.journalPath, 'r+', 0o600)
      try {
        await repair.truncate(completeLength)
        await repair.sync()
      } finally {
        await repair.close()
      }
    }
    const text = raw.subarray(0, completeLength).toString('utf8')
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    let index = 0
    let meta = null
    for (const line of lines) {
      index += 1
      if (!line.trim()) throw corrupt('blank line at journal line ' + String(index))
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch {
        throw corrupt('unparseable complete line at journal line ' + String(index))
      }
      if (parsed && parsed.meta === 'seq') {
        meta = validateMeta(parsed)
        this.counter = Math.max(this.counter, meta.q)
        continue
      }
      const kind = parsed && parsed.k
      if (kind === 'd') {
        const record = validateDedupRecord(parsed)
        const rebuilt = larkDedupKey(record.app, record.msg)
        if (rebuilt !== record.key) throw corrupt('dedup key does not match app/message tuple at journal line ' + String(index))
        if (this.namespace !== null && this.namespace !== record.ns) throw corrupt('journal mixes two store namespaces at journal line ' + String(index))
        this.namespace = record.ns
        this.counter = Math.max(this.counter, record.q)
        this.records.set(record.key, record)
      } else if (kind === 's') {
        const record = validateSendRecord(parsed)
        const rebuilt = larkSendKey(record.uuid)
        if (rebuilt !== record.key) throw corrupt('send key does not match uuid at journal line ' + String(index))
        this.sendRecords.set(record.key, record)
      } else {
        throw corrupt('unknown record kind at journal line ' + String(index))
      }
      this.journalLines += 1
    }
    if (meta && this.namespace !== null && meta.ns !== this.namespace) throw corrupt('meta namespace does not match record namespace')
    if (this.namespace === null && meta) this.namespace = meta.ns
  }

  // writeAll：循环写完整行（不假设单次 write 全量）；任何失败 → poison + throw。
  async #appendLine(line) {
    this.#ensureWritable()
    const buf = Buffer.from(line + '\n', 'utf8')
    try {
      let offset = 0
      while (offset < buf.length) {
        const result = await this.journalHandle.write(buf, offset, buf.length - offset)
        if (!result || result.bytesWritten <= 0) throw new Error('short write')
        offset += result.bytesWritten
      }
      await this.journalHandle.sync()
    } catch (error) {
      this.statsCounters.writeErrors += 1
      throw this.#poison('write_failed', 'journal append/fsync failed (durability uncertain): ' + String(error && error.message))
    }
    this.journalLines += 1
  }

  #metaLine() { return { v: LARK_DEDUP_RECORD_VERSION, meta: 'seq', ns: this.namespace, q: this.counter } }

  #evictTerminal() {
    const current = this.now()
    const terminal = []
    for (const record of this.records.values()) {
      if (TERMINAL_STATES.includes(record.st)) terminal.push(record)
    }
    const keep = []
    const drop = []
    for (const record of terminal) {
      if (current - record.u >= this.ttlMs) drop.push(record)
      else keep.push(record)
    }
    keep.sort((a, b) => b.u - a.u)
    for (const record of keep.slice(this.terminalCapacity)) drop.push(record)
    for (const record of drop) {
      this.records.delete(record.key)
      this.statsCounters.evictedTerminal += 1
    }
    return drop.length > 0
  }

  #claimedCount() {
    let count = 0
    for (const record of this.records.values()) {
      if (record.st === 'claimed') count += 1
    }
    return count
  }

  async #maybeCompact() {
    const live = this.records.size + this.sendRecords.size
    if (this.journalLines <= COMPACT_MIN_LINES || this.journalLines < live * 2) return
    await this.#compact()
  }

  // 原子压缩（只在串行写链内调用）。阶段原子性见文件头：rename 成功后无条件换 fd；
  // 目录 fsync 失败 → poison。压缩失败由 #maintain 吸收（只计数），不改变业务返回值。
  async #compact() {
    const tmp = this.journalPath + '.tmp.' + this.token
    let handle = null
    let renamed = false
    try {
      handle = await this.fs.open(tmp, 'w', 0o600)
      const body = [JSON.stringify(this.#metaLine())]
      for (const record of this.records.values()) body.push(JSON.stringify({ ...record, k: 'd' }))
      for (const record of this.sendRecords.values()) body.push(JSON.stringify({ ...record, k: 's' }))
      const buf = Buffer.from(body.join('\n') + '\n', 'utf8')
      let offset = 0
      while (offset < buf.length) {
        const result = await handle.write(buf, offset, buf.length - offset)
        if (!result || result.bytesWritten <= 0) throw new Error('short write')
        offset += result.bytesWritten
      }
      await handle.sync()
      await handle.close()
      handle = null
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      await this.fs.unlink(tmp).catch(() => {})
      this.statsCounters.compactionErrors += 1
      this.lastCompactionError = 'compact_write_failed'
      throw new LarkDedupError('write_failed', 'compaction temp write failed (previous journal kept): ' + String(error && error.message))
    }
    try {
      await this.fs.rename(tmp, this.journalPath)
      renamed = true
    } catch (error) {
      await this.fs.unlink(tmp).catch(() => {})
      this.statsCounters.compactionErrors += 1
      this.lastCompactionError = 'compact_rename_failed'
      throw new LarkDedupError('write_failed', 'compaction rename failed (previous journal kept): ' + String(error && error.message))
    }
    // rename 成功：旧 fd 指向已被替换的 inode——无条件先换新 fd（finally）。
    try {
      if (this.journalHandle) await this.journalHandle.close().catch(() => {})
      this.journalHandle = await this.fs.open(this.journalPath, 'a', 0o600)
    } catch (error) {
      this.journalHandle = null
      this.statsCounters.compactionErrors += 1
      this.lastCompactionError = 'compact_reopen_failed'
      throw this.#poison('write_failed', 'compaction fd reopen failed after rename: ' + String(error && error.message))
    }
    try {
      if (process.platform !== 'win32') {
        const dirHandle = await this.fs.open(dirname(this.journalPath), 'r')
        try {
          await dirHandle.sync()
        } finally {
          await dirHandle.close()
        }
      }
    } catch (error) {
      // rename 的崩溃持久性未确认（可能被回卷）：继续写新 fd 会丢数据 → poison。
      this.statsCounters.compactionErrors += 1
      this.lastCompactionError = 'compact_dirsync_failed'
      throw this.#poison('write_failed', 'compaction directory sync failed (rename durability uncertain): ' + String(error && error.message))
    }
    this.journalLines = this.records.size + this.sendRecords.size + 1
  }

  // 自动压缩维护：失败只计数（固定枚举），poison 由 #compact 内部决定；
  // 业务操作（claim/settle）的 durable 结果不因维护失败而改变。
  async #maintain() {
    try {
      this.#evictTerminal()
      await this.#maybeCompact()
    } catch {
      // 已计数 + lastCompactionError；poison（若有）在后续写时生效。
    }
  }

  compact() {
    this.#ensureOpen()
    return this.#runExclusive(async () => {
      this.#evictTerminal()
      await this.#compact()
    })
  }

  // ---- 入站去重 ----

  async claim(entry) {
    this.#ensureWritable()
    requireString(entry && entry.appId, 'appId')
    requireString(entry && entry.messageId, 'messageId')
    const chatId = optionalString(entry.chatId, 'chatId')
    const chatType = LARK_DEDUP_CHAT_TYPES.includes(entry.chatType) ? entry.chatType : null
    const sessionId = optionalString(entry.sessionId, 'sessionId')
    const sessionExisted = typeof entry.sessionExisted === 'boolean' ? entry.sessionExisted : null
    const key = larkDedupKey(entry.appId, entry.messageId)
    return this.#runExclusive(async () => {
      this.#ensureWritable()
      this.#evictTerminal()
      const existing = this.records.get(key)
      if (existing) {
        if (existing.st !== 'claimed') {
          this.statsCounters.duplicateTerminal += 1
          return { outcome: 'duplicate-terminal', record: publicRecord(existing) }
        }
        if (this.inFlight.has(key)) {
          this.statsCounters.duplicateInflight += 1
          return { outcome: 'duplicate-inflight', record: publicRecord(existing) }
        }
        // 重试复用已存 seq/id：只 bump attempts 取回处理权。
        const retaken = { ...existing, n: existing.n + 1, u: this.now() }
        await this.#appendLine(JSON.stringify(retaken))
        this.records.set(key, retaken)
        this.inFlight.add(key)
        this.statsCounters.recoverable += 1
        return { outcome: 'recoverable', record: publicRecord(retaken) }
      }
      if (this.#claimedCount() >= this.maxClaimed) {
        throw new LarkDedupError('at_capacity', 'claimed record capacity (' + String(this.maxClaimed) + ') reached; apply backpressure (do not ack)')
      }
      if (this.counter >= Number.MAX_SAFE_INTEGER) {
        throw new LarkDedupError('seq_exhausted', 'ledgerSeq safe-integer range exhausted; manual ledger migration required')
      }
      if (this.namespace === null) this.namespace = larkDedupNamespace()
      // 烧 seq：先推进 counter 再写（append 失败 → poisoned，seq 永不复用）。
      const seq = this.counter + 1
      this.counter = seq
      const umid = larkDedupUserMessageId(this.namespace, seq, entry.appId, entry.messageId)
      const record = {
        v: LARK_DEDUP_RECORD_VERSION, k: 'd', key,
        app: entry.appId, msg: entry.messageId, o: chatId, ct: chatType,
        ns: this.namespace, q: seq, umid, sx: sessionExisted, sid: sessionId,
        st: 'claimed', e: null, n: 0, c: this.now(), u: this.now(),
      }
      await this.#appendLine(JSON.stringify(record))
      this.records.set(key, record)
      this.inFlight.add(key)
      this.statsCounters.claims += 1
      await this.#maintain()
      return { outcome: 'claimed', record: publicRecord(record) }
    })
  }

  // 路由绑定：首次绑定 / 相同幂等；冲突拒绝（M1）。followup 之前 durable。
  async bindRoute(key, route) {
    this.#ensureWritable()
    requireString(key, 'key')
    const sessionId = requireString(route && route.sessionId, 'sessionId')
    const sessionExisted = typeof (route && route.sessionExisted) === 'boolean' ? route.sessionExisted : null
    return this.#runExclusive(async () => {
      this.#ensureWritable()
      const record = this.records.get(key)
      if (!record) throw new LarkDedupError('unknown_record', 'no such dedup record')
      if (record.st !== 'claimed') throw new LarkDedupError('bad_state', 'cannot bind route on a terminal record')
      if (!this.inFlight.has(key)) throw new LarkDedupError('not_owner', 'bindRoute requires the in-flight claim')
      if (record.sid !== null && record.sid !== sessionId) {
        throw new LarkDedupError('route_conflict', 'record is already bound to a different session; refusing to overwrite')
      }
      if (record.sx !== null && sessionExisted !== null && record.sx !== sessionExisted) {
        throw new LarkDedupError('route_conflict', 'sessionExisted checkpoint conflict; it never downgrades once written')
      }
      if (record.sid === sessionId && (sessionExisted === null || record.sx === sessionExisted)) {
        return publicRecord(record) // 幂等重复绑定
      }
      const bound = { ...record, sid: sessionId, sx: sessionExisted !== null ? sessionExisted : record.sx, u: this.now() }
      await this.#appendLine(JSON.stringify(bound))
      this.records.set(key, bound)
      return publicRecord(bound)
    })
  }

  async settleDelivered(key, evidence) {
    return this.#settle(key, 'delivered', evidence)
  }

  async settleRejected(key, evidence) {
    return this.#settle(key, 'rejected', evidence)
  }

  async #settle(key, state, evidence) {
    this.#ensureWritable()
    requireString(key, 'key')
    if (!this.inFlight.has(key)) throw new LarkDedupError('not_owner', 'settle requires the in-flight claim')
    if (state === 'delivered') {
      if (!(evidence && evidence.flushed === true)) {
        throw new LarkDedupError('bad_evidence', 'settleDelivered requires flushed:true (host durability evidence)')
      }
      // M4：admission 必须明确为 admitted（接受 'admitted' 或判据对象 {verdict:'admitted'}）。
      // 这只是调用方证明契约——宿主事实由接线用 lark-admission 判据保证，模块不验证宿主。
      const admission = evidence && evidence.admission
      const admitted = admission === 'admitted' || (admission && typeof admission === 'object' && admission.verdict === 'admitted')
      if (!admitted) {
        throw new LarkDedupError('bad_evidence', "settleDelivered requires admission:'admitted' (an admitted verdict object is also accepted); uncertain/missing must not deliver")
      }
    }
    if (state === 'rejected' && !(evidence && evidence.noticeDelivered === true)) {
      throw new LarkDedupError('bad_evidence', 'settleRejected requires noticeDelivered:true')
    }
    return this.#runExclusive(async () => {
      this.#ensureWritable()
      const record = this.records.get(key)
      if (!record) throw new LarkDedupError('unknown_record', 'no such dedup record')
      if (record.st === state) {
        this.inFlight.delete(key)
        return publicRecord(record)
      }
      if (record.st !== 'claimed') throw new LarkDedupError('bad_state', 'record already terminal: ' + record.st)
      const settled = { ...record, st: state, e: null, u: this.now() }
      await this.#appendLine(JSON.stringify(settled))
      this.records.set(key, settled)
      this.inFlight.delete(key)
      if (state === 'delivered') this.statsCounters.delivered += 1
      else this.statsCounters.rejected += 1
      await this.#maintain() // 维护失败不改变本次 durable 结果
      return publicRecord(settled)
    })
  }

  async recordFailure(key, errorCode) {
    this.#ensureWritable()
    requireString(key, 'key')
    if (!LARK_DEDUP_ERROR_CODES.includes(errorCode)) {
      throw new LarkDedupError('invalid_key', 'error code must be one of the fixed enum')
    }
    if (!this.inFlight.has(key)) throw new LarkDedupError('not_owner', 'recordFailure requires the in-flight claim')
    return this.#runExclusive(async () => {
      this.#ensureWritable()
      const record = this.records.get(key)
      if (!record) throw new LarkDedupError('unknown_record', 'no such dedup record')
      if (record.st !== 'claimed') throw new LarkDedupError('bad_state', 'cannot record failure on a terminal record')
      const failed = { ...record, e: errorCode, u: this.now() }
      await this.#appendLine(JSON.stringify(failed))
      this.records.set(key, failed)
      this.inFlight.delete(key)
      this.statsCounters.failuresRecorded += 1
      return publicRecord(failed)
    })
  }

  release(key) {
    return this.inFlight.delete(key)
  }

  isProcessing(key) {
    return this.inFlight.has(key)
  }

  get(key) {
    const record = this.records.get(key)
    return record ? publicRecord(record) : null
  }

  recover() {
    const rows = []
    for (const record of this.records.values()) {
      if (record.st === 'claimed') rows.push(publicRecord(record))
    }
    rows.sort((a, b) => a.ledgerSeq - b.ledgerSeq || (a.key < b.key ? -1 : 1))
    return rows
  }

  async markOrphaned(key) {
    this.#ensureWritable()
    requireString(key, 'key')
    return this.#runExclusive(async () => {
      this.#ensureWritable()
      const record = this.records.get(key)
      if (!record) throw new LarkDedupError('unknown_record', 'no such dedup record')
      if (record.st !== 'claimed') throw new LarkDedupError('bad_state', 'cannot orphan a terminal record')
      const orphaned = { ...record, st: 'orphaned', u: this.now() }
      await this.#appendLine(JSON.stringify(orphaned))
      this.records.set(key, orphaned)
      this.inFlight.delete(key)
      this.statsCounters.orphaned += 1
      return publicRecord(orphaned)
    })
  }

  // ---- 发送 receipt（kind:'s' 独立状态机；与入站绝不混淆）----

  async sendBegin(args) {
    this.#ensureWritable()
    requireString(args && args.uuid, 'uuid')
    const digest = requireString(args && args.digest, 'digest')
    if (!KEY_RE.test(digest)) throw new LarkDedupError('invalid_key', 'digest must be a sha256 hex (use larkSendDigest)')
    const now = args.now
    if (!Number.isSafeInteger(now) || now < 0) throw new LarkDedupError('invalid_key', 'now must be a non-negative safe integer (server-provided time only)')
    const key = larkSendKey(args.uuid)
    return this.#runExclusive(async () => {
      this.#ensureWritable()
      const existing = this.sendRecords.get(key)
      if (existing) {
        if (existing.dgst !== digest) {
          this.statsCounters.sendConflicts += 1
          return { outcome: 'conflict', record: publicSend(existing) }
        }
        if (existing.st === 'sent') return { outcome: 'sent', record: publicSend(existing) }
        if (existing.st === 'rejected') return { outcome: 'rejected', record: publicSend(existing) }
        if (existing.st === 'unknown') return { outcome: 'unknown', record: publicSend(existing) }
        if (this.sendInFlight.has(key)) return { outcome: 'in_progress', record: publicSend(existing) }
        // dispatching 但无 owner（理论防御；load 已把遗留转 unknown）。
        return { outcome: 'unknown', record: publicSend({ ...existing, st: 'unknown', rsn: 'interrupted', u: this.now() }) }
      }
      if (this.sendRecords.size >= this.sendCapacity) {
        this.statsCounters.sendCapacityErrors += 1
        throw new LarkDedupError('at_capacity', 'send receipt capacity (' + String(this.sendCapacity) + ') reached; backpressure (no silent eviction; receipts cover the 1h resend window)')
      }
      const ownerToken = randomBytes(16).toString('hex')
      const record = {
        v: LARK_DEDUP_RECORD_VERSION, k: 's', key,
        uuid: args.uuid, dgst: digest, st: 'dispatching',
        fd: now, mid: null, rsn: null, u: now,
      }
      await this.#appendLine(JSON.stringify(record)) // acquired 之前先 durable
      this.sendRecords.set(key, record)
      this.sendInFlight.set(key, ownerToken)
      this.statsCounters.sendAcquired += 1
      return { outcome: 'acquired', record: Object.freeze({ key, uuid: args.uuid, digest, firstDispatchAt: now, ownerToken }) }
    })
  }

  async sendFinish(args) {
    this.#ensureWritable()
    requireString(args && args.uuid, 'uuid')
    requireString(args && args.ownerToken, 'ownerToken')
    const state = args.state
    if (state !== 'sent' && state !== 'rejected' && state !== 'unknown') {
      throw new LarkDedupError('invalid_key', 'finish state must be sent|rejected|unknown')
    }
    const key = larkSendKey(args.uuid)
    if (this.sendInFlight.get(key) !== args.ownerToken) {
      throw new LarkDedupError('send_not_owner', 'finish requires the live ownerToken from begin (restart leftovers cannot finish; they stay unknown)')
    }
    if (state === 'sent') requireString(args.messageId, 'messageId')
    if (state !== 'sent' && !LARK_SEND_REASONS.includes(args.reason)) {
      throw new LarkDedupError('invalid_key', 'finish reason must be one of the fixed enum')
    }
    return this.#runExclusive(async () => {
      this.#ensureWritable()
      const record = this.sendRecords.get(key)
      if (!record || record.st !== 'dispatching') throw new LarkDedupError('send_state', 'no dispatching send record for this uuid')
      const finished = {
        ...record,
        st: state,
        mid: state === 'sent' ? String(args.messageId) : null,
        rsn: state === 'sent' ? null : args.reason,
        u: this.now(),
      }
      // 先 durable 再对外确认；写失败 → poison + throw（平台可能已成功 → 调用方对外报 unknown，不假成功）。
      await this.#appendLine(JSON.stringify(finished))
      this.sendRecords.set(key, finished)
      this.sendInFlight.delete(key)
      if (state === 'sent') this.statsCounters.sendSent += 1
      else if (state === 'rejected') this.statsCounters.sendRejected += 1
      else this.statsCounters.sendUnknown += 1
      await this.#maintain()
      return publicSend(finished)
    })
  }

  sendGet(uuid) {
    requireString(uuid, 'uuid')
    const record = this.sendRecords.get(larkSendKey(uuid))
    return record ? publicSend(record) : null
  }

  stats() {
    return Object.freeze(Object.assign({}, this.statsCounters, {
      journalLines: this.journalLines,
      liveRecords: this.records.size,
      claimedRecords: this.#claimedCount(),
      inFlight: this.inFlight.size,
      ledgerSeq: this.counter,
      sendRecords: this.sendRecords.size,
      sendInFlight: this.sendInFlight.size,
      compactionErrors: this.statsCounters.compactionErrors,
      lastCompactionError: this.lastCompactionError,
      poisoned: this.poisonError !== null,
      lockMode: this.lockMode,
    }))
  }

  async releaseLease() {
    this.leaseRefs -= 1
    if (this.leaseRefs > 0 || this.closing) return
    this.closing = true
    const entry = leases.get(this.root)
    const done = (async () => {
      await this.tail
      this.closed = true
      if (this.journalHandle) {
        await this.journalHandle.close().catch(() => {})
        this.journalHandle = null
      }
      await this.#releaseLock()
    })()
    if (entry) entry.closing = done
    try {
      await done
    } finally {
      leases.delete(this.root)
    }
  }
}

// root 级单写者 lease：每次 open 返回独立 Lease 句柄（M2），共享同一底层 store；
// 关闭中的 store 不再被新 open 复用（N2），open 等 drain 完成后再开新实例。
const leases = new Map() // abs root → { ready, closing? }

export async function openLarkDedupStore(root, options = {}) {
  const abs = resolve(root)
  for (;;) {
    const entry = leases.get(abs)
    if (entry) {
      if (entry.closing) {
        await entry.closing
        continue
      }
      const store = await entry.ready
      if (entry.closing) continue // drain 开始的竞态：重试
      store.leaseRefs += 1
      return new LarkDedupLease(store)
    }
    const mine = { ready: null, closing: null }
    leases.set(abs, mine)
    mine.ready = (async () => {
      const store = new LarkDedupStore(abs, options)
      await store.open()
      store.leaseRefs = 1
      return store
    })()
    try {
      return new LarkDedupLease(await mine.ready)
    } catch (error) {
      leases.delete(abs)
      throw error
    }
  }
}

export async function larkDedupLockExists(root) {
  try {
    await stat(join(resolve(root), LARK_DEDUP_LOCK_NAME))
    return true
  } catch {
    return false
  }
}
