// dsh-messaging 启动壳
//
// 职责：
//   1) 把伴随脚本同步到 ~/.dsh-messaging/companion，并预置用户级 config.json
//      （nodePath=当前进程 Node、wsModulePath=profile 内 ws、companionDir=用户目录）；
//   2) 等宿主服务（agents / dynamicCordisRunner）就绪后，创建专属 bootstrap 会话；
//   3) 用该会话 cordis_define 注册 dsh-messaging 动态插件，并自动激活 Host 半区；
//      Client 半区（设置页与状态面板）受官方安全模型限制，需用户在 UI 上手动 Run。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const ID_PREFIX = 'dshmsg'
const SESSION_ID = 'dsh-messaging-bootstrap'
const RETRY_MS = 1500
const CONFIG_ROOT_MARKER = "const CONFIG_ROOT_OVERRIDE = ''"

// cordis 严格模式：访问 ctx.interval（timer 插件提供）必须显式声明依赖
export const inject = ['timer']
export const name = 'dsh-messaging'

function ensureRuntimeHome() {
  // 配置根目录 = 用户主目录：host.js 会在 <root>/.dsh-messaging/config.json 读写配置
  const root = homedir()
  const configDir = join(root, '.dsh-messaging')
  const companionDir = join(configDir, 'companion')
  mkdirSync(companionDir, { recursive: true })
  for (const file of ['crypto-helper.cjs', 'discord-gateway.cjs']) {
    const src = join(pkgDir, 'companion', file)
    if (existsSync(src)) copyFileSync(src, join(companionDir, file))
  }
  const configPath = join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    let wsModulePath = ''
    try {
      wsModulePath = require.resolve('ws')
    } catch {
      // profile 未解析到 ws 时留空：Discord 网关不可用，其余渠道不受影响
    }
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          workspaceRoot: root,
          runtime: {
            nodePath: process.execPath,
            wsModulePath,
            companionDir,
          },
        },
        null,
        2,
      ),
    )
  }
  return root
}

export function apply(ctx) {
  const home = ensureRuntimeHome()
  let started = false
  let currentHandle = null
  let currentRunner = null
  let currentPluginId = null

  async function cleanup() {
    if (currentRunner && currentHandle?.agent && currentPluginId) {
      try {
        await currentRunner.undefine(currentHandle.agent, currentPluginId)
      } catch (err) {
        console.warn('[dsh-messaging] cleanup undefine failed:', err)
      }
    }
    if (currentHandle) {
      try {
        await currentHandle.dispose()
      } catch (err) {
        console.warn('[dsh-messaging] cleanup handle dispose failed:', err)
      }
    }
    currentHandle = null
    currentPluginId = null
  }

  const timer = ctx.interval(async () => {
    if (started) return
    let runner
    let agents
    try {
      runner = ctx.get('dynamicCordisRunner')
      agents = ctx.get('agents')
    } catch {
      return // 宿主服务尚未挂载，下轮重试
    }
    if (!runner || !agents) return
    started = true
    currentRunner = runner

    let handle = null
    let defined = null
    try {
      handle = await agents.create({
        sessionId: SESSION_ID,
        meta: { cwd: home },
        agentOptions: {},
      })
      currentHandle = handle

      const hostSource = readFileSync(join(pkgDir, 'dynamic', 'host.js'), 'utf8').replace(
        CONFIG_ROOT_MARKER,
        `const CONFIG_ROOT_OVERRIDE = ${JSON.stringify(home)}`,
      )
      const clientSource = readFileSync(join(pkgDir, 'dynamic', 'client.js'), 'utf8')
      defined = runner.define({
        sessionId: handle.agent.id,
        plugin: { kind: 'new', idPrefix: ID_PREFIX },
        name: 'dsh-messaging',
        purpose:
          'DSH 内置消息渠道网关：OneBot v11、Telegram、Discord、Slack、飞书/Lark、企业微信、个人微信',
        code: { host: hostSource, client: clientSource },
      })
      currentPluginId = defined.pluginId

      const outcome = await runner.runHostHalf(
        handle.agent,
        defined.pluginId,
        defined.packageId,
        'run',
        null,
        false,
      )

      if (!outcome || outcome.ok === false) {
        const errorMsg = outcome?.message || 'unknown error'
        console.error(`[dsh-messaging] runHostHalf failed for ${defined.pluginId}/${defined.packageId}: ${errorMsg}`)
        await cleanup()
        started = false
        return
      }

      console.log(
        `[dsh-messaging] activated ${defined.pluginId}/${defined.packageId} (Host half online)`,
      )
    } catch (error) {
      console.error('[dsh-messaging] bootstrap failed:', error)
      await cleanup()
      started = false // 会话/激活竞态或异常时清理并等待下轮重试
    }
  }, RETRY_MS)

  return async () => {
    if (timer) timer()
    await cleanup()
  }
}
