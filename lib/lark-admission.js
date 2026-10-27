// 飞书入站准入判据（host-only，独立模块，不接线）。
//
// 宿主事实（已实测证据 /tmp/dsh-feishu-admission-projection-evidence.md）：
// - idle agent 上 followup 会在 followup 内同步 claim，inbox 立刻变空；紧接着同 id
//   再 followup 不会被宿主拦截（inbox 只拒绝重复的 pending）。插件必须在 followup
//   **之前**自查，不能指望宿主抛错。
// - `agent/inbox/spliced` 的 data.inserted 是宿主准入的持久事实：followup 同步
//   append，claim/取消只产生 removedCount，投影不会因后续步骤让 id 消失。
// - `SessionStore.flush(session)` 返回 boolean：true=至少一个持久监听者参与；
//   false=无持久后端，不得标 delivered。
//
// 本模块提供：
// 1. createLarkAdmissionDefinition()：注册进 ctx.sessionProjections 的 host-only
//    定义（key/stateVersion/stateSchema.parse/init/apply），fold agent/inbox/spliced
//    的 inserted，收集本插件 userMessageId（lark-<ns8>-<seq>-<hash16>），每会话有界
//    保留（默认 2000），淘汰时按 namespace 分别抬高 evictedMax 水位。
// 2. larkAdmissionVerdict()：严格三态判据 admitted|not_admitted|uncertain——
//    命中 inbox 或投影 → admitted（仍需 flush===true 才可 settleDelivered）；
//    未命中且 seq > 该 ns 的 evictedMax 且投影状态有效 → not_admitted（可重投）；
//    其余（投影缺失/未注册/坏 shape/seq ≤ 水位/id 无法解析）→ uncertain（禁止
//    自动重投，走告知流程）。被淘汰的未决 claim 不能仅靠“不存在”重发。
//
// 读取方式（接线用，勿猜）：
// - ctx.sessionProjections.stateOf(agent.session, LARK_ADMISSION_KEY) → state | undefined
//   （未注册返回 undefined=不确定；返回值是借用引用，不得修改）。
// - agent.inbox.nextTurn / agent.inbox.nextStep → readonly UserMessage[]，元素含
//   .id（MessageId 字符串）。判定时收集两列的 id 传入 larkAdmissionVerdict。

import { parseLarkUserMessageId } from './lark-dedup.js'

export const LARK_ADMISSION_KEY = 'dshMessaging.larkAdmitted'
// stateVersion 2：新增 overflow 哨兵字段（evictedMax 按 namespace 有界，超限不可信）。
// 模块尚未安装到任何生产环境 → 整体换版本安全；旧 cache 行因版本不符被丢弃并重 fold。
export const LARK_ADMISSION_STATE_VERSION = 2
export const LARK_ADMISSION_IDS_PER_SESSION = 2000
// 水位 map 的 namespace 上限（可证明有界；超出 → overflow 哨兵，缺席 ns 一律 uncertain）。
export const LARK_ADMISSION_NS_LIMIT = 16

// userMessageId 严格形状：'lark-'+ns(8hex)+'-'+seq(十进制)+'-'+hash16(hex)。
const USER_MESSAGE_ID_RE = /^lark-([0-9a-f]{8})-(\d{1,16})-([0-9a-f]{16})$/

export const LARK_ADMISSION_VERDICTS = Object.freeze(['admitted', 'not_admitted', 'uncertain'])

// stateSchema.parse：projection-cache 恢复路径直接调用且不 catch——必须真实校验，
// 非法即抛（fail-closed：坏缓存触发从日志重 fold，绝不当空集）。
// state（v2）：{ ids: string[], evictedMax: { [ns]: seq }, overflow: boolean }
//   overflow=true 表示淘汰时已有 ≥16 个 ns 水位、更多 ns 无法记录 → 不在保留集合里
//   的 ns 一律 uncertain（绝不可当水位 0 → not_admitted）。
function parseState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('larkAdmission projection state must be an object')
  }
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys[0] !== 'evictedMax' || keys[1] !== 'ids' || keys[2] !== 'overflow') {
    throw new Error('larkAdmission projection state has an unknown shape (stateVersion mismatch?)')
  }
  if (typeof value.overflow !== 'boolean') {
    throw new Error('larkAdmission projection overflow must be boolean')
  }
  if (!Array.isArray(value.ids) || value.ids.length > LARK_ADMISSION_IDS_PER_SESSION) {
    throw new Error('larkAdmission projection ids must be an array within the retention bound')
  }
  for (const id of value.ids) {
    if (typeof id !== 'string' || !USER_MESSAGE_ID_RE.test(id)) {
      throw new Error('larkAdmission projection ids contain a foreign or malformed entry')
    }
  }
  const evicted = value.evictedMax
  if (!evicted || typeof evicted !== 'object' || Array.isArray(evicted)) {
    throw new Error('larkAdmission projection evictedMax must be an object map')
  }
  const nsKeys = Object.keys(evicted)
  if (nsKeys.length > LARK_ADMISSION_NS_LIMIT) {
    throw new Error('larkAdmission projection evictedMax exceeds the namespace bound')
  }
  for (const ns of nsKeys) {
    const seq = evicted[ns]
    if (!/^[0-9a-f]{8}$/.test(ns) || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error('larkAdmission projection evictedMax entry is malformed')
    }
  }
  return { ids: [...value.ids], evictedMax: { ...evicted }, overflow: value.overflow }
}

function seqOf(id) {
  const parsed = parseLarkUserMessageId(id)
  return parsed ? parsed.seq : null
}

// 注册进 ctx.sessionProjections 的定义（host-only，不带 wire）。
// state：{ ids: string[]（本插件 userMessageId，有界 FIFO）, evictedMax: { [ns]: seq } }。
export function createLarkAdmissionDefinition(options = {}) {
  const idsPerSession = Number.isSafeInteger(options.idsPerSession) && options.idsPerSession > 0
    ? Math.min(options.idsPerSession, LARK_ADMISSION_IDS_PER_SESSION)
    : LARK_ADMISSION_IDS_PER_SESSION
  return {
    key: LARK_ADMISSION_KEY,
    stateVersion: LARK_ADMISSION_STATE_VERSION,
    stateSchema: { parse: parseState },
    init: () => ({ ids: [], evictedMax: {}, overflow: false }),
    apply(state, event) {
      // 无关事件必须返回同一引用（宿主以引用相等短路）。
      if (!event || event.type !== 'agent/inbox/spliced') return state
      const inserted = event.data && event.data.inserted
      if (!Array.isArray(inserted)) return state
      const add = []
      for (const message of inserted) {
        if (!message || typeof message !== 'object') continue
        const id = typeof message.id === 'string' ? message.id : null
        // 只收本插件合法 id：外来 id/坏 shape 忽略，绝不混入水位。
        if (!id || !USER_MESSAGE_ID_RE.test(id)) continue
        if (state.ids.includes(id) || add.includes(id)) continue
        add.push(id)
      }
      if (add.length === 0) return state
      const ids = [...state.ids, ...add]
      const evictedMax = { ...state.evictedMax }
      let overflow = state.overflow
      while (ids.length > idsPerSession) {
        const victim = ids.shift()
        const seq = seqOf(victim)
        const ns = victim.slice(5, 13) // 'lark-' 之后的 ns 段
        if (seq === null) continue
        if (evictedMax[ns] !== undefined) {
          if (seq > evictedMax[ns]) evictedMax[ns] = seq
        } else if (Object.keys(evictedMax).length < LARK_ADMISSION_NS_LIMIT) {
          evictedMax[ns] = seq
        } else {
          // namespace 水位表已满：无法为该 ns 记水位 → 溢出哨兵；
          // 此后缺席的 ns 一律 uncertain（可证明：不缺席的16个照常判）。
          overflow = true
        }
      }
      return { ids, evictedMax, overflow }
    },
  }
}

// 从 inbox 两列收集本插件 id（接线勿手抄形状；未知 shape 返回 null=fail-closed）。
export function larkAdmissionInboxIds(agent) {
  if (!agent || !agent.inbox) return null
  const nextTurn = agent.inbox.nextTurn
  const nextStep = agent.inbox.nextStep
  if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) return null
  const ids = []
  for (const message of [...nextTurn, ...nextStep]) {
    if (message && typeof message === 'object' && typeof message.id === 'string') ids.push(message.id)
  }
  return ids
}

// 严格三态判据（不是 boolean）：
// - admitted：userMessageId ∈ inbox ∪ proj.ids（仍需 flush===true 且 admission 明确
//   admitted 才可 settleDelivered）
// - not_admitted：投影状态有效（已注册且 schema 合法）且未命中且 seq > 该 ns 的
//   evictedMax → 确定未准入，可安全重投
// - uncertain：投影缺失/未注册/坏 shape/id 无法解析/seq ≤ 水位（可能被淘汰，无法
//   证明）/水位表溢出后缺席 ns → 禁止自动重投，走可见告知流程；被淘汰的未决
//   claim 不能仅靠不存在重发
export function larkAdmissionVerdict(input) {
  const id = input && input.userMessageId
  const parsed = typeof id === 'string' ? parseLarkUserMessageId(id) : null
  const inboxIds = input && Array.isArray(input.inboxIds) ? input.inboxIds : null
  if (inboxIds !== null && inboxIds.includes(id)) {
    return { verdict: 'admitted', reason: 'inbox' }
  }
  const state = input && input.projectionState
  // 投影缺失（未注册/未注入/未恢复）：fail-closed，不得当未命中。
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { verdict: 'uncertain', reason: 'projection_missing' }
  }
  let valid = false
  try {
    parseState(state)
    valid = true
  } catch {
    valid = false
  }
  if (!valid) return { verdict: 'uncertain', reason: 'projection_invalid' }
  if (Array.isArray(state.ids) && state.ids.includes(id)) {
    return { verdict: 'admitted', reason: 'projection' }
  }
  if (!parsed) return { verdict: 'uncertain', reason: 'id_unparseable' }
  const nsKnown = state.evictedMax && Object.prototype.hasOwnProperty.call(state.evictedMax, parsed.ns)
  if (!nsKnown && state.overflow === true) {
    // 水位表（≤16 ns）曾溢出：该 ns 可能是被挤掉水位的 → 无法证明未准入，fail-closed。
    return { verdict: 'uncertain', reason: 'waterline_overflow' }
  }
  const waterline = nsKnown && Number.isSafeInteger(state.evictedMax[parsed.ns])
    ? state.evictedMax[parsed.ns]
    : 0
  if (parsed.seq <= waterline) {
    // 落在淘汰水位以下：可能已被投影淘汰（已准入无法证明），fail-closed。
    return { verdict: 'uncertain', reason: 'evicted_waterline' }
  }
  return { verdict: 'not_admitted', reason: 'proved_absent' }
}
