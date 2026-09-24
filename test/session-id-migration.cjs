'use strict'
// 会话 id 防碰撞方案与分级迁移的回归测试（lib/session-id-migration.js）。
// 用临时目录搭一个 DSH 宿主存储 fixture（sessions/<ws>/<id> + projcache +
// workspace.json），断言：
//   1. 新 id 方案对三类历史碰撞（telegram ±id、_ vs -、截断）产出不同 id；
//   2. 迁移改名日志目录并重写 zstd 头部内嵌 id、改名 projcache、修补注册表引用；
//   3. dry-run 零改动、重跑幂等、目标存在时整体冲突跳过（不合并不覆盖不删除）；
//   4. 分级顺序：stage ids（第二点）不碰双前缀源，stage legacy（第一点）随后迁；
//   5. 崩溃半途（目录已改名、头部未改）重跑能续完；
//   6. cleanup（第三点）只删 bootstrap 自己的两件套。
const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { zstdCompressSync, zstdDecompressSync } = require('node:zlib')

const root = path.resolve(__dirname, '..')
const LOG_FILE = 'session.v3.jsonl.zstd'
const WS = '--test-ws--'

let mig
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mig-test-'))
}

function writeSession(home, id, { embedIdInLog = true, embedIdInCache = false, withLog = true, logFrames = null } = {}) {
  const dir = path.join(home, 'sessions', WS, id)
  fs.mkdirSync(dir, { recursive: true })
  if (logFrames) {
    // 显式多帧日志（每帧独立 zstd）——模拟 harness 追加式日志的物理结构。
    fs.writeFileSync(path.join(dir, LOG_FILE), Buffer.concat(logFrames))
  } else if (withLog) {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: embedIdInLog ? id : 'other', createdAt: 1, cwd: 'C:\\x', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
      JSON.stringify({ type: 'message', seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'message', seq: 2, message: { role: 'assistant' } }),
    ]
    fs.writeFileSync(path.join(dir, LOG_FILE), zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
  }
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify({ version: 1, record: embedIdInCache ? { id } : { rows: { title: { val: 'x' } } } }))
  return dir
}

function readLog(home, id) {
  const file = path.join(home, 'sessions', WS, id, LOG_FILE)
  return zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
}

function writeRegistry(home, ids) {
  const file = path.join(home, 'storages', 'workspace.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ unit: {}, global: { archivedSessionIds: ids }, tables: {} }))
}

function readRegistry(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
}

const exists = (p) => fs.existsSync(p)

async function main() {
  mig = await import(pathToFileURL(path.join(root, 'lib', 'session-id-migration.js')).href)

  // --- 1. 防碰撞：三类历史碰撞在新方案下必须分离 -----------------------------
  const colliding = [
    ['telegram:-100123456', 'telegram:100123456'],
    ['lark:oc_abc', 'lark:oc-abc'],
    ['lark:oc_' + 'x'.repeat(90) + 'AAAA', 'lark:oc_' + 'x'.repeat(90) + 'BBBB'],
    ['TgChat', 'tgchat'],
  ]
  for (const [a, b] of colliding) {
    assert.notEqual(mig.sessionIdForKey(a), mig.sessionIdForKey(b), 'collision pair must be distinct: ' + a + ' vs ' + b)
  }
  // 可读性保留 + 形态
  assert.match(mig.sessionIdForKey('onebot:private:1001'), /^dsh-msg-onebot-private-1001-x[0-9a-f]+$/)
  assert.match(mig.sessionIdForKey('x'), /^dsh-msg-x-x[0-9a-f]+$/, 'slug 参与形态：dsh-msg-<slug>-x<hash>')

  // --- 2. 旧形态候选：第二点（纯 slug）在前、第一点（双前缀）在后 ------------
  const larkKey = 'lark:oc_7428c5632711d7bb4382e371f8094ba5'
  const legacyLark = mig.legacySessionIdsForKey(larkKey)
  assert.equal(legacyLark.length, 2, 'both legacy shapes must be candidates')
  assert.equal(legacyLark[0], 'dsh-msg-lark-oc-7428c5632711d7bb4382e371f8094ba5', '第二点 (slug-only) first')
  assert.equal(legacyLark[1], 'dsh-msg-lark-lark-oc-7428c5632711d7bb4382e371f8094ba5', '第一点 (double-prefix) second')
  // 不带渠道前缀的会话键（onebot）：双前缀候选 = channel:key 形态
  assert.equal(mig.legacySessionIdsForKey('onebot:private:1001')[1], 'dsh-msg-onebot-onebot-private-1001')
  // 候选不得与新 id 相同
  for (const id of mig.legacySessionIdsForKey(larkKey)) assert.notEqual(id, mig.sessionIdForKey(larkKey))

  // 迁移源/目标（提前声明，各分组共用）
  const oldId = mig.legacySlugSessionId(larkKey)
  const newId = mig.sessionIdForKey(larkKey)

  // --- 3. dry-run 零改动 -----------------------------------------------------
  let home = makeHome()
  writeSession(home, mig.legacySlugSessionId(larkKey), { embedIdInCache: true })
  writeRegistry(home, [oldId])
  const snapshot = () => JSON.stringify({
    tree: fs.readdirSync(path.join(home, 'sessions', WS)),
    cache: fs.readdirSync(path.join(home, 'storages', 'session_projcache', 'sessions')),
    registry: fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'),
    log: readLog(home, mig.legacySlugSessionId(larkKey)),
  })
  const before = snapshot()
  const dry = mig.runMigrationStage(home, 'ids', [larkKey], { apply: false })
  assert.equal(dry[0].reason, 'dry-run')
  assert.ok(dry[0].actions.length >= 3, 'plan must list dir + cache + registry actions')
  assert.equal(snapshot(), before, 'dry-run must not touch anything')

  // --- 4. stage ids 应用：完整搬运（含 zstd 头、projcache 内容、注册表） -----
  const applied = mig.runMigrationStage(home, 'ids', [larkKey], { apply: true })
  assert.equal(applied[0].moved, true)
  assert.equal(exists(path.join(home, 'sessions', WS, oldId)), false, 'old dir renamed away')
  assert.equal(exists(path.join(home, 'sessions', WS, newId)), true, 'new dir present')
  const logText = readLog(home, newId)
  assert.ok(logText.includes('"' + newId + '"'), 'zstd header id rewritten')
  assert.equal(logText.includes('"' + oldId + '"'), false, 'no stale id token in header (新 id 是旧 id 超串，必须整 token 匹配)')
  assert.ok(logText.includes('"role": "user"') || logText.includes('"role":"user"'), 'log body intact')
  assert.equal(exists(path.join(home, 'storages', 'session_projcache', 'sessions', oldId + '.json')), false)
  assert.equal(exists(path.join(home, 'storages', 'session_projcache', 'sessions', newId + '.json')), true)
  const registryAfter = JSON.stringify(readRegistry(home))
  assert.ok(registryAfter.includes('"' + newId + '"'), 'registry ref patched to the new id')
  assert.equal(registryAfter.includes('"' + oldId + '"'), false, 'no stale id token left in the registry')
  // 幂等重跑
  const rerun = mig.runMigrationStage(home, 'ids', [larkKey], { apply: true })
  assert.equal(rerun[0].found, false)
  assert.equal(rerun[0].reason, 'absent')
  fs.rmSync(home, { recursive: true, force: true })

  // --- 5. 分级顺序：stage ids 不碰双前缀源；stage legacy 再迁 ----------------
  home = makeHome()
  const slugOnlyId = mig.legacySlugSessionId(larkKey)          // 第二点源（本例不存在 → absent）
  const doubleId = mig.doublePrefixedSessionId(larkKey)        // 第一点源
  writeSession(home, doubleId, { embedIdInCache: true })
  writeRegistry(home, [doubleId])
  const stageIds = mig.runMigrationStage(home, 'ids', [larkKey], { apply: true })
  assert.equal(stageIds[0].reason, 'absent', '第二点 stage 在纯 slug 源缺席时无操作')
  assert.equal(exists(path.join(home, 'sessions', WS, doubleId)), true, '双前缀源必须原封不动')
  assert.notEqual(doubleId, slugOnlyId)
  const stageLegacy = mig.runMigrationStage(home, 'legacy', [larkKey], { apply: true })
  assert.equal(stageLegacy[0].moved, true, '第一点 stage 迁移双前缀历史')
  assert.equal(exists(path.join(home, 'sessions', WS, doubleId)), false)
  assert.equal(exists(path.join(home, 'sessions', WS, newId)), true, '落到同一个新 id')
  assert.ok(readLog(home, newId).includes(newId))
  assert.ok(readRegistry(home).global.archivedSessionIds.includes(newId), '注册表引用同步到新 id')
  fs.rmSync(home, { recursive: true, force: true })

  // --- 6. 冲突：目标已存在 → 整体跳过，源原封不动 ----------------------------
  home = makeHome()
  writeSession(home, doubleId, { embedIdInCache: true })
  writeSession(home, newId, { embedIdInLog: false })            // 目标已在（且其头部没有旧 id）
  const conflict = mig.runMigrationStage(home, 'legacy', [larkKey], { apply: true })
  assert.equal(conflict[0].reason, 'target-exists')
  assert.equal(conflict[0].moved, false)
  assert.equal(exists(path.join(home, 'sessions', WS, doubleId)), true, 'source must survive a conflict')
  // projcache 目标已存在同样冲突（Windows rename 会静默覆盖，必须拦）
  const home2 = makeHome()
  writeSession(home2, mig.legacySlugSessionId('lark:oc_zzz'))
  const cacheDir = path.join(home2, 'storages', 'session_projcache', 'sessions')
  fs.writeFileSync(path.join(cacheDir, mig.sessionIdForKey('lark:oc_zzz') + '.json'), JSON.stringify({ version: 1 }))
  const cacheConflict = mig.runMigrationStage(home2, 'ids', ['lark:oc_zzz'], { apply: true })
  assert.equal(cacheConflict[0].reason, 'target-exists')
  fs.rmSync(home2, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })

  // --- 7. 崩溃半途续跑：目录已改名、头部未改、缓存未搬 → 重跑补完 ------------
  home = makeHome()
  const halfDir = path.join(home, 'sessions', WS, newId)
  fs.mkdirSync(halfDir, { recursive: true })
  fs.writeFileSync(path.join(halfDir, LOG_FILE), zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session', version: 3, id: doubleId }) + '\n', 'utf8')))
  fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', doubleId + '.json'), '{}')
  writeRegistry(home, [doubleId])
  const resumeRun = mig.runMigrationStage(home, 'legacy', [larkKey], { apply: true })
  assert.equal(resumeRun[0].moved, true, 'resume run must complete remaining pieces')
  assert.ok(readLog(home, newId).includes(newId), 'stale header patched in the already-renamed dir')
  assert.equal(exists(path.join(home, 'storages', 'session_projcache', 'sessions', doubleId + '.json')), false)
  assert.ok(readRegistry(home).global.archivedSessionIds.includes(newId))
  fs.rmSync(home, { recursive: true, force: true })

  // --- 8. cleanup（第三点）：只删 bootstrap 两件套 ---------------------------
  home = makeHome()
  writeSession(home, 'dsh-messaging-bootstrap')
  writeSession(home, mig.sessionIdForKey(larkKey))
  writeRegistry(home, ['dsh-messaging-bootstrap'])
  const cleanupPlan = mig.runMigrationStage(home, 'cleanup', [], { apply: false })
  assert.equal(cleanupPlan[0].found, true)
  assert.equal(cleanupPlan[0].actions.length, 2, 'dir + projcache exactly')
  assert.equal(cleanupPlan[0].reason, 'dry-run')
  assert.equal(exists(path.join(home, 'sessions', WS, 'dsh-messaging-bootstrap')), true, 'dry-run keeps it')
  const cleanup = mig.runMigrationStage(home, 'cleanup', [], { apply: true })
  assert.equal(cleanup[0].moved, true)
  assert.equal(exists(path.join(home, 'sessions', WS, 'dsh-messaging-bootstrap')), false)
  assert.equal(exists(path.join(home, 'storages', 'session_projcache', 'sessions', 'dsh-messaging-bootstrap.json')), false)
  assert.equal(exists(path.join(home, 'sessions', WS, mig.sessionIdForKey(larkKey))), true, 'unrelated session untouched')
  const cleanupAgain = mig.runMigrationStage(home, 'cleanup', [], { apply: true })
  assert.equal(cleanupAgain[0].reason, 'absent', 'cleanup is idempotent')
  fs.rmSync(home, { recursive: true, force: true })

  // --- 8.5 多帧日志：帧感知改写（回归——整文件解压会丢掉首帧之后的全部消息帧） ---
  home = makeHome()
  const mkFrame = (obj) => zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
  const multiOld = mig.legacySlugSessionId('lark:oc_multi')
  const multiNew = mig.sessionIdForKey('lark:oc_multi')
  const headerFrame = mkFrame({ type: 'session', version: 3, id: multiOld, cwd: 'C:\\x' })
  const msgFrame1 = mkFrame({ type: 'user/message', seq: 0 })
  const msgFrame2 = mkFrame({ type: 'assistant/message', seq: 1, sessionId: multiOld })
  writeSession(home, multiOld, { logFrames: [headerFrame, msgFrame1, msgFrame2] })
  const mv = mig.runMigrationStage(home, 'ids', ['lark:oc_multi'], { apply: true })
  assert.equal(mv[0].moved, true)
  const curBuf = fs.readFileSync(path.join(home, 'sessions', WS, multiNew, LOG_FILE))
  const scan = mig.scanZstdFrames(curBuf)
  assert.equal(scan.tornStart, undefined)
  assert.equal(scan.frames.length, 3, '帧数必须保持（丢帧即数据丢失）')
  const decode = (f) => zstdDecompressSync(curBuf.subarray(f.start, f.end)).toString('utf8')
  const texts = scan.frames.map(decode)
  assert.ok(texts[0].includes('"' + multiNew + '"'), 'header 帧 id 已换')
  assert.ok(!texts[0].includes('"' + multiOld + '"'), 'header 无旧 token')
  assert.ok(texts[1].includes('user/message'), '**消息帧1 必须存活**（旧实现整文件解压会丢掉它）')
  assert.ok(texts[2].includes('assistant/message'), '**消息帧2 必须存活**')
  assert.ok(texts[2].includes('"' + multiNew + '"'), '消息帧内的 id 引用也必须换')
  assert.ok(!texts[2].includes('"' + multiOld + '"'), '消息帧无旧 token')
  assert.equal(curBuf.subarray(scan.frames[1].start, scan.frames[1].end).equals(msgFrame1), true,
    '不含 token 的帧必须原字节保留（校验和不破坏）')
  const rerunMulti = mig.runMigrationStage(home, 'ids', ['lark:oc_multi'], { apply: true })
  assert.equal(rerunMulti[0].reason, 'absent', '多帧迁移幂等')
  fs.rmSync(home, { recursive: true, force: true })

  // --- 8.6 撕裂帧：整体中止，绝不改名、绝不写半个文件 -------------------------
  home = makeHome()
  const tornOld = mig.legacySlugSessionId('lark:oc_torn')
  const tornNew = mig.sessionIdForKey('lark:oc_torn')
  const full = Buffer.concat([headerFrame, msgFrame1, msgFrame2])
  const tornBytes = full.subarray(0, full.length - 7) // 截断末帧
  writeSession(home, tornOld, { logFrames: [tornBytes] })
  assert.throws(() => mig.rewriteIdTokenInFrames(tornBytes, tornOld, tornNew), /torn zstd frame/)
  const torn = mig.runMigrationStage(home, 'ids', ['lark:oc_torn'], { apply: true })
  assert.equal(torn[0].reason, 'torn-log', '撕裂日志必须整体拒绝')
  assert.equal(exists(path.join(home, 'sessions', WS, tornOld)), true, '拒绝后源目录必须原封不动')
  assert.equal(exists(path.join(home, 'sessions', WS, tornNew)), false, '不得产生目标目录（半途状态）')
  fs.rmSync(home, { recursive: true, force: true })

  // --- 9. CLI 参数解析（阶段逻辑已由上面覆盖；真实 CLI 调用在迁移执行时验证） -
  const cli = require(path.join(root, 'scripts', 'migrate-sessions.cjs'))
  const parsed = cli.parseArgs(['--stage', 'ids', '--key', 'a:b', '--key', 'c:d', '--apply', '--home', '/tmp/h'])
  assert.equal(parsed.stage, 'ids')
  assert.deepEqual(parsed.keys, ['a:b', 'c:d'])
  assert.equal(parsed.apply, true)
  assert.equal(parsed.home, '/tmp/h')
  assert.throws(() => cli.parseArgs(['--bogus']), /unknown argument/)
  assert.equal(cli.parseArgs(['--stage', 'cleanup']).keys.length, 0, 'cleanup 不需要 --key')

  console.log('session-id-migration: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
