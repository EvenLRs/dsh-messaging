// lark-notice.cjs —— 恢复告知（C-1）单测：独立 notice UUID/digest 域、
// 成功后重放零重复、通知 unknown、finish 持久失败不谎 rejected、目标不可确认不乱发。
// 全 seam 注入（receipts/wire 均为 mock），零网络、零真实配置。
process.env.DSH_TEST_TIMEOUT_MS = process.env.DSH_TEST_TIMEOUT_MS || '120000'
require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

function makeReceipts() {
  const db = new Map()
  let failFinish = false
  const finishes = []
  return {
    finishes,
    setFailFinish(v) { failFinish = v },
    db,
    begin: async ({ uuid, digest, now }) => {
      const rec = db.get(uuid)
      if (!rec) {
        const owned = { state: 'dispatching', firstDispatchAt: now, ownerToken: 'own-' + uuid, digest }
        db.set(uuid, owned)
        return { outcome: 'acquired', record: owned }
      }
      if (rec.digest !== digest) return { outcome: 'conflict', record: rec }
      if (rec.state === 'sent') return { outcome: 'sent', record: rec }
      if (rec.state === 'rejected') return { outcome: 'rejected', record: rec }
      if (rec.state === 'unknown') return { outcome: 'unknown', record: rec }
      return { outcome: 'in_progress', record: rec }
    },
    finish: async ({ uuid, ownerToken, state, messageId, reason }) => {
      if (failFinish) return false
      const rec = db.get(uuid)
      if (!rec || rec.state !== 'dispatching' || rec.ownerToken !== ownerToken) return false
      finishes.push({ uuid, state, messageId, reason })
      db.set(uuid, { ...rec, state, messageId: messageId || null, reason: reason || null })
      return { state }
    },
  }
}

function makeWire(handler) {
  const calls = []
  const wire = async (method, url, headers, payload) => {
    calls.push({ method, url, headers, payload })
    return handler(payload, url)
  }
  return { calls, wire }
}

async function main() {
  const mod = await import(pathToFileURL(path.join(root, 'lib', 'lark-notice.js')).href)
  const { sendLarkNotice, larkNoticeUuid, larkNoticeDigest, LARK_NOTICE_KINDS } = mod

  // UUID/digest 独立业务域：lkn_ 前缀 ≤50，与图片 lki_ 域不串
  const u1 = larkNoticeUuid('dedup-key-1', 'session_missing')
  assert.ok(u1.startsWith('lkn_') && u1.length <= 50, 'notice uuid 独立前缀且 ≤50')
  assert.equal(u1, larkNoticeUuid('dedup-key-1', 'session_missing'), '同 key+kind 稳定（可幂等重放）')
  assert.notEqual(u1, larkNoticeUuid('dedup-key-1', 'edited'), '不同 kind 不同 uuid')
  const d1 = larkNoticeDigest({ kind: 'edited', appId: 'cli_x', conversation: 'lark:oc_y' })
  assert.equal(d1.length, 64)
  assert.notEqual(d1, larkNoticeDigest({ kind: 'edited', appId: 'cli_x', conversation: 'lark:oc_z' }), 'digest 绑定目标')

  // 1) 首次成功：acquired → 真 wire（uuid 入 body、card=true 一律 interactive）→ finish(sent) → delivered
  {
    const receipts = makeReceipts()
    const { calls, wire } = makeWire(() => ({ ok: true, status: 200, json: { code: 0, data: { message_id: 'om_n1' } } }))
    const res = await sendLarkNotice({
      receipts, wire, key: 'k1', kind: 'session_missing',
      appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 1000,
    })
    assert.equal(res.outcome, 'delivered', '通知确认送达')
    assert.equal(calls.length, 1, '恰好一次 wire')
    assert.equal(calls[0].payload.msg_type, 'interactive', 'card=true 一律 interactive')
    assert.equal(String(calls[0].payload.uuid), larkNoticeUuid('k1', 'session_missing'), 'uuid 实际入 wire（独立 lkn_ 域）')
    assert.equal(String(calls[0].payload.uuid).startsWith('lkn_'), true)
    const card = JSON.parse(calls[0].payload.content)
    assert.equal(card.schema, '2.0', '固定卡片（无正文注入）')
    assert.ok(card.body.elements[0].text.content.includes('请重新发送'), '固定文案')
    assert.deepEqual(receipts.finishes.map((f) => f.state), ['sent'], '先 durable(sent) 再报送达')
  }

  // 2) 成功后 crash 重放：begin=sent → delivered，零重复 wire（不落第二条消息）
  {
    const receipts = makeReceipts()
    let wireCount = 0
    const { wire } = makeWire(() => { wireCount += 1; return { ok: true, status: 200, json: { code: 0, data: { message_id: 'om_n2' } } } })
    const a = await sendLarkNotice({ receipts, wire, key: 'k2', kind: 'edited', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 1000 })
    assert.equal(a.outcome, 'delivered')
    const b = await sendLarkNotice({ receipts, wire, key: 'k2', kind: 'edited', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 2000 })
    assert.equal(b.outcome, 'delivered', '重放视为已送达')
    assert.equal(wireCount, 1, 'crash 重放零重复通知')
  }

  // 3) 通知 unknown：网络无响应 → finish(unknown) → unknown（不谎 rejected，不重派）
  {
    const receipts = makeReceipts()
    const { calls, wire } = makeWire(() => ({ ok: false, status: null, json: null }))
    const res = await sendLarkNotice({ receipts, wire, key: 'k3', kind: 'uncertain', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: false, now: () => 1000 })
    assert.equal(res.outcome, 'unknown', '无响应 → unknown')
    assert.deepEqual(receipts.finishes.map((f) => f.state), ['unknown'], '落 unknown 非 rejected')
    const again = await sendLarkNotice({ receipts, wire, key: 'k3', kind: 'uncertain', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: false, now: () => 2000 })
    assert.equal(again.outcome, 'unknown', 'unknown 重放不重派')
    assert.equal(calls.length, 1, 'unknown 重放零 wire')
  }

  // 4) finish 持久失败：平台成功但写失败 → unknown（绝不谎 rejected/送达）
  {
    const receipts = makeReceipts()
    const { calls, wire } = makeWire(() => ({ ok: true, status: 200, json: { code: 0, data: { message_id: 'om_n4' } } }))
    receipts.setFailFinish(true)
    const res = await sendLarkNotice({ receipts, wire, key: 'k4', kind: 'refetch_scope_missing', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 1000 })
    assert.equal(res.outcome, 'unknown', 'finish 持久失败 → unknown（不谎）')
    // Lead 规则：unknown/in_progress 不重派，原入站 claimed 保留 → 同进程重放=in_progress 零 wire
    const replay = await sendLarkNotice({ receipts, wire, key: 'k4', kind: 'refetch_scope_missing', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 2000 })
    assert.equal(replay.outcome, 'in_progress', 'finish 失败后同进程重放 = in_progress 不重派')
    assert.equal(calls.length, 1, '零重复 wire')
    // 模拟重启：遗留 dispatching 载入转 unknown → 仍不重派（保留 pending）
    const rec = receipts.db.get(larkNoticeUuid('k4', 'refetch_scope_missing'))
    if (rec) rec.state = 'unknown'
    const replay2 = await sendLarkNotice({ receipts, wire, key: 'k4', kind: 'refetch_scope_missing', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 3000 })
    assert.equal(replay2.outcome, 'unknown', '重启后 unknown 仍不重派')
    assert.equal(calls.length, 1, '全程仅首次真实发送')
  }

  // 5) 平台明确拒绝 → failed（finish rejected 持久）；未知 chat → 本地阻断不发；未知 kind 不发
  {
    const receipts = makeReceipts()
    const { calls, wire } = makeWire(() => ({ ok: true, status: 200, json: { code: 230002, msg: 'not in chat' } }))
    const res = await sendLarkNotice({ receipts, wire, key: 'k5', kind: 'edited', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: false, now: () => 1000 })
    assert.equal(res.outcome, 'failed')
    assert.deepEqual(receipts.finishes.map((f) => f.state), ['rejected'])
    assert.equal(receipts.finishes[0].reason, 'target_gone', '固定枚举 reason')
    const noChat = await sendLarkNotice({ receipts, wire, key: 'k6', kind: 'sid_or_chat_missing', appId: 'cli_x', conversation: null, chatId: null, interactiveCard: true, now: () => 1000 })
    assert.equal(noChat.outcome, 'pending_target', '无法确认目标 → 本地阻断')
    const badKind = await sendLarkNotice({ receipts, wire, key: 'k7', kind: 'not_a_kind', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 1000 })
    assert.equal(badKind.outcome, 'invalid_kind', '未知 kind 不发送')
    assert.equal(calls.length, 1, '后两者零 wire')
    assert.equal(LARK_NOTICE_KINDS.length, 10, 'kind 枚举固定（6 恢复类 + waiting + 3 图片类）')
    const { calls: cw, wire: ww } = makeWire(() => ({ ok: true, status: 200, json: { code: 0, data: { message_id: 'om_nw' } } }))
    const rw = await sendLarkNotice({ receipts: makeReceipts(), wire: ww, key: 'kw', kind: 'waiting_for_input', appId: 'cli_x', conversation: 'lark:oc_y', chatId: 'oc_y', interactiveCard: true, now: () => 1000 })
    assert.equal(rw.outcome, 'delivered', 'waiting_for_input 可正常送达')
    assert.ok(JSON.parse(cw[0].payload.content).body.elements[0].text.content.includes('已入队'), 'waiting_for_input 固定文案（需后续输入继续）')
  }

  console.log('lark-notice ok | independent notice domain | replay-zero | unknown/finish-fail honest')
}

main().catch((err) => { console.error(err); process.exit(1) })
