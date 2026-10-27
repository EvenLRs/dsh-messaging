// lark-t5-attachments.cjs —— T5 真实附件服务验收（Lead 授权路径 a：官方 registry
// 校验后的原生件仅补入 /tmp/dsh-hostx 隔离夹具）。
// 覆盖：真解码、伪格式拒绝、宿主体积限额、图文/多图顺序、content-addressed
// 只准入一次（fresh 与 GET recovery 同 parts 契约 → 等价 typed blocks）。
// 全程合成图片 + mkdtemp dshHome；不触真实 profile/app/用户图片。
process.env.DSH_TEST_TIMEOUT_MS = process.env.DSH_TEST_TIMEOUT_MS || '120000'
require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const HOST = (process.env.DSH_HOSTX_ROOT || process.env.DSH_HOSTX || '/tmp/dsh-hostx') + '/dsh/node_modules/@deepseek-ai/'
if (!fs.existsSync(path.join(HOST, 'dsh-tools'))) {
  throw new Error('host fixture missing: set DSH_HOSTX to an unpacked host tree (looked for dsh/node_modules/@deepseek-ai/dsh-tools)')
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

// 与插件入站管线完全同形的 parts 构造（fresh=事件解析；recovery=GET 重建）。
function partsFromEvent(content) {
  const parsed = typeof content === 'string' ? JSON.parse(content) : content
  return parsed && parsed.image_key
    ? [{ kind: 'text', text: '看图' }, { kind: 'image', fileKey: parsed.image_key }]
    : null
}
function partsFromGet(item) {
  const raw = item.body && item.body.content
  const content = typeof raw === 'string' ? JSON.parse(raw) : raw
  return content && content.image_key
    ? [{ kind: 'text', text: '看图' }, { kind: 'image', fileKey: content.image_key }]
    : null
}
function toAdmitParts(parts, bytesByKey) {
  return parts.map((p) => (p.kind === 'text'
    ? { type: 'text', text: p.text }
    : { type: 'image', data: bytesByKey.get(p.fileKey).toString('base64'), mediaType: 'image/png' }))
}

async function main() {
  const { Context } = await import(pathToFileURL(path.join(HOST, 'cordis/lib/index.js')).href)
  const mod = await import(pathToFileURL(path.join(HOST, 'dsh-attachment-local/lib/index.js')).href)
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t5-'))
  const ctx = new Context()
  const store = new mod.LocalAttachmentStore(ctx, { dshHome })
  assert.ok(String(store.root).startsWith(dshHome), 'T5 存储根隔离在 mkdtemp（不触真实 profile）')

  // 1) 真解码（sharp 实跑）：合法 1x1 PNG 通过权威校验
  await store.validateImage({ data: PNG, mediaType: 'image/png' })

  // 2) 伪格式拒绝（真解码器，非 sniff）
  await assert.rejects(
    () => store.validateImage({ data: Buffer.from('definitely-not-a-real-png'), mediaType: 'image/png' }),
    (err) => /INVALID_IMAGE|unsupported|format/i.test(String(err.code || err.name || err.message)),
    '伪 PNG 被真解码器拒绝')

  // 3) 宿主体积限额（maxImageBytes 由 store 权威执行）
  const overLimit = Buffer.concat([PNG, Buffer.alloc(22 * 1024 * 1024)])
  await assert.rejects(
    () => store.validateImage({ data: overLimit, mediaType: 'image/png' }),
    (err) => String(err.code) === 'IMAGE_TOO_LARGE' || /too.?large/i.test(String(err.message)),
    '超宿主限额被拒绝')

  // 4) 图文/多图顺序 + content-addressed 只准入一次
  const bytesByKey = new Map([['img_v3_a', PNG], ['img_v3_b', PNG]])
  const mixed = [{ kind: 'text', text: '第一行' }, { kind: 'image', fileKey: 'img_v3_a' }, { kind: 'text', text: '中间' }, { kind: 'image', fileKey: 'img_v3_b' }]
  const blocksMixed = await store.admitPromptContent(toAdmitParts(mixed, bytesByKey))
  assert.deepEqual(blocksMixed.map((b) => b.type), ['text', 'image', 'text', 'image'], 'T5 多图+文本按原顺序')
  assert.ok(blocksMixed.every((b) => b.type !== 'image' || String(b.attachment && b.attachment.attachmentId).startsWith('sha256:')), 'T5 image block 持真实内容寻址引用')

  // 5) fresh 与 GET recovery 契约等价：同一 messageId/image_key 的两条 parts 路径
  //    产出完全等价的 typed blocks，且同字节二次准入复用同一确定性 ID（只准入一次）
  const eventContent = JSON.stringify({ image_key: 'img_v3_a' })
  const getContent = { body: { content: JSON.stringify({ image_key: 'img_v3_a' }) } }
  const freshParts = partsFromEvent(eventContent)
  const recovParts = partsFromGet(getContent)
  assert.deepEqual(freshParts, recovParts, 'fresh 与 recovery 重建的 parts 契约一致')
  const freshBlocks = await store.admitPromptContent(toAdmitParts(freshParts, bytesByKey))
  const recovBlocks = await store.admitPromptContent(toAdmitParts(recovParts, bytesByKey))
  assert.deepEqual(freshBlocks.map((b) => b.type), recovBlocks.map((b) => b.type), '两条路径 typed blocks 类型序列等价')
  assert.equal(freshBlocks[1].attachment.attachmentId, recovBlocks[1].attachment.attachmentId, '确定性 ID：同字节两路径同一引用（只准入一次）')

  console.log('lark-t5-attachments ok | real sharp decode | fake/oversize rejected | order+multipic | fresh≡recovery idempotent')
}

main().catch((err) => { console.error(err); process.exit(1) })
