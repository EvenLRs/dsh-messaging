// Feishu / Lark CardKit 与 IM 卡片官方 API 封装。
// 所有网络调用都通过注入的 httpRequest(method, url, headers, body) 完成，
// 与 lib/index.js 的 curl 实现解耦，方便单元测试注入替身。
//
// ⚠ 注入契约（JSON wrapper 由引擎接线负责，lib/index.js 侧另接）：
// 本模块每次交给 httpRequest 的 body 都是**普通对象**（对象 payload），headers 只带
// Authorization。宿主必须注入一层 wrapper：统一 JSON.stringify(payload) 并补
// `Content-Type: application/json; charset=utf-8` 后再交给原生 httpRequest。
// 每个外发对象**不得直接**交原生 httpRequest——其 body 期望原始字符串，
// 直传会把对象编码成 [object Object]，请求体即刻损坏。
//
// 协议来源：本地官方 SDK lib/index.js:65674-65688（im.message.patch）、
// 103641-103694（buildStreamingCard）、105128-105207（CardKit 流式）。

import {
  createStreamingCard,
  createStaticCard,
  createTextSegmentCard,
  createErrorCard,
  createCardReferencePayload,
  createStreamingSettingsPayload,
} from './lark-card-layout.js'

export const LARK_API_BASE = 'https://open.feishu.cn/open-apis'

function larkError(result) {
  if (!result) return 'no response'
  if (result.json && typeof result.json.msg === 'string') return result.json.msg
  if (result.json && typeof result.json.error === 'string') return result.json.error
  if (result.stderr) return result.stderr
  if (!result.ok) return 'HTTP ' + result.status
  return null
}

// 诊断用：只提取平台**数值** code（整数才保留）；raw body/原始错误文本不透出本模块。
function apiCodeOf(result) {
  if (!result || !result.json) return null
  return Number.isInteger(result.json.code) ? result.json.code : null
}

function unwrapCardId(result) {
  if (!result || !result.json || !result.json.data) return null
  if (typeof result.json.data.card_id === 'string') return result.json.data.card_id
  return null
}

function unwrapMessageId(result) {
  if (!result || !result.json || !result.json.data) return null
  if (typeof result.json.data.message_id === 'string') return result.json.data.message_id
  return null
}

function unwrapCreateData(result) {
  if (!result || !result.json || !result.json.data) return null
  return result.json.data
}

// 创建 CardKit 卡片实体，返回 card_id（流式更新必需）。
// SDK 契约：POST /cardkit/v1/cards，body { type: 'card_json', data: JSON.stringify(spec) }
export async function createCardInstance({ cardSpec, accessToken, httpRequest }) {
  const url = LARK_API_BASE + '/cardkit/v1/cards'
  const payload = {
    type: 'card_json',
    data: JSON.stringify(cardSpec || {}),
  }
  const result = await httpRequest('POST', url, { Authorization: 'Bearer ' + accessToken }, payload)
  const cardId = unwrapCardId(result)
  const error = larkError(result)
  if (result.ok && result.json && result.json.code === 0 && !cardId) {
    return {
      ok: false,
      status: result.status,
      error: 'cardkit.card.create returned no card_id',
      cardId: null,
      raw: result,
    }
  }
  return {
    ok: result.ok && result.json && result.json.code === 0,
    status: result.status,
    error,
    cardId,
    raw: result,
  }
}

// 通过 card_id 引用发送 interactive 卡片消息。
// SDK 契约：POST /im/v1/messages?receive_id_type=chat_id，msg_type='interactive'，
// content=JSON.stringify({ type: 'card', data: { card_id } })
export async function sendCardByReference({ conversation, cardId, accessToken, httpRequest }) {
  const target = String(conversation).replace(/^lark:/, '')
  const url = LARK_API_BASE + '/im/v1/messages?receive_id_type=chat_id'
  const payload = {
    receive_id: target,
    msg_type: 'interactive',
    content: JSON.stringify(createCardReferencePayload(cardId)),
  }
  const result = await httpRequest('POST', url, { Authorization: 'Bearer ' + accessToken }, payload)
  const messageId = unwrapMessageId(result)
  const error = larkError(result)
  if (result.ok && result.json && result.json.code === 0 && !messageId) {
    return {
      ok: false,
      status: result.status,
      error: 'im.message.create returned no message_id',
      messageId: null,
      raw: result,
    }
  }
  return {
    ok: result.ok && result.json && result.json.code === 0,
    status: result.status,
    error,
    messageId,
    raw: result,
  }
}

// 直接发送完整的 interactive 卡片（静态卡片无需 CardKit 创建）。
export async function sendInteractiveCardDirect({ conversation, cardSpec, accessToken, httpRequest }) {
  const target = String(conversation).replace(/^lark:/, '')
  const url = LARK_API_BASE + '/im/v1/messages?receive_id_type=chat_id'
  const payload = {
    receive_id: target,
    msg_type: 'interactive',
    content: JSON.stringify(cardSpec || {}),
  }
  const result = await httpRequest('POST', url, { Authorization: 'Bearer ' + accessToken }, payload)
  const messageId = unwrapMessageId(result)
  const error = larkError(result)
  if (result.ok && result.json && result.json.code === 0 && !messageId) {
    return {
      ok: false,
      status: result.status,
      apiCode: apiCodeOf(result),
      error: 'im.message.create returned no message_id',
      messageId: null,
      raw: result,
    }
  }
  return {
    ok: result.ok && result.json && result.json.code === 0,
    status: result.status,
    apiCode: apiCodeOf(result),
    error,
    messageId,
    raw: result,
  }
}

// 直接 PATCH 已发送消息卡片（静态卡片更新）。
// SDK 契约：PATCH /im/v1/messages/:message_id，body { content: JSON.stringify(cardSpec) }
export async function patchInteractiveCardDirect({ messageId, cardSpec, accessToken, httpRequest }) {
  const url = LARK_API_BASE + '/im/v1/messages/' + encodeURIComponent(messageId)
  const payload = {
    content: JSON.stringify(cardSpec || {}),
  }
  const result = await httpRequest('PATCH', url, { Authorization: 'Bearer ' + accessToken }, payload)
  return {
    ok: result.ok && result.json && result.json.code === 0,
    status: result.status,
    error: larkError(result),
    raw: result,
  }
}

// CardKit 流式更新组件内容。
// SDK 契约：PUT /cardkit/v1/cards/:card_id/elements/:element_id/content，
// body { content, sequence, uuid }
export async function updateCardElementContent({ cardId, elementId, content, sequence, accessToken, httpRequest }) {
  const url = LARK_API_BASE + '/cardkit/v1/cards/' + encodeURIComponent(cardId)
    + '/elements/' + encodeURIComponent(elementId) + '/content'
  const payload = {
    content: String(content || ''),
    sequence: Number(sequence),
    uuid: 'c_' + cardId + '_' + sequence,
  }
  const result = await httpRequest('PUT', url, { Authorization: 'Bearer ' + accessToken }, payload)
  return {
    ok: result.ok && result.json && result.json.code === 0,
    status: result.status,
    apiCode: apiCodeOf(result),
    error: larkError(result),
    raw: result,
  }
}

// 关闭 CardKit 流式卡片。
// SDK 契约：PATCH /cardkit/v1/cards/:card_id/settings，body { settings, sequence, uuid }
export async function finishStreamingCard({ cardId, sequence, summary, accessToken, httpRequest }) {
  const url = LARK_API_BASE + '/cardkit/v1/cards/' + encodeURIComponent(cardId) + '/settings'
  const payload = {
    settings: JSON.stringify(createStreamingSettingsPayload(summary)),
    sequence: Number(sequence),
    uuid: 's_' + cardId + '_' + sequence,
  }
  const result = await httpRequest('PATCH', url, { Authorization: 'Bearer ' + accessToken }, payload)
  return {
    ok: result.ok && result.json && result.json.code === 0,
    status: result.status,
    apiCode: apiCodeOf(result),
    error: larkError(result),
    raw: result,
  }
}

// 便捷：发送静态文本卡片（直接 IM interactive，不经过 CardKit 创建）。
export async function sendInteractiveText({ conversation, text, accessToken, httpRequest }) {
  return sendInteractiveCardDirect({
    conversation,
    cardSpec: createTextSegmentCard(text),
    accessToken,
    httpRequest,
  })
}

// 把 httpRequest 的 throw（如 ETIMEDOUT）转成结构化失败：保留原始原因（message/code/异常对象）、
// 已知 cardId 与“投递状态未知”标记（超时 reject 不等于未送达，可能已发出但响应丢失）。
// 引擎据 cardId 定向收尾；任何失败分支都不得再次创建/发送，绝不盲重发。
function thrownFailure(err, cardId) {
  return {
    ok: false,
    status: null,
    error: (err && err.message) || String(err),
    code: (err && err.code) || null,
    thrown: true,
    deliveryUnknown: true,
    cardId: cardId === undefined ? null : cardId,
    messageId: null,
    cause: err,
  }
}

// 便捷：发送 CardKit 流式卡片并返回 cardId + messageId。
// 失败语义（供引擎幂等收尾，禁止盲重发）：
// - create 结构化失败 → 不发起引用 send。返回 cardId 可能非空（失败响应里仍带
//   data.card_id 时原样保留，引擎应考虑对该已知 ID 收尾）；cardId 为 null 表示
//   **创建结果未知**（超时/响应缺 ID 时服务器可能已创建、只是身份不可知），
//   不承诺不存在遗留实体，引擎不得据此盲重开第二张。
// - create 抛异常 → 结构化返回（thrown:true/deliveryUnknown:true/cardId:null），
//   创建结果同样未知，不透传裸 rejection 丢上下文。
// - create 成功但引用发送失败（HTTP 失败、缺 message_id 或 throw）→ 返回值始终
//   保留已创建的 cardId 与原始原因（throw 路径带 code/cause/deliveryUnknown），
//   引擎必须据此对 streaming_mode:true 的实体调 finishStreamingCard 幂等关闭；
//   投递结果不明时不得重发第二张卡，只收尾已知 cardId。
export async function sendStreamingCard({ conversation, text, accessToken, httpRequest, hint, onAttempt, onStage }) {
  // 诊断派发/ACK 钩子（可选）：onAttempt 在阶段真实派发前回调；onStage 在该阶段
  // **实际返回/throw 时**回调（真实 ACK 时刻，不等后续阶段）；抛错一律被吞，绝不
  // 影响发送链路。不提供则完全保持原行为。
  const notifyAttempt = (stage) => {
    if (typeof onAttempt !== 'function') return
    try { onAttempt(stage) } catch {}
  }
  const notifyStage = (stage, outcome) => {
    if (typeof onStage !== 'function') return
    try { onStage(stage, outcome) } catch {}
  }
  const stageOutcome = (result, ok, unknown) => ({
    ok,
    status: result && Number.isInteger(result.status) ? result.status : null,
    apiCode: apiCodeOf(result && result.raw ? result.raw : result),
    unknown,
    error: ok ? '' : String((result && result.error) || ''),
    // 仅内存瞬时透传：供 index 侧用 larkNoResponse 判定返回式无响应（timeout 等），
    // 不落库、不出诊断出口。
    raw: result && result.raw ? result.raw : result,
  })
  notifyAttempt('card_create')
  let created
  try {
    created = await createCardInstance({
      cardSpec: createStreamingCard(text, { hint }),
      accessToken,
      httpRequest,
    })
  } catch (err) {
    // create 抛异常：创建结果未知（可能已建但身份不可知），结构化上报，不盲重开。
    notifyStage('card_create', { ok: false, status: null, apiCode: null, unknown: true, error: String((err && err.message) || err) })
    return {
      ...thrownFailure(err, null),
      stages: {
        create: { ok: false, status: null, apiCode: null, unknown: true },
        reference: null,
      },
    }
  }
  if (!created.ok) {
    notifyStage('card_create', stageOutcome(created, false, Boolean(created.deliveryUnknown)))
    return {
      ...created,
      stages: {
        create: {
          ok: false,
          status: created.status == null ? null : created.status,
          apiCode: apiCodeOf(created.raw),
          unknown: Boolean(created.deliveryUnknown),
        },
        reference: null,
      },
    }
  }
  notifyStage('card_create', stageOutcome(created, true, false))

  notifyAttempt('card_reference')
  let sent
  try {
    sent = await sendCardByReference({
      conversation,
      cardId: created.cardId,
      accessToken,
      httpRequest,
    })
  } catch (err) {
    // P1：已知 cardId 必须保留——超时等 rejection 不等于未送达，投递状态未知，禁止盲重发。
    notifyStage('card_reference', { ok: false, status: null, apiCode: null, unknown: true, error: String((err && err.message) || err) })
    return {
      ...thrownFailure(err, created.cardId),
      stages: {
        create: { ok: true, status: created.status == null ? null : created.status, apiCode: apiCodeOf(created.raw) ?? 0, unknown: false },
        reference: { ok: false, status: null, apiCode: null, unknown: true },
      },
    }
  }
  if (!sent.ok) {
    // 保留 create 阶段的 cardId 与 send 的 error，引擎可幂等关闭该实体。
    notifyStage('card_reference', stageOutcome(sent, false, Boolean(sent.deliveryUnknown)))
    return {
      ...sent,
      cardId: created.cardId,
      stages: {
        create: { ok: true, status: created.status == null ? null : created.status, apiCode: apiCodeOf(created.raw) ?? 0, unknown: false },
        reference: {
          ok: false,
          status: sent.status == null ? null : sent.status,
          apiCode: apiCodeOf(sent.raw),
          unknown: Boolean(sent.deliveryUnknown),
        },
      },
    }
  }
  notifyStage('card_reference', stageOutcome(sent, true, false))
  return {
    ok: true,
    status: sent.status,
    error: null,
    cardId: created.cardId,
    messageId: sent.messageId,
    stages: {
      create: { ok: true, status: created.status == null ? null : created.status, apiCode: apiCodeOf(created.raw) ?? 0, unknown: false },
      reference: { ok: true, status: sent.status, apiCode: apiCodeOf(sent.raw) ?? 0, unknown: false },
    },
  }
}

// 便捷：发送错误卡片。
export async function sendInteractiveError({ conversation, error, accessToken, httpRequest, title }) {
  return sendInteractiveCardDirect({
    conversation,
    cardSpec: createErrorCard(error, { title }),
    accessToken,
    httpRequest,
  })
}
