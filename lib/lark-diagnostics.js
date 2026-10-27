// 飞书渠道匿名诊断（schemaVersion 1）。
// 只存**白名单标量**：枚举字符串、整数计数/时间戳、以及固定字段的 lastFailure 摘要。
// 绝不保留：正文、session/chat/user/app/card/message/Agent/attempt ID、URL、请求体、
// 原始错误消息（errorText 只在分类瞬间使用，不落库）、Authorization/cookie/token。
// 任何方法都是同步、无 IO、不抛错语义（调用侧另有 diagSafe 兜底）；诊断绝不能
// 影响发送、串行队列、close 序号、计时器或 Agent 生命周期。
//
// 证据域严格分开：
//   permissions（grant 域）：只读 scope 查询结果——"查询已授权"不等于"实际调用已验证"；
//   operations（operationEvidence 域）：真实 create/ref/PUT/close/text/static 调用证据；
//   localRefusals：纯本地拒绝（well-formed/预算/schema），**未派发网络**、不计入
//   attempted，避免用户拿 diagnostics 与 wire 核对时对不上。
//
// 回合身份与终局（P1）：
//   - 每个 (Agent 槽位, host turn) 一条**稳定记录**，全代内不换身：迟到 final、
//     重复 final、排队中的收卡 ACK 都归它，绝不在 done 后同 turn 重建新身份；
//   - 终局由**真实信号**共同决定：final 已收 + turnEnd 已收 + 所有在途操作 ACK
//     结算（pendingOps=0）+ 逐卡关闭（cardsOpened=cardsClosed）；任一张卡未收完
//     不算完成；静态/text 投递在途同样挂在 pendingOps 上；
//   - 未知投递/确定失败不假 completed：unknown → failed（userState 显示
//     unknown_delivery）；静态/text 失败且无任何成功输出 → failed；
//   - 有界历史只淘汰**已终态**记录；未结算身份绝不为有界而被逐出。
//
// 证据新鲜度（P1）：cardkit 总体 state 按**派发单调序号**（token.seq）比较
//   denied 水位与 success 水位——较旧操作的晚到成功不得覆盖较新拒绝；真正更新的
//   成功（派发序号更大）才恢复 observed_success。
//
// 代际隔离：每个插件代（channelGeneration.lark）新建一个 store；操作派发时捕获
// store 引用与 generation，结算只回写**原桶**——旧代迟到结果绝不污染新代展示。

export const LARK_SCOPE_CARDKIT_WRITE = 'cardkit:card:write'
export const LARK_SCOPE_READ_URL = 'https://open.feishu.cn/open-apis/application/v6/scopes'

import * as nodeCrypto from 'node:crypto'

// 实例身份（非认证 token、非私密标识）：每次插件 apply 新建的匿名 48 位随机非负
// 安全整数；同一实例内所有渠道 reload 保持不变，重新 apply 必不同。仅用于**等值
// 身份比较**（不用于大小排序），不从机器/账号/会话/凭据派生。随机源可注入（测试
// 固定词源避免偶然相等断言）。
// **纯观察失败边界**：本函数是 total 函数——熵源异常/词源异常/结果非法一律返回
// null（明确“实例身份未确认”），绝不抛出；不回显原异常，不拿 generation/Date.now
// 冒充可信标记，也不默默复用固定 epoch。
export function createLarkInstanceEpoch(getWords) {
  try {
    const words = typeof getWords === 'function'
      ? getWords(3)
      : nodeCrypto.getRandomValues(new Uint16Array(3))
    if (!words || typeof words.length !== 'number' || words.length < 3) return null
    const a = Number(words[0])
    const b = Number(words[1])
    const c = Number(words[2])
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null
    const epoch = ((a & 0xffff) * 65536 + (b & 0xffff)) * 65536 + (c & 0xffff) // 48-bit
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= 2 ** 48) return null
    return epoch
  } catch {
    return null // 熵源/词源故障：明确未知身份，绝不破坏 apply 启动
  }
}

const OPS = [
  'card_create',
  'card_reference',
  'card_put',
  'card_close',
  'static_interactive',
  'text_send',
  'scope_read',
  // 图片操作桶（status.dedup/images 契约 v1）：与 grant 域分离（权限≠操作证据）。
  'image_download',
  'image_upload',
  'image_send',
]
const CARD_OPS = new Set(['card_create', 'card_reference', 'card_put', 'card_close'])
// 事件 kind 白名单（UI 时间线只认这些值；text_send/scope_read 只计数不入时间线）。
const EVENT_OP_KIND = {
  card_create: 'create',
  card_reference: 'ref',
  card_put: 'put',
  card_close: 'close',
  static_interactive: 'static',
}
// 引擎拒绝分类白名单：duplicateIndex 与 duplicateRevision/regressedRevision 区分
// （重复 index 帧与 revision 不前进是独立原因，指标名必须与真实原因一致）。
const FRAME_REJECT_CATEGORIES = new Set([
  'duplicateIndex',
  'duplicateRevision',
  'regressedRevision',
  'denseIndexGap',
  'shape',
  'unbound',
  'stale',
])
const FAILURE_CATEGORIES = new Set([
  'scope_denied',
  'card_identity',
  'rate_limited',
  'http_error',
  'network_unknown',
  'no_id',
  'shape_mismatch',
  'budget_exceeded',
  'malformed',
  'stale_generation',
])
const LOCAL_REFUSAL_CATEGORIES = new Set(['malformed', 'budget_exceeded', 'shape_mismatch'])

const SCOPE_STALE_TTL_MS = 60 * 60 * 1000
// ── status 增量契约（channels.lark.diagnostics.dedup/images，冻结 v1）────────
// 图片所需 scope（grant 域；实际授权以只读 scope 查询为准，与操作桶分离）。
// 图片 scope 固定规则（OR 组；代码常量，UI 只显示不自算）。
export const LARK_IMAGE_SCOPE_GROUPS = Object.freeze({
  upload: Object.freeze(['im:resource', 'im:resource:upload']),
  download: Object.freeze(['im:message', 'im:message:readonly', 'im:message.history:readonly']),
})
// 群历史重拉条件（独立显示；不叫 groupSend，不从 download 外推）。
export const LARK_IMAGE_GROUP_HISTORY_SCOPE = 'im:message.group_msg'
// OR 组判定：任一成员 grant_status===1 → granted；整组成员均被显式列出且全部
// grant_status===2（充分显式拒绝）→ denied；缺字段/未列出/查询失败 → unknown
//（绝不以“未返回”判 denied）。
function grantFromEntries(entries, scopes) {
  let listed = 0
  let deniedListed = 0
  for (const name of scopes) {
    let status = null
    for (const e of entries) {
      if (e && e.scope_name === name) { status = e.grant_status; break }
    }
    if (status === null || status === undefined) continue
    listed += 1
    if (status === 1) return 'granted' // OR 组：任一显式授予即可用
    if (status === 2) deniedListed += 1
  }
  if (listed > 0 && listed === scopes.length && deniedListed === scopes.length) return 'denied'
  return 'unknown'
}
export function deriveImageScopeGrants(scopeEntries) {
  const entries = Array.isArray(scopeEntries) ? scopeEntries : []
  return {
    upload: grantFromEntries(entries, LARK_IMAGE_SCOPE_GROUPS.upload),
    download: grantFromEntries(entries, LARK_IMAGE_SCOPE_GROUPS.download),
    groupHistory: grantFromEntries(entries, [LARK_IMAGE_GROUP_HISTORY_SCOPE]),
  }
}
// send receipt 容量默认值（ledger sendCapacity；仅显式配置可改，无 TTL/淘汰）。
export const LARK_SEND_RECEIPT_CAPACITY_DEFAULT = 2000
// dedup lastError 固定枚举（自由文本绝不入 status）。
export const LARK_DEDUP_LAST_ERRORS = Object.freeze([
  'lock_unavailable', 'lock_held', 'store_poisoned', 'write_failed',
  'corrupt_journal', 'closed', 'not_open', 'at_capacity', 'seq_exhausted',
])
// 匿名计数白名单（仅数值；不含任何业务 ID/正文/digest/ledger 序号）。
// 语义：counts.delivered = **持久准入结算数**（消息已证进入 agent inbox），
// 不是「响应完成数」（回复由 agent 自身回合驱动，UI/跨模块不得混用）。
const DEDUP_COUNT_KEYS = Object.freeze([
  'claims', 'recoverable', 'duplicateTerminal', 'duplicateInflight',
  'delivered', 'rejected', 'orphaned', 'failuresRecorded', 'evictedTerminal',
  'writeErrors', 'compactionErrors', 'journalLines', 'liveRecords',
  'sendAcquired', 'sendSent', 'sendRejected', 'sendUnknown', 'sendConflicts',
  'sendCapacityErrors', 'sendRecords', 'sendInFlight',
])
const IMAGE_OPS = Object.freeze(['image_download', 'image_upload', 'image_send'])

// 纯函数：真实 store 视图（{stats, sendCapacity, lastError} | null）→ 冻结形状。
// status 每次直接读 store（不以模型字段为存储真源）；poisoned 显式可见 →
// reopen:'needed'（需用户显式 reload 动作，不自动反复重开；不清空账本）。
export function normalizeLarkDedupStatus(src) {
  const stats = src && src.stats && typeof src.stats === 'object' ? src.stats : null
  if (!stats) {
    // available=false（未接线/reader 故障）：counts:null + capacity 全 null ——
    // UI 隐藏；绝不伪造 2000 充数，也不输出未知原串。
    return {
      schemaVersion: 1,
      available: false,
      poisoned: false,
      lockMode: null,
      capacity: { sendReceipts: null, source: null },
      counts: null,
      reopen: 'none',
      lastError: null,
    }
  }
  const counts = {}
  for (const key of DEDUP_COUNT_KEYS) {
    const v = stats[key]
    counts[key] = Number.isFinite(v) ? v : 0
  }
  const poisoned = Boolean(stats.poisoned)
  // lockMode 仅 'flock'|null（按 Lead 裁定隐藏 link 等非声明能力，不假称能力）。
  const lockMode = stats.lockMode === 'flock' ? 'flock' : null
  // 容量由真实 reader 提供（实际值+来源）；缺失/非法 → null/null（不伪造默认）。
  const capRaw = src ? Number(src.sendCapacity) : NaN
  const sendReceipts = Number.isSafeInteger(capRaw) && capRaw > 0 ? capRaw : null
  const source = src && (src.sendCapacitySource === 'default' || src.sendCapacitySource === 'configured')
    ? src.sendCapacitySource
    : null
  let lastError = src && typeof src.lastError === 'string' && LARK_DEDUP_LAST_ERRORS.includes(src.lastError) ? src.lastError : null
  if (lastError === null && poisoned) lastError = 'store_poisoned'
  return {
    schemaVersion: 1,
    available: true,
    poisoned,
    lockMode,
    capacity: { sendReceipts, source: sendReceipts === null ? null : source },
    counts,
    reopen: poisoned ? 'needed' : 'none',
    lastError,
    ...(src && src.lastError != null && !LARK_DEDUP_LAST_ERRORS.includes(src.lastError) ? { lastErrorUnknown: true } : {}),
  }
}
const MAX_TURNS = 16 // 全代回合记录上限；只淘汰已终态，未结算身份保留
const MAX_RECENT_TURNS = 8
const MAX_TURN_EVENTS = 16

function intOrNull(value) {
  return Number.isInteger(value) ? value : null
}

// 失败分类器：只依据结构化数值（HTTP status / 平台数值 code）与**瞬时**错误文本来
// 判定枚举类别；errorText 用完即弃、绝不入库。99991672 只有在文本明确指向白名单
// scope（cardkit:card:write）时才判 scope_denied；300311 是目标卡片身份问题，不泛判
// 缺权；其余 403/超时/断连/无ID/预算/畸形各自分类，不混成缺权。
export function classifyLarkApiFailure({ status, apiCode, errorText, unknown }) {
  if (unknown === true) return { outcome: 'unknown', category: 'network_unknown', scope: null }
  const text = typeof errorText === 'string' ? errorText : ''
  if (apiCode === 99991672) {
    const match = /\[([a-z0-9:._-]+)\]/i.exec(text)
    const scope = match && String(match[1]).toLowerCase() === LARK_SCOPE_CARDKIT_WRITE
      ? LARK_SCOPE_CARDKIT_WRITE
      : null
    if (scope) return { outcome: 'denied', category: 'scope_denied', scope }
    // 99991672 但无白名单 scope 证据：保守按确定失败处理，不判缺权（不硬编码臆测）。
    return { outcome: 'failed', category: 'http_error', scope: null }
  }
  if (apiCode === 300311) return { outcome: 'failed', category: 'card_identity', scope: null }
  if (status === 429) return { outcome: 'failed', category: 'rate_limited', scope: null }
  if (/no card_id|no message_id/i.test(text)) return { outcome: 'failed', category: 'no_id', scope: null }
  if (/budget|30KB/i.test(text)) return { outcome: 'failed', category: 'budget_exceeded', scope: null }
  if (/malformed|surrogate/i.test(text)) return { outcome: 'failed', category: 'malformed', scope: null }
  return { outcome: 'failed', category: 'http_error', scope: null }
}

export function createLarkDiagnostics(generation) {
  const slots = new WeakMap() // Agent 对象 → 匿名自增槽位号（不落任何真实 ID）
  let slotSeq = 0
  let opSeq = 0
  let turnSeq = 0
  let currentTurn = null
  let lastFailure = null
  let lastFailureSeq = 0
  // 跨 operation 证据水位（派发单调序号）：防止较旧操作的晚到成功覆盖较新拒绝。
  let cardDeniedSeq = -1
  let cardSuccessSeq = -1

  const ops = {}
  for (const op of OPS) {
    ops[op] = {
      state: 'unknown', // unknown | observed_success | denied | failed
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deliveryUnknown: 0,
      lastResultAt: null,
      lastHttpStatus: null,
      lastApiCode: null,
      lastCategory: null,
      lastSeq: 0,
    }
  }
  const permissions = {
    grant: 'unknown', // unknown | granted | denied（仅 scope_read 来源）
    source: null,
    checkedAt: null,
    queryState: 'never', // never | in_flight | ok | failed
    failedCategory: null, // null | network | timeout | http_error | malformed
  }
  // 图片三项独立权限域（status.images.permissions；与操作桶分离=权限≠操作证据）。
  const imagesPermState = {
    upload: { grant: 'unknown', source: null, checkedAt: null },
    download: { grant: 'unknown', source: null, checkedAt: null },
    groupHistory: { grant: 'unknown', source: null, checkedAt: null },
  }
  // 查询失败可见：新最后一次 scope 查询失败 → 三项强制 stale=true（即使旧
  // checkedAt 未到 TTL）；下次成功查询清除。旧 granted 绝不伪装 fresh。
  let imagesQueryFailed = false
  // 接线注入（只读视图）：status 每次直读真实 store；默认未接线。
  let dedupReader = null
  let imagesAvailable = false
  let imageReceiptErrors = 0
  const stream = {
    hostSeen: { start: 0, chunk: 0, textDelta: 0, blockEnd: 0, end: 0 },
    engineAccepted: { start: 0, textDelta: 0, end: 0 },
    engineRejected: {
      duplicateIndex: 0,
      duplicateRevision: 0,
      regressedRevision: 0,
      denseIndexGap: 0,
      shape: 0,
      unbound: 0,
      stale: 0,
    },
    finalReceived: 0,
    turnEndReceived: 0,
    aborted: 0,
    observedMode: 'pending',
    finalStatic: { count: 0, lastReason: null, lastAt: null },
    // 纯本地拒绝（未派发网络）：与 operations 分开，attempted 保持真实派发语义。
    localRefusals: { count: 0, lastCategory: null, lastAt: null },
  }
  const turns = new Map() // `slot:turn` → 回合记录（稳定身份，跨 active/terminal）
  // 结算水位按 **Agent 弱键**（WeakMap）存储：条目随 Agent 对象可回收自然消失，
  // 不留“每曾见 Agent 一个永久小条目”；仍被外部持有的已 dispose Agent（键存活）
  // 依旧拒绝旧 final 复活。turn 推进即清旧 step，条目本身有界。
  const agentWatermarks = new WeakMap() // Agent 对象 → { turn, steps: Map<turn, maxStep> }

  function turnKey(slot, turn) {
    return String(slot) + ':' + String(turn)
  }

  function isTerminal(rec) {
    return rec.outcome !== 'in_progress'
  }

  // 有界终态历史：终态变更时及时修剪（不只在新建时）；只淘汰已终态且非当前
  // 摘要的记录，真实在途身份绝不逐出。
  function compactTerminal() {
    if (turns.size <= MAX_RECENT_TURNS) return
    for (const rec of turns.values()) {
      if (turns.size <= MAX_RECENT_TURNS) return
      if (isTerminal(rec) && rec !== currentTurn) turns.delete(turnKey(rec.slot, rec.turn))
    }
  }

  function agentWatermarkFor(agent) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return null
    let wm = agentWatermarks.get(agent)
    if (!wm) {
      wm = { turn: -1, steps: new Map() }
      agentWatermarks.set(agent, wm)
    }
    return wm
  }

  function makeWeakRef(agent) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function') || typeof WeakRef === 'undefined') return null
    try { return new WeakRef(agent) } catch { return null }
  }

  function noteSettledWatermark(rec) {
    const agent = rec.agentRef && typeof rec.agentRef.deref === 'function' ? rec.agentRef.deref() : null
    const wm = agentWatermarkFor(agent)
    if (!wm) return
    if (rec.turn > wm.turn) {
      wm.turn = rec.turn
      wm.steps.clear() // 只保留当前水位 turn 的 step（有界）
    }
    if (rec.turn === wm.turn && rec.step != null) {
      const prev = wm.steps.has(rec.turn) ? wm.steps.get(rec.turn) : -1
      if (rec.step > prev) wm.steps.set(rec.turn, rec.step)
    }
  }

  // 统一终态出口：失败原因 + 冻结 completion 快照 + 水位 + 历史修剪。
  // failureReason 由触发终局的真实分支传入；completed/aborted/dispose 为 null（不猜）。
  function markTerminal(rec, failureReason = null) {
    rec.failureReason = failureReason || null
    rec.completionSnapshot = {
      pendingTasks: rec.pendingTasks,
      pendingOps: rec.pendingOps,
      enginesPending: rec.enginesPending,
      cardsOpened: rec.cardsOpened,
      cardsClosed: rec.cardsClosed,
      incompleteSteps: [...rec.engineSteps.values()].filter((v) => v.unknown || v.delivered !== true).length,
    }
    noteSettledWatermark(rec)
    compactTerminal()
  }

  function liveCompletion(rec) {
    return {
      pendingTasks: rec.pendingTasks,
      pendingOps: rec.pendingOps,
      enginesPending: rec.enginesPending,
      cardsOpened: rec.cardsOpened,
      cardsClosed: rec.cardsClosed,
      incompleteSteps: [...rec.engineSteps.values()].filter((v) => v.unknown || v.delivered !== true).length,
    }
  }

  function pushEvent(rec, kind, at) {
    if (!rec) return
    rec.events.push({ seq: ++rec.eventSeq, atMs: at, kind })
    while (rec.events.length > MAX_TURN_EVENTS) rec.events.shift()
  }

  // 有界：仅淘汰**已终态**的最旧记录；未结算身份绝不逐出（P1）。
  function evictTerminalIfNeeded() {
    if (turns.size <= MAX_TURNS) return
    for (const rec of turns.values()) {
      if (turns.size <= MAX_TURNS) return
      if (isTerminal(rec)) turns.delete(turnKey(rec.slot, rec.turn))
    }
  }

  function ensureTurn(slot, turn, step, at, agent) {
    if (slot == null || turn == null || !Number.isFinite(turn)) return null
    const key = turnKey(slot, turn)
    let rec = turns.get(key)
    if (!rec) {
      // 结算水位防复活（P2）：已明确结算的旧身份（低于水位 turn，或同 turn 已
      // 结算 step 重放/无 step）不得重建；同 turn 严格更大的新 step 放行；
      // 活跃身份优先（上面 turns 命中即用，保护合法旧活跃补尾）。
      const wm = agentWatermarkFor(agent)
      if (wm) {
        if (turn < wm.turn) return null
        if (turn === wm.turn) {
          const maxStep = wm.steps.has(turn) ? wm.steps.get(turn) : -1
          const givenStep = intOrNull(step)
          if (givenStep == null || givenStep <= maxStep) return null
        }
      }
      rec = {
        turnId: ++turnSeq,
        slot,
        turn,
        step: intOrNull(step),
        startedAt: at,
        updatedAt: at,
        outcome: 'in_progress', // in_progress | completed | canceled | aborted | failed
        startedSeen: false,
        acceptedTextDelta: 0,
        firstAcceptedDeltaAt: null,
        firstDeliveryAckAt: null,
        firstPutSuccessAt: null,
        lastPutSuccessAt: null,
        finalReceivedAt: null,
        liveEndAt: null,
        turnEndAt: null,
        terminalCloseAt: null,
        putBeforeFinal: 0,
        putBeforeTurnEnd: 0,
        putTotal: 0,
        // 终局门控（P1）：在途操作 ACK + 逐卡关闭 + 引擎队列/尝试生命周期。
        agentRef: makeWeakRef(agent), // 弱引用：记录不延 Agent 生命周期
        pendingOps: 0,
        pendingTasks: 0, // 引擎串行队列待办（token 等待/分段/flush/finish，非 HTTP attempted）
        enginesPending: 0, // 已接纳未结算的正文/收尾任务
        engineLastDelivered: null, // 最近一次权威结算镜像（仅无 step 归集时启发式）
        engineSteps: new Map(), // stepKey → { delivered, unknown }（按 step 归集，最新权威覆盖同 step）
        engineAnyUnknown: false,
        cardsOpened: 0,
        cardsClosed: 0,
        lastCloseAckAt: null,
        staticFinalUsed: false,
        staticFinalReason: null,
        staticFinalAt: null,
        observed: {
          card: false,
          static: false,
          text: false,
          denied: false,
          rateLimited: false,
          outputFailed: false,
          outputUnknown: false,
        },
        rejectedSeen: 0,
        // ── 机密化失败解释与终局快照（固定枚举/数值，无正文/身份）──
        failureReason: null, // 终局时真实分支：cards_unclosed|delivery_unknown|engine_incomplete|transport_failure|local_refusal
        completionSnapshot: null, // 终局冻结的 completion 快照（serialize 明确区分活值/终态）
        endKind: null, // null | committed | abandoned（end 帧）
        settlementType: null, // null | assistant_message | assistant_attempt（end eventType 白名单）
        interrupted: null, // 仅来自 final（assistant/message）严格布尔：null（缺失/非法）| true | false
        firstPutDispatchAt: null,
        lastPutDispatchAt: null,
        putDispatchedBeforeFinal: 0, // 按 onAttempt 派发时刻计（与 ACK 计数分离）
        putDispatchedBeforeTurnEnd: 0,
        delivery: null, // 最新一次 attempt 结算的匿名交付视图（含 authoritative 布尔）
        localRefusalCount: 0,
        events: [],
        eventSeq: 0,
      }
      turns.set(key, rec)
      evictTerminalIfNeeded()
      currentTurn = rec
      return rec
    }
    // 稳定身份：已存在（含已终态）绝不重建、绝不复活；只在进行中时更新可见步进。
    if (!isTerminal(rec)) {
      if (intOrNull(step) != null) rec.step = intOrNull(step)
      rec.updatedAt = at
      currentTurn = rec
    }
    return rec
  }

  function hasOutputSuccess(rec) {
    return Boolean(rec && (rec.observed.card || rec.observed.text || rec.observed.static))
  }

  // 首次投递确认：起点=该回合首个 accepted text-delta，终点=其后首个成功的
  // reference/text/static ACK（服务端确认代理值，不是客户端渲染可见延迟）。
  // 非流式（无 accepted delta）恒为 null——不与其它指标同名混用。
  function noteDeliveryAck(rec, at) {
    if (!rec || rec.firstDeliveryAckAt != null) return
    if (rec.firstAcceptedDeltaAt != null && at >= rec.firstAcceptedDeltaAt) rec.firstDeliveryAckAt = at
  }

  // 终局只依据真实信号：final + turnEnd + 所有在途操作 ACK（pendingOps=0）+
  // 引擎队列待办清空（pendingTasks=0）+ 尝试全部结算（enginesPending=0）+
  // 逐卡关闭（cardsOpened=cardsClosed）+ 引擎确认最终正文完整交付；未知投递/
  // 确定失败/无法确认关闭都归 failed，绝不假 completed。计数静止不算完成。
  function maybeComplete(rec) {
    if (!rec || isTerminal(rec)) return
    if (rec.finalReceivedAt == null || rec.turnEndAt == null) return
    if (rec.pendingOps > 0) return // 在途正文/收卡 HTTP ACK 未落定
    if (rec.pendingTasks > 0) return // 引擎串行队列仍有待办（含 token 等待/分段未派发）
    if (rec.enginesPending > 0) return // 已接纳的正文/收尾任务未全部结算
    if (rec.cardsOpened > rec.cardsClosed) {
      // 已无在途仍无法确认全部关闭：区分 close 未知与仅未收妥。
      rec.outcome = 'failed'
      markTerminal(rec, rec.observed.outputUnknown ? 'delivery_unknown' : 'cards_unclosed')
      return
    }
    if (rec.engineAnyUnknown || rec.observed.outputUnknown) {
      rec.outcome = 'failed'
      markTerminal(rec, 'delivery_unknown')
      return
    }
    // 按 step/有效 attempt 归集交付终局（P1）：任一已提交 step 未完整送达即失败；
    // 同 step 以最新权威结算为准（有限补试补齐/有效替代可恢复），不同 step 的
    // 成功不得抹掉别的 step 的失败。
    const localBlocked = rec.delivery && rec.delivery.outputBlocked === true
    for (const entry of rec.engineSteps.values()) {
      if (entry.unknown || entry.delivered === false) {
        rec.outcome = 'failed'
        markTerminal(rec, localBlocked ? 'local_refusal' : 'engine_incomplete')
        return
      }
    }
    if (rec.engineSteps.size === 0 && rec.engineLastDelivered === false) {
      // 最终正文目标未完整交付（如尾段确定失败且有限补试耗尽）：不得 completed。
      rec.outcome = 'failed'
      markTerminal(rec, localBlocked ? 'local_refusal' : 'engine_incomplete')
      return
    }
    if (rec.engineSteps.size === 0 && rec.engineLastDelivered == null
      && rec.observed.outputFailed && !hasOutputSuccess(rec)) {
      rec.outcome = 'failed'
      markTerminal(rec, 'transport_failure')
      return
    }
    rec.outcome = 'completed'
    markTerminal(rec, null)
  }

  // 静态兜底原因：只按已记录证据映射，无证据不猜（返回 null = 原因未知）。
  function deriveStaticReason(rec) {
    if (!rec) return 'no_live_frames'
    if (rec.observed.denied) return 'permission_denied'
    if (rec.observed.outputUnknown) return 'delivery_unknown'
    if (rec.observed.outputFailed) return 'known_transport_failure'
    if (!rec.startedSeen) return 'non_streaming'
    if (rec.acceptedTextDelta === 0) return 'no_live_frames'
    if (rec.rejectedSeen > 0) return 'live_rejected'
    return null
  }

  function deriveObservedMode(rec) {
    if (!rec) return 'pending'
    if (rec.observed.card) return 'live_card'
    if (rec.observed.text) return 'text'
    if (rec.observed.static) return 'static_interactive'
    if (rec.observed.outputFailed || rec.observed.outputUnknown) return 'failed'
    return 'pending'
  }

  function deriveUserState(rec) {
    if (!rec) return 'waiting_new_request'
    if (rec.outcome === 'completed') return 'completed'
    if (rec.outcome === 'aborted' || rec.outcome === 'canceled') return 'failed'
    if (rec.outcome === 'failed') return rec.observed.outputUnknown ? 'unknown_delivery' : 'failed'
    if (rec.observed.denied) return 'missing_scope'
    if (rec.observed.rateLimited) return 'rate_limited'
    if (rec.staticFinalUsed) return 'static_final'
    if (rec.observed.card) return 'live_card'
    if (rec.observed.text) return 'multi_text'
    if (rec.observed.outputUnknown) return 'unknown_delivery'
    if (rec.observed.outputFailed) return 'failed'
    if (rec.startedSeen || rec.acceptedTextDelta > 0) return 'receiving_no_output'
    return 'waiting_new_request'
  }

  // cardkit 总体状态：按**派发单调序号**水位比较（P1）——较旧操作的晚到成功只计
  // 自己桶的历史，不得覆盖较新拒绝；真正更新的成功才恢复。
  function deriveCardkitState() {
    const anySuccess = [...CARD_OPS].some((op) => ops[op].state === 'observed_success')
    if (cardDeniedSeq < 0 && !anySuccess) return 'unknown'
    if (cardDeniedSeq >= cardSuccessSeq) return 'denied'
    return 'observed_success'
  }

  function rel(at, base) {
    return at != null && base != null ? at - base : null
  }

  const diag = {
    generation,

    slotOf(agent) {
      if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return null
      let slot = slots.get(agent)
      if (slot == null) {
        slotSeq += 1
        slots.set(agent, slotSeq)
        slot = slotSeq
      }
      return slot
    },

    // 宿主侧 seen 计数（listener 收到的原始帧，未经引擎校验）。
    noteHostFrame(frameType, chunkType) {
      if (frameType === 'start') stream.hostSeen.start += 1
      else if (frameType === 'chunk') {
        stream.hostSeen.chunk += 1
        if (chunkType === 'text-delta') stream.hostSeen.textDelta += 1
        else if (chunkType === 'block-end') stream.hostSeen.blockEnd += 1
      } else if (frameType === 'end') stream.hostSeen.end += 1
    },

    // 引擎接受（严格 shape + revision + dense index 校验通过并计入正文/进度）。
    noteFrameAccepted(slot, detail, at, agent) {
      const nowMs = at || Date.now()
      const kind = detail && detail.kind
      const rec = ensureTurn(slot, detail && detail.turn, detail && detail.step, nowMs, agent)
      if (kind === 'start') {
        stream.engineAccepted.start += 1
        if (rec && !isTerminal(rec)) {
          rec.startedSeen = true
          pushEvent(rec, 'start', nowMs)
        }
      } else if (kind === 'chunk') {
        if (detail && detail.textDelta === true) {
          stream.engineAccepted.textDelta += 1
          if (rec && !isTerminal(rec)) {
            rec.acceptedTextDelta += 1
            if (rec.firstAcceptedDeltaAt == null) rec.firstAcceptedDeltaAt = nowMs
            pushEvent(rec, 'delta_accepted', nowMs)
          }
        }
      } else if (kind === 'end') {
        stream.engineAccepted.end += 1
        if (rec && !isTerminal(rec)) {
          rec.liveEndAt = nowMs
          if (detail && (detail.endKind === 'committed' || detail.endKind === 'abandoned')) rec.endKind = detail.endKind
          if (detail && (detail.settlement === 'assistant_message' || detail.settlement === 'assistant_attempt')) rec.settlementType = detail.settlement
          pushEvent(rec, 'live_end', nowMs)
        }
      }
    },

    // 引擎拒绝分类（P1：可归属的携带 slot/turn/step 写回**实际**回合；不可归属的
    // 只计全局总数，不猜最近回合）。
    noteFrameRejected(category, at, attribution) {
      if (!FRAME_REJECT_CATEGORIES.has(category)) return
      stream.engineRejected[category] += 1
      const nowMs = at || Date.now()
      if (!attribution || attribution.turn == null || !Number.isFinite(attribution.turn)) return
      const rec = ensureTurn(attribution.slot, attribution.turn, attribution.step, nowMs, attribution && attribution.agent)
      if (!rec) return
      rec.rejectedSeen += 1
      pushEvent(rec, 'delta_rejected', nowMs)
    },

    noteTelemetry(kind, detail, slot, at, agent) {
      const nowMs = at || Date.now()
      if (kind === 'frame_accepted') diag.noteFrameAccepted(slot, detail, nowMs, agent)
      else if (kind === 'frame_rejected') {
        const attributable = detail && Number.isFinite(detail.turn)
        diag.noteFrameRejected(detail && detail.category, nowMs, attributable
          ? { slot, turn: detail.turn, step: detail.step, agent }
          : null)
      }
      else if (kind === 'task_enqueued') diag.noteTaskEnqueued(slot, detail && detail.turn, detail && detail.step, nowMs, agent)
      else if (kind === 'task_settled') diag.noteTaskSettled(slot, detail && detail.turn, detail && detail.step, nowMs, agent)
      else if (kind === 'attempt_opened') diag.noteEngineOpened(slot, detail && detail.turn, detail && detail.step, nowMs, agent)
      else if (kind === 'attempt_finished') diag.noteEngineFinished(slot, detail && detail.turn, detail && detail.step, detail, nowMs, agent)
    },

    // 引擎串行队列生命周期（P1）：入队即本地 pending（不是 HTTP attempted），
    // 执行/跳过/失败即释放；覆盖 token 等待、分段、flush、final、finish。
    noteTaskEnqueued(slot, turn, step, at, agent) {
      if (!Number.isFinite(turn)) return
      const rec = ensureTurn(slot, turn, step, at || Date.now(), agent)
      if (!rec || isTerminal(rec)) return
      rec.pendingTasks += 1
    },

    noteTaskSettled(slot, turn, step, at, agent) {
      if (!Number.isFinite(turn)) return
      const rec = ensureTurn(slot, turn, step, at || Date.now(), agent)
      if (!rec || isTerminal(rec)) return
      rec.pendingTasks = rec.pendingTasks > 0 ? rec.pendingTasks - 1 : 0 // 源侧已保证恰好一次
      maybeComplete(rec)
    },

    // 尝试生命周期：opened（流 start / 非流式 final 虚拟 attempt）→ finished
    //（finishTask 真实结算：delivered=最终正文目标是否完整交付；authoritative=false
    // 仅用于被取代且从未开正文的 attempt，不作交付结论）。
    noteEngineOpened(slot, turn, step, at, agent) {
      if (!Number.isFinite(turn)) return
      const rec = ensureTurn(slot, turn, step, at || Date.now(), agent)
      if (!rec || isTerminal(rec)) return
      rec.enginesPending += 1
    },

    noteEngineFinished(slot, turn, step, info, at, agent) {
      if (!Number.isFinite(turn)) return
      const rec = ensureTurn(slot, turn, step, at || Date.now(), agent)
      if (!rec || isTerminal(rec)) return
      rec.enginesPending = rec.enginesPending > 0 ? rec.enginesPending - 1 : 0 // 源侧已保证恰好一次
      // 匿名交付视图：最新一次 attempt 结算（含 authoritative 布尔）；完成判定仍以
      // engineSteps 多 step 汇总为准，本视图供解释字段。
      rec.delivery = {
        targetSource: info && (info.targetSource === 'final' || info.targetSource === 'delta') ? info.targetSource : null,
        targetLength: info && Number.isSafeInteger(info.targetLength) && info.targetLength >= 0 ? info.targetLength : null,
        publishedLength: info && Number.isSafeInteger(info.publishedLength) && info.publishedLength >= 0 ? info.publishedLength : null,
        sentLength: info && Number.isSafeInteger(info.sentLength) && info.sentLength >= 0 ? info.sentLength : null,
        exactTargetMatch: Boolean(info && info.exactTargetMatch),
        delivered: Boolean(info && info.delivered),
        failed: Boolean(info && info.failed),
        unknown: Boolean(info && info.unknown),
        authoritative: !(info && info.authoritative === false),
        cancelled: Boolean(info && info.cancelled),
        outputBlocked: Boolean(info && info.outputBlocked),
      }
      if (info && info.authoritative !== false) {
        rec.engineLastDelivered = info && info.delivered === true
        if (info && info.unknown === true) rec.engineAnyUnknown = true
        // 按 step 归集：同 step 最新权威结算覆盖（补试补齐/有效替代可恢复），
        // 不同 step 独立保留（任一失败都阻止 completed，不被后 step 成功覆盖）。
        const stepKey = Number.isFinite(step) ? 's' + step : 'a'
        rec.engineSteps.set(stepKey, {
          delivered: info && info.delivered === true,
          unknown: info && info.unknown === true,
        })
      }
      maybeComplete(rec)
    },

    // 最终 message 到达（agent/message 事件，独立于 live end，二者时序可区分）。
    // 已终态身份的迟到/重复 final：只计接收总数，**不复活**、不改写记录。
    noteFinal(slot, turn, step, at, agent, interrupted) {
      stream.finalReceived += 1
      const nowMs = at || Date.now()
      const rec = ensureTurn(slot, turn, step, nowMs, agent)
      if (!rec || isTerminal(rec)) return
      // message 域 interrupted：仅严格布尔（true/false）写入，多 step/重复 final
      // 按 latest final 策略；缺失/非法一律不写（不伪造 false、不回退已知值）。
      // 与 turnEnd 结束原因分域——真实已知 true 不被后来的结束原因覆盖。
      if (typeof interrupted === 'boolean') rec.interrupted = interrupted
      rec.finalReceivedAt = nowMs
      pushEvent(rec, 'final', nowMs)
      maybeComplete(rec)
    },

    noteTurnEnd(slot, turn, at, agent) {
      stream.turnEndReceived += 1
      const nowMs = at || Date.now()
      const rec = ensureTurn(slot, turn, null, nowMs, agent)
      if (!rec || isTerminal(rec)) return
      rec.turnEndAt = nowMs
      pushEvent(rec, 'turn_end', nowMs)
      maybeComplete(rec)
    },

    noteAbort(slot, turn, at, agent) {
      stream.aborted += 1
      const nowMs = at || Date.now()
      const rec = turns.get(turnKey(slot, turn)) || null
      if (!rec || isTerminal(rec)) return
      rec.outcome = 'aborted'
      pushEvent(rec, 'turn_end', nowMs)
      markTerminal(rec, null)
    },

    // Agent 级 dispose：只终结该槽位自己的进行中记录（不动其他并发 Agent）。
    noteAgentDispose(slot, at) {
      const nowMs = at || Date.now()
      for (const rec of Array.from(turns.values())) {
        if (rec.slot !== slot || isTerminal(rec)) continue
        rec.outcome = 'aborted'
        pushEvent(rec, 'dispose', nowMs)
        markTerminal(rec, null)
      }
      compactTerminal()
    },

    // 静态兜底被使用（final && !everOpened 分支）：原因按当时证据推导。
    noteStaticFinal(slot, turn, at, agent) {
      const nowMs = at || Date.now()
      const rec = ensureTurn(slot, turn, null, nowMs, agent)
      stream.finalStatic.count += 1
      const reason = deriveStaticReason(rec)
      stream.finalStatic.lastReason = reason
      stream.finalStatic.lastAt = nowMs
      if (rec && !isTerminal(rec)) {
        rec.staticFinalUsed = true
        rec.staticFinalReason = reason
        rec.staticFinalAt = nowMs
      }
    },

    // 全局 dispose/reload：进行中回合标记 aborted（不冒充 completed）。
    noteDispose(at) {
      const nowMs = at || Date.now()
      for (const rec of Array.from(turns.values())) {
        if (isTerminal(rec)) continue
        rec.outcome = 'aborted'
        pushEvent(rec, 'dispose', nowMs)
        markTerminal(rec, null)
      }
      compactTerminal()
    },

    // 纯本地拒绝（well-formed/预算/schema）：**未派发网络**，不计任何 operation
    // attempted，只进独立计数（wire 可核对性）。
    noteLocalRefusal(category, at) {
      if (!LOCAL_REFUSAL_CATEGORIES.has(category)) return
      stream.localRefusals.count += 1
      stream.localRefusals.lastCategory = category
      stream.localRefusals.lastAt = at || Date.now()
      if (currentTurn && !isTerminal(currentTurn)) currentTurn.localRefusalCount += 1
    },

    // 操作派发：捕获 store 引用 + generation + 归属回合；结算只回写原桶。
    // attempted 在真实派发时 +1；结算恰好一次（token.settled 保证）。
    opAttempt(op, ctx) {
      if (!OPS.includes(op)) return null
      const bucket = ops[op]
      bucket.attempted += 1
      const at = Date.now()
      const rec = ctx && ctx.turn != null ? ensureTurn(ctx.slot, ctx.turn, ctx.step, at, ctx && ctx.agent) : null
      if (rec && !isTerminal(rec)) {
        rec.pendingOps += 1 // 在途 ACK 计入终局门控
        if (op === 'card_put') {
          // PUT 派发时刻/派发计数（与成功 ACK 时刻明确分离）。
          if (rec.firstPutDispatchAt == null) rec.firstPutDispatchAt = at
          rec.lastPutDispatchAt = at
          if (rec.finalReceivedAt == null) rec.putDispatchedBeforeFinal += 1
          if (rec.turnEndAt == null) rec.putDispatchedBeforeTurnEnd += 1
        }
      }
      return { store: diag, gen: generation, seq: ++opSeq, op, rec, settled: false }
    },

    // res: { ok, status, apiCode, unknown, errorText } —— errorText 仅分类用，不落库。
    opSettle(token, res) {
      if (!token || token.settled) return
      token.settled = true
      // 代际/归属防护：旧代迟到结果只落自己的 store；跨代调用直接丢弃。
      if (token.store !== diag || token.gen !== generation) return
      const bucket = ops[token.op]
      if (!bucket) return
      const at = Date.now()
      const ok = Boolean(res && res.ok)
      const status = intOrNull(res && res.status)
      const apiCode = intOrNull(res && res.apiCode)
      const unknown = Boolean(res && res.unknown)
      const rec = token.rec
      if (rec && !isTerminal(rec)) rec.pendingOps = Math.max(0, rec.pendingOps - 1)
      if (ok) bucket.succeeded += 1
      else if (unknown) bucket.deliveryUnknown += 1
      else bucket.failed += 1
      const fresh = token.seq >= bucket.lastSeq
      if (ok) {
        if (fresh) {
          bucket.lastSeq = token.seq
          bucket.state = 'observed_success'
          bucket.lastResultAt = at
          bucket.lastHttpStatus = status
          bucket.lastApiCode = apiCode ?? 0
          bucket.lastCategory = null
        }
        if (CARD_OPS.has(token.op) && token.seq > cardSuccessSeq) cardSuccessSeq = token.seq
        if (token.op === 'card_create' && rec && !isTerminal(rec)) {
          rec.cardsOpened += 1
          // 新卡待收：旧 rollover 成功 ACK 立即失去“终态”资格（P2）。
          rec.terminalCloseAt = null
        }
        if (token.op === 'card_close' && rec && !isTerminal(rec)) {
          rec.cardsClosed += 1
          rec.lastCloseAckAt = at
          // 终态关闭 ACK 只在**本回合所有已创建卡真正收妥**时展示；中途 rollover
          // close 仍由 close_ok 事件表示，不伪造终态顺序（P2）。
          rec.terminalCloseAt = rec.cardsClosed === rec.cardsOpened ? at : null
        }
        if (rec && !isTerminal(rec)) {
          if (token.op === 'card_reference') {
            rec.observed.card = true
            noteDeliveryAck(rec, at)
          } else if (token.op === 'text_send') {
            rec.observed.text = true
            noteDeliveryAck(rec, at)
          } else if (token.op === 'static_interactive') {
            rec.observed.static = true
            noteDeliveryAck(rec, at)
          } else if (token.op === 'card_put') {
            rec.putTotal += 1
            // 终局前 PUT：以成功 ACK 时刻是否已收到 final/turnEnd 计数，不按排队推定。
            if (rec.finalReceivedAt == null) rec.putBeforeFinal += 1
            if (rec.turnEndAt == null) rec.putBeforeTurnEnd += 1
            if (rec.firstPutSuccessAt == null) rec.firstPutSuccessAt = at
            rec.lastPutSuccessAt = at
          }
        }
      } else {
        const cls = classifyLarkApiFailure({ status, apiCode, errorText: res && res.errorText, unknown })
        if (fresh) {
          bucket.lastSeq = token.seq
          bucket.state = cls.outcome
          bucket.lastResultAt = at
          bucket.lastHttpStatus = status
          bucket.lastApiCode = apiCode
          bucket.lastCategory = cls.category
        }
        if (CARD_OPS.has(token.op)) {
          if (cls.outcome === 'denied' && token.seq > cardDeniedSeq) cardDeniedSeq = token.seq
        }
        if (rec && !isTerminal(rec)) {
          if (cls.outcome === 'denied') rec.observed.denied = true
          if (cls.category === 'rate_limited') rec.observed.rateLimited = true
          if (cls.outcome === 'unknown') rec.observed.outputUnknown = true
          else rec.observed.outputFailed = true
        }
        if (CARD_OPS.has(token.op) && token.seq >= lastFailureSeq) {
          lastFailureSeq = token.seq
          lastFailure = {
            operation: token.op,
            httpStatus: status,
            apiCode,
            category: cls.category,
            scope: cls.scope,
            at,
          }
        }
        // 终态收卡失败：旧成功 ACK 失去终态资格；回合按真实回调标 failed。
        if (token.op === 'card_close' && rec && !isTerminal(rec)) {
          rec.terminalCloseAt = null
          if (rec.finalReceivedAt != null && rec.turnEndAt != null) {
            rec.outcome = 'failed'
            markTerminal(rec, unknown ? 'delivery_unknown' : 'transport_failure')
          }
        }
      }
      const evtKind = EVENT_OP_KIND[token.op]
      if (evtKind && rec) pushEvent(rec, evtKind + (ok ? '_ok' : '_fail'), at)
      if (rec && !isTerminal(rec)) maybeComplete(rec)
    },

    // ── permissions（grant 域）：只读 scope 查询结果 ──
    setPermissions(patch) {
      if (!patch || typeof patch !== 'object') return
      if (['unknown', 'granted', 'denied'].includes(patch.grant)) permissions.grant = patch.grant
      if (patch.source === 'scope_read') permissions.source = 'scope_read'
      if (patch.checkedAt === null || Number.isFinite(patch.checkedAt)) permissions.checkedAt = patch.checkedAt
      if (['never', 'in_flight', 'ok', 'failed'].includes(patch.queryState)) permissions.queryState = patch.queryState
      // 查询结果对新三权限的新鲜度影响：失败→强制 stale；成功（含 images 三项）→清除。
      if (patch.queryState === 'failed') imagesQueryFailed = true
      if (patch.queryState === 'ok') imagesQueryFailed = false
      if (patch.failedCategory === null || ['network', 'timeout', 'http_error', 'malformed'].includes(patch.failedCategory)) {
        permissions.failedCategory = patch.failedCategory
      }
      // 图片三项显式输入（OR 组规则见 deriveImageScopeGrants；缺项不改旧证据）。
      if (patch.images && typeof patch.images === 'object') {
        for (const key of ['upload', 'download', 'groupHistory']) {
          const item = patch.images[key]
          if (!item || typeof item !== 'object') continue
          const slice = imagesPermState[key]
          if (['unknown', 'granted', 'denied'].includes(item.grant)) slice.grant = item.grant
          if (item.source === 'scope_read') slice.source = 'scope_read'
          if (item.checkedAt === null || Number.isFinite(item.checkedAt)) slice.checkedAt = item.checkedAt
        }
      }
    },

    // 接线注入：真实 dedup store 只读视图（status 每次直读，不缓存模型字段）。
    setDedupReader(fn) { dedupReader = typeof fn === 'function' ? fn : null },
    setImagesAvailable(v) { imagesAvailable = v === true },
    noteImageReceiptError() { imageReceiptErrors += 1 },

    permissionsView(now) {
      const stale = permissions.checkedAt != null && now - permissions.checkedAt > SCOPE_STALE_TTL_MS
      return {
        grant: permissions.grant,
        source: permissions.source,
        checkedAt: permissions.checkedAt,
        queryState: permissions.queryState,
        failedCategory: permissions.failedCategory,
        stale,
      }
    },

    // status.dedup：每次直读真实 store（reader 缺失/抛错 → available:false，
    // 诊断降级绝不影响 status 出口，也不以模型字段当存储真源）。
    dedupStatusView() {
      let src = null
      if (dedupReader) {
        try { src = dedupReader() } catch { src = null }
      }
      return normalizeLarkDedupStatus(src)
    },

    // status.images：图片操作桶（证据域）与三项 scope 权限（权限域）分离展示；
    // available 只表示服务/接线可用，不等于实际图片已收发成功。
    imagesView(now) {
      const operations = {}
      for (const op of IMAGE_OPS) {
        const bucket = ops[op]
        operations[op] = {
          state: bucket.state,
          attempted: bucket.attempted,
          succeeded: bucket.succeeded,
          failed: bucket.failed,
          deliveryUnknown: bucket.deliveryUnknown,
          lastResultAt: bucket.lastResultAt,
          lastHttpStatus: bucket.lastHttpStatus,
          lastApiCode: bucket.lastApiCode,
          lastCategory: bucket.lastCategory && FAILURE_CATEGORIES.has(bucket.lastCategory) ? bucket.lastCategory : null,
        }
      }
      const permView = {}
      for (const key of ['upload', 'download', 'groupHistory']) {
        const slice = imagesPermState[key]
        permView[key] = {
          grant: slice.grant,
          source: slice.source,
          checkedAt: slice.checkedAt,
          stale: imagesQueryFailed || (slice.checkedAt != null && now - slice.checkedAt > SCOPE_STALE_TTL_MS),
        }
      }
      return {
        schemaVersion: 1,
        available: imagesAvailable,
        operations,
        receiptErrors: imageReceiptErrors,
        permissions: permView,
      }
    },

    // 白盒可观测计数（仅测试/排障用，不进 serialize 出口）：回合记录规模边界。
    debugCounts() {
      let active = 0
      for (const rec of turns.values()) if (!isTerminal(rec)) active += 1
      return { turns: turns.size, active, terminal: turns.size - active }
    },

    // 白名单序列化出口：逐字段构造，绝不展开内部对象；任何缺省值都是安全标量。
    // 渠道未运行时不输出 userState（UI 回落 channel.state）；running 时必有枚举值。
    serialize({ configuredMode, running, now }) {
      const latest = currentTurn || null
      const turnView = latest
        ? {
          turnId: latest.turnId,
          step: latest.step,
          startedAt: latest.startedAt,
          outcome: latest.outcome,
          // 解释性字段（固定枚举/数值/布尔；UI 首批消费 failureReason/completion/
          // endKind/dispatch 计数与时刻）：失败原因只在真实终局时记录，进行中为 null。
          failureReason: isTerminal(latest) ? (latest.failureReason || null) : null,
          // completion：终态=冻结快照；进行中=最新活值（含义已区分，不混用）。
          completion: isTerminal(latest) && latest.completionSnapshot
            ? { ...latest.completionSnapshot }
            : liveCompletion(latest),
          endKind: latest.endKind,
          settlementType: latest.settlementType,
          interrupted: latest.interrupted,
          delivery: latest.delivery ? { ...latest.delivery } : null,
          timings: {
            firstAcceptedTextDeltaMs: rel(latest.firstAcceptedDeltaAt, latest.startedAt),
            firstDeliveryAckMs: rel(latest.firstDeliveryAckAt, latest.firstAcceptedDeltaAt),
            firstPutSuccessMs: rel(latest.firstPutSuccessAt, latest.startedAt),
            lastPutSuccessMs: rel(latest.lastPutSuccessAt, latest.startedAt),
            firstPutDispatchMs: rel(latest.firstPutDispatchAt, latest.startedAt),
            lastPutDispatchMs: rel(latest.lastPutDispatchAt, latest.startedAt),
            finalReceivedMs: rel(latest.finalReceivedAt, latest.startedAt),
            liveEndMs: rel(latest.liveEndAt, latest.startedAt),
            turnEndMs: rel(latest.turnEndAt, latest.startedAt),
            terminalCloseMs: latest.outcome === 'completed' ? rel(latest.terminalCloseAt, latest.startedAt) : null,
          },
          counts: {
            acceptedTextDelta: latest.acceptedTextDelta,
            putBeforeFinal: latest.putBeforeFinal,
            putBeforeTurnEnd: latest.putBeforeTurnEnd,
            putTotal: latest.putTotal,
            // 按真实 onAttempt 派发记录（与 ACK 计数分离）。
            putDispatchedBeforeFinal: latest.putDispatchedBeforeFinal,
            putDispatchedBeforeTurnEnd: latest.putDispatchedBeforeTurnEnd,
          },
          staticFinal: { used: latest.staticFinalUsed, reason: latest.staticFinalReason },
          events: latest.events.map((event) => ({ seq: event.seq, atMs: event.atMs, kind: event.kind })),
        }
        : null
      stream.observedMode = deriveObservedMode(latest)
      const opsView = {}
      for (const op of OPS) {
        const bucket = ops[op]
        opsView[op] = {
          state: bucket.state,
          attempted: bucket.attempted,
          succeeded: bucket.succeeded,
          failed: bucket.failed,
          deliveryUnknown: bucket.deliveryUnknown,
          lastResultAt: bucket.lastResultAt,
          lastHttpStatus: bucket.lastHttpStatus,
          lastApiCode: bucket.lastApiCode,
          lastCategory: bucket.lastCategory && FAILURE_CATEGORIES.has(bucket.lastCategory) ? bucket.lastCategory : null,
        }
      }
      const out = {
        schemaVersion: 1,
        generation,
        configuredMode,
        permissions: { cardkitWrite: diag.permissionsView(now) },
        // status 增量契约（冻结 v1，加法兼容）：dedup/images 独立对象。
        dedup: diag.dedupStatusView(),
        images: diag.imagesView(now),
        cardkit: {
          requiredScope: LARK_SCOPE_CARDKIT_WRITE,
          state: deriveCardkitState(),
          operationsVerified: OPS.filter((op) => ops[op].state === 'observed_success'),
          lastFailure: lastFailure
            ? {
              operation: lastFailure.operation,
              httpStatus: lastFailure.httpStatus,
              apiCode: lastFailure.apiCode,
              category: lastFailure.category && FAILURE_CATEGORIES.has(lastFailure.category) ? lastFailure.category : null,
              scope: lastFailure.scope,
              at: lastFailure.at,
            }
            : null,
        },
        operations: opsView,
        stream: {
          hostSeen: { ...stream.hostSeen },
          engineAccepted: { ...stream.engineAccepted },
          engineRejected: { ...stream.engineRejected },
          finalReceived: stream.finalReceived,
          turnEndReceived: stream.turnEndReceived,
          aborted: stream.aborted,
          observedMode: stream.observedMode,
          finalStatic: { ...stream.finalStatic },
          localRefusals: { ...stream.localRefusals },
        },
        turn: turnView,
        recentTurns: [...turns.values()]
          .filter((rec) => isTerminal(rec))
          .slice(-MAX_RECENT_TURNS)
          .reverse()
          .map((rec) => ({
            turnId: rec.turnId,
            outcome: rec.outcome,
            failureReason: rec.failureReason || null,
            observedMode: deriveObservedMode(rec),
            counts: {
              acceptedTextDelta: rec.acceptedTextDelta,
              putBeforeFinal: rec.putBeforeFinal,
              putTotal: rec.putTotal,
            },
            staticFinal: { used: rec.staticFinalUsed, reason: rec.staticFinalReason },
            firstDeliveryAckMs: rel(rec.firstDeliveryAckAt, rec.firstAcceptedDeltaAt),
            endedAt: rec.turnEndAt != null ? rec.turnEndAt : rec.updatedAt,
          })),
      }
      if (running) out.userState = deriveUserState(latest)
      return out
    },
  }

  return diag
}
