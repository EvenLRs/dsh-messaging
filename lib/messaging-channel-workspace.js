// 渠道默认工作区与成员（0.3.7）：某渠道首次新建会话时，在宿主默认工作区下建
// `<default-workspace>/<channel>` 目录并登记为 Workspace，之后该渠道的新会话
// 以它为 cwd。宿主在首次初始化后使用显式成员关系。插件调用 attachSession，
// 由宿主核对会话的规范 cwd 与工作区路径一致。
//
// 只用宿主公开的 `ctx.workspaceController`（create / initializeDefault）与可选的
// `ctx.workspaceRegistry`（get / list / resolveByPath）。没有可用工作区时返回 null，
// 调用方也会捕获异常并沿用原 agent.cwd。
//
// 每渠道一份 fsynced 标记。加入成功后只追加 session ID，尊重用户之后手动移除会话。
// 用户移除工作区登记或删除目录后，保留标记并回到原 cwd。
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

export const CHANNEL_WORKSPACE_STORE = 'messaging-channel-workspaces-v1'
// 宿主固定的默认工作区目录名（dsh-api-workspace-controller DEFAULT_WORKSPACE_DIRECTORY）。
export const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const DEFAULT_LOOKUP_TIMEOUT_MS = 20000
const MAX_ATTACHED_SESSIONS = 10000
// Plugin reapplication can overlap an older attachment in the same process.
const jobs = new Map()
const failedAttachments = new Map()

function validChannel(channel) {
  return typeof channel === 'string' && CHANNEL_PATTERN.test(channel)
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/**
 * @param {object} options
 * @param {string} options.root - 标记目录（DSH 宿主存储根下）。
 * @param {() => { controller?: any, registry?: any }} options.services - 现取可选宿主服务。
 * @param {number} [options.lookupTimeoutMs] - initializeDefault 的上限。
 * @param {() => number} [options.now]
 */
export function createChannelWorkspaces({ root, services, lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS, now = Date.now }) {
  function markerFile(channel) { return join(root, channel + '.json') }

  function load(channel) {
    const file = markerFile(channel)
    let row
    try {
      if (!lstatSync(file).isFile()) throw new Error('channel_workspace_store_invalid')
      row = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      // 损坏/权限/符号链接：失败关闭，不回显路径或内容。
      throw new Error('channel_workspace_store_invalid')
    }
    if (!row || row.version !== 1 || row.channel !== channel
      || typeof row.path !== 'string' || !isAbsolute(row.path) || basename(row.path) !== channel
      || typeof row.workspaceId !== 'string' || !row.workspaceId || !Number.isFinite(row.createdAt)) {
      throw new Error('channel_workspace_store_invalid')
    }
    const ids = row.attachedSessionIds
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_ATTACHED_SESSIONS
      || ids.some(id => typeof id !== 'string' || !id))) {
      throw new Error('channel_workspace_store_invalid')
    }
    return row
  }

  function save(row) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const file = markerFile(row.channel)
    const tmp = file + '.tmp-' + randomUUID()
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      try {
        writeFileSync(fd, JSON.stringify(row))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
      if (process.platform !== 'win32') {
        const dir = openSync(root, 'r')
        try { fsyncSync(dir) } finally { closeSync(dir) }
      }
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  // 默认工作区：优先宿主自己的首次使用身份（已初始化则直接返回、不再查 Documents；
  // 注册表与会话历史都为空时按宿主规则创建，和首次打开桌面端的行为相同）。
  // 不合格（如老安装从未初始化）时，再找已登记的 `default-workspace` 目录。
  async function defaultWorkspacePath(controller, registry) {
    if (typeof controller.initializeDefault === 'function') {
      const value = await controller.initializeDefault(AbortSignal.timeout(lookupTimeoutMs))
      const path = value && value.workspace && value.workspace.path
      if (typeof path === 'string' && path) return path
    }
    if (registry && typeof registry.list === 'function') {
      const hit = registry.list().find(ws => ws && typeof ws.path === 'string' && basename(ws.path) === DEFAULT_WORKSPACE_DIRECTORY)
      if (hit) return hit.path
    }
    return null
  }

  function validatedPath(marker, registry) {
    if (!marker || !isDirectory(marker.path) || realpathSync(marker.path) !== marker.path) return null
    if (typeof registry?.get === 'function' && registry.get(marker.workspaceId)?.path !== marker.path) return null
    return marker.path
  }

  async function resolveNow(channel) {
    const { controller, registry } = services() || {}
    const marker = load(channel)
    if (marker) return validatedPath(marker, registry)
    if (!controller || typeof controller.create !== 'function') return null
    const base = await defaultWorkspacePath(controller, registry)
    if (!base || !isDirectory(base)) return null
    const dir = join(realpathSync(base), channel)
    mkdirSync(dir, { recursive: true })
    // Keep cwd under the default workspace even if the channel directory was pre-created.
    if (realpathSync(dir) !== dir) throw new Error('invalid channel workspace directory')
    const value = await controller.create({ path: dir })
    const workspace = value?.workspace
    if (workspace?.path !== dir || typeof workspace.workspaceId !== 'string' || !workspace.workspaceId) {
      throw new Error('invalid channel workspace registration')
    }
    save({ version: 1, channel, path: workspace.path, workspaceId: workspace.workspaceId, createdAt: now() })
    return workspace.path
  }

  function serialize(channel, run) {
    const key = markerFile(channel)
    const previous = jobs.get(key) || Promise.resolve()
    const pending = previous.catch(() => {}).then(run)
    jobs.set(key, pending)
    pending.finally(() => { if (jobs.get(key) === pending) jobs.delete(key) }).catch(() => {})
    return pending
  }

  async function attachNow(channel, { sessionId, cwd, current }) {
    if (!current()) return
    const { registry } = services() || {}
    if (typeof registry?.resolveByPath !== 'function') return
    const key = markerFile(channel)
    const failed = failedAttachments.get(key)
    if (failed?.has(sessionId) || failed?.size >= MAX_ATTACHED_SESSIONS) return
    try {
      const marker = load(channel)
      const ids = marker?.attachedSessionIds || []
      // Keep durable receipts when full. Eviction could re-add manually removed sessions.
      if (ids.includes(sessionId) || ids.length >= MAX_ATTACHED_SESSIONS || !marker || cwd !== marker.path) return
      const path = validatedPath(marker, registry)
      if (!path) return
      const workspace = await registry.resolveByPath(path)
      if (typeof workspace?.attachSession !== 'function' || !current()) return
      if (workspace.id !== undefined && workspace.id !== marker.workspaceId) return
      await workspace.attachSession(sessionId)
      if (current()) save({ ...marker, attachedSessionIds: [...ids, sessionId] })
    } catch (error) {
      if (failed) failed.add(sessionId)
      else failedAttachments.set(key, new Set([sessionId]))
      throw error
    }
  }

  return {
    /**
     * @param {string} channel - 适配器渠道 key（onebot/telegram/discord/slack/lark/wecom/wechat）。
     * @returns {Promise<string|null>} 该渠道的工作区目录；null = 沿用原 cwd。
     */
    resolve(channel) {
      if (!validChannel(channel)) return Promise.resolve(null)
      // 同渠道串行：并发首条消息只建一次目录、登记一次。
      return serialize(channel, () => resolveNow(channel))
    },
    lookup(channel) {
      if (!validChannel(channel)) return null
      return validatedPath(load(channel), services()?.registry)
    },
    attach(channel, { sessionId, cwd, current = () => true }) {
      if (!validChannel(channel) || typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd) return Promise.resolve()
      return serialize(channel, () => attachNow(channel, { sessionId, cwd, current }))
    },
  }
}
