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

// 手动驱动的假调度器（fake clock）：advance() 触发当前全部 timer（兼容旧断言）；
// tick(ms) 推进时钟只触发到期 timer；deadlines() 返回绝对到期时刻（now+ms），
// 用于断言“已有 deadline 不被范围操作推移”而非只数 timer 个数。
function createFakeScheduler() {
  let nextId = 1
  let now = 0
  const timers = new Map() // id → { fn, at }
  return {
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pending() {
      return timers.size
    },
    now() {
      return now
    },
    deadlines() {
      return [...timers.values()].map((t) => t.at).sort((x, y) => x - y)
    },
    // 兼容：不推进时钟，触发当前全部 timer
    advance() {
      const due = [...timers.values()]
      timers.clear()
      for (const t of due) t.fn()
    },
    // 推进时钟：只触发 at <= now 的 timer
    tick(ms) {
      now += ms
      const due = [...timers.entries()].filter(([, t]) => t.at <= now)
      for (const [id, t] of due) {
        timers.delete(id)
        t.fn()
      }
    },
  }
}

// 真实帧工厂：revision 每帧递增（start=1, chunk=2/3/..., end=最后一帧），
// 外层 index 为 attempt 内 dense 序号，end.index = chunk 总数。
// 传入 lifecycle（{rev:n}）时多个 attempt 共享同一 Agent lifecycle 级 revision 计数器，
// 模拟真实宿主 nextRevision() 跨 attempt 连续递增；缺省则每个 attempt 独立从 1 开始。
function frames(attemptId, turn, step, lifecycle) {
  const revState = lifecycle || { rev: 0 }
  let idx = 0
  const committed = { kind: 'committed', eventType: 'assistant/message', seq: 1 }
  return {
    start: () => ({ type: 'start', attemptId, revision: ++revState.rev, turn, step }),
    chunk: (text) => {
      idx += 1
      return {
        type: 'chunk',
        attemptId,
        revision: ++revState.rev,
        index: idx - 1,
        time: 1000 + idx,
        chunk: { type: 'text-delta', index: 0, text },
      }
    },
    reasoning: (text) => {
      idx += 1
      return {
        type: 'chunk',
        attemptId,
        revision: ++revState.rev,
        index: idx - 1,
        time: 1000 + idx,
        chunk: { type: 'reasoning-delta', index: 0, text },
      }
    },
    blockEnd: () => {
      idx += 1
      return {
        type: 'chunk',
        attemptId,
        revision: ++revState.rev,
        index: idx - 1,
        time: 1000 + idx,
        chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
      }
    },
    end: (outcome = committed) => ({ type: 'end', attemptId, revision: ++revState.rev, index: idx, outcome }),
  }
}

// 真实宿主全类型流工厂：与 mock-adapter.ts textResponse/toolCallResponse 同形——
// block-start / text-delta / tool-call-delta / block-end / usage / finish(reason 对象)，
// 外层 index 对每一帧 dense 递增（usage/finish 也占位），revision 共享 lifecycle 全局递增。
function realFrames(life, attemptId, turn, step) {
  let idx = 0
  return {
    start: () => ({ type: 'start', attemptId, revision: ++life.rev, turn, step }),
    chunk: (chunk) => ({ type: 'chunk', attemptId, revision: ++life.rev, index: idx++, time: 1000 + idx, chunk }),
    end: (outcome = { kind: 'committed', eventType: 'assistant/message', seq: 1 }) => ({
      type: 'end',
      attemptId,
      revision: ++life.rev,
      index: idx,
      outcome,
    }),
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

// 记录器：成功投递才入 calls；tries 计回调发起次数（含失败）；
// maxInFlight 验证串行；failX 注入前 N 次失败；order 记录跨回调顺序。
function createRecorder(create, opts = {}) {
  const { mode = 'text', delay = 0, scheduler, agentId = 'agent-a', sessionId = 'sess-1', throttleMs = 50 } = opts
  const calls = { delta: [], text: [], finish: [] }
  const tries = { delta: 0, text: 0, finish: 0 }
  const errors = []
  const order = []
  let inFlight = 0
  let maxInFlight = 0

  const hook = (bucket) => async (payload) => {
    tries[bucket] += 1
    inFlight += 1
    if (inFlight > maxInFlight) maxInFlight = inFlight
    try {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const failKey = `fail${bucket[0].toUpperCase()}${bucket.slice(1)}`
      if (opts[failKey] > 0) {
        opts[failKey] -= 1
        throw new Error(`${bucket} rejected`)
      }
      calls[bucket].push(payload)
      if (bucket === 'delta') order.push(`delta:${payload.delta}`)
      else if (bucket === 'text') order.push(`text:${payload.text}`)
      else order.push(`finish:${payload.reason}`) // 收卡是纯信号：正文不进 finish
    } finally {
      inFlight -= 1
    }
  }

  const stream = create({
    mode,
    agentId,
    sessionId,
    throttleMs,
    scheduler,
    sendTextDelta: hook('delta'),
    updateCardText: hook('text'),
    finishCard: hook('finish'),
    onError: (err) => errors.push(err),
  })
  return { calls, tries, errors, order, stream, maxConcurrent: () => maxInFlight }
}

;(async () => {
  const { createLarkStream, createLarkStreamHub } = await import(pathToFileURL(path.join(root, 'lib', 'lark-stream.js')).href)

  // ---------- T0 构造参数校验 ----------
  {
    assert.throws(() => createLarkStream({ updateCardText() {}, finishCard() {} }), TypeError)
    assert.throws(() => createLarkStream({ sendTextDelta() {}, finishCard() {} }), TypeError)
    assert.throws(() => createLarkStream({ sendTextDelta() {}, updateCardText() {} }), TypeError)
    const base = { sendTextDelta() {}, updateCardText() {}, finishCard() {} }
    assert.throws(() => createLarkStream({ ...base, mode: 'stream' }), TypeError)
    assert.throws(() => createLarkStream({ ...base, scheduler: {} }), TypeError)
    assert.throws(() => createLarkStreamHub().get('string-agent', 'S'), TypeError)
  }

  // ---------- T1 text 模式：真实 revision 1→2→…，三批 flush 先于 final/end ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const f = frames('a1', 1, 1)

    s.handleStart(f.start()) // rev1
    s.handleChunk(f.chunk('one')) // rev2 idx0
    assert.equal(sch.pending(), 1, '节流 timer 挂起')
    await s.idle()
    assert.equal(rec.calls.delta.length, 0, '节流窗口内不回调')
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 1)
    assert.equal(rec.calls.delta[0].delta, 'one')

    s.handleChunk(f.chunk('two')) // rev3 idx1
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 2)
    assert.equal(rec.calls.delta[1].delta, 'two')

    s.handleChunk(f.reasoning('思考…')) // rev4 idx2：非正文 chunk 只推进 revision/index
    s.handleChunk(f.chunk('three')) // rev5 idx3
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 3)
    assert.equal(rec.calls.delta[2].delta, 'three')
    assert.equal(s.state().text, 'onetwothree', 'reasoning 不进正文')

    // final/end 之前已多次输出（3 次实时 flush 全部先于 final/end，无 turn-end 参与）
    assert.equal(rec.calls.text.length, 0, 'text 模式正文只走 delta 通道（分流契约，card 实时见 T2）')
    assert.equal(rec.calls.finish.length, 0)
    s.handleChunk(f.blockEnd()) // block-end 帧占据外层 index/revision，不进正文
    await s.idle()
    assert.equal(s.state().text, 'onetwothree', 'reasoning/block-end 均不进正文')

    // 重复帧 / 过期 revision+index / 残缺帧 / 重复 start：全部去重忽略
    const threeFrame = { type: 'chunk', attemptId: 'a1', revision: 5, index: 3, time: 1003, chunk: { type: 'text-delta', index: 0, text: 'three' } }
    s.handleChunk(threeFrame) // 过期 revision+index（进度回退）
    s.handleChunk({ type: 'chunk', attemptId: 'a1', revision: 6, index: 4, time: 1004, chunk: { type: 'text-delta', index: 0, text: 'DUP' } }) // 相同 revision/index 重复帧
    s.handleChunk({ type: 'chunk', attemptId: 'a1', revision: 99, index: 99 }) // 缺 chunk 字段
    s.handleStart({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 }) // 重复 start
    s.handleStart({ attemptId: 'a9', revision: 1, turn: 1, step: 1 }) // 缺 type
    await s.idle()
    assert.equal(s.state().text, 'onetwothree', '重复/过期/残缺帧不进正文')

    s.handleChunk(f.chunk('four')) // rev7 idx5（block-end 占了 rev6 idx4）
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 4, 'final/end 前 4 次实时输出')
    assert.equal(rec.calls.delta[3].delta, 'four')

    // 最终 message：与已投递内容相同 → 补尾为空，去重不重发全文
    s.setFinalMessage('onetwothreefour', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.calls.delta.length, 4, '已全部投递时 final 不重发全文')
    s.setFinalMessage('onetwothreefour', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.calls.delta.length, 4, '重复最终 message 去重')
    assert.equal(s.state().finalText, 'onetwothreefour')

    const endFrame = f.end()
    s.handleEnd(endFrame)
    await s.idle()
    assert.equal(rec.calls.finish.length, 1, 'end 收卡一次')
    const fin = rec.calls.finish[0]
    assert.equal('text' in fin, false, '收卡是纯信号，不携带正文')
    assert.equal(fin.outcome.kind, 'committed')
    assert.equal(fin.reason, 'end')
    assert.equal(fin.attemptId, 'a1')
    assert.equal(sch.pending(), 0, 'end 清 timer')
    s.handleEnd(endFrame)
    await s.idle()
    assert.equal(rec.calls.finish.length, 1, '重复 end 去重')

    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'onetwothreefour', '多片段拼接唯一无重复')
    assert.equal(rec.maxConcurrent(), 1, '串行：至多一个在飞')
    assert.equal(rec.errors.length, 0)
    assert.deepEqual(rec.order, ['delta:one', 'delta:two', 'delta:three', 'delta:four', 'finish:end'])
  }

  // ---------- T1b end/turn flush：未到节流窗口也要先补发内容再收卡 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 } // Agent lifecycle 级连续 revision（同实例多 attempt）
    const f = frames('e1', 1, 1, life)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('tail'))
    assert.equal(sch.pending(), 1)
    s.handleEnd(f.end()) // 未经 advance：end 自己 flush
    await s.idle()
    assert.deepEqual(rec.order, ['delta:tail', 'finish:end'], '内容先于收卡（严格串行 await）')
    assert.equal(sch.pending(), 0, 'end 清 timer')

    const g = frames('e2', 1, 1, life)
    s.handleStart(g.start())
    s.handleChunk(g.chunk('quick'))
    s.flushTurn()
    await s.idle()
    assert.equal(rec.calls.delta.length, 2, 'turn flush 不等节流窗口')
    assert.equal(rec.calls.delta[1].reason, 'turn')
    assert.equal(sch.pending(), 0, 'turn flush 清 timer')
    await s.dispose()
  }

  // ---------- T2 card 模式：三次累计快照先于 final/end，严格串行 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'card', delay: 5, scheduler: sch })
    const s = rec.stream
    const f = frames('c1', 1, 1)

    s.handleStart(f.start())
    s.handleChunk(f.chunk('A'))
    sch.advance()
    await s.idle()
    s.handleChunk(f.chunk('B'))
    sch.advance()
    await s.idle()
    s.handleChunk(f.chunk('C'))
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.text.length, 3, 'final/end 前 3 次累计快照')
    assert.deepEqual(rec.calls.text.map((t) => t.text), ['A', 'AB', 'ABC'], '快照严格递增')
    assert.equal(rec.tries.delta, 0, 'sendTextDelta 不参与 card 模式')
    assert.equal(rec.maxConcurrent(), 1, '卡片更新严格串行 await')

    s.handleChunk(f.chunk('D')) // 不 advance，挂着
    s.setFinalMessage('ABCD', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.calls.text.length, 4, '最终快照一次')
    assert.equal(rec.calls.text[3].text, 'ABCD')
    assert.equal(rec.calls.text[3].source, 'final')
    s.setFinalMessage('ABCD', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.calls.text.length, 4, '重复最终快照去重')

    s.handleEnd(f.end())
    await s.idle()
    assert.equal(rec.calls.finish.length, 1, 'end 收卡')
    assert.equal(rec.calls.text.length, 4, 'end 不重复整卡正文')
    assert.equal(rec.tries.delta, 0)
    assert.equal(sch.pending(), 0)
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T2b end 正文更新必须先于收卡（挂起/拒绝都不阻断收尾） ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'card', delay: 20, scheduler: sch })
    const s = rec.stream
    const f = frames('h1', 1, 1)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('Hi')) // 不 advance：end 自己触发校正更新
    s.handleEnd(f.end())
    let done = false
    const idlePromise = s.idle().then(() => {
      done = true
    })
    await tick()
    assert.equal(rec.tries.text, 1, 'end 的内容更新已发起（在途）')
    assert.equal(rec.calls.text.length, 0, '更新尚未 resolve')
    assert.equal(rec.calls.finish.length, 0, '内容未完成前 finishCard 不得开始')
    assert.equal(done, false, 'idle 未完成：更新仍在串行链上等待')
    await idlePromise
    assert.deepEqual(rec.order, ['text:Hi', 'finish:end'], '先内容后收卡')
    assert.equal(rec.maxConcurrent(), 1)

    // end 路径的内容更新 reject → onError；收卡仍恰好一次
    const rec2 = createRecorder(createLarkStream, { mode: 'card', scheduler: sch, failText: 1 })
    const s2 = rec2.stream
    const g = frames('h2', 1, 1)
    s2.handleStart(g.start())
    s2.handleChunk(g.chunk('X'))
    s2.handleEnd(g.end())
    await s2.idle()
    assert.equal(rec2.tries.text, 1)
    assert.equal(rec2.errors.length, 1, 'end 内容更新失败进 onError（无 unhandled）')
    assert.equal(rec2.calls.finish.length, 1, '内容失败不阻断收卡，且只收一次')
    await s2.dispose()
  }

  // ---------- T3 最终 message 竞态：同步紧跟下一 start + 延迟网络，A 不污染 B ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', delay: 5, scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 } // 同一 Agent lifecycle 级连续 revision（真实 nextRevision 语义）
    const fA = frames('a1', 1, 1, life)
    const fB = frames('b1', 2, 1, life)

    s.handleStart(fA.start())
    s.handleChunk(fA.chunk('hello'))
    s.flushTurn()
    await tick() // 'hello' 进入在途（5ms 延迟网络）
    s.setFinalMessage('hello world', { turn: 1, step: 1 }) // final 入队
    s.handleStart(fB.start()) // 同步紧接下一 attempt 的 start
    await s.idle()

    assert.equal(rec.calls.delta.length, 2, '在途 hello + A 的 final 尾部')
    assert.deepEqual(rec.calls.delta.map((d) => d.delta), ['hello', ' world'])
    assert.ok(rec.calls.delta.every((d) => d.attemptId === 'a1'), 'A 的最终 message 只作用于 A')
    assert.equal(rec.calls.delta[1].reason, 'final')
    assert.equal(s.state().attemptId, 'b1')
    assert.equal(s.state().text, '', 'A 的 final 不污染 B')

    s.handleChunk(fB.chunk('B'))
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 3)
    assert.equal(rec.calls.delta[2].delta, 'B')
    assert.equal(rec.calls.delta[2].attemptId, 'b1')

    s.handleEnd(fA.end()) // A 的 end 收 A 的卡，不碰 B
    await s.idle()
    assert.equal(rec.calls.finish.length, 1)
    assert.equal(rec.calls.finish[0].attemptId, 'a1')

    s.setFinalMessage('B world', { turn: 2, step: 1 })
    s.handleEnd(fB.end())
    await s.idle()
    assert.equal(rec.calls.delta.length, 4, 'B 的 final 只补 B 的尾部')
    assert.equal(rec.calls.delta[3].delta, ' world')
    assert.equal(rec.calls.delta[3].attemptId, 'b1')
    assert.equal(rec.calls.finish.length, 2, '两张卡各收一次')
    assert.deepEqual(rec.calls.finish.map((x) => x.attemptId), ['a1', 'b1'])
    assert.equal(s.state().ended, true)
    assert.equal(rec.errors.length, 0)
    assert.equal(rec.maxConcurrent(), 1)
  }

  // ---------- T4 非流式：连续两 turn 各输出一次（text 模式 + card 模式） ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream

    s.setFinalMessage('reply one', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.calls.delta.length, 1, '非流式 turn1 全文一次')
    assert.equal(rec.calls.delta[0].delta, 'reply one')
    assert.equal(rec.calls.delta[0].reason, 'final')
    s.endTurn()
    await s.idle()
    assert.equal(rec.calls.finish.length, 1, 'turn1 收卡一次')

    s.setFinalMessage('reply two', { turn: 2, step: 1 })
    await s.idle()
    assert.equal(rec.calls.delta.length, 2, '非流式 turn2 全文一次（未被 turn1 的 ended 吞掉）')
    assert.equal(rec.calls.delta[1].delta, 'reply two')
    s.endTurn()
    await s.idle()
    assert.equal(rec.calls.finish.length, 2, 'turn2 收卡一次')

    s.setFinalMessage('reply two', { turn: 2, step: 1 }) // turn2 已结算的重复 final
    await s.idle()
    assert.equal(rec.calls.delta.length, 2, '已结算 turn 的重复 final 去重')
    assert.equal(rec.calls.text.length, 0, 'text 模式不用 card 通道')
    assert.equal(rec.errors.length, 0)
    await s.dispose()

    // card 模式非流式
    const rec2 = createRecorder(createLarkStream, { mode: 'card', scheduler: sch })
    const s2 = rec2.stream
    s2.setFinalMessage('card reply', { turn: 1, step: 1 })
    s2.endTurn()
    await s2.idle()
    assert.equal(rec2.calls.text.length, 1, 'card 非流式全文快照一次')
    assert.equal(rec2.tries.delta, 0, '非流式 card 模式不走 text 通道')
    assert.equal(rec2.calls.finish.length, 1)
    await s2.dispose()
  }

  // ---------- T5 attempt 身份隔离：retry/旧 end/abandoned/重复帧 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 } // Agent lifecycle 级连续 revision
    const f1 = frames('x1', 1, 1, life)

    s.handleStart(f1.start())
    s.handleChunk(f1.chunk('x'))
    sch.advance()
    await s.idle()
    const x1End = f1.end()
    s.handleEnd(x1End)
    await s.idle()
    assert.equal(rec.calls.finish.length, 1)
    assert.equal(rec.calls.finish[0].attemptId, 'x1')

    // retry：新 attempt（同 turn，不同 attemptId/step）
    const f2 = frames('x2', 1, 2, life)
    s.handleStart(f2.start())
    s.handleChunk(f2.chunk('y'))
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 2)
    assert.equal(rec.calls.delta[1].attemptId, 'x2')

    // 旧 end（x1 重放）→ 收旧卡逻辑忽略（已收过），绝不碰 x2
    s.handleEnd(x1End)
    await s.idle()
    assert.equal(rec.calls.finish.length, 1, '旧 end 不重复收卡、不碰新 attempt')

    // abandoned：丢弃未发送前缀，只收卡一次
    s.handleChunk(f2.chunk('z')) // 未 advance，挂起
    assert.equal(sch.pending(), 1)
    s.handleEnd(f2.end({ kind: 'abandoned' }))
    await s.idle()
    assert.equal(sch.pending(), 0, 'abandoned end 清 timer')
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'xy', 'abandoned 丢弃未发送前缀 z')
    assert.equal(rec.calls.finish.length, 2)
    const fin2 = rec.calls.finish[1]
    assert.equal(fin2.attemptId, 'x2')
    assert.equal(fin2.reason, 'abandoned')
    assert.equal(fin2.outcome.kind, 'abandoned')

    // ended 之后的 chunk 忽略；settled 后全文已释放（仅留身份墓碑）
    s.handleChunk(f2.chunk('w'))
    await s.idle()
    assert.equal(s.state().text, '', 'settled 后释放全文')
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'xy', 'z 被 abandoned 丢弃、w 被 ended 拒绝')
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T5b 多 attempt 替换 A→B→C：各自 end 收各自的卡 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 }
    const fA = frames('m1', 1, 1, life)
    const fB = frames('m2', 1, 2, life)
    const fC = frames('m3', 1, 3, life)

    s.handleStart(fA.start())
    s.handleChunk(fA.chunk('A1'))
    sch.advance()
    await s.idle()
    s.handleStart(fB.start()) // 替换 A（supersede：补发剩余，A 保留在册）
    s.handleChunk(fB.chunk('B1'))
    sch.advance()
    await s.idle()
    s.handleStart(fC.start()) // 替换 B
    s.handleChunk(fC.chunk('C1'))
    sch.advance()
    await s.idle()
    assert.deepEqual(rec.calls.delta.map((d) => d.delta), ['A1', 'B1', 'C1'])
    assert.deepEqual(rec.calls.delta.map((d) => d.attemptId), ['m1', 'm2', 'm3'])

    s.handleEnd(fA.end())
    s.handleEnd(fB.end())
    s.handleEnd(fC.end())
    await s.idle()
    assert.deepEqual(
      rec.calls.finish.map((x) => x.attemptId),
      ['m1', 'm2', 'm3'],
      '旧/新 attempt 的 end 各自收自己的卡，各一次',
    )
    assert.equal(s.state().attemptId, 'm3')
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T6 Hub：Agent 对象身份隔离（同 id 不同对象不共享状态） ----------
  {
    const sch = createFakeScheduler()
    const collected = { delta: [], text: [], finish: [] }
    const hub = createLarkStreamHub({
      mode: 'text',
      throttleMs: 50,
      scheduler: sch,
      sendTextDelta: (p) => collected.delta.push(p),
      updateCardText: (p) => collected.text.push(p),
      finishCard: (p) => collected.finish.push(p),
    })
    const agent1 = { id: 'same-agent' }
    const agent2 = { id: 'same-agent' } // 同字符串 id，不同对象身份
    const s1 = hub.get(agent1, 'S')
    const s2 = hub.get(agent2, 'S')
    assert.notEqual(s1, s2, '不同 Agent 对象绝不共享实例')
    assert.equal(hub.get(agent1, 'S'), s1, '同对象同 session 复用')
    assert.equal(hub.size(), 2)

    // 相同 attemptId 字符串、revision 都从 1 开始
    const f1 = frames('S:1', 1, 1)
    const f2 = frames('S:1', 1, 1)
    s1.handleStart(f1.start())
    s2.handleStart(f2.start())
    s1.handleChunk(f1.chunk('AAA'))
    s2.handleChunk(f2.chunk('BBB'))
    s1.handleChunk(f1.chunk('!'))
    sch.advance()
    await Promise.all([s1.idle(), s2.idle()])
    assert.deepEqual(collected.delta.map((d) => d.delta).sort(), ['AAA!', 'BBB'], '两侧正文互不串扰')
    assert.equal(s1.state().text, 'AAA!')
    assert.equal(s2.state().text, 'BBB')

    // hub.handle 帧路由（start 自动创建，chunk/end 不越权创建）
    await hub.handle(agent2, 'S', f2.chunk('?'))
    assert.equal(s2.state().text, 'BBB?')
    await hub.handle(agent1, 'ghost', f1.chunk('nope'))
    assert.equal(hub.has(agent1, 'ghost'), false, '非 start 帧不自动创建')

    // dispose 一个 Agent 的 session 不影响另一个对象（s1 已开的卡随 dispose 收一次）
    await hub.dispose(agent1, 'S')
    assert.equal(hub.has(agent1, 'S'), false)
    assert.equal(hub.has(agent2, 'S'), true)
    assert.equal(collected.finish.length, 1, 'dispose 收尾 s1 的卡')
    assert.equal(collected.finish[0].reason, 'dispose')
    await hub.handle(agent2, 'S', f2.end())
    await s2.idle()
    assert.equal(collected.finish.length, 2, 'agent2 的流仍正常工作')
    assert.equal(collected.finish[1].reason, 'end')
    assert.equal(hub.size(), 1)

    assert.throws(() => hub.get('string-agent', 'S'), TypeError, 'agent 必须是对象身份键')

    // disposeAgent：仍开着卡的 session 要收尾一次
    const s3 = hub.get(agent2, 'S2')
    const f3 = frames('S2:1', 1, 1)
    s3.handleStart(f3.start())
    s3.handleChunk(f3.chunk('CCC'))
    sch.advance()
    await s3.idle()
    assert.equal(hub.size(), 2)
    await hub.disposeAgent(agent2)
    assert.equal(hub.size(), 0)
    assert.equal(collected.finish.length, 3, 'disposeAgent 收尾仍开着的卡')
    assert.equal(collected.finish[2].reason, 'dispose')
  }

  // ---------- T7 abort / dispose：timer + 排队任务 + 在途请求 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', delay: 5, scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 } // Agent lifecycle 级连续 revision
    const f = frames('z1', 1, 1, life)

    s.handleStart(f.start())
    s.handleChunk(f.chunk('a'))
    s.flushTurn()
    await tick() // 'a' 在途（不可撤销）
    s.handleChunk(f.chunk('b'))
    s.flushTurn() // 已入队未执行
    s.handleChunk(f.chunk('c')) // 节流 timer 挂起
    assert.equal(sch.pending(), 1)
    s.abort()
    assert.equal(sch.pending(), 0, 'abort 清 timer')
    await s.idle()
    assert.deepEqual(rec.calls.delta.map((d) => d.delta), ['a'], '仅在途请求完成，排队任务不再启动')
    assert.equal(rec.tries.delta, 1, '被取消的任务未发起回调')
    assert.equal(rec.calls.finish.length, 1, 'abort 立即收卡一次')
    assert.equal(rec.calls.finish[0].reason, 'abort')
    assert.equal(rec.calls.finish[0].aborted, true)
    assert.ok(rec.order.indexOf('delta:a') < rec.order.indexOf('finish:abort'), '收卡等待在途请求完成')

    s.handleEnd(f.end()) // 迟到 end：不重复收卡、不再输出
    await s.idle()
    assert.equal(rec.calls.finish.length, 1)
    assert.equal(rec.calls.delta.length, 1)

    // abort 后新 attempt 恢复
    const g = frames('z2', 2, 1, life)
    s.handleStart(g.start())
    s.handleChunk(g.chunk('ok'))
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 2)
    assert.equal(rec.calls.delta[1].delta, 'ok')
    assert.equal(rec.calls.delta[1].attemptId, 'z2')
    await s.dispose()

    // dispose：清 timer、取消排队正文、已开的卡收一次
    const rec2 = createRecorder(createLarkStream, { mode: 'text', delay: 5, scheduler: sch })
    const s2 = rec2.stream
    const h = frames('d1', 1, 1)
    s2.handleStart(h.start())
    s2.handleChunk(h.chunk('a'))
    s2.flushTurn()
    await tick()
    s2.handleChunk(h.chunk('b'))
    s2.flushTurn()
    s2.handleChunk(h.chunk('c'))
    assert.equal(sch.pending(), 1)
    s2.dispose()
    assert.equal(sch.pending(), 0, 'dispose 清 timer')
    await s2.idle()
    assert.deepEqual(rec2.calls.delta.map((d) => d.delta), ['a'], 'dispose 后不再启动正文请求')
    assert.equal(rec2.tries.delta, 1)
    assert.equal(rec2.calls.finish.length, 1, 'dispose 收尾已开的卡')
    assert.equal(rec2.calls.finish[0].reason, 'dispose')

    // dispose 后所有输入 no-op
    const i = frames('d2', 9, 9)
    s2.handleStart(i.start())
    s2.handleChunk(i.chunk('x'))
    s2.setFinalMessage('x', { turn: 9, step: 9 })
    s2.flushTurn()
    s2.endTurn()
    s2.handleEnd(i.end())
    s2.abort()
    await s2.idle()
    assert.equal(rec2.tries.delta + rec2.tries.text + rec2.tries.finish, 2, 'dispose 后输入全部 no-op')
    assert.equal(s2.state().disposed, true)

    // 从未产生输出的流 dispose 不收卡
    const rec3 = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    await rec3.stream.dispose()
    await rec3.stream.idle()
    assert.equal(rec3.tries.finish, 0, '无卡不收尾')

    // 无任何 end 帧的中止：卡不得悬挂
    const rec4 = createRecorder(createLarkStream, { mode: 'text', delay: 5, scheduler: sch })
    const s4 = rec4.stream
    const k = frames('n1', 1, 1)
    s4.handleStart(k.start())
    s4.handleChunk(k.chunk('a'))
    s4.flushTurn()
    await tick()
    s4.handleChunk(k.chunk('b'))
    s4.flushTurn() // 排队待发
    s4.abort() // 之后永远没有 end 帧
    assert.equal(sch.pending(), 0)
    await s4.idle()
    assert.deepEqual(rec4.calls.delta.map((d) => d.delta), ['a'], '排队任务被取消，在途完成')
    assert.equal(rec4.calls.finish.length, 1, '无 end 也已收卡（不悬挂）')
    assert.equal(rec4.calls.finish[0].reason, 'abort')
    await s4.dispose()
  }

  // ---------- T8 回调失败：不提前 published、onError、无无限重试 ----------
  {
    // (a) text 模式 sendTextDelta 失败一次
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch, failDelta: 1 })
    const s = rec.stream
    const f = frames('f1', 1, 1)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('x'))
    sch.advance()
    await s.idle()
    assert.equal(rec.tries.delta, 1, '失败被计入发起次数')
    assert.equal(rec.calls.delta.length, 0, '失败不计入投递')
    assert.equal(rec.errors.length, 1, 'onError 收到 reject')
    assert.equal(s.state().sent, 0, '失败不推进 sent/published')

    s.handleChunk(f.chunk('y'))
    assert.equal(sch.pending(), 0, '失败后自动节流不重试（无 timer）')
    s.flushTurn() // 显式补试一次
    await s.idle()
    assert.equal(rec.tries.delta, 2, '至多一次显式补试')
    assert.deepEqual(rec.calls.delta.map((d) => d.delta), ['xy'])
    assert.equal(s.state().outputFailed, false, '补试成功后恢复')
    s.handleEnd(f.end())
    await s.idle()
    assert.equal(rec.calls.finish.length, 1)
    assert.equal(rec.errors.length, 1)

    // (b) card 模式 updateCardText 失败一次：published 不提前
    const rec2 = createRecorder(createLarkStream, { mode: 'card', scheduler: sch, failText: 1 })
    const s2 = rec2.stream
    const g = frames('f2', 1, 1)
    s2.handleStart(g.start())
    s2.handleChunk(g.chunk('A'))
    sch.advance()
    await s2.idle()
    assert.equal(rec2.tries.text, 1)
    assert.equal(rec2.calls.text.length, 0)
    assert.equal(rec2.errors.length, 1)
    assert.equal(s2.state().published, '', '失败不提前标 published')

    s2.handleChunk(g.chunk('B'))
    assert.equal(sch.pending(), 0, 'card 失败后自动不重试')
    s2.setFinalMessage('AB', { turn: 1, step: 1 }) // 显式最终 message 补试
    await s2.idle()
    assert.equal(rec2.tries.text, 2)
    assert.equal(s2.state().published, 'AB', '成功后才标 published')
    s2.handleEnd(g.end())
    await s2.idle()
    assert.equal(rec2.calls.finish.length, 1)
    assert.equal(rec2.errors.length, 1)

    // (c) finishCard 失败：只报错不重试
    const rec3 = createRecorder(createLarkStream, { mode: 'text', scheduler: sch, failFinish: 1 })
    const s3 = rec3.stream
    s3.setFinalMessage('ok', { turn: 1, step: 1 })
    s3.endTurn()
    await s3.idle()
    assert.equal(rec3.tries.finish, 1)
    assert.equal(rec3.errors.length, 1, 'finish 失败进 onError')
    s3.endTurn()
    await s3.idle()
    assert.equal(rec3.tries.finish, 1, '收卡失败不重试')

    // (d) 最终 message 与已投递前缀分歧：报错且不重发
    const rec4 = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s4 = rec4.stream
    const h = frames('f4', 1, 1)
    s4.handleStart(h.start())
    s4.handleChunk(h.chunk('abc'))
    sch.advance()
    await s4.idle()
    assert.equal(rec4.calls.delta.length, 1)
    s4.setFinalMessage('xyz', { turn: 1, step: 1 })
    await s4.idle()
    assert.equal(rec4.errors.length, 1, '分歧上报 onError')
    assert.equal(rec4.tries.delta, 1, '分歧不重发已投递内容')
    s4.handleEnd(h.end())
    await s4.idle()
    assert.equal(rec4.calls.finish.length, 1, '分歧仍正常收卡')
  }

  // ---------- T9 跨 chunk 代理对：实时缓冲完整字符；畸形扣留、onError、安全收尾 ----------
  {
    const sch = createFakeScheduler()

    // (1) text 模式：高代理在 chunk 尾部 → 缓冲，补齐低代理后完整发出
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const f = frames('u1', 1, 1)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('a\uD83D')) // 😀 的高代理在尾部
    sch.advance()
    await s.idle()
    assert.equal(rec.tries.delta, 1)
    assert.equal(rec.calls.delta[0].delta, 'a', '尾部高代理被缓冲，不发不完整字符')
    s.handleChunk(f.chunk('\uDE00b')) // 低代理补齐 + 后续文本
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta[1].delta, '\uD83D\uDE00b', '补齐后完整字符才发出')
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'a😀b', '拼接唯一且代理对未被拆开')
    assert.equal(rec.errors.length, 0, '可补齐的代理对不报错')
    s.handleEnd(f.end())
    await s.idle()
    assert.equal(rec.calls.finish.length, 1)
    await s.dispose()

    // (2) 最终仍非法（孤立高代理）：明确 onError + 扣留不投（不把坏文本交拆分器）+ 安全收尾
    const rec2 = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s2 = rec2.stream
    const g = frames('u2', 1, 1)
    s2.handleStart(g.start())
    s2.handleChunk(g.chunk('x\uD83D'))
    sch.advance()
    await s2.idle()
    assert.equal(rec2.calls.delta[0].delta, 'x', '实时仍缓冲高代理')
    assert.equal(rec2.errors.length, 0)
    assert.equal(s2.state().outputBlocked, false)
    s2.setFinalMessage('x\uD83D', { turn: 1, step: 1 })
    await s2.idle()
    assert.equal(rec2.errors.length, 1, '最终非法 → 明确错误')
    assert.match(rec2.errors[0].message, /lone UTF-16 surrogate/)
    assert.match(rec2.errors[0].message, /withheld/)
    assert.equal(rec2.tries.delta, 1, '畸形 remainder 扣留：绝不投给拆分器')
    assert.equal(rec2.calls.delta.map((d) => d.delta).join(''), 'x', '只交付过合法前缀')
    assert.equal(s2.state().outputBlocked, true, '安全中止：后续正文不再投递')
    s2.handleEnd(g.end())
    await s2.idle()
    assert.equal(rec2.calls.finish.length, 1, '安全收尾（卡正常关闭）')
    assert.equal(rec2.errors.length, 1, '不重复报错')
    await s2.dispose()

    // (3) card 模式：累计快照同样只发完整字符
    const rec3 = createRecorder(createLarkStream, { mode: 'card', scheduler: sch })
    const s3 = rec3.stream
    const h = frames('u3', 1, 1)
    s3.handleStart(h.start())
    s3.handleChunk(h.chunk('q\uD83D'))
    sch.advance()
    await s3.idle()
    assert.equal(rec3.calls.text[0].text, 'q', 'card 实时快照缓冲尾部高代理')
    s3.handleChunk(h.chunk('\uDE00'))
    sch.advance()
    await s3.idle()
    assert.equal(rec3.calls.text[1].text, 'q😀', '补齐后累计快照含完整字符')
    assert.equal(rec3.errors.length, 0)
    await s3.dispose()
  }

  // ---------- T10 P1-1：final 尾部失败后，end/endTurn 必须按最终目标补发 ----------
  {
    const sch = createFakeScheduler()
    const cfg = { mode: 'text', scheduler: sch }
    const rec = createRecorder(createLarkStream, cfg)
    const s = rec.stream
    const f = frames('f1', 1, 1)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('a'))
    sch.advance()
    await s.idle()
    assert.deepEqual(rec.calls.delta.map((d) => d.delta), ['a'])

    cfg.failDelta = 1 // 只让 final 这次失败
    s.setFinalMessage('ab', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.errors.length, 1)
    assert.equal(s.state().finalText, 'ab', 'finalText 是收尾目标，失败也保留')
    assert.equal(s.state().sent, 1, '失败不推进 sent')
    assert.equal(s.state().text, 'a', '失败不推进正文')
    assert.equal(s.state().outputFailed, true)

    s.handleEnd(f.end()) // 真实 end 必须把 b 补上，不能只 finish 丢 b
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'ab', 'end 按最终目标只补缺尾 b')
    assert.equal(rec.tries.delta, 3, 'a + 失败的 ab + 补发的 b')
    assert.equal(rec.calls.finish.length, 1)
    assert.equal(rec.errors.length, 1)
    await s.dispose()

    // 非流式首次 final 失败 → endTurn 补全文
    const cfg2 = { mode: 'text', scheduler: sch, failDelta: 1 }
    const rec2 = createRecorder(createLarkStream, cfg2)
    const s2 = rec2.stream
    s2.setFinalMessage('xy', { turn: 1, step: 1 })
    await s2.idle()
    assert.equal(rec2.calls.delta.length, 0, '首次 final 失败')
    assert.equal(s2.state().finalText, 'xy')
    s2.endTurn()
    await s2.idle()
    assert.equal(rec2.calls.delta.map((d) => d.delta).join(''), 'xy', 'endTurn 补发全文')
    assert.equal(rec2.calls.finish.length, 1)
    await s2.dispose()

    // card 模式：final 快照失败后 end 按最终目标补发，不丢内容
    const cfg3 = { mode: 'card', scheduler: sch }
    const rec3 = createRecorder(createLarkStream, cfg3)
    const s3 = rec3.stream
    const g3 = frames('g1', 1, 1)
    s3.handleStart(g3.start())
    s3.handleChunk(g3.chunk('A'))
    sch.advance()
    await s3.idle()
    assert.deepEqual(rec3.calls.text.map((t) => t.text), ['A'])
    cfg3.failText = 1
    s3.setFinalMessage('AB', { turn: 1, step: 1 })
    await s3.idle()
    assert.equal(rec3.errors.length, 1)
    assert.equal(s3.state().published, 'A', 'final 失败不推进 published')
    s3.handleEnd(g3.end())
    await s3.idle()
    assert.equal(rec3.calls.text.map((t) => t.text).join('|'), 'A|AB', 'end 按最终目标补发快照')
    assert.equal(rec3.tries.text, 3)
    assert.equal(rec3.calls.finish.length, 1)
    await s3.dispose()
  }

  // ---------- T11 P1-2：旧 A 的 end 不得清掉 B 的节流 timer ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 }
    const fA = frames('a1', 1, 1, life)
    const fB = frames('b1', 2, 1, life)

    s.handleStart(fA.start())
    s.handleChunk(fA.chunk('a')) // A 未发，timer 挂起
    s.handleStart(fB.start()) // 替换 A
    s.handleChunk(fB.chunk('b')) // B 待节流
    assert.equal(sch.pending(), 1)
    s.handleEnd(fA.end()) // 旧 A 的 end
    assert.equal(sch.pending(), 1, '旧 end 不清新 attempt 的 timer（回归：旧实现此处变 0）')
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'a', 'A 补发并收卡')
    assert.equal(rec.calls.finish[0].attemptId, 'a1')
    assert.equal(s.state().attemptId, 'b1')
    assert.equal(s.state().sent, 0, 'B 仍在等节流窗口')
    sch.advance() // 等待节流窗口：B 必须能发
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'ab', 'B 未因旧 end 断粮')
    assert.equal(rec.calls.delta[1].attemptId, 'b1')
    await s.dispose()
  }

  // ---------- T12 P1-3：start B 后迟到的 A final 归原 attempt，不换 current、不重发 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 }
    const fA = frames('a1', 1, 1, life)
    const fB = frames('b1', 2, 1, life)

    s.handleStart(fA.start())
    s.handleChunk(fA.chunk('A'))
    sch.advance()
    await s.idle()
    s.handleStart(fB.start()) // B 成为 current
    s.setFinalMessage('A full', { turn: 1, step: 1 }) // 迟到的 A final
    await s.idle()
    assert.equal(rec.calls.delta.length, 2)
    assert.equal(rec.calls.delta[1].delta, ' full', '迟到 final 归原 attempt 补尾')
    assert.equal(rec.calls.delta[1].attemptId, 'a1', '以 A 身份投递')
    assert.equal(s.state().attemptId, 'b1', 'current 仍是 B（回归：旧实现换成 turn1 虚拟）')
    assert.equal(s.state().turn, 2)

    s.handleEnd(fA.end())
    await s.idle()
    assert.deepEqual(rec.calls.finish.map((x) => x.attemptId), ['a1'])

    // A 已结算的重复 final：去重不重发
    s.setFinalMessage('A full', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.calls.delta.length, 2, '已结算 final 去重不重发')
    assert.equal(s.state().attemptId, 'b1')

    s.handleChunk(fB.chunk('B'))
    sch.advance()
    await s.idle()
    s.handleEnd(fB.end())
    await s.idle()
    assert.deepEqual(rec.calls.finish.map((x) => x.attemptId), ['a1', 'b1'])
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T13 P1-4：同 turn 多 step，endTurn(identity) 收全部且不碰下一 turn ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'card', scheduler: sch })
    const s = rec.stream

    s.setFinalMessage('step-one', { turn: 1, step: 1 })
    s.setFinalMessage('step-two', { turn: 1, step: 2 }) // 同 turn 新 step → 新虚拟 attempt，step1 卡不泄漏
    s.setFinalMessage('turn-two', { turn: 2, step: 1 }) // 下一 turn 先开着
    await s.idle()
    assert.deepEqual(rec.calls.text.map((t) => t.text), ['step-one', 'step-two', 'turn-two'])
    assert.equal(s.state().attempts, 3)

    s.endTurn({ turn: 1 }) // 只收 turn1 的两张卡
    await s.idle()
    assert.equal(rec.calls.finish.length, 2, '同 turn 两 step 都收卡（回归：旧实现只收最后一步）')
    assert.deepEqual(rec.calls.finish.map((x) => x.step), [1, 2])
    assert.deepEqual(rec.calls.finish.map((x) => x.turn), [1, 1])

    // turn2 不受影响：卡仍开、内容还能更新
    s.setFinalMessage('turn-two-more', { turn: 2, step: 1 })
    await s.idle()
    assert.equal(rec.calls.text.length, 4, 'turn2 的卡未被 turn1 的 endTurn 关掉')
    assert.equal(rec.calls.text[3].text, 'turn-two-more')

    s.endTurn({ turn: 2 })
    await s.idle()
    assert.equal(rec.calls.finish.length, 3)
    assert.deepEqual(rec.calls.finish.map((x) => x.turn), [1, 1, 2])
    await s.dispose()
  }

  // ---------- T14 P1-5：end 已同步置位后，abort 仍取消尚未执行的正文 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const f = frames('e1', 1, 1)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('x'))
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.length, 1, 'x 已发，卡已开')

    s.handleChunk(f.chunk('y')) // 未发，待 flush
    s.handleEnd(f.end()) // 同步置 ended，flush+finish 入队
    s.abort() // settled 前必须仍能取消正文
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'x', '排队正文被 abort 取消（回归：旧实现仍发 y）')
    assert.equal(rec.tries.delta, 1)
    assert.equal(rec.calls.finish.length, 1, 'finish 恰一次')
    assert.equal(rec.calls.finish[0].aborted, true, 'abort 已生效')
    assert.equal(s.state().cancelled, true)
    assert.equal(sch.pending(), 0)
    await s.dispose()
  }

  // ---------- T15 P1-6：deliveryUnknown 禁盲重试；确定失败有有限上限；ok:false 当失败 ----------
  {
    // (a) 未知投递：对端已收但 reject deliveryUnknown → 禁止一切正文重发
    const sch = createFakeScheduler()
    const delivered = []
    const errors = []
    const finishes = []
    const s = createLarkStream({
      mode: 'text',
      throttleMs: 50,
      scheduler: sch,
      sendTextDelta: (p) => {
        delivered.push(p.delta)
        const err = new Error('unknown delivery')
        err.deliveryUnknown = true
        throw err
      },
      updateCardText: () => {},
      finishCard: (p) => finishes.push(p),
      onError: (err) => errors.push(err),
    })
    const f = frames('u1', 1, 1)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('x'))
    sch.advance()
    await s.idle()
    assert.deepEqual(delivered, ['x'], '回调已记录投递后抛未知错误')
    assert.equal(errors.length, 1)
    assert.equal(s.state().deliveryUnknown, true)
    assert.equal(s.state().sent, 0, '未知投递不能当成功推进')

    s.handleChunk(f.chunk('y'))
    assert.equal(sch.pending(), 0, '未知投递后无自动重试 timer')
    s.setFinalMessage('xy', { turn: 1, step: 1 })
    s.setFinalMessage('xy', { turn: 1, step: 1 })
    s.setFinalMessage('xy', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(delivered.length, 1, '重复 final 不得盲重发（回归：旧实现 delivered=3）')
    s.handleEnd(f.end())
    await s.idle()
    assert.equal(finishes.length, 1, '未知投递仍正常收卡')
    assert.equal(errors.length, 1, '被拦下的 final 不重复报错')

    // (b) 确定失败：连续失败达上限后显式补试也停止（有限、不无限）
    const cfg = { mode: 'text', scheduler: sch, failDelta: 99 }
    const rec = createRecorder(createLarkStream, cfg)
    const s2 = rec.stream
    const g = frames('u2', 1, 1)
    s2.handleStart(g.start())
    s2.handleChunk(g.chunk('x'))
    sch.advance()
    await s2.idle()
    assert.equal(rec.tries.delta, 1, 'live 失败 1')
    s2.flushTurn()
    await s2.idle()
    assert.equal(rec.tries.delta, 2, '显式补试 2（上限内）')
    s2.flushTurn()
    s2.flushTurn()
    await s2.idle()
    assert.equal(rec.tries.delta, 2, '达上限后不再发起（回归：旧实现无上限）')
    s2.setFinalMessage('x', { turn: 1, step: 1 })
    await s2.idle()
    assert.equal(rec.tries.delta, 2, '上限对 final 同样生效')
    s2.handleEnd(g.end())
    await s2.idle()
    assert.equal(rec.errors.length, 2, '只报实际发起的失败')
    assert.equal(rec.calls.finish.length, 1, '仍收卡一次')

    // (c) 结构化 {ok:false} 不算成功
    let phase = 'fail'
    const errors3 = []
    const s3 = createLarkStream({
      mode: 'text',
      throttleMs: 50,
      scheduler: sch,
      sendTextDelta: () => (phase === 'fail' ? { ok: false, error: 'nope' } : 'ok'),
      updateCardText: () => {},
      finishCard: () => {},
      onError: (err) => errors3.push(err),
    })
    const h = frames('u3', 1, 1)
    s3.handleStart(h.start())
    s3.handleChunk(h.chunk('z'))
    sch.advance()
    await s3.idle()
    assert.equal(errors3.length, 1, 'ok:false 按失败上报')
    assert.equal(s3.state().sent, 0, 'ok:false 不推进 sent')
    assert.equal(s3.state().outputFailed, true)
    phase = 'ok'
    s3.flushTurn()
    await s3.idle()
    assert.equal(s3.state().sent, 1, '确定失败的有界补试可用')
    s3.handleEnd(h.end())
    await s3.idle()
    assert.equal(errors3.length, 1)
  }

  // ---------- T16 P2：严格 revision 单调 / dense index 连续 / end 计数 / shape ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const f = frames('p1', 1, 1)
    const startFrame = f.start() // rev1
    const accepted = f.chunk('A') // rev2 idx0
    s.handleStart(startFrame)
    s.handleChunk(accepted)
    await s.idle()
    assert.equal(s.state().text, 'A')

    // 等 revision + 新 index：协议违约，onError 后拒绝
    s.handleChunk({ type: 'chunk', attemptId: 'p1', revision: 2, index: 1, time: 1, chunk: { type: 'text-delta', index: 0, text: 'BAD' } })
    await s.idle()
    assert.equal(rec.errors.length, 1, '等 revision 新 index 被拒并上报')
    assert.equal(s.state().text, 'A')

    // revision 前进但 index 跳号：丢帧上报后拒绝
    s.handleChunk({ type: 'chunk', attemptId: 'p1', revision: 3, index: 5, time: 2, chunk: { type: 'text-delta', index: 0, text: 'GAP' } })
    await s.idle()
    assert.equal(rec.errors.length, 2, 'index 跳号被拒并上报（不静默丢）')
    assert.equal(s.state().text, 'A')

    // 重复帧：静默幂等，不报错
    s.handleChunk(accepted)
    await s.idle()
    assert.equal(rec.errors.length, 2, '重复帧静默去重')
    assert.equal(s.state().text, 'A')

    s.handleChunk(f.chunk('B')) // rev4 idx1 正常
    await s.idle()
    assert.equal(s.state().text, 'AB')

    // end 计数 != chunk 总数：拒绝并上报，不收卡
    s.handleEnd({ type: 'end', attemptId: 'p1', revision: 5, index: 9, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
    await s.idle()
    assert.equal(rec.errors.length, 3, '非法 end 计数被拒并上报')
    assert.equal(rec.calls.finish.length, 0, '非法 end 不收卡')

    // 非法 shape：防御性静默拒绝（NaN / 字符串 / 未知 attemptId）
    s.handleChunk({ type: 'chunk', attemptId: 'p1', revision: NaN, index: 2, time: 1, chunk: { type: 'text-delta', index: 0, text: 'X' } })
    s.handleStart({ type: 'start', attemptId: 'zz', revision: 'x', turn: 1, step: 1 })
    s.handleEnd({ type: 'end', attemptId: 'never-seen', revision: 99, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
    await s.idle()
    assert.equal(rec.errors.length, 3, '非法 shape/未知 end 防御性静默拒绝')
    assert.equal(s.state().attempts, 1, '非法 start 不建 attempt')
    assert.equal(rec.calls.finish.length, 0, '未知 end 不猜归属、不收卡')

    // 合法 end：rev6 idx2 = lastIndex(1)+1
    s.handleEnd(f.end())
    await s.idle()
    assert.equal(rec.calls.finish.length, 1, '合法 end 正常收卡')
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'AB')
    await s.dispose()
  }

  // ---------- T16b 17:08 P2 探针原序：start rev1 → chunk rev1 idx0 → chunk rev2 idx5 → end rev3 idx0 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    s.handleStart({ type: 'start', attemptId: 'pr', revision: 1, turn: 1, step: 1 })
    s.handleChunk({ type: 'chunk', attemptId: 'pr', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'same' } })
    s.handleChunk({ type: 'chunk', attemptId: 'pr', revision: 2, index: 5, time: 2, chunk: { type: 'text-delta', index: 0, text: 'gap' } })
    await s.idle()
    assert.equal(rec.errors.length, 2, '等 revision 新 index 与跳号都拒绝并上报（回归：旧实现全接受）')
    assert.equal(rec.tries.delta, 0, '坏帧正文一条都没发出')
    assert.equal(s.state().text, '', '正文不被污染')
    // end 计数对账“已接受”的 chunk：0 个被接受 → idx0 合法；从未开卡则无卡可收
    s.handleEnd({ type: 'end', attemptId: 'pr', revision: 3, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
    await s.idle()
    assert.equal(s.state().ended, true, '合法 end 被处理')
    assert.equal(rec.tries.finish, 0, '从未投递过正文 → 没有卡可收（不凭空收卡）')
    assert.equal(rec.errors.length, 2, 'end 本身合法不额外报错')
    await s.dispose()
  }

  // ---------- T17 P2：settled 释放全文 + 墓碑挡重复 final + 墓碑容量有界 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream

    s.setFinalMessage('done', { turn: 1, step: 1 })
    s.endTurn()
    await s.idle()
    assert.equal(rec.tries.delta, 1)
    assert.equal(rec.calls.finish.length, 1)
    assert.equal(s.state().text, '', 'settled 后释放全文（不随轮次线性积累）')
    assert.equal(s.state().finalText, null, 'settled 后释放 finalText')
    assert.equal(s.state().settled, true)
    assert.equal(s.state().attemptId, null, '虚拟墓碑 attemptId')
    assert.equal(s.state().turn, 1, '身份墓碑保留 turn（挡重复 final）')

    s.setFinalMessage('done', { turn: 1, step: 1 }) // 墓碑命中 → 去重
    s.endTurn({ turn: 1 })
    await s.idle()
    assert.equal(rec.tries.delta, 1, '墓碑挡重复 final，不重发')
    assert.equal(rec.calls.finish.length, 1, '重复 endTurn 不重复收卡')

    // 墓碑容量有界
    for (let i = 1; i <= 40; i++) {
      s.setFinalMessage(`r${i}`, { turn: 100 + i, step: 1 })
      s.endTurn({ turn: 100 + i })
    }
    await s.idle()
    assert.ok(s.state().attempts <= 32, `墓碑容量有界（实际 ${s.state().attempts} <= 32）`)
    assert.equal(rec.tries.delta, 41, '40 轮各自输出一次，无重复')
    assert.equal(rec.calls.finish.length, 41)
    assert.equal(rec.errors.length, 0)

    // 淘汰后重放历史 turn1 final：结算水位线挡复活（回归：旧实现会变 42 次投递）
    assert.ok(s.state().settledTurnWatermark >= 140, `水位线已推进（${s.state().settledTurnWatermark}）`)
    s.setFinalMessage('done', { turn: 1, step: 1 })
    await s.idle()
    assert.equal(rec.tries.delta, 41, '被淘汰墓碑的历史 final 不复活')
    assert.equal(s.state().turn, 140, 'current 不被历史 turn 替换')

    // 新 turn / 同 turn 新 step 不被水位线误拒
    s.setFinalMessage('fresh', { turn: 141, step: 1 })
    s.endTurn({ turn: 141 })
    await s.idle()
    assert.equal(rec.tries.delta, 42, '新 turn 正常输出')
    s.setFinalMessage('fresh-step2', { turn: 141, step: 2 })
    s.endTurn({ turn: 141, step: 2 })
    await s.idle()
    assert.equal(rec.tries.delta, 43, '同 turn 新 step 不被水位线误拒')
    assert.equal(rec.calls.finish.length, 43)
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T18 17:40 P1-1：真实全类型流（block/usage/对象 finish）必须能收卡 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 }

    // mock-adapter textResponse 完整形状：finish.reason 是对象而非字符串
    const a1 = realFrames(life, 'full1', 1, 1)
    s.handleStart(a1.start())
    s.handleChunk(a1.chunk({ type: 'block-start', index: 0, blockType: 'text' }))
    s.handleChunk(a1.chunk({ type: 'text-delta', index: 0, text: 'Hello' }))
    s.handleChunk(a1.chunk({ type: 'text-delta', index: 0, text: ' world' }))
    s.handleChunk(a1.chunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } }))
    s.handleChunk(a1.chunk({ type: 'usage', usage: { inputTokens: 10, outputTokens: 11 } }))
    s.handleChunk(a1.chunk({ type: 'finish', reason: { kind: 'stop' } }))
    s.handleEnd(a1.end())
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'Hello world', '正常成功流正文完整')
    assert.equal(rec.errors.length, 0, '全类型帧合法（回归：旧实现拒对象 finish reason → end 计数不符）')
    assert.equal(s.state().ended, true, '合法 end 被接受')
    assert.equal(rec.calls.finish.length, 1, '正常成功流能收卡')

    // 其余真实 FinishReason 变体（含 error/aborted 带 failure）+ tool-call 块
    const reasons = [
      { kind: 'tool-calls' },
      { kind: 'max-tokens' },
      { kind: 'error', failure: { message: 'boom', code: 'PROVIDER_ERROR' } },
      { kind: 'aborted', failure: { message: 'stop', code: 'ABORTED' } },
    ]
    for (let i = 0; i < reasons.length; i++) {
      const a = realFrames(life, `fr${i}`, 2 + i, 1)
      s.handleStart(a.start())
      s.handleChunk(a.chunk({ type: 'block-start', index: 0, blockType: 'text' }))
      s.handleChunk(a.chunk({ type: 'text-delta', index: 0, text: 'x' }))
      s.handleChunk(a.chunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }))
      if (reasons[i].kind === 'tool-calls') {
        s.handleChunk(a.chunk({ type: 'block-start', index: 1, blockType: 'tool-call' }))
        s.handleChunk(a.chunk({ type: 'tool-call-delta', index: 1, id: 'call_1', name: 'probe', argumentsDelta: '{}' }))
        s.handleChunk(a.chunk({ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_1', name: 'probe', arguments: '{}' } }))
      }
      s.handleChunk(a.chunk({ type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }))
      s.handleChunk(a.chunk({ type: 'finish', reason: reasons[i] }))
      s.handleEnd(a.end())
      await s.idle()
      assert.equal(rec.errors.length, 0, `finish reason ${reasons[i].kind} 合法`)
      assert.equal(rec.calls.finish.length, 2 + i, `${reasons[i].kind} 流正常收卡`)
    }
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'Hello worldxxxx', '各 attempt 正文隔离且完整')

    // 非法 finish reason（字符串）仍拒：外层 index 不占位 → end 计数不符被拒并上报
    const bad = realFrames(life, 'bad1', 9, 1)
    s.handleStart(bad.start())
    s.handleChunk(bad.chunk({ type: 'text-delta', index: 0, text: 'y' }))
    s.handleChunk(bad.chunk({ type: 'finish', reason: 'stop' })) // 非法 shape → 拒
    s.handleEnd(bad.end()) // end.index=2 ≠ lastIndex(0)+1 → onError 拒
    await s.idle()
    assert.equal(rec.errors.length, 1, '非法 finish 的 end 计数不符被拒并上报')
    assert.equal(s.state().ended, false)
    assert.equal(rec.calls.finish.length, 5, '非法 end 不收卡')
    await s.dispose()
    assert.equal(rec.calls.finish.length, 5, 'dispose 不重复已收的卡；从未投递的不凭空收卡')
  }

  // ---------- T20 17:40 P1-3：多 step final 排队后 abort 按 turn scope 全取消 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'card', delay: 10, scheduler: sch })
    const s = rec.stream

    s.setFinalMessage('step-one', { turn: 1, step: 1 })
    await tick() // final1 在途（10ms），卡已开
    s.setFinalMessage('step-two', { turn: 1, step: 2 }) // 排队（新虚拟 step2，current 仍 v1）
    s.abort() // 同步：按 current 所在 turn scope 取消 v1+v2
    await s.idle()
    assert.deepEqual(rec.calls.text.map((t) => t.text), ['step-one'], '排队的 step2 被取消，不新开未收卡（回归：旧实现出现 step-two）')
    assert.equal(rec.tries.text, 1, 'v2 的 final 未发起')
    assert.equal(rec.calls.finish.length, 1, '只有已开的卡收一次')
    assert.equal(rec.calls.finish[0].reason, 'abort')
    assert.equal(rec.calls.finish[0].turn, 1)

    // 下一 turn 不受影响
    s.setFinalMessage('next-turn', { turn: 2, step: 1 })
    await s.idle()
    assert.equal(rec.calls.text.length, 2, 'next turn 正常输出（abort 不影响下一 turn）')
    assert.equal(rec.calls.text[1].text, 'next-turn')
    s.endTurn({ turn: 2 })
    await s.idle()
    assert.equal(rec.calls.finish.length, 2)
    assert.equal(rec.calls.finish[1].turn, 2)
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T21 17:40 P1-4：endTurn(abandoned) 同步标废弃，已排队 final 被取消 ----------
  {
    const sch = createFakeScheduler()
    // (a) 全排队：final 未执行即遇 abandoned → 一律不发正文
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    s.setFinalMessage('queued', { turn: 1, step: 1 })
    s.endTurn({ turn: 1, outcome: { kind: 'abandoned' } }) // 同步置 abandoned
    await s.idle()
    assert.equal(rec.tries.delta, 0, '已排队 final 被取消（回归：旧实现先投 queued）')
    assert.equal(rec.calls.finish.length, 0, '从未开卡 → 无卡可收')

    // (b) 已开卡 + 排队 step2：只发已投内容，排队 step2 取消，已开卡 abandoned 收一次
    const rec2 = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s2 = rec2.stream
    s2.setFinalMessage('done', { turn: 1, step: 1 })
    await s2.idle()
    assert.equal(rec2.tries.delta, 1)
    s2.setFinalMessage('queued2', { turn: 1, step: 2 })
    s2.endTurn({ turn: 1, outcome: { kind: 'abandoned' } })
    await s2.idle()
    assert.equal(rec2.tries.delta, 1, '排队 step2 final 被 abandoned 取消')
    assert.equal(rec2.calls.finish.length, 1, '已开的卡 abandoned 收一次')
    assert.equal(rec2.calls.finish[0].reason, 'abandoned')
    assert.equal(rec2.calls.finish[0].outcome.kind, 'abandoned')
    assert.equal(rec2.errors.length, 0)
  }

  // ---------- T22 17:59 P1-②：同 turn >32 step 墓碑淘汰后旧 step 不复活、新 step 正常 ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    for (let i = 0; i < 40; i++) {
      s.setFinalMessage(`s${i}`, { turn: 1, step: i })
      s.endTurn({ turn: 1, step: i })
    }
    await s.idle()
    assert.equal(rec.tries.delta, 40, '40 个 step 各输出一次')
    assert.equal(rec.calls.finish.length, 40, '40 个 step 各收卡一次')
    assert.ok(s.state().attempts <= 32, '早期 step 墓碑已被淘汰')

    // 重放被淘汰墓碑的旧 step0：step 水位线拒复活
    s.setFinalMessage('s0', { turn: 1, step: 0 })
    await s.idle()
    assert.equal(rec.tries.delta, 40, '同 turn 旧 step 不复活（回归：旧实现 41）')

    // 同 turn 尚未出现的新 step 正常
    s.setFinalMessage('s40', { turn: 1, step: 40 })
    s.endTurn({ turn: 1, step: 40 })
    await s.idle()
    assert.equal(rec.tries.delta, 41, '同 turn 新 step 不被水位线误拒')
    assert.equal(rec.calls.finish.length, 41)
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T23 17:59 P1-③：水位线不得吞仍开着的旧 attempt final（活跃身份优先） ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 }
    const fA = frames('a1', 1, 1, life)
    const fB = frames('b1', 3, 1, life)

    s.handleStart(fA.start())
    s.handleChunk(fA.chunk('old '))
    sch.advance()
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'old ')

    // 新 turn2 结算 → 水位线=2（A 仍开着）
    s.setFinalMessage('new', { turn: 2, step: 1 })
    s.endTurn({ turn: 2 })
    await s.idle()
    assert.ok(s.state().settledTurnWatermark >= 2, '水位线已推进到 2')
    assert.equal(rec.calls.finish.length, 1, 'turn2 虚拟 attempt 收卡')
    assert.equal(rec.calls.finish[0].turn, 2)

    // 启动 B(turn3)：current 变为 B，A 变成非 current 的活跃 attempt
    s.handleStart(fB.start())
    s.handleChunk(fB.chunk('B'))
    sch.advance()
    await s.idle()

    // 迟到的 A(turn1) final：必须先被活跃身份接住、补尾唯一（回归：旧实现被水位线吞掉）
    s.setFinalMessage('old tail', { turn: 1, step: 1 })
    await s.idle()
    const aDeltas = rec.calls.delta.filter((d) => d.attemptId === 'a1').map((d) => d.delta)
    assert.deepEqual(aDeltas, ['old ', 'tail'], '仍开着的旧 attempt final 不被水位线吞，补尾唯一')
    assert.equal(s.state().attemptId, 'b1', 'current 不被历史 final 替换')

    s.endTurn({ turn: 1 }) // 收 A
    await s.idle()
    assert.deepEqual(rec.calls.finish.map((x) => x.turn), [2, 1], 'A 被 turn1 endTurn 收卡')
    s.handleEnd(fB.end())
    await s.idle()
    assert.deepEqual(rec.calls.finish.map((x) => x.turn), [2, 1, 3])
    assert.deepEqual(rec.calls.finish.map((x) => x.attemptId), [null, 'a1', 'b1'])
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T24 17:59 P1-①：abort(identity) 只取消所述 turn，无参兼容 current scope ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch })
    const s = rec.stream
    const life = { rev: 0 }
    const fA = frames('a1', 1, 1, life)
    const fB = frames('b1', 2, 1, life)

    s.handleStart(fA.start())
    s.handleChunk(fA.chunk('A'))
    sch.advance()
    await s.idle()
    s.handleStart(fB.start()) // B(turn2) 取代 A，待节流
    s.handleChunk(fB.chunk('B'))
    assert.equal(sch.pending(), 1)

    s.flushTurn({ turn: 1 }) // 范围 flush：不碰 turn2
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'A', 'scoped flushTurn 不冲刷其他 turn')
    assert.equal(sch.pending(), 1, '范围外 B 的 timer 被重排不断粮')

    s.abort({ turn: 1 }) // 迟到的 turn1 aborted：只中止所述 turn
    assert.equal(sch.pending(), 1, 'B 的 timer 不受 turn1 abort 影响')
    await s.idle()
    assert.equal(rec.calls.finish.length, 1)
    assert.equal(rec.calls.finish[0].attemptId, 'a1')
    assert.equal(rec.calls.finish[0].aborted, true)
    assert.equal(s.state().cancelled, false, 'B（current）未被 turn1 abort 误杀（回归：旧实现取消 B）')

    sch.advance() // B 等到节流窗口
    await s.idle()
    s.setFinalMessage('B tail', { turn: 2, step: 1 })
    await s.idle()
    s.handleEnd(fB.end())
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'AB tail', 'B 全程未被旧 turn abort 影响')
    assert.deepEqual(rec.calls.finish.map((x) => x.attemptId), ['a1', 'b1'])

    // 无匹配 identity 的 abort：不取消任何东西（attemptId 维度过滤）
    s.abort({ attemptId: 'nonexistent' })
    s.abort() // 无参兼容：current scope（T7/T14 已覆盖行为）
    await s.idle()
    assert.equal(rec.calls.finish.length, 2, '无匹配 abort 不重复收卡')
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  // ---------- T25 18:33 P1：在途首请求 + >32 pending ended + 重复旧 final 不复活 ----------
  {
    const sch = createFakeScheduler()
    let releaseGate
    const gate = new Promise((resolve) => {
      releaseGate = resolve
    })
    let hangNext = true
    const delivered = []
    const errors = []
    const finishes = []
    const s = createLarkStream({
      mode: 'text',
      throttleMs: 50,
      scheduler: sch,
      sendTextDelta: async (p) => {
        if (hangNext) {
          hangNext = false
          await gate // 首个投递请求挂住（在途不可撤销）
        }
        delivered.push(p.delta)
      },
      updateCardText: () => {},
      finishCard: (p) => finishes.push(p),
      onError: (err) => errors.push(err),
    })

    s.setFinalMessage('s0', { turn: 1, step: 0 }) // 投递将挂住
    s.endTurn({ turn: 1, step: 0 }) // step0 同步 ended 但永未 settled（任务堵在挂起请求后）
    for (let i = 1; i <= 39; i++) {
      s.setFinalMessage(`s${i}`, { turn: 1, step: i })
      s.endTurn({ turn: 1, step: i }) // 39 个 pending ended，全部入队但无一 settled
    }
    assert.equal(s.state().settledTurnWatermark, -1, '挂起期间水位线仍 -1')
    assert.ok(s.state().attempts > 32, '在途/未 settled 不被淘汰（容量仅限已完成历史）')

    // 重放旧 step0：必须归到仍存在的未 settled step0（不得新建 virtual 重发）
    s.setFinalMessage('s0', { turn: 1, step: 0 })
    releaseGate() // 释放在途请求，全队列排空
    await s.idle()

    assert.equal(delivered.filter((d) => d === 's0').length, 1, '重复旧 step0 不复活（回归：旧实现 2 次/共 41 条）')
    assert.equal(delivered.length, 40, 'step0..39 各恰好一条')
    assert.equal(finishes.length, 40, '40 个 step 各收卡一次')
    assert.equal(errors.length, 0)
    assert.ok(s.state().attempts <= 32, `settlement 后压缩回容量内（实际 ${s.state().attempts}）`)
    assert.equal(s.state().settledTurnWatermark, 1, '全部结算后水位线推进')

    // 已完全结算后的重放：靠水位线/step 上界拒
    s.setFinalMessage('s0', { turn: 1, step: 0 })
    await s.idle()
    assert.equal(delivered.length, 40, '结算并压缩后的重放仍不复活')
    await s.dispose()
  }

  // ---------- T26 18:33 P2：范围操作无匹配完全 no-op，不推移已有绝对 deadline ----------
  {
    const sch = createFakeScheduler()
    const rec = createRecorder(createLarkStream, { mode: 'text', scheduler: sch }) // throttleMs 50
    const s = rec.stream
    const life = { rev: 0 } // 全部 attempt 共享 Agent lifecycle 级 revision
    const f = frames('b1', 2, 1, life)
    s.handleStart(f.start())
    s.handleChunk(f.chunk('B'))
    assert.deepEqual(sch.deadlines(), [50], '首个 deadline = now(0)+50')

    sch.tick(30) // now=30，未到期
    assert.deepEqual(sch.deadlines(), [50], '推进时钟不改 deadline')

    // 无匹配的范围操作：完全 no-op（不清、不重排、不顺延）
    s.flushTurn({ turn: 999 })
    s.abort({ turn: 999 })
    s.endTurn({ turn: 999 })
    await s.idle()
    assert.deepEqual(sch.deadlines(), [50], '无匹配 flush/abort/endTurn 不推移 deadline（回归：旧实现 30→80/110/140）')
    assert.equal(rec.calls.delta.length, 0)
    assert.equal(sch.pending(), 1)

    sch.tick(20) // now=50 → 按原 deadline 到期
    assert.equal(sch.pending(), 0)
    await s.idle()
    assert.equal(rec.calls.delta.length, 1, '按原 deadline 发出')
    assert.equal(rec.calls.delta[0].delta, 'B')

    // 有匹配范围 flush：只冲刷目标，其他 dirty 保持既有 deadline
    const g1 = frames('a1', 1, 1, life)
    const g2 = frames('b2', 3, 1, life)
    s.handleStart(g1.start())
    s.handleChunk(g1.chunk('X')) // now=50 → deadline 100
    s.handleStart(g2.start())
    s.handleChunk(g2.chunk('Y')) // timer 已挂 → 不重排
    assert.deepEqual(sch.deadlines(), [100], '共享 timer deadline = 50+50')
    sch.tick(30) // now=80
    s.flushTurn({ turn: 1 }) // 只冲刷 a1
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'BX', '目标立即冲刷')
    assert.deepEqual(sch.deadlines(), [100], '有匹配 flush 不推移其他 dirty 的 deadline（回归：旧实现 130）')
    sch.tick(20) // now=100 → 到期
    await s.idle()
    assert.equal(rec.calls.delta.map((d) => d.delta).join(''), 'BXY', '其余按原 deadline 发出')
    assert.equal(rec.errors.length, 0)
    await s.dispose()
  }

  assert.equal(unhandled.length, 0, `不允许 unhandledRejection: ${unhandled.map((e) => e && e.message).join('; ')}`)
  console.log('lark-stream ok')
})().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
