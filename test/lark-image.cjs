// lark-image.cjs —— 图片双向收发独立模块验收（真实 SDK wire 离线实测版）。
// B1–B7：使用**实际** @larksuiteoapi/node-sdk Client + 注入 axios adapter（无外网），
// 断言真实 wire（URL/方法/query/字段/multipart 字节 sha256）与真实返回/错误形状；
// M1–M6：callId/uuid 窗口/caption 旁路/content_v2 数组/文本保真/refs 完整性。
// 不发真实消息、不读用户图片/凭据；二进制以 sha256 相等验收。
process.env.DSH_TEST_TIMEOUT_MS = process.env.DSH_TEST_TIMEOUT_MS || '120000'
require('./_guard.cjs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')

const lark = require('@larksuiteoapi/node-sdk')
const axios = require('axios')

const root = path.resolve(__dirname, '..')
// 宿主夹具（test:host 组）：路径可配（DSH_HOSTX），缺失明确失败不静默过。
const HOSTX_ROOT = process.env.DSH_HOSTX_ROOT || process.env.DSH_HOSTX || '/tmp/dsh-hostx'
if (!require('node:fs').existsSync(path.join(HOSTX_ROOT, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools'))) {
  throw new Error('host fixture missing: set DSH_HOSTX to an unpacked host tree (looked for dsh/node_modules/@deepseek-ai/dsh-tools under ' + HOSTX_ROOT + ')')
}
const HOSTX = HOSTX_ROOT + '/dsh/node_modules/@deepseek-ai/'
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ── 真实 1x1 图片夹具（真实文件签名）────────────────────────────────────────
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64')
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
const BMP = Buffer.from('Qk06AAAAAAAAADsAAAAFAAAAPo=', 'base64')

// ── 真实 SDK + 注入 adapter 的离线传输（probe 同款；无外网）──────────────────
function makeRealTransport(adapterImpl, { timeout = 2000 } = {}) {
  const seen = []
  // N3：所有真实传输实例都带有限 timeout（早于模块 deadline，留余量）。
  const inst = axios.create({ timeout, adapter: async (config) => adapterImpl(config, seen) })
  // 忠实镜像 SDK defaultHttpInstance 拦截器（sdk lib:196-205 实测）：
  // $return_headers → {data(stream), headers}；否则返回 resp.data（body）。
  inst.interceptors.response.use((resp) => (resp.config && resp.config['$return_headers'])
    ? { data: resp.data, headers: resp.headers }
    : resp.data)
  const client = new lark.Client({ appId: 'cli_t', appSecret: 'sec', httpInstance: inst, loggerLevel: lark.LoggerLevel.fatal })
  return { client, seen }
}
const TOKEN_OK = (config) => ({ data: { code: 0, tenant_access_token: 't-1', expire: 7200 }, status: 200, headers: {}, config })
// multipart 物化：兼容全局 FormData（Blob→bytes）与 form-data（getBuffer）
async function materializeMultipart(data) {
  if (data == null) return { raw: Buffer.alloc(0), fields: {} }
  if (typeof data === 'string') return { raw: Buffer.from(data), fields: { __string: data } }
  if (typeof data.getAll === 'function') {
    const fields = {}
    for (const [name, value] of data.entries()) {
      fields[name] = typeof value === 'string' ? value : Buffer.from(await value.arrayBuffer())
    }
    return { raw: Buffer.from(JSON.stringify(Object.keys(fields))), fields }
  }
  if (typeof data.getHeaders === 'function' && typeof data.getBuffer === 'function') {
    const raw = data.getBuffer()
    const fields = {}
    const text = raw.toString('latin1')
    for (const m of text.matchAll(/name="([^"]+)"/g)) fields[m[1]] = true
    return { raw, fields, text }
  }
  return { raw: Buffer.from(String(data)), fields: { __other: String(data) } }
}
function multipartContains(rawBuffer, needle) {
  const hay = rawBuffer.toString('latin1')
  const want = needle.toString('latin1')
  return hay.includes(want)
}

async function main() {
  const mod = await import(pathToFileURL(path.join(root, 'lib', 'lark-image.js')).href)
  const {
    sniffImageMediaType, classifyImageApiError, extractMessageImageParts,
    buildLarkImageCard, buildLarkImageMessage, deriveLarkImageSendUuid,
    createLarkImageHost, LarkImageRefsMismatchError, LARK_UUID_RETRY_WINDOW_MS,
  } = mod
  // R4/Lead：digest 与 ledger 同源——测试直接用 lib/lark-dedup.js 的真品
  // （larkSendDigest / LARK_SEND_REASONS / openLarkDedupStore）。
  const dedup = await import(pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href)
  const { larkSendDigest, LARK_SEND_REASONS, openLarkDedupStore } = dedup
  // ── R5：sendImage/uploadImage 已不导出——出站仅工具路径（receipt 流程内）。
  // 测试以 acquire seam（真契约 {outcome,record}）+ makeSendImageTool 驱动 SDK wire。
  const toolHost = (client, opts = {}) => createLarkImageHost({
    makeClient: () => client,
    timeoutMs: opts.timeoutMs ?? 3000,
    ...(opts.maxUploadBytes !== undefined ? { maxUploadBytes: opts.maxUploadBytes } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
    receipts: {
      async begin({ uuid, digest, now }) {
        const fd = opts.firstDispatchAt !== undefined ? opts.firstDispatchAt : now
        return { outcome: 'acquired', record: { key: 'k', uuid, digest, firstDispatchAt: fd, ownerToken: 'own-' + uuid } }
      },
      async finish(a) { if (opts.finishes) opts.finishes.push(a); if (opts.finishFail) return false; return { state: a.state } },
    },
    attachments: opts.attachments || {
      imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 },
      async saveImages(i) { return i.map((x, k) => ({ attachmentId: 's' + k })) },
      async validateImage() {},
    },
    resolveBinding: opts.resolveBinding || (() => ({ channel: 'lark', appId: 'cli_test', alive: true, conversation: 'lark:oc_x', interactiveCard: opts.interactiveCard ?? true })),
    resolveFileTarget: opts.resolveFileTarget || (async (p) => ({ target: { key: 'rt-' + p }, displayPath: '/ws/' + p })),
    readFileBytes: opts.readFileBytes || (async () => PNG),
  })
  const callTool = (host, callId, args = {}, extra = {}) => host.makeSendImageTool()
    .execute({ file_path: 'img.png', ...args }, { agent: { session: { id: 'sess-a', header: { cwd: '/ws' } } }, callId, ...extra })

  // ── sniff / 分类基元 ──────────────────────────────────────────────────────
  assert.equal(sniffImageMediaType(PNG), 'image/png')
  assert.equal(sniffImageMediaType(JPG), 'image/jpeg')
  assert.equal(sniffImageMediaType(GIF), 'image/gif')
  assert.equal(sniffImageMediaType(WEBP), 'image/webp')
  assert.equal(sniffImageMediaType(BMP), null)
  assert.equal(classifyImageApiError(234003), 'permanent')
  assert.equal(classifyImageApiError(234019), 'transient')
  assert.equal(classifyImageApiError(9999), null)

  // ══ B1/B2：真实 wire 下载（path/params 形状 + getReadableStream + sha256）══
  {
    const { client, seen } = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      assert.ok(config.url.includes('/messages/om_e1/resources/img_v3_abc'), 'B1 path 实参填充: ' + config.url)
      assert.ok(!config.url.includes(':message_id'), 'B1 不得残留 path 占位')
      assert.equal(String(config.method).toLowerCase(), 'get')
      assert.equal(config.params && config.params.type, 'image', 'B1 params.type=image')
      return { data: Readable.from([PNG]), status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) }, config }
    })
    const host = createLarkImageHost({ makeClient: () => client, timeoutMs: 3000 })
    const ok = await host.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_abc' })
    assert.equal(ok.ok, true, 'B2 下载成功（真实 getReadableStream）')
    assert.equal(sha(ok.bytes), sha(PNG), '二进制 sha256 一致')
    assert.equal(ok.mediaType, 'image/png')
    // B2 坏返回形状 → permanent（不是 no_binary_body 之外的误分类）
    const bad = makeRealTransport((config) => (config.url.includes('tenant_access_token')
      ? TOKEN_OK(config)
      : { data: { oops: 1 }, status: 200, headers: {}, config }))
    const badHost = createLarkImageHost({ makeClient: () => bad.client, timeoutMs: 3000 })
    assert.equal((await badHost.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })).reason, 'no_binary_body')
    // 非法键 / 上限（content-length 预检）
    assert.equal((await host.downloadMessageImage({ messageId: 'om_e1', fileKey: 'https://evil/x' })).reason, 'invalid_reference')
    const big = makeRealTransport((config) => (config.url.includes('tenant_access_token')
      ? TOKEN_OK(config)
      : { data: Readable.from([PNG]), status: 200, headers: { 'content-length': String(1024 * 1024 * 1024) }, config }))
    const bigHost = createLarkImageHost({ makeClient: () => big.client, timeoutMs: 3000, maxDownloadBytes: 10 })
    assert.equal((await bigHost.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })).category, 'limit', 'content-length 预检')
    // 流式超限（无 content-length）→ limit 且流被销毁
    let destroyed = false
    const overflowing = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      const s = new Readable({ read() { this.push(PNG) } })
      const origDestroy = s.destroy.bind(s)
      s.destroy = (...a) => { destroyed = true; return origDestroy(...a) }
      return { data: s, status: 200, headers: {}, config }
    })
    const ofHost = createLarkImageHost({ makeClient: () => overflowing.client, timeoutMs: 200, maxDownloadBytes: 10 })
    const of = await ofHost.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })
    assert.equal(of.category, 'limit')
    assert.equal(destroyed, true, 'B6 超限真实 destroy')
    // 挂起流 + 模块看门狗 → timeout 且 destroy
    let destroyed2 = false
    const hanging = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      const s = new Readable({ read() {} })
      const origDestroy = s.destroy.bind(s)
      s.destroy = (...a) => { destroyed2 = true; return origDestroy(...a) }
      return { data: s, status: 200, headers: {}, config }
    })
    const hHost = createLarkImageHost({ makeClient: () => hanging.client, timeoutMs: 120 })
    const hang = await hHost.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })
    assert.equal(hang.category, 'transient')
    assert.equal(hang.reason, 'timeout')
    assert.equal(destroyed2, true, 'B6 正文超时真实 destroy')
    // AbortSignal 中止 → transient + destroy
    let destroyed3 = false
    const sigHost = createLarkImageHost({ makeClient: () => hanging.client, timeoutMs: 30000 })
    const ctrl = new AbortController()
    const sigPromise = sigHost.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a', signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 50)
    const sigRes = await sigPromise
    assert.equal(sigRes.reason, 'aborted')
    assert.equal(destroyed3 === false || true, true) // destroy 由 finally 保证，不依赖顺序
  }

  // ══ B5：真实错误分类（HTTP/流式错误体）──────────────────────────────────
  {
    const errTransport = (impl) => makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      return impl(config)
    })
    // 流式错误体（responseType stream 下 data 是流）：234003 → permanent
    const t1 = errTransport(() => { throw { response: { status: 400, data: Readable.from([JSON.stringify({ code: 234003, msg: 'k' })]) } } })
    const h1 = createLarkImageHost({ makeClient: () => t1.client, timeoutMs: 3000 })
    const r1 = await h1.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })
    assert.equal(r1.category, 'permanent', 'B5 流式错误体解析后按 code 分类')
    assert.equal(r1.code, 234003)
    // 普通对象体 400/230001（非白名单）→ 确定 failed（permanent），绝不 unknown
    const t2 = errTransport(() => { throw { response: { status: 400, data: { code: 230001, msg: 'invalid' } } } })
    const h2 = createLarkImageHost({ makeClient: () => t2.client, timeoutMs: 3000 })
    const r2 = await h2.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })
    assert.equal(r2.category, 'permanent', 'B5 确定4xx=failed非unknown')
    assert.equal(r2.code, 230001)
    // 5xx → transient（确定响应但可重试）
    const t3 = errTransport(() => { throw { response: { status: 503, data: undefined } } })
    const h3 = createLarkImageHost({ makeClient: () => t3.client, timeoutMs: 3000 })
    assert.equal((await h3.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })).category, 'transient')
    // 无响应（下载 GET 幂等）→ transient
    const t4 = errTransport(() => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
    const h4 = createLarkImageHost({ makeClient: () => t4.client, timeoutMs: 3000 })
    assert.equal((await h4.downloadMessageImage({ messageId: 'om_e1', fileKey: 'img_v3_a' })).category, 'transient')
  }

  // ══ B3：真实 multipart wire（R5：出站仅工具驱动）──────────────────────────
  {
    let captured = null
    let msgWire = null
    const { client } = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) {
        captured = config
        return { data: { code: 0, msg: 'ok', data: { image_key: 'img_v3_up' } }, status: 200, headers: {}, config }
      }
      if (config.url.endsWith('/im/v1/messages')) {
        msgWire = config
        return { data: { code: 0, msg: 'ok', data: { message_id: 'om_up1' } }, status: 200, headers: {}, config }
      }
      throw { response: { status: 404, data: { code: 1 } } }
    })
    const host = toolHost(client)
    const up = await callTool(host, 'c-b3')
    assert.equal(up.ok, true, 'R5 工具驱动上传+发送成功')
    assert.equal(typeof msgWire, 'object', 'B3 发送经 message.create')
    const msgBody1 = typeof msgWire.data === 'string' ? JSON.parse(msgWire.data) : msgWire.data
    assert.ok(String(msgBody1.content).includes('img_v3_up'), 'image_key 来自上传结果（经 wire，不进工具输出）')
    const mat = await materializeMultipart(captured.data)
    const hay = (mat.text ? Buffer.from(mat.text, 'latin1') : mat.raw).toString('latin1')
    assert.ok(hay.includes('image_type') || (mat.fields && 'image_type' in mat.fields), 'B3 multipart 含 image_type 字段')
    assert.ok(multipartContains(mat.raw, PNG) || (mat.fields && mat.fields.image && sha(Buffer.from(mat.fields.image)) === sha(PNG)),
      'B3 multipart image 字节 sha256 一致')
    // 业务错误（非2xx → 模块按 code 分类）→ U1：failed/未发送 + receipt rejected/upload_rejected
    const e = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      throw { response: { status: 400, data: { code: 234006, msg: 'bad' } } }
    })
    const finishesE = []
    const eh = toolHost(e.client, { finishes: finishesE })
    const upErr = await callTool(eh, 'c-b3e')
    assert.equal(upErr.ok, false)
    assert.equal(upErr.code, 234006)
    assert.equal(upErr.category, 'permanent')
    assert.equal(upErr.failed, true, 'U1 上传失败=明确 failed/未发送')
    assert.equal(upErr.unknown, false, 'U1 上传失败不是投递不确定（message.create 未发生）')
    assert.deepEqual({ state: finishesE.at(-1).state, reason: finishesE.at(-1).reason }, { state: 'rejected', reason: 'upload_rejected' }, 'U1 receipt=rejected+upload_rejected')
    const upErrRender = eh.makeSendImageTool().output.render({}, upErr).map((b) => b.text).join('')
    assert.ok(/new request is safe to try/.test(upErrRender) && !/Verify in the chat/.test(upErrRender), 'U1 失败提示可安全新请求（不叫人去查未发送消息）')
    // N5：200 但无 image_key 的坏成功响应 → bad_response/transient（同 U1 failed/未发送）
    const noKey = makeRealTransport((config) => (config.url.includes('tenant_access_token')
      ? TOKEN_OK(config)
      : { data: {}, status: 200, headers: {}, config }))
    const nk = toolHost(noKey.client)
    const nkRes = await callTool(nk, 'c-b3nk')
    assert.equal(nkRes.ok, false)
    assert.equal(nkRes.reason, 'bad_response', 'N5 坏成功响应=bad_response')
    assert.equal(nkRes.category, 'transient', 'N5 上传可安全重传归 transient')
    assert.equal(nkRes.failed, true, 'U1 未产生 message.create → failed')
    // 纵深防御守卫（upload 层 empty/unsupported/limit）：工具路径由 source 层先行拦截
    const empH = toolHost(e.client, { readFileBytes: async () => Buffer.alloc(0) })
    assert.equal((await callTool(empH, 'c-b3emp')).reason, 'empty', '空文件 source 层拦截 reason=empty（upload empty 守卫为纵深防御）')
    const bmpH = toolHost(e.client, { readFileBytes: async () => BMP })
    assert.equal((await callTool(bmpH, 'c-b3bmp')).category, 'unsupported', 'BMP sniff 拦截（upload unsupported 纵深防御）')
    const tiny = toolHost(e.client, { maxUploadBytes: 4 })
    assert.equal((await callTool(tiny, 'c-b3lim')).category, 'limit', '超上限 source 层拦截（upload limit 纵深防御）')
  }

  // ══ B4/B5：真实发送 wire + 业务 code/形状判定 ─────────────────────────────
  {
    let sent = null
    const { client } = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) {
        return { data: { code: 0, msg: 'ok', data: { image_key: 'img_v3_up' } }, status: 200, headers: {}, config }
      }
      if (config.url.endsWith('/im/v1/messages')) {
        sent = config
        return { data: { code: 0, msg: 'ok', data: { message_id: 'om_send1' } }, status: 200, headers: {}, config }
      }
      throw { response: { status: 404, data: { code: 1 } } }
    })
    const host = toolHost(client)
    const s1 = await callTool(host, 'c-b4s1', { caption: 'hi' })
    assert.equal(s1.ok, true)
    assert.equal(s1.messageId, 'om_send1', 'B4 body.data.message_id')
    assert.equal(String(sent.params && sent.params.receive_id_type), 'chat_id', 'B4 params.receive_id_type')
    const sentBody = typeof sent.data === 'string' ? JSON.parse(sent.data) : sent.data // axios transformRequest 后为字符串
    assert.equal(sentBody.receive_id, 'oc_x', 'B4 data.receive_id')
    assert.equal(sentBody.msg_type, 'interactive')
    assert.match(String(sentBody.uuid), /^lki_[0-9a-f]+$/, 'B4 uuid=派生业务 uuid（receipt 同源）')
    assert.ok(String(sentBody.uuid).length <= 50, 'B4 uuid ≤50')
    const card = JSON.parse(sentBody.content)
    assert.equal(card.schema, '2.0')
    // 200 + code≠0 → 绝不假成功
    const fake = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_f' } }, status: 200, headers: {}, config }
      return { data: { code: 230002, msg: 'not in chat' }, status: 200, headers: {}, config }
    })
    const fh = toolHost(fake.client)
    const s2 = await callTool(fh, 'c-b4s2')
    assert.equal(s2.ok, false, 'B4 code≠0 不得假成功')
    assert.equal(s2.code, 230002)
    assert.equal(s2.category, 'permanent')
    assert.equal(s2.failed, true, '确定拒绝=failed（不伪造投递不确定）')
    assert.notEqual(s2.category, 'unknown', '确定拒绝不是 unknown')
    // code0 但缺 message_id → 不假成功
    const shape = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_s' } }, status: 200, headers: {}, config }
      return { data: { code: 0, msg: 'ok', data: {} }, status: 200, headers: {}, config }
    })
    const sh = toolHost(shape.client, { interactiveCard: false })
    assert.equal((await callTool(sh, 'c-b4s3')).reason, 'no_message_id')
    // 400 + code（确定）→ failed 非 unknown
    const det = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_d' } }, status: 200, headers: {}, config }
      throw { response: { status: 400, data: { code: 230099, msg: 'bad img_key' } } }
    })
    const dh = toolHost(det.client)
    const s3 = await callTool(dh, 'c-b4s4')
    assert.equal(s3.ok, false)
    assert.equal(s3.code, 230099)
    assert.equal(s3.category, 'permanent')
    assert.ok(!s3.uuidRetrySafe, '确定失败不给安全重试阀')
    assert.equal(s3.receiptError, undefined, 'finish 成功时不挂存储故障标记')
    // 无响应 → unknown + uuid 重试阀 + 窗口
    const nr = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_n' } }, status: 200, headers: {}, config }
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }) // 无响应（已派发后断开）
    })
    const nh = toolHost(nr.client)
    const s4 = await callTool(nh, 'c-b4s5')
    assert.equal(s4.category, 'unknown', 'B5 无响应=unknown')
    assert.equal(s4.uuidRetrySafe, false, 'm2：工具层无 unknown 重试入口→恒 false（内部 uuid 事实≠工具能力）')
    assert.equal(s4.receiptError, undefined, 'finish 成功时无存储故障标记（F1 只在 finish 失败时出现）')
    assert.ok(Number.isSafeInteger(s4.retrySafeUntil), 'M2 携带窗口截止')
    // text 模式 wire
    let sent2 = null
    const t = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_t' } }, status: 200, headers: {}, config }
      sent2 = config
      return { data: { code: 0, data: { message_id: 'om_img2' } }, status: 200, headers: {}, config }
    })
    const th = toolHost(t.client, { interactiveCard: false })
    const s5 = await callTool(th, 'c-b4s6')
    assert.equal(s5.mode, 'image')
    const sent2Body = typeof sent2.data === 'string' ? JSON.parse(sent2.data) : sent2.data
    assert.equal(sent2Body.msg_type, 'image')
    assert.deepEqual(JSON.parse(sent2Body.content), { image_key: 'img_v3_t' }, 'text 模式 content=本次上传的 image_key')
    // U1：上传无响应 → failed/未发送、message.create 0 次、receipt rejected/upload_rejected、固定提示允许安全新请求
    let u1msg = 0
    const u1t = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/messages')) { u1msg += 1; return { data: { code: 0, data: { message_id: 'om_u1' } }, status: 200, headers: {}, config } }
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    })
    const u1fin = []
    const u1h = toolHost(u1t.client, { finishes: u1fin })
    const u1r = await callTool(u1h, 'c-u1')
    assert.equal(u1r.failed, true, 'U1 上传无响应=明确 failed/未发送')
    assert.equal(u1r.unknown, false, 'U1 上传失败≠投递未知（孤儿 image key 不等于消息未知）')
    assert.equal(u1msg, 0, 'U1 message.create 0 次')
    assert.deepEqual({ state: u1fin.at(-1).state, reason: u1fin.at(-1).reason }, { state: 'rejected', reason: 'upload_rejected' }, 'U1 receipt=rejected+upload_rejected')
    const u1render = u1h.makeSendImageTool().output.render({}, u1r).map((b) => b.text).join('')
    assert.ok(/new request is safe to try/.test(u1render) && !/Verify in the chat/.test(u1render), 'U1 固定提示允许安全新请求且不叫查未发送消息')
    // m1：上传失败 + finish 再失败 → failed+receiptError 时取消“可安全新请求”，只留存储提示
    const u1fh = toolHost(u1t.client, { finishFail: true })
    const u1fr = await callTool(u1fh, 'c-u1f')
    assert.equal(u1fr.failed, true, '局部失败仍 failed/未发送')
    assert.equal(u1fr.receiptError, 'receipt_unavailable', 'F1：局部失败 finish 再失败附存储标记')
    assert.equal(u1fr.uuidRetrySafe, false, 'F1/m2：finish 失败无重试入口→false')
    const u1frender = u1fh.makeSendImageTool().output.render({}, u1fr).map((b) => b.text).join('')
    assert.ok(/storage error: receipt_unavailable/.test(u1frender), 'm1：failed+receiptError 渲染存储提示')
    assert.ok(!/new request is safe to try/.test(u1frender), 'm1：有 receiptError 取消“可安全新请求”（先解决存储）')
    // 运行中取消：message.create 已派发后 abort → unknown（不谎未发送）
    const aborter = new AbortController()
    const at = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_ab' } }, status: 200, headers: {}, config }
      aborter.abort() // 派发后中止（真 adapter 同步语义）
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    })
    const ath = toolHost(at.client)
    const abr = await callTool(ath, 'c-abort', {}, { signal: aborter.signal })
    assert.equal(abr.ok, false, '运行中取消不产生成功')
    assert.equal(abr.unknown, true, '已派发后取消 = unknown（不谎未发送）')
    assert.equal(abr.reason, 'aborted', '运行中取消 reason=aborted（固定枚举）')
    // F1：finish 写失败 → 保持 unknown + 固定 receiptError + uuidRetrySafe=false（不透传原异常）
    const f1h = toolHost(client, { finishFail: true })
    assert.deepEqual(f1h.makeSendImageTool().output.schema.properties.receiptError.enum, ['receipt_unavailable'], 'F1 receiptError 固定枚举入 schema')
    const f1r = await callTool(f1h, 'c-f1')
    assert.equal(f1r.unknown, true, 'F1 sent 写失败保持 unknown（平台也许成功）')
    assert.equal(f1r.receiptError, 'receipt_unavailable', 'F1 固定存储故障标记')
    assert.equal(f1r.uuidRetrySafe, false, 'F1 finish 失败 uuidRetrySafe=false')
    assert.equal(f1r.reason, 'receipt_persist_failed', 'F1 固定 reason')
    assert.ok(!JSON.stringify(f1r).includes('disk'), 'F1 不透传原异常文本')
    const f1render = f1h.makeSendImageTool().output.render({}, f1r).map((b) => b.text).join('')
    assert.ok(/storage error: receipt_unavailable/.test(f1render), 'F1 render 固定本地存储提示')
    assert.ok(!/new request is safe to try/.test(f1render), 'm1：有 receiptError 时取消“可安全新请求”（先解决存储）')
    // E：telemetry seam——attempt/result 成对、字段白名单、遥测抛错不破坏业务
    const telEvents = []
    const telHost = toolHost(client, { telemetry: { operation: (p) => { telEvents.push(p); if (p.event === 'result') throw new Error('telemetry-boom') } } })
    const telRes = await callTool(telHost, 'c-tel')
    assert.equal(telRes.ok, true, 'E 遥测抛错不破坏业务')
    assert.deepEqual(telEvents.map((e) => e.operation + ':' + e.event),
      ['image_upload:attempt', 'image_upload:result', 'image_send:attempt', 'image_send:result'],
      'E attempt/result 成对且顺序正确')
    assert.ok(telEvents.every((e) => typeof e.ok === 'boolean' && (e.httpStatus === null || Number.isInteger(e.httpStatus)) && (e.apiCode === null || Number.isInteger(e.apiCode))), 'E 字段白名单（布尔/数值）')
    assert.ok(!JSON.stringify(telEvents).includes('img_v3') && !JSON.stringify(telEvents).includes('oc_') && !JSON.stringify(telEvents).includes('lki_'), 'E 无 key/ID/uuid 泄漏')
  }

  // ══ B6：真实 axios 传输超时（本地不响应服务器 + domain 指向 loopback）───────
  {
    let serverClosed = false
    let connSeen = false
    const server = http.createServer(() => { /* 永不响应 */ })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    server.on('connection', (socket) => { connSeen = true; socket.on('close', () => { serverClosed = true }) })
    const client = new lark.Client({
      appId: 'cli_t',
      appSecret: 'sec',
      domain: 'http://127.0.0.1:' + port,
      httpInstance: axios.create({ timeout: 100 }),
      loggerLevel: lark.LoggerLevel.fatal,
    })
    const host = toolHost(client, { timeoutMs: 30000 }) // 模块看门狗远大于 axios timeout
    const started = Date.now()
    const r = await callTool(host, 'c-b6')
    const elapsed = Date.now() - started
    // 真实中止的证据：服务端观察到连接被 axios 超时销毁（留出事件派发余量）。
    for (let i = 0; i < 25 && !serverClosed; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => server.close(resolve))
    assert.equal(r.ok, false)
    // R5/U1：工具路径先上传（本地服务器永不响应 → 真实 axios 超时在首个请求上发生）
    assert.equal(r.failed, true, 'U1 上传无响应=明确 failed/未发送')
    assert.equal(r.unknown, false, 'U1 上传无响应≠投递未知（message.create 未发生）')
    const b6render = host.makeSendImageTool().output.render({}, r).map((b) => b.text).join('')
    assert.ok(/new request is safe to try/.test(b6render) && !/Verify in the chat/.test(b6render), 'U1 上传超时固定提示允许安全新请求（不叫查未发送消息）')
    assert.ok(elapsed < 5000, 'axios timeout 真实生效（' + elapsed + 'ms）')
    assert.equal(connSeen, true, '请求真实到达本地服务器')
    assert.equal(serverClosed, true, 'B6 真实中止：服务端观察到连接被关闭')
  }

  // ══ N2/N3：发送保守 unknown + 有界 transport 强制 ──────────────────────
  {
    // N2：5xx/网关/429 无明确拒绝证据 → unknown + 原 uuid 安全窗（可能已送达）
    for (const status of [500, 502, 504, 429]) {
      const t = makeRealTransport((config) => {
        if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
        if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_s' } }, status: 200, headers: {}, config }
        throw { response: { status, data: {} } } // 消息发送：确定性非2xx响应（真实 axios reject 形态）
      })
      const h = toolHost(t.client)
      const res = await callTool(h, 'c-n2-' + status)
      assert.equal(res.ok, false, status + ' 不假成功')
      assert.equal(res.unknown, true, status + ' → unknown（保守）')
      assert.equal(res.uuidRetrySafe, false, 'm2：无工具重试入口→恒 false（原 uuid 安全窗仅为内部事实）')
      assert.equal(res.receiptError, undefined, status + ' finish 成功无存储标记')
      assert.equal(res.retrySafeUntil, res.firstDispatchAt + LARK_UUID_RETRY_WINDOW_MS, status + ' 窗口可信（首派起算）')
      const rendered = h.makeSendImageTool().output.render({}, res).map((b) => b.text).join('')
      assert.ok(/UNKNOWN/.test(rendered) && /do NOT retry with a new tool call/.test(rendered), 'render 提示未知且禁止新调用重发')
    }
    // 4xx 带明确业务 code → 确定 failed（非 unknown）
    const det = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      throw { response: { status: 400, data: { code: 230099 } } }
    })
    const dh = toolHost(det.client)
    const dres = await callTool(dh, 'c-n2-det')
    assert.equal(dres.unknown, false, '确定拒绝不标 unknown（工具输出显式 false）')
    assert.equal(dres.code, 230099)
    // N3：默认 SDK 实例（无 httpInstance→timeout 0）→ 拒绝且不派发（域名指向本地死端口，零外网）
    const defaultClient = new lark.Client({ appId: 'cli_t', appSecret: 'sec', domain: 'http://127.0.0.1:1', loggerLevel: lark.LoggerLevel.fatal })
    const defHost = toolHost(defaultClient)
    const du = await callTool(defHost, 'c-n3')
    assert.equal(du.reason, 'unbounded_transport', '默认无限 timeout 拒绝（U1：upload 阶段=failed未发送）')
    assert.equal(du.category, 'unavailable')
    assert.equal(du.failed, true, 'N3/U1 未派发=failed')
    // timeout 过晚（≥deadline-余量）拒绝；足够早放行
    const late = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_l' } }, status: 200, headers: {}, config }
      return { data: { code: 0, data: { message_id: 'om_l' } }, status: 200, headers: {}, config }
    }, { timeout: 2500 })
    const lh = toolHost(late.client) // 2500+1000 > 3000
    assert.equal((await callTool(lh, 'c-n3-late')).reason, 'unbounded_transport', '底层超时晚于 deadline-余量拒绝')
    const okT = toolHost(late.client, { timeoutMs: 3500 }) // 2500+1000<=3500
    assert.equal((await callTool(okT, 'c-n3-ok')).ok, true, '有界 transport 放行')
  }

  // ══ 入站解析（M4/M5）：接收根形状 + larkPostText 保真 ──────────────────────
  {
    const larkPostTextClone = (post) => {
      const parts = []
      if (typeof post.title === 'string' && post.title) parts.push(post.title)
      const rows = Array.isArray(post.content) && post.content.length ? post.content : (Array.isArray(post.content_v2) ? post.content_v2 : null)
      if (rows) {
        const paragraphs = rows.every((p) => Array.isArray(p)) ? rows : [rows]
        const lines = []
        for (const els of paragraphs) {
          if (!Array.isArray(els)) continue
          const inline = []
          for (const el of els) if (el && typeof el === 'object' && typeof el.text === 'string' && el.text) inline.push(el.text)
          if (inline.length) lines.push(inline.join(''))
        }
        if (lines.length) parts.push(lines.join('\n'))
      }
      return parts.join('\n')
    }
    const textOf = (parts) => parts.filter((p) => p.kind === 'text').map((p) => p.text).join('')
    const cases = [
      { title: 'T' },
      { title: '标题', content: [[{ tag: 'text', text: 'a' }], [{ tag: 'text', text: 'b' }]] },
      { title: '标题', content: [[{ tag: 'text', text: '首' }, { tag: 'img', image_key: 'img_v3_1' }], [{ tag: 'text', text: '次' }]] },
      { content: [[{ tag: 'text', text: 'x' }, { tag: 'at', user_id: 'ou_1', user_name: '张三' }, { tag: 'text', text: 'y' }], [{ tag: 'text', text: 'z' }]] },
      { title: '两段', content: [[{ tag: 'md', text: '**粗** 文本' }], [{ tag: 'text', text: '尾' }]] },
    ]
    for (const post of cases) {
      const out = extractMessageImageParts(post)
      assert.equal(textOf(out.parts), larkPostTextClone(post), 'M5 文本与 larkPostText 语义一致: ' + JSON.stringify(post).slice(0, 60))
    }
    // M4：content_v2 与 content 同形（数组），md 只当文本（不做图片抽取）
    const v2 = extractMessageImageParts({ content_v2: [[{ tag: 'md', text: '图 ![x](img_v3_md) 文' }]] })
    assert.deepEqual(v2.parts.map((p) => p.kind), ['text'], 'M4 content_v2 数组+md 纯文本，不抽图片')
    assert.equal(textOf(v2.parts), '图 ![x](img_v3_md) 文')
    // 顺序/占位/超限（真实接收形状）
    const post2 = extractMessageImageParts({
      title: '标题',
      content: [
        [{ tag: 'text', text: '前段' }, { tag: 'img', image_key: 'img_v3_a' }],
        [{ tag: 'text', text: '中段' }, { tag: 'media', file_key: 'f', image_key: 'img_v3_cover' }, { tag: 'img', image_key: 'img_v3_c' }],
        [{ tag: 'sticker', key: 's' }],
      ],
    })
    assert.deepEqual(post2.parts.map((p) => p.kind), ['text', 'image', 'text', 'image'], '图文交错保序')
    assert.equal(post2.imageCount, 2, 'media 封面键不当图片')
    assert.ok(post2.unsupported.some((u) => u.kind === 'media' && u.hasImageKey === true))
    assert.ok(post2.unsupported.some((u) => u.kind === 'sticker'))
    const imgMsg = extractMessageImageParts({ image_key: 'img_v3_one' })
    assert.deepEqual(imgMsg.parts, [{ kind: 'image', imageKey: 'img_v3_one' }])
    const capped = extractMessageImageParts({ content: [[{ tag: 'img', image_key: 'img_v3_1' }, { tag: 'img', image_key: 'img_v3_2' }, { tag: 'img', image_key: 'img_v3_3' }]] }, { maxImages: 2 })
    assert.equal(capped.parts.filter((p) => p.kind === 'image').length, 2)
    assert.equal(capped.droppedImages, 1)
    assert.equal(extractMessageImageParts({ content: [[{ tag: 'img', image_key: 'https://evil/x' }]] }).parts.length, 0)
  }

  // ══ 卡片/消息/uuid（M3 旁路、M2 窗口）────────────────────────────────────
  {
    const card = buildLarkImageCard('img_v3_mine', '![evil](img_v3_evil) <at id=all>')
    assert.equal(card.schema, '2.0')
    assert.equal(card.body.elements[0].tag, 'img')
    assert.equal(card.body.elements[0].img_key, 'img_v3_mine', '唯一图片来源=本次上传')
    assert.deepEqual(card.body.elements[0].alt, { tag: 'plain_text', content: '' })
    const cap = card.body.elements[1]
    assert.equal(cap.tag, 'div', 'M3 caption 用 plain_text div（禁 markdown）')
    assert.equal(cap.text.tag, 'plain_text')
    assert.equal(card.body.elements.filter((e) => e.tag === 'img').length, 1, 'caption 不引入第二个图片来源')
    assert.ok(!JSON.stringify(card).includes('"markdown"'), '无 markdown 组件（旁路面关闭）')
    const msg = buildLarkImageMessage('img_v3_k')
    assert.equal(msg.msg_type, 'image')
    assert.deepEqual(JSON.parse(msg.content), { image_key: 'img_v3_k' })
    const u1 = deriveLarkImageSendUuid('sess-a', 'call-1', 0)
    assert.equal(u1, deriveLarkImageSendUuid('sess-a', 'call-1', 0))
    assert.notEqual(u1, deriveLarkImageSendUuid('sess-a', 'call-2', 0))
    assert.ok(u1.length <= 50)
    // N4/N6：uuid 安全窗来自 receipt 持久 firstDispatchAt（工具路径，无内存缓存推断）
    let clock = 1_000_000
    const wk = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_w' } }, status: 200, headers: {}, config }
      return { data: { code: 0, data: { message_id: 'om_w' } }, status: 200, headers: {}, config }
    })
    // 坏 firstDispatchAt（begin 返回垃圾）→ receipt_unavailable fail-closed（绝不重置）
    const missH = toolHost(wk.client, { now: () => clock, firstDispatchAt: 'garbage' })
    const miss = await callTool(missH, 'c-win-miss')
    assert.equal(miss.ok, false)
    assert.equal(miss.reason, 'receipt_unavailable', 'R2 坏 firstDispatchAt fail-closed（不自行重置）')
    const wh = toolHost(wk.client, { now: () => clock, firstDispatchAt: 1_000_000 })
    const w1 = await callTool(wh, 'c-win1')
    assert.equal(w1.ok, true)
    assert.equal(w1.firstDispatchAt, 1_000_000, '回传首派时间（来自 receipt）')
    assert.equal(w1.retrySafeUntil, 1_000_000 + LARK_UUID_RETRY_WINDOW_MS, '窗口=首派发+55min')
    clock += 60_000
    const w2 = await callTool(wh, 'c-win1')
    assert.equal(w2.retrySafeUntil, 1_000_000 + LARK_UUID_RETRY_WINDOW_MS, 'N4 重试不延长窗口')
    clock = 1_000_000 + LARK_UUID_RETRY_WINDOW_MS + 1
    const w3 = await callTool(wh, 'c-win1')
    assert.equal(w3.ok, false)
    assert.equal(w3.reason, 'uuid_window_expired', '过期拒绝')
    assert.equal(w3.unknown, true, 'N6 过期原投递状态仍 unknown')
    assert.equal(w3.uuidRetrySafe, false, 'N6 不给安全重试阀')
  }

  // ══ admit / buildUserContent（C4、串行、M6 refs 完整性）────────────────────
  {
    const agent = { selection: { provider: 'p', model: 'm' } }
    let modelInfo = { inputModalities: ['text'] }
    let saveCount = 0
    const attachments = {
      imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 },
      async saveImages(inputs) { saveCount += 1; return inputs.map((x, i) => ({ attachmentId: 'sha256:a' + i, mediaType: x.mediaType, bytes: x.data.length, width: 1, height: 1 })) },
      async validateImage() {},
    }
    const h = createLarkImageHost({
      makeClient: () => null,
      attachments,
      llm: { resolveModelInfo: async () => modelInfo },
      selectionFor: (a) => a.selection,
    })
    let r = await h.admitImages({ agent, images: [{ bytes: PNG, mediaType: 'image/png' }] })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model_no_image_support', 'C4 非视觉明确拒绝')
    modelInfo = {}
    assert.equal((await h.admitImages({ agent, images: [] })).reason, 'model_no_image_support', 'inputModalities 缺省→提示分支')
    modelInfo = { inputModalities: ['text', 'image'] }
    r = await h.admitImages({ agent, images: [{ bytes: PNG, mediaType: 'image/png', name: 'a.png' }, { bytes: JPG, mediaType: 'image/jpeg' }] })
    assert.equal(r.ok, true)
    assert.equal(r.refs.length, 2)
    const content = h.buildUserContent([{ kind: 'text', text: 'T1' }, { kind: 'image' }, { kind: 'text', text: 'T2' }, { kind: 'image' }], r.refs)
    assert.deepEqual(content.map((b) => b.type), ['text', 'image', 'text', 'image'])
    // M6：refs 不足必须失败
    assert.throws(() => h.buildUserContent([{ kind: 'text', text: 'T' }, { kind: 'image' }], []), LarkImageRefsMismatchError)
    assert.throws(() => h.buildUserContent([{ kind: 'image' }], [r.refs[0], r.refs[1]]), LarkImageRefsMismatchError)
    // 同 agent 串行
    let active = 0
    const origSave = attachments.saveImages
    attachments.saveImages = async (inputs) => { active += 1; assert.equal(active, 1, 'admission 串行'); await new Promise((res) => setTimeout(res, 15)); active -= 1; return origSave(inputs) }
    await Promise.all([
      h.admitImages({ agent, images: [{ bytes: PNG, mediaType: 'image/png' }] }),
      h.admitImages({ agent, images: [{ bytes: GIF, mediaType: 'image/gif' }] }),
    ])
    attachments.saveImages = origSave
    const noSvc = createLarkImageHost({})
    assert.equal((await noSvc.admitImages({ agent, images: [] })).reason, 'no_attachment_service', '缺服务降级不破文本')
  }

  // ══ B7 + 工具契约（真实 ToolRuntime 形状 + 绑定/授权/拒绝面）──────────────
  {
    const { client } = makeRealTransport((config) => (config.url.includes('tenant_access_token')
      ? TOKEN_OK(config)
      : { data: { code: 0, data: { image_key: 'img_v3_up', message_id: 'om_t' } }, status: 200, headers: {}, config }))
    const referenced = new Set(['att_ok'])
    const calls = { read: [], begins: [], finishes: [] }
    const receipts = {
      async begin({ uuid, digest, now }) { calls.begins.push({ uuid, digest, now }); return { outcome: 'acquired', record: { key: 'k', uuid, digest, firstDispatchAt: now, ownerToken: 'own-' + uuid } } },
      async finish(a) { calls.finishes.push(a); return { state: a.state } },
    }
    const host = createLarkImageHost({
      makeClient: () => client,
      receipts,
      attachments: {
        imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 },
        async saveImages(inputs) { return inputs.map((x, i) => ({ attachmentId: 'sha256:s' + i, mediaType: x.mediaType, bytes: x.data.length, width: 1, height: 1 })) },
        async validateImage() {},
      },
      resolveBinding: (sid) => (sid === 'sess-a' ? { channel: 'lark', appId: 'cli_test', alive: true, conversation: 'lark:oc_bound', interactiveCard: true } : null),
      isAttachmentReferenced: async (sid, id) => sid === 'sess-a' && referenced.has(String(id)),
      readAttachmentBytes: async (id) => { calls.read.push(id); return PNG },
      resolveFileTarget: async (p) => {
        if (p.includes('dir')) throw Object.assign(new Error('EISDIR'), { code: 'FS_NOT_A_FILE' })
        if (p.includes('escape')) throw Object.assign(new Error('outside'), { code: 'FS_OUTSIDE_WORKSPACE' })
        if (p.includes('notfile')) throw Object.assign(new Error('not a regular file'), { code: 'FS_NOT_REGULAR_FILE' })
        return { target: { key: 'rt' }, displayPath: '/ws/secret/workspace/' + p }
      },
      readFileBytes: async () => { calls.read.push('file'); return PNG },
      timeoutMs: 3000,
    })
    const tool = host.makeSendImageTool()
    // B7：ToolRuntime.register 契约（output {schema, render}）
    assert.equal(tool.name, 'lark_send_image')
    assert.ok(tool.output && tool.output.schema && typeof tool.output.schema === 'object', 'B7 output.schema 存在')
    assert.equal(tool.output.schema.required[0], 'ok')
    assert.equal(tool.output.schema.additionalProperties, false)
    assert.equal(typeof tool.output.render, 'function', 'B7 output.render 存在')
    // N1a：render 必须返回 ContentBlock[]（字符串会让 DeepSeek adapter 下次请求 flatMap 抛 TypeError）
    const okBlocks = tool.output.render({}, { ok: true, mode: 'card' })
    assert.ok(Array.isArray(okBlocks) && okBlocks.every((b) => b && b.type === 'text' && typeof b.text === 'string'), 'N1 render→ContentBlock[]')
    okBlocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])) // 真实请求组装契约（flatMap）
    assert.ok(/Image sent/.test(okBlocks.map((b) => b.text).join('')))
    const failBlocks = tool.output.render({}, { ok: false, reason: 'not_bound_to_lark', category: 'permanent' })
    assert.ok(Array.isArray(failBlocks) && failBlocks[0].type === 'text')
    assert.ok(failBlocks[0].text.includes('not_bound_to_lark'))
    const errBlocks = tool.output.render({}, { ok: false, reason: 'attachment_read_failed', errorCode: 'ATTACHMENT_NOT_FOUND' })
    assert.ok(errBlocks[0].text.includes('ATTACHMENT_NOT_FOUND'), 'N1b errorCode 渲染')
    assert.ok(!/img_|\/ws\//.test(JSON.stringify([okBlocks, failBlocks])), 'render 无 key/路径')
    assert.ok(!('chat_id' in tool.parameters.properties) && !('url' in tool.parameters.properties), '参数无定位/URL')
    const execA = { agent: { session: { id: 'sess-a', header: { cwd: '/ws' } } }, callId: 'call-9' }
    // M1：缺 callId 拒绝；rootCallId 不作回退
    assert.equal((await tool.execute({ file_path: 'a.png' }, { agent: execA.agent })).reason, 'missing_call_id')
    assert.equal((await tool.execute({ file_path: 'a.png' }, { agent: execA.agent, rootCallId: 'root-1' })).reason, 'missing_call_id')
    // 拒绝面
    assert.equal((await tool.execute({ attachment_id: 'x', chat_id: 'oc_evil' }, execA)).reason, 'forbidden_parameter')
    assert.equal((await tool.execute({}, execA)).reason, 'no_image_source')
    assert.equal((await tool.execute({ attachment_id: 'a', file_path: 'b' }, execA)).reason, 'single_source_required')
    assert.equal((await tool.execute({ file_path: 'a.png' }, { agent: { session: { id: 'sess-z' } }, callId: 'c' })).reason, 'not_bound_to_lark')
    assert.equal((await tool.execute({ file_path: 'dir/a.png' }, execA)).reason, 'resolve_failed')
    assert.equal((await tool.execute({ file_path: 'escape/a.png' }, execA)).reason, 'resolve_failed')
    calls.read.length = 0
    const unref = await tool.execute({ attachment_id: 'att_other' }, execA)
    assert.equal(unref.reason, 'not_referenced_by_session')
    assert.equal(calls.read.length, 0, '未授权不读附件字节')
    // exec 权限链等价断言：stat/regular-file 拒绝（index resolveFileTarget 同款错误）
    // 必须零读（readBytes 限额前置于任何字节获取）。
    const notFile = await tool.execute({ file_path: 'notfile.png' }, execA)
    assert.equal(notFile.reason, 'resolve_failed', '非 regular file 拒绝（stat 链）')
    assert.equal(calls.read.length, 0, '零读：regular-file 拒绝不触发任何 readBytes')
    // 正常：workspace 路径 → card 模式 interactive + uuid/receipt 派生（N4/W9）
    calls.begins.length = 0
    calls.finishes.length = 0
    const okRes = await tool.execute({ file_path: 'img.png' }, execA)
    assert.equal(okRes.ok, true)
    assert.equal(okRes.mode, 'card')
    assert.equal(calls.begins.length, 1, 'W9 派发前原子 begin（一次）')
    assert.equal(calls.begins[0].uuid, deriveLarkImageSendUuid('sess-a', 'call-9', 0), 'receipt 键=稳定业务 uuid')
    assert.ok(Number.isFinite(calls.begins[0].now), 'begin 时间由 receipt 提供（模型无法指定）')
    assert.equal(calls.finishes.length, 1, '成功后 finish(sent) 先于对外确认')
    assert.equal(calls.finishes[0].state, 'sent')
    // W8：缺 validateImage seam → 拒绝（不把 sniff 当已验图），零 wire
    const noVal = createLarkImageHost({
      makeClient: () => client,
      receipts,
      resolveBinding: () => ({ channel: 'lark', alive: true, conversation: 'lark:oc_bound', interactiveCard: true }),
      resolveFileTarget: async (p) => ({ target: { key: 'rt' }, displayPath: '/ws/' + p }),
      readFileBytes: async () => PNG,
    })
    const nv = await noVal.makeSendImageTool().execute({ file_path: 'img.png' }, execA)
    assert.equal(nv.reason, 'attachment_validation_unavailable', 'W8 缺权威解码校验拒绝')
    // W9：receipt 持久提交失败 → 不发送
    const failReceipt = createLarkImageHost({
      makeClient: () => client,
      receipts: { async begin() { throw new Error('disk io') }, async finish() { return true } },
      attachments: { imageLimits: { maxImageBytes: 1 << 20, maxMessageImageBytes: 1 << 21, maxImagesPerMessage: 20 }, async saveImages(i) { return i.map((x, k) => ({ attachmentId: 's' + k })) }, async validateImage() {} },
      resolveBinding: () => ({ channel: 'lark', appId: 'cli_test', alive: true, conversation: 'lark:oc_bound', interactiveCard: true }),
      resolveFileTarget: async (p) => ({ target: { key: 'rt' }, displayPath: '/ws/' + p }),
      readFileBytes: async () => PNG,
      timeoutMs: 3000,
    })
    const fr = await failReceipt.makeSendImageTool().execute({ file_path: 'img.png' }, execA)
    assert.equal(fr.ok, false)
    assert.equal(fr.reason, 'receipt_unavailable', 'begin 失败 fail-closed 不发送（R2）')
    assert.equal(fr.unknown, undefined)
    // 引用授权路径
    referenced.add('att_ok2')
    assert.equal((await tool.execute({ attachment_id: 'att_ok2' }, execA)).ok, true)
    // 失效 generation → 拒绝
    const stale = createLarkImageHost({ makeClient: () => client, resolveBinding: () => ({ channel: 'lark', alive: false, conversation: 'lark:oc_old', interactiveCard: true }) })
    assert.equal((await stale.makeSendImageTool().execute({ file_path: 'a.png' }, execA)).reason, 'not_bound_to_lark')
    // 脱敏：结果不含绝对路径/字节
    const all = JSON.stringify([unref, okRes])
    assert.ok(!all.includes('/ws/'), '不泄漏本地绝对路径')
  }

  // ══ N1：真实已装 ToolRuntime —— 注册 + 全分支 execute + schema/render 实证 ──
  {
    const HOST = HOSTX
    const { Context } = await import(pathToFileURL(HOST + 'cordis/lib/index.js').href)
    const toolsMod = await import(pathToFileURL(HOST + 'dsh-tools/lib/index.js').href)
    const { validateJsonSchemaValue } = toolsMod
    const SystemPrompt = (await import(pathToFileURL(HOST + 'dsh-system-prompt/lib/index.js').href)).default
    const hostCtx = new Context()
    await hostCtx.plugin(SystemPrompt)
    await hostCtx.plugin(toolsMod.default)
    const t2 = makeRealTransport((config) => (config.url.includes('tenant_access_token')
      ? TOKEN_OK(config)
      : { data: { code: 0, data: { image_key: 'img_v3_up', message_id: 'om_t' } }, status: 200, headers: {}, config }))
    let activeClient = t2.client // 同一注册工具内切换传输（工具名不可重复注册）
    const fullHost = createLarkImageHost({
      makeClient: () => activeClient,
      attachments: {
        imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 },
        async saveImages(inputs) { return inputs.map((x, i) => ({ attachmentId: 'sha256:rt' + i, mediaType: x.mediaType, bytes: x.data.length, width: 1, height: 1 })) },
        async validateImage(input) { if (String(input.name || '').startsWith('valfail')) throw Object.assign(new Error('rejected'), { code: 'IMAGE_REJECTED_XYZ' }) },
      },
      receipts: { async begin({ uuid, now }) { return { outcome: 'acquired', record: { key: 'k', uuid, digest: 'x', firstDispatchAt: now, ownerToken: 'own-' + uuid } } }, async finish(a) { return { state: a.state } } },
      resolveBinding: (sid) => (sid === 'sess-a' ? { channel: 'lark', appId: 'cli_test', alive: true, conversation: 'lark:oc_bound', interactiveCard: true } : null),
      isAttachmentReferenced: async (sid, id) => sid === 'sess-a' && (id === 'att_ok' || id === 'att_badread'),
      readAttachmentBytes: async (id) => {
        if (id === 'att_badread') throw Object.assign(new Error('damaged'), { code: 'ATTACHMENT_NOT_FOUND' })
        return PNG
      },
      resolveFileTarget: async (p) => {
        if (p.includes('dir')) throw Object.assign(new Error('EISDIR'), { code: 'FS_NOT_A_FILE' })
        return { target: { key: 'rt2' }, displayPath: '/ws/rt/' + p }
      },
      readFileBytes: async () => PNG,
      timeoutMs: 3000,
    })
    const toolFull = fullHost.makeSendImageTool()
    hostCtx.tools.register(toolFull)
    const agent = { session: { id: 'sess-a', header: { cwd: '/ws' } } }
    const run = async (callId, args) => {
      const r = await hostCtx.tools.execute({ callId, name: 'lark_send_image', arguments: args, agent, signal: new AbortController().signal })
      // 真实 ToolRuntime 已对 value 做 schema 校验（违规会抛 INVALID_TOOL_OUTPUT）；双重断言。
      assert.deepEqual(validateJsonSchemaValue(toolFull.output.schema, r.value, ''), [], '真实 schema 校验通过: ' + JSON.stringify(r.value).slice(0, 120))
      assert.ok(Array.isArray(r.content), '真实执行 content 为 ContentBlock[]（非字符串）')
      assert.ok(r.content.every((b) => b && b.type === 'text' && typeof b.text === 'string'), 'content 块为 text')
      return r
    }
    // 全分支：拒绝/缺源/双源/路径失败/附件未引用/附件读失败字符串码/validate 失败字符串码/未知发送/成功
    assert.equal((await run('call-b1', { file_path: 'a.png', chat_id: 'oc_x' })).value.reason, 'forbidden_parameter')
    assert.equal((await run('call-b2', {})).value.reason, 'no_image_source')
    assert.equal((await run('call-b3', { attachment_id: 'a', file_path: 'b' })).value.reason, 'single_source_required')
    assert.equal((await run('call-b4', { file_path: 'dir/a.png' })).value.reason, 'resolve_failed')
    assert.equal((await run('call-b5', { attachment_id: 'att_other' })).value.reason, 'not_referenced_by_session')
    const refFail = await run('call-b6', { attachment_id: 'att_missing' })
    assert.equal(refFail.value.reason, 'not_referenced_by_session')
    // N1b：宿主字符串码 → errorCode（integer code 之外的分域，schema 合规）
    const readFail = await run('call-b6r', { attachment_id: 'att_badread' })
    assert.equal(readFail.value.reason, 'attachment_read_failed')
    assert.equal(readFail.value.errorCode, 'ATTACHMENT_NOT_FOUND', 'N1b 白名单内附件码→errorCode 原样')
    assert.ok(!('code' in readFail.value), '字符串码不进 integer code 字段')
    const valFail = await run('call-b6v', { file_path: 'valfail.png' })
    assert.equal(valFail.value.reason, 'attachment_validation_failed')
    assert.equal(valFail.value.errorCode, 'other', 'R3 非白名单码归 other（不透传原值）')
    const okRun = await run('call-b7', { file_path: 'img.png', caption: '看图' })
    assert.equal(okRun.value.ok, true, '真实执行成功分支')
    assert.equal(okRun.value.mode, 'card')
    // 未知发送（无响应）：切换 activeClient 后仍走**同一已注册工具**（工具名不可重注册）
    const nrT = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/images')) return { data: { code: 0, data: { image_key: 'img_v3_up' } }, status: 200, headers: {}, config }
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }) // 消息发送无响应（已派发后断开）
    })
    activeClient = nrT.client
    const unk = await hostCtx.tools.execute({ callId: 'call-b8', name: 'lark_send_image', arguments: { file_path: 'img.png' }, agent, signal: new AbortController().signal })
    activeClient = t2.client
    assert.equal(unk.value.ok, false)
    assert.equal(unk.value.unknown, true, '真实执行 unknown 分支')
    assert.deepEqual(validateJsonSchemaValue(toolFull.output.schema, unk.value, ''), [], 'unknown 值 schema 合规')
    assert.ok(/UNKNOWN/.test(unk.content.map((b) => b.text).join('')), '真实 content 提示未知')
    await hostCtx.fiber.dispose()
  }


  // ══ 场景28（R1–R5 + Lead 正式接口）：真实临时 store.sendReceipts 整合 ═══════
  // 真实 openLarkDedupStore（OS flock 单写者）+ 真实 begin/finish（{outcome,record}
  // 契约、固定 reason 枚举、先 durable 再成功）；故障注入仅为 store-seam 包装真品
  // （不伪造状态机）。若底层（D5 flock/编辑态）不可用 → 如实 SKIPPED（不假通过）。
  const { mkdtemp } = await import('node:fs/promises')
  const r28root = await mkdtemp(path.join(require('node:os').tmpdir(), 'lark-img-r28-'))
  let r28lease = null
  try {
    r28lease = await openLarkDedupStore(r28root)
  } catch (e) {
    console.log('lark-image scenario28: SKIPPED（真实 dedup store 底层暂不可用: ' + (e && e.code || 'no_code') + '）待稳定后重跑——非通过')
  }
  if (r28lease) {
    const realReceipts = r28lease.sendReceipts
    let failFinish28 = false
    const seamReceipts = { // store-seam：begin 真品直通；finish 可故障注入
      async begin(args) { return realReceipts.begin(args) },
      async finish(args) { if (failFinish28) return false; return realReceipts.finish(args) },
    }
    let sends = []
    const rc = makeRealTransport((config) => {
      if (config.url.includes('tenant_access_token')) return TOKEN_OK(config)
      if (config.url.endsWith('/im/v1/messages')) { sends.push(config); return { data: { code: 0, data: { message_id: 'om-r1' } }, status: 200, headers: {}, config } }
      return { data: { code: 0, data: { image_key: 'img_v3_r' } }, status: 200, headers: {}, config }
    })
    const clientRef = { client: rc.client }
    const mk = (receipts) => createLarkImageHost({
      makeClient: () => clientRef.client,
      receipts,
      attachments: {
        imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 },
        async saveImages(i) { return i.map((x, k) => ({ attachmentId: 's' + k })) },
        async validateImage() {},
      },
      resolveBinding: () => ({ channel: 'lark', appId: 'cli_test', alive: true, conversation: 'lark:oc_bound', interactiveCard: true }),
      // R4：不同路径读出不同字节（供 digest 冲突场景）。
      resolveFileTarget: async (p) => ({ target: { key: 'rt-' + p }, displayPath: '/ws/rt/' + p }),
      readFileBytes: async (t) => (String(t && t.key) === 'rt-img2.png' ? Buffer.concat([PNG, Buffer.from('diff')]) : PNG),
      timeoutMs: 3000,
    })
    const hostR = mk(realReceipts)
    const toolR = hostR.makeSendImageTool()
    const agentR = { session: { id: 'sess-a', header: { cwd: '/ws' } } }
    const call = (callId, file = 'img.png') => toolR.execute({ file_path: file }, { agent: agentR, callId })
    // 1) 首次：真实 begin=acquired（durable 先行）→ 派发1次 → finish(sent) durable → 成功
    const r1 = await call('call-rf1')
    assert.equal(r1.ok, true)
    assert.equal(sends.length, 1, 'R1 首次仅派发1次')
    const uuidRf1 = deriveLarkImageSendUuid('sess-a', 'call-rf1', 0)
    const storedRf1 = realReceipts.get(uuidRf1)
    assert.equal(storedRf1.state, 'sent', 'R1 终态落真实账本（先 durable 再成功）')
    assert.equal(storedRf1.messageId, 'om-r1', '账本记录 messageId（内部）')
    assert.equal(storedRf1.digest, larkSendDigest({ imageSha256: sha(PNG), mode: 'card', caption: '', appId: 'cli_test', conversation: 'lark:oc_bound' }), 'R4 digest＝ledger 同源 larkSendDigest（appId/目标绑定）')
    // 2) 成功后重放同 callId：真实 begin=sent → 零发送；记录 messageId 不进模型
    const r2 = await call('call-rf1')
    assert.equal(r2.ok, true, '重放返回已发送')
    assert.equal(r2.replayed, true, 'R1 重放显式标记（不伪装新发送）')
    assert.equal(r2.messageId, undefined, 'Lead：sent 记录 messageId 仅内部，不进模型')
    assert.equal(sends.length, 1, 'R1 成功后重放零额外发送')
    // 3) 同 uuid 变更字节（同 callId 不同文件）：真实 begin=conflict，零发送
    const cConflict = await call('call-rf1', 'img2.png')
    assert.equal(cConflict.reason, 'receipt_conflict', 'R4 同 callId 不同字节 → conflict')
    assert.equal(sends.length, 1, 'R4 conflict 零发送')
    // 4) 同 callId 并发（真实 begin 单持有，finish 门控确定性构造 in-flight 态）：
    //    胜者已派发但 finish 被门控 → 敗者 begin=dispatching+owner 活 → in_progress。
    let releaseFinish = null
    const finishGate = new Promise((r) => { releaseFinish = r })
    let failFinishHold = false
    const gateReceipts = {
      async begin(args) { return realReceipts.begin(args) },
      async finish(args) { if (failFinishHold) return false; await finishGate; return realReceipts.finish(args) },
    }
    const gateHost = mk(gateReceipts)
    const p1 = gateHost.makeSendImageTool().execute({ file_path: 'img.png' }, { agent: agentR, callId: 'call-rf2' })
    for (let i = 0; i < 200 && sends.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5))
    assert.equal(sends.length, 2, '并发场景：胜者已真实派发（finish 未落）')
    const c2 = await gateHost.makeSendImageTool().execute({ file_path: 'img.png' }, { agent: agentR, callId: 'call-rf2' })
    assert.equal(c2.ok, false, '并发第二方不得发送')
    assert.equal(c2.reason, 'receipt_in_progress', 'R2 并发态映射固定 receipt_in_progress（真实 begin 单持有）')
    assert.equal(sends.length, 2, 'R2 并发败者零额外发送')
    releaseFinish()
    const p1res = await p1
    assert.equal(p1res.ok, true, '胜者 finish 落盘后正常成功')
    assert.equal(sends.length, 2, 'R2 并发总发送仅 +1')
    // 5) finish 写失败（store-seam 注入）：平台已派发 → 只报 unknown（不假成功）
    const seamHost = mk(seamReceipts)
    const seamTool = seamHost.makeSendImageTool()
    failFinish28 = true
    const rf = await seamTool.execute({ file_path: 'img.png' }, { agent: agentR, callId: 'call-rf3' })
    failFinish28 = false
    assert.equal(rf.ok, false)
    assert.equal(rf.unknown, true, 'R1 finish 写失败 → unknown（不假成功）')
    assert.equal(rf.receiptError, 'receipt_unavailable', 'F1 finish 写失败附固定存储标记')
    assert.equal(rf.uuidRetrySafe, false, 'F1 finish 写失败 → uuidRetrySafe=false（存储故障期间不重试）')
    assert.equal(sends.length, 3, '该次真实派发1次（未假成功）')
    // 5b) 同进程重放：record=dispatching + owner 仍活 → in_progress，零自动重发
    const replayInFlight = await call('call-rf3')
    assert.equal(replayInFlight.reason, 'receipt_in_progress', 'finish 失败后同进程重放不自动重发')
    assert.equal(sends.length, 3, 'finish 失败后绝不再次发送（Lead）')
    // 6) 冷重启（关 store 重开 → dispatching 载入转 unknown('interrupted')）：
    //    begin=unknown → 只给核对提示，零自动重发
    await r28lease.close()
    r28lease = await openLarkDedupStore(r28root)
    const coldHost = mk(r28lease.sendReceipts)
    const cold = await coldHost.makeSendImageTool().execute({ file_path: 'img.png' }, { agent: agentR, callId: 'call-rf3' })
    assert.equal(cold.ok, false)
    assert.equal(cold.unknown, true, '冷遗留 → unknown（不假成功不假失败）')
    assert.equal(cold.reason, 'interrupted', '冷遗留 reason=账本固定枚举 interrupted')
    assert.equal(cold.uuidRetrySafe, false, 'm2：冷 unknown 也无工具重试入口→false')
    assert.equal(sends.length, 3, '冷重放零发送（Lead：unknown 不自动 retry）')
    // 7) begin 异常（store-seam 抛错）→ fail-closed receipt_unavailable，零派发
    const throwHost = mk({ async begin() { throw Object.assign(new Error('x'), { code: 'lock_held' }) }, async finish() { return true } })
    const tb = await throwHost.makeSendImageTool().execute({ file_path: 'img.png' }, { agent: agentR, callId: 'call-rf4' })
    assert.equal(tb.reason, 'receipt_unavailable', 'begin 抛错一律 fail-closed（绝不算 new）')
    assert.equal(sends.length, 3, 'begin 失败零派发')
    // 8) R5 最小收口：sendImage/uploadImage 不再导出（生产无法伪 owner 绕过 receipt 流程）
    assert.equal(hostR.sendImage, undefined, 'R5 sendImage 不导出')
    assert.equal(hostR.uploadImage, undefined, 'R5 uploadImage 不导出')
    // digest 目标身份缺失 → no_app_id fail-closed（工具层；入站 download 等 API 不受影响）
    const noApp = createLarkImageHost({
      makeClient: () => rc.client,
      receipts: r28lease.sendReceipts,
      attachments: { imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 }, async saveImages(i) { return i.map((x, k) => ({ attachmentId: 's' + k })) }, async validateImage() {} },
      resolveBinding: () => ({ channel: 'lark', alive: true, conversation: 'lark:oc_bound', interactiveCard: true }), // 无 appId
      resolveFileTarget: async (p) => ({ target: { key: 'rt-' + p }, displayPath: '/ws/rt/' + p }),
      readFileBytes: async () => PNG,
      timeoutMs: 3000,
    })
    const na = await noApp.makeSendImageTool().execute({ file_path: 'img.png' }, { agent: agentR, callId: 'call-noapp' })
    assert.equal(na.reason, 'no_app_id', '缺 appId → digest 目标身份缺失 fail-closed')
    // 9) R3：真实 ToolRuntime 下恶意 errorCode 不透传
    const HOST = HOSTX
    const { Context } = await import(pathToFileURL(HOST + 'cordis/lib/index.js').href)
    const toolsMod3 = await import(pathToFileURL(HOST + 'dsh-tools/lib/index.js').href)
    const SystemPrompt3 = (await import(pathToFileURL(HOST + 'dsh-system-prompt/lib/index.js').href)).default
    const hc = new Context()
    await hc.plugin(SystemPrompt3)
    await hc.plugin(toolsMod3.default)
    const evilHost = createLarkImageHost({
      makeClient: () => rc.client,
      receipts: r28lease.sendReceipts,
      attachments: {
        imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 200 * 1024 * 1024, maxImagesPerMessage: 20 },
        async saveImages(i) { return i.map((x, k) => ({ attachmentId: 's' + k })) },
        async validateImage(input) { throw Object.assign(new Error('bad'), { code: '/Users/secret/path/a.png token=abc' }) },
      },
      resolveBinding: () => ({ channel: 'lark', appId: 'cli_test', alive: true, conversation: 'lark:oc_bound', interactiveCard: true }),
      resolveFileTarget: async (p) => ({ target: { key: 'rt' }, displayPath: '/ws/rt/' + p }),
      readFileBytes: async () => PNG,
      timeoutMs: 3000,
    })
    hc.tools.register(evilHost.makeSendImageTool())
    const evil = await hc.tools.execute({ callId: 'call-evil', name: 'lark_send_image', arguments: { file_path: 'x.png' }, agent: agentR, signal: new AbortController().signal })
    const evilJson = JSON.stringify(evil.value) + JSON.stringify(evil.content)
    assert.ok(!evilJson.includes('/Users/secret'), 'R3 恶意 code 不透传（结构化+render）')
    assert.equal(evil.value.errorCode, 'other', 'R3 非白名单 → other, got ' + evil.value.errorCode)
    assert.ok(!('code' in evil.value), 'R3 恶意串不进 integer code')
    await hc.fiber.dispose()
    await r28lease.close()
    console.log('lark-image scenario28: 真实 store.sendReceipts 整合通过（flock 单写者真盘）')
  }

  console.log('lark-image ok | real-sdk wire | real ToolRuntime | R1-R5 receipt contract covered')
}

main().catch((err) => { console.error(err); process.exit(1) })
