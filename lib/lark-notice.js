// lib/lark-notice.js —— 恢复失败的固定无正文告知（C-1）。
// 复用 store.sendReceipts 的持久去重状态机，但用**独立 notice UUID/digest 业务域**
// （lkn_ 前缀 + 'dsh-messaging/lark-notice/v1' 元组），与图片出站（lki_/lark-send）
// 绝不互串。文本固定枚举、无正文；card=true 一律 interactive；uuid 真实入 wire。
// 所有 I/O 经 seam 注入（receipts/wire），本模块零网络、可独立单测。
import { createHash } from 'node:crypto'

export const LARK_NOTICE_KINDS = Object.freeze([
  'session_missing', // 会话已删：不复活，告知重发
  'sid_or_chat_missing', // 缺 route 证据（chat 已知才发）
  'edited', // 官方 GET updated=true：请重发
  'refetch_scope_missing', // 权限不可恢复（scope 查询判定）
  'refetch_unavailable', // 永久缺资源（404/不存在）
  'uncertain', // admission uncertain：无法确认处理状态
  'waiting_for_input', // 已 admitted 且 pending 仍在 inbox（冷 resume idle）：需后续输入继续
  'image_unavailable', // 图片永久失败（下载/校验/多图部分失败）：未准入，请重发
  'image_not_supported', // 当前模型非视觉：图片未入模，明确告知（不自动切模型）
  'attachments_unavailable', // 宿主附件服务缺失：图片未处理，请重发
])

// 固定文案（无正文、无 ID、无路径）。
const NOTICE_TEXT = Object.freeze({
  session_missing: '之前发起的会话已不可用，该消息未被处理，请重新发送。',
  sid_or_chat_missing: '该消息缺少可确认的目标会话，未能处理，请重新发送。',
  edited: '该消息已被编辑，无法确认原文，请重新发送。',
  refetch_scope_missing: '暂时没有权限读取该消息，未能处理，请重新发送或检查应用权限。',
  refetch_unavailable: '无法找回该消息的原文，未能处理，请重新发送。',
  uncertain: '暂时无法确认该消息的处理状态，如未得到回复请重新发送。',
  waiting_for_input: '该消息已入队，需要后续输入时继续处理。',
  image_unavailable: '该消息中的图片未能处理，消息未被提交，请重新发送。',
  image_not_supported: '当前会话使用的模型不支持图片输入，图片未被提交；如需看图请更换支持视觉的模型后重发。',
  attachments_unavailable: '图片服务当前不可用，消息未被提交，请稍后重发。',
})

export function larkNoticeUuid(key, kind) {
  const digest = createHash('sha256').update(String(key) + '|' + String(kind)).digest('hex')
  return 'lkn_' + digest.slice(0, 44) // 4+44=48 ≤50；同 key+kind 稳定 → sendReceipts 幂等
}

export function larkNoticeDigest({ kind, appId, conversation }) {
  return createHash('sha256').update(JSON.stringify([
    'dsh-messaging/lark-notice/v1',
    String(kind),
    String(appId),
    String(conversation),
  ]), 'utf8').digest('hex')
}

function noticeWireBody(kind, interactiveCard) {
  const text = NOTICE_TEXT[kind] || NOTICE_TEXT.uncertain
  if (interactiveCard) {
    return JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: text } }] } })
  }
  return JSON.stringify({ text })
}

const LARK_NOTICE_TARGET_CODES = new Set([230002, 230013, 220101])
const LARK_NOTICE_SCOPE_CODES = new Set([99991672, 230031, 230032])

/**
 * 发送恢复告知。返回 outcome：
 * - delivered：已确认送达（finish(sent) 已持久，或 begin=sent 重放）→ 调用方才可 settleRejected
 * - unknown：平台状态不可证 / finish 持久失败 → 不谎 rejected、不重派，入站记录保留 claimed
 * - failed：平台明确拒绝（finish rejected 已持久）→ 通知未送达，入站记录保留可见 pending
 * - in_progress / conflict / storage_unavailable：本进程不重派/存储不可用，保留 pending
 * - pending_target：无法确认原 chat 目标 → 仅本地阻断，绝不乱发
 * - invalid_kind：未知 kind（固定文案缺失）→ 不发送
 */
export async function sendLarkNotice({ receipts, wire, key, kind, appId, conversation, chatId, interactiveCard, now, isCurrent = () => true }) {
  if (!isCurrent()) return { outcome: 'stale' }
  if (!LARK_NOTICE_KINDS.includes(kind)) return { outcome: 'invalid_kind' }
  if (!chatId || !conversation) return { outcome: 'pending_target' }
  if (!receipts || typeof receipts.begin !== 'function' || typeof receipts.finish !== 'function') {
    return { outcome: 'storage_unavailable' }
  }
  const uuid = larkNoticeUuid(key, kind)
  const digest = larkNoticeDigest({ kind, appId: appId || '', conversation })
  let begun = null
  try {
    begun = await receipts.begin({ uuid, digest, now: typeof now === 'function' ? now() : Date.now() })
  } catch {
    return { outcome: 'storage_unavailable' } // fail-closed，绝不当 new
  }
  if (!isCurrent()) return { outcome: 'stale' }
  const outcome = begun && typeof begun.outcome === 'string' ? begun.outcome : null
  if (outcome === 'sent') return { outcome: 'delivered' } // 重放=已送达，零重复发送
  if (outcome === 'rejected') return { outcome: 'failed' } // 曾被平台明确拒绝
  if (outcome === 'unknown') return { outcome: 'unknown' } // 不重派
  if (outcome === 'in_progress') return { outcome: 'in_progress' }
  if (outcome === 'conflict') return { outcome: 'conflict' }
  if (outcome !== 'acquired') return { outcome: 'storage_unavailable' }
  const ownerToken = begun.record && begun.record.ownerToken
  if (!ownerToken) return { outcome: 'storage_unavailable' }
  if (typeof wire !== 'function') {
    return { outcome: 'storage_unavailable' }
  }
  const msgType = interactiveCard === true ? 'interactive' : 'text'
  let res = null
  try {
    res = await wire('POST', 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { 'Content-Type': 'application/json; charset=utf-8' },
      { receive_id: String(chatId), msg_type: msgType, content: noticeWireBody(kind, interactiveCard), uuid })
  } catch {
    res = null
  }
  if (!isCurrent()) return { outcome: 'stale' }
  const apiCode = res && res.json && Number.isInteger(res.json.code) ? res.json.code : null
  const messageId = res && res.ok && res.json && res.json.code === 0 && res.json.data
    ? String(res.json.data.message_id || '')
    : ''
  const finish = async (state, extra) => {
    try {
      const fin = await receipts.finish({ uuid, ownerToken, state, ...extra })
      return fin === true || Boolean(fin && typeof fin === 'object' && fin.state === state)
    } catch {
      return false
    }
  }
  if (messageId) {
    // 先 durable 再报送达；写失败 → unknown（绝不谎 rejected）。
    return (await finish('sent', { messageId })) ? { outcome: 'delivered' } : { outcome: 'unknown' }
  }
  if (res && res.ok && apiCode !== null && apiCode !== 0) {
    const reason = LARK_NOTICE_TARGET_CODES.has(apiCode) ? 'target_gone'
      : LARK_NOTICE_SCOPE_CODES.has(apiCode) ? 'scope_missing' : 'platform_error'
    return (await finish('rejected', { reason })) ? { outcome: 'failed' } : { outcome: 'unknown' }
  }
  // 无响应/5xx/结构未知 → unknown（不重派、不谎）
  return (await finish('unknown', { reason: 'platform_error' })) ? { outcome: 'unknown' } : { outcome: 'unknown' }
}
