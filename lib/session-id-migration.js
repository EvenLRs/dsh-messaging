// 会话 id 方案与存储迁移（dsh-messaging）。
//
// 背景：旧 safeSessionId 只做 slug（小写、非 [a-z0-9] → '-'、截 80 字符），存在三类
// 碰撞（实测：telegram 负数群 id 与正数 uid、下划线与连字符归一、超长截断），碰撞后
// 两个不同 IM 会话会共用同一个 DSH 会话，且 sessionToConversation 被后创建者覆盖，
// 回发会串到错误会话。此外，双前缀修复前的历史会话 id 形如
// `dsh-msg-lark-lark-oc-…`，与修复后的派生不同，会与旧历史分裂。
//
// 新方案：`dsh-msg-<slug>-x<hash(原键)>` —— slug 保留可读性，键哈希保证唯一。
//
// 迁移**不能**从盘上 id 反推会话键（slug 不可逆：`:`/`-`/`_` 归一、大小写、截断），
// 因此迁移一律由**权威会话键**驱动：
//   - 惰性（权威路径）：`ensureAgent` 在某会话首次来消息时，用适配器给出的真实键列出
//     旧形态候选（顺序 = 第二点的 slug 形态在前，第一点的双前缀形态在后），
//     命中就把整个会话存储（日志目录 + 投影缓存 + workspace 注册表引用）迁到新 id。
//   - 急迁（工具化）：`scripts/migrate-sessions.cjs --stage ids|legacy|cleanup`，
//     对**已知**键分级执行，用于归档后不会再收消息的会话，以及孤儿清理。
//
// 所有操作幂等；dry-run 为默认；目标已存在时整体跳过（绝不合并、绝不删除）。
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export const SESSION_ID_PREFIX = 'dsh-msg-'
export const BOOTSTRAP_SESSION_ID = 'dsh-messaging-bootstrap'
const LOG_FILE = 'session.v3.jsonl.zstd'
const ZSTD_MAGIC = 0xfd2fb528

/**
 * 结构化扫描串联的 Zstandard 帧（不解压块内容）。移植自 harness
 * session-persistence-jsonl 的 scanZstdFrames（zstd 规范：魔数 / 帧头描述符 /
 * 块头位域）；EOF 落在帧中间时返回 tornStart —— 调用方必须把撕裂帧当作
 * 不可安全改写。
 * @param buffer - 完整日志字节
 * @returns 完整帧区间列表，及可选的不完整末帧起点
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt zstd log: invalid frame magic at byte ' + offset)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error('corrupt zstd log: reserved frame-header bit at byte ' + (offset - 1))
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('corrupt zstd log: reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 帧感知的 id token 改写：**只解压含 token 的帧**，其余帧字节原样保留
 * （校验和仍有效）。绝不整文件解压重写——Node zstdDecompressSync 只解第一帧，
 * 整文件解压会丢弃后续全部消息帧（该数据丢失事故见 CHANGELOG Unreleased）。
 * 撕裂帧 / 结构损坏 → 抛错，绝不产出半个文件。
 * @param bytes - 完整日志字节
 * @param oldId - 旧会话 id
 * @param newId - 新会话 id
 * @returns 改写后的完整字节与被改写帧数（0 = 无需改写）
 */
export function rewriteIdTokenInFrames(bytes, oldId, newId) {
  const scan = scanZstdFrames(bytes)
  if (scan.tornStart !== undefined) {
    throw new Error('torn zstd frame at byte ' + scan.tornStart + ' - refusing to rewrite')
  }
  const parts = []
  let swapped = 0
  for (const range of scan.frames) {
    const raw = bytes.subarray(range.start, range.end)
    const text = zstdDecompressSync(raw).toString('utf8')
    if (hasIdToken(text, oldId)) {
      parts.push(zstdCompressSync(Buffer.from(swapIdToken(text, oldId, newId), 'utf8')))
      swapped += 1
    } else {
      parts.push(Buffer.from(raw))
    }
  }
  return { bytes: Buffer.concat(parts), swapped }
}

// 与历史实现一致的32 位字符串哈希（原 safeSessionId 内联实现，原样搬移）。
function hashString(value) {
  let hash = 0
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index)
    hash |= 0
  }
  return 'x' + Math.abs(hash).toString(16)
}

function slugOf(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** 新方案会话 id：可读 slug + 键哈希后缀（防碰撞的根修复）。 */
export function sessionIdForKey(key) {
  const text = String(key)
  const slug = slugOf(text)
  return SESSION_ID_PREFIX + (slug ? slug + '-' : '') + hashString(text)
}

/** 第二点旧形态（新方案之前的纯 slug id）。 */
export function legacySlugSessionId(key) {
  const slug = slugOf(key)
  return SESSION_ID_PREFIX + (slug || hashString(key))
}

/**
 * 第一点旧形态：双前缀键（双前缀修复前 sessionKey 无条件拼渠道名）。
 * 键本身已带渠道前缀时旧键 = channel + ':' + key；否则旧键 == key。
 */
export function doublePrefixedSessionId(key) {
  const text = String(key)
  const channel = text.split(':')[0]
  if (!channel || !text.startsWith(channel + ':')) return null
  return legacySlugSessionId(channel + ':' + text)
}

/**
 * 某键的全部旧形态候选，顺序即迁移优先级：
 * 第二点（纯 slug）在前，第一点（双前缀）在后；剔除与新 id 相同及重复项。
 */
export function legacySessionIdsForKey(key) {
  const fresh = sessionIdForKey(key)
  const candidates = [legacySlugSessionId(key), doublePrefixedSessionId(key)]
  const seen = new Set()
  return candidates.filter((id) => {
    if (!id || id === fresh || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

// --- 存储定位 ---------------------------------------------------------------

function listWorkspaceDirs(homeRoot) {
  const sessionsRoot = join(homeRoot, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  return readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sessionsRoot, entry.name))
}

function projcachePath(homeRoot, id) {
  return join(homeRoot, 'storages', 'session_projcache', 'sessions', id + '.json')
}

function workspaceRegistryPath(homeRoot) {
  return join(homeRoot, 'storages', 'workspace.json')
}

// 新 id = 旧 id + '-x<hash>'，**新 id 是旧 id 的超串**——裸子串替换在重跑时会命中
// 新 id 内部把头部改坏（测试抓到过此 bug）。所有检测与替换都用 JSON 引号定界的整体
// token（`"<id>"`）：`"dsh-msg-a"` 不可能是 `"dsh-msg-a-x1a2"` 的子位置，天然幂等。
function idToken(id) {
  return '"' + id + '"'
}
function hasIdToken(text, id) {
  return text.includes(idToken(id))
}
function swapIdToken(text, oldId, newId) {
  return text.split(idToken(oldId)).join(idToken(newId))
}

// --- 单会话迁移 -------------------------------------------------------------

/**
 * 把 oldId 的全部存储迁到 newId。detailed per-piece 行为：
 *   A. sessions/<workspace>/<oldId> → rename（目标已存在 → 整体 conflict 跳过）
 *   B. 目录内 session.v3.jsonl.zstd **按帧**改写 id token（只解压含 token 的帧，
 *      其余帧字节原样保留）；重跑或 A 因崩溃半途时，会对**现所在目录**（新或旧）
 *      做幂等修补；撕裂帧 → 抛错中止，不产出半个文件
 *   C. projcache 文件改名 + 防御性内容替换
 *   D. workspace.json 内引用替换
 * 返回 { found, moved, reason?, actions: [...] }；dry-run 只列 actions。
 */
export function migrateSessionStore(homeRoot, oldId, newId, { apply = false, log = () => {} } = {}) {
  const result = { found: false, moved: false, reason: undefined, actions: [] }
  if (!oldId || !newId || oldId === newId) {
    result.reason = 'same-id'
    return result
  }

  const sourceDirs = listWorkspaceDirs(homeRoot)
    .map((ws) => join(ws, oldId))
    .filter((dir) => existsSync(dir))
  const targetDirs = listWorkspaceDirs(homeRoot)
    .map((ws) => join(ws, newId))
    .filter((dir) => existsSync(dir))
  const sourceCache = projcachePath(homeRoot, oldId)
  const targetCache = projcachePath(homeRoot, newId)
  const cacheSrcExists = existsSync(sourceCache)
  const registry = workspaceRegistryPath(homeRoot)
  const registryText = existsSync(registry) ? readFileSync(registry, 'utf8') : ''
  const registryHasOld = hasIdToken(registryText, oldId)

  const pieces = {
    dir: sourceDirs.length > 0,
    cache: cacheSrcExists,
    registry: registryHasOld,
  }
  const patchedTargets = {
    dirHeader: targetDirs.some((dir) => {
      const file = join(dir, LOG_FILE)
      if (!existsSync(file)) return false
      return hasIdToken(zstdDecompressSync(readFileSync(file)).toString('utf8'), oldId)
    }),
    cacheContent: existsSync(targetCache) && hasIdToken(readFileSync(targetCache, 'utf8'), oldId),
  }

  result.found = pieces.dir || pieces.cache || pieces.registry || patchedTargets.dirHeader || patchedTargets.cacheContent
  if (!result.found) {
    result.reason = 'absent'
    return result
  }

  // 冲突按**同一件**存储判断：日志目录源与目标并存、或 projcache 源与目标并存 →
  // 真正的分歧，绝不合并、绝不覆盖、绝不删除（Windows 的 rename 会静默替换文件，
  // 必须在这里拦住）。跨件组合（目录已改名、缓存/头部未搬）是崩溃续跑态，必须放行。
  const dirConflict = pieces.dir && targetDirs.length > 0
  const cacheConflict = pieces.cache && existsSync(targetCache)
  if (dirConflict || cacheConflict) {
    result.reason = 'target-exists'
    result.conflict = { oldId, newId }
    return result
  }

  // 撕裂/损坏预检：在任何改名之前扫源日志帧结构。半途抛错会留下
  // 「目录已改名、头部未改」的僵局，宁可整体不迁也不冒险。
  if (pieces.dir) {
    for (const dir of sourceDirs) {
      const file = join(dir, LOG_FILE)
      if (!existsSync(file)) continue
      try {
        const scan = scanZstdFrames(readFileSync(file))
        if (scan.tornStart !== undefined) {
          result.reason = 'torn-log'
          result.torn = { file, byte: scan.tornStart }
          return result
        }
      } catch (error) {
        result.reason = 'corrupt-log'
        result.error = String(error && error.message ? error.message : error)
        return result
      }
    }
  }

  if (pieces.dir) {
    for (const dir of sourceDirs) {
      result.actions.push({ kind: 'rename-dir', from: dir, to: dir.slice(0, dir.length - oldId.length) + newId })
    }
  }
  // 头部修补目标：A 执行后在新目录；A 无源（崩溃恢复半途）时在既有目标目录。
  const headerDirsAfter = pieces.dir
    ? sourceDirs.map((dir) => dir.slice(0, dir.length - oldId.length) + newId)
    : targetDirs
  for (const dir of headerDirsAfter) result.actions.push({ kind: 'rewrite-log-header', dir })
  if (pieces.cache) {
    result.actions.push({ kind: 'rename-projcache', from: sourceCache, to: targetCache })
  } else if (patchedTargets.cacheContent) {
    result.actions.push({ kind: 'patch-projcache-content', file: targetCache })
  }
  if (registryHasOld) result.actions.push({ kind: 'patch-workspace-registry', file: registry })

  log((apply ? '[migrate] ' : '[plan] ') + oldId + ' -> ' + newId + ' (' + result.actions.length + ' actions)')
  for (const action of result.actions) log('    ' + action.kind + ' ' + (action.to || action.dir || action.file || action.from || ''))

  if (!apply) {
    result.moved = false
    result.reason = 'dry-run'
    return result
  }

  // 执行顺序：目录改名 → 头部修补 → projcache → 注册表。每步幂等，可重跑续完。
  for (const dir of sourceDirs) {
    const target = dir.slice(0, dir.length - oldId.length) + newId
    renameSync(dir, target)
  }
  for (const dir of headerDirsAfter) {
    const file = join(dir, LOG_FILE)
    if (!existsSync(file)) continue
    // 帧感知改写：多帧追加日志的消息在后续帧，整文件解压重写会丢帧（见头注释）。
    const rewritten = rewriteIdTokenInFrames(readFileSync(file), oldId, newId)
    if (rewritten.swapped > 0) writeFileSync(file, rewritten.bytes)
  }
  if (cacheSrcExists) {
    renameSync(sourceCache, targetCache)
  }
  if (existsSync(targetCache)) {
    const text = readFileSync(targetCache, 'utf8')
    if (hasIdToken(text, oldId)) writeFileSync(targetCache, swapIdToken(text, oldId, newId))
  }
  if (registryHasOld) {
    writeFileSync(registry, swapIdToken(registryText, oldId, newId))
  }
  result.moved = true
  return result
}

// --- 分级阶段 ---------------------------------------------------------------

/**
 * stage:
 *   'ids'    —— 第二点：纯 slug 旧 id → 新 id（防碰撞方案落地）
 *   'legacy' —— 第一点：双前缀旧 id → 新 id（归并双前缀历史）
 *   'cleanup'—— 第三点：删除0.1.x bootstrap 孤儿会话（仅它自己的两件套）
 * keys 为权威会话键（channel:conversation 形态）。dry-run 默认。
 */
export function runMigrationStage(homeRoot, stage, keys = [], { apply = false, log = () => {} } = {}) {
  const results = []
  if (stage === 'cleanup') {
    const name = BOOTSTRAP_SESSION_ID
    const dirs = listWorkspaceDirs(homeRoot).map((ws) => join(ws, name)).filter((dir) => existsSync(dir))
    const cache = projcachePath(homeRoot, name)
    const cacheExists = existsSync(cache)
    const found = dirs.length > 0 || cacheExists
    const result = { stage, id: name, found, moved: false, reason: found ? undefined : 'absent', actions: [] }
    for (const dir of dirs) result.actions.push({ kind: 'remove-dir', path: dir })
    if (cacheExists) result.actions.push({ kind: 'remove-projcache', path: cache })
    log((apply ? '[cleanup] ' : '[cleanup-plan] ') + name + ' (' + result.actions.length + ' actions)')
    for (const action of result.actions) log('    ' + action.kind + ' ' + action.path)
    if (apply && found) {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
      if (cacheExists) unlinkSync(cache)
      result.moved = true
    } else if (!apply && found) {
      result.reason = 'dry-run'
    }
    results.push(result)
    return results
  }

  if (stage !== 'ids' && stage !== 'legacy') {
    throw new Error('unknown stage: ' + stage)
  }
  if (!keys.length) throw new Error('stage ' + stage + ' requires at least one --key')

  for (const key of keys) {
    const newId = sessionIdForKey(key)
    const oldId = stage === 'ids'
      ? legacySlugSessionId(key)
      : doublePrefixedSessionId(key)
    if (!oldId) {
      results.push({ stage, key, found: false, moved: false, reason: 'no-legacy-shape' })
      continue
    }
    const result = migrateSessionStore(homeRoot, oldId, newId, { apply, log })
    results.push({ stage, key, oldId, newId, ...result })
  }
  return results
}
