require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// unhandled rejection 必须显式失败（回调 reject 一律走 onError，不允许泄漏）。
const unhandled = []
process.on('unhandledRejection', (err) => {
  unhandled.push(err)
})

async function main() {
  const {
    LARK_ADMISSION_KEY,
    LARK_ADMISSION_STATE_VERSION,
    LARK_ADMISSION_IDS_PER_SESSION,
    LARK_ADMISSION_NS_LIMIT,
    createLarkAdmissionDefinition,
    larkAdmissionVerdict,
    larkAdmissionInboxIds,
  } = await import(pathToFileURL(path.join(root, 'lib', 'lark-admission.js')).href)
  const { larkDedupUserMessageId } = await import(pathToFileURL(path.join(root, 'lib', 'lark-dedup.js')).href)

  const nsA = 'aa11bb22'
  const nsB = 'cc33dd44'
  const id = (ns, seq) => larkDedupUserMessageId(ns, seq, 'cli_app', 'om_' + ns + '_' + String(seq))
  const def = createLarkAdmissionDefinition()

  // ---------- 定义形状：host-only，注册所需字段齐全 ----------
  {
    assert.equal(def.key, LARK_ADMISSION_KEY, 'projection key is exported for registration')
    assert.equal(def.stateVersion, LARK_ADMISSION_STATE_VERSION, 'stateVersion exported')
    assert.equal(typeof def.stateSchema.parse, 'function', 'stateSchema.parse is a real validator (cache restore calls it uncaught)')
    assert.equal(typeof def.init, 'function', 'init present')
    assert.equal(typeof def.apply, 'function', 'apply present')
    assert.equal(def.wire, undefined, 'host-only definition carries no wire')
    assert.deepEqual(def.init(), { ids: [], evictedMax: {}, overflow: false }, 'init state shape (v2: overflow sentinel present)')
    assert.ok(LARK_ADMISSION_IDS_PER_SESSION >= 1, 'retention bound exported')
  }

  // ---------- fold：只认 agent/inbox/spliced 的 inserted，本插件合法 id ----------
  {
    let state = def.init()
    const a1 = id(nsA, 1)
    const a2 = id(nsA, 2)
    state = def.apply(state, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: a1 }] } })
    assert.deepEqual(state.ids, [a1], 'first insert folds in')
    // claim 事件（removedCount、inserted 空）不影响投影
    const afterClaim = def.apply(state, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
    assert.equal(afterClaim, state, 'claim-only splice returns the same reference')
    // 无关事件返回同一引用（宿主引用相等短路）
    assert.equal(def.apply(state, { type: 'user/message', data: {} }), state, 'unrelated event returns the same reference')
    assert.equal(def.apply(state, { type: 'agent/inbox/spliced', data: { inserted: 'not-an-array' } }), state, 'malformed inserted degrades to same reference')
    // 重复 id 不重复计入；外来 id 被忽略
    const mixed = def.apply(state, {
      type: 'agent/inbox/spliced',
      data: { inserted: [{ id: a1 }, { id: a2 }, { id: 'ou_other_plugin' }, { id: 42 }, null, { noId: true }] },
    })
    assert.deepEqual(mixed.ids, [a1, a2], 'duplicate and foreign ids never enter the projection')
    state = mixed
    assert.equal(state.evictedMax[nsA], undefined, 'no eviction watermark before the bound is hit')
  }

  // ---------- 有界保留 + 淘汰水位按 namespace 分别记账 ----------
  {
    const small = createLarkAdmissionDefinition({ idsPerSession: 3 })
    let state = small.init()
    const seqs = [1, 2, 3, 4, 5]
    for (const seq of seqs) {
      state = small.apply(state, { type: 'agent/inbox/spliced', data: { inserted: [{ id: id(nsA, seq) }] } })
    }
    assert.equal(state.ids.length, 3, 'ids stay within the retention bound')
    assert.deepEqual(state.ids, [id(nsA, 3), id(nsA, 4), id(nsA, 5)], 'eviction drops from the oldest end')
    assert.equal(state.evictedMax[nsA], 2, 'watermark records the highest evicted seq for nsA')
    assert.equal(state.evictedMax[nsB], undefined, 'namespace B is untouched by namespace A eviction')
    // 混入 nsB：淘汰仍从最旧端发生（容量压力会淘汰 nsA 旧 id，水位各自抬升），
    // 但两个 ns 的水位独立记账、判定时互不串用。
    for (const seq of [1, 2, 3, 4]) {
      state = small.apply(state, { type: 'agent/inbox/spliced', data: { inserted: [{ id: id(nsB, seq) }] } })
    }
    assert.equal(state.evictedMax[nsA], 5, 'nsA items evicted under capacity pressure raise the nsA watermark only')
    assert.equal(state.evictedMax[nsB], 1, 'nsB watermark is tracked independently')
    // 上限保护：options 不能突破产品上限
    const capped = createLarkAdmissionDefinition({ idsPerSession: 999999 })
    let cappedState = capped.init()
    for (let seq = 1; seq <= LARK_ADMISSION_IDS_PER_SESSION + 5; seq += 1) {
      cappedState = capped.apply(cappedState, { type: 'agent/inbox/spliced', data: { inserted: [{ id: id(nsA, seq) }] } })
    }
    assert.equal(cappedState.ids.length, LARK_ADMISSION_IDS_PER_SESSION, 'options cannot exceed the product retention bound')
    assert.equal(cappedState.evictedMax[nsA], 5, 'watermark follows the capped eviction')
  }

  // ---------- stateSchema.parse：严格校验，坏缓存 fail-closed（抛，不当空集） ----------
  {
    const valid = { ids: [id(nsA, 1)], evictedMax: { [nsB]: 7 }, overflow: false }
    const parsed = def.stateSchema.parse(valid)
    assert.deepEqual(parsed.ids, valid.ids, 'valid state parses')
    assert.deepEqual(parsed.evictedMax, valid.evictedMax, 'valid watermark map parses')
    const bad = [
      null,
      [],
      'json-string',
      { ids: 'x', evictedMax: {}, overflow: false },
      { ids: [id(nsA, 1)] }, // 缺 evictedMax
      { ids: [], evictedMax: {}, overflow: false, extra: 1 }, // 多余字段
      { ids: ['ou_foreign_id'], evictedMax: {}, overflow: false }, // 外来 id 混入
      { ids: ['lark-XX-1-yy'], evictedMax: {}, overflow: false }, // 坏形状 id
      { ids: [], evictedMax: { notHex: 1 }, overflow: false }, // 坏 ns key
      { ids: [], evictedMax: { [nsA]: -1 }, overflow: false }, // 负水位
      { ids: [], evictedMax: { [nsA]: 1.5 }, overflow: false }, // 非整数水位
      { ids: new Array(LARK_ADMISSION_IDS_PER_SESSION + 1).fill(id(nsA, 1)), evictedMax: {}, overflow: false }, // 超界
    ]
    for (const value of bad) {
      assert.throws(() => def.stateSchema.parse(value), 'corrupted cache state must throw, never parse as empty: ' + JSON.stringify(value))
    }
    // parse 结果是拷贝（投影 state 是借用引用，防外部污染）
    const copy = def.stateSchema.parse(valid)
    copy.ids.push(id(nsA, 99))
    assert.deepEqual(def.stateSchema.parse(valid).ids, [id(nsA, 1)], 'parse returns a defensive copy')
  }

  // ---------- inbox 收集：真实访问方式 agent.inbox.nextTurn/nextStep ----------
  {
    const fakeAgent = { inbox: { nextTurn: [{ id: id(nsA, 1) }], nextStep: [{ id: 'ou_other' }, { id: id(nsA, 2) }] } }
    assert.deepEqual(larkAdmissionInboxIds(fakeAgent), [id(nsA, 1), 'ou_other', id(nsA, 2)], 'both inbox columns are read')
    assert.equal(larkAdmissionInboxIds(null), null, 'missing agent is fail-closed, not empty')
    assert.equal(larkAdmissionInboxIds({}), null, 'missing inbox is fail-closed')
    assert.equal(larkAdmissionInboxIds({ inbox: { nextTurn: 'x', nextStep: [] } }), null, 'bad inbox shape is fail-closed')
  }

  // ---------- 严格三态判据 ----------
  {
    const a5 = id(nsA, 5)
    const state = { ids: [id(nsA, 1), a5], evictedMax: { [nsA]: 2, [nsB]: 9 }, overflow: false }
    // admitted：inbox 命中
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: a5, inboxIds: [a5], projectionState: state }),
      { verdict: 'admitted', reason: 'inbox' },
      'inbox hit is admitted',
    )
    // admitted：投影命中
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: a5, inboxIds: [], projectionState: state }),
      { verdict: 'admitted', reason: 'projection' },
      'projection hit is admitted',
    )
    // not_admitted：未命中且 seq 在水位之上（确定未准入，可重投）
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(nsA, 3), inboxIds: [], projectionState: state }),
      { verdict: 'not_admitted', reason: 'proved_absent' },
      'seq above the watermark and absent proves non-admission',
    )
    // uncertain：seq 恰在水位上（可能被淘汰，禁止仅凭不存在重发）
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(nsA, 2), inboxIds: [], projectionState: state }),
      { verdict: 'uncertain', reason: 'evicted_waterline' },
      'at/below the watermark cannot prove absence',
    )
    // uncertain：投影缺失（未注册/未注入）
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(nsA, 3), inboxIds: [], projectionState: undefined }),
      { verdict: 'uncertain', reason: 'projection_missing' },
      'missing projection is fail-closed, never "not admitted"',
    )
    // uncertain：坏 shape
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(nsA, 3), inboxIds: [], projectionState: { ids: 'x', evictedMax: {}, overflow: false } }),
      { verdict: 'uncertain', reason: 'projection_invalid' },
      'corrupted projection state is fail-closed',
    )
    // uncertain：id 无法解析（未命中且无法比较水位）
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: 'garbage-id', inboxIds: [], projectionState: state }),
      { verdict: 'uncertain', reason: 'id_unparseable' },
      'unparseable ids are uncertain, never auto-redelivered',
    )
    // uncertain：inbox 收集失败（shape 坏）时也不能因为“没命中”就判 not_admitted——
    // 接线应传 null 并按 uncertain 处理；verdict 对非数组 inboxIds 视为无 inbox 证据，
    // 但投影仍可证明 admitted；两者都空才看水位。
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: a5, inboxIds: null, projectionState: state }),
      { verdict: 'admitted', reason: 'projection' },
      'projection alone can prove admission when inbox shape is unusable',
    )
    // namespace 隔离：nsB 的高水位不影响 nsA 的判定
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(nsA, 3), inboxIds: [], projectionState: state }),
      { verdict: 'not_admitted', reason: 'proved_absent' },
      'a high watermark in another namespace never gates this one',
    )
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(nsB, 5), inboxIds: [], projectionState: state }),
      { verdict: 'uncertain', reason: 'evicted_waterline' },
      'its own namespace watermark applies',
    )
  }

  // ---------- N1：水位 namespace 有界 + 溢出哨兵（缺席 ns 在溢出后必须 uncertain） ----------
  {
    assert.ok(LARK_ADMISSION_NS_LIMIT >= 16, 'namespace bound exported')
    const tiny = createLarkAdmissionDefinition({ idsPerSession: 1 })
    let state = tiny.init()
    // 注入 20 个不同 ns，各 1 条 id：cap=1 → 每次插入都淘汰，前 16 个 ns 记水位，之后溢出。
    for (let n = 0; n < 20; n += 1) {
      const ns = n.toString(16).padStart(8, '0')
      state = tiny.apply(state, { type: 'agent/inbox/spliced', data: { inserted: [{ id: id(ns, 10 + n) }] } })
    }
    assert.equal(Object.keys(state.evictedMax).length, LARK_ADMISSION_NS_LIMIT, 'watermark map never exceeds the namespace bound')
    assert.equal(state.overflow, true, 'overflow sentinel set once the bound is hit')
    const knownNs = Object.keys(state.evictedMax)[0]
    // 已知 ns：水位仍可正常判（保留的16个不受影响）
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(knownNs, 1), inboxIds: [], projectionState: state }),
      { verdict: 'uncertain', reason: 'evicted_waterline' },
      'retained namespaces still compare against their waterline',
    )
    // 溢出后缺席 ns：绝不可当水位 0 → not_admitted，必须 uncertain。
    const unknownNs = 'ffffffff'
    assert.equal(state.evictedMax[unknownNs], undefined, 'the 17th namespace is absent from the map')
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: id(unknownNs, 1), inboxIds: [], projectionState: state }),
      { verdict: 'uncertain', reason: 'waterline_overflow' },
      'absent namespace after overflow is uncertain, never a false not_admitted',
    )
    // 溢出不影响已存 ids 命中（仍 admitted）——无 false not_admitted。
    const survivor = id(knownNs, 11)
    let kept = tiny.init()
    kept = tiny.apply(kept, { type: 'agent/inbox/spliced', data: { inserted: [{ id: survivor }] } })
    kept = { ...state, ids: [survivor, ...state.ids.slice(0, 1)] }
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: survivor, inboxIds: [], projectionState: kept }),
      { verdict: 'admitted', reason: 'projection' },
      'ids hit stays admitted even under overflow',
    )
    // parse 拒绝：缺 overflow / overflow 非 bool / 超限 ns 条目（v2 严格校验）。
    assert.throws(() => def.stateSchema.parse({ ids: [], evictedMax: {} }), /unknown shape/, 'missing overflow field is rejected')
    assert.throws(() => def.stateSchema.parse({ ids: [], evictedMax: {}, overflow: 1 }), /overflow must be boolean/, 'overflow must be boolean')
    const manyNs = {}
    for (let n = 0; n <= LARK_ADMISSION_NS_LIMIT; n += 1) manyNs[n.toString(16).padStart(8, '0')] = 1
    assert.throws(() => def.stateSchema.parse({ ids: [], evictedMax: manyNs, overflow: true }), /namespace bound/, 'map over the bound is rejected')
    // stateVersion 兼容策略：v2 模块（未安装新模块可整体换版本，旧 cache 行按版本丢弃重 fold）。
    assert.equal(LARK_ADMISSION_STATE_VERSION, 2, 'stateVersion bumped for the overflow-shape change')
  }

  // ---------- 端到端形状：claim 分配的 id 直接进判据（与 ledger 一致） ----------
  {
    const umid = larkDedupUserMessageId(nsA, 42, 'cli_app', 'om_e2e')
    let state = def.init()
    state = def.apply(state, { type: 'agent/inbox/spliced', data: { inserted: [{ id: umid }] } })
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: umid, inboxIds: larkAdmissionInboxIds({ inbox: { nextTurn: [], nextStep: [] } }), projectionState: state }),
      { verdict: 'admitted', reason: 'projection' },
      'a claimed id admitted by followup is provably admitted via the projection',
    )
    const unseen = larkDedupUserMessageId(nsA, 43, 'cli_app', 'om_e2e')
    assert.deepEqual(
      larkAdmissionVerdict({ userMessageId: unseen, inboxIds: [], projectionState: state }),
      { verdict: 'not_admitted', reason: 'proved_absent' },
      'a claimed id never admitted is provably absent above the watermark',
    )
  }

  assert.deepEqual(unhandled, [], 'no unhandled rejections leaked')
  console.log('lark-admission: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
