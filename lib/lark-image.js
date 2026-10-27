// 飞书图片双向收发（独立模块，index 未接线）。
// 依据：官方 open.feishu.cn 一手文档（image/create、message-resource/get、message/create、
// 卡片 JSON2.0 img 组件）+ installed host 0.2.0-rc.2 契约 + **真实 @larksuiteoapi/node-sdk
// 1.74.0 离线 wire 实测**（B1–B7 修复按真实 SDK 载荷/返回/错误形状，不按自定义 mock）。
//
// 真实 SDK 调用形状（离线探针核实）：
//   - 下载：get({ path:{message_id, file_key}, params:{type:'image'} }) →
//     { writeFile(), getReadableStream(), headers }；错误响应体在 responseType:'stream' 下是流。
//   - 上传：image.create({ data:{ image_type:'message', image: Buffer } }) → multipart 实字段。
//   - 发送：message.create({ params:{receive_id_type:'chat_id'},
//     data:{receive_id, msg_type, content, uuid} }) → 返回整个 body {code, msg, data:{message_id}}。
//   - SDK formatPayload 不透传 per-request timeout：真实超时/取消由注入的
//     httpInstance（Client 构造时 axios.create({timeout})）负责（接线 W1）；本模块对
//     下载流自行看门狗并**真实 destroy**；上传/发送的早期返回只可能报 unknown（绝不
//     声称未送达）；可选 signal 中止下载流、上传/发送中止后同样保持 unknown。
//
// 安全边界（验收契约 §2/§3/§7 + 复审 B/M 项）：
// - 入站 file_key 只来自已鉴权事件并与该事件 message_id 配对；不抓 content 内 URL。
// - 出站只接受本会话日志引用的 attachment_id（授权 seam）或宿主 fs 策略 resolve 的
//   工作区文件；工具参数无 chat/receive/url；caption 用 plain_text（无 Markdown 图片
//   旁路）；单次单张（≤9 上限保留给未来批量）。
// - 非视觉路由（inputModalities 未显式含 'image'）→ 明确拒绝，调用方只投文本+可见提示。
// - 失败语义：有确定 HTTP 响应 = failed（带 status/code 分类）；仅无响应 = unknown；
//   下载 GET 幂等 = 瞬时可重试。uuid 安全重试仅限**首派发起算**的 55 分钟窗口。
// - 脱敏：结果/工具输出不含 token/Authorization/图片字节/本地绝对路径/base64；
//   image_key 不进工具 render。

import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
// R4/Lead：digest 与 ledger **同源**——直接用 lark-dedup 导出的 larkSendDigest
// （版本化 JSON 元组 sha256，含 appId/conversation 目标绑定），拒绝本地再实现。
import { larkSendDigest, LARK_SEND_REASONS } from './lark-dedup.js'

// 平台与宿主共同约束的固定闭集（宿主 attachment 服务权威复验）。
export const LARK_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
// 出站单次调用张数上限（验收契约建议 ≤9；当前实现单次单张）。
export const LARK_SEND_IMAGE_MAX_PER_CALL = 9
// 平台上限（官方一手）：上传 ≤10MB 且非 0 字节。
export const LARK_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
// 下载默认上限：宿主单图上限（20MiB）与平台 100MB 取小；可由配置覆盖。
export const LARK_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024
// uuid 安全重试窗口：官方同 uuid 1 小时内至多成功一次 → 首派发起 55 分钟（留余量），
// 且窗口**不随重试重新延长**。
export const LARK_UUID_RETRY_WINDOW_MS = 55 * 60 * 1000
// N3：底层 transport 超时必须比模块 deadline 至少早这个余量（毫秒）。
export const LARK_TRANSPORT_MARGIN_MS = 1000
// R3：白名单来源＝主机实装的两个错误码集（ATTACHMENT_ERROR_CODES /
// IMAGE_ADMISSION_ERROR_CODES，自 app.asar 提取，2026-10-15）；非白名单（含路径/任意
// 串）一律归 'other'，绝不透传（render 与结构化结果同规则）。
export const LARK_ATTACHMENT_ERROR_CODES = Object.freeze([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'IMAGE_TOO_LARGE',
  'IMAGE_DIMENSION_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_TYPE_MISMATCH',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE',
  'INVALID_IMAGE_BASE64',
  'INVALID_FILE_BASE64',
  'ATTACHMENT_CORRUPT',
  'ATTACHMENT_FILES_UNSUPPORTED',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_PROJECTION_UNSUPPORTED',
  'ATTACHMENT_READ_FAILED',
  'ATTACHMENT_WRITE_FAILED',
  'INVALID_ATTACHMENT_REF',
])
// errorCode 出口唯一规则：白名单原样，其余（含路径/任意串）→ 'other'。
export function sanitizeAttachmentErrorCode(code) {
  if (typeof code === 'string' && LARK_ATTACHMENT_ERROR_CODES.includes(code)) return code
  return 'other'
}
// 官方标注可重试（瞬时）的资源/上传错误码。
const TRANSIENT_API_CODES = new Set([234019, 232096, 234044])
// 官方标注的确定（永久）错误码。
const PERMANENT_API_CODES = new Set([234003, 234004, 234009, 234038, 234040, 234043, 230110, 234006, 234010, 234011, 234039])
// 错误流有界解析上限（不因错误体无限缓冲）。
const ERROR_BODY_MAX_BYTES = 64 * 1024

// 非视觉路由的用户可见固定文案（不含路径/键/任何私密内容）。
export const LARK_IMAGE_UNSUPPORTED_NOTICE =
  '图片已随消息收到，但当前会话的模型不支持读取图片，图片未交给模型；文字部分已正常送达。'

export function classifyImageApiError(code) {
  const value = Number(code)
  if (!Number.isFinite(value)) return null
  if (TRANSIENT_API_CODES.has(value)) return 'transient'
  if (PERMANENT_API_CODES.has(value)) return 'permanent'
  return null
}

// 真实文件签名识别（不信任扩展名/声明；宿主附件服务会再权威解码复验）。
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

const IMAGE_KEY_RE = /^img_[A-Za-z0-9_-]+$/

// 把 SDK/axios 两种返回形态归一为 {body, value}：body=平台 {code,…}（若存在），
// value=data 层（image_key/message_id 所在）。B4：有 code 必校验；无 code 形态（SDK
// 已归一到 data 层）只校验必要形状；任何 code≠0 都不得判成功。
function unwrapApiResult(res) {
  if (!res || typeof res !== 'object') return { body: null, value: null }
  if ('code' in res) return { body: res, value: res.data && typeof res.data === 'object' ? res.data : null }
  if (res.data && typeof res.data === 'object') {
    if ('code' in res.data) return { body: res.data, value: res.data.data && typeof res.data.data === 'object' ? res.data.data : null }
    return { body: null, value: res.data }
  }
  // SDK 已归一到字段层（拦截器/不同版本）：直接识别必要形状。
  if ('message_id' in res || 'image_key' in res) return { body: null, value: res }
  return { body: null, value: null }
}

// 有确定 HTTP 响应 = 确定结果（failed，按业务 code → HTTP status 分类）；
// 只有无响应（超时/连接中断，可能已发出）才是 unknown（发送/上传）或 transient（幂等 GET）。
// responseType:'stream' 的错误体是流 → 有界读取并 JSON 解析后再分类（B5）。
async function classifyTransportError(error, options = {}) {
  const response = error && error.response
  if (!response) return { outcome: 'unknown' }
  const status = Number.isInteger(response.status) ? response.status : null
  // N2：发送侧保守——5xx/网关/429 无明确业务拒绝证据 → unknown（可能已被平台处理）；
  // 只有 4xx（或 200+code≠0，由调用方判定）才是确定拒绝。下载/上传幂等语义保持。
  if (options.sendSafe === true && status !== null && (status >= 500 || status === 429)) {
    return { outcome: 'unknown', category: 'transient', code: null, status }
  }
  let body = response.data
  if (body && typeof body.pipe === 'function') {
    const chunks = []
    let total = 0
    try {
      for await (const chunk of body) {
        total += chunk.length
        if (total > ERROR_BODY_MAX_BYTES) {
          if (typeof body.destroy === 'function') body.destroy()
          break
        }
        chunks.push(chunk)
      }
    } catch {
      // 错误流读取失败 → 走 status 兜底
    }
    const text = Buffer.concat(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk))).toString('utf8')
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  const code = body && Number.isFinite(Number(body.code)) ? Number(body.code) : null
  if (code != null) {
    const byCode = classifyImageApiError(code)
    if (byCode) return { outcome: 'failed', category: byCode, code }
    if (status !== null && (status >= 500 || status === 429)) return { outcome: 'failed', category: 'transient', code }
    return { outcome: 'failed', category: 'permanent', code }
  }
  if (status !== null && (status >= 500 || status === 429)) return { outcome: 'failed', category: 'transient', code: null, status }
  if (status !== null) return { outcome: 'failed', category: 'permanent', code: null, status }
  return { outcome: 'unknown' }
}

// 入站消息内容解析（接收形状 ≠ 发送形状）：
// - image 消息：根 {image_key}。
// - post：**根级** {title?, content:[[node…]…], content_v2}（无 zh_cn 包裹；content_v2 与
//   content 同形，数组）。文本语义**严格对齐现有 larkPostText**：标题作为首行，正文段落
//   行之间恰好一个 '\n'（段内带 text 的节点直接拼接；md 元素的 text 按纯文本——不做
//   Markdown 图片抽取，只认结构化 img 元素；at 等无 text 节点与现有摊平一致不贡献）。
// - 图片只来自结构化 {tag:'img', image_key}（img_ 键形状）；media/sticker/file/audio →
//   可见占位标记（不注入 prompt 文本，交调用方告知）；超 maxImages → droppedImages 计数。
export function extractMessageImageParts(parsedContent, options = {}) {
  const maxImages = Number.isFinite(options.maxImages) && options.maxImages > 0 ? options.maxImages : 20
  const parts = []
  const unsupported = []
  let imageCount = 0
  let droppedImages = 0
  const pushImage = (imageKey) => {
    if (!IMAGE_KEY_RE.test(String(imageKey || ''))) {
      unsupported.push({ kind: 'invalid_image_key' })
      return
    }
    imageCount += 1
    if (imageCount > maxImages) {
      droppedImages += 1
      return
    }
    parts.push({ kind: 'image', imageKey: String(imageKey) })
  }
  const pushText = (text) => {
    const value = typeof text === 'string' ? text : ''
    if (!value) return
    const last = parts[parts.length - 1]
    if (last && last.kind === 'text') last.text += value
    else parts.push({ kind: 'text', text: value })
  }
  const content = parsedContent && typeof parsedContent === 'object' ? parsedContent : null
  if (!content) return { parts, unsupported, imageCount, droppedImages }
  // image 消息：根 {image_key}（无标题）。
  if (typeof content.image_key === 'string' && content.image_key) {
    pushImage(content.image_key)
    return { parts, unsupported, imageCount, droppedImages }
  }
  const hasTitle = typeof content.title === 'string' && Boolean(content.title)
  if (hasTitle) pushText(content.title) // larkPostText：[title, body].join('\n')
  let emittedLines = hasTitle ? 1 : 0
  const rows = Array.isArray(content.content) && content.content.length
    ? content.content
    : (Array.isArray(content.content_v2) ? content.content_v2 : null)
  if (rows) {
    const paragraphs = rows.every((paragraph) => Array.isArray(paragraph)) ? rows : [rows]
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue
      let lineStarted = false
      // 行首换行：与前一已产出行之间恰好一个 '\n'（对齐 lines.join('\n')）。
      const lead = () => {
        if (emittedLines > 0 && !lineStarted) pushText('\n')
        lineStarted = true
      }
      let contributed = false
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue
        if (element.tag === 'img') {
          lead()
          pushImage(element.image_key)
          contributed = true
        } else if (element.tag === 'media' || element.tag === 'sticker' || element.tag === 'file' || element.tag === 'audio') {
          // 可见占位标记（交调用方告知）：与 larkPostText 一致不贡献正文行，
          // 不参与 '\n' 分隔（避免悬挂换行）。
          unsupported.push({ kind: String(element.tag), hasImageKey: typeof element.image_key === 'string' })
        } else if (typeof element.text === 'string' && element.text) {
          lead()
          pushText(element.text)
          contributed = true
        }
        // at 等无 text 节点：与现有 larkPostText 摊平一致，不贡献文本、不入 unsupported。
      }
      if (contributed) emittedLines += 1
    }
  }
  return { parts, unsupported, imageCount, droppedImages }
}

// 卡片 JSON2.0 静态图片卡（独立卡，绝不插入正在流式的卡）：
// img 组件官方契约 {tag:'img', img_key, alt:{tag:'plain_text', content}}（alt 必填可空串）。
// caption 用安全 plain_text div（**禁 Markdown**：卡片 markdown 支持 ![x](img_key) 图片
// 扩展，原样透传会形成“模型文本即可外发任意 key”的旁路，契约 M3 禁止）。
export function buildLarkImageCard(imageKey, caption) {
  const elements = [{
    tag: 'img',
    img_key: String(imageKey),
    alt: { tag: 'plain_text', content: '' },
  }]
  if (typeof caption === 'string' && caption.trim()) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: caption } })
  }
  return { schema: '2.0', body: { elements } }
}

// text 模式：msg_type=image。
export function buildLarkImageMessage(imageKey) {
  return { msg_type: 'image', content: JSON.stringify({ image_key: String(imageKey) }) }
}

// 发送 uuid：同一次业务（sessionId+callId）重试稳定；不同调用天然不同（M1：callId 必填）。
// 官方保证相同 uuid 1 小时内至多成功发送一条 → 安全重试窗口见 sendImage。
export function deriveLarkImageSendUuid(sessionId, toolCallId, index) {
  const digest = createHash('sha256')
    .update(String(sessionId))
    .update('\n')
    .update(String(toolCallId))
    .update('\n')
    .update(String(index))
    .digest('hex')
  return 'lki_' + digest.slice(0, 46) // ≤50 字符
}

// R4/W9：同 callId 绑定非正文摘要（版本化元组，只存 hash 不存原图/附言）：
// digest = sha256(JSON.stringify(['dsh-lark-send/v1', sha256hex(bytes), mode,
//                                  sha256hex(caption ''), sha256hex(conversation)]))
// 目标（conversation）入元组；generation 不入（跨 reload 同业务同 uuid 必须同 digest）。
// 发送 digest（R4）：**唯一来源**为 lib/lark-dedup.js 的 larkSendDigest
// （同源实现，禁止本地再实现）：JSON 元组 sha256，绑定规范图字节 SHA/mode/
// caption/appId/conversation；同 uuid 换任一要素 → begin 返回 conflict。

// refs 与图片部件数量必须严格一致：不足=admission 失败，绝不静默丢图（M6）。
export class LarkImageRefsMismatchError extends Error {
  constructor(imageCount, refCount) {
    super(`lark image: admission returned ${refCount} refs for ${imageCount} image parts`)
    this.name = 'LarkImageRefsMismatchError'
    this.code = 'IMAGE_ADMISSION_REFS_MISMATCH'
    this.imageCount = imageCount
    this.refCount = refCount
  }
}

async function raceWithSignal(promise, { timeoutMs, signal, label }, onAbort) {
  let timer = null
  let onSignal = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('lark image ' + label + ' timed out')
      error.larkImageTimeout = true
      if (typeof onAbort === 'function') onAbort()
      reject(error)
    }, timeoutMs)
    if (signal) {
      onSignal = () => {
        const error = new Error('lark image ' + label + ' aborted')
        error.larkImageAborted = true
        if (typeof onAbort === 'function') onAbort()
        reject(error)
      }
      if (signal.aborted) onSignal()
      else signal.addEventListener('abort', onSignal, { once: true })
    }
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (signal && onSignal) signal.removeEventListener('abort', onSignal)
  }
}

// ── 工厂：宿主 seam 全注入 ─────────────────────────────────────────────────────
export function createLarkImageHost(deps = {}) {
  const attachments = deps.attachments || null
  const hostLimits = attachments && attachments.imageLimits ? attachments.imageLimits : null
  const maxDownloadBytes = Number.isFinite(deps.maxDownloadBytes)
    ? deps.maxDownloadBytes
    : Math.min(hostLimits && hostLimits.maxImageBytes ? hostLimits.maxImageBytes : LARK_DOWNLOAD_MAX_BYTES, LARK_DOWNLOAD_MAX_BYTES)
  const maxUploadBytes = Number.isFinite(deps.maxUploadBytes) ? deps.maxUploadBytes : LARK_UPLOAD_MAX_BYTES
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 60000
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const admitChains = new WeakMap() // 同一 agent 的 admission 串行
  const client = () => (typeof deps.makeClient === 'function' ? deps.makeClient() : null)

  // N3：派发前强制**有界真实 transport**——httpInstance.defaults.timeout 必须为正且
  // 早于模块 deadline 并留出余量；不满足一律不派发（unbounded_transport）。
  const boundedTransport = (c) => {
    const t = c && c.httpInstance && c.httpInstance.defaults && c.httpInstance.defaults.timeout
    if (!Number.isFinite(t) || t <= 0) return false
    return t + LARK_TRANSPORT_MARGIN_MS <= timeoutMs
  }

  // 入站下载（B1/B2/B6）：path/params 真实形状；getReadableStream；真实 destroy。
  async function downloadMessageImage({ messageId, fileKey, signal }) {
    if (typeof messageId !== 'string' || !messageId || typeof fileKey !== 'string' || !IMAGE_KEY_RE.test(fileKey)) {
      return { ok: false, category: 'permanent', reason: 'invalid_reference' }
    }
    const c = client()
    if (!c) return { ok: false, category: 'unavailable', reason: 'no_client' }
    let res
    try {
      res = await raceWithSignal(
        c.im.v1.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type: 'image' } }),
        { timeoutMs, signal, label: 'download' },
        () => {},
      )
    } catch (error) {
      if (error && error.larkImageTimeout) return { ok: false, category: 'transient', reason: 'timeout' }
      if (error && error.larkImageAborted) return { ok: false, category: 'transient', reason: 'aborted' }
      const classified = await classifyTransportError(error)
      if (classified.outcome === 'unknown') return { ok: false, category: 'transient', reason: 'network' } // 幂等 GET：可重试
      return { ok: false, category: classified.category, code: classified.code ?? null, reason: 'api_error' }
    }
    if (!res || typeof res.getReadableStream !== 'function') {
      return { ok: false, category: 'permanent', reason: 'no_binary_body' }
    }
    let stream
    try {
      stream = res.getReadableStream()
    } catch {
      // SDK 对非流 data 抛 "stream already consumed" 等：确定性坏返回。
      return { ok: false, category: 'permanent', reason: 'no_binary_body' }
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      return { ok: false, category: 'permanent', reason: 'no_binary_body' }
    }
    const declared = Number(res.headers && res.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxDownloadBytes) {
      return { ok: false, category: 'limit', reason: 'too_large' }
    }
    const chunks = []
    let total = 0
    let failed = null
    const deadline = now() + timeoutMs // 正文读取同样受有界超时约束（B6）
    try {
      await raceWithSignal((async () => {
        for await (const chunk of stream) {
          total += chunk.length
          if (total > maxDownloadBytes) {
            failed = { ok: false, category: 'limit', reason: 'too_large' }
            break
          }
          if (now() > deadline) {
            failed = { ok: false, category: 'transient', reason: 'timeout' }
            break
          }
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        }
      })(), { timeoutMs: Math.max(deadline - now(), 1), signal, label: 'download-body' }, () => {
        if (typeof stream.destroy === 'function') stream.destroy() // 中止/超时真实销毁，不残留读取
      })
    } catch (error) {
      if (error && (error.larkImageTimeout || error.larkImageAborted)) failed = { ok: false, category: 'transient', reason: error.larkImageTimeout ? 'timeout' : 'aborted' }
      else failed = { ok: false, category: 'transient', reason: 'network' }
    } finally {
      // 任何退出路径（超限/错误/提前中止/超时）都真实销毁流，不残留读取（B6）。
      if (typeof stream.destroy === 'function') stream.destroy()
    }
    if (failed) return failed
    const bytes = Buffer.concat(chunks, total)
    if (bytes.length === 0) return { ok: false, category: 'permanent', reason: 'empty' }
    const mediaType = sniffImageMediaType(bytes)
    if (!mediaType) return { ok: false, category: 'unsupported', reason: 'format' }
    return { ok: true, bytes, mediaType }
  }

  // 入站多模态准入（C4/B7 无关）：inputModalities 未显式含 'image' → 明确拒绝。
  async function admitImages({ agent, images }) {
    if (!attachments || typeof attachments.saveImages !== 'function') return { ok: false, reason: 'no_attachment_service' }
    if (!deps.llm || typeof deps.llm.resolveModelInfo !== 'function' || typeof deps.selectionFor !== 'function') {
      return { ok: false, reason: 'no_llm_capability_probe' }
    }
    const selection = deps.selectionFor(agent)
    if (!selection) return { ok: false, reason: 'no_model_selection' }
    let info
    try {
      info = await deps.llm.resolveModelInfo(selection.provider, selection.model)
    } catch {
      return { ok: false, reason: 'model_info_unavailable' }
    }
    if (!info || !Array.isArray(info.inputModalities) || !info.inputModalities.includes('image')) {
      return { ok: false, reason: 'model_no_image_support' }
    }
    const previous = admitChains.get(agent) || Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      const inputs = (images || []).map((image) => ({
        data: image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes),
        mediaType: image.mediaType,
        ...(image.name ? { name: image.name } : {}),
      }))
      const refs = await attachments.saveImages(inputs)
      return { ok: true, refs }
    })
    admitChains.set(agent, run.catch(() => {}))
    try {
      return await run
    } catch (error) {
      if (error && typeof error.code === 'string') return { ok: false, reason: 'admission_failed', code: error.code }
      return { ok: false, reason: 'admission_failed' }
    }
  }

  // 组装用户消息内容：图文交错保序；refs 与图片部件**必须数量一致**（M6，否则抛错）。
  function buildUserContent(orderedParts, refs) {
    const imageParts = (orderedParts || []).filter((part) => part.kind === 'image')
    const safeRefs = Array.isArray(refs) ? refs : []
    if (safeRefs.length !== imageParts.length) {
      throw new LarkImageRefsMismatchError(imageParts.length, safeRefs.length)
    }
    const content = []
    let refIndex = 0
    for (const part of orderedParts) {
      if (part.kind === 'text') content.push({ type: 'text', text: part.text })
      else if (part.kind === 'image') {
        content.push({ type: 'image', attachment: safeRefs[refIndex] })
        refIndex += 1
      }
    }
    return content
  }

  // 上传（B3/B5/B6）：真实 multipart 载荷形状；body {code,data} 判定；窗口无关。
  async function uploadImage({ bytes, mediaType, name, signal }) {
    if (!bytes || bytes.length === 0) return { ok: false, category: 'permanent', reason: 'empty' }
    if (bytes.length > maxUploadBytes) return { ok: false, category: 'limit', reason: 'too_large' }
    if (!LARK_IMAGE_MEDIA_TYPES.includes(mediaType)) return { ok: false, category: 'unsupported', reason: 'format' }
    const c = client()
    if (!c) return { ok: false, category: 'unavailable', reason: 'no_client' }
    if (!boundedTransport(c)) return { ok: false, category: 'unavailable', reason: 'unbounded_transport' }
    try {
      const res = await raceWithSignal(
        c.im.v1.image.create({ data: { image_type: 'message', image: Buffer.from(bytes) } }),
        { timeoutMs, signal, label: 'upload' },
        () => {},
      )
      const { body, value } = unwrapApiResult(res)
      if (body && Number(body.code) !== 0) {
        const classified = classifyImageApiError(body.code)
        return { ok: false, category: classified || 'permanent', code: Number(body.code), reason: 'api_error' }
      }
      const imageKey = value && value.image_key
      if (typeof imageKey !== 'string' || !imageKey) {
        // N5：坏成功响应（无 key）→ 上传可安全重传，归 transient/bad_response。
        return { ok: false, category: 'transient', reason: 'bad_response' }
      }
      return { ok: true, imageKey }
    } catch (error) {
      if (error && error.larkImageTimeout) return { ok: false, category: 'unknown', reason: 'timeout' }
      if (error && error.larkImageAborted) return { ok: false, category: 'unknown', reason: 'aborted' }
      const classified = await classifyTransportError(error)
      if (classified.outcome === 'unknown') return { ok: false, category: 'unknown', reason: 'network' }
      return { ok: false, category: classified.category, code: classified.code ?? null, reason: 'api_error' }
    }
  }

  // 发送（B4/N2/N4/N6）：{params,data} 载荷；body {code,data.message_id} 判定；
  // uuid 安全窗=**调用方持久提交的 firstDispatchAt** 起算（模块不用缓存推断首派，
  // 缺失即拒绝；所有结果回传 firstDispatchAt 供调用方持久对账）。
  // 发送（R5/W9）：直发强制 uuid + 受信 firstDispatchAt（窗口起点）+ ownerToken
  // + digest（均由工具层原子 begin 从 receipt 取得，模型无法指定）；begin/finish
  // 编排在工具层，本函数只负责一次真实派发与结果分类。缺失任一必填 → 固定拒绝。
  async function sendImage({ conversation, interactiveCard, imageKey, caption, uuid, digest, firstDispatchAt, ownerToken, signal }) {
    const c = client()
    if (!c) return { ok: false, category: 'unavailable', reason: 'no_client' }
    if (!boundedTransport(c)) return { ok: false, category: 'unavailable', reason: 'unbounded_transport' }
    const target = String(conversation || '').replace(/^lark:/, '')
    if (!target) return { ok: false, category: 'permanent', reason: 'no_conversation' }
    if (typeof uuid !== 'string' || !uuid) return { ok: false, category: 'permanent', reason: 'uuid_required' }
    if (!Number.isFinite(firstDispatchAt)) {
      // N4：窗口起点必须是 receipt 持久提交的首次派发时间；缺失=fail-closed，不自行重置。
      return { ok: false, category: 'unavailable', reason: 'first_dispatch_at_missing', failed: true }
    }
    const retrySafeUntil = firstDispatchAt + LARK_UUID_RETRY_WINDOW_MS
    if (now() > retrySafeUntil) {
      // N6：过期=unknown 且 uuidRetrySafe:false（不降 failed、不暗示未发出）。
      return {
        ok: false,
        category: 'window_expired',
        reason: 'uuid_window_expired',
        unknown: true,
        uuidRetrySafe: false,
        retrySafeUntil,
        firstDispatchAt,
      }
    }
    if (typeof ownerToken !== 'string' || !ownerToken) {
      return { ok: false, category: 'permanent', reason: 'owner_token_required' }
    }
    if (typeof digest !== 'string' || !digest) return { ok: false, category: 'permanent', reason: 'digest_required' }
    const payload = interactiveCard
      ? { msg_type: 'interactive', content: JSON.stringify(buildLarkImageCard(imageKey, caption)) }
      : buildLarkImageMessage(imageKey)
    try {
      const res = await raceWithSignal(
        c.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: target,
            msg_type: payload.msg_type,
            content: payload.content,
            ...(uuid ? { uuid } : {}),
          },
        }),
        { timeoutMs, signal, label: 'send' },
        () => {},
      )
      const { body, value } = unwrapApiResult(res)
      if (body && Number(body.code) !== 0) {
        const classified = classifyImageApiError(body.code)
        return { ok: false, category: classified || 'permanent', code: Number(body.code), reason: 'api_error', retrySafeUntil, firstDispatchAt: firstDispatchAt ?? null }
      }
      const messageId = value && value.message_id
      if (typeof messageId !== 'string' || !messageId) {
        // HTTP/业务成功但缺必要形状 → 不假成功。
        return { ok: false, category: 'permanent', reason: 'no_message_id', retrySafeUntil, firstDispatchAt: firstDispatchAt ?? null }
      }
      return { ok: true, mode: interactiveCard ? 'card' : 'image', messageId, retrySafeUntil, firstDispatchAt: firstDispatchAt ?? null }
    } catch (error) {
      // N2：超时/中止/无响应/5xx/429 → unknown（可能已送达），带原 uuid 的可信安全窗；
      // 模块放弃等待不等于底层已中止，不向模型暗示已撤销。
      const aborted = Boolean(error && (error.larkImageTimeout || error.larkImageAborted))
      const classified = aborted ? { outcome: 'unknown' } : await classifyTransportError(error, { sendSafe: true })
      if (classified.outcome === 'unknown') {
        return {
          ok: false,
          category: 'unknown',
          reason: error && error.larkImageTimeout ? 'timeout' : error && error.larkImageAborted ? 'aborted' : 'network',
          unknown: true,
          uuidRetrySafe: typeof uuid === 'string' && Boolean(uuid),
          retrySafeUntil,
          firstDispatchAt: firstDispatchAt ?? null,
        }
      }
      return { ok: false, category: classified.category, code: classified.code ?? null, reason: 'api_error', retrySafeUntil, firstDispatchAt: firstDispatchAt ?? null }
    }
  }

  // 工作区文件：只经宿主执行世界 fs seam（resolve+stat regular file+边界），非 node:fs。
  async function resolveWorkspaceImage({ filePath, cwd, signal, exec }) {
    if (typeof deps.resolveFileTarget !== 'function' || typeof deps.readFileBytes !== 'function') {
      return { ok: false, category: 'unavailable', reason: 'no_fs_seam' }
    }
    let resolved
    try {
      resolved = await deps.resolveFileTarget(String(filePath || ''), { cwd, signal, exec })
    } catch {
      return { ok: false, category: 'permanent', reason: 'resolve_failed' }
    }
    if (!resolved || !resolved.target) return { ok: false, category: 'permanent', reason: 'resolve_failed' }
    let bytes
    try {
      bytes = await deps.readFileBytes(resolved.target, { maxBytes: maxUploadBytes, ...(signal ? { signal } : {}) })
    } catch {
      return { ok: false, category: 'permanent', reason: 'read_failed' }
    }
    if (!bytes || bytes.length === 0) return { ok: false, category: 'permanent', reason: 'empty' }
    const mediaType = sniffImageMediaType(bytes)
    if (!mediaType) return { ok: false, category: 'unsupported', reason: 'format' }
    const name = String(resolved.displayPath || '').split('/').pop() || undefined
    return { ok: true, bytes, mediaType, name }
  }

  async function authorizeAttachmentRef(sessionId, attachmentId) {
    if (typeof deps.isAttachmentReferenced !== 'function' || typeof deps.readAttachmentBytes !== 'function') {
      return { ok: false, category: 'permanent', reason: 'no_attachment_authz' }
    }
    let referenced = false
    try {
      referenced = await deps.isAttachmentReferenced(sessionId, attachmentId)
    } catch {
      referenced = false
    }
    if (referenced !== true) return { ok: false, category: 'permanent', reason: 'not_referenced_by_session' }
    let bytes
    try {
      bytes = await deps.readAttachmentBytes(attachmentId)
    } catch (error) {
      if (error && typeof error.code === 'string') return { ok: false, category: 'permanent', reason: 'attachment_read_failed', code: error.code }
      return { ok: false, category: 'transient', reason: 'attachment_read_failed' }
    }
    if (!bytes || bytes.length === 0) return { ok: false, category: 'permanent', reason: 'empty' }
    const mediaType = sniffImageMediaType(bytes)
    if (!mediaType) return { ok: false, category: 'unsupported', reason: 'format' }
    return { ok: true, bytes, mediaType }
  }

  // 显式出站工具（B7：output {schema, render} 满足宿主 ToolRuntime.register 契约）。
  const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      mode: { type: 'string' },
      messageId: { type: 'string' },
      refused: { type: 'boolean' },
      reason: { type: 'string' },
      category: { type: 'string' },
      code: { type: 'integer' },
      errorCode: { type: 'string' },
      failed: { type: 'boolean' },
      unknown: { type: 'boolean' },
      uuidRetrySafe: { type: 'boolean' },
      retrySafeUntil: { type: 'integer' },
      firstDispatchAt: { type: 'integer' },
      replayed: { type: 'boolean' },
      // F1：固定存储故障标记（仅 receipt finish 失败时出现；不透传原异常）。
      receiptError: { type: 'string', enum: ['receipt_unavailable'] },
      parameter: { type: 'string' },
    },
    required: ['ok'],
  }
  const REASON_LABELS = new Set([
    'no_session_binding', 'not_bound_to_lark', 'forbidden_parameter', 'no_image_source', 'single_source_required',
    'not_referenced_by_session', 'no_attachment_authz', 'missing_call_id', 'resolve_failed', 'read_failed',
    'empty', 'format', 'too_large', 'attachment_validation_failed', 'no_client', 'no_conversation',
    'no_image_key', 'no_message_id', 'bad_response', 'api_error', 'timeout', 'aborted', 'network',
    'uuid_window_expired', 'unknown', 'unavailable', 'attachment_read_failed',
    'first_dispatch_at_missing', 'receipt_persist_failed', 'unbounded_transport',
    'attachment_validation_unavailable', 'no_receipt_seam', 'receipt_unavailable',
    'receipt_conflict', 'receipt_in_progress', 'uuid_required', 'owner_token_required',
    'digest_required', 'image_source_invalid', 'no_app_id',
    // ledger 发送终态固定枚举（LARK_SEND_REASONS）也进显示白名单：
    'invalid_image', 'oversized', 'upload_rejected', 'scope_missing', 'target_gone',
    'platform_error', 'interrupted',
  ])
  // N1b：code（integer，平台数值）与 errorCode（string，宿主字符串码）分域，
  // 避免违反自身 schema（真实 ToolRuntime 会报 INVALID_TOOL_OUTPUT）。
  function platformCodeFields(code) {
    if (Number.isInteger(code)) return { code }
    if (typeof code === 'string' && code) return { errorCode: sanitizeAttachmentErrorCode(code) }
    return {}
  }
  // E：白名单 telemetry seam（status 图片操作桶真实证据）——字段仅
  // operation/event/布尔/数值；无 body/ID/key/token；遥测异常绝不破坏业务。
  function emitTelemetry(deps, operation, event, detail) {
    try {
      const t = deps && deps.telemetry
      if (!t || typeof t.operation !== 'function') return
      t.operation({
        operation, // 'image_download' | 'image_upload' | 'image_send'
        event, // 'attempt' | 'result'
        ok: Boolean(detail && detail.ok),
        httpStatus: detail && Number.isInteger(detail.httpStatus) ? detail.httpStatus : null,
        apiCode: detail && Number.isInteger(detail.apiCode) ? detail.apiCode : null,
        unknown: Boolean(detail && detail.unknown),
      })
    } catch { /* 遥测异常绝不破坏业务 */ }
  }
  // ── R1/Lead：finish 固定枚举映射（自由串/未知原始 code 绝不入账本）────────
  // 平台已知、可第一手确认的少量码；未列入者一律保守归 platform_error。
  const LARK_SCOPE_MISSING_CODES = new Set([230031]) // 无权限（官方 im 错误码）
  const LARK_TARGET_GONE_CODES = new Set([230002]) // 不在会话/会话已失效
  function sendReasonOf(result) {
    const r = result && result.reason
    if (r === 'aborted') return 'interrupted'
    if (r === 'too_large') return 'oversized'
    if (r === 'format' || r === 'unsupported' || r === 'attachment_validation_failed') return 'invalid_image'
    if (r === 'api_error') {
      const code = Number(result && result.code)
      if (LARK_SCOPE_MISSING_CODES.has(code)) return 'scope_missing'
      if (LARK_TARGET_GONE_CODES.has(code)) return 'target_gone'
      return 'platform_error' // 未知原始 code → 默认枚举，绝不塞原值
    }
    return 'platform_error' // timeout/network/no_message_id/bad_response/… 同枚举
  }
  // 上传/发送结果 → finish 终态：平台状态不可证（超时/无响应/中止/无 id）
  // → unknown；其余（确定拒绝）→ rejected。reason 固定属 LARK_SEND_REASONS。
  function sendFinishPlan(result) {
    const uncertain = result.unknown === true
      || result.reason === 'aborted'
      || result.reason === 'no_message_id'
      || result.reason === 'timeout'
      || result.reason === 'network'
    return { state: uncertain ? 'unknown' : 'rejected', reason: sendReasonOf(result) }
  }
  // 账本 finish 返回 publicSend 对象；旧 mock 返回 true——两者均接受，按目标 state 校验。
  function finishOk(fin, wantState) {
    if (fin === true) return true
    return Boolean(fin && typeof fin === 'object' && fin.state === wantState)
  }
  function sendReasonDisplay(reason) {
    return typeof reason === 'string' && LARK_SEND_REASONS.includes(reason) ? reason : 'unknown'
  }
  function sendCategoryOf(reason) {
    return reason === 'oversized' ? 'limit' : 'permanent'
  }
  function receiptPersistFailed(firstDispatchAt) {
    // Lead/F1：finish 失败 → 保持 unknown（平台也许成功）+ 固定 receiptError
    // + uuidRetrySafe=false（存储故障期间不得重试）；原窗口保留供核对。
    return {
      ok: false, unknown: true, failed: false,
      reason: 'receipt_persist_failed', category: 'unavailable',
      receiptError: 'receipt_unavailable',
      uuidRetrySafe: false,
      retrySafeUntil: firstDispatchAt + LARK_UUID_RETRY_WINDOW_MS,
      firstDispatchAt,
    }
  }
  function makeSendImageTool() {
    return {
      name: 'lark_send_image',
      description:
        'Send an image into the Feishu (Lark) chat bound to the CURRENT session. '
        + 'Only works inside a session bound to Feishu; other sessions receive a structured refusal. '
        + 'Name exactly one image per call: a session-referenced attachment_id and/or a workspace file_path. '
        + 'Images produced by other tools are NEVER sent unless named here. No chat/receive ids or URLs.',
      parameters: {
        type: 'object',
        properties: {
          attachment_id: { type: 'string', description: 'Durable attachment id already referenced by this session.' },
          file_path: { type: 'string', description: 'Workspace image file (PNG/JPEG/WebP/GIF), read with session filesystem permissions.' },
          caption: { type: 'string', description: 'Optional short caption shown as plain text next to the image card (card mode only).' },
        },
        // Neither alternative is individually required. The host subset forbids
        // type + oneOf at the root; execute enforces exactly one nonempty source.
        required: [],
        additionalProperties: false,
      },
      // 宿主 ToolRuntime.register 必需（B7/N1）：schema 固定 + render 返回
      // ContentBlock[]（[{type:'text',text}]——字符串会让 DeepSeek adapter 的
      // input(blocks) flatMap 在下一次请求抛 TypeError）。unknown 分支明确告知
      // “不要用新工具调用重发”（N2：新 callId→新 uuid→平台不去重→重复发送）。
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => {
          // F1/U1：固定本地提示（不透传原异常；仅白名单 reason/code）。
          const storageLine = ' (storage error: receipt_unavailable — plugin storage is not accepting receipt writes; check channel status and resolve storage before any retry)'
          if (value && value.ok === true) {
            const text = value.mode === 'card' ? 'Image sent (interactive card).' : 'Image sent (image message).'
            return [{ type: 'text', text }]
          }
          if (value && value.unknown === true) {
            return [{ type: 'text', text: 'Image delivery status UNKNOWN (may or may not have been sent): ' + (typeof value.reason === 'string' && REASON_LABELS.has(value.reason) ? value.reason : 'unknown') + '. Verify in the chat before any retry, and do NOT retry with a new tool call or new request.' + (value.receiptError === 'receipt_unavailable' ? storageLine : '') }]
          }
          const reason = value && typeof value.reason === 'string' && REASON_LABELS.has(value.reason) ? value.reason : 'unknown'
          const code = value && Number.isInteger(value.code) ? ' (code ' + value.code + ')' : value && typeof value.errorCode === 'string' && sanitizeAttachmentErrorCode(value.errorCode) !== 'other' ? ' (' + sanitizeAttachmentErrorCode(value.errorCode) + ')' : ''
          // U1：failed = 确定未发送（含 upload 阶段失败）→ 固定提示可安全新请求；
          // m1：有 receiptError（存储故障）时**取消**安全新请求提示，只提示先解决存储；
          // 绝不提示去查一条未发送的消息。
          const storageOnly = value.receiptError === 'receipt_unavailable'
          const safeHint = storageOnly ? '' : '. No message was sent; a new request is safe to try.'
          const storageTail = storageOnly ? storageLine : ''
          return [{ type: 'text', text: 'Image not sent: ' + reason + code + safeHint + storageTail }]
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const refuse = (reason, extra) => ({ ok: false, refused: true, reason, ...(extra || {}) })
        for (const forbidden of ['chat_id', 'receive_id', 'receive_id_type', 'url', 'directory', 'glob']) {
          if (args && args[forbidden] !== undefined) return refuse('forbidden_parameter', { parameter: forbidden })
        }
        if (args && Object.keys(args).some((key) => !['attachment_id', 'file_path', 'caption'].includes(key))) {
          return refuse('forbidden_parameter')
        }
        // M1：callId 必填（宿主 ToolExecutionInput 契约），缺失/非法即拒绝，绝不回退常量。
        const callId = exec && typeof exec.callId === 'string' && exec.callId ? exec.callId : null
        if (!callId) return refuse('missing_call_id')
        const agent = exec && exec.agent
        const sessionId = agent && agent.session && typeof agent.session.id === 'string' && agent.session.id ? agent.session.id : null
        if (!sessionId) return refuse('no_session_binding')
        const binding = typeof deps.resolveBinding === 'function' ? deps.resolveBinding(sessionId, agent) : null
        if (!binding || binding.channel !== 'lark' || binding.alive !== true || !binding.conversation) {
          return refuse('not_bound_to_lark') // 未绑定/失效 generation：结构化拒绝，不猜目标
        }
        const hasAttachment = typeof (args && args.attachment_id) === 'string' && Boolean(args.attachment_id)
        const hasPath = typeof (args && args.file_path) === 'string' && Boolean(args.file_path)
        if (!hasAttachment && !hasPath) return refuse('no_image_source')
        if (hasAttachment && hasPath) return refuse('single_source_required')
        // W8：用户素材必须经宿主权威解码校验——缺 validateImage seam 一律拒绝，
        // 不把签名 sniff 当“已验图”。
        if (!attachments || typeof attachments.validateImage !== 'function') {
          return refuse('attachment_validation_unavailable', { category: 'unavailable' })
        }
        const caption = typeof (args && args.caption) === 'string' ? args.caption.slice(0, 2000) : undefined
        const signal = exec && exec.signal ? exec.signal : undefined
        let source
        if (hasAttachment) {
          source = await authorizeAttachmentRef(sessionId, String(args.attachment_id))
        } else {
          const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
          source = await resolveWorkspaceImage({ filePath: String(args.file_path), cwd, signal, exec })
        }
        if (!source.ok) {
          return refuse(source.reason, { category: source.category, ...platformCodeFields(source.code) })
        }
        if (source.bytes.length > maxUploadBytes) return refuse('too_large', { category: 'limit' })
        try {
          await attachments.validateImage({ data: source.bytes, mediaType: source.mediaType, ...(source.name ? { name: source.name } : {}) })
        } catch (error) {
          return refuse('attachment_validation_failed', {
            category: 'permanent',
            ...platformCodeFields(error && typeof error.code === 'string' ? error.code : undefined),
          })
        }
        const uuid = deriveLarkImageSendUuid(sessionId, callId, 0)
        const mode = binding.interactiveCard === true ? 'card' : 'image'
        // R4/Lead：digest＝ledger 同源 larkSendDigest（含 appId/conversation 目标绑定）。
        // appId 缺失＝接线未就绪 → fail-closed（绝不省略目标身份）。
        const appId = (binding && typeof binding.appId === 'string' && binding.appId)
          ? binding.appId
          : (typeof deps.appId === 'string' && deps.appId ? deps.appId : null)
        if (!appId) return refuse('no_app_id', { category: 'unavailable' })
        const imageSha256 = createHash('sha256').update(source.bytes).digest('hex')
        const digest = larkSendDigest({ imageSha256, mode, caption, appId, conversation: binding.conversation })
        // W9/R1/R2/Lead：原子 begin（真实 store.sendReceipts 契约 {outcome,record}）在
        // 任何网络派发（含上传）之前；只有 begin 决定首次；异常一律 fail-closed。
        if (!deps.receipts || typeof deps.receipts.begin !== 'function' || typeof deps.receipts.finish !== 'function') {
          return refuse('no_receipt_seam', { category: 'unavailable' })
        }
        let begun = null
        try {
          begun = await deps.receipts.begin({ uuid, digest, now: now() })
        } catch {
          begun = null // 任一 throw（invalid_key/at_capacity/store_poisoned/lock_*…）→ fail-closed
        }
        const outcome = begun && typeof begun.outcome === 'string' ? begun.outcome : null
        const rec = begun && begun.record && typeof begun.record === 'object' ? begun.record : null
        if (!outcome || !rec) return refuse('receipt_unavailable', { category: 'unavailable' })
        if (outcome === 'sent') {
          // 零重发送回“已发送”；账本记录内 messageId 仅内部，不进模型/诊断。
          const heldAt = Number(rec.firstDispatchAt)
          return { ok: true, mode, replayed: true, ...(Number.isFinite(heldAt) ? { firstDispatchAt: heldAt, retrySafeUntil: heldAt + LARK_UUID_RETRY_WINDOW_MS } : {}) }
        }
        if (outcome === 'rejected') {
          // 终态重放：固定 reason 枚举；零重发。
          return { ok: false, failed: true, unknown: false, reason: sendReasonDisplay(rec.reason), category: sendCategoryOf(rec.reason), replayed: true }
        }
        if (outcome === 'conflict') return refuse('receipt_conflict')
        if (outcome === 'in_progress') {
          // m2：工具层无任何 unknown 重试入口 → uuidRetrySafe 恒 false（内部平台
          // uuid 事实不混为工具能力）。
          return { ok: false, unknown: true, failed: false, reason: 'receipt_in_progress', category: 'unavailable', uuidRetrySafe: false }
        }
        if (outcome === 'unknown') {
          // 冷遗留/不可证：不自动重派（Lead）；只给核对提示 + 原首派窗口；坏值 fail-closed。
          const heldAt = Number(rec.firstDispatchAt)
          if (!Number.isFinite(heldAt)) return refuse('receipt_unavailable', { category: 'unavailable' })
          const expired = now() > heldAt + LARK_UUID_RETRY_WINDOW_MS
          return {
            ok: false, unknown: true, failed: false,
            reason: expired ? 'uuid_window_expired' : sendReasonDisplay(rec.reason),
            category: expired ? 'window_expired' : 'unknown',
            uuidRetrySafe: false, // m2：无工具重试入口（窗口事实仅内部）
            retrySafeUntil: heldAt + LARK_UUID_RETRY_WINDOW_MS,
            firstDispatchAt: heldAt,
          }
        }
        if (outcome !== 'acquired') return refuse('receipt_unavailable', { category: 'unavailable' })
        const firstDispatchAt = Number(rec.firstDispatchAt)
        const ownerToken = typeof rec.ownerToken === 'string' ? rec.ownerToken : ''
        if (!Number.isFinite(firstDispatchAt) || !ownerToken) return refuse('receipt_unavailable', { category: 'unavailable' })
        emitTelemetry(deps, 'image_upload', 'attempt', {})
        const uploaded = await uploadImage({ bytes: source.bytes, mediaType: source.mediaType, name: source.name, signal })
        emitTelemetry(deps, 'image_upload', 'result', {
          ok: uploaded.ok === true,
          httpStatus: Number.isInteger(uploaded.status) ? uploaded.status : null,
          apiCode: Number.isInteger(uploaded.code) ? uploaded.code : null,
          unknown: uploaded.unknown === true,
        })
        if (!uploaded.ok) {
          // U1：upload 失败时 message.create 尚未发生 → 输出明确 failed/未发送
          //（孤儿 image key ≠ 消息未知）；receipt 固定 rejected + upload_rejected。
          // 局部失败 + finish 再失败 → F1 标记（receiptError + uuidRetrySafe=false）。
          let upPersisted = true
          try { upPersisted = finishOk(await deps.receipts.finish({ uuid, ownerToken, state: 'rejected', reason: 'upload_rejected' }), 'rejected') } catch { upPersisted = false }
          const out = { ok: false, failed: true, unknown: false, reason: uploaded.reason, category: uploaded.category === 'unknown' ? 'transient' : uploaded.category, ...platformCodeFields(uploaded.code) }
          if (!upPersisted) { out.receiptError = 'receipt_unavailable'; out.uuidRetrySafe = false }
          return out
        }
        emitTelemetry(deps, 'image_send', 'attempt', {})
        const sent = await sendImage({
          conversation: binding.conversation,
          interactiveCard: binding.interactiveCard === true,
          imageKey: uploaded.imageKey,
          caption,
          uuid,
          digest,
          firstDispatchAt,
          ownerToken,
          signal,
        })
        emitTelemetry(deps, 'image_send', 'result', {
          ok: sent.ok === true,
          httpStatus: Number.isInteger(sent.status) ? sent.status : null,
          apiCode: Number.isInteger(sent.code) ? sent.code : null,
          unknown: sent.unknown === true,
        })
        // R1/Lead：终态先落 receipt（finish 固定枚举）再对外确认；平台成功但
        // finish 写失败 → 只报 unknown（不假成功）；绝不因此再发送。
        if (sent.ok) {
          let sentPersisted = false
          try { sentPersisted = finishOk(await deps.receipts.finish({ uuid, ownerToken, state: 'sent', messageId: sent.messageId }), 'sent') } catch { sentPersisted = false }
          if (!sentPersisted) return receiptPersistFailed(firstDispatchAt)
          return { ok: true, mode: sent.mode, messageId: sent.messageId, replayed: false, firstDispatchAt, retrySafeUntil: firstDispatchAt + LARK_UUID_RETRY_WINDOW_MS }
        }
        const plan = sendFinishPlan(sent)
        if (plan.state === 'unknown') {
          let unkPersisted = false
          try { unkPersisted = finishOk(await deps.receipts.finish({ uuid, ownerToken, state: 'unknown', reason: plan.reason }), 'unknown') } catch { unkPersisted = false }
          if (!unkPersisted) return receiptPersistFailed(firstDispatchAt)
          return {
            ok: false, unknown: true, failed: false,
            reason: sent.reason, category: sent.category,
            ...platformCodeFields(sent.code),
            uuidRetrySafe: false, // m2：工具层不提供 unknown 重试入口（内部 uuid 事实≠工具能力）
            ...(typeof sent.retrySafeUntil === 'number' ? { retrySafeUntil: sent.retrySafeUntil } : {}),
            firstDispatchAt,
          }
        }
        // 确定拒绝：证据优先返回（failed + 数值 code，不伪造投递不确定）；finish
        // 失败必须暴露存储故障（F1：固定 receiptError + uuidRetrySafe=false）；
        // 记录保持 dispatching → 后续 begin 零自动重发。
        let rejPersisted = true
        try { rejPersisted = finishOk(await deps.receipts.finish({ uuid, ownerToken, state: 'rejected', reason: plan.reason }), 'rejected') } catch { rejPersisted = false }
        return { ok: false, failed: true, unknown: false, reason: sent.reason, category: sent.category, ...platformCodeFields(sent.code), ...(typeof sent.retrySafeUntil === 'number' ? { retrySafeUntil: sent.retrySafeUntil } : {}), ...(!rejPersisted ? { receiptError: 'receipt_unavailable', uuidRetrySafe: false } : {}) }
      },
    }
  }

  return {
    // E：入站下载同样走 telemetry（attempt/result 成对；异常不破坏业务）。
    downloadMessageImage: async (...args) => {
      emitTelemetry(deps, 'image_download', 'attempt', {})
      let out
      try {
        out = await downloadMessageImage(...args)
      } catch (error) {
        emitTelemetry(deps, 'image_download', 'result', { ok: false, unknown: true })
        throw error
      }
      emitTelemetry(deps, 'image_download', 'result', {
        ok: out && out.ok === true,
        httpStatus: out && Number.isInteger(out.status) ? out.status : null,
        apiCode: out && Number.isInteger(out.code) ? out.code : null,
        unknown: Boolean(out && out.unknown),
      })
      return out
    },
    admitImages,
    buildUserContent,
    // R5 最小收口：sendImage/uploadImage 不再导出——一切出站必须经
    // makeSendImageTool（受 receipt 流程：begin/finish）；生产无法伪 owner 绕过。
    // 入站所需 download 保留；其余无关 API 不动。
    resolveWorkspaceImage,
    authorizeAttachmentRef,
    makeSendImageTool,
    limits: { maxDownloadBytes, maxUploadBytes, timeoutMs },
  }
}
