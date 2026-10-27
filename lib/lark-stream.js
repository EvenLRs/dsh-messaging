// 通用实时流状态机：把 Agent 的 AssistantStreamFrame（start / chunk / end）
// 转成对三个注入回调的串行、节流调用。
//
// 真实帧契约（deepseek-harness core/agent/src/runtime-types.ts + core/agent-loop/src/assistant-stream.ts）：
//   start { type, attemptId, revision, turn, step }
//   chunk { type, attemptId, revision, index, time, chunk }
//   end   { type, attemptId, revision, index, outcome: committed | abandoned }
//   - revision 由 nextRevision() 每帧全局递增（Agent lifecycle 级唯一、单调）：
//     本模块按实例维护 agentRevision，要求每帧严格大于它；等值/回退一律拒绝。
//   - 外层 index 是 attempt 内 dense 连续序号：chunk 必须恰为 lastIndex+1（拒重复/跳号，
//     跳号属丢帧 → onError 显式上报，不静默丢正文）；end.index 必须等于 lastIndex+1
//     （chunk 总数）。内层 chunk.index 是内容块序号，两者不可混用。
//   - 帧 shape 严格校验（safe integer / chunk 类型及内部字段 / outcome eventType+seq），
//     非法帧防御性拒绝（静默）；进度违约（新 index 但 revision 不前进 / index 跳号 /
//     end 计数不符）onError 上报后拒绝。
//   - attemptId 是同 attempt 的身份键：chunk/end 按它路由；未知 end 直接拒绝
//     （非流式 turn 用显式 endTurn() 收尾，不猜归属）。
//
// 输出协议：
//   mode 'text'：正文只经 sendTextDelta 投递（delta=未发送尾部，拼接唯一）；
//   mode 'card'：正文只经 updateCardText 投递累计全文快照（严格递增、逐一 await）。
//   实时（throttle/turn）flush 在 final/end 之前即多次发出；finishCard 是纯收卡信号
//   （不携带正文），每张已开的卡至多收尾一次（abort/dispose/end/endTurn 全部幂等）。
//   setFinalMessage(text, identity{turn, step})：最终 message 通道——text 模式只补
//   未投递尾部（非流式即全文一次），card 模式发布最终快照；归属按 identity 查已有
//   attempt（开着的归原 attempt、已结算的走去重、完全没有才开新的非流式 turn）；
//   无 identity 的 final 只归 current，current 已结束则直接去重跳过（不开新回合，
//   需要新回合必须传 identity）。非流式 turn 用 setFinalMessage + endTurn()。
//   endTurn(identity?)：不传 → 收 current 所在 turn 的全部未结束 attempt；
//   传 {turn, step?} → 只收对应 turn/step，绝不影响下一 turn。
//
// 投递错误契约（sendTextDelta/updateCardText/finishCard 的 reject 或结构化 {ok:false}）：
//   - deliveryUnknown:true（对端可能已收）→ 标记后禁止一切正文重发（含 final/end/flush），
//     只允许收卡；绝不盲重试。
//   - 确定失败 → outputFailed 停自动节流；同一 attempt 连续失败达
//     MAX_BODY_SEND_FAILURES 后显式补试也停止（有限上限）；成功即清零。
//   - finishCard 失败只报错不重试（cardFinished 先置位）。
//   - sent/published 仅在成功 resolve 后推进。
//
// 生命周期 / 内存：
//   - finalText 是收尾目标、与投递进度(sent/published)分离：final 失败后 end/endTurn
//     仍按最终目标只补缺尾（不丢尾巴）。
//   - attempt settled（收卡任务执行）时释放全文（text/finalText/published），仅留
//     身份墓碑（attemptId/turn/step/revision/ended/settled...）挡重复 final/重复 end；
//     墓碑容量 MAX_TRACKED_ATTEMPTS，超限淘汰最老的已结算项。历史去重不只靠墓碑：
//     final 归属按「现有未结算身份 → 已结算墓碑 → turn/step 水位线 → 全新非流式 turn」
//     顺序解析——在途旧 attempt 的合法 final 先被身份接住（绝不因水位线吞尾），被淘汰
//     后靠 settledTurnWatermark（turn 单调递增）与 settledSteps（同 turn 已结算 step 上界）
//     拒绝复活；同 turn 尚未出现的新 step（严格大于已结算上界）不被误拒。
//
// API 身份契约：identity{turn, step, attemptId} 按宿主 turn/step **单调递增** 假设工作，
//   active（未 settled）归属可接住迟到 final 补尾；不声称支持任意乱序历史输入——
//   乱序超出上述单调/水位线语义的历史 final 一律拒绝而非复活。墓碑只淘汰已 settled
//   项（ended 未 settled / 在途请求绝不淘汰）；timer 单实例：只在无 dirty 时清除、
//   脏且未挂才新挂，绝不 clear+restart 已挂 deadline（范围操作无匹配时完全 no-op）。
//   - abort 在 settled 前始终可取消尚未执行的正文（即使 end 帧已到、ended 已置位）；
//     在途请求允许完成。abort/dispose 清 timer 后按剩余 dirty 重新调度，不误伤
//     其他 attempt 的节流（旧 end 也不得清掉新 attempt 的 timer）。
//   - 代理对：实时输出缓冲尾部未配对高代理（跨批次合法 pair 缓冲）；任何路径若内容
//     仍含孤立代理项（畸形）：只投最长合法前缀，其余扣留、明确 onError 并置
//     outputBlocked 安全中止（后续正文不再投递），随后正常收卡——绝不把坏文本交
//     给拆分器，也不宣称“照投保证不丢”。
//
// 身份隔离：实例绑定 (agentId, sessionId) 仅作回调身份戳；createLarkStreamHub 外层按
//   Agent 对象身份（WeakMap）分桶、按 sessionId 分流——同 id 不同 Agent 对象绝不共享状态。

const DEFAULT_THROTTLE_MS = 200
// 同一 attempt 连续正文投递失败上限（成功即清零）：显式补试有限、不无限重发。
const MAX_BODY_SEND_FAILURES = 2
// 已结算 attempt 墓碑容量：保留身份去重，超限淘汰最老已结算项。
const MAX_TRACKED_ATTEMPTS = 32

const noop = () => {}

const defaultScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

const isHighSurrogate = (cu) => cu >= 0xd800 && cu <= 0xdbff
const isLowSurrogate = (cu) => cu >= 0xdc00 && cu <= 0xdfff

// 返回从开头起的最长合法 UTF-16 前缀（遇到孤立代理项即截断）。
function wellFormedPrefix(str) {
  for (let i = 0; i < str.length; i++) {
    const cu = str.charCodeAt(i)
    if (isHighSurrogate(cu)) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN
      if (!isLowSurrogate(next)) return str.slice(0, i)
      i++ // 跳过已配对的低位
    } else if (isLowSurrogate(cu)) {
      return str.slice(0, i)
    }
  }
  return str
}

// 实时输出缓冲：尾部未配对高代理暂缓一个码元，等下一 chunk 补齐低代理再发。
function holdIncompleteTail(str) {
  if (str.length > 0 && isHighSurrogate(str.charCodeAt(str.length - 1))) return str.slice(0, -1)
  return str
}

// ---- 严格帧 shape 校验（P2：safe integer / 类型 / outcome 结构）----
const isNat = (v) => Number.isSafeInteger(v) && v >= 0
const isId = (v) => (typeof v === 'string' && v.length > 0) || Number.isSafeInteger(v)
const INDEXED_CHUNK_TYPES = new Set(['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'])
const CHUNK_TYPES = new Set([...INDEXED_CHUNK_TYPES, 'usage', 'finish'])
const SETTLEMENT_EVENT_TYPES = new Set(['assistant/message', 'assistant/attempt'])

function validStartFrame(f) {
  return !!f && f.type === 'start' && isId(f.attemptId) && isNat(f.revision) && isNat(f.turn) && isNat(f.step)
}

function validChunkFrame(f) {
  if (!f || f.type !== 'chunk' || !isId(f.attemptId) || !isNat(f.revision) || !isNat(f.index) || !isNat(f.time) || !f.chunk) {
    return false
  }
  const c = f.chunk
  if (!CHUNK_TYPES.has(c.type)) return false
  if (INDEXED_CHUNK_TYPES.has(c.type) && !isNat(c.index)) return false
  if (c.type === 'text-delta' || c.type === 'reasoning-delta') return typeof c.text === 'string'
  if (c.type === 'tool-call-delta') return typeof c.id === 'string' && typeof c.argumentsDelta === 'string'
  if (c.type === 'block-start') return typeof c.blockType === 'string'
  if (c.type === 'block-end') return !!c.block && typeof c.block === 'object'
  if (c.type === 'usage') return !!c.usage && typeof c.usage === 'object'
  if (c.type === 'finish') return validFinishReason(c.reason) && (c.replayState == null || typeof c.replayState === 'object')
  return false
}

function validFinishReason(reason) {
  if (!reason || typeof reason !== 'object' || typeof reason.kind !== 'string' || reason.kind === '') return false
  // FinishReasonMap：error/aborted 带 LlmFailure{message, code}；其余 kind 合并可扩展
  if (reason.kind === 'error' || reason.kind === 'aborted') {
    const f = reason.failure
    if (!f || typeof f !== 'object' || typeof f.message !== 'string' || typeof f.code !== 'string') return false
  }
  return true
}

function validEndFrame(f) {
  if (!f || f.type !== 'end' || !isId(f.attemptId) || !isNat(f.revision) || !isNat(f.index) || !f.outcome) return false
  const o = f.outcome
  if (o.kind === 'abandoned') return true
  return o.kind === 'committed' && SETTLEMENT_EVENT_TYPES.has(o.eventType) && isNat(o.seq)
}

function makeAttempt(fields = {}) {
  return {
    key: null,
    attemptId: null,
    turn: null,
    step: null,
    revision: -1, // 本 attempt 已接受的最新帧 revision
    lastIndex: -1, // 本 attempt 已接受的最新外层 index（dense）
    streaming: false, // 由 start 帧创建
    virtual: false, // 由最终 message / 非流式 turn 创建
    text: '', // 累计正文（settled 后释放）
    sent: 0, // text 模式已投递字符数
    published: '', // card 模式最近一次成功快照（settled 后释放）
    finalText: null, // 最终 message 收尾目标（与投递进度分离；settled 后释放）
    outputFailed: false, // 上次正文回调确定失败 → 停自动节流
    outputBlocked: false, // 畸形正文已扣留 → 该 attempt 后续正文不再投递（安全中止）
    deliveryUnknown: false, // 未知投递 → 禁止一切正文重发
    explicitRetries: 0, // 连续失败计数（成功清零；达上限显式补试也停止）
    cancelled: false, // abort/dispose：取消未执行的正文任务
    abandoned: false, // end(outcome abandoned)：丢弃未发送前缀
    ended: false, // 已收到 end/endTurn（停止接受帧）
    settled: false, // 收卡任务已执行（执行期判定）
    superseded: false, // 被新 start 取代（其 end 仍可收自己的卡）
    opened: false, // 至少一个正文回调已发起 → 卡已存在
    cardFinished: false, // finishCard 已发起（幂等）
    surrogateWarned: false, // 孤立代理项错误每 attempt 只报一次
    ...fields,
  }
}

/**
 * 创建绑定 (agentId, sessionId) 的实时流状态机。
 *
 * @param {object} options
 * @param {string|number} [options.agentId] 身份戳（元数据）
 * @param {string|number} [options.sessionId] 身份戳（元数据）
 * @param {'text'|'card'} [options.mode] 输出模式，默认 'text'
 * @param {(payload: object) => any} options.sendTextDelta 正文增量回调（必填）
 * @param {(payload: object) => any} options.updateCardText 累计快照回调（必填）
 * @param {(payload: object) => any} options.finishCard 收卡信号回调（必填，不携带正文）
 * @param {number} [options.throttleMs] 节流窗口，默认 200
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.scheduler]
 * @param {(err: unknown, info: object) => void} [options.onError]
 * @param {(kind: string, detail: object) => void} [options.telemetry] 匿名诊断钩子（可选）：
 *   frame_accepted {kind:'start'|'chunk'|'end', textDelta?, turn, step} /
 *   frame_rejected {category:'shape'|'stale'|'duplicateIndex'|'duplicateRevision'|'regressedRevision'|'denseIndexGap', turn?, step?}
 *   —— 可归属的拒绝携带 attempt 的 turn/step；未知 attempt/形状无法归属则省略（只计总数）。
 *   纯观察，不改变引擎行为；抛错一律吞掉。
 */
export function createLarkStream(options = {}) {
  const {
    agentId = 'default',
    sessionId = 'default',
    mode = 'text',
    sendTextDelta,
    updateCardText,
    finishCard,
    throttleMs = DEFAULT_THROTTLE_MS,
    scheduler = defaultScheduler,
    onError = noop,
    telemetry = null,
  } = options

  if (typeof sendTextDelta !== 'function') throw new TypeError('lark-stream: sendTextDelta must be a function')
  if (typeof updateCardText !== 'function') throw new TypeError('lark-stream: updateCardText must be a function')
  if (typeof finishCard !== 'function') throw new TypeError('lark-stream: finishCard must be a function')
  if (mode !== 'text' && mode !== 'card') throw new TypeError("lark-stream: mode must be 'text' or 'card'")
  if (!scheduler || typeof scheduler.setTimeout !== 'function' || typeof scheduler.clearTimeout !== 'function') {
    throw new TypeError('lark-stream: scheduler must provide setTimeout and clearTimeout')
  }

  let disposed = false
  let attemptSeq = 0
  let agentRevision = 0 // Agent lifecycle 级 revision 进度：每帧必须严格大于
  // 已结算 turn 水位线（turn 单调递增）：被淘汰墓碑的历史 final 不得复活。
  let settledTurnWatermark = -1
  // 同 turn 已结算 step 上界（有界：仅保留 turn >= 水位线的记录，更老 turn 已被水位线拒绝）：
  // 墓碑被淘汰后，旧 step 的重放仍被拒，而严格大于上界的新 step 放行。
  const settledSteps = new Map() // turn → maxSettledStep
  const attempts = new Map() // key(String) → attempt（已结算的留作身份墓碑）
  let current = null
  let timer = null
  // 串行链：所有回调按入队顺序逐个 await，同一时刻至多一个在飞。
  let queue = Promise.resolve()

  function payload(a, extra) {
    return {
      agentId,
      sessionId,
      attemptId: a.attemptId,
      revision: a.revision,
      turn: a.turn,
      step: a.step,
      ...extra,
    }
  }

  function reportError(err, info) {
    try {
      onError(err, { agentId, sessionId, ...info })
    } catch {}
  }

  // 诊断遥测：纯观察，不参与投递/去重/重试语义；抛错一律吞掉。
  function note(kind, detail) {
    if (typeof telemetry !== 'function') return
    try { telemetry(kind, detail) } catch {}
  }

  // final=true 的任务是收卡终局任务，不被 disposed 闸门吞掉。
  // meta（可选）：{turn, step, kind:'output'|'final'|'finish'} —— 匿名诊断生命周期
  // 遥测：入队即本地 pending（**不是 HTTP attempted**）；**每条入队路径恰好一次
  // task_settled**（本地闭包标志，不依赖消费侧计数钳位）；跳过带固定 skipped 标志。
  // 纯观察，不改变队列语义；抛错一律吞掉。
  function enqueue(task, final = false, meta = null) {
    if (meta) note('task_enqueued', meta)
    let settledOnce = false
    const settle = (extra) => {
      if (settledOnce) return
      settledOnce = true
      if (meta) note('task_settled', Object.assign({}, meta, extra))
    }
    queue = queue
      .then(() => {
        if (disposed && !final) {
          settle({ skipped: true })
          return undefined
        }
        return task()
      })
      .then(
        (result) => { settle({ ok: true }); return result },
        (err) => { settle({ ok: false }); reportError(err) },
      )
    return queue
  }

  // 收卡终局入队的唯一入口：置 finishQueued，供 dispose 判断该 attempt 是否
  // 已有配对的 attempt_finished（避免双重结算/漏配对）。
  function enqueueFinish(a, info, meta) {
    a.finishQueued = true
    return enqueue(() => finishTask(a, info)(), true, meta)
  }

  // 回调投递：reject 或结构化 {ok:false} 都按失败处理（deliveryUnknown 透传）。
  function deliver(call) {
    return Promise.resolve()
      .then(call)
      .then((result) => {
        if (result && typeof result === 'object' && result.ok === false) {
          const err = new Error(result.error != null ? String(result.error) : 'lark-stream: delivery reported ok:false')
          if (result.deliveryUnknown === true) err.deliveryUnknown = true
          throw err
        }
        return result
      })
  }

  // 正文投递失败记账：未知投递 → 永久禁止重发；确定失败 → 连续失败计数（有界补试）。
  function noteBodyFailure(a, err) {
    a.outputFailed = true
    if (err && err.deliveryUnknown === true) {
      a.deliveryUnknown = true
      return
    }
    a.explicitRetries += 1
  }

  // 发送门禁：未知投递/畸形扣留禁止；确定失败后 auto 一律停、显式补试受有限上限约束。
  function sendAllowed(a, auto) {
    if (a.cancelled || a.abandoned || a.settled || a.deliveryUnknown || a.outputBlocked) return false
    if (!a.outputFailed) return true
    if (auto) return false
    return a.explicitRetries < MAX_BODY_SEND_FAILURES
  }

  function clearTimer() {
    if (timer !== null) {
      scheduler.clearTimeout(timer)
      timer = null
    }
  }

  // 收尾目标：finalText（最终 message）优先，否则累计正文。与 sent/published 分离，
  // 保证 final 失败后 end/endTurn 仍按目标只补缺尾。
  function targetOf(a) {
    return a.finalText != null ? a.finalText : a.text
  }

  // 是否还有未投递正文（不考虑失败状态——符合门禁的显式 flush 可补试）。
  function pending(a) {
    if (a.cancelled || a.abandoned || a.deliveryUnknown || a.outputBlocked) return false
    if (mode === 'text') return targetOf(a).length > a.sent
    const target = targetOf(a)
    return target.length > 0 && target !== a.published
  }

  function dirty(a) {
    // ended 的 attempt 不再驱动节流 timer：其收尾 flush 已在 end/endTurn 内入队，
    // 这样旧 end 的 reschedule 只会为其他仍活跃的 dirty attempt 重新计时。
    return !a.ended && !a.outputFailed && pending(a)
  }

  function anyDirty() {
    for (const a of attempts.values()) if (dirty(a)) return true
    return false
  }

  function schedule() {
    if (timer !== null || disposed) return
    if (!anyDirty()) return
    timer = scheduler.setTimeout(() => {
      timer = null
      for (const a of [...attempts.values()]) flushAttempt(a, 'throttle', true)
    }, throttleMs)
  }

  // 清 timer 后按剩余 dirty 重新调度：不误伤其他 attempt 的节流窗口。
  // timer 语义：单实例单 timer。只在“无 dirty”时清除；脏且未挂时才新挂——
  // 绝不 clear+restart 已挂 timer（否则既有 deadline 被逐次后移、可被无限推迟）。
  function ensureTimer() {
    if (disposed) return
    if (anyDirty()) {
      if (timer == null) schedule()
    } else {
      clearTimer()
    }
  }

  // 畸形正文扣留：只返回最长合法前缀；发现孤立代理项 → 明确报错（每 attempt 一次）
  // 并置 outputBlocked 安全中止——坏文本绝不交给拆分器。
  function sanitizeForDelivery(a, str) {
    const safe = wellFormedPrefix(str)
    if (safe === str) return str
    if (!a.surrogateWarned) {
      a.surrogateWarned = true
      reportError(
        new Error('lark-stream: lone UTF-16 surrogate in output — malformed remainder withheld (not delivered), caller must sanitize source'),
        { attemptId: a.attemptId },
      )
    }
    a.outputBlocked = true
    return safe
  }

  // 单次正文投递任务：目标/尾部在执行时计算（串行执行保证拼接唯一）；
  // 成功才推进 sent/published 并清失败计数，失败记账后上抛给 enqueue.catch → onError。
  // throttle/turn 是实时输出：尾部高代理缓冲；end/final 全量结算，不缓冲。
  function outputTask(a, reason, auto = false) {
    if (!sendAllowed(a, auto)) return undefined
    const live = reason === 'throttle' || reason === 'turn'
    if (mode === 'text') {
      const target = targetOf(a)
      const raw = target.slice(a.sent)
      const held = live ? holdIncompleteTail(raw) : raw
      if (!held) return undefined // 仅剩待补齐的高代理 → 缓冲，不发不完整字符
      const tail = sanitizeForDelivery(a, held) // 畸形则只留合法前缀并安全中止
      if (!tail) return undefined
      a.opened = true // 卡已创建（回调即将发起）
      const p = payload(a, { delta: tail, text: target, reason })
      return deliver(() => sendTextDelta(p))
        .then(() => {
          a.sent += tail.length // 只按实际投递推进（实时可能缓冲尾部高代理）
          if (a.sent === target.length && target !== a.text) a.text = target // 全量到达才对齐权威正文
          a.outputFailed = false
          a.explicitRetries = 0
        })
        .catch((err) => {
          noteBodyFailure(a, err)
          throw err
        })
    }
    const target = targetOf(a)
    const heldSnap = live ? holdIncompleteTail(target) : target
    if (!heldSnap) return undefined
    const snapshot = sanitizeForDelivery(a, heldSnap) // 畸形则只留合法前缀并安全中止
    if (!snapshot || snapshot === a.published) return undefined
    a.opened = true
    const p = payload(a, { text: snapshot, reason, source: reason === 'throttle' ? 'live' : reason })
    return deliver(() => updateCardText(p))
      .then(() => {
        a.published = snapshot
        if (!live && target !== a.text) a.text = target
        a.outputFailed = false
        a.explicitRetries = 0
      })
      .catch((err) => {
        noteBodyFailure(a, err)
        throw err
      })
  }

  // 投递 a 的未发内容。auto=true 表示节流驱动（执行期也受 outputFailed 门禁）。
  // ended 的 attempt 只允许 handleEnd/endTurn 在置位前的那次显式 flush。
  function flushAttempt(a, reason, auto = false) {
    if (disposed || a.ended || !pending(a)) return queue
    if (auto && a.outputFailed) return queue
    return enqueue(() => outputTask(a, reason, auto), false, { turn: a.turn, step: a.step, kind: 'output' })
  }

  // settled 墓碑：释放全文只留身份/状态（防长寿命 Agent 线性积累，同时挡重复 final/end）。
  function releaseBody(a) {
    a.text = ''
    a.finalText = null
    a.published = ''
    a.sent = 0
  }

  function register(a) {
    while (attempts.size >= MAX_TRACKED_ATTEMPTS) {
      let evicted = false
      for (const [k, old] of attempts) {
        // 只淘汰已 settled 的墓碑：ended 但未 settled（首请求挂住/终局任务排队中）
        // 的 attempt 绝不淘汰——否则迟到重复 final 会绕过水位线新建 virtual 重发；
        // 容量限制仅适用于已完成历史，settlement 释放全文后由后续 register 压缩。
        if (old.settled && old !== current) {
          attempts.delete(k)
          evicted = true
          break
        }
      }
      if (!evicted) break // 存在未 settled（含在途）则暂超容量，不淘汰
    }
    const key = a.attemptId != null ? String(a.attemptId) : `virtual#${++attemptSeq}`
    attempts.set(key, a)
    a.key = key
    return a
  }

  // settlement 压缩：结算释放全文后，把已 settled 墓碑裁回容量上限（在途/未 settled 不动）。
  function compressTombs() {
    while (attempts.size > MAX_TRACKED_ATTEMPTS) {
      let evicted = false
      for (const [k, old] of attempts) {
        if (old.settled && old !== current) {
          attempts.delete(k)
          evicted = true
          break
        }
      }
      if (!evicted) break
    }
  }

  function supersede(a) {
    if (a.ended || a.superseded) return
    a.superseded = true
    flushAttempt(a, 'superseded') // 旧 attempt 剩余正文先补发（其 end 仍收自己的卡）
  }

  function finishTask(a, info) {
    return () => {
      if (a.cardFinished) return undefined // 幂等：abort/dispose/end/endTurn 各路径只收一次
      a.cardFinished = true // 先置位再 await，回调失败也不再重试
      a.settled = true // 执行期结算：晚于本任务入队的 final/body 任务会被跳过
      // 尝试终局遥测：在 releaseBody 前按**真实投递进度**判定完整交付与否；
      // 失败/未知如实透出，供 diagnostics 决定 completed vs failed/unknown_delivery。
      // delivery 视图：匿名长度/布尔/枚举，无正文、无哈希、无身份。
      {
        const target = targetOf(a)
        const complete = !a.outputFailed && !a.deliveryUnknown && !a.cancelled && !a.abandoned && !a.outputBlocked
          && (mode === 'text'
            ? a.sent >= target.length
            : (target.length === 0 || a.published === target))
        note('attempt_finished', {
          turn: a.turn,
          step: a.step,
          delivered: complete,
          failed: Boolean(a.outputFailed),
          unknown: Boolean(a.deliveryUnknown),
          // 被取代（supersede）的 attempt：有效替代者才是该 step 的权威交付结论；
          // 已提交普通 end/abort/dispose 的结算为权威（按真实投递状态）。
          authoritative: info.reason !== 'supersede',
          targetSource: a.finalText != null ? 'final' : 'delta',
          targetLength: target.length,
          publishedLength: mode === 'text' ? a.sent : a.published.length,
          sentLength: a.sent,
          exactTargetMatch: mode === 'text' ? a.sent >= target.length : (target.length === 0 || a.published === target),
          cancelled: Boolean(a.cancelled),
          outputBlocked: Boolean(a.outputBlocked),
          endReason: info.reason ?? null,
        })
      }
      if (a.turn != null && a.turn > settledTurnWatermark) settledTurnWatermark = a.turn // 结算 turn 水位线
      if (a.turn != null && a.step != null) {
        const rec = settledSteps.get(a.turn)
        if (rec == null || a.step > rec) settledSteps.set(a.turn, a.step) // 已结算 step 上界
      }
      for (const t of settledSteps.keys()) if (t < settledTurnWatermark) settledSteps.delete(t) // 有界
      releaseBody(a) // 释放全文，仅留身份墓碑
      compressTombs() // settlement 后压缩：只裁已 settled 墓碑
      if (!a.opened) return undefined // 从未发起正文回调 → 没有卡可收
      return deliver(() =>
        finishCard(
          payload(a, {
            outcome: info.outcome ?? null,
            aborted: a.cancelled,
            reason: info.reason ?? 'end',
          }),
        ),
      ) // 拒绝 / {ok:false} → enqueue.catch → onError，不重试
    }
  }

  /** 输入 start 帧（严格 shape）：全局 revision 单调 + attemptId 开新 attempt。 */
  function handleStart(frame) {
    if (disposed) return queue
    if (!validStartFrame(frame)) { // 非法 shape 防御性拒绝
      note('frame_rejected', { category: 'shape' })
      return queue
    }
    if (frame.revision <= agentRevision) { // 等值/回退：重复或过期 start
      note('frame_rejected', { category: frame.revision === agentRevision ? 'duplicateRevision' : 'regressedRevision' })
      return queue
    }
    agentRevision = frame.revision
    const key = String(frame.attemptId)
    const existing = attempts.get(key)
    if (existing) {
      // 同 attemptId 重启（新 generation）：旧卡无人再收 → 立即收掉，不留悬挂。
      supersede(existing)
      existing.ended = true
      if (existing.opened && !existing.cardFinished) {
        enqueueFinish(existing, { outcome: null, reason: 'supersede' }, { turn: existing.turn, step: existing.step, kind: 'finish' })
      } else if (!existing.opened && !existing.finishQueued && !existing.cardFinished) {
        // 从未发起正文回调就被取代：配对 attempt_opened，但不作为权威交付结论
        //（存活的新 attempt 才是该 turn 的最终事实）。
        note('attempt_finished', { turn: existing.turn, step: existing.step, delivered: false, failed: false, unknown: false, authoritative: false })
      }
      attempts.delete(key)
    }
    if (current && current !== existing && !current.ended && !current.superseded) supersede(current)
    const a = register(
      makeAttempt({
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        revision: frame.revision,
        streaming: true,
      }),
    )
    current = a
    note('frame_accepted', { kind: 'start', turn: frame.turn, step: frame.step })
    note('attempt_opened', { turn: frame.turn, step: frame.step })
    ensureTimer() // 不误伤被取代 attempt 的既有 deadline
    return queue
  }

  /**
   * 输入 chunk 帧（严格 shape + 全局 revision 单调 + attempt 内 dense 连续 index）。
   * 拒绝规则：index <= lastIndex → 重复帧（静默幂等）；index 跳号 → 丢帧，
   * onError 上报后拒绝；新 index 但 revision 不前进 → 协议违约，onError 后拒绝。
   */
  function handleChunk(frame) {
    if (disposed) return queue
    if (!validChunkFrame(frame)) {
      note('frame_rejected', { category: 'shape' }) // 形状非法：不可归属，只计总数
      return queue
    }
    const a = attempts.get(String(frame.attemptId))
    if (!a || a.ended || a.cancelled || a.abandoned) {
      // 未知 attempt 无法归属（不猜最近回合）；已知但已结算/取消的可归属。
      note('frame_rejected', a
        ? { category: 'stale', turn: a.turn, step: a.step }
        : { category: 'stale' })
      return queue
    }
    if (frame.index <= a.lastIndex) { // 重复/过期 index 帧：幂等静默（与 revision 独立）
      note('frame_rejected', { category: 'duplicateIndex', turn: a.turn, step: a.step })
      return queue
    }
    if (frame.revision <= agentRevision) {
      note('frame_rejected', {
        category: frame.revision === agentRevision ? 'duplicateRevision' : 'regressedRevision',
        turn: a.turn,
        step: a.step,
      })
      reportError(new Error('lark-stream: chunk revision not advancing (frame rejected, content lost)'), {
        attemptId: a.attemptId,
        revision: frame.revision,
        index: frame.index,
      })
      return queue
    }
    if (frame.index !== a.lastIndex + 1) {
      note('frame_rejected', { category: 'denseIndexGap', turn: a.turn, step: a.step })
      reportError(new Error('lark-stream: dense index gap (frame rejected, content may be lost)'), {
        attemptId: a.attemptId,
        revision: frame.revision,
        index: frame.index,
        expectedIndex: a.lastIndex + 1,
      })
      return queue
    }
    agentRevision = frame.revision
    a.revision = frame.revision
    a.lastIndex = frame.index
    if (frame.chunk.type === 'text-delta' && frame.chunk.text !== '') {
      a.text += frame.chunk.text
    }
    note('frame_accepted', { kind: 'chunk', textDelta: frame.chunk.type === 'text-delta', turn: a.turn, step: a.step })
    // reasoning / tool-call / block-* / usage / finish 只推进 revision/index 进度。
    schedule()
    return queue
  }

  /**
   * 输入 end 帧（严格 shape）：只按 attemptId 精确归属（不猜未知 end），
   * 计数必须等于 chunk 总数、revision 必须前进；补发未投递内容 → 幂等收卡；
   * abandoned 丢弃未发送前缀。
   */
  function handleEnd(frame) {
    if (disposed) return queue
    if (!validEndFrame(frame)) {
      note('frame_rejected', { category: 'shape' }) // 形状非法：不可归属，只计总数
      return queue
    }
    const a = attempts.get(String(frame.attemptId))
    if (!a || a.ended) { // 未知 end 拒绝（非流式用 endTurn）/ 重复 end 幂等
      note('frame_rejected', a
        ? { category: 'stale', turn: a.turn, step: a.step }
        : { category: 'stale' })
      return queue
    }
    if (frame.revision <= agentRevision) {
      note('frame_rejected', {
        category: frame.revision === agentRevision ? 'duplicateRevision' : 'regressedRevision',
        turn: a.turn,
        step: a.step,
      })
      reportError(new Error('lark-stream: end revision not advancing (frame rejected)'), { attemptId: a.attemptId })
      return queue
    }
    if (frame.index !== a.lastIndex + 1) {
      note('frame_rejected', { category: 'denseIndexGap', turn: a.turn, step: a.step })
      reportError(new Error('lark-stream: end index != chunk total (frame rejected)'), {
        attemptId: a.attemptId,
        index: frame.index,
        expectedIndex: a.lastIndex + 1,
      })
      return queue
    }
    agentRevision = frame.revision
    a.revision = frame.revision
    a.lastIndex = frame.index
    // end 帧结果种类（匿名枚举）：committed|abandoned + settlement eventType 白名单。
    const endKind = frame.outcome && frame.outcome.kind === 'abandoned' ? 'abandoned'
      : frame.outcome && frame.outcome.kind === 'committed' ? 'committed' : null
    const settlement = frame.outcome && frame.outcome.eventType === 'assistant/message' ? 'assistant_message'
      : frame.outcome && frame.outcome.eventType === 'assistant/attempt' ? 'assistant_attempt' : null
    note('frame_accepted', { kind: 'end', turn: a.turn, step: a.step, endKind, settlement })
    const kind = frame.outcome.kind
    if (kind === 'abandoned') {
      a.abandoned = true // 无持久提交：丢弃未发送前缀，不再普通新增输出
    } else {
      flushAttempt(a, 'end') // 已提交：按最终目标补发（串行先于收卡任务）
    }
    a.ended = true
    ensureTimer() // 其他 attempt 若仍待节流，不能因旧 end 断粮（且保持其已定 deadline）
    // 收尾入队统一走 enqueueFinish（带 finish 元数据与 finishQueued）：
    // pendingTasks 必须覆盖到 finishCard/close 回调真正 resolve，否则终局在 close
    // 派发前提前结算（实机同形竞态）。
    return enqueueFinish(a, { outcome: frame.outcome, reason: kind === 'abandoned' ? 'abandoned' : 'end' }, { turn: a.turn, step: a.step, kind: 'finish' })
  }

  /**
   * 最终 message（先于 end 到达时天然串行在 end 之前）。
   * 调用时按 identity{turn, step} 归属（不受其后同步到达的 start 影响）：
   *   开着的匹配 attempt → 归它（迟到 final 回原 attempt，不换 current）；
   *   已结算的匹配 attempt → 去重通道（settled 任务直接跳过，不重发）；
   *   完全没有匹配 → 才开新的非流式 turn（current 仅在其为 null/ended 时才切换）。
   * 无 identity：只归 current；current 已结束 → 直接去重跳过（新回合必须传 identity）。
   */
  function setFinalMessage(text, info = {}) {
    if (disposed || typeof text !== 'string' || text === '') return queue
    const turn = info.turn ?? null
    const step = info.step ?? null
    const identityGiven = turn != null || step != null
    let a = null
    if (identityGiven) {
      const same = (x) => (turn == null || x.turn === turn) && (step == null || x.step === step)
      // 1) 现有未结算身份优先（含仍开着的旧 attempt）：绝不因水位线吞掉在途 final 的补尾
      let active = null
      if (current && !current.settled && same(current)) active = current
      if (!active) {
        for (const cand of attempts.values()) {
          if (!cand.settled && same(cand)) {
            active = cand
            break
          }
        }
      }
      if (active) {
        a = active
      } else {
        // 2) 已结算身份（墓碑仍在）→ 去重通道（settled 任务内部跳过）
        let tomb = null
        for (const cand of attempts.values()) {
          if (cand.ended && same(cand)) tomb = cand // 取插入序最后（最近结算）
        }
        if (tomb) {
          a = tomb
        } else {
          // 3) 历史身份：墓碑被淘汰后仍由 turn/step 水位线拒复活；同 turn 新 step 放行
          if (turn != null && turn <= settledTurnWatermark) {
            if (turn < settledTurnWatermark) return queue // 更老的 turn
            if (step == null) return queue // 已关闭 turn 的无 step final = 重放
            const rec = settledSteps.get(turn)
            if (rec != null && step <= rec) return queue // 已结算 step（含被淘汰墓碑）不复活
          }
          // 4) 全新非流式 turn
          a = register(makeAttempt({ virtual: true, turn, step }))
          note('attempt_opened', { turn, step })
          if (!current || current.ended) current = a
        }
      }
    } else {
      if (current && !current.ended) a = current
      else return queue // current 已结束/无 current：无 identity 不开新回合（去重优先）
    }
    return enqueue(() => {
      // settled/cancelled/abandoned：执行期判定，晚于收卡的 final 不再补发。
      if (a.cancelled || a.abandoned || a.settled) return undefined
      a.finalText = text // 收尾目标（与投递进度分离）
      if (mode === 'text') {
        const delivered = a.text.slice(0, a.sent)
        if (a.sent > 0 && !text.startsWith(delivered)) {
          a.finalText = null // 分歧：作废目标，end 只按已累计正文收尾
          reportError(new Error('lark-stream: final text diverges from delivered prefix'), { attemptId: a.attemptId })
          return undefined
        }
        const rawTail = text.slice(a.sent)
        if (!rawTail) return undefined // 已全部投递 → 最终 message 去重
        if (!sendAllowed(a, false)) return undefined // 未知投递/失败上限：不盲重发
        const tail = sanitizeForDelivery(a, rawTail) // 最终仍畸形：报错扣留、安全中止
        if (!tail) return undefined
        a.opened = true
        const p = payload(a, { delta: tail, text, reason: 'final' })
        return deliver(() => sendTextDelta(p))
          .then(() => {
            a.sent += tail.length // 只按实际投递（合法前缀）推进
            if (a.sent >= text.length && a.text !== text) a.text = text
            a.outputFailed = false
            a.explicitRetries = 0
          })
          .catch((err) => {
            noteBodyFailure(a, err)
            throw err
          })
      }
      if (text === a.published) return undefined // card 模式最终快照去重
      if (!sendAllowed(a, false)) return undefined
      const finalSnap = sanitizeForDelivery(a, text) // 最终仍畸形：报错扣留、安全中止
      if (!finalSnap || finalSnap === a.published) return undefined
      a.opened = true
      const p = payload(a, { text: finalSnap, reason: 'final', source: 'final' })
      return deliver(() => updateCardText(p))
        .then(() => {
          a.published = finalSnap // 只按合法投递推进
          if (finalSnap === text && a.text !== text) a.text = text
          a.outputFailed = false
          a.explicitRetries = 0
        })
        .catch((err) => {
          noteBodyFailure(a, err)
          throw err
        })
    }, false, { turn: a.turn, step: a.step, kind: 'final' })
  }

  /**
   * 非流式 turn 收尾（显式 API，不喂残缺实时帧）：
   *   不传 identity → 收 current 所在 turn 的全部未结束 attempt（同 turn 多 step 全收）；
   *   传 {turn, step?} → 只收对应 turn/step，绝不影响下一 turn。
   * 全部先按最终目标补发，再逐一幂等收卡。
   */
  function endTurn(info = {}) {
    if (disposed) return queue
    let scope
    if (info.turn != null || info.step != null) {
      scope = [...attempts.values()].filter(
        (a) =>
          !a.ended &&
          (info.turn == null || a.turn === info.turn) &&
          (info.step == null || a.step === info.step),
      )
    } else if (current) {
      const anchor = current.turn
      scope = [...attempts.values()].filter((a) => !a.ended && a.turn === anchor)
    } else {
      return queue
    }
    if (scope.length === 0) return queue // 无匹配：完全 no-op（不动其他 turn 的 deadline）
    const outcome = info.outcome ?? null
    const abandoned = !!(outcome && outcome.kind === 'abandoned')
    const reason = abandoned ? 'abandoned' : 'end'
    // abandoned 同步标废弃：已入队的 final/body 任务在执行期守卫处直接取消，
    // 不只是跳过新 flush（在途请求仍允许完成）。
    if (abandoned) for (const a of scope) a.abandoned = true
    if (!abandoned) for (const a of scope) flushAttempt(a, 'end')
    for (const a of scope) a.ended = true
    for (const a of scope) enqueueFinish(a, { outcome, reason }, { turn: a.turn, step: a.step, kind: 'finish' })
    ensureTimer()
    return queue
  }

  /**
   * turn 级 flush：立即入队未发内容（只冲刷、不收尾——turn 结束请用 endTurn）。
   * flushTurn() 全部 attempt；flushTurn({turn, step?, attemptId?}) 只冲刷所述身份，
   * 避免对全部 attempt 的过宽操作。
   */
  function flushTurn(identity) {
    if (disposed) return queue
    if (!hasIdentity(identity)) {
      clearTimer() // 无参全量 flush：整窗冲刷
      for (const a of [...attempts.values()]) flushAttempt(a, 'turn')
      return queue
    }
    const matched = [...attempts.values()].filter((a) => matchesIdentity(a, identity))
    if (matched.length === 0) return queue // 无匹配：完全 no-op（不清、不重排已有 deadline）
    for (const a of matched) flushAttempt(a, 'turn')
    ensureTimer() // 只补“未挂”的 timer，绝不动已挂 deadline
    return queue
  }

  // identity 过滤（turn/step/attemptId 任一给出即生效，字段间为与关系）。
  function matchesIdentity(a, id) {
    if (id.attemptId != null && (a.attemptId == null || String(a.attemptId) !== String(id.attemptId))) return false
    if (id.turn != null && a.turn !== id.turn) return false
    if (id.step != null && a.step !== id.step) return false
    return true
  }

  function hasIdentity(id) {
    return !!id && (id.turn != null || id.step != null || id.attemptId != null)
  }

  /**
   * 中止：
   *   abort({turn, step?, attemptId?}) —— 只取消所述身份的未 settled attempt（index
   *   应传实际 turn，避免迟到的旧 turn 中止误杀新 turn）；
   *   abort() —— 无参兼容：取 current 所在 turn 的 scope（含排队 virtual step）。
   * 取消尚未执行的正文（在途允许完成）、逐一幂等收卡；无匹配则完全 no-op
   * （不动其他 turn 的既有 deadline），只在无 dirty 时才清 timer。
   */
  function abort(identity) {
    let scope
    if (hasIdentity(identity)) {
      scope = [...attempts.values()].filter((a) => !a.settled && !a.cancelled && matchesIdentity(a, identity))
    } else if (current) {
      const anchorTurn = current.turn
      scope = [...attempts.values()].filter((a) => {
        if (a.settled || a.cancelled) return false
        if (a === current) return true
        return anchorTurn != null ? a.turn === anchorTurn : a.turn == null
      })
    } else {
      scope = []
    }
    if (scope.length === 0) return queue // 无匹配：完全 no-op（不动其他 turn 的 deadline）
    for (const a of scope) {
      a.cancelled = true // 执行期守卫：排队中的 final/body 全部取消
      enqueueFinish(a, { outcome: null, reason: 'abort' }, { turn: a.turn, step: a.step, kind: 'finish' })
    }
    ensureTimer()
    return queue
  }

  /** 永久停用：清 timer、取消所有未执行正文、已开的卡逐一幂等收尾并清空 attempt 表。 */
  function dispose() {
    clearTimer()
    disposed = true
    const finishers = []
    for (const a of attempts.values()) {
      a.cancelled = true
      if (a.opened && !a.cardFinished) finishers.push(a)
      else if (!a.cardFinished && !a.finishQueued) {
        // 未开正文且无排队收尾的 attempt：给一次**非权威**结束遥测配对
        // attempt_opened（纯观察，不增业务 send/finishCard，不作交付结论）。
        note('attempt_finished', { turn: a.turn, step: a.step, delivered: false, failed: false, unknown: false, authoritative: false, cancelled: true })
      }
    }
    attempts.clear() // finish 任务已捕获引用，不依赖表
    current = null
    for (const a of finishers) enqueueFinish(a, { outcome: null, reason: 'dispose' }, { turn: a.turn, step: a.step, kind: 'finish' })
    return queue
  }

  /** 等待串行链上的全部回调完成（不含未触发的节流 timer）。 */
  function idle() {
    return queue
  }

  function state() {
    const a = current
    return {
      agentId,
      sessionId,
      mode,
      disposed,
      timerPending: timer !== null,
      attempts: attempts.size,
      agentRevision,
      settledTurnWatermark,
      attemptId: a ? a.attemptId : null,
      turn: a ? a.turn : null,
      step: a ? a.step : null,
      text: a ? a.text : '',
      sent: a ? a.sent : 0,
      published: a ? a.published : '',
      finalText: a ? a.finalText : null,
      ended: a ? a.ended : false,
      settled: a ? a.settled : false,
      cancelled: a ? a.cancelled : false,
      opened: a ? a.opened : false,
      cardFinished: a ? a.cardFinished : false,
      outputFailed: a ? a.outputFailed : false,
      outputBlocked: a ? a.outputBlocked : false,
      deliveryUnknown: a ? a.deliveryUnknown : false,
    }
  }

  return {
    agentId,
    sessionId,
    mode,
    handleStart,
    handleChunk,
    handleEnd,
    setFinalMessage,
    endTurn,
    flushTurn,
    abort,
    dispose,
    idle,
    state,
  }
}

/**
 * 按 Agent 对象身份分桶（WeakMap）的流集合：同 sessionId、同 attemptId、revision 都从 1
 * 开始的两个不同 Agent 对象绝不共享状态；字符串 id 仅作回调元数据。
 * 同 (agent 对象, sessionId) 重复 get 返回同一实例。
 */
export function createLarkStreamHub(options = {}) {
  const { create = createLarkStream, ...defaults } = options
  const byAgent = new WeakMap() // Agent 对象 → Map(sessionKey → stream)
  let streamCount = 0

  function requireAgent(agent) {
    if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) {
      throw new TypeError('lark-stream hub: agent must be an object identity key')
    }
  }

  function sessionsOf(agent) {
    requireAgent(agent)
    let m = byAgent.get(agent)
    if (!m) {
      m = new Map()
      byAgent.set(agent, m)
    }
    return m
  }

  function get(agent, sessionId) {
    const m = sessionsOf(agent)
    const key = String(sessionId)
    let stream = m.get(key)
    if (!stream) {
      const agentId = agent.id != null ? agent.id : 'default' // 字符串 id 仅作身份戳元数据
      stream = create({ ...defaults, agentId, sessionId: key, agent })
      m.set(key, stream)
      streamCount += 1
    }
    return stream
  }

  /** 按身份把真实 start/chunk/end 帧路由到对应状态机（start 自动创建，其余不存在则忽略）。 */
  function handle(agent, sessionId, frame) {
    requireAgent(agent)
    if (!frame || typeof frame.type !== 'string') return Promise.resolve()
    if (frame.type === 'start') return get(agent, sessionId).handleStart(frame)
    const m = byAgent.get(agent)
    const stream = m ? m.get(String(sessionId)) : undefined
    if (!stream) return Promise.resolve()
    if (frame.type === 'chunk') return stream.handleChunk(frame)
    if (frame.type === 'end') return stream.handleEnd(frame)
    return Promise.resolve()
  }

  function dispose(agent, sessionId) {
    requireAgent(agent)
    const m = byAgent.get(agent)
    if (!m) return Promise.resolve()
    const key = String(sessionId)
    const stream = m.get(key)
    m.delete(key)
    if (m.size === 0) byAgent.delete(agent)
    streamCount -= stream ? 1 : 0
    return stream ? stream.dispose() : Promise.resolve()
  }

  function disposeAgent(agent) {
    requireAgent(agent)
    const m = byAgent.get(agent)
    if (!m) return Promise.resolve()
    byAgent.delete(agent)
    const streams = [...m.values()]
    streamCount -= streams.length
    return Promise.all(streams.map((s) => s.dispose()))
  }

  return {
    get,
    handle,
    dispose,
    disposeAgent,
    has(agent, sessionId) {
      requireAgent(agent)
      const m = byAgent.get(agent)
      return !!m && m.has(String(sessionId))
    },
    size: () => streamCount,
  }
}
