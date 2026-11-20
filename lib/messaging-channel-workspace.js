// 渠道默认工作区（0.3.6）：某渠道首次新建会话时，在宿主默认工作区下建
// `<default-workspace>/<channel>` 目录并登记为 Workspace，之后该渠道的新会话
// 以它为 cwd。宿主按会话 cwd 的规范路径**精确匹配**归组，所以目录必须单独登记，
// 会话才会出现在该工作区下。
//
// 只用宿主公开的 `ctx.workspaceController`（create / initializeDefault）与可选的
// `ctx.workspaceRegistry`（get / list，只读）。没有可用工作区时返回 null，
// 调用方也会捕获异常并沿用原 agent.cwd。
//
// 每渠道一份 fsynced 标记（不含会话/消息 id 与正文）：登记成功才写。之后用户移除
// 该工作区登记或删除目录，均视为不再需要，不自动重建（与宿主默认工作区“删除登记
// 不再自动创建”的语义一致），回到原 cwd。
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

export const CHANNEL_WORKSPACE_STORE = 'messaging-channel-workspaces-v1'
// 宿主固定的默认工作区目录名（dsh-api-workspace-controller DEFAULT_WORKSPACE_DIRECTORY）。
export const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const DEFAULT_LOOKUP_TIMEOUT_MS = 20000

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
  const jobs = new Map()

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

  async function resolveNow(channel) {
    const { controller, registry } = services() || {}
    const marker = load(channel)
    if (marker) {
      if (!isDirectory(marker.path)) return null
      if (realpathSync(marker.path) !== marker.path) return null
      if (typeof registry?.get === 'function' && registry.get(marker.workspaceId)?.path !== marker.path) return null
      return marker.path
    }
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

  return {
    /**
     * @param {string} channel - 适配器渠道 key（onebot/telegram/discord/slack/lark/wecom/wechat）。
     * @returns {Promise<string|null>} 该渠道的工作区目录；null = 沿用原 cwd。
     */
    resolve(channel) {
      if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) return Promise.resolve(null)
      // 同渠道串行：并发首条消息只建一次目录、登记一次。
      const previous = jobs.get(channel) || Promise.resolve()
      const pending = previous.catch(() => {}).then(() => resolveNow(channel))
      jobs.set(channel, pending)
      pending.finally(() => { if (jobs.get(channel) === pending) jobs.delete(channel) }).catch(() => {})
      return pending
    },
  }
}
