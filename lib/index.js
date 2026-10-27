// dsh-messaging 静态 Host 半区。
// companion 同步与用户级 config 预置在 apply 开头完成；业务逻辑从原动态工厂迁出。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute as pathIsAbsolute, relative as pathRelative, resolve as resolveAbsolutePath } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'

import { qrSvgDataUrl } from './qr-image.js'
import { shellRun, shellStart } from './shell-compat.js'
import {
  legacySessionIdsForKey,
  migrateSessionStore,
  sessionIdForKey,
} from './session-id-migration.js'
// 飞书实时出站：已验收的卡片 API / 布局 / splitter / 流式状态机模块。
// splitText 必须取别名——本文件模块级已有同名的码点分段函数（telegram/discord/slack 用）。
import { createLarkStream, createLarkStreamHub } from './lark-stream.js'
import {
  finishStreamingCard,
  sendInteractiveCardDirect,
  sendStreamingCard,
  updateCardElementContent,
} from './lark-card-api.js'
import {
  STREAMING_ELEMENT_ID,
  createStaticCard,
  createStreamingCard,
  createTextSegmentCard,
} from './lark-card-layout.js'
import { splitText as splitLarkText } from './lark-text-splitter.js'
import { createLarkDiagnostics, createLarkInstanceEpoch, deriveImageScopeGrants, LARK_SCOPE_CARDKIT_WRITE, LARK_SCOPE_READ_URL, LARK_DEDUP_LAST_ERRORS } from './lark-diagnostics.js'
// P1：入站持久去重（单写者 OS flock lease；见 lib/lark-dedup.js）。
import { openLarkDedupStore } from './lark-dedup.js'
// P1：admission 投影与三态判据（followup 入队后 settle 依据）。
import {
  LARK_ADMISSION_KEY, LARK_ADMISSION_VERDICTS,
  createLarkAdmissionDefinition, larkAdmissionInboxIds, larkAdmissionVerdict,
} from './lark-admission.js'
// P4：图片出站工具（W1–W9 seams 接线；缺 seam=结构化拒绝，不破文本流）。
import { createLarkImageHost } from './lark-image.js'
// C-1：恢复失败的固定无正文告知（复用 store.sendReceipts，独立 notice 域）。
import { sendLarkNotice } from './lark-notice.js'

const require = createRequire(import.meta.url)
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')

// Loader 条目 id = settings 的 ns。真机从 fiber 取；测试可用 ctx.get 钩子注入。
function resolveEntryId(ctx) {
  try {
    const entry = ctx.fiber && ctx.fiber.entry
    if (entry && entry.options && entry.options.id) return entry.options.id
  } catch {
    /* 非 Cordis 上下文 */
  }
  try {
    const hook = ctx.get && ctx.get('dshMessaging.entryId')
    if (typeof hook === 'string' && hook) return hook
  } catch {
    /* 生产环境无此测试钩子 */
  }
  return undefined
}

function validateConfigValue(dotted, value) {
  const probe = {}
  writePathValue(probe, dotted, value)
  const result = Config['~standard'].validate(probe)
  if (result.issues && result.issues.length) throw new Error(result.issues[0].message)
  const resolved = unwrapVolatile(result.value)
  if (!deepEqualValues(readPathValue(resolved, dotted), value)) {
    throw new Error('value rejected by schema (normalized to ' + JSON.stringify(readPathValue(resolved, dotted)) + ')')
  }
}

export const name = 'dsh-messaging'
export const inject = ['webServer', 'shell', 'fs', 'agents', 'timer', 'agentDefaultModel']

function ensureRuntimeHome() {
  const root = homedir()
  const configDir = join(root, '.dsh-messaging')
  const companionDir = join(configDir, 'companion')
  mkdirSync(companionDir, { recursive: true })
  for (const file of ['crypto-helper.cjs', 'discord-gateway.cjs']) {
    const srcPath = join(pkgDir, 'companion', file)
    if (existsSync(srcPath)) copyFileSync(srcPath, join(companionDir, file))
  }
  // P2b：不再生成 config.json。骨架文件会让导入每次启动都重新造一份；
  // 旧路径的真源改由 loadConfig()（未被 Loader 挂载时）自己写。
  return root
}

function resolveConfigRoot(ctx) {
  try {
    const override = ctx.get('dshMessaging.root')
    if (typeof override === 'string' && override) return override
  } catch {
    /* 生产环境无此测试钩子 */
  }
  return ensureRuntimeHome()
}

export function defaultConfig(root) {
  return {
    version: 1,
    workspaceRoot: root,
    runtime: {
      nodePath: '',
      wsModulePath: '',
      companionDir: '',
      pollIntervalMs: 2500,
      telegramLongPollTimeoutSec: 40,
      shellTimeoutMs: 60000,
      stdoutMaxBytes: 2 * 1024 * 1024,
    },
    agent: {
      cwd: root,
      agentPreset: '',
      provider: null,
      model: null,
    },
    adapters: {
      onebot: {
        enabled: true,
        endpoint: 'http://127.0.0.1:5700',
        accessToken: '',
        secret: '',
        webhookPath: '/messaging/onebot',
        selfId: null,
      },
      telegram: {
        enabled: false,
        token: '',
        mode: 'polling',
        webhookSecret: '',
        webhookPath: '/messaging/telegram/webhook',
        pollIntervalMs: 2500,
        longPollTimeoutSec: 40,
        dropPendingUpdates: false,
      },
      discord: {
        enabled: false,
        botToken: '',
        intents: 33281,
        wsModulePath: '',
      },
      slack: {
        enabled: false,
        botToken: '',
        signingSecret: '',
        verificationToken: '',
        webhookPath: '/messaging/slack/events',
      },
      lark: {
        enabled: false,
        appId: '',
        appSecret: '',
        // 订阅方式：长连接（WebSocket，推荐）或 webhook（HTTP 回调）。
        // 长连接只凭 appId/appSecret 在建连时鉴权，事件为明文、无需验签，
        // 因此不需要公网地址、verificationToken 或 encryptKey。
        mode: 'long-connection',
        interactiveCard: false,
        sendCapacity: null,
        // 仅 webhook 方式使用，由用户填写（须与飞书控制台一致）。
        verificationToken: '',
        // 仅 webhook 方式使用。Encrypt Key 由飞书控制台生成，用户复制填入；
        // 留空即要求飞书侧以明文模式推送。
        encryptKey: '',
        webhookPath: '/messaging/lark/events',
      },
      wecom: {
        enabled: false,
        corpId: '',
        agentId: '',
        secret: '',
        token: '',
        encodingAESKey: '',
        webhookPath: '/messaging/wecom/callback',
      },
      wechat: {
        enabled: false,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        // P2b：token 不在默认配置里（凭据 record 是真源）。legacy config.json 里
        // 的旧 token 由 loadConfig 的 deepMerge 保留，导入时迁到 record。
        botAgent: 'dsh-messaging',
        pollIntervalMs: 2500,
        longPollTimeoutSec: 35,
      },
    },
  }
}

// cosmokit 的 volatile 引用协议（Symbol.for 保证跨副本一致）：设置页改 volatile
// 字段时 Loader 只改写引用里的快照、fiber 不重启，所以读取必须每次 .get()。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

// 把 Loader 传入的 config（叶子上挂着 volatile 引用）解成普通快照。每次 rebuild
// 现取，不在 apply 开头缓存：否则热更新后读到的还是旧值。
function unwrapVolatile(value) {
  if (isVolatileRef(value)) return unwrapVolatile(value.get())
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (isObject(value)) {
    const result = {}
    for (const key of Object.keys(value)) result[key] = unwrapVolatile(value[key])
    return result
  }
  return value
}

// Loader 快照 → 运行时配置：schema 里 workspaceRoot / agent.cwd 不写默认值
// （依赖运行时根目录），这里兜底，与 legacy config.json 的语义保持一致。
function materializeConfig(snapshot, root, previousRoot) {
  const merged = deepMerge(defaultConfig(root), snapshot)
  merged.workspaceRoot = String(snapshot.workspaceRoot || previousRoot || root)
  merged.agent.cwd = String(snapshot.agent.cwd || merged.workspaceRoot)
  return merged
}

// 页面上要编辑的字段一律 .volatile()：dsh-settings 的 volatileForm()/write()
// 只投影 volatile 字段，写非 volatile 路径会直接抛 "is not volatile"，所以普通
// 字段在设置页上根本改不了。密钥再叠 .role('secret')，describe 只回存在性。
// 范围：adapters.*（含 enabled / endpoint / path / id / mode / 间隔 / 密钥）与
// agent.*；version、workspaceRoot、runtime.* 是安装环境派生值，保持普通字段。
const INTERVAL_MS_MAX = 86400000 // 1 天：超过它的轮询间隔一定是填错了
const INTERVAL_SEC_MAX = 86400
const SHELL_TIMEOUT_MAX = 3600000 // 1 小时
const STDOUT_MAX_BYTES = 1073741824 // 1 GiB
const INTENTS_MAX = 2147483647

// 端口按 0–65535 全区间校验：正则做不了数值比较，只能逐段枚举。
const ENDPOINT_PATTERN = /^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[^\s/:?#]+)(?::(?:[0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:[\/?#][^\s]*)?$/i
// webhook 路径必须以 / 开头（空串表示「用渠道默认路径」，运行时 cfg.path || 默认）。
const WEBHOOK_PATH_PATTERN = /^$|^\/[^\s]*$/

const fieldText = (value = '') => z.string().default(value).volatile()
const fieldFlag = (value) => z.boolean().default(value).volatile()
const fieldCount = (value, max) => z.natural().max(max).default(value).volatile()
const fieldSecret = () => z.string().default('').role('secret').volatile()
const fieldMode = (choices, value) => z.union(choices).default(value).volatile()
const fieldNullableText = () => z.union([z.string(), z.const(null)]).default(null).volatile()
const fieldEndpoint = (value) => z.string().pattern(ENDPOINT_PATTERN).default(value).volatile()
const fieldWebhookPath = (value) => z.string().pattern(WEBHOOK_PATH_PATTERN).default(value).volatile()

/**
 * 官方设置页的配置 schema（P2a）。Loader 从 fiber.runtime.Config 读取，
 * 与 defaultConfig() 逐字段对应；叶子字段的 volatile/secret 元数据由
 * test/config-schema.cjs 对照 SECRET_FIELDS 与表单字段清单逐项守护。
 */
export const Config = z.object({
  version: z.natural().default(1),
  workspaceRoot: z.string().default(''),
  runtime: z.object({
    nodePath: z.string().default(''),
    wsModulePath: z.string().default(''),
    companionDir: z.string().default(''),
    pollIntervalMs: z.natural().max(INTERVAL_MS_MAX).default(2500),
    telegramLongPollTimeoutSec: z.natural().max(INTERVAL_SEC_MAX).default(40),
    shellTimeoutMs: z.natural().max(SHELL_TIMEOUT_MAX).default(60000),
    stdoutMaxBytes: z.natural().max(STDOUT_MAX_BYTES).default(2 * 1024 * 1024),
  }),
  agent: z.object({
    cwd: fieldText(''),
    agentPreset: fieldText(''),
    provider: fieldNullableText(),
    model: fieldNullableText(),
  }),
  adapters: z.object({
    onebot: z.object({
      enabled: fieldFlag(true),
      endpoint: fieldEndpoint('http://127.0.0.1:5700'),
      accessToken: fieldSecret(),
      secret: fieldSecret(),
      webhookPath: fieldWebhookPath('/messaging/onebot'),
      selfId: z.union([z.string(), z.number(), z.const(null)]).default(null).volatile(),
    }),
    telegram: z.object({
      enabled: fieldFlag(false),
      token: fieldSecret(),
      webhookSecret: fieldSecret(),
      mode: fieldMode(['polling', 'webhook'], 'polling'),
      webhookPath: fieldWebhookPath('/messaging/telegram/webhook'),
      pollIntervalMs: fieldCount(2500, INTERVAL_MS_MAX),
      longPollTimeoutSec: fieldCount(40, INTERVAL_SEC_MAX),
      dropPendingUpdates: fieldFlag(false),
    }),
    discord: z.object({
      enabled: fieldFlag(false),
      botToken: fieldSecret(),
      intents: fieldCount(33281, INTENTS_MAX),
      wsModulePath: fieldText(''),
    }),
    slack: z.object({
      enabled: fieldFlag(false),
      botToken: fieldSecret(),
      signingSecret: fieldSecret(),
      verificationToken: fieldSecret(),
      webhookPath: fieldWebhookPath('/messaging/slack/events'),
    }),
    lark: z.object({
      enabled: fieldFlag(false),
      appId: fieldText(''),
      appSecret: fieldSecret(),
      mode: fieldMode(['long-connection', 'webhook'], 'long-connection'),
      interactiveCard: fieldFlag(false),
      // send receipt 容量（ledger sendCapacity）：null=默认 2000（source:'default'）；
      // 显式整数（1..100000）→ source:'configured'。背压无 TTL/静默淘汰。
      sendCapacity: z.union([z.natural().max(100000), z.const(null)]).default(null).volatile(),
      verificationToken: fieldSecret(),
      encryptKey: fieldSecret(),
      webhookPath: fieldWebhookPath('/messaging/lark/events'),
    }),
    wecom: z.object({
      enabled: fieldFlag(false),
      corpId: fieldText(''),
      agentId: fieldText(''),
      secret: fieldSecret(),
      token: fieldSecret(),
      encodingAESKey: fieldSecret(),
      webhookPath: fieldWebhookPath('/messaging/wecom/callback'),
    }),
    wechat: z.object({
      enabled: fieldFlag(false),
      baseUrl: fieldEndpoint('https://ilinkai.weixin.qq.com'),
      // P2b：微信 bot token 不再进 Config，改存凭据 record（dsh-messaging/wechat-bot）。
      // 登录成功后写 record，扫码/入站只读 record；旧文件里的 token 由导入流程迁移。
      botAgent: fieldText('dsh-messaging'),
      pollIntervalMs: fieldCount(2500, INTERVAL_MS_MAX),
      longPollTimeoutSec: fieldCount(35, INTERVAL_SEC_MAX),
    }),
  }),
})

// ── P2b：写入收敛 / 旧配置导入 / 地址-密钥联动 ──────────────────────────────────

// 微信 bot token 的凭据 record（P2b 从 Config 迁出）：登录成功后写入，
// 出站与扫码读取，出站地址变更时删除。
export const WECHAT_CREDENTIAL_KEY = credentialKey('dsh-messaging', 'wechat-bot')

// 出站地址 → 随该地址发出的凭据。只列会把凭据发往可配置地址的字段；
// telegram / discord / slack / lark / wecom 的 API 地址都是硬编码，
// webhookPath 是入站路径（不带凭据出站），agent.cwd / workspaceRoot 不是出站地址。
const ADDRESS_SECRET_MAP = {
  'adapters.onebot.endpoint': { path: 'adapters.onebot.accessToken' },
  'adapters.wechat.baseUrl': { path: 'adapters.wechat.token', record: true },
}

// Config 中所有 volatile 叶子路径 = settings 表单可写的字段集合。
function collectVolatilePaths(node, prefix, out) {
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) return out
  if (node.dict && Object.keys(node.dict).length) {
    for (const key of Object.keys(node.dict)) collectVolatilePaths(node.dict[key], prefix.concat(key), out)
    return out
  }
  if (node.meta && node.meta.volatile) out.push(prefix.join('.'))
  return out
}

const VOLATILE_CONFIG_PATHS = collectVolatilePaths(Config, [], [])

function readPathValue(root, dotted) {
  let cursor = root
  for (const key of dotted.split('.')) {
    if (!isObject(cursor)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

function writePathValue(root, dotted, value) {
  const keys = dotted.split('.')
  let cursor = root
  for (const key of keys.slice(0, -1)) {
    if (!isObject(cursor[key])) cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

// 只投影 volatile 字段：settings.update 的 validatePaths 会拒绝任何非 volatile
// 路径，所以普通字段（version / workspaceRoot / runtime.*）不进 patch。
function volatileProjection(snapshot) {
  const patch = {}
  for (const dotted of VOLATILE_CONFIG_PATHS) {
    const value = readPathValue(snapshot, dotted)
    if (value === undefined) continue
    writePathValue(patch, dotted, value)
  }
  return patch
}

function deepEqualValues(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const left = Object.keys(a)
  const right = Object.keys(b)
  if (left.length !== right.length) return false
  for (const key of left) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqualValues(a[key], b[key])) return false
  }
  return true
}

// 地址规范化：只比较“真正发往哪里”。尾部斜杠、默认端口、主机大小写、空路径
// 都视为同一个地址，不算变更。
function normalizeAddress(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!text) return ''
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return text.replace(/\/+$/, '')
  }
  const protocol = parsed.protocol.toLowerCase()
  const defaultPort = protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : ''
  const port = parsed.port && parsed.port !== defaultPort ? ':' + parsed.port : ''
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return protocol + '//' + parsed.hostname.toLowerCase() + port + pathname + parsed.search + parsed.hash
}

/**
 * 「改了出站地址就清掉随该地址发出的密钥」（P2b 追加需求）——规则只写这一处：
 * 唯一入口是 loader/volatile-update（设置页保存 → settings.update → 该事件）。
 * （P5：旧 POST /config 路由已删除，它曾经也在 settings.update 之前调用这里。）
 * 返回要清的配置密钥（ops）、要删的凭据 record（clearWechatRecord）与提示文案。
 * options.internal：插件自己发起的写入（扫码登录回写 baseUrl）不触发。
 * options.wechatTokenProvided：同一次写入带了新微信 token（写 record 而非删）。
 */
function diffAddressSecrets(previous, next, options) {
  const opts = options || {}
  const result = { ops: [], clearWechatRecord: false, messages: [] }
  if (opts.internal) return result
  for (const addressPath of Object.keys(ADDRESS_SECRET_MAP)) {
    const target = ADDRESS_SECRET_MAP[addressPath]
    const before = normalizeAddress(readPathValue(previous, addressPath))
    const after = normalizeAddress(readPathValue(next, addressPath))
    if (!after || after === before) continue
    if (target.record) {
      if (opts.wechatTokenProvided) continue
      result.clearWechatRecord = true
      // 未被 Loader 挂载的旧路径里，token 还可能躺在 config.json/快照里，一并清掉
      // （volatile 路径写不进 profile，由调用方只在内存里生效）。
      if (isSecretSet(readPathValue(next, target.path))) result.ops.push({ path: target.path, value: '' })
      result.messages.push('wechat: outbound address changed, the stored WeChat credential was cleared, scan again / 出站地址已变更，已清除微信凭据，请重新扫码')
      continue
    }
    const secretPath = target.path
    const beforeSecret = readPathValue(previous, secretPath)
    const afterSecret = readPathValue(next, secretPath)
    if (!isSecretSet(afterSecret)) continue
    // 同一次写入里密钥变了（新值，包括旧文件导入时“新地址+新密钥”一起进来）
    // 就算“显式提供了新密钥”，保留；没变才是随地址发出的旧凭据 → 清空。
    if (String(afterSecret) !== String(beforeSecret)) continue
    result.ops.push({ path: secretPath, value: '' })
    result.messages.push('onebot: outbound address changed, ' + secretPath + ' was cleared, please re-enter it / 出站地址已变更，已清除 ' + secretPath + '，请重新填写')
  }
  return result
}

const CHANNEL_DEFS = [
  { key: 'onebot', label: 'OneBot v11', kind: 'http' },
  { key: 'telegram', label: 'Telegram', kind: 'polling-or-http' },
  { key: 'discord', label: 'Discord', kind: 'gateway-ws' },
  { key: 'slack', label: 'Slack', kind: 'events-api' },
  { key: 'lark', label: 'Lark / Feishu', kind: 'events-api' },
  { key: 'wecom', label: 'WeCom', kind: 'callback' },
  { key: 'wechat', label: 'Personal WeChat', kind: 'bridge' },
]

// Agentless shell calls (curl HTTP, companion node scripts) cannot resolve a
// per-session workspace-write ACL root; the deployment fallback root is not
// always ACL-grantable, so these fixed-shape commands run unconfined.
const SHELL_SANDBOX_POLICY = { mode: 'danger-full-access' }

// The host shell executor runs PowerShell. Quote every argument with pwsh
// single-quote doubling and leave the command name unquoted so the statement
// parses in command mode (adjacent quoted literals are a syntax error).
function pwshQuote(value) {
  const text = String(value)
  if (text === '') return "''"
  return "'" + text.replace(/'/g, "''") + "'"
}

function buildCommand(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return ''
  const head = String(parts[0])
  const rest = parts.slice(1)
  if (rest.length === 0) return head
  return head + ' ' + rest.map(pwshQuote).join(' ')
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanJson(value) {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(cleanJson)
  if (isObject(value)) {
    const result = {}
    for (const key of Object.keys(value)) {
      result[key] = cleanJson(value[key])
    }
    return result
  }
  return value
}

// ── 密钥脱敏（P1）─────────────────────────────────────────────────────────
// 设置接口绝不能把渠道密钥回传给浏览器：官方文档要求密钥以 role('secret') /
// 凭据引用的形式留在宿主侧，前端 type:'password' 只是遮挡显示，不算脱敏。
// 清单以 lib/client.js 的 CHANNEL_FIELDS 中 type:'password' 的字段为准，并对照
// defaultConfig() 核对补齐。注意 telegram.webhookSecret 只出现在用户配置文件里
// （defaultConfig 未声明），同样按密钥处理——清单比 defaultConfig 更宽是安全的。
export const SECRET_FIELDS = {
  onebot: ['accessToken', 'secret'],
  telegram: ['token', 'webhookSecret'],
  discord: ['botToken'],
  slack: ['botToken', 'signingSecret', 'verificationToken'],
  lark: ['appSecret', 'verificationToken', 'encryptKey'],
  wecom: ['secret', 'token', 'encodingAESKey'],
  wechat: ['token'],
}

// 已设置判断：地址策略（diffAddressSecrets）用它区分「已有值」与「未配置」。
function isSecretSet(value) {
  if (value === undefined || value === null) return false
  return String(value).length > 0
}



// ── status 出口脱敏（P1b）──────────────────────────────────────────────────
// channels[].lastError/detail、sessions[].meta、recent、errors 里可能回显密钥：
// companion 命令行（--secret / --signing-secret / --token / --aes-key）、带 token
// 的 URL（telegram `bot<token>/`、wecom `corpsecret=` / `access_token=`）、curl
// stderr 里的 `Authorization: Bearer …`。不在各个 recordError 调用点打补丁：出口
// 统一过两层过滤，写入时再过一遍作纵深防御。
const SECRET_MIN_LENGTH = 6 // 过短的值不做字面替换，免得把普通文本也打成 ***

// companion 进程的命令行参数名（值可能被抛出的错误 / stderr 原样回显）
const SECRET_CLI_FLAGS = [
  'secret', 'signing-secret', 'token', 'aes-key', 'key',
  'access-token', 'app-secret', 'bot-token', 'client-secret', 'encrypt-key', 'verify-token',
]

// URL 查询参数名（凭据常常拼在 query 里）
const SECRET_QUERY_PARAMS = [
  'access_token', 'tenant_access_token', 'corpsecret', 'appsecret', 'app_secret',
  'client_secret', 'signing_secret', 'bot_token', 'verify_token', 'verification_token',
  'encrypt_key', 'secret', 'token',
]

// `--flag value` / `--flag=value`；同时兼容宿主 shell 的 pwsh 单引号包裹：
// 实际命令形如 `'--secret' 'value'`，flag 后的引号与值两侧的引号都要放行。
const SECRET_CLI_RE = new RegExp(
  '(?<![A-Za-z0-9_-])(' + SECRET_CLI_FLAGS.map((flag) => '--' + flag).join('|') + ')[\'"]?(=|\\s+)("[^"]*"|\'[^\']*\'|\\S+)',
  'g',
)
// URL / 表单里的凭据参数（`?access_token=`、`&corpsecret=`、行首的 `secret=` 都算）
const SECRET_QUERY_RE = new RegExp('\\b(' + SECRET_QUERY_PARAMS.join('|') + ')=([^&\\s"\'<>]*)', 'gi')
const SECRET_AUTH_RE = /(\bAuthorization['"]?\s*:\s*)(?:(Bearer|Bot|Token)\s+)?[^\s"'<>]+/gi
const SECRET_SCHEME_RE = /\b(Bearer|Bot)\s+[^\s"'<>]+/gi
// telegram 的入站/出站 URL：…/bot<token>/<method>，token 形如 123456789:AAH-xxxx
const SECRET_TG_URL_RE = /\/bot[^/\s"'<>]+:[^/\s"'<>]{6,}/gi

// UI 路由响应里必须原值返回的字段：扫码图源与配对码由客户端直接使用，
// 一旦被打成 *** 就扫不了码 / 对不上号（它们本就不在值集合里，这里是兜底
// 防模式层误伤）。
const UI_PASSTHROUGH_KEYS = new Set(['qrcodeUrl', 'qrcode', 'pendingVerifyCode'])

// 第二层：模式匹配，负责“值本身不在已知密钥集合里”的情况（运行时令牌、
// 从别处复制进来的凭据）。
function redactSecretPatterns(text) {
  let out = text
  out = out.replace(SECRET_AUTH_RE, (match, prefix, scheme) => prefix + (scheme ? scheme + ' ' : '') + '***')
  out = out.replace(SECRET_SCHEME_RE, '$1 ***')
  out = out.replace(SECRET_TG_URL_RE, '/bot***')
  out = out.replace(SECRET_QUERY_RE, '$1=***')
  out = out.replace(SECRET_CLI_RE, '$1$2***')
  return out
}

// 第一层：值匹配——把已知密钥的字面值统一换成 ***。
function redactSecretText(text, values) {
  if (typeof text !== 'string' || !text) return text
  let out = text
  if (values) {
    for (const value of values) {
      if (typeof value !== 'string' || value.length < SECRET_MIN_LENGTH) continue
      if (out.indexOf(value) === -1) continue
      out = out.split(value).join('***')
    }
  }
  return redactSecretPatterns(out)
}

// 对象/数组递归：所有字符串字段都过两层过滤（keys 不动，它们只是字段名）。
function redactSecretNodes(value, values) {
  if (typeof value === 'string') return redactSecretText(value, values)
  if (Array.isArray(value)) return value.map((entry) => redactSecretNodes(entry, values))
  if (isObject(value)) {
    const result = {}
    for (const key of Object.keys(value)) result[key] = redactSecretNodes(value[key], values)
    return result
  }
  return value
}

// DSH 宿主存储根（会话日志 / storages 所在）。测试用 ctx.get('dsh.home') 注入
// 隔离目录，绝不能让惰性迁移碰到真实家目录。
function resolveDshHomeRoot(ctx) {
  try {
    const override = ctx.get && ctx.get('dsh.home')
    if (override) return String(override)
  } catch {
    // Fall through to the environment-derived default.
  }
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

function now() {
  return Date.now()
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function isApplicationJson(contentType) {
  const ct = String(contentType || '').toLowerCase().trim()
  return ct.startsWith('application/json')
}

function headerValue(headers, name) {
  if (!headers) return ''
  const direct = headers[name] || headers[name.toLowerCase()]
  if (direct) return String(direct).trim()
  const lower = String(name || '').toLowerCase()
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === lower) return String(headers[key] || '').trim()
  }
  return ''
}

function originOfUrl(urlLike) {
  try {
    return new URL(urlLike).origin
  } catch {
    return ''
  }
}

function hostnameFromHostHeader(host) {
  const raw = String(host || '').trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end > 1) return raw.slice(1, end)
    return ''
  }
  const colon = raw.lastIndexOf(':')
  if (colon > -1 && raw.indexOf(':') === colon) return raw.slice(0, colon)
  return raw
}

function unwrapIpv6Hostname(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (host.startsWith('[') && host.endsWith(']') && host.length > 2) return host.slice(1, -1)
  return host
}

function isLoopbackHostname(hostname) {
  const host = unwrapIpv6Hostname(hostname)
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function constantTimeEqual(a, b) {
  const strA = String(a || '')
  const strB = String(b || '')
  let mismatch = strA.length === strB.length ? 0 : 1
  const len = Math.max(strA.length, strB.length)
  for (let i = 0; i < len; i++) {
    const codeA = i < strA.length ? strA.charCodeAt(i) : 0
    const codeB = i < strB.length ? strB.charCodeAt(i) : 0
    mismatch |= codeA ^ codeB
  }
  return mismatch === 0
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/[\\/]+$/, '')
}

function joinUrl(base, path) {
  return trimTrailingSlash(base) + '/' + String(path || '').replace(/^\/+/, '')
}

function joinPath(base, path) {
  return trimTrailingSlash(base) + '/' + String(path || '').replace(/^\/+/, '')
}

function textPreview(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(value)
  if (chars.length <= (max || 140)) return value
  return chars.slice(0, max || 140).join('') + '…'
}

function extractTextBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!isObject(block)) return ''
      if (block.type === 'text') return String(block.text || '')
      if (block.type === 'reasoning') return ''
      return ''
    })
    .join('')
}

function splitText(text, max) {
  const chars = Array.from(String(text || ''))
  const chunks = []
  for (let index = 0; index < chars.length; index += max) {
    chunks.push(chars.slice(index, index + max).join(''))
  }
  return chunks.length ? chunks : ['']
}

function deepMerge(base, extra) {
  if (!isObject(base) && !isObject(extra)) return extra === undefined ? base : extra
  const result = isObject(base) ? Object.assign(Object.create(null), base) : Object.create(null)
  if (!isObject(extra)) return result
  for (const key of Object.keys(extra)) {
    const value = extra[key]
    if (value === undefined) continue
    if (isObject(value) && isObject(result[key])) result[key] = deepMerge(result[key], value)
    else result[key] = value
  }
  return result
}

function percentDecode(value) {
  return String(value || '').replace(/\+/g, ' ').replace(/%([0-9a-fA-F]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16))
  })
}

function parseQuery(url) {
  const query = String(url || '').split('?')[1] || ''
  const result = Object.create(null)
  if (!query) return result
  for (const part of query.split('&')) {
    if (!part) continue
    const index = part.indexOf('=')
    if (index < 0) result[percentDecode(part)] = ''
    else result[percentDecode(part.slice(0, index))] = percentDecode(part.slice(index + 1))
  }
  return result
}

function xmlTag(xml, tag) {
  const match = String(xml || '').match(new RegExp('<' + tag + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</' + tag + '>', 'i'))
  if (!match) return ''
  return (match[1] !== undefined ? match[1] : match[2] || '').trim()
}

// --- Personal WeChat via the ilink Bot API (Tencent/openclaw-weixin protocol) ---

function asciiBase64(input) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  let index = 0
  while (index < input.length) {
    const c1 = input.charCodeAt(index) & 0xff
    const c2 = index + 1 < input.length ? input.charCodeAt(index + 1) & 0xff : null
    const c3 = index + 2 < input.length ? input.charCodeAt(index + 2) & 0xff : null
    index += 3
    result += chars.charAt(c1 >> 2)
    result += chars.charAt(((c1 & 3) << 4) | (c2 === null ? 0 : c2 >> 4))
    result += c2 === null ? '=' : chars.charAt(((c2 & 15) << 2) | (c3 === null ? 0 : c3 >> 6))
    result += c3 === null ? '=' : chars.charAt(c3 & 63)
  }
  return result
}

// Headers shared by every ilink Bot API request (see openclaw-weixin src/api/api.ts).
function ilinkHeaders(token) {
  const headers = {
    'AuthorizationType': 'ilink_bot_token',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '65536', // 0x00010000 (channel_version 1.0.0)
    'X-WECHAT-UIN': asciiBase64(String(Math.floor(Math.random() * 0x100000000))),
  }
  if (token) headers.Authorization = 'Bearer ' + token
  return headers
}

// Lightweight headers for QR-status GET polls (no auth / no UIN; mirrors buildCommonHeaders).
function ilinkCommonHeaders() {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '65536',
  }
}

// Fixed API base used for every QR code request (openclaw-weixin FIXED_BASE_URL).
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

// 长轮询两次请求之间的**最小间隔**：网关秒回（200 + 空结果）时循环不得自旋——
// 微任务风暴会饿死整个事件循环（进程空转烧 CPU、宿主 UI 卡死；测试整体挂死过一次）。
// 真实长轮询本身耗时 ≥ 该间隔，正常路径不受影响；失败路径直接抛出也走不到这里。
const ILINK_MIN_POLL_GAP_MS = 500

// 会话被其他界面占用时（DSH 桌面端把同一个会话打开着）的退避重试：占用方关闭
// 会话后会很快释放，短试探即可覆盖；始终占用则给出可操作提示，不把渠道判成故障。
const SESSION_BUSY_RETRIES = 3
const SESSION_BUSY_RETRY_MS = 300

// 已知、无需处理的飞书事件表：每种都挂一个空处理器（避免每次打 `no … handle`
// 的 warn 噪声），同时它们也是「飞书在往这条连接推事件」的证据——**首次**出现
// 记一条 outcome='noted' 痕迹，之后只刷新 lastEventAt，不再留痕（已读回执每读
// 一条消息就会推一次，不能每次都刷 recent）。dispatcher.register 与
// makeLarkSdkLogger 里跳过 `execute X handle` 的判断都基于这张表；
// 消息事件 im.message.receive_v1 另有 inbound / lark-drop 痕迹，单独跳过。
const LARK_NOOP_EVENTS = new Set([
  'im.chat.access_event.bot_p2p_chat_entered_v1', // 用户进入与机器人的单聊
  'im.message.message_read_v1', // 消息已读回执
])
const LARK_REPLAY_TTL_MS = 6 * 60 * 1000

// ── 飞书实时出站预算（本地保守阈值，按各自接口分开；不冒充官方硬性条款）────────
// 完整 IM 请求体（receive_id + msg_type + content 序列化后）的本地保守 30KB 预算：
// 官方 content/请求体原文条款本次未核实，这里按「完整序列化 body ≤ 30KB」保守切分
// （宁可多分段也不越界）；该值不得当作所有接口的官方统一 30KB 上限。
const LARK_IM_BODY_MAX_BYTES = 30 * 1024
// 外层 IM 请求体包裹开销：按宽松 receive_id(64 字符) 估算，保证扣完成本预算后
// **完整 wire body** 也落在 30KB 内（审核要求：预算必须对完整序列化 body 成立）。
const LARK_IM_BODY_OVERHEAD_BYTES = Buffer.byteLength(
  JSON.stringify({ receive_id: 'o'.repeat(64), msg_type: 'interactive', content: '' }),
  'utf8',
) - 2 // 去掉 content 自身两侧引号
// 流式组件字符阈值：**本地/SDK 保守阈值，非官方硬限**——官方 Node SDK
// DEFAULT_MAX_ELEMENT_CHARS=30000（超限平台回 code 230099，230099 rollover 口径）；
// 官方 content 字段为 1~100000 字符（content.md L52），卡体 30KB 是另一条款
//（200860），与字符限分别控制、不得混称。
const LARK_CARDKIT_MAX_ELEMENT_CHARS = 30000
// 官方 streaming_mode 自动关闭窗口 10 分钟；提前 1 分钟（9 分钟）用 timer 主动
// 定格收尾；到期后任何 PUT/pin 都不可靠——先关旧卡再开新卡续写。
const LARK_CARD_EXPIRY_MS = 10 * 60 * 1000
const LARK_CARD_WINDOW_MS = 9 * 60 * 1000
// reload 时对旧队列的有界等待：网络悬挂不得让 reload 无限阻塞。
const LARK_CLEANUP_WAIT_MS = 5000
// 实时正文节流窗口：窗口内的增量合并成一次投递。
const LARK_STREAM_THROTTLE_MS = 200
// 单条 text/静态卡正文的字符上限（与 telegram/discord 同类分段），再叠加字节预算。
const LARK_TEXT_MESSAGE_MAX_CHARS = 4096

// JSON 字节度量：与 wire 上 content 字段的真实序列化大小一致（含膨胀）。
const larkJsonBytes = (value) => Buffer.byteLength(JSON.stringify(String(value)), 'utf8')
// 内容预算 = 完整 body 30KB − 外层包裹开销 − 各自的内层 JSON 包裹开销。
const LARK_TEXT_CONTENT_MAX_BYTES = LARK_IM_BODY_MAX_BYTES - LARK_IM_BODY_OVERHEAD_BYTES
  - (Buffer.byteLength(JSON.stringify({ text: '' }), 'utf8') - 2)
const LARK_STATIC_CARD_CONTENT_MAX_BYTES = LARK_IM_BODY_MAX_BYTES - LARK_IM_BODY_OVERHEAD_BYTES
  - (Buffer.byteLength(JSON.stringify(createStaticCard('')), 'utf8') - 2)

// 时钟注入点：测试可经 ctx.get('dshMessaging.larkClock') 注入 fake clock
//（now/setTimeout/clearTimeout）驱动 9/10 分钟窗口，不真实等待。
const realLarkClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

export async function apply(ctx, config) {
    const configRoot = resolveConfigRoot(ctx)
    const dshHomeRoot = resolveDshHomeRoot(ctx)
    // P2a 真源：Loader 传入的 config（volatile 字段是引用，热更新原地改写，fiber
    // 不重启）。未被 Loader 挂载时（老客户端直连、测试直接调用 apply(ctx)）为
    // null，继续读 ~/.dsh-messaging/config.json —— 这条兼容路径与 /config 路由
    // 一起保留到 P2b（旧文件导入/凭据迁移）。
    const loaderConfig = config === undefined ? null : config
    const readLoaderConfig = () => (loaderConfig ? unwrapVolatile(loaderConfig) : null)
    // P1：注册 admission 投影定义（host-only；重复注册 fail-safe 不影响其他域）。
    let admissionRegistrationFailed = false
    try {
      const projections = (ctx.get && ctx.get('sessionProjections')) || ctx.sessionProjections
      if (projections && typeof projections.register === 'function') {
        projections.register(createLarkAdmissionDefinition())
      }
    } catch { admissionRegistrationFailed = true }
    // ── P2b：可选服务引用。宿主没有 settings/credentials 时保持 null，代码降级到
    // 旧路径（config.json）/ 明确报错，不影响插件启动。
    const entryId = resolveEntryId(ctx)
    let settingsApi = null
    let credentialsApi = null
    let internalWrite = 0 // >0 = 插件自己发起的写入（不触发“改地址清密钥”）
    let importStatus = 'pending' // pending | blocked | skipped | done | failed
    let importRunning = null
    let pendingAddressClears = [] // settings 暂不可用时的欠账，可用后补写
    let pendingNotices = [] // 待写入的提示：等当前重建结束再写（重建会清空 errors）
    let rebuildQueue = Promise.resolve()
    const state = {
      config: null,
      workspaceRoot: '',
      configPath: '',
      generation: 0,
      // 实例身份（见 createLarkInstanceEpoch）：每次 apply 新建；同实例 reload 不变，
      // 重新 apply 必不同；仅等值比较，不排序、不认证、不派生。
      // 生成器已是 total 函数，此处再加 apply 边界兑底：任何意外一律降级 null
      //（明确未知身份），绝不让诊断故障阻断插件启动/路由注册。
      instanceEpoch: (() => {
        try { return createLarkInstanceEpoch() } catch { return null }
      })(),
      messageSeq: 0,
      // 泄露点 8：入站消息原文，只存内存供展示。入口不脱敏（排障要看原文），
      // **出口唯一**走 statusSnapshot 的 redactSecrets（GET /status、POST /reload）；
      // 除 statusSnapshot 外不得再读这个数组——新读取点必须先想过它会不会把
      // 用户消息、命令行参数或 Authorization 头送出去。
      recent: [],
      errors: [],
      // 已知密钥值（只增不减）：配置轮换后，历史事件里记录的旧值仍要能被脱敏。
      pastSecrets: new Set(),
      channels: [],
      sessions: Object.create(null),
      conversationAgents: Object.create(null),
      // 「会话同时被其他界面打开」的提示每个会话只记一次（避免每条消息刷屏 errors）。
      sessionSharedNotified: new Set(),
      // 飞书入站痕迹：connectedAt=最后一次 onReady 的时刻，lastEventAt=最后一个事件
      // 到达的时刻（含被丢弃的）。写在 state 里，由 setChannelState/syncLarkDetail
      // 同步进 lark 的 detail，否则状态切换会把痕迹抹掉。
      larkTrace: { connectedAt: null, lastEventAt: null, notedEvents: new Set() },
      larkSeenRequests: new Map(),
      // 匿名诊断 store：每代（channelGeneration.lark）一个，见 lib/lark-diagnostics.js。
      larkDiag: null,
      // P1：去重 store lease（null=未打开；open 失败/未接线 → status dedup.available=false）。
      larkDedup: null,
      sessionToConversation: Object.create(null),
      turnBuffer: Object.create(null),
      adapters: Object.create(null),
      // P2c：disposer 按渠道归属，只拆需要重建的那个渠道。
      disposersByChannel: Object.create(null),
      // P2c：按渠道代际；在途的轮询/循环用它判断自己是否过期，
      // 否则重建一个渠道会误杀其他渠道的循环（或旧循环退不出去）。
      channelGeneration: Object.fromEntries(CHANNEL_DEFS.map((def) => [def.key, 0])),
      telegramOffset: 0,
      telegramBotId: null,
      telegramPolling: false,
      // lark token 缓存按 runtime 对象隔离（见 larkAccessToken），无全局槽。
      wecomToken: null,
      wechatSeen: Object.create(null),
      wechatPolling: false,
      wechatUpdatesBuf: '',
      wechatContextTokens: Object.create(null),
      ilinkLogins: Object.create(null),
      discordProc: null,
      // 凭据 record 里的微信 token（P2b 起不进 Config）：只在内存里用于出站/扫码。
      wechatCredential: '',
      // ── 飞书实时出站运行时 ──
      // 本次适配器代际快照：stopAdapter/disposeAdapters 的逆序 disposer 里最先
      // 置空（invalidateLarkRuntime），token/网络 await 之后的每次派发都复核，
      // 旧链不得再打到新配置。
      larkRuntime: null,
      // 旧代际收尾上下文：reload/停用期间收卡专用独立通路（捕获旧 cfg/token/ID），
      // 与普通出站门分离；cleanup 结束后置空。
      larkClosing: null,
      // Agent 对象 → (attemptKey → { card, cursor, timer, surrogate, prefix })：
      // 卡片/游标/到期 timer/跨批代理对/已送达前缀全部按真实 Agent 对象 +
      // attempt（attemptId，或虚拟 turn:step）隔离，不共用 sessionId 槽。
      larkAttemptStates: new WeakMap(),
      // sessionId → 产出实时帧的 agent 对象（session 事件没有 agent，用它归位）。
      larkAgentBySession: new Map(),
      // 见过实时帧的 agent 强引用清单（WeakMap 不可枚举，卸载时要能逐个收卡）。
      larkAgents: new Set(),
    }

    async function getFallbackRoot() {
      if (configRoot) return configRoot
      return homedir()
    }

    function configPathFor(root) {
      return joinPath(root, '.dsh-messaging/config.json')
    }

    async function readJsonFile(path) {
      const target = await ctx.fs.resolve(path)
      try {
        return safeJsonParse(await ctx.fs.readText(target), null)
      } catch (error) {
        if (error && error.code === 'FS_NOT_FOUND') return null
        throw error
      }
    }

    // The config directory is the plugin's own fixed location under the runtime
    // home, outside the ACL root of whichever session opens the settings page.
    // An inherited workspace-write policy therefore refuses the save, so config
    // writes carry an explicit policy rooted at that directory instead.
    const configWritePolicy = { mode: 'danger-full-access', workspaceRoot: configRoot }

    async function writeJsonFile(path, value) {
      const target = await ctx.fs.resolve(path)
      await ctx.fs.writeText(target, JSON.stringify(value, null, 2), undefined, undefined, configWritePolicy)
    }

    // 飞书凭据按订阅方式分工：
    // - 长连接（默认）：只用 appId / appSecret，SDK 在建连时鉴权，事件为明文，
    //   verificationToken 与 encryptKey 都不参与。
    // - webhook：verificationToken / encryptKey 由用户在设置页填写，取值必须与飞书
    //   控制台「事件与回调」里的一致（Encrypt Key 由控制台生成，只能复制，插件无法
    //   代为生成后回填）。两者都填即最严：既比对令牌，也要求 payload 能被解密。
    async function loadConfig() {
      const initialRoot = await getFallbackRoot()
      const initialPath = configPathFor(initialRoot)
      const saved = await readJsonFile(initialPath)
      let root = isObject(saved) && saved.workspaceRoot ? saved.workspaceRoot : initialRoot
      root = String(root)
      const base = isObject(saved) ? saved : {}
      const merged = deepMerge(defaultConfig(root), base)
      root = merged.workspaceRoot || root
      merged.workspaceRoot = root
      merged.runtime = deepMerge(defaultConfig(root).runtime, merged.runtime || {})
      merged.agent = deepMerge(defaultConfig(root).agent, merged.agent || {})
      merged.adapters = deepMerge(defaultConfig(root).adapters, merged.adapters || {})
      state.configPath = configPathFor(root)
      if (saved === null) {
        await writeJsonFile(state.configPath, merged)
      }
      return merged
    }

    async function saveConfig(config) {
      state.configPath = configPathFor(config.workspaceRoot || state.workspaceRoot)
      await writeJsonFile(state.configPath, config)
    }

    function channelStatus(key) {
      return state.channels.find((channel) => channel.key === key)
    }

    function setChannelState(key, stateName, detail) {
      const channel = channelStatus(key)
      if (!channel) return
      channel.state = stateName
      if (stateName === 'running') channel.lastError = null
      if (detail !== undefined) {
        // lark 的 detail 每次都是整体替换：把连接痕迹并回去，
        // 否则 lastEventAt/connectedAt 会被下一次状态切换抹掉。
        channel.detail = key === 'lark' ? Object.assign({}, detail, state.larkTrace) : detail
      }
      if (key === 'lark') syncLarkImagesAvailable()
    }

    // 事件到达时同步痕迹（不动状态/错误字段）：/status 读的是 channel.detail。
    function syncLarkDetail() {
      const channel = channelStatus('lark')
      if (channel && channel.detail) channel.detail = Object.assign({}, channel.detail, state.larkTrace)
    }

    function resetChannelStatuses() {
      state.channels = CHANNEL_DEFS.map((def) => ({
        key: def.key,
        label: def.label,
        kind: def.kind,
        enabled: false,
        state: 'disabled',
        inboundCount: 0,
        outboundCount: 0,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastError: null,
        detail: {},
      }))
    }

    // ── 值集合（P1b）：当前配置的密钥 + 运行时缓存的令牌 ────────────────────
    function configSecretValues() {
      const values = []
      const adapters = isObject(state.config && state.config.adapters) ? state.config.adapters : {}
      for (const channel of Object.keys(SECRET_FIELDS)) {
        const adapter = isObject(adapters[channel]) ? adapters[channel] : {}
        for (const key of SECRET_FIELDS[channel]) {
          const value = adapter[key]
          if (typeof value === 'string' && value) values.push(value)
        }
      }
      return values
    }

    // 运行时令牌不在 config 里，但会出现在请求 URL / 错误文本中：飞书
    // tenant_access_token、企微 access_token、微信 context_token、ilink 登录态。
    function runtimeSecretValues() {
      const values = []
      const push = (value) => { if (typeof value === 'string' && value) values.push(value) }
      // 两个活动上下文的 lark token 都要进脱敏值集合（按 runtime 隔离，无全局缓存）。
      if (state.larkRuntime && state.larkRuntime.token) push(state.larkRuntime.token.value)
      if (state.larkClosing && state.larkClosing.token) push(state.larkClosing.token.value)
      if (state.wecomToken) push(state.wecomToken.value)
      // P2b：微信 token 已迁到凭据 record，只存在内存里，但一样会出现在
      // curl 的 Authorization 头 / 错误消息里，所以必须进值集合。
      push(state.wechatCredential)
      for (const key of Object.keys(state.wechatContextTokens)) push(state.wechatContextTokens[key])
      // ilink 的 pendingVerifyCode 不进值集合：它是客户端自己提交的配对码，
      // 只会回给同一个客户端，屏蔽它没有任何收益，反而可能把 UI 往返打坏。
      return values
    }

    // 值集合只增不减：rebuildAll 先记住旧值再换配置，因此配置轮换 / 令牌刷新后，
    // 已经记下来的旧事件里的旧密钥仍然能被脱敏。
    function rememberSecretValues() {
      const fresh = configSecretValues().concat(runtimeSecretValues())
      for (const value of fresh) {
        if (value.length >= SECRET_MIN_LENGTH) state.pastSecrets.add(value)
      }
      return state.pastSecrets
    }

    function redactSecrets(value) {
      return redactSecretNodes(value, rememberSecretValues())
    }

    // UI 路由的响应统一走这里：整体脱敏（成功响应里透传的上游 error 字符串
    // 也在内），但 qrcodeUrl / qrcode / pendingVerifyCode 直通。
    function redactUiResponse(value, key) {
      if (key && UI_PASSTHROUGH_KEYS.has(key)) return value
      if (typeof value === 'string') return redactSecretText(value, rememberSecretValues())
      if (Array.isArray(value)) return value.map((entry) => redactUiResponse(entry))
      if (isObject(value)) {
        const result = {}
        for (const name of Object.keys(value)) result[name] = redactUiResponse(value[name], name)
        return result
      }
      return value
    }

    // recent 只在出口脱敏：它是入站消息原文，仅存内存用于展示，出口（statusSnapshot）
    // 本来就会过滤；写入即脱敏会把原文不可逆地毁掉，排障时看不到用户到底发了什么。
    // errors 不同：它会挂到 channels[].lastError 并被多处引用，保持写入时就脱敏。
    function recordRecent(kind, entry) {
      state.recent.push(cleanJson({
        at: now(),
        kind,
        ...entry,
      }))
      if (state.recent.length > 120) state.recent.splice(0, state.recent.length - 120)
    }

    function recordError(channel, error, context, fatal = true) {
      const raw = error instanceof Error ? error.message : String(error || 'unknown error')
      // 写入即脱敏（纵深防御）：lastError 会挂在 channels[] 上，出口还会再过一遍。
      const message = redactSecretText(raw, rememberSecretValues())
      const status = channel ? channelStatus(channel) : null
      if (status) {
        status.lastError = message
        if (fatal && (status.state === 'starting' || status.state === 'running')) status.state = 'error'
      }
      state.errors.push(redactSecrets(cleanJson({
        at: now(),
        channel: channel || null,
        message,
        context: context ? String(context) : null,
      })))
      if (state.errors.length > 50) state.errors.splice(0, state.errors.length - 50)
      recordRecent('error', { channel: channel || null, message })
    }

    // status 的出口（GET /status、POST /reload）都走这里：任何字符串字段先过
    // 值匹配、再过模式匹配，密钥不会随快照发到浏览器——recent[]（入站消息原文，
    // 泄露点 8）与 errors[] 的脱敏都在这一步完成，不要绕开本函数去读 state.recent。
    // （P5：旧 POST /config 出口已随路由删除。）
    function statusSnapshot() {
      return redactSecrets(cleanJson({
        instanceEpoch: state.instanceEpoch,
        generation: state.generation,
        updatedAt: now(),
        configPath: state.configPath,
        channels: state.channels.map((channel) => {
          const copy = { ...channel }
          if (channel.key === 'lark') {
            // 匿名白名单诊断；构建失败只省略字段，绝不影响 status 出口。
            const diag = diagSafe(() => larkDiag().serialize({
              configuredMode: Boolean(state.config && state.config.adapters
                && state.config.adapters.lark && state.config.adapters.lark.interactiveCard) ? 'card' : 'text',
              running: channel.state === 'running',
              now: now(),
            }))
            if (diag) copy.diagnostics = diag
          }
          return copy
        }),
        sessions: Object.values(state.sessions).map((session) => ({
          key: session.key,
          channel: session.channel,
          conversation: session.conversation,
          sessionId: session.sessionId || null,
          agentId: session.agentId || null,
          messageCount: session.messageCount || 0,
          lastInboundAt: session.lastInboundAt || null,
          lastOutboundAt: session.lastOutboundAt || null,
          meta: session.meta || {},
        })),
        recent: state.recent.slice(-80),
        errors: state.errors.slice(-30),
      }))
    }

    // conversation 可能已经带有渠道前缀（适配器发送前会剥掉它，例如 lark:oc_xxx），
    // 此时不再重复拼接——否则会出现 "lark:lark:oc_xxx" 这类双前缀标识。
    // 不带前缀的渠道（onebot 的 private:1001、telegram 的数字 id）行为不变。
    function sessionKey(channel, conversation) {
      const text = String(conversation == null ? '' : conversation)
      const prefix = channel + ':'
      return text.startsWith(prefix) ? text : prefix + text
    }

    function ensureSessionRecord(channel, conversation, meta) {
      const key = sessionKey(channel, conversation)
      const existing = state.sessions[key]
      const record = existing || {
        key,
        channel,
        conversation,
        sessionId: null,
        agentId: null,
        messageCount: 0,
        lastInboundAt: null,
        lastOutboundAt: null,
        meta: {},
      }
      record.meta = deepMerge(record.meta || {}, meta || {})
      record.meta = cleanJson(record.meta)
      record.channel = channel
      record.conversation = conversation
      state.sessions[key] = record
      return record
    }

    // Presets are compositions, not header labels. Match the host session
    // controller: resolve, then mount only in the factory's unpublished setup.
    // No roster is a supported legacy composition; losing an observed roster
    // must not silently create a tool-free agent instead.
    let messagingPresetBinding = null
    let messagingPresetSeen = false
    let messagingPresetStopped = false
    let messagingProjectionBinding = null
    const presetFailure = () => {
      const error = new Error('agent preset unavailable')
      error.name = 'MessagingPresetUnavailableError'
      return error
    }
    function presetRun(channel) {
      const binding = messagingPresetBinding
      const projectionBinding = messagingProjectionBinding
      const generation = state.channelGeneration[channel]
      return { binding, current: () => !messagingPresetStopped
        && messagingPresetBinding === binding && messagingProjectionBinding === projectionBinding
        && state.channelGeneration[channel] === generation }
    }
    function sessionPreset(agent, required) {
      const projections = messagingProjectionBinding?.service
      if (projections && typeof projections.stateOf === 'function') {
        const value = projections.stateOf(agent.session, 'agentPreset')
        if (value === null || (typeof value === 'string' && value.length > 0)) return value ?? undefined
        if (required) throw presetFailure()
      }
      if (required) throw presetFailure()
      return agent.session?.header?.agentPreset || undefined
    }
    async function resolveMessagingPreset(run, requested) {
      if (!run.current()) throw presetFailure()
      const service = run.binding?.service
      if (!service) {
        if (messagingPresetSeen || requested) throw presetFailure()
        return undefined
      }
      const resolved = await service.resolve(requested)
      if (!run.current() || !resolved || typeof resolved.id !== 'string' || !resolved.id || resolved.broken) throw presetFailure()
      return resolved.id
    }
    async function messagingComposition(channel, fresh = false) {
      const run = presetRun(channel)
      try {
        const selected = fresh
          ? await resolveMessagingPreset(run, state.config.agent?.agentPreset || undefined)
          : undefined
        return {
          ...(selected ? { agentPreset: selected } : {}),
          setup: async (agentCtx, agent) => {
            try {
              const requested = fresh ? selected : sessionPreset(agent, Boolean(run.binding))
              const id = await resolveMessagingPreset(run, requested)
              if (id) {
                await run.binding.service.mount(agentCtx, id)
                if (!run.current() || run.binding.service.composedPreset(agentCtx) !== id) throw presetFailure()
              }
              if (!run.current()) throw presetFailure()
            } catch { throw presetFailure() }
          },
        }
      } catch { throw presetFailure() }
    }
    async function resumeMessagingAgent(sessionId, agentOptions, channel) {
      const composition = await messagingComposition(channel)
      const activation = presetRun(channel)
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup: composition.setup })
      if (!activation.current()) {
        await handle.dispose()
        throw presetFailure()
      }
      return handle
    }
    async function validateMessagingAgent(agent, channel) {
      // A live, possibly busy agent belongs to its current owner. Never mount or
      // recompose it after publication: only reuse an already matching binding.
      const run = presetRun(channel)
      try {
        const requested = sessionPreset(agent, Boolean(run.binding))
        const id = await resolveMessagingPreset(run, requested)
        if (id && run.binding.service.composedPreset(agent.ctx) !== id) throw presetFailure()
        if (!run.current() || (run.binding && ctx.agents.get(agent.session.id) !== agent)) throw presetFailure()
        return agent
      } catch { throw presetFailure() }
    }

    const pendingPresetActivations = new Map()
    async function withPresetActivation(key, run, activate) {
      const token = {}
      pendingPresetActivations.set(token, { key, run })
      try { return await activate() } finally { pendingPresetActivations.delete(token) }
    }
    function releasePresetActivations() {
      // Only pre-publication work still owned by this run is tracked here.
      // Mark that exact run so its late stale handler cannot release a successor.
      for (const [token, { key, run }] of pendingPresetActivations) {
        if (state.larkDedup?.lease === run.lease && !run.activationReleased) {
          run.activationReleased = true
          try { run.lease.release(key) } catch { /* closed owner cannot act */ }
        }
        pendingPresetActivations.delete(token)
      }
    }

    async function resolveAgentCwd() {
      const wanted = (state.config.agent && state.config.agent.cwd) || state.workspaceRoot
      try {
        const target = await ctx.fs.resolve(wanted, { cwd: state.workspaceRoot })
        if (target && typeof target.displayPath === 'string') return target.displayPath
      } catch {
        // Fall back to the configured workspace root.
      }
      return state.workspaceRoot
    }

    function defaultModelSelection() {
      try {
        const selection = ctx.agentDefaultModel.currentSelection()
        if (selection && typeof selection === 'object') return selection
      } catch (error) {
        recordError(null, error, 'default model selection')
      }
      return null
    }

    // ── 会话被其他界面占用（实机：飞书消息到达但 agent followup 失败）──────
    // DSH 桌面端把同一个会话打开时，宿主里已有活着的 agent 持有写句柄，
    // `agents.resume` 会以 SessionAlreadyOwnedError 拒绝（官方
    // dsh-api-session-controller 遇到同样错误时选择复用活着的 agent）。这里照做：
    //   · 查得到活 agent → 复用它（不接管 dispose，消息并入那个会话）；
    //   · 查不到 → 短暂退避重试（占用方可能刚释放）；
    //   · 仍然占用 → 抛出可操作的中英提示，且**不把渠道判成 error**
    //     （长连接本身是好的，坏的是会话占用，error 状态会误导排查）。
    function isSessionBusyError(error) {
      if (!error) return false
      const text = String(error.message || '')
      return error.name === 'SessionAlreadyOwnedError'
        || error.name === 'SessionBusyError'
        || text.includes('already owned by an active write handle')
        || text.includes('is in use by another surface')
    }

    async function attachBusySession(sessionId, agentOptions, record) {
      const liveAgent = () => (typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined)
      const reuse = async (agent) => {
        await validateMessagingAgent(agent, record.channel)
        if (!state.sessionSharedNotified.has(record.key)) {
          state.sessionSharedNotified.add(record.key)
          recordError(
            record.channel,
            'session ' + sessionId + ' is also open in another surface (e.g. the DSH app); this message was delivered there'
              + ' / 该会话同时在其他界面（如 DSH 桌面端）打开，本次消息已并入该会话',
            'agent followup',
            false,
          )
        }
        return { handle: null, agent, owned: false }
      }
      const first = liveAgent()
      if (first) return reuse(first)
      for (let attempt = 0; attempt < SESSION_BUSY_RETRIES; attempt += 1) {
        await pause(SESSION_BUSY_RETRY_MS)
        const live = liveAgent()
        if (live) return reuse(live)
        try {
          const handle = await resumeMessagingAgent(sessionId, agentOptions, record.channel)
          return { handle, agent: handle.agent, owned: true }
        } catch (error) {
          if (!isSessionBusyError(error)) throw error
        }
      }
      const busy = new Error(
        'session "' + sessionId + '" is in use by another surface or process; close the session in the DSH app'
          + ' (restart DSH if needed), then resend / 该会话正被其他界面或进程占用：请关闭 DSH 中打开的该会话'
          + '（必要时重启 DSH）后重发消息',
      )
      busy.name = 'SessionBusyError'
      throw busy
    }

    async function ensureAgent(record) {
      const activation = presetRun(record.channel)
      const existing = state.conversationAgents[record.key]
      if (existing && existing.agent) {
        if (existing.owned) return validateMessagingAgent(existing.agent, record.channel)
        // 复用的外部 agent：每次复核还活着（对方关闭会话后要重新解析，
        // 否则会一直对着一个死 agent 发消息）。
        const live = typeof ctx.agents.get === 'function'
          ? ctx.agents.get(record.sessionId || sessionIdForKey(record.key))
          : undefined
        if (live === existing.agent) return validateMessagingAgent(existing.agent, record.channel)
        delete state.conversationAgents[record.key]
        state.sessionSharedNotified.delete(record.key)
      }
      const sessionId = sessionIdForKey(record.key)
      // 旧形态存储 → 新 id 的惰性（权威）迁移：会话键来自适配器，不从盘上 id 反推
      // （slug 不可逆）。候选顺序 = 第二点（纯 slug 形态）在前、第一点（双前缀旧
      // 形态）在后；缺席即无操作，全部幂等。命中后 resume 新 id，历史无缝续接。
      for (const legacyId of legacySessionIdsForKey(record.key)) {
        try {
          const migration = migrateSessionStore(dshHomeRoot, legacyId, sessionId, { apply: true })
          if (migration.moved) {
            console.log('[dsh-messaging] migrated session store ' + legacyId + ' -> ' + sessionId)
          }
        } catch (error) {
          // 迁移失败不阻断入站：按原样 resume/create。会话级缓存命中期间不重试，
          // 进程重启/适配器重载后的下一次冷启动（缓存未命中）会再走一遍迁移。
          recordError(record.channel, error, 'session id migration', false)
        }
      }
      const agentOptions = {}
      const configuredProvider = state.config.agent && state.config.agent.provider
      const configuredModel = state.config.agent && state.config.agent.model
      const selection = (configuredProvider && configuredModel) ? null : defaultModelSelection()
      agentOptions.provider = configuredProvider || (selection && selection.provider) || ''
      agentOptions.model = configuredModel || (selection && selection.model) || ''
      const meta = {
        cwd: await resolveAgentCwd(),
      }
      const agentPreset = state.config.agent && state.config.agent.agentPreset
      if (agentPreset) meta.agentPreset = agentPreset
      // 会话 id 由会话键确定性推导，因此同一个飞书会话在进程重启后（以及每次保存设置
      // 触发的适配器重载后）会得到同一个 id。此时磁盘上已有该会话，`create` 会以
      // SessionAlreadyExistsError 拒绝，消息将被丢弃。故先 resume 续接既有历史，
      // 仅在确认没有已持久化会话时才新建。错误按 name 判断，避免依赖 DSH 内部类型。
      let resolved
      try {
        const handle = await resumeMessagingAgent(sessionId, agentOptions, record.channel)
        resolved = { handle, agent: handle.agent, owned: true }
      } catch (error) {
        if (error && error.name === 'SessionPersistenceNotFoundError') {
          const composition = await messagingComposition(record.channel, true)
          const handle = await ctx.agents.create({
            sessionId,
            meta: { ...meta, ...composition.agentPreset ? { agentPreset: composition.agentPreset } : {} },
            agentOptions,
            setup: composition.setup,
          })
          resolved = { handle, agent: handle.agent, owned: true }
        } else if (isSessionBusyError(error)) {
          resolved = await attachBusySession(sessionId, agentOptions, record)
        } else {
          throw error
        }
      }
      if (!activation.current()) {
        if (resolved.handle) await resolved.handle.dispose()
        throw presetFailure()
      }
      record.sessionId = sessionId
      record.agentId = resolved.agent.id
      record.meta = deepMerge(record.meta || {}, {
        provider: agentOptions.provider || null,
        model: agentOptions.model || null,
      })
      record.meta = cleanJson(record.meta)
      state.sessionToConversation[sessionId] = record
      state.conversationAgents[record.key] = {
        // 复用来的外部 agent 为 null：**绝不 dispose 别人的 agent**，
        // disposeChannelSessions / rebuildAll 的 `if (entry.handle)` 天然跳过它。
        handle: resolved.handle,
        agent: resolved.agent,
        record,
        owned: resolved.owned,
      }
      bindLarkImageAgent(resolved.agent, record)
      return resolved.agent
    }

    function makeUserMessage(text, id) {
      state.messageSeq += 1
      return {
        // P1：飞书入站传入 dedup userMessageId（admission 投影只认该格式）；
        // 非入站/无 id 路径保持原生成逻辑。
        id: typeof id === 'string' && id ? id : 'dsh-msg-' + now() + '-' + state.messageSeq,
        role: 'user',
        content: [{ type: 'text', text: String(text || '') }],
        source: { kind: 'user' },
      }
    }

    async function inbound(channel, conversation, text, meta) {
      if (!String(text || '').trim()) return
      // dedup 句柄绝不进 session.meta / status（含 lease 对象）——仅本函数作用域。
      const dedup = meta && meta.dedup ? meta.dedup : null
      const run = dedup ? larkRun(dedup.lease) : null
      if (dedup && !larkRunCurrent(run)) return staleRecoveryRow({ key: dedup.key }, run)
      const safeMeta = dedup
        ? { messageId: meta.messageId, chatId: meta.chatId, senderId: meta.senderId }
        : meta
      const status = channelStatus(channel)
      if (status) {
        status.enabled = true
        status.inboundCount += 1
        status.lastInboundAt = now()
      }
      const record = ensureSessionRecord(channel, conversation, safeMeta)
      record.lastInboundAt = now()
      record.messageCount += 1
      recordRecent('inbound', {
        channel,
        conversation,
        text: textPreview(text),
        meta: record.meta || {},
      })
      try {
        // 3：route 证据只用本进程已知的 hadSid（入口 claim 已定 sid/sx 不再二次推导）。
        const hadSidBeforeAgent = Boolean(record.sessionId)
        const agent = await (dedup ? withPresetActivation(dedup.key, run, () => ensureAgent(record)) : ensureAgent(record))
        if (dedup && !larkRunCurrent(run)) return staleRecoveryRow({ key: dedup.key }, run)
        if (!dedup) {
          agent.followup(makeUserMessage(text))
          return
        }
        // P1/B-3：bindRoute 复用账本已定 route 证据（sid/sx 原样）；仅 sx=null 时
        // 用本进程已知证据补（绝不写 false、绝不“升级”已定值——已验 module 会冲突拒绝）。
        try {
          const stored = dedup.lease.get(dedup.key)
          const boundSid = stored && stored.sessionId ? stored.sessionId : record.sessionId
          const boundSx = stored && stored.sessionExisted !== null && stored.sessionExisted !== undefined
            ? stored.sessionExisted
            : (hadSidBeforeAgent ? true : null)
          await dedup.lease.bindRoute(dedup.key, { sessionId: boundSid, sessionExisted: boundSx })
        } catch (error) {
          if (!larkRunCurrent(run)) return staleRecoveryRow({ key: dedup.key }, run)
          recordError(channel, error, 'dedup bindRoute', false)
          await dedupRecordFailure(dedup, 'host_reconcile_needed')
          return
        }
        // B-1：followup **之前**的真判据——admitted 只 flush；not_admitted 才
        // followup；uncertain 一律禁止入队（投影缺失/坏缓存/evicted → 0 次调用）。
        if (!larkRunCurrent(run)) return staleRecoveryRow({ key: dedup.key }, run)
        const row = dedup.lease.get(dedup.key)
        const v1 = admissionVerdictOf(agent, dedup.userMessageId)
        if (v1.verdict === 'uncertain') {
          // C-1：uncertain 必须固定无正文告知；通知未确认送达 → 记录保留 claimed，
          // 由恢复队列退避接手（不再 admission_failed 静默终态）。
          await settleOrPendingNotice({ key: dedup.key, chatId: meta.chatId, appId: null, messageId: null, sessionId: record.sessionId }, dedup.lease, 'uncertain', run)
          return
        }
        if (v1.verdict === 'admitted') {
          await flushAndSettle(agent, row, dedup.lease, v1, run)
          return
        }
        // not_admitted（真投影证明不在 inbox）：唯一允许入队的分支。
        let followupError = null
        try {
          agent.followup(makeUserMessage(text, dedup.userMessageId))
        } catch (error) {
          followupError = error
        }
        // 后置判据只用于“确认准入”/throw 后重查（不是前置替代）：
        let v2 = admissionVerdictOf(agent, dedup.userMessageId)
        if (v2.verdict === 'uncertain') {
          await new Promise((resolve) => setImmediate(resolve)) // 仅确认新入队投影落地
          v2 = admissionVerdictOf(agent, dedup.userMessageId)
        }
        if (!larkRunCurrent(run)) return staleRecoveryRow({ key: dedup.key }, run)
        if (followupError) recordError(channel, followupError, 'agent followup', !isSessionBusyError(followupError))
        if (v2.verdict === 'admitted') {
          await flushAndSettle(agent, row, dedup.lease, v2, run)
          return
        }
        // 未证 admitted：固定无正文告知（C-1；送达才终态，否则保留 claimed 可见）。
        await settleOrPendingNotice({ key: dedup.key, chatId: meta.chatId, appId: null, messageId: null, sessionId: record.sessionId }, dedup.lease, 'uncertain', run)
      } catch (error) {
        if (dedup && !larkRunCurrent(run)) return staleRecoveryRow({ key: dedup.key }, run)
        // 会话占用是「会话层」的冲突，不是适配器故障：不把渠道打进 error 状态，
        // 否则状态页会把排查引向连接（实机上就是这样被带偏的）。
        recordError(channel, error, 'agent followup', !isSessionBusyError(error) && error?.name !== 'MessagingPresetUnavailableError')
        if (dedup && larkRunCurrent(run)) {
          await dedupRecordFailure(dedup, isSessionBusyError(error) ? 'agent_busy' : 'enqueue_failed')
          if (error?.name === 'MessagingPresetUnavailableError' && larkRunCurrent(run)) {
            // Retain this fresh text only in the existing bounded retry queue;
            // durable records still contain no body, and cold recovery never creates.
            larkContentPayloads.set(dedup.key, { chatId: meta.chatId, messageId: meta.messageId, parts: [{ kind: 'text', text }] })
            scheduleRecoveryRow(dedup.lease.get(dedup.key), { delayMs: RECOVERY_BASE_BACKOFF_MS })
          }
        }
      }
    }
    async function dedupRecordFailure(dedup, code) {
      try {
        await dedup.lease.recordFailure(dedup.key, code)
      } catch (error) {
        recordError('lark', error, 'dedup recordFailure', false)
        // A failed write retains this task's processing right. Success already
        // releases it inside recordFailure, so never release twice after await.
        try { dedup.lease.release(dedup.key) } catch {}
        try { scheduleRecoveryRow(dedup.lease.get(dedup.key), { delayMs: RECOVERY_BASE_BACKOFF_MS }) } catch {}
      }
    }
    function admissionVerdictOf(agent, userMessageId) {
      try {
        const inboxIds = larkAdmissionInboxIds(agent)
        // 真宿主有 agent.session；测试 fake 可能只有 agent.id → 兜底同键，保持
        // 与 followup→splice 同一投影键（真宿主路径不变）。
        const projSession = agent.session && agent.session.id ? agent.session : { id: typeof agent.id === 'string' ? agent.id : null }
        const projections = (ctx.get && ctx.get('sessionProjections')) || ctx.sessionProjections
        const projectionState = projections && typeof projections.stateOf === 'function'
          ? projections.stateOf(projSession, LARK_ADMISSION_KEY)
          : null
        const out = larkAdmissionVerdict({ userMessageId, inboxIds, projectionState })
        if (out && LARK_ADMISSION_VERDICTS.includes(out.verdict)) return out
        return { verdict: 'uncertain', reason: 'verdict_unavailable', userMessageId }
      } catch {
        // 判据不可用一律 fail-closed（绝不假 admitted）；服务缺失≠准入。
        return { verdict: 'uncertain', reason: 'verdict_threw', userMessageId }
      }
    }

    // ── C：崩溃残留本地完结（主动 recover；不靠平台重投）─────────────────
    // 调用方须已 claim 取权；只 resume 绝不 create；admitted→settle；正文经
    // message GET（只读，无正文入账本=匿名设计）；固定失败码，不透原文。
    function recoveryAgentOptions() {
      const agentOptions = {}
      const configuredProvider = state.config.agent && state.config.agent.provider
      const configuredModel = state.config.agent && state.config.agent.model
      const selection = (configuredProvider && configuredModel) ? null : defaultModelSelection()
      agentOptions.provider = configuredProvider || (selection && selection.provider) || ''
      agentOptions.model = configuredModel || (selection && selection.model) || ''
      return agentOptions
    }
    async function larkFetchRecoveredMessage(runtime, messageId) {
      if (!runtime) return { ok: false, kind: 'unavailable' }
      try {
        const accessToken = await larkScopeToken(runtime)
        const url = LARK_MESSAGE_GET_URL_PREFIX + encodeURIComponent(String(messageId))
        const result = await larkWire(runtime)('GET', url, { Authorization: 'Bearer ' + accessToken }, {})
        if (!result) return { ok: false, kind: 'unavailable' }
        if (result.status === 404) return { ok: false, kind: 'missing' }
        const apiCode = result.json && Number.isInteger(result.json.code) ? result.json.code : null
        if (result.status === 403 || apiCode === 99991672 || apiCode === 230031) return { ok: false, kind: 'scope_missing' }
        if (!result.ok || !result.json || result.json.code !== 0 || !result.json.data) return { ok: false, kind: 'unavailable' }
        const items = Array.isArray(result.json.data.items) ? result.json.data.items : null
        const item = items && items.length ? items[0] : null
        if (!item) return { ok: false, kind: 'missing' }
        // C-3：edited 用官方 GET 响应的 updated 证据（不拿 update_time 推测）。
        if (item.updated === true) return { ok: false, kind: 'edited' }
        const msgType = String(item.msg_type || item.message_type || '')
        const raw = isObject(item.body) && item.body.content !== undefined ? item.body.content : item.content
        const content = isObject(raw) ? raw : safeJsonParse(raw, {})
        // E：恢复分支的 image/post 用统一内容管线（不再 content_image_pending 透延）。
        if (msgType === 'image') {
          const key = content && typeof content.image_key === 'string' ? content.image_key : null
          return key ? { ok: true, parts: [{ kind: 'image', fileKey: key }] } : { ok: false, kind: 'missing' }
        }
        if (msgType === 'post') {
          const rows = content && Array.isArray(content.content) ? content.content : []
          const parts = []
          if (content && typeof content.title === 'string' && content.title) parts.push({ kind: 'text', text: String(content.title) })
          for (const r of rows) {
            if (!Array.isArray(r)) continue
            for (const el of r) {
              if (!isObject(el)) continue
              if ((el.tag === 'text' || el.tag === 'a') && typeof el.text === 'string' && el.text) parts.push({ kind: 'text', text: String(el.text) })
              else if (el.tag === 'img' && typeof el.image_key === 'string' && el.image_key) parts.push({ kind: 'image', fileKey: String(el.image_key) })
            }
          }
          return parts.some((p) => p.kind === 'image') ? { ok: true, parts } : { ok: false, kind: 'unsupported_type' }
        }
        const text = larkMessageText({ message_type: msgType }, content)
        if (text === null || !String(text).trim()) return { ok: false, kind: 'unsupported_type' }
        return { ok: true, text: String(text) }
      } catch {
        return { ok: false, kind: 'unavailable' }
      }
    }
    let sessionsService = null
    function larkRun(lease) {
      return { generation: state.channelGeneration.lark, runtime: state.larkRuntime, lease }
    }
    function larkRunCurrent(run) {
      return !state.larkDedupClosedForever && state.channelGeneration.lark === run.generation
        && state.larkRuntime === run.runtime && state.larkDedup && state.larkDedup.lease === run.lease
    }
    function staleRecoveryRow(row, run) {
      // A closed old lease cannot release a new lease's claim. With the same live
      // lease this task still owns the key until release; hand it back once.
      if (state.larkDedup && state.larkDedup.lease === run.lease && !run.activationReleased) {
        try { run.lease.release(row.key) } catch {}
        const att = recoveryAttempts.get(row.key)
        if (att) att.owned = false
        try { scheduleRecoveryRow(run.lease.get(row.key), { delayMs: RECOVERY_BASE_BACKOFF_MS }) } catch {}
      }
      return 'stale'
    }
    async function flushAndSettle(agent, row, lease, admission, run) {
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      let flushed = false
      try {
        const sessions = sessionsService || ctx.sessions
        if (sessions && typeof sessions.flush === 'function') flushed = await sessions.flush(agent.session)
      } catch (error) {
        if (larkRunCurrent(run)) recordError('lark', error, 'dedup flush', false)
      }
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      if (flushed !== true) return retrySoonRow(row, lease)
      try {
        await lease.settleDelivered(row.key, { admission, flushed })
        return larkRunCurrent(run) ? 'done' : staleRecoveryRow(row, run)
      } catch (error) {
        if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
        recordError('lark', error, 'dedup settle', false)
        return retrySoonRow(row, lease)
      }
    }
    // C-1：恢复告知（独立 notice 域；wire=当前 runtime 真实网络，ACK 后异步）。
    async function larkRecoveryNotice(row, kind, run) {
      if (!larkRunCurrent(run)) return { outcome: 'stale' }
      try {
        const lease = run.lease
        if (!larkRunCurrent(run)) return { outcome: 'stale' }
        const larkCfg = state.config && state.config.adapters && state.config.adapters.lark
        return await sendLarkNotice({
          receipts: lease.sendReceipts,
          isCurrent: () => larkRunCurrent(run),
          wire: run.runtime ? larkWire(run.runtime) : null,
          key: row.key,
          kind,
          appId: larkCfg ? String(larkCfg.appId || '') : '',
          conversation: row.chatId ? 'lark:' + row.chatId : null,
          chatId: row.chatId || null,
          interactiveCard: Boolean(larkCfg && larkCfg.interactiveCard === true),
        })
      } catch (error) {
        if (!larkRunCurrent(run)) return { outcome: 'stale' }
        recordError('lark', error, 'dedup notice', false)
        return { outcome: 'storage_unavailable' }
      }
    }
    // 通知→终态或可见 pending：只有 delivered 才 settleRejected({noticeDelivered})；
    // unknown/failed/目标不可确认 → 保留 claimed + 退避重入队（最大尝试后暂停可见）。
    async function settleOrPendingNotice(row, lease, kind, run) {
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      const res = await larkRecoveryNotice(row, kind, run)
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      if (res.outcome === 'delivered') {
        try {
          await lease.settleRejected(row.key, { noticeDelivered: true })
          return larkRunCurrent(run) ? 'done' : staleRecoveryRow(row, run)
        } catch (error) {
          if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
          recordError('lark', error, 'dedup notice settle', false)
        }
        try { lease.release(row.key) } catch { /* 已释放 */ }
        scheduleRecoveryRow(row, { delayMs: RECOVERY_BASE_BACKOFF_MS })
        return 'retry'
      }
      if (res.outcome === 'pending_target' || res.outcome === 'invalid_kind') {
        // 无法确认原 chat 目标 / 固定文案缺失 → 仅本地阻断，绝不乱发。
        recordRecent('lark-recovery', { channel: 'lark', outcome: 'notice_local_blocked', kind: String(kind) })
      }
      try { lease.release(row.key) } catch { /* 已释放 */ }
      scheduleRecoveryRow(row, { delayMs: RECOVERY_BASE_BACKOFF_MS })
      return 'retry'
    }
    function retrySoonRow(row, lease) {
      try { lease.release(row.key) } catch { /* 已释放 */ }
      scheduleRecoveryRow(row, { delayMs: RECOVERY_BASE_BACKOFF_MS })
      return 'retry'
    }
    // E：视觉能力（read_image 同路由：当前 selection → resolveModelInfo.inputModalities）。
    async function larkAgentModalities(agent) {
      try {
        const selection = (agent && agent.selection)
          || (ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === 'function'
            ? ctx.agentDefaultModel.currentSelection()
            : null)
        if (larkImageServices.llm && selection && selection.provider && selection.model) {
          const info = await larkImageLlm.resolveModelInfo(selection.provider, selection.model)
          const modalities = info && info.inputModalities
          if (Array.isArray(modalities) && modalities.length > 0
            && Array.from(modalities).every((value) => value === 'text' || value === 'image')) return modalities
        }
      } catch { /* unknown is transient, never evidence of text-only capability */ }
      return null
    }
    // E：下载单图（幂等 GET）；永久→permanent；瞬时/无响应→temp_retry（不静默丢图）。
    async function larkDownloadImagePart(messageId, part, generation) {
      if (!larkImageHost) {
        try { larkImageTool() } catch { /* 附件服务缺失等 → host 仍 null */ }
      }
      const host = larkImageHostOrNull()
      if (!host || state.channelGeneration.lark !== generation) return { outcome: 'temp_retry' }
      const res = await host.downloadMessageImage({ messageId, fileKey: part.fileKey })
      if (res && res.ok === true && res.bytes) return { outcome: 'ok', bytes: res.bytes, mediaType: res.mediaType }
      if (res && res.category === 'permanent') return { outcome: 'permanent' }
      return { outcome: 'temp_retry' }
    }
    // E：图文内容管线（fresh 与 recovery 共用）：整条最多一次准入；临时失败整条
    // 重试（不部分准入）；能力暂时未知走有界重试，明确非视觉才走固定告知。
    async function larkCompleteWithParts(agent, row, lease, parts, generation, run) {
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      const hasImage = parts.some((part) => part.kind !== 'text')
      if (hasImage) {
        const modalities = await larkAgentModalities(agent)
        if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
        if (modalities === null) return retrySoonRow(row, lease)
        if (!modalities.includes('image')) {
          return settleOrPendingNotice(row, lease, 'image_not_supported', run) // 不记图片成功、不自动切模型
        }
      }
      let attachments
      try { attachments = ctx.get('attachments') } catch { attachments = undefined }
      if (hasImage && (!attachments || typeof attachments.admitPromptContent !== 'function')) {
        return settleOrPendingNotice(row, lease, 'attachments_unavailable', run)
      }
      const admitParts = []
      for (const part of parts) {
        if (part.kind === 'text') { admitParts.push({ type: 'text', text: part.text }); continue }
        const dl = await larkDownloadImagePart(row.messageId, part, generation)
        if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
        if (dl.outcome === 'temp_retry') return retrySoonRow(row, lease) // claimed 有界重试
        if (dl.outcome !== 'ok') return settleOrPendingNotice(row, lease, 'image_unavailable', run) // 含多图部分失败：整条不提交
        admitParts.push({ type: 'image', data: Buffer.from(dl.bytes).toString('base64'), mediaType: dl.mediaType })
      }
      let blocks
      try {
        blocks = hasImage ? await attachments.admitPromptContent(admitParts) : admitParts // 宿主真实 typed blocks
      } catch {
        return settleOrPendingNotice(row, lease, 'image_unavailable', run)
      }
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run) // 不跨代入队
      let followupError = null
      try {
        // 账本原 userMessageId + 真实 admission verdict/flush 门。
        agent.followup({ id: row.userMessageId, role: 'user', content: blocks, source: { kind: 'user' } })
      } catch (error) {
        followupError = error // 已入队后 throw → 仍重查
      }
      let v2 = admissionVerdictOf(agent, row.userMessageId)
      if (v2.verdict === 'uncertain') {
        await new Promise((resolve) => setImmediate(resolve))
        v2 = admissionVerdictOf(agent, row.userMessageId)
      }
      if (v2.verdict === 'admitted') {
        return flushAndSettle(agent, row, lease, v2, run)
      }
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      if (followupError) recordError('lark', followupError, 'agent followup', !isSessionBusyError(followupError))
      return settleOrPendingNotice(row, lease, 'uncertain', run)
    }
    // E：fresh image/post（ACK 后；新会话可 create）。
    async function processFreshContent(row, payload, generation, lease) {
      const run = larkRun(lease)
      if (run.generation !== generation || !larkRunCurrent(run)) return staleRecoveryRow(row, run)
      const record = ensureSessionRecord('lark', 'lark:' + payload.chatId, { messageId: payload.messageId, chatId: payload.chatId })
      let agent
      try {
        agent = await withPresetActivation(row.key, run, () => ensureAgent(record))
      } catch (error) {
        if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
        recordError('lark', error, 'agent ensure', !isSessionBusyError(error) && error?.name !== 'MessagingPresetUnavailableError')
        return retrySoonRow(row, lease)
      }
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      try {
        const stored = lease.get(row.key)
        const boundSid = stored && stored.sessionId ? stored.sessionId : record.sessionId
        const boundSx = stored && stored.sessionExisted !== null && stored.sessionExisted !== undefined
          ? stored.sessionExisted
          : (record.sessionId ? true : null)
        await lease.bindRoute(row.key, { sessionId: boundSid, sessionExisted: boundSx })
      } catch (error) {
        if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
        recordError('lark', error, 'dedup bindRoute', false)
        return retrySoonRow(row, lease)
      }
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      const v1 = admissionVerdictOf(agent, row.userMessageId)
      if (v1.verdict === 'admitted') {
        return flushAndSettle(agent, row, lease, v1, run)
      }
      if (v1.verdict === 'uncertain') return settleOrPendingNotice(row, lease, 'uncertain', run)
      return larkCompleteWithParts(agent, row, lease, payload.parts, generation, run)
    }
    async function completeRecoveredRecord(row, lease) {
      const run = larkRun(lease)
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      const key = row.key
      const release = () => { try { lease.release(key) } catch { /* 已释放 */ } }
      const retrySoon = () => {
        release()
        scheduleRecoveryRow(row, { delayMs: RECOVERY_BASE_BACKOFF_MS })
        return 'retry'
      }
      if (!row.sessionId || !row.chatId) {
        // C-1：缺 route 证据 → 固定无正文告知（chat 已知）/ 本地阻断（未知）；
        // 不再 release+trace 无限静默；绝不 create。
        return settleOrPendingNotice(row, lease, 'sid_or_chat_missing', run)
      }
      const record = ensureSessionRecord('lark', 'lark:' + row.chatId, {})
      let agent
      try {
        const handle = await withPresetActivation(row.key, run, () => resumeMessagingAgent(row.sessionId, recoveryAgentOptions(), 'lark'))
        if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
        agent = handle.agent
      } catch (error) {
        if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
        if (error && error.name === 'SessionPersistenceNotFoundError') {
          // C-1：会话已删 → 固定告知重发；绝不复活、不 create。
          return settleOrPendingNotice(row, lease, 'session_missing', run)
        }
        if (isSessionBusyError(error)) {
          try {
            const resolved = await withPresetActivation(row.key, run, () => attachBusySession(row.sessionId, recoveryAgentOptions(), record))
            if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
            agent = resolved.agent
          } catch {
            if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
            recordError('lark', 'busy session attachment failed', 'dedup recovery attach', false)
            return retrySoon()
          }
        } else {
          recordError('lark', error, 'dedup recovery resume', false)
          release()
          return 'retry' // 临时失败 → 退避重试（保留 claimed 可见）
        }
      }
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      record.sessionId = row.sessionId
      bindLarkImageAgent(agent, record)
      const v1 = admissionVerdictOf(agent, row.userMessageId)
      if (v1.verdict === 'admitted') {
        const settled = await flushAndSettle(agent, row, lease, v1, run)
        if (settled !== 'done') return settled
        // C-4：冷 resume 后 inbox 仍有该 ID（未消费 pending，宿主无公共 wake）→
        // 固定可见告知（独立 notice 域）；历史投影命中但 inbox 无该 ID（已消费/
        // 压缩）→ 不报；账本仍 delivered（不改 rejected）。
        try {
          const inboxIds = larkAdmissionInboxIds(agent)
          if (Array.isArray(inboxIds) && inboxIds.includes(row.userMessageId)) {
            const note = await larkRecoveryNotice(row, 'waiting_for_input', run)
            if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
            if (note.outcome !== 'delivered') {
              recordRecent('lark-recovery', { channel: 'lark', outcome: 'waiting_notice_' + String(note.outcome) })
            }
          }
        } catch { /* 告知失败不改变已 delivered 的账本事实 */ }
        return 'done'
      }
      if (v1.verdict === 'uncertain') {
        // C-1：uncertain 必须固定无正文告知（非静默 release）。
        return settleOrPendingNotice(row, lease, 'uncertain', run)
      }
      // not_admitted → 需正文：message GET（无正文不入账本）。
      const got = await larkFetchRecoveredMessage(run.runtime, row.messageId)
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      if (got.ok && Array.isArray(got.parts)) {
        // E：恢复 image/post → 与 fresh 共用统一内容管线。
        return larkCompleteWithParts(agent, row, lease, got.parts, run.generation, run)
      }
      if (!got.ok) {
        // C-1/C-3：固定告知分类；临时不可用 → 退避重试（非 permanent 拒）。
        if (got.kind === 'edited') return settleOrPendingNotice(row, lease, 'edited', run)
        if (got.kind === 'scope_missing') return settleOrPendingNotice(row, lease, 'refetch_scope_missing', run)
        if (got.kind === 'missing') return settleOrPendingNotice(row, lease, 'refetch_unavailable', run)
        if (got.kind === 'unsupported_type') return settleOrPendingNotice(row, lease, 'refetch_unavailable', run)
        return retrySoon() // unavailable：网络/无 runtime → 退避重试（保留 claimed 可见）
      }
      let followupError = null
      try {
        agent.followup(makeUserMessage(got.text, row.userMessageId))
      } catch (error) {
        followupError = error
      }
      let v2 = admissionVerdictOf(agent, row.userMessageId)
      if (v2.verdict === 'uncertain') {
        await new Promise((resolve) => setImmediate(resolve)) // 仅确认新入队投影落地
        v2 = admissionVerdictOf(agent, row.userMessageId)
      }
      if (v2.verdict === 'admitted') {
        return flushAndSettle(agent, row, lease, v2, run)
      }
      if (!larkRunCurrent(run)) return staleRecoveryRow(row, run)
      if (followupError) recordError('lark', followupError, 'agent followup', !isSessionBusyError(followupError))
      // C-1：入队后仍无法证 admitted → 固定无正文告知（非静默终态）。
      return settleOrPendingNotice(row, lease, 'uncertain', run)
    }
    // ── C-2：可靠恢复队列（公平 FIFO+每项退避+最大尝试暂停可见）──────
    const larkRecoveryQueue = new Map() // key → publicRecord（FIFO 序）
    const larkContentPayloads = new Map() // key → { parts, messageId, chatId }（仅内存；E fresh 管线）
    const recoveryAttempts = new Map() // key → { n, nextAt, pausedLogged, owned }
    const RECOVERY_MAX_ATTEMPTS = 5
    const RECOVERY_BASE_BACKOFF_MS = 5000
    const RECOVERY_MAX_BACKOFF_MS = 60000
    let larkRecoveryTimer = null
    let larkRecoveryRunning = false
    function recoveryBackoffMs(n) {
      return Math.min(RECOVERY_BASE_BACKOFF_MS * (2 ** Math.max(0, n - 1)), RECOVERY_MAX_BACKOFF_MS)
    }
    function scheduleRecoveryRow(row, opts = {}) {
      if (!row || !row.key || state.larkDedupClosedForever) return
      const att = recoveryAttempts.get(row.key) || { n: 0, nextAt: 0, pausedLogged: false, owned: false }
      if (att.n >= RECOVERY_MAX_ATTEMPTS && !opts.owned) {
        // 最大尝试后明确暂停：不重入队；记录保留 claimed 可见（重启重置）。
        if (!att.pausedLogged) {
          att.pausedLogged = true
          recoveryAttempts.set(row.key, att)
          recordRecent('lark-recovery', { channel: 'lark', outcome: 'paused', attempts: RECOVERY_MAX_ATTEMPTS })
        }
        return
      }
      if (opts.owned) att.owned = true
      if (!larkRecoveryQueue.has(row.key)) larkRecoveryQueue.set(row.key, row)
      const delay = opts.delayMs || 0
      att.nextAt = Math.max(att.nextAt, now() + delay)
      recoveryAttempts.set(row.key, att)
      armRecoveryTimer(delay)
    }
    function armRecoveryTimer(delayMs) {
      if (state.larkDedupClosedForever || larkRecoveryTimer) return // 单飞 timer（dispose 清）
      const wait = Math.max(0, Math.min(Number.isFinite(delayMs) ? delayMs : 250, 30000))
      larkRecoveryTimer = setTimeout(() => {
        larkRecoveryTimer = null
        drainRecoveryQueue().catch(() => {})
      }, wait)
    }
    // 启动种子：recovered 全量入队（不限 32；公平序=ledgerSeq），每扇 32，续扇不饿死后续。
    async function seedRecoveryQueue() {
      const gen = state.channelGeneration.lark
      let lease
      try { lease = await ensureLarkDedupStore() } catch { return }
      if (state.channelGeneration.lark !== gen || state.larkDedupClosedForever) return
      let rows = []
      try { rows = lease.recover() } catch { return }
      for (const row of rows) scheduleRecoveryRow(row)
      if (rows.length) armRecoveryTimer(0)
    }
    async function drainRecoveryQueue() {
      if (larkRecoveryRunning || state.larkDedupClosedForever) return
      larkRecoveryRunning = true
      let storeBroken = false
      try {
        const gen = state.channelGeneration.lark
        let lease
        try { lease = await ensureLarkDedupStore() } catch { return }
        let budget = 32
        while (budget > 0 && !state.larkDedupClosedForever && state.channelGeneration.lark === gen) {
          const t = now()
          let chosenKey = null
          let chosenRow = null
          let soonestAt = Infinity
          for (const [k, row] of larkRecoveryQueue) {
            const att = recoveryAttempts.get(k) || { n: 0, nextAt: 0 }
            if (att.nextAt <= t) { chosenKey = k; chosenRow = row; break } // FIFO 到期项
            if (att.nextAt < soonestAt) soonestAt = att.nextAt
          }
          if (!chosenRow) {
            if (Number.isFinite(soonestAt)) armRecoveryTimer(soonestAt - t)
            return
          }
          const att = recoveryAttempts.get(chosenKey) || { n: 0, nextAt: 0, pausedLogged: false, owned: false }
          const ownedBySchedule = att.owned === true
          if (!ownedBySchedule && lease.isProcessing(chosenKey)) {
            larkRecoveryQueue.delete(chosenKey) // 活跃在途：由本进程正常路径处理
            continue
          }
          let fresh = null
          try { fresh = lease.get(chosenKey) } catch { fresh = null }
          if (!fresh || fresh.state !== 'claimed') {
            larkRecoveryQueue.delete(chosenKey)
            recoveryAttempts.delete(chosenKey)
            continue
          }
          const cfgNow = state.config && state.config.adapters && state.config.adapters.lark
          const currentApp = cfgNow ? String(cfgNow.appId || '') : ''
          if (!currentApp || fresh.appId !== currentApp) {
            // app 更换 → orphaned（不拿新 token 发任何东西）。
            try { await lease.markOrphaned(chosenKey) } catch { /* 已终态/无主 */ }
            larkRecoveryQueue.delete(chosenKey)
            recoveryAttempts.delete(chosenKey)
            continue
          }
          budget -= 1
          let target = fresh
          if (!ownedBySchedule) {
            if (att.n >= RECOVERY_MAX_ATTEMPTS) {
              if (!att.pausedLogged) {
                att.pausedLogged = true
                recoveryAttempts.set(chosenKey, att)
                recordRecent('lark-recovery', { channel: 'lark', outcome: 'paused', attempts: RECOVERY_MAX_ATTEMPTS })
              }
              larkRecoveryQueue.delete(chosenKey)
              larkContentPayloads.delete(chosenKey)
              continue
            }
            let claimRes
            try {
              claimRes = await lease.claim({
                appId: fresh.appId,
                messageId: fresh.messageId,
                chatId: fresh.chatId || undefined,
                chatType: fresh.chatType || undefined,
                sessionId: fresh.sessionId || undefined,
                sessionExisted: fresh.sessionExisted === null || fresh.sessionExisted === undefined ? null : fresh.sessionExisted,
              })
            } catch (error) {
              recordError('lark', error, 'dedup recovery claim', false)
              storeBroken = true
              break // store 不可用（poison/锁）→ 本扇终止；status 可见
            }
            if (claimRes.outcome !== 'recoverable') {
              larkRecoveryQueue.delete(chosenKey) // 在途/终态：由持有者/账本收敛
              larkContentPayloads.delete(chosenKey)
              continue
            }
            target = claimRes.record
          }
          let done
          const payload = larkContentPayloads.get(chosenKey)
          if (payload) {
            // payload 存在=event 内容还在（含临时失败重试轮）→ fresh 管线；
            // 仅 done/终态清除，否则重启/丢失后自然回落 GET 恢复管线。
            done = await processFreshContent(target, payload, gen, lease)
          } else {
            done = await completeRecoveredRecord(target, lease)
          }
          if (done === 'stale' || state.channelGeneration.lark !== gen || state.larkDedup.lease !== lease) {
            if (larkRecoveryQueue.size) armRecoveryTimer(250)
            return
          }
          if (done === 'done') {
            larkRecoveryQueue.delete(chosenKey)
            recoveryAttempts.delete(chosenKey)
            larkContentPayloads.delete(chosenKey)
            continue
          }
          // retry 类结果：每项退避（n+1）；到顶**立即**暂停可见（不等下一轮）。
          att.n += 1
          if (att.n >= RECOVERY_MAX_ATTEMPTS && !att.pausedLogged) {
            att.pausedLogged = true
            recoveryAttempts.set(chosenKey, att)
            recordRecent('lark-recovery', { channel: 'lark', outcome: 'paused', attempts: RECOVERY_MAX_ATTEMPTS })
            larkRecoveryQueue.delete(chosenKey)
            larkContentPayloads.delete(chosenKey)
            continue
          }
          att.owned = false // 取权已释放/终止，下轮重新取
          att.nextAt = t + recoveryBackoffMs(att.n)
          recoveryAttempts.set(chosenKey, att)
          armRecoveryTimer(att.nextAt - t)
        }
        // 公平续扇：预算耗尽但队列未空 → 立刻排下一扇（>96 不饿死）；store 损坏不空转。
        if (!storeBroken && larkRecoveryQueue.size > 0 && !state.larkDedupClosedForever) armRecoveryTimer(0)
      } finally {
        larkRecoveryRunning = false
      }
    }

    async function sendOutbound(channel, conversation, text, meta) {
      const adapter = state.adapters[channel]
      if (!adapter || typeof adapter.sendText !== 'function') {
        throw new Error('adapter not ready: ' + channel)
      }
      // 会话 meta 展示层不携带匿名诊断归属（diag 只供适配器归组，不入 sessions[].meta）。
      const record = ensureSessionRecord(channel, conversation, meta && meta.diag ? { ...meta, diag: undefined } : meta)
      const result = await adapter.sendText(conversation, text, meta || {})
      record.lastOutboundAt = now()
      record.messageCount += 1
      const status = channelStatus(channel)
      if (status) {
        status.outboundCount += 1
        status.lastOutboundAt = now()
      }
      recordRecent('outbound', {
        channel,
        conversation,
        text: textPreview(text),
        status: result && result.status,
        ok: result && result.ok,
      })
      if (!result || result.ok === false) {
        const message = (result && result.error) || 'outbound send failed'
        recordError(channel, message, 'outbound')
      }
      return result
    }

    async function flushReply(sessionId, text, reason) {
      const record = state.sessionToConversation[sessionId]
      if (!record || !text) return
      try {
        await sendOutbound(record.channel, record.conversation, text, {
          sessionId,
          reason: reason && reason.kind,
        })
      } catch (error) {
        recordError(record.channel, error, 'reply flush')
      }
    }

    function onSessionEvent(session, event) {
      if (!isObject(event)) return
      // 飞书渠道且适配器在跑：最终文本/收尾走实时流通道（去重/补尾/收卡），
      // 不再进 turnBuffer——否则最终全文会重复发一遍。
      const record = state.sessionToConversation[session.id]
      const larkLive = Boolean(record && record.channel === 'lark' && state.larkRuntime && state.adapters.lark)
      if (event.type === 'assistant/message') {
        if (!record) return
        const text = extractTextBlocks(event.data && event.data.message && event.data.message.content)
        if (!text) return
        if (larkLive) {
          const data = isObject(event.data) ? event.data : {}
          return deliverLarkFinal(session.id, record, text, data)
        }
        state.turnBuffer[session.id] = (state.turnBuffer[session.id] || '') + text
      } else if (event.type === 'turn/end') {
        if (larkLive && handleLarkTurnEnd(session.id, event.data)) return
        // 未命中流状态（如正文在渠道停机期间进了 turnBuffer）→ 走旧的缓冲冲刷，
        // 不让缓冲期间的正文静默丢失。
        const text = state.turnBuffer[session.id] || ''
        delete state.turnBuffer[session.id]
        const reason = event.data && event.data.reason
        if (text && (!reason || reason.kind !== 'aborted')) {
          flushReply(session.id, text, reason)
        }
      }
    }

    // curl 配置值：双引号内只有 \\ 与 \" 是转义序列（curl -K 的解析规则）。
    function curlConfigValue(value) {
      return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }

    // 泄露点 3：URL、请求头、方法、请求体全部改走 stdin 上的 curl 配置，
    // 命令行只留 `curl --config -`。请求体是 JSON.stringify 的产物（单行），
    // 可以安全地放进配置的引号里；stdout 里用 write-out 追加状态标记。
    function buildCurlConfig(method, url, headers, body, timeoutSec) {
      const lines = [
        'url = ' + curlConfigValue(url),
        'request = ' + curlConfigValue(method || 'GET'),
        'silent',
        'show-error',
        'max-time = ' + curlConfigValue(String(timeoutSec)),
      ]
      for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue
        lines.push('header = ' + curlConfigValue(key + ': ' + value))
      }
      if (body !== undefined && body !== null) lines.push('data-binary = ' + curlConfigValue(String(body)))
      // 不加前导换行：write-out 永远在响应体之后，lastIndexOf 仍只命中它。
      lines.push('write-out = ' + curlConfigValue('__DSH_STATUS__:%{http_code}'))
      return lines.join('\n')
    }

    async function httpRequest(method, url, headers, body, options) {
      const opts = options || {}
      const timeoutMs = opts.timeoutMs || state.config.runtime.shellTimeoutMs || 60000
      const stdoutMaxBytes = Number(opts.stdoutMaxBytes || state.config.runtime.stdoutMaxBytes || 2 * 1024 * 1024)
      const timeoutSec = clamp(Math.ceil(timeoutMs / 1000), 1, 300)
      const spec = ctx.shell.resolve({
        command: 'curl --config -',
        stdin: buildCurlConfig(method, url, headers, body, timeoutSec),
        timeoutMs,
        stdoutMaxBytes,
        sandboxPolicy: SHELL_SANDBOX_POLICY,
      })
      const result = await shellRun(ctx.shell, spec)
      const stdout = (result.stdout && result.stdout.text) || ''
      const stderr = (result.stderr && result.stderr.text) || ''
      const marker = '__DSH_STATUS__:'
      const markerIndex = stdout.lastIndexOf(marker)
      let status = 0
      let text = stdout
      if (markerIndex >= 0) {
        status = parseInt(stdout.slice(markerIndex + marker.length).trim(), 10) || 0
        text = stdout.slice(0, markerIndex)
      }
      const json = safeJsonParse(text, null)
      return {
        ok: result.exitCode === 0 && status >= 200 && status < 300,
        status,
        exitCode: result.exitCode,
        text,
        stderr,
        json,
        timedOut: result.timedOut,
        aborted: result.aborted,
      }
    }

    async function httpGetJson(url, headers, options) {
      return httpRequest('GET', url, headers, undefined, options)
    }

    async function httpPostJson(url, payload, headers, options) {
      const actualHeaders = Object.assign({}, { 'Content-Type': 'application/json' }, headers || {})
      return httpRequest('POST', url, actualHeaders, JSON.stringify(payload || {}), options)
    }

    function readBody(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const decoder = new TextDecoder()
        let text = ''
        let size = 0
        let settled = false
        const finish = (error, value) => {
          if (settled) return
          settled = true
          if (error) reject(error)
          else resolve(value)
        }
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            finish(new Error('request body too large'))
            if (req.destroy) req.destroy()
            return
          }
          text += decoder.decode(chunk, { stream: true })
        })
        req.on('end', () => finish(null, text + decoder.decode()))
        req.on('error', finish)
      })
    }

    function sendJson(res, statusCode, value) {
      if (res.headersSent) return
      res.writeHead(statusCode || 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }

    function sendText(res, statusCode, text) {
      if (res.headersSent) return
      res.writeHead(statusCode || 200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(String(text || ''))
    }

    // options.channel 标识“外部平台回调”：未捕获的异常只回固定短语，细节经
    // recordError 进内部（写入即脱敏）。UI 路由由 registerUiRoute 自己 try/catch
    // 并返回脱敏后的 error 文本，这里只兜底。
    function registerRoute(path, options, handler) {
      const opts = isObject(options) ? options : {}
      const routeHandler = typeof handler === 'function' ? handler : options
      return ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await routeHandler(req, res)
          } catch (error) {
            if (res.headersSent) return
            if (opts.channel) {
              // 对外固定短语：内部错误（可能带着命令行 / 令牌）不进响应体。
              recordError(opts.channel, error, opts.context || 'webhook', false)
              sendText(res, 500, 'internal error')
              return
            }
            sendJson(res, 500, {
              ok: false,
              error: redactSecretText(error && error.message ? error.message : String(error), rememberSecretValues()),
            })
          }
        },
      })
    }

    // 静态 client 同源 fetch：浏览器拿不到动态 host.call。
    // 与 DSH 自身 /api 信任门禁同规则（packages/client/connection 的
    // isTrustedApiRequest）：Host 必须回环（DNS rebinding 防御）；显式跨站标记
    // 一律拒绝；Origin 存在时必须与 Host 同源，不存在则放行——回环页面的同源
    // GET 不带 Origin，Electron 外壳（sec-fetch-mode: cors）也不带 Origin 与
    // Referer，旧规则把这两种情况全部拒掉，导致设置页 403。
    function authenticateSameOrigin(req, res) {
      const deny = () => {
        sendJson(res, 403, { ok: false, error: 'forbidden origin' })
        return false
      }
      const host = headerValue(req && req.headers, 'host')
      if (!isLoopbackHostname(hostnameFromHostHeader(host))) return deny()
      if (headerValue(req && req.headers, 'sec-fetch-site') === 'cross-site') return deny()
      const origin = headerValue(req && req.headers, 'origin')
      // URL 解析会剥掉默认端口，因此 http://host:80 与 http://host 视为同源。
      if (origin && originOfUrl(origin) !== originOfUrl(`http://${host}`)) return deny()
      return true
    }

    async function readJsonBody(req, maxBytes) {
      const text = await readBody(req, maxBytes || 1024 * 1024)
      if (!text || !String(text).trim()) return {}
      const parsed = safeJsonParse(text, undefined)
      if (parsed === undefined) throw new Error('invalid json body')
      if (!isObject(parsed)) throw new Error('json body must be an object')
      return parsed
    }

    function companionCommand(script, args) {
      const nodePath = state.config.runtime.nodePath || 'node'
      const companionDir = state.config.runtime.companionDir || joinPath(state.workspaceRoot, '.dsh-messaging/companion')
      return buildCommand([nodePath, joinPath(companionDir, script), ...(args || [])])
    }

    async function companionRun(script, args, input, timeoutMs) {
      const result = await shellRun(ctx.shell, ctx.shell.resolve({
        command: companionCommand(script, args),
        stdin: input === undefined ? undefined : JSON.stringify(input),
        timeoutMs: timeoutMs || 30000,
        stdoutMaxBytes: Number(state.config.runtime.stdoutMaxBytes || 1024 * 1024),
        sandboxPolicy: SHELL_SANDBOX_POLICY,
      }))
      const stdout = (result.stdout && result.stdout.text) || ''
      const stderr = (result.stderr && result.stderr.text) || ''
      if (result.exitCode !== 0 || !stdout.trim()) {
        throw new Error('companion process failed: ' + (stderr || stdout || 'empty output'))
      }
      return safeJsonParse(stdout.trim(), null)
    }

    // OneBot v11
    function startOnebot(cfg) {
      const disposers = []
      const path = cfg.webhookPath || '/messaging/onebot'

      // Security: refuse to start webhook without secret to prevent unauthorized access
      if (!cfg.secret || cfg.secret.trim() === '') {
        recordError('onebot', 'webhook startup refused: secret is required for security. Set adapters.onebot.secret in config or disable the adapter.', 'config', true)
        return disposers
      }

      state.adapters.onebot = {
        sendText: async (conversation, text) => {
          const parts = String(conversation).split(':')
          const isGroup = parts[0] === 'group'
          const target = parts.slice(1).join(':')
          const action = isGroup ? 'send_group_msg' : 'send_private_msg'
          const payload = isGroup ? { group_id: Number(target), message: text } : { user_id: Number(target), message: text }
          const headers = {}
          if (cfg.accessToken) headers.Authorization = 'Bearer ' + cfg.accessToken
          const response = await httpPostJson(joinUrl(cfg.endpoint, action), payload, headers)
          const apiOk = response.ok && (!response.json || response.json.retcode === 0 || response.json.status === 'ok')
          return { ok: apiOk, status: response.status, error: apiOk ? null : (response.json && (response.json.msg || response.json.wording)) || response.stderr || ('HTTP ' + response.status) }
        },
      }
      disposers.push(registerRoute(path, { channel: 'onebot' }, async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const contentType = req.headers && (req.headers['content-type'] || req.headers['Content-Type']) || ''
        if (!isApplicationJson(contentType)) {
          recordError('onebot', 'incoming webhook rejected: unsupported content-type', 'auth', false)
          return sendText(res, 415, 'unsupported media type')
        }
        const rawBody = await readBody(req, 4 * 1024 * 1024)
        if (rawBody === null) return sendJson(res, 400, { ok: false, error: 'invalid body' })
        if (cfg.secret) {
          const signature = req.headers && (req.headers['x-signature'] || req.headers['X-Signature']) || ''
          if (!signature) {
            recordError('onebot', 'incoming webhook rejected: missing X-Signature header', 'auth', false)
            return sendJson(res, 401, { ok: false, error: 'unauthorized' })
          }
          const verifyRes = await companionRun('crypto-helper.cjs', ['onebot', 'verify'], {
            signature,
            rawBody,
            // 泄露点 4：密钥改走 stdin，argv 只留子命令。
            secret: cfg.secret,
          }, 15000)
          if (!verifyRes || verifyRes.ok !== true) {
            recordError('onebot', 'incoming webhook rejected: signature verification failed', 'auth', false)
            return sendJson(res, 401, { ok: false, error: 'unauthorized' })
          }
        }
        const body = safeJsonParse(rawBody, null)
        if (body && body.post_type === 'message') {
          const selfId = body.self_id
          const senderId = body.sender && body.sender.user_id
          if (senderId !== undefined && selfId !== undefined && String(senderId) === String(selfId)) {
            return sendJson(res, 200, { ok: true, ignored: 'self-echo' })
          }
          const text = extractOnebotText(body)
          if (text) {
            const messageType = body.message_type === 'group' ? 'group' : 'private'
            if (messageType === 'group' && body.group_id === undefined) return sendJson(res, 200, { ok: true, ignored: 'missing-group-id' })
            if (messageType === 'private' && body.user_id === undefined) return sendJson(res, 200, { ok: true, ignored: 'missing-user-id' })
            const conversation = messageType === 'group' ? 'group:' + body.group_id : 'private:' + body.user_id
            inbound('onebot', conversation, text, {
              messageType,
              userId: body.user_id,
              groupId: body.group_id || null,
              nickname: body.sender && body.sender.nickname,
            })
          }
        }
        sendJson(res, 200, { ok: true })
      }))
      setChannelState('onebot', 'running', { webhookPath: path, endpoint: cfg.endpoint, auth: cfg.secret ? 'signature-verified' : 'unverified' })
      return disposers
    }

    function extractOnebotText(event) {
      if (typeof event.raw_message === 'string' && event.raw_message) return event.raw_message
      if (Array.isArray(event.message)) {
        return event.message
          .map((segment) => {
            if (isObject(segment) && segment.type === 'text') return (segment.data && segment.data.text) || ''
            if (typeof segment === 'string') return segment
            return ''
          })
          .join('')
      }
      if (typeof event.message === 'string') return event.message
      if (isObject(event.message) && typeof event.message.text === 'string') return event.message.text
      return ''
    }

    // Telegram
    function telegramApi(cfg, method) {
      return 'https://api.telegram.org/bot' + cfg.token + '/' + method
    }

    async function startTelegram(cfg) {
      const disposers = []
      state.adapters.telegram = {
        sendText: async (conversation, text) => {
          let last = null
          for (const chunk of splitText(text, 4096)) {
            const response = await httpPostJson(telegramApi(cfg, 'sendMessage'), { chat_id: conversation, text: chunk })
            last = { ok: response.ok, status: response.status, error: response.ok ? null : (response.json && response.json.description) || response.stderr || ('HTTP ' + response.status) }
            if (!response.ok) break
          }
          return last || { ok: false, status: 0, error: 'empty reply' }
        },
      }

      const getMe = await httpGetJson(telegramApi(cfg, 'getMe'), {}, { timeoutMs: 15000 })
      if (getMe.ok && getMe.json && getMe.json.result) state.telegramBotId = getMe.json.result.id
      else {
        const detail = (getMe.json && getMe.json.description) || getMe.stderr || ('HTTP ' + getMe.status)
        throw new Error('telegram getMe failed: ' + detail)
      }

      const processUpdate = (update) => {
        if (!isObject(update)) return
        state.telegramOffset = Math.max(state.telegramOffset, Number(update.update_id || 0) + 1)
        const message = update.message || update.channel_post
        if (!isObject(message)) return
        if (message.from && state.telegramBotId !== null && Number(message.from.id) === Number(state.telegramBotId)) return
        const text = message.text || message.caption || ''
        if (!text) return
        const chat = message.chat || {}
        if (chat.id === undefined || chat.id === null) return
        inbound('telegram', String(chat.id), text, {
          messageId: message.message_id,
          chatType: chat.type,
          fromId: message.from && message.from.id,
        })
      }

      if (cfg.mode === 'webhook') {
        disposers.push(registerRoute(cfg.webhookPath || '/messaging/telegram/webhook', { channel: 'telegram' }, async (req, res) => {
          if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
          const contentType = req.headers && (req.headers['content-type'] || req.headers['Content-Type']) || ''
          if (!isApplicationJson(contentType)) {
            recordError('telegram', 'incoming webhook rejected: unsupported content-type', 'auth', false)
            return sendText(res, 415, 'unsupported media type')
          }
          if (!cfg.webhookSecret) {
            recordError('telegram', 'incoming webhook rejected: webhookSecret is not configured', 'auth', false)
            return sendJson(res, 401, { ok: false, error: 'unauthorized' })
          }
          const secretHeader = req.headers && (
            req.headers['x-telegram-bot-api-secret-token'] ||
            req.headers['X-Telegram-Bot-Api-Secret-Token']
          ) || ''
          if (!secretHeader || !constantTimeEqual(secretHeader, cfg.webhookSecret)) {
            recordError('telegram', 'incoming webhook rejected: secret token mismatch', 'auth', false)
            return sendJson(res, 401, { ok: false, error: 'unauthorized' })
          }
          const body = safeJsonParse(await readBody(req, 4 * 1024 * 1024), null)
          if (body) processUpdate(body)
          sendJson(res, 200, { ok: true })
        }))
        setChannelState('telegram', 'running', { mode: 'webhook', path: cfg.webhookPath || '/messaging/telegram/webhook', auth: cfg.webhookSecret ? 'secret-configured' : 'unprotected' })
      } else {
        if (cfg.dropPendingUpdates && state.telegramOffset === 0) {
          const dropped = await httpGetJson(telegramApi(cfg, 'getUpdates') + '?timeout=0&offset=-1', {}, { timeoutMs: 15000 })
          if (dropped.ok && Array.isArray(dropped.json && dropped.json.result)) {
            state.telegramOffset = dropped.json.result.reduce((max, update) => Math.max(max, Number(update.update_id || 0) + 1), state.telegramOffset)
          }
        }
        disposers.push(ctx.interval(() => {
          if (state.telegramPolling) return
          state.telegramPolling = true
          // 按渠道代际：只重建 telegram 时本循环自己过期，不会牵连别的渠道。
          const generation = state.channelGeneration.telegram
          const timeoutSec = Number(cfg.longPollTimeoutSec || state.config.runtime.telegramLongPollTimeoutSec || 40)
          const offsetPart = state.telegramOffset ? '&offset=' + state.telegramOffset : ''
          httpGetJson(telegramApi(cfg, 'getUpdates') + '?timeout=' + timeoutSec + offsetPart, {}, { timeoutMs: (timeoutSec + 15) * 1000 })
            .then((response) => {
              if (generation !== state.channelGeneration.telegram) return
              if (!response.ok) throw new Error(response.json && response.json.description || response.stderr || ('HTTP ' + response.status))
              const updates = response.json && response.json.result
              if (Array.isArray(updates)) for (const update of updates) processUpdate(update)
              setChannelState('telegram', 'running', { mode: 'polling', pollIntervalMs: Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500) })
            })
            .catch((error) => {
              if (generation === state.channelGeneration.telegram) recordError('telegram', error, 'long poll')
            })
            .finally(() => {
              if (generation === state.channelGeneration.telegram) state.telegramPolling = false
            })
        }, clamp(Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500), 500, 60000)))
        setChannelState('telegram', 'running', { mode: 'polling', pollIntervalMs: Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500) })
      }
      return disposers
    }

    // Discord Gateway companion
    async function startDiscord(cfg) {
      const disposers = []
      const modulePath = cfg.wsModulePath || state.config.runtime.wsModulePath
      // onExpiry:'none'：0.1.7+ 的 resolve 默认 'kill'，会按默认 timeoutMs 到点
      // 杀掉常驻伴进程；旧代 resolve 丢弃该未知字段、start 本就忽略超时——
      // 两代语义因此一致（常驻直到显式 kill / 组合卸载）。
      const proc = await shellStart(ctx.shell, ctx.shell.resolve({
        command: companionCommand('discord-gateway.cjs', ['--ws-module', modulePath || 'ws']),
        stdin: JSON.stringify({ token: cfg.botToken, intents: cfg.intents || 33281 }),
        sandboxPolicy: SHELL_SANDBOX_POLICY,
        onExpiry: 'none',
      }))
      state.discordProc = proc
      disposers.push(ctx.effect(() => () => {
        try { proc.kill() } catch {
          // 进程可能已自行退出，卸载失败无需上报。
        }
      }))
      let buffer = ''
      const handleLine = (line) => {
        const clean = line.trim()
        if (!clean) return
        const packet = safeJsonParse(clean, null)
        if (!packet) return
        if (packet.type === 'ready') setChannelState('discord', 'running', { gateway: packet.url })
        else if (packet.type === 'message') {
          if (packet.authorBot) return
          if (!packet.channelId) return
          inbound('discord', 'discord:' + packet.channelId, packet.content || '', {
            channelId: packet.channelId,
            guildId: packet.guildId,
            authorId: packet.authorId,
            messageId: packet.messageId,
          })
        } else if (packet.type === 'error') {
          recordError('discord', packet.message || 'discord gateway error', 'gateway')
        }
      }
      disposers.push(ctx.interval(() => {
        try {
          const output = proc.readOutput()
          buffer += output.delta || ''
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() || ''
          for (const line of lines) handleLine(line)
        } catch (error) {
          recordError('discord', error, 'gateway read')
        }
      }, 1000))
      state.adapters.discord = {
        sendText: async (conversation, text) => {
          const channelId = String(conversation).replace(/^discord:/, '')
          let last = null
          for (const chunk of splitText(text, 2000)) {
            const response = await httpPostJson('https://discord.com/api/v10/channels/' + channelId + '/messages', { content: chunk }, {
              Authorization: 'Bot ' + cfg.botToken,
            })
            last = { ok: response.ok, status: response.status, error: response.ok ? null : (response.json && response.json.message) || response.stderr || ('HTTP ' + response.status) }
            if (!response.ok) break
          }
          return last || { ok: false, status: 0, error: 'empty reply' }
        },
      }
      setChannelState('discord', 'starting', { mode: 'gateway' })
      return disposers
    }

    // Slack Events API
    function startSlack(cfg) {
      const disposers = []
      const path = cfg.webhookPath || '/messaging/slack/events'
      state.adapters.slack = {
        sendText: async (conversation, text) => {
          const target = String(conversation).replace(/^slack:/, '')
          let last = null
          for (const chunk of splitText(text, 3000)) {
            const response = await httpPostJson('https://slack.com/api/chat.postMessage', { channel: target, text: chunk }, {
              Authorization: 'Bearer ' + cfg.botToken,
            })
            last = { ok: response.ok && response.json && response.json.ok !== false, status: response.status, error: (response.json && response.json.error) || response.stderr || (!response.ok ? 'HTTP ' + response.status : null) }
            if (last.ok === false) break
          }
          return last || { ok: false, status: 0, error: 'empty reply' }
        },
      }
      disposers.push(registerRoute(path, { channel: 'slack' }, async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const contentType = req.headers && (req.headers['content-type'] || req.headers['Content-Type']) || ''
        // Slack sends application/json, application/x-www-form-urlencoded (for shortcuts/interactivity)
        if (!isApplicationJson(contentType) && !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
          recordError('slack', 'incoming webhook rejected: unsupported content-type', 'auth', false)
          return sendText(res, 415, 'unsupported media type')
        }
        if (!cfg.signingSecret) {
          recordError('slack', 'incoming webhook rejected: signingSecret is not configured', 'auth', false)
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }
        const timestamp = req.headers && (req.headers['x-slack-request-timestamp'] || req.headers['X-Slack-Request-Timestamp']) || ''
        const signature = req.headers && (req.headers['x-slack-signature'] || req.headers['X-Slack-Signature']) || ''
        const rawBody = await readBody(req, 2 * 1024 * 1024)
        if (!timestamp || !signature || rawBody === null) {
          recordError('slack', 'incoming webhook rejected: missing signature or timestamp headers', 'auth', false)
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }
        const verifyRes = await companionRun('crypto-helper.cjs', ['slack', 'verify'], {
          timestamp,
          signature,
          rawBody,
          signingSecret: cfg.signingSecret,
        }, 15000)
        if (!verifyRes || verifyRes.ok !== true) {
          recordError('slack', 'incoming webhook rejected: signature verification failed', 'auth', false)
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }
        const body = safeJsonParse(rawBody, null)
        if (!body) return sendJson(res, 400, { ok: false, error: 'invalid json' })
        if (body.type === 'url_verification') return sendJson(res, 200, { challenge: body.challenge })
        if (body.type === 'event_callback' && body.event) {
          const event = body.event
          if (event.type === 'message' && !event.bot_id && !event.subtype) {
            if (event.text && event.channel) inbound('slack', 'slack:' + event.channel, event.text, {
              channel: event.channel,
              user: event.user,
              ts: event.ts,
            })
          }
        }
        sendJson(res, 200, { ok: true })
      }))
      setChannelState('slack', 'running', { path, signature: cfg.signingSecret ? 'configured' : 'not-verified' })
      return disposers
    }

    // Lark / Feishu：token 缓存**按 runtime（generation+appId）隔离**——缓存存在
    // runtime 对象自身字段上，旧 auth 迟到只写旧 runtime，绝不污染当前新代；
    // cleanup 用捕获旧 runtime 自有 token，不经任何共享缓存串新旧。
    async function larkAccessToken(runtime) {
      const cfg = runtime.cfg
      const cached = runtime.token
      if (cached && cached.appId === cfg.appId && cached.expiresAt > now()) return cached.value
      const response = await httpPostJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: cfg.appId,
        app_secret: cfg.appSecret,
      })
      if (!response.ok || !response.json || !response.json.tenant_access_token) {
        throw new Error(response.json && response.json.msg || response.stderr || ('HTTP ' + response.status))
      }
      // 写缓存前验证归属：只写**本 runtime 自己的**字段（appId 一致），
      // 即便本 runtime 已被 reload 作废也不触碰任何其他代的缓存。
      runtime.token = {
        value: response.json.tenant_access_token,
        expiresAt: now() + (Number(response.json.expire) || 7200) * 1000 - 60000,
        appId: cfg.appId,
      }
      return runtime.token.value
    }

    async function larkDecrypt(cfg, encrypted) {
      const result = await companionRun('crypto-helper.cjs', ['lark', 'decrypt'], { encrypt: encrypted, key: cfg.encryptKey }, 15000)
      if (!result || result.ok !== true) throw new Error(result && result.error || 'lark decrypt failed')
      return safeJsonParse(result.json, null)
    }

    async function verifyLarkSignature(cfg, req, rawBody) {
      const result = await companionRun('crypto-helper.cjs', ['lark', 'verify'], {
        encryptKey: cfg.encryptKey,
        timestamp: headerValue(req.headers, 'x-lark-request-timestamp'),
        nonce: headerValue(req.headers, 'x-lark-request-nonce'),
        signature: headerValue(req.headers, 'x-lark-signature'),
        rawBody,
      }, 15000)
      return Boolean(result && result.ok === true)
    }

    function larkReplayKey(timestamp, nonce, signature) {
      return timestamp + ':' + nonce + ':' + signature
    }
    // D：只查不记——成功 replay 记录必须在 durable claim+bind 成功后才写；
    // claim 失败（500）不得留成功 replay，合法同 body 重试才可成功。
    function larkRequestSeen(timestamp, nonce, signature) {
      const current = now()
      for (const [key, expiresAt] of state.larkSeenRequests) {
        if (expiresAt <= current) state.larkSeenRequests.delete(key)
      }
      return state.larkSeenRequests.has(larkReplayKey(timestamp, nonce, signature))
    }
    function rememberLarkRequest(timestamp, nonce, signature) {
      const current = now()
      for (const [key, expiresAt] of state.larkSeenRequests) {
        if (expiresAt <= current) state.larkSeenRequests.delete(key)
      }
      if (state.larkSeenRequests.has(larkReplayKey(timestamp, nonce, signature))) return 'replay'
      if (state.larkSeenRequests.size >= 10000) {
        const oldest = state.larkSeenRequests.keys().next().value
        state.larkSeenRequests.delete(oldest)
      }
      state.larkSeenRequests.set(larkReplayKey(timestamp, nonce, signature), current + LARK_REPLAY_TTL_MS)
      return 'new'
    }

    function larkVerificationToken(event) {
      if (!isObject(event)) return ''
      if (event.schema === '2.0') {
        return isObject(event.header) && typeof event.header.token === 'string' ? event.header.token : ''
      }
      if (typeof event.token === 'string') return event.token
      if (isObject(event.header) && typeof event.header.token === 'string') return event.header.token
      return ''
    }

    // 长连接（WebSocket）方式：SDK 只在建连时用 app_id/app_secret 鉴权，之后推送
    // 均为明文，既不需要 verificationToken 也不需要 encryptKey，也不需要公网地址。
    // 官方文档：open.larkoffice.com/document/server-side-sdk/nodejs-sdk/handling-events
    // 测试可用 ctx.get('dshMessaging.larkSdk') 注入替身（生产环境无此服务）。
    async function loadLarkSdk(ctx) {
      const injected = ctx.get('dshMessaging.larkSdk')
      if (injected) return injected
      return import('@larksuiteoapi/node-sdk')
    }

    // SDK 层痕迹（飞书事件链路的第三级证据）：
    //  · EventDispatcher **没有通配注册**，未注册的事件类型只会以 `no <type> handle`
    //    出现在日志里（warn），已注册的以 `execute <type> handle`（debug）；
    //  · WSClient 在数据帧到达时打 debug 级行 `receive message, message_type: …;
    //    data: <完整事件体>`——即使 dispatcher 根本没被调用，也能证明「飞书推了」。
    //  两处都**只提取字段**（event_type / message_type / chat_type / outcome / source）：
    //  日志行本身与 `data:` 后面的事件体绝不写进 recent。debug/trace 行只分类不转发
    //  （保持宿主控制台与 info 级时代一致，避免把事件体打进宿主日志），info 及以上照旧转发。
    function makeLarkSdkLogger(sdk) {
      const record = (source, entry) => recordRecent('lark-event', Object.assign({ channel: 'lark', source }, entry))
      const classify = (line) => {
        if (typeof line !== 'string' || !line) return
        let match = /^no (.+) handle$/.exec(line)
        if (match) {
          record('dispatcher', { eventType: match[1], messageType: null, chatType: null, outcome: 'unhandled' })
          return
        }
        match = /^execute (.+) handle$/.exec(line)
        if (match) {
          // 已覆盖的类型不再记 execute（重复噪声）：消息事件由 inbound / lark-drop
          // 必留一条；LARK_NOOP_EVENTS 表内的事件由处理器首次 noted 一次。
          if (match[1] !== 'im.message.receive_v1' && !LARK_NOOP_EVENTS.has(match[1])) {
            record('dispatcher', { eventType: match[1], messageType: null, chatType: null, outcome: 'handled' })
          }
          return
        }
        if (line === 'verification failed event') {
          record('dispatcher', { eventType: null, messageType: null, chatType: null, outcome: 'verification-failed' })
          return
        }
        if (line.includes('receive message')) {
          // `receive message, message_type: event; message_id: …; trace_id: …; data: <体>`
          // 只取帧头字段，`data:` 之后一概不碰。
          match = /receive message, message_type: ([^;]*);/.exec(line)
          record('ws', { eventType: null, messageType: match ? match[1].trim() : null, chatType: null, outcome: 'frame' })
          return
        }
        if (line.includes('failed to handle inbound frame') || line.includes('failed to merge event fragments')) {
          record('ws', { eventType: null, messageType: null, chatType: null, outcome: 'frame-error' })
          return
        }
        if (line.includes('invoke event failed')) {
          // 处理器抛错（WSClient 的 catch 行，args 同样是 ['[ws]', '…']）。
          record('ws', { eventType: null, messageType: null, chatType: null, outcome: 'invoke-error' })
        }
      }
      const forward = (level) => (...args) => {
        try {
          // LoggerProxy 把参数包成**一个数组**传入；而 WSClient 是
          // `logger.debug('[ws]', '<正文>')` → 收到的是 ['[ws]', '<正文>']，
          // **必须逐段分类**：只取 [0] 会永远拿到 '[ws]'、把整行漏掉
          // （实机上 ws 帧痕迹缺失就是这个原因）。dispatcher 的行是单元素数组。
          const parts = Array.isArray(args[0]) ? args[0] : args
          for (const part of parts) classify(part)
        } catch {
          // 痕迹失败不能影响 SDK 自身的日志链路。
        }
        if (level === 'debug' || level === 'trace') return
        const target = sdk && sdk.defaultLogger
        if (target && typeof target[level] === 'function') target[level](...args)
      }
      return {
        trace: forward('trace'),
        debug: forward('debug'),
        info: forward('info'),
        warn: forward('warn'),
        error: forward('error'),
      }
    }

    // 飞书事件有两种形状，取类型的位置不同：
    // - v2（长连接推送、新版 webhook）：类型在 header.event_type；SDK 的
    //   EventDispatcher 会把 header/event 摊平到顶层，故读顶层 event_type；
    // - v1（旧版回调）：类型在 event.type。
    // 取错会导致事件被静默丢弃——长连接「连得上、心跳正常、却永远收不到消息」
    // 就是这个原因。
    function larkEventType(event) {
      if (!isObject(event)) return ''
      if (typeof event.event_type === 'string' && event.event_type) return event.event_type
      if (isObject(event.header) && typeof event.header.event_type === 'string') return event.header.event_type
      if (isObject(event.event) && typeof event.event.type === 'string') return event.event.type
      return typeof event.type === 'string' ? event.type : ''
    }

    // 事件体与发送者：v2 在顶层，v1 在 event 之下。
    function larkEventBody(event) {
      if (isObject(event) && isObject(event.message)) {
        return { message: event.message, sender: event.sender, chatId: event.chat_id }
      }
      const inner = isObject(event) && isObject(event.event) ? event.event : null
      if (inner && isObject(inner.message)) {
        return { message: inner.message, sender: inner.sender, chatId: inner.chat_id }
      }
      return { message: null, sender: null, chatId: null }
    }

    // 消息正文提取：text 直取；post 摊平成纯文本（post 的 content.content 是
    // 「段落数组、每段是元素数组」，直接 String() 会得到 "[object Object]"）；
    // 其余**显式**类型不支持（图片/表情包/文件的内容里没有文本）→ 返回 null，
    // 调用方记 lark-drop(unsupported message_type)。
    // message_type 缺省时按 text 兼容旧形状（v1 回调不带该字段）。
    // 返回：string（空串 = 没有文本）；null = 该类型不支持。
    function larkMessageText(message, content) {
      const type = typeof message.message_type === 'string' ? message.message_type : ''
      if (type === 'post') return larkPostText(content)
      if (type && type !== 'text') return null
      if (!isObject(content)) return ''
      if (typeof content.text === 'string' && content.text) return content.text
      if (typeof content.content === 'string' && content.content) return content.content
      return flattenLarkContent(content.content) || ''
    }

    function larkPostText(post) {
      if (!isObject(post)) return ''
      const parts = []
      if (typeof post.title === 'string' && post.title) parts.push(post.title)
      const body = flattenLarkContent(post.content)
      if (body) parts.push(body)
      return parts.join('\n')
    }

    // 富文本摊平：跳过没有文本的元素（图片/表情/音频），只留带 text 的节点。
    function flattenLarkContent(content) {
      if (!Array.isArray(content)) return ''
      const paragraphs = content.every((paragraph) => Array.isArray(paragraph)) ? content : [content]
      const lines = []
      for (const elements of paragraphs) {
        if (!Array.isArray(elements)) continue
        const inline = []
        for (const element of elements) {
          if (isObject(element) && typeof element.text === 'string' && element.text) inline.push(element.text)
        }
        if (inline.length) lines.push(inline.join(''))
      }
      return lines.join('\n')
    }

    // 被丢弃的飞书事件必须在 recent 里留痕（kind=lark-drop）：只记原因与元数据
    // （message_type / chat_type / 文本长度），**绝不记消息原文**——否则
    // 「连得上、心跳正常，却永远收不到消息」在状态页上完全无迹可查。
    function dropLarkEvent(reason, meta, textLen) {
      recordRecent('lark-drop', {
        channel: 'lark',
        reason,
        messageType: meta.messageType || null,
        chatType: meta.chatType || null,
        textLen: typeof textLen === 'number' ? textLen : null,
      })
    }

    // 长连接与 webhook 两条入站路径共用的事件投递：前者已由建连鉴权，后者由
    // handleLarkEvent 校验令牌；这里只负责把事件转成网关的入站消息。
    // 每个 return 分支都记 lark-drop（见 dropLarkEvent），检查顺序：
    // 事件类型 → message → 正文（text/post/不支持的类型）→ chatId。
    // E：image/post 按原顺序提取图文（仅 text+img 元素；无图 → null 保持原丢弃语义）。
    function larkEventContentParts(message, content) {
      const msgType = String(message.message_type || '')
      if (msgType === 'image') {
        const key = content && typeof content.image_key === 'string' ? content.image_key : null
        return key ? [{ kind: 'image', fileKey: key }] : null
      }
      if (msgType === 'post') {
        const rows = content && Array.isArray(content.content) ? content.content : null
        if (!rows) return null
        const parts = []
        if (content && typeof content.title === 'string' && content.title) parts.push({ kind: 'text', text: String(content.title) }) // 标题保留
        for (const row of rows) {
          if (!Array.isArray(row)) continue
          for (const el of row) {
            if (!isObject(el)) continue
            if ((el.tag === 'text' || el.tag === 'a') && typeof el.text === 'string' && el.text) parts.push({ kind: 'text', text: String(el.text) })
            else if (el.tag === 'img' && typeof el.image_key === 'string' && el.image_key) parts.push({ kind: 'image', fileKey: String(el.image_key) })
          }
        }
        return parts.some((p) => p.kind === 'image') ? parts : null
      }
      return null
    }
    async function dispatchLarkEvent(event) {
      // 到达即记时间：即使被丢弃，/status 的 lark.detail.lastEventAt 也能说明
      // 「飞书推过来了」——这是区分「没推」与「收到但丢弃」的唯一凭据。
      state.larkTrace.lastEventAt = now()
      syncLarkDetail()
      const type = larkEventType(event)
      const { message, sender, chatId: bodyChatId } = larkEventBody(event)
      const meta = {
        messageType: isObject(message) && typeof message.message_type === 'string' ? message.message_type : '',
        chatType: isObject(message) && typeof message.chat_type === 'string' ? message.chat_type : '',
      }
      if (type !== 'im.message.receive_v1') {
        dropLarkEvent('not im.message.receive_v1', meta, null)
        return
      }
      if (!isObject(message)) {
        dropLarkEvent('no message', meta, null)
        return
      }
      const content = isObject(message.content) ? message.content : safeJsonParse(message.content, {})
      // E：image/post → 按原顺序提取图文（无图的 post/image 仍按不支持丢弃）。
      const parts = larkEventContentParts(message, content)
      const text = parts ? null : larkMessageText(message, content)
      if (!parts && text === null) {
        dropLarkEvent('unsupported message_type', meta, null)
        return
      }
      if (!parts && !String(text).trim()) {
        dropLarkEvent('no text', meta, String(text).length)
        return
      }
      const chatId = message.chat_id || bodyChatId
      if (!chatId) {
        dropLarkEvent('no chatId', meta, String(text).length)
        return
      }
      if (!message.message_id) {
        dropLarkEvent('no messageId', meta, String(text).length)
        return
      }
      const conversation = 'lark:' + chatId
      const sessionK = sessionKey('lark', conversation)
      // ── P1 claim/ACK 漏斗：鉴权后 durable claim → bindRoute → 才允许 ACK ──
      // open/claim/bind 任一失败 → throw（webhook 500 / WS handler 抛 → 平台重投）；
      // 绝不静默绕过账本、绝不假成功 ACK。重复 terminal/在途 → 跳过（零重复处理）。
      const lease = await ensureLarkDedupStore()
      const prior = state.sessions[sessionK]
      const claimed = await lease.claim({
        appId: String((state.config.adapters.lark && state.config.adapters.lark.appId) || ''),
        messageId: String(message.message_id),
        chatId,
        chatType: meta.chatType === 'p2p' || meta.chatType === 'group' ? meta.chatType : null,
        sessionId: sessionIdForKey(sessionK),
        // 在进程已解析过该会话才有 true 证据；冷进程/未知 → null（绝不推断 false）。
        sessionExisted: prior && prior.sessionId ? true : null,
      })
      if (claimed.outcome === 'duplicate-terminal' || claimed.outcome === 'duplicate-inflight') {
        return { deduped: true, outcome: claimed.outcome }
      }
      if (claimed.outcome !== 'claimed') {
        // C-2/Lead：ACK 只等 durable claim+可靠调度；GET/下载/通知全部在 ACK 后的
        // 恢复队列异步执行（不阻塞 WS/webhook handler >3s，不把就地完结放在 ACK 前）。
        scheduleRecoveryRow(claimed.record, { owned: true })
        return { deduped: true, outcome: 'recoverable:scheduled' }
      }
      // bindRoute durable（sessionId 确定性同源；sx 复用 claim 已定证据，不二次推导）。
      try {
        await lease.bindRoute(claimed.record.key, {
          sessionId: sessionIdForKey(sessionK),
          sessionExisted: claimed.record.sessionExisted,
        })
      } catch (error) {
        lease.release(claimed.record.key) // only this successful claim owns the processing right
        throw error
      }
      // ACK 后处理：进程内单飞持有（claim 即 in-flight；崩溃→recoverable 由平台重投）。
      if (parts) {
        // E：image/post 走统一内容管线——ACK 后异步（下载/准入不阻塞 handler）；
        // payload 仅内存（重启丢失→恢复分支走 message GET 重建）。
        larkContentPayloads.set(claimed.record.key, { parts, messageId: String(message.message_id), chatId })
        scheduleRecoveryRow(claimed.record, { owned: true })
        return { deduped: false, outcome: 'image_scheduled' }
      }
      inbound('lark', conversation, String(text), {
        messageId: message.message_id,
        chatId,
        senderId: sender && sender.sender_id && sender.sender_id.open_id,
        dedup: {
          key: claimed.record.key,
          lease,
          userMessageId: claimed.record.userMessageId,
        },
      })
      return { deduped: false }
    }

    // 已知、无需处理的飞书事件统一处理器（见 LARK_NOOP_EVENTS）：刷新 lastEventAt
    // （“链路活着”的信号），每种类型**首次**出现记一条 outcome='noted' 痕迹，
    // 之后不再留痕——比如每读一条消息就推一次的已读回执，不能每次都刷 recent。
    function makeNoopLarkHandler(eventType) {
      return async () => {
        state.larkTrace.lastEventAt = now()
        syncLarkDetail()
        if (!state.larkTrace.notedEvents.has(eventType)) {
          state.larkTrace.notedEvents.add(eventType)
          recordRecent('lark-event', {
            channel: 'lark',
            source: 'dispatcher',
            eventType,
            messageType: null,
            chatType: null,
            outcome: 'noted',
          })
        }
      }
    }

    async function startLarkLongConnection(cfg) {
      const disposers = []
      let client = null
      let closed = false
      const sdk = await loadLarkSdk(ctx)
      larkImageSdk = sdk // P4：图片工具客户端源（注入替身或真实 sdk）
      setChannelState('lark', 'starting', { mode: 'long-connection' })
      // SDK 层痕迹：开到 debug 才能看到 `execute/no … handle` 与 `receive message`；
      // 我们的 logger 只提取字段（见 makeLarkSdkLogger），debug 行不转发，
      // 宿主控制台输出与原先 info 级时代一致。
      const sdkLogger = makeLarkSdkLogger(sdk)
      const dispatcher = new sdk.EventDispatcher({
        loggerLevel: sdk.LoggerLevel ? sdk.LoggerLevel.debug : undefined,
        logger: sdkLogger,
      })
      // 表内事件（LARK_NOOP_EVENTS）都挂统一的空处理器：首次 noted、之后只刷新
      // lastEventAt；分类器里 `execute X handle` 的跳过用同一张表。
      dispatcher.register(Object.assign({
        'im.message.receive_v1': async (data) => {
          await dispatchLarkEvent(data)
        },
      }, Object.fromEntries([...LARK_NOOP_EVENTS].map((type) => [type, makeNoopLarkHandler(type)]))))
      client = new sdk.WSClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        loggerLevel: sdk.LoggerLevel ? sdk.LoggerLevel.debug : undefined,
        logger: sdkLogger,
        onReady: () => {
          if (closed) return
          state.larkTrace.connectedAt = now()
          setChannelState('lark', 'running', { mode: 'long-connection', path: null })
          warmLarkDedupStore()
          registerLarkImageToolOnce()
        },
        onReconnecting: () => {
          if (closed) return
          // 正在重连 = 当前连接不再成立，先不展示旧的 connectedAt。
          state.larkTrace.connectedAt = null
          setChannelState('lark', 'starting', { mode: 'long-connection', detail: { reconnecting: true } })
        },
        onError: (error) => {
          if (closed) return
          recordError('lark', 'long connection failed: ' + (error && error.message ? error.message : String(error)), 'connect', false)
        },
      })
      // start() 立刻返回，握手结果经 onReady/onError 异步到达。
      await client.start({ eventDispatcher: dispatcher })
      disposers.push(() => {
        closed = true
        try {
          if (client) client.close()
        } catch {
          // 关闭失败不影响适配器卸载。
        }
      })
      return disposers
    }

    // ── 飞书实时出站接线 ────────────────────────────────────────────────
    // 把已验收的 lark-stream（状态机）、lark-card-api / lark-card-layout（协议）与
    // lark-text-splitter（切分/预算）组装到宿主：
    //   · 全局订阅 agent/assistant-stream（global:true），仅已绑定的飞书会话处理，
    //     按 Agent 对象 + 适配器 generation 隔离；
    //   · 模式由 interactiveCard 决定：开 = CardKit 流式卡（live 建实体引用消息、
    //     累计 PUT、收尾关流），关 = 多段独立 text 实时发；
    //   · 非流式（无 live 帧）最终文本：卡片模式发静态 interactive 卡，文本模式发一段 text；
    //   · 所有出站（含错误提示）都经 adapter.sendText，同样受 interactiveCard 约束；
    //   · wire 契约：模块给的是对象 payload，由 larkWire 统一 JSON.stringify +
    //     Content-Type；每次 await token/网络之后复核 generation，旧链不得再派发。
    function larkOutputMode() {
      return state.larkRuntime && state.larkRuntime.interactiveCard ? 'card' : 'text'
    }

    // ── 匿名诊断（schemaVersion 1，见 lib/lark-diagnostics.js）─────────────
    // 每代一个 store；操作派发时捕获 store 引用与代，旧代迟到结果只落原桶，
    // 绝不污染新代展示。所有 diagSafe 调用吞掉任何抛错——诊断不得影响发送、
    // 串行队列、close 序号、计时器或 Agent 生命周期；status 构建零网络。
    const LARK_SCOPE_REFRESH_MIN_MS = 5000
    const LARK_SCOPE_MAX_PAGES = 5
    // C：恢复取正文（官方 message GET，只读；与 scope 查询同域名权威）。
    const LARK_MESSAGE_GET_URL_PREFIX = 'https://open.feishu.cn/open-apis/im/v1/messages/'

    function larkDiag() {
      const generation = state.channelGeneration.lark || 0
      if (!state.larkDiag || state.larkDiag.generation !== generation) {
        state.larkDiag = createLarkDiagnostics(generation)
        state.larkDiag.setDedupReader(larkDedupReader) // status 每次直读真实 store
      }
      state.larkDiag.setImagesAvailable(larkImagesAvailable())
      return state.larkDiag
    }

    // ── P1：去重 store 生命周期（单写者 lease；open 失败绝不静默绕过）──────
    function larkDedupCapacity() {
      const cfg = state.config && state.config.adapters && state.config.adapters.lark
      const raw = cfg ? Number(cfg.sendCapacity) : NaN
      return Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 100000) : 2000
    }
    // A：容量来源真实透出（null 默认→'default'；显式整数→'configured'），供
    // status.capacity.source；绝不向 UI 伪造数字。
    function larkDedupCapacitySource() {
      const cfg = state.config && state.config.adapters && state.config.adapters.lark
      const raw = cfg ? Number(cfg.sendCapacity) : NaN
      return Number.isSafeInteger(raw) && raw > 0 ? 'configured' : 'default'
    }
    async function ensureLarkDedupStore() {
      if (state.larkDedupClosedForever) {
        const err = new Error('lark dedup store is closed (plugin disposing)')
        err.code = 'closed'
        throw err
      }
      const entry = state.larkDedup || (state.larkDedup = { lease: null, opening: null, lastError: null })
      if (entry.lease) return entry.lease
      if (entry.opening) return entry.opening
      entry.opening = (async () => {
        try {
          const lease = await openLarkDedupStore(join(dshHomeRoot, 'lark-dedup'), { sendCapacity: larkDedupCapacity() })
          // dispose 竞态：open 后到时若已关闭 → 立即关闭新 lease，绝不泄漏。
          if (state.larkDedupClosedForever) {
            try { await lease.close() } catch { /* 仅关自身 */ }
            const err = new Error('lark dedup store closed during open')
            err.code = 'closed'
            throw err
          }
          entry.lease = lease
          entry.lastError = null
          return entry.lease
        } catch (error) {
          // 白名单才透出（自由文本不入 status）；非白名单→null（available:false 已表达）。
          entry.lastError = error && typeof error.code === 'string' && LARK_DEDUP_LAST_ERRORS.includes(error.code) ? error.code : null
          throw error
        } finally {
          entry.opening = null
        }
      })()
      return entry.opening
    }
    // 显式重开动作（POST /__dsh-messaging/reload 调用）：close/drain → rebuild
    // 后 start 重开；不清账本、不自动反复重开（poison 恢复唯一入口）。
    async function closeLarkDedupStore() {
      releasePresetActivations()
      const entry = state.larkDedup
      if (!entry) return
      const lease = entry.lease
      entry.lease = null
      entry.lastError = null
      if (lease) {
        try { await lease.close() } catch (error) { recordError('lark', error, 'dedup close', false) }
      }
    }
    // status 直读真实 store（读时取 stats；非初始化真值、非模型字段）。
    function larkDedupReader() {
      const entry = state.larkDedup
      if (!entry || !entry.lease) return null
      try {
        return {
          stats: entry.lease.stats(),
          sendCapacity: larkDedupCapacity(),
          sendCapacitySource: larkDedupCapacitySource(),
          lastError: entry.lastError,
        }
      } catch {
        return null
      }
    }
    // 渠道 running 即尝试打开：失败不阻断启动（记录错误），入站 claim 将 fail-closed；
    // 成功后主动 recover（崩溃残留本地完结，不靠平台重投；dispose 竞态守卫）。
    function warmLarkDedupStore() {
      ensureLarkDedupStore()
        .then(() => {
          if (state.larkDedupClosedForever) {
            closeLarkDedupStore().catch(() => {})
            return
          }
          seedRecoveryQueue().catch(() => {}) // 启动主动 recover（不依赖新事件）
        })
        .catch((error) => {
          recordError('lark', error, 'dedup open', false)
        })
    }

    // ── P4：图片出站工具接线（seams 全部来自真实宿主 API）──
    let larkImageAxiosMod = null
    try {
      larkImageAxiosMod = (await import('axios')).default || null
    } catch { larkImageAxiosMod = null } // axios 为 lark-sdk 传递依赖；不可用 → 图片诚实降级
    let larkImageSdk = null
    try {
      larkImageSdk = ctx.get('dshMessaging.larkSdk') || null // 测试注入替身优先
    } catch { larkImageSdk = null }
    if (!larkImageSdk) {
      try { larkImageSdk = await import('@larksuiteoapi/node-sdk') } catch { larkImageSdk = null }
    } // 真实 sdk：长连接/webhook 两种模式共用（图片客户端源）
    let larkImageHost = null
    const larkImageAgents = new Map()
    const larkImageAgentTools = new Map()
    const larkImageMasks = new Map()
    let larkImageScopeFailed = false
    let larkImagesStopped = false
    let larkImageServiceEpoch = 0
    const larkImageServices = Object.create(null)
    // Service readiness: no live bound agent is required. If one exists, its
    // scoped registration must succeed. This is not vision/grant/traffic evidence.
    function larkImageServicesReady() {
      return !larkImagesStopped
        && typeof larkImageServices.tools?.service?.register === 'function'
        && typeof larkImageServices.llm?.service?.resolveModelInfo === 'function'
        && typeof larkImageServices.attachments?.service?.validateImage === 'function'
        && typeof larkImageServices.sandboxPolicy?.service?.resolve === 'function'
        && typeof ctx.fs.resolve === 'function' && typeof ctx.fs.readBytes === 'function'
        && typeof larkImageSdk?.Client === 'function' && Boolean(larkImageAxiosMod)
    }
    function larkImagesAvailable() {
      return Boolean(larkImageHost) && !larkImageScopeFailed && larkImageServicesReady()
        && channelStatus('lark')?.state === 'running'
        && [...larkImageAgents.keys()].every((agent) => !currentLarkImageAgent(agent) || larkImageAgentTools.get(agent)?.registered === true)
    }
    function syncLarkImagesAvailable() {
      if (state.larkDiag) state.larkDiag.setImagesAvailable(larkImagesAvailable())
    }
    function clearLarkImageTool() {
      for (const entry of larkImageAgentTools.values()) disposeLarkImageEntry(entry)
      larkImageAgentTools.clear()
      for (const dispose of larkImageMasks.values()) disposeLarkImageEntry({ dispose })
      larkImageMasks.clear()
      larkImageScopeFailed = false
      larkImageHost = null
      syncLarkImagesAvailable()
    }
    function disposeLarkImageEntry(entry) {
      const dispose = entry.dispose
      entry.registered = false
      entry.dispose = null
      try {
        const pending = dispose && dispose()
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      } catch { /* exact, idempotent host disposer */ }
    }
    function currentLarkImageAgent(agent) {
      const bound = larkImageAgents.get(agent)
      return bound && !larkImagesStopped && bound.generation === state.channelGeneration.lark
        && state.sessions[bound.record.key] === bound.record
        && bound.record.channel === 'lark' && bound.record.sessionId === agent.session?.id
        && typeof ctx.agents.get === 'function' && ctx.agents.get(agent.session.id) === agent
    }
    function bindLarkImageAgent(agent, record) {
      if (record.channel !== 'lark' || !agent?.session || record.sessionId !== agent.session.id || larkImagesStopped) return
      const old = larkImageAgents.get(agent)
      if (old?.record !== record || old.generation !== state.channelGeneration.lark) {
        const entry = larkImageAgentTools.get(agent)
        if (entry) disposeLarkImageEntry(entry)
        larkImageAgentTools.delete(agent)
        larkImageAgents.set(agent, { record, generation: state.channelGeneration.lark })
      }
      registerLarkImageToolOnce()
    }
    // Scoped registries inherit down the agent tree. Mask only OUR inherited
    // definition in non-bound children; never apply a context-global restriction.
    function maskInheritedLarkImageTool(agent) {
      if (larkImageAgentTools.has(agent) || larkImageMasks.has(agent)) return
      const tools = agent.ctx?.get?.('tools')
      const visible = tools?.get?.('lark_send_image', agent)
      if (!visible || ![...larkImageAgentTools.values()].some((entry) => entry.definition === visible)) return
      larkImageMasks.set(agent, tools.restrict({ deny: ['lark_send_image'] }))
    }
    function onLarkImageAgentCreated({ agent }) {
      const record = state.sessionToConversation[agent.session?.id]
        // Cold recovery has a durable route record but no fresh inbound cache.
        || Object.values(state.sessions).find((entry) => entry.channel === 'lark' && entry.sessionId === agent.session?.id)
      if (record?.channel === 'lark') bindLarkImageAgent(agent, record)
      try { maskInheritedLarkImageTool(agent) } catch {
        larkImageScopeFailed = true
        recordError('lark', 'image tool registration failed', 'images registration', false)
        syncLarkImagesAvailable()
      }
    }
    const larkImageLlm = {
      async resolveModelInfo(...args) {
        const binding = larkImageServices.llm
        if (!binding || larkImagesStopped) throw new Error('image model service unavailable')
        const info = await binding.service.resolveModelInfo(...args)
        if (larkImagesStopped || larkImageServices.llm !== binding) throw new Error('image model service changed')
        return info
      },
    }
    // E：真实图片操作桶 token FIFO（attempt/result 成对；匿名，无 ID/正文）。
    const larkImageOpTokens = { image_download: [], image_upload: [], image_send: [] }
    let larkImageToolClient = null
    let larkImageToolGen = -1
    const larkImageReceipts = {
      // P4/W9：receipt = 真实入站同一 store 的 kind:'send' 命名空间（异步单飞）。
      begin: async (args) => (await ensureLarkDedupStore()).sendReceipts.begin(args),
      finish: async (args) => (await ensureLarkDedupStore()).sendReceipts.finish(args),
    }
    function larkResolveImageBinding(sessionId, agent) {
      const bound = larkImageAgents.get(agent)
      const record = bound?.record
      const larkCfg = state.config && state.config.adapters && state.config.adapters.lark
      if (!currentLarkImageAgent(agent) || record.sessionId !== sessionId || !larkCfg?.appId) return null
      return {
        channel: 'lark',
        appId: String(larkCfg.appId), // R4 digest 目标身份
        alive: Boolean(state.adapters.lark), // 出站门存活（重建/停用 → false）
        conversation: record.conversation,
        interactiveCard: larkCfg.interactiveCard === true,
      }
    }
    function larkImageMakeClient() {
      if (!larkImageAxiosMod || !larkImageSdk || typeof larkImageSdk.Client !== 'function') return null
      const larkCfg = state.config && state.config.adapters && state.config.adapters.lark
      if (!larkCfg || !larkCfg.appId) return null
      try {
        if (!larkImageToolClient || larkImageToolGen !== state.channelGeneration.lark) {
          // N3 有界 transport：axios timeout(45s) ≤ 模块看门狗(60s)−1s。
          const httpInstance = larkImageAxiosMod.create({ timeout: 45000 })
          // 与 SDK defaultHttpInstance 同形的响应解包（sdk lib:196-205 实测；
          // 自定义实例必须复刻，否则 SDK 读到完整 axios 响应 → 凭据/业务误判网络错）。
          httpInstance.interceptors.response.use((resp) => (resp.config && resp.config['$return_headers'])
            ? { data: resp.data, headers: resp.headers }
            : resp.data)
          larkImageToolClient = new larkImageSdk.Client({
            appId: String(larkCfg.appId),
            appSecret: String(larkCfg.appSecret || ''),
            httpInstance,
            loggerLevel: larkImageSdk.LoggerLevel ? larkImageSdk.LoggerLevel.fatal : undefined,
          })
          larkImageToolGen = state.channelGeneration.lark
        }
        return larkImageToolClient
      } catch {
        return null // 客户端构造失败 → 工具层 no_client 拒绝，不破文本
      }
    }
    function larkImageTool() {
      if (larkImageHost) return larkImageHost.makeSendImageTool()
      const attachments = larkImageServices.attachments?.service
      if (!attachments || typeof attachments.validateImage !== 'function') return null // W8 缺权威解码不注册
      const epoch = larkImageServiceEpoch
      const imageDeps = {
        makeClient: () => epoch === larkImageServiceEpoch && !larkImagesStopped ? larkImageMakeClient() : null,
        receipts: larkImageReceipts,
        attachments,
        resolveBinding: larkResolveImageBinding,
        resolveFileTarget: async (filePath, opts) => {
          // fail-closed（Lead 裁定）：缺 exec 上下文 → 零读零上传拒绝；root 仅来自
          // 宿主真实契约 `ctx.sandboxPolicy.resolve({session})` → workspaceRoot
          //（dsh-sandbox-policy 实源：session.header.cwd，无 cwd 时回部署默认）；
          // root 经宿主 processPathFromHostPath（realpath）规范化；边界=targetKey
          //（realpath canonical）+fs.contains；无自造回退。
          const execCtx = opts && opts.exec ? opts.exec : null
          let policyRoot = null
          if (execCtx) {
            try {
              const sp = ctx.get('sandboxPolicy')
              if (sp && typeof sp.resolve === 'function') {
                const session = execCtx.agent && execCtx.agent.session ? execCtx.agent.session : undefined
                const pol = sp.resolve({ session })
                const root = pol && typeof pol.workspaceRoot === 'string' && pol.workspaceRoot ? pol.workspaceRoot : null
                if (root) {
                  // 修正：targetKey 由 fs-local 的 realpath 派生 → root 亦须 realpath
                  // 规范化（processPathFromHostPath 仅 resolve 不展开符号链接，
                  // 在 /var→/private/var 平台会造成误拒，真组合实测捕获）。
                  let canonicalRoot = null
                  try { canonicalRoot = realpathSync(root) } catch {
                    try { canonicalRoot = ctx.fs.processPathFromHostPath(root) || null } catch { canonicalRoot = null }
                    if (!canonicalRoot) canonicalRoot = resolveAbsolutePath(root)
                  }
                  policyRoot = canonicalRoot
                }
              }
            } catch { policyRoot = null }
          }
          if (!policyRoot) throw new Error('workspace policy unavailable') // 上下文不可得 = 拒绝
          const target = await ctx.fs.resolve(filePath, {
            ...(opts && opts.cwd ? { cwd: opts.cwd } : {}),
            ...(opts && opts.signal ? { signal: opts.signal } : {}), // 真 resolve 支持并校验 signal（FS_ABORTED）
          })
          if (!target) throw new Error('path not resolvable')
          const canonical = String(target.targetKey || '')
          if (!canonical) throw new Error('missing canonical target')
          let inside = null
          if (typeof ctx.fs.contains === 'function') {
            // 与宿主 contains 同源：processPath=targetKey（realpath）后 relative 判定。
            const okContains = ctx.fs.contains({ targetKey: policyRoot }, target)
            inside = okContains === true
          } else {
            const rel = pathRelative(policyRoot, canonical)
            inside = rel === '' || (!rel.startsWith('..') && !pathIsAbsolute(rel))
          }
          if (!inside) throw new Error('outside workspace policy')
          // 与 tool-fs resolveRegularReadTarget 同形：stat（含 signal）= regular file 才可读。
          if (typeof ctx.fs.stat === 'function') {
            const info = await ctx.fs.stat(target, opts && opts.signal ? opts.signal : undefined)
            if (info === undefined || info === null) throw new Error('path not found')
            if (info.type !== 'file') throw new Error('not a regular file')
          }
          return { target, displayPath: String(target.displayPath || canonical) }
        },
        // 宿主实名 API：ctx.fs.readBytes(target, signal, byteCap)（dsh-tool-fs 同源）。
        readFileBytes: async (target, opts) => ctx.fs.readBytes(target, opts && opts.signal, opts && opts.maxBytes),
        timeoutMs: 60000,
        // E：白名单遥测 → status 图片操作桶真实证据（异常不影响业务）。
        telemetry: {
          operation: (p) => diagSafe(() => {
            if (!p || typeof p.operation !== 'string') return
            const diag = larkDiag()
            if (p.event === 'attempt') {
              const token = diag.opAttempt(p.operation, {})
              if (token) (larkImageOpTokens[p.operation] || (larkImageOpTokens[p.operation] = [])).push(token)
              return
            }
            const queue = larkImageOpTokens[p.operation]
            const token = queue && queue.length ? queue.shift() : null
            if (token) {
              diag.opSettle(token, { ok: p.ok === true, status: p.httpStatus, apiCode: p.apiCode, unknown: p.unknown === true, errorText: '' })
            }
          }),
        },
      }
      if (larkImageServices.llm) {
        imageDeps.llm = larkImageLlm
        imageDeps.selectionFor = (agent) => (agent && agent.selection)
          || (ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === 'function'
            ? ctx.agentDefaultModel.currentSelection()
            : null)
      }
      larkImageHost = createLarkImageHost(imageDeps)
      return larkImageHost.makeSendImageTool()
    }
    // E：入站图片下载复用同一冻结模块 host（含 generation 化客户端；无 host → temp）。
    function larkImageHostOrNull() {
      return larkImageHost
    }
    function registerLarkImageToolOnce() {
      try {
        if (!larkImageServicesReady() || channelStatus('lark')?.state !== 'running') return
        const tool = larkImageTool()
        if (!tool) return
        for (const agent of larkImageAgents.keys()) {
          if (!currentLarkImageAgent(agent)) {
            const old = larkImageAgentTools.get(agent)
            if (old) disposeLarkImageEntry(old)
            larkImageAgentTools.delete(agent)
            larkImageAgents.delete(agent)
            continue
          }
          if (larkImageAgentTools.get(agent)?.registered) continue
          const epoch = larkImageServiceEpoch
          const bound = larkImageAgents.get(agent)
          const entry = { registered: false, dispose: null, definition: null }
          larkImageAgentTools.set(agent, entry)
          const definition = { ...tool, execute(args, exec) {
            if (exec?.agent !== agent || !currentLarkImageAgent(agent) || epoch !== larkImageServiceEpoch
              || larkImageAgents.get(agent) !== bound || larkImageAgentTools.get(agent) !== entry || !entry.registered) {
              return { ok: false, refused: true, reason: 'not_bound_to_lark' }
            }
            return tool.execute(args, exec)
          } }
          entry.definition = definition
          try {
            // get() is the supported guard-safe service lookup; it retains this
            // agent context's scope tag, unlike the optional root service proxy.
            const registered = agent.ctx.get('tools').register(definition)
            if (typeof registered === 'function') {
              entry.dispose = registered
              entry.registered = true
            } else {
              // Never adopt a late async registration after its scope retired.
              Promise.resolve(registered).then((dispose) => { if (typeof dispose === 'function') dispose() }).catch(() => {})
              throw new Error('unsupported asynchronous tool registration')
            }
          } catch {
            recordError('lark', 'image tool registration failed', 'images registration', false)
          }
        }
        larkImageScopeFailed = false
        for (const agent of ctx.agents.list()) maskInheritedLarkImageTool(agent)
      } catch {
        larkImageScopeFailed = true
        recordError('lark', 'image tool registration failed', 'images registration', false)
      } finally { syncLarkImagesAvailable() }
    }

    function diagSafe(fn) {
      try { return fn() } catch { return undefined }
    }

    // 出站 meta 里的匿名归属（{slot,turn,step}）：内部构造的 meta 直通；UI 手动
    // /send 的用户 meta 只在字段为有限数值时才采信，且只用于匿名归组。
    function diagCtxFromMeta(meta) {
      const diag = meta && typeof meta.diag === 'object' && meta.diag ? meta.diag : null
      if (!diag) return null
      const slot = Number.isInteger(diag.slot) ? diag.slot : null
      const turn = Number.isFinite(diag.turn) ? diag.turn : null
      if (slot == null || turn == null) return null
      // agent 必须随归属透传：结算水位按 Agent 弱键防复活，丢掉 agent 会让迟到
      // 出站为已结算旧回合重建记录（用户 meta 无法伪造对象 agent，只会是 null）。
      const agent = diag.agent && (typeof diag.agent === 'object' || typeof diag.agent === 'function')
        ? diag.agent
        : null
      return { slot, turn, step: Number.isFinite(diag.step) ? diag.step : null, agent }
    }

    function diagCtxFromSt(st) {
      return st && st.diagSlot != null && st.diagTurn != null
        ? { slot: st.diagSlot, turn: st.diagTurn, step: st.diagStep, gen: st.generation, agent: st.diagAgent || null }
        : null
    }

    // 操作派发/结算统一出口：token 捕获（store, generation），结算只回写原桶。
    // 旧代上下文（ctx.gen 与当前代不符，如 reload 后的 cleanup 收尾）：不写新代
    // 计数、不建新代回合——旧代证据绝不污染新代展示。
    function diagAttempt(op, ctx) {
      const d = larkDiag()
      if (ctx && Number.isInteger(ctx.gen) && ctx.gen !== d.generation) return null
      return diagSafe(() => d.opAttempt(op, ctx || null)) || null
    }

    function diagSettle(token, res) {
      if (!token) return
      diagSafe(() => token.store.opSettle(token, res))
    }

    // 结算结果组装：ok/status 取结构化字段，apiCode 只取平台数值 code，
    // unknown 与引擎未知投递语义对齐（deliveryUnknown 标记 / 无响应 raw）；
    // errorText 只供分类器瞬时判定，绝不落库。
    function diagRes(result) {
      const unknown = Boolean(result && result.deliveryUnknown === true)
        || Boolean(result && result.ok !== true && larkNoResponse(result.raw))
      return {
        ok: Boolean(result && result.ok),
        status: result && Number.isInteger(result.status) ? result.status : null,
        apiCode: result && Number.isInteger(result.apiCode) ? result.apiCode : null,
        unknown,
        errorText: result && result.error ? String(result.error) : '',
      }
    }

    // sendStreamingCard 复合结果 → create/ref 分阶段结算（各自 HTTP status/apiCode）。
    function diagSettleStages(createToken, refToken, result) {
      const stages = result && result.stages
      if (!stages) return
      const errorText = String((result && result.error) || '')
      if (stages.create) {
        diagSettle(createToken, {
          ok: stages.create.ok === true,
          status: Number.isInteger(stages.create.status) ? stages.create.status : null,
          apiCode: Number.isInteger(stages.create.apiCode) ? stages.create.apiCode : null,
          unknown: stages.create.unknown === true || (stages.create.ok !== true && larkNoResponse(result.raw)),
          errorText: stages.create.ok ? '' : errorText,
        })
      }
      if (stages.reference) {
        diagSettle(refToken, {
          ok: stages.reference.ok === true,
          status: Number.isInteger(stages.reference.status) ? stages.reference.status : null,
          apiCode: Number.isInteger(stages.reference.apiCode) ? stages.reference.apiCode : null,
          unknown: stages.reference.unknown === true || (stages.reference.ok !== true && larkNoResponse(result.raw)),
          errorText: stages.reference.ok ? '' : errorText,
        })
      }
    }

    // ── 只读 scope 查询（grant 域）：GET /application/v6/scopes ────────────
    // 官方契约（application-v6/scope/list.md）：无额外所需权限、当前应用
    // tenant_access_token、data.scopes[{scope_name, grant_status(1|2)}]；官方文档
    // 未定义分页，仍防御性处理 data.has_more/page_token（有界 LARK_SCOPE_MAX_PAGES）。
    // 每代一次 + UI 显式刷新（单飞 + 5s 限频）；任何 status GET 都不触发本查询；
    // 查询失败只记 queryState=failed+分类，保留旧 grant/checkedAt 与全部操作证据；
    // 缺 scope 不是 denied（完整枚举未见 → unknown，仅 grant_status=2 才 denied）。
    function classifyScopeReadFailure(result) {
      if (!result) return 'network'
      // scope 查询的 httpRequest 返回原结构（非包装 raw）：按真实返回形状区分
      // 返回式 timeout（curl28/timedOut）/无响应网络错/HTTP 业务错误。
      if (larkNoResponse(result)) return result.timedOut === true || result.exitCode === 28 ? 'timeout' : 'network'
      return 'http_error'
    }

    // scope 查询专用 token：**不读不写** runtime token 缓存——诊断查询绝不改变业务
    // token 的取用时序（集成回归里 auth 派发时刻是被断言的既定行为）。
    async function larkScopeToken(runtime) {
      const cfg = runtime.cfg
      const response = await httpPostJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: cfg.appId,
        app_secret: cfg.appSecret,
      })
      if (!response.ok || !response.json || !response.json.tenant_access_token) {
        throw new Error((response.json && response.json.msg) || response.stderr || ('HTTP ' + response.status))
      }
      return response.json.tenant_access_token
    }

    async function larkScopeRead(runtime, options = {}) {
      const force = options.force === true
      const d = larkDiag()
      if (!runtime || !larkRuntimeLive(runtime)) return { ok: false, error: 'adapter_not_running' }
      if (runtime.scopeReadInFlight) return { ok: false, error: 'in_flight' }
      const clockNow = Date.now()
      if (force && runtime.scopeReadLastForcedAt != null && clockNow - runtime.scopeReadLastForcedAt < LARK_SCOPE_REFRESH_MIN_MS) {
        return { ok: false, error: 'rate_limited' }
      }
      if (force) runtime.scopeReadLastForcedAt = clockNow
      runtime.scopeReadInFlight = true
      const token = diagAttempt('scope_read', null)
      d.setPermissions({ queryState: 'in_flight' })
      try {
        const accessToken = await larkScopeToken(runtime)
        let pageToken = null
        let pages = 0
        let scopeSeen = false
        let grant = 'unknown'
        let complete = false
        const scopeEntries = [] // 全部页条目（仅供图片 OR 组判定；不落库）
        while (pages < LARK_SCOPE_MAX_PAGES) {
          pages += 1
          const url = LARK_SCOPE_READ_URL + (pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '')
          const result = await larkWire(runtime)('GET', url, { Authorization: 'Bearer ' + accessToken }, {})
          if (!result || !result.ok || !result.json || result.json.code !== 0 || !result.json.data) {
            diagSettle(token, {
              ok: false,
              status: result && Number.isInteger(result.status) ? result.status : null,
              apiCode: result && result.json && Number.isInteger(result.json.code) ? result.json.code : null,
              unknown: !result || larkNoResponse(result),
              errorText: result ? String(result.error || '') : '',
            })
            d.setPermissions({ queryState: 'failed', failedCategory: classifyScopeReadFailure(result) })
            return { ok: false, error: 'scope read failed' }
          }
          const data = result.json.data
          const scopes = Array.isArray(data.scopes) ? data.scopes : null
          if (!scopes) {
            diagSettle(token, { ok: false, status: result.status, apiCode: 0, unknown: false, errorText: 'malformed scope list' })
            d.setPermissions({ queryState: 'failed', failedCategory: 'malformed' })
            return { ok: false, error: 'malformed scope list' }
          }
          for (const entry of scopes) {
            if (!entry || typeof entry.scope_name !== 'string') continue
            scopeEntries.push({ scope_name: entry.scope_name, grant_status: entry.grant_status })
            if (entry.scope_name === LARK_SCOPE_CARDKIT_WRITE) {
              scopeSeen = true
              grant = entry.grant_status === 1 ? 'granted' : entry.grant_status === 2 ? 'denied' : 'unknown'
            }
          }
          if (data.has_more === true) {
            // has_more=true 但无合法 page_token：枚举不完整，归入 malformed 分支，
            // 绝不假装完整（不猜 grant）。
            if (typeof data.page_token === 'string' && data.page_token) {
              pageToken = data.page_token
              continue
            }
            break
          }
          complete = true
          break
        }
        if (!complete) {
          // 分页有界耗尽仍 has_more：枚举不完整，不猜 grant。
          diagSettle(token, { ok: false, status: null, apiCode: null, unknown: false, errorText: 'scope list truncated' })
          d.setPermissions({ queryState: 'failed', failedCategory: 'malformed' })
          return { ok: false, error: 'scope list truncated' }
        }
        diagSettle(token, { ok: true, status: null, apiCode: 0, unknown: false, errorText: '' })
        // 图片三项权限（OR 组规则在 deriveImageScopeGrants；失败路径不回写=保留旧证据）。
        const imgCheckedAt = Date.now()
        const imageGrants = deriveImageScopeGrants(scopeEntries)
        d.setPermissions({
          grant: scopeSeen ? grant : 'unknown',
          source: 'scope_read',
          checkedAt: imgCheckedAt,
          queryState: 'ok',
          failedCategory: null,
          images: {
            upload: { grant: imageGrants.upload, source: 'scope_read', checkedAt: imgCheckedAt },
            download: { grant: imageGrants.download, source: 'scope_read', checkedAt: imgCheckedAt },
            groupHistory: { grant: imageGrants.groupHistory, source: 'scope_read', checkedAt: imgCheckedAt },
          },
        })
        return { ok: true }
      } catch (error) {
        diagSettle(token, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
        const category = error && /timed? ?out|timeout/i.test(String((error && error.message) || '')) ? 'timeout' : 'network'
        d.setPermissions({ queryState: 'failed', failedCategory: category })
        return { ok: false, error: 'scope read failed' }
      } finally {
        runtime.scopeReadInFlight = false
      }
    }

    function larkRuntimeLive(runtime) {
      return Boolean(runtime) && state.larkRuntime === runtime
        && state.channelGeneration.lark === runtime.generation
        && Boolean(state.adapters.lark)
    }

    function larkStaleError() {
      const error = new Error('lark adapter reloaded; stale outbound dropped')
      error.name = 'StaleAdapterError'
      return error
    }

    function assertLarkRuntimeLive(runtime) {
      if (!larkRuntimeLive(runtime)) throw larkStaleError()
    }

    // 模块注入契约的 JSON wrapper：对象 payload → 字符串 wire body + Content-Type。
    // options.cleanup=true（旧代际收卡专用通路）时跳过 live 断言：只用捕获的旧
    // cfg/token/已知 ID 派发收尾，绝不碰新配置。
    function larkWire(runtime, options = {}) {
      return (method, url, headers, payload) => {
        if (options.cleanup !== true) assertLarkRuntimeLive(runtime)
        const merged = Object.assign({}, headers, { 'Content-Type': 'application/json; charset=utf-8' })
        return httpRequest(method, url, merged, JSON.stringify(payload))
      }
    }

    function larkConversationFor(sessionId) {
      const record = state.sessionToConversation[sessionId]
      if (!record || record.channel !== 'lark') return null
      return record.conversation
    }

    // 收尾摘要：单行化 + 50 字符（与官方 SDK truncateSummary 同口径）；
    // 截断点避开代理对，绝不把半个 emoji 写进 summary。
    function larkSummary(text) {
      const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
      if (!cleaned) return undefined
      if (cleaned.length <= 50) return cleaned
      let cut = cleaned.slice(0, 49)
      const lastCode = cut.charCodeAt(cut.length - 1)
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1)
      return cut + '…'
    }

    // 手动 well-formed 校验（不依赖较新 API）：high 必须紧跟 low，low 必须前邻 high。
    // 非实时/手动路径一律先校验、明确失败，绝不 normalize 后静默发 200。
    function larkWellFormed(str) {
      for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN
          if (!(next >= 0xdc00 && next <= 0xdfff)) return false
          i += 1
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return false
        }
      }
      return true
    }

    // 无确定 HTTP 响应的 curl 结果：请求可能已送达（超时/中止/无状态码）
    // → 不能当确定失败重发，必须 deliveryUnknown。连接建立前的本地失败
    //（DNS exitCode 6 / 拒绝 7 / 关闭 5，未超时）有确定结论，可有限补试。
    function larkNoResponse(raw) {
      if (!raw || typeof raw !== 'object') return false
      if (raw.timedOut === true || raw.aborted === true) return true
      if (raw.exitCode === 28) return true // CURLE_OPERATION_TIMEDOUT
      if (raw.status === 0 && raw.json == null && raw.ok !== true) {
        return raw.exitCode !== 5 && raw.exitCode !== 6 && raw.exitCode !== 7
      }
      return false
    }

    function larkHttpResult(response) {
      const result = {
        ok: Boolean(response && response.ok && response.json && response.json.code === 0),
        status: response ? response.status : 0,
        // 诊断用：只提取平台**数值** code（整数才保留），不透出 raw body/原始文本。
        apiCode: response && response.json && Number.isInteger(response.json.code) ? response.json.code : null,
        error: (response && response.json && response.json.msg)
          || (response && response.stderr)
          || (response && !response.ok ? 'HTTP ' + response.status : null),
      }
      if (larkNoResponse(response)) {
        // 返回式 timeout/无响应（真实 shell 通常是结构化结果而非 throw）：
        // 透传 deliveryUnknown，后续正文重发永久停止。
        result.deliveryUnknown = true
        result.error = (result.error || 'no response') + ' (no response, delivery unknown)'
      }
      return result
    }

    // 纯本地校验/预算错误（well-formed、splitter 切分等）是**确定性本地失败**：
    // 绝不标 deliveryUnknown（只有已真实派发且无确定响应才未知），否则会把合法
    // 后续批次永久吞掉。
    function larkLocalFailure(error) {
      const e = error instanceof Error ? error : new Error(String(error))
      if (e.name !== 'StaleAdapterError' && !e.deliveryUnknown && !e.deliveryKnown) e.deliveryKnown = true
      return e
    }

    function larkSplitForText(text) {
      try {
        return splitLarkText(String(text || ''), {
          maxLength: LARK_TEXT_MESSAGE_MAX_CHARS,
          maxBytes: LARK_TEXT_CONTENT_MAX_BYTES,
          measure: larkJsonBytes,
        })
      } catch (error) {
        throw larkLocalFailure(error)
      }
    }

    function larkSplitForStaticCard(text) {
      try {
        return splitLarkText(String(text || ''), {
          maxLength: LARK_TEXT_MESSAGE_MAX_CHARS,
          maxBytes: LARK_STATIC_CARD_CONTENT_MAX_BYTES,
          measure: larkJsonBytes,
        })
      } catch (error) {
        throw larkLocalFailure(error)
      }
    }

    // ── live 卡体预算（官方一手，HTTP200，见主报告19:30/19:55 与 test/official-scope-sources.md）──
    // 发送消息官方.md L46/L206：text 请求体 150KB、卡片/富文本请求体 30KB；
    // CardKit content.md L52：新全量 content 1~100000 字符（官方字符限，独立守卫）；
    // create/content/settings 官方条款200860 "Card content exceeds limit" 要求/建议
    // 卡片大小 30KB 以内。live 卡不能只按本地 30000 字符阈值切：
    // `createStreamingCard('中'.repeat(30000))` 卡 JSON 90345B / 创建 wire 90425B ≫ 30720B。
    // 统一最安全 30KB：度量**最坏收尾终态**的创建 wire（type/data 包裹 + data 内
    // JSON 再转义）。close PATCH 会把 config.summary 替换为 larkSummary(lastText)
    //（单行 ≤50 UTF16 码元，+「…」），其 JSON 每码元最坏 6B（控制符 \uXXXX）+ 引号
    // =302B 上界（比默认 summary 更大，实测饱和 CJK 下终态会反超预算）；用**固定
    // 保守样本**预留（不按实际文本动态截尾，保持 splitter 码点前缀单调的 measure
    // 契约），使 streaming 与 close 后任何终态（真实 summary、streaming_mode:false、
    // 其余 config 原样合并）都不超预算。固定预留不随 content 变化 → 仍单调。
    const LARK_WORST_SUMMARY_JSON_SAMPLE = '\u0001'.repeat(50) // JSON.stringify → 2+50×6=302B 上界

    // 最坏收尾终态：close settings 合并原 config 后的卡片（summary 被替换为最坏
    // 50 码元样本、streaming_mode:false，其余字段原样保留）。
    function larkCardWorstTerminal(content) {
      const card = createStreamingCard(content)
      return {
        ...card,
        config: {
          ...card.config,
          streaming_mode: false,
          summary: { content: LARK_WORST_SUMMARY_JSON_SAMPLE },
        },
      }
    }

    function larkCardWireMeasure(content) {
      return Buffer.byteLength(
        JSON.stringify({ type: 'card_json', data: JSON.stringify(larkCardWorstTerminal(content)) }),
        'utf8',
      )
    }

    // live 快照超预算判定：本地/SDK 保守 30000 字符阈值（官方 content 字段限 100000）
    // + 最坏终态完整创建 wire ≤ 本地 30KiB 双重闸。
    function larkSnapshotOverBudget(content) {
      if (content.length > LARK_CARDKIT_MAX_ELEMENT_CHARS) return true
      return larkCardWireMeasure(content) > LARK_IM_BODY_MAX_BYTES
    }

    // live 分段（seed / rollover head）：用已验收 splitter 的 measure 在**最坏收尾
    // 终态完整创建 wire 字节**上切分（含全部字段、summary 预留与真实转义），叠加
    // 本地 30000 字符保守阈值取更严；单字符超预算时 splitter 明确 RangeError，绝不截断。
    function larkSplitForCardBody(text) {
      return splitLarkText(String(text || ''), {
        maxLength: LARK_CARDKIT_MAX_ELEMENT_CHARS,
        maxBytes: LARK_IM_BODY_MAX_BYTES,
        measure: larkCardWireMeasure,
      })
    }

    // 时钟：每次现取，测试可经 ctx.get('dshMessaging.larkClock') 注入 fake clock。
    function larkClock() {
      try {
        const injected = ctx.get && ctx.get('dshMessaging.larkClock')
        if (injected && typeof injected.now === 'function'
          && typeof injected.setTimeout === 'function' && typeof injected.clearTimeout === 'function') {
          return injected
        }
      } catch {
        /* 生产环境无此测试钩子 */
      }
      return realLarkClock
    }

    // attempt 身份：有 attemptId 用它；虚拟（非流式）attempt 用 turn:step。
    function larkAttemptKey(payload) {
      if (payload && payload.attemptId != null && payload.attemptId !== '') return 'a:' + String(payload.attemptId)
      return 'v:' + String(payload && payload.turn) + ':' + String(payload && payload.step)
    }

    // Agent 对象 → attempt 状态（卡片/游标/timer/代理对缓存/已送达前缀）：
    // 按真实 Agent 对象 + attempt 隔离，不同 Agent 同 sessionId 绝不共享。
    function larkAttemptState(runtime, agent, payload) {
      if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) {
        throw new Error('lark: attempt state requires the real Agent object identity')
      }
      let states = state.larkAttemptStates.get(agent)
      if (!states) {
        states = new Map()
        state.larkAttemptStates.set(agent, states)
      }
      const key = larkAttemptKey(payload)
      let entry = states.get(key)
      if (!entry) {
        entry = {
          card: null,
          cursor: 0,
          timer: null,
          timerClock: null,
          surrogate: '',
          prefix: '',
          transport: null,
          everOpened: false,
          // 匿名诊断归属：Agent 槽位 + host turn/step（回调 payload 提供）；
          // diagAgent 仅存于 attempt 生命周期（dispose/重建即清），供结算水位弱键。
          diagSlot: diagSafe(() => larkDiag().slotOf(agent)) ?? null,
          diagAgent: agent,
          diagTurn: payload && Number.isFinite(payload.turn) ? payload.turn : null,
          diagStep: payload && Number.isFinite(payload.step) ? payload.step : null,
          generation: runtime ? runtime.generation : null,
        }
        states.set(key, entry)
      } else if (runtime && entry.generation != null && entry.generation !== runtime.generation) {
        // 键含适配器 generation：旧代代的 attempt 状态不得跨代复用（进度/卡失效）。
        const stale = new Error('lark adapter reloaded; stale attempt state dropped')
        stale.name = 'StaleAdapterError'
        throw stale
      }
      return entry
    }

    // engine 的 delta 是 target.slice(sent) 尾巴（实时可能缓冲尾部高代理）：
    // 反推 tail 在 target 中的起始 offset。
    // 本批 tail 在 target（原始累计全文）中的**安全投递窗口** [start, end)：
    // 先按严格后缀/尾部高代理缓冲位对齐，兜底 lastIndexOf；对不上返回 null
    //（调用方只投已验证的 tail 本体，不动前缀）。窗口内容 === tail（合法），
    // 原始 target 里被引擎缓冲/扣留的半代理对与非法余段绝不进 splitter。
    function larkTailWindow(target, tail) {
      if (!tail) return null
      if (target.endsWith(tail)) return [target.length - tail.length, target.length]
      const near = target.length - tail.length - 1 // 尾部被缓冲 1 个高代理
      if (near >= 0 && target.slice(near, near + tail.length) === tail) return [near, near + tail.length]
      const idx = target.lastIndexOf(tail)
      if (idx >= 0) return [idx, idx + tail.length]
      return null
    }

    // 明确失败（已收到确定的 API 拒绝）：引擎可按有限上限显式补试。
    function larkFail(message) {
      const error = new Error(message || 'lark outbound failed')
      error.deliveryKnown = true
      return error
    }

    // 网络层抛错（无响应，投递可能已发生）：标记投递未知，引擎据此禁止盲目重发；
    // StaleAdapterError 是派发前拦截（肯定未发出），保持确定失败。
    function larkUnknown(error) {
      if (error instanceof Error && (error.name === 'StaleAdapterError' || error.deliveryKnown || error.deliveryUnknown)) return error
      if (error instanceof Error) error.deliveryUnknown = true
      return error
    }

    // 结构化失败结果 → 带投递语义的错误：无响应/超时 → deliveryUnknown（禁重发），
    // 其余 → deliveryKnown（有限补试）。
    function larkResultError(result, fallback) {
      const error = new Error((result && result.error) || fallback || 'lark outbound failed')
      if (result && (result.deliveryUnknown === true || larkNoResponse(result.raw))) {
        error.deliveryUnknown = true
      } else {
        error.deliveryKnown = true
      }
      return error
    }

    // token 请求不携带正文：失败可确定重试（保留因果，不伪造送达失败）。
    async function larkTokenFor(runtime) {
      try {
        return await larkAccessToken(runtime) // 按 runtime 隔离缓存，写入不跨代
      } catch (error) {
        if (error instanceof Error) error.deliveryKnown = true
        throw error
      }
    }

    // interactiveCard 开启时的静态出站（非流式最终文本 / 错误提示 / 手动发送）：
    // 每段一张完整 JSON2.0 静态卡，超预算先分段，正文不丢不截。
    // 该函数供 adapter.sendText 使用（legacy 缓冲/UI 手动发送无自动重试）；
    // 流式路径的分段+前缀进度在 larkDeliverSegments，这里是纯分段发送循环。
    async function larkSendStaticCards(runtime, target, token, text, diagCtx = null) {
      const segments = larkSplitForStaticCard(text)
      let last = null
      for (const segment of segments) {
        assertLarkRuntimeLive(runtime)
        const sendToken = diagAttempt('static_interactive', diagCtx)
        let result
        try {
          result = await sendInteractiveCardDirect({
            conversation: target,
            cardSpec: createTextSegmentCard(segment),
            accessToken: token,
            httpRequest: larkWire(runtime),
          })
        } catch (error) {
          diagSettle(sendToken, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
          throw error // 网络层 reject 原样上抛（larkUnknown 标未知投递）
        }
        diagSettle(sendToken, diagRes(result))
        if (!result.ok) {
          return {
            ok: false,
            status: result.status,
            error: result.error,
            deliveryUnknown: result.deliveryUnknown === true || larkNoResponse(result.raw) || undefined,
          }
        }
        last = result
      }
      return { ok: true, status: last ? last.status : 0, error: null, messageId: last ? last.messageId : null }
    }

    // ── 流式路径的分段投递（Agent+attempt 前缀进度）──────────────────────
    // 引擎失败不推进 sent/published；适配层按 (Agent 对象, attempt) 记录**已成功
    // 投递的目标正文前缀**：目标增长（实时 delta 后更长 final）时从已送达前缀
    // 继续，绝不重发首段；正文身份只用前缀对齐，不依赖本次 delta 全文相等。
    async function larkDeliverSegments({ runtime, agent, payload, conversation, target, tail, kind, reason }) {
      const st = larkAttemptState(runtime, agent, payload)
      // 安全投递窗口 = 本批 tail 在 target 中的绝对区间；tail 是引擎 sanitize/
      // 缓冲后的合法正文（入口已再校验），原始 target 只用于前缀对齐——
      // 被缓冲/扣留的半代理对与非法余段绝不重新进入 splitter（P1-1）。
      const win = tail ? larkTailWindow(target, tail) : null
      const windowStart = win ? win[0] : Math.max(0, target.length - String(tail || '').length)
      const windowEnd = win ? win[1] : target.length
      const prefix = typeof st.prefix === 'string' ? st.prefix : ''
      let from = windowStart
      let aligned = Boolean(win)
      if (prefix && target.startsWith(prefix)) {
        if (prefix.length >= windowEnd) return // 窗口已全部送达 → 不再发，也不算失败
        if (prefix.length > windowStart) from = prefix.length // 目标增长后从已确认前缀续发
      } else if (prefix) {
        st.prefix = '' // 正文分歧（非增长）：放弃旧前缀，按窗口起点走
      }
      if (from >= windowEnd) return
      const deliverable = win ? target.slice(from, windowEnd) : String(tail || '')
      // 双保险：可投递正文必须 well-formed；此类**纯局部校验**按确定失败，
      // 绝不标 deliveryUnknown（否则合法后续批次会被永久吞掉）。
      if (!larkWellFormed(deliverable)) {
        diagSafe(() => larkDiag().noteLocalRefusal('malformed', Date.now()))
        const error = new Error('lark adapter: unsafe deliverable range refused (malformed UTF-16); not sent, not marked unknown')
        error.deliveryKnown = true
        throw error
      }
      const segments = kind === 'static' ? larkSplitForStaticCard(deliverable) : larkSplitForText(deliverable)
      let sent = 0
      for (const segment of segments) {
        assertLarkRuntimeLive(runtime)
        let result
        try {
          result = await sendOutbound('lark', conversation, segment, {
            sessionId: payload.sessionId,
            reason: reason || null,
            // 匿名诊断归属：分段静态/text 出站归回原 Agent+turn（仅内部构造可信）。
            diag: diagCtxFromSt(st),
          })
        } catch (error) {
          if (aligned) st.prefix = target.slice(0, from + sent) // 已成功段记成功，不转成未知失败
          throw error
        }
        if (!result || result.ok === false) {
          if (aligned) st.prefix = target.slice(0, from + sent) // 部分成功：补试只发剩余段
          throw larkResultError(result, 'lark segment send failed')
        }
        sent += segment.length
        if (aligned) st.prefix = target.slice(0, from + sent)
      }
    }

    // text 模式实时增量：delta 是「未发送尾部」。跨批次缓存未完整代理对（先缓存补全
    // 再发）；最终结算仍不完整、或正文含孤立代理 → 明确报错收尾（引擎有限补试后正常
    // 收卡），绝不静默丢、也绝不把坏文本交给 splitter。
    async function larkSendTextDelta(payload, agent) {
      try {
        const runtime = state.larkRuntime
        assertLarkRuntimeLive(runtime)
        const conversation = larkConversationFor(payload.sessionId)
        if (!conversation) throw new Error('lark session is not bound: ' + payload.sessionId)
        const st = larkAttemptState(runtime, agent, payload)
        let text = String(st.surrogate || '') + String(payload.delta || '')
        const lastCode = text.length ? text.charCodeAt(text.length - 1) : NaN
        const trailingHigh = lastCode >= 0xd800 && lastCode <= 0xdbff
        if (trailingHigh && payload.reason === 'final') {
          // 最终仍缺低代理：明确失败，不静默丢这半个字符；引擎按有限补试后收卡。
          st.surrogate = ''
          const malformed = new Error('lark adapter: final text ends with an unpaired UTF-16 high surrogate (malformed); refusing to deliver or silently drop')
          malformed.deliveryKnown = true
          throw malformed
        }
        if (trailingHigh) {
          st.surrogate = text.slice(-1) // 跨批次先缓存，补全再发
          text = text.slice(0, -1)
        } else {
          st.surrogate = ''
        }
        if (!text) return
        if (!larkWellFormed(text)) {
          const malformed = new Error('lark adapter: malformed text (lone UTF-16 surrogate) refused before splitter')
          malformed.deliveryKnown = true
          throw malformed
        }
        const target = typeof payload.text === 'string' && payload.text ? payload.text : text
        await larkDeliverSegments({
          runtime,
          agent,
          payload,
          conversation,
          target,
          tail: text,
          kind: 'text',
          reason: payload.reason,
        })
      } catch (error) {
        throw larkUnknown(error)
      }
    }

    // ── card 模式：CardKit 实体生命周期（开卡 / 累计 PUT / 滚动换卡 / 收尾）──
    async function larkOpenCard(runtime, conversation, seedText, st) {
      // 创建 wire 预算硬门：完整 schema 卡 JSON + 包裹/转义 overhead ≤ 本地 30KB
      //（对应官方200860 卡体 30KB 条款）；超限明确失败，不截断、不静默删正文。
      const seedWireBytes = larkCardWireMeasure(seedText)
      if (seedWireBytes > LARK_IM_BODY_MAX_BYTES) {
        diagSafe(() => larkDiag().noteLocalRefusal('budget_exceeded', Date.now()))
        throw larkFail(
          'live card create wire exceeds 30KB card budget: ' + seedWireBytes + ' > '
          + LARK_IM_BODY_MAX_BYTES + ' bytes (refusing, no truncation)'
        )
      }
      assertLarkRuntimeLive(runtime)
      const token = await larkTokenFor(runtime)
      assertLarkRuntimeLive(runtime)
      const diagCtx = diagCtxFromSt(st)
      const createToken = diagAttempt('card_create', diagCtx)
      let refToken = null
      const stageRes = (outcome) => ({
        ok: outcome.ok === true,
        status: Number.isInteger(outcome.status) ? outcome.status : null,
        apiCode: Number.isInteger(outcome.apiCode) ? outcome.apiCode : null,
        // 返回式无响应（curl28/timedOut 等）与引擎未知投递语义对齐。
        unknown: outcome.unknown === true || (outcome.ok !== true && larkNoResponse(outcome.raw)),
        errorText: outcome.ok === true ? '' : String(outcome.error || ''),
      })
      const result = await sendStreamingCard({
        conversation,
        text: seedText,
        accessToken: token,
        httpRequest: larkWire(runtime),
        onAttempt: (stage) => {
          if (stage === 'card_reference') refToken = diagAttempt('card_reference', diagCtx)
        },
        // 阶段 ACK 钩子：create/reference 在**各自实际返回时**结算（真实 ACK 时刻，
        // 不等复合调用结束；create 不算用户可见发送，firstDeliveryAck 仍归 ref）。
        onStage: (stage, outcome) => {
          if (stage === 'card_create') diagSettle(createToken, stageRes(outcome))
          else if (stage === 'card_reference') diagSettle(refToken, stageRes(outcome))
        },
      })
      diagSettleStages(createToken, refToken, result) // 兜底（token.settled 保证只结算一次）
      if (!result.ok) {
        if (result.cardId) {
          // 已知实体（create 在途 reload / send 失败）→ **立即走 cleanup 专用通路**
          // 收尾（捕获旧 cfg/token/已知 ID、跳过 live 断言）：绝不遗留
          // create1/ref0/close0，也不建第二卡（P1-3）。
          const cleanupToken = diagAttempt('card_close', diagCtx)
          try {
            const closeResult = await finishStreamingCard({
              cardId: result.cardId,
              sequence: 1,
              summary: larkSummary(seedText),
              accessToken: token, // 旧 runtime 自有 token（按代隔离，不碰新缓存）
              httpRequest: larkWire(runtime, { cleanup: true }),
            })
            diagSettle(cleanupToken, diagRes(closeResult))
          } catch (error) {
            diagSettle(cleanupToken, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
            // 收尾失败只记录；实体还有 10 分钟自动关闭兑底。
          }
        }
        // 资源先收尾，再报 generation 失效 / 无响应未知 / 确定拒绝。
        if (!larkRuntimeLive(runtime)) throw larkStaleError()
        throw larkResultError(result, 'open streaming card failed')
      }
      if (!larkRuntimeLive(runtime)) {
        // 成功但 runtime 已失效（create/reference 在途跨 reload，含 5s 有界清理后
        // owner/attempt 表与 larkClosing 均已被删除）：与已知 ID 失败分支同策略——
        // 用**捕获的旧 token + 旧 runtime 的 cleanup 通路**直接幂等关闭已知实体，
        // 再抛 stale；不依赖已清 owner、当前 runtime 或 larkClosing（P1 late-success）。
        if (result.cardId) {
          const staleCleanupToken = diagAttempt('card_close', diagCtx)
          try {
            const closeResult = await finishStreamingCard({
              cardId: result.cardId,
              sequence: 1,
              summary: larkSummary(seedText),
              accessToken: token, // 旧 runtime 自有 token（按代隔离）
              httpRequest: larkWire(runtime, { cleanup: true }),
            })
            diagSettle(staleCleanupToken, diagRes(closeResult))
          } catch (error) {
            diagSettle(staleCleanupToken, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
            // 关闭失败：平台 10 分钟自动关闭兑底；不重试、不重发。
          }
        }
        throw larkStaleError()
      }
      const card = {
        cardId: result.cardId,
        messageId: result.messageId,
        sequence: 0,
        createdAt: larkClock().now(),
        lastText: seedText,
      }
      // 活跃路径：注册到 attempt 状态（快照/收卡/到期 timer 均以它为准）；
      // 失效路径已在上方直接 cleanup 关闭，不依赖 owner 表。
      if (st) {
        st.card = card
        st.everOpened = true
      }
      assertLarkRuntimeLive(runtime)
      return card
    }

    async function larkCloseCard(runtime, card, options = {}) {
      const cleanup = options.cleanup === true
      if (!cleanup) assertLarkRuntimeLive(runtime)
      const token = await larkTokenFor(runtime)
      if (!cleanup) assertLarkRuntimeLive(runtime)
      const closeToken = diagAttempt('card_close', diagCtxFromMeta(options) || diagCtxFromSt(options.st) || null)
      let result
      try {
        result = await finishStreamingCard({
          cardId: card.cardId,
          sequence: card.sequence + 1,
          summary: larkSummary(card.lastText),
          accessToken: token,
          httpRequest: larkWire(runtime, { cleanup }),
        })
      } catch (error) {
        diagSettle(closeToken, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
        throw error
      }
      card.sequence += 1
      diagSettle(closeToken, diagRes(result))
      if (!result.ok) throw larkResultError(result, 'finish streaming card failed')
    }

    function larkClearTimer(st) {
      if (st.timer != null && st.timerClock) {
        try {
          st.timerClock.clearTimeout(st.timer)
        } catch {
          // 已触发或句柄失效：忽略。
        }
      }
      st.timer = null
      st.timerClock = null
    }

    // 到期收尾（**原始逻辑**，只能在同 attempt 传输串行链内执行）：绝不再对
    // （可能已被平台关闭的）旧卡 PUT/pin——捕获 card 引用、只关卡、推进游标，
    // 后续正文在新卡上续写（旧卡展示到 lastText，不重不丢）。
    async function larkExpireCardRaw(runtime, st) {
      const card = st.card
      if (!card) return
      st.card = null
      larkClearTimer(st)
      st.cursor += String(card.lastText || '').length
      const live = state.larkRuntime === runtime
      try {
        await larkCloseCard(runtime, card, { cleanup: !live, st }) // 捕获的 card：seq 严格下一个
      } catch (error) {
        recordError('lark', error, 'streaming card expiry close', false)
      }
    }

    // 9 分钟（早于官方 10 分钟自动关闭）主动 timer 定格收尾；publish 里另有
    // 10 分钟到期检查兑底（timer 错过也绝不再 PUT 旧卡）。卡正常关闭时清理 timer。
    // timer 回调**不直接改 st.card**：进入同 attempt 传输串行链，等在途 PUT
    // 结果落定（seq++/lastText）后再收卡，close 序号严格下一个（P1-2）。
    function larkScheduleExpiry(runtime, st) {
      larkClearTimer(st)
      const clock = larkClock()
      st.timer = clock.setTimeout(() => {
        st.timer = null
        st.timerClock = null
        if (!st.card) return
        void larkEnqueue(st, () => larkExpireCardRaw(runtime, st)).catch(() => {}) // 内部已记录错误
      }, LARK_CARD_WINDOW_MS)
      st.timerClock = clock
    }

    // 同 attempt 的**传输串行链**：正文发布 / 到期收尾 / 最终收卡全部排队，
    // 任何 await 期间不会有另一个操作抢改 st.card 与 sequence（P1-2）。
    function larkEnqueue(st, task) {
      const run = () => task()
      const next = st.transport ? st.transport.then(run, run) : Promise.resolve().then(run)
      st.transport = next
      return next
    }

    // 换卡切点：在**最坏收尾终态完整创建 wire ≤30KB**（含 summary 预留与全部字段
    // 转义）+ 本地 30000 字符保守阈值双重预算上用已验收 splitter 切；返回 null =
    // 正文推进不了，不硬切。（时间窗到期不走这里：由 larkExpireCardRaw 关旧卡。）
    function larkRolloverHead(remaining) {
      const head = larkSplitForCardBody(remaining)[0]
      return head && head.length < remaining.length ? head : null
    }

    // 累计快照发布：每张卡的 content = text.slice(cursor)；**任何 PUT/pin 之前先检查
    // 到期**（官方 10 分钟窗口：先关旧卡、绝不再 PUT 旧卡），再看超本地 30000 字符阈值/
    // 终态预算滚动，最后才开新卡/发正文（游标前进，正文不丢不重）。
    async function larkPublishCardSnapshot(payload, agent) {
      try {
        await publishCardSnapshotImpl(payload, agent)
      } catch (error) {
        throw larkUnknown(error)
      }
    }

    async function publishCardSnapshotImpl(payload, agent) {
      const runtime = state.larkRuntime
      assertLarkRuntimeLive(runtime)
      const sessionId = payload.sessionId
      const conversation = larkConversationFor(sessionId)
      if (!conversation) throw new Error('lark session is not bound: ' + sessionId)
      const text = String(payload.text || '')
      if (!larkWellFormed(text)) {
        const malformed = new Error('lark adapter: malformed card snapshot (lone UTF-16 surrogate) refused')
        malformed.deliveryKnown = true
        throw malformed
      }
      const st = larkAttemptState(runtime, agent, payload)
      // 非流式最终文本且本 attempt 从未开过卡 → 静态 interactive 卡（分段 +
      // Agent/attempt 前缀进度，与错误提示同路）；开过卡（含到期关的）则走卡片
      // 路径续写，绝不重复发整段静态卡。
      if (payload.source === 'final' && !st.everOpened) {
        // 静态兜底被使用：原因只按当时已记录证据推导（无证据保持 unknown/null）。
        diagSafe(() => larkDiag().noteStaticFinal(st.diagSlot, st.diagTurn, Date.now(), st.diagAgent || null))
        await larkDeliverSegments({
          runtime, agent, payload, conversation,
          target: text, tail: text, kind: 'static', reason: 'final',
        })
        return
      }
      // 卡片正文操作整体进入**同 attempt 传输串行链**：与到期 timer / 收卡互斥，
      // PUT await 期间不会被任何并发操作抢改 st.card/sequence（P1-2）。
      await larkEnqueue(st, () => publishCardBody(runtime, conversation, text, st))
    }

    async function publishCardBody(runtime, conversation, text, st) {
      const clock = larkClock()
      for (;;) {
        // ① 到期优先于任何 PUT/pin：过期卡不再接受正文，先关旧再建新。
        if (st.card && clock.now() - st.card.createdAt >= LARK_CARD_EXPIRY_MS) {
          await larkExpireCardRaw(runtime, st) // 链内直调原始逻辑，不重入队
          continue
        }
        const snapshot = text.slice(st.cursor)
        // 超预算（本地 30000 字符保守阈值 或 最坏终态完整 wire >30KB）→ 先滚动换卡，
        // 绝不把超预算快照 PUT 出去（P2：live 卡体30KB预算）。
        if (st.card && larkSnapshotOverBudget(snapshot)) {
          const card = st.card // 捕获 card 身份：await 前后只操作它，不读被替换引用
          const head = larkRolloverHead(snapshot)
          if (!head) break
          assertLarkRuntimeLive(runtime)
          const token = await larkTokenFor(runtime)
          assertLarkRuntimeLive(runtime)
          const putToken = diagAttempt('card_put', diagCtxFromSt(st))
          let pinned
          try {
            pinned = await updateCardElementContent({
              cardId: card.cardId,
              elementId: STREAMING_ELEMENT_ID,
              content: head,
              sequence: card.sequence + 1,
              accessToken: token,
              httpRequest: larkWire(runtime),
            })
          } catch (error) {
            diagSettle(putToken, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
            throw error
          }
          diagSettle(putToken, diagRes(pinned))
          card.sequence += 1
          card.lastText = head
          if (!pinned.ok) throw larkResultError(pinned, 'pin rollover head failed')
          await larkCloseCard(runtime, card, { st }) // 旧卡定格在 head，再开新卡（seq 严格下一个）
          larkClearTimer(st)
          if (st.card === card) st.card = null
          st.cursor += head.length
          continue
        }
        if (!st.card) {
          const seed = larkSplitForCardBody(text.slice(st.cursor))[0] || '' // seed 即满足完整卡体预算
          st.card = await larkOpenCard(runtime, conversation, seed, st)
          st.everOpened = true
          larkScheduleExpiry(runtime, st)
          continue // 回到循环头重新判定（首卡种子也可能仍超预算 → 继续滚动）
        }
        break
      }
      const card = st.card
      if (!card) return
      const content = text.slice(st.cursor)
      if (!content || content === card.lastText) return // 开卡内容已带 / 无新内容：不重复 PUT
      // 防御闸：PUT 前重建完整卡 JSON 再验一次 30KB 预算（滚动判定万一漏网时
      // 明确失败而不是发超预算卡体；不截断）。
      if (larkSnapshotOverBudget(content)) {
        diagSafe(() => larkDiag().noteLocalRefusal('budget_exceeded', Date.now()))
        throw larkFail(
          'live card snapshot exceeds the 30KB card-body budget: ' + larkCardWireMeasure(content)
          + ' > ' + LARK_IM_BODY_MAX_BYTES + ' bytes (rollover should have split; refusing, no truncation)'
        )
      }
      assertLarkRuntimeLive(runtime)
      const token = await larkTokenFor(runtime)
      assertLarkRuntimeLive(runtime)
      const putToken = diagAttempt('card_put', diagCtxFromSt(st))
      let result
      try {
        result = await updateCardElementContent({
          cardId: card.cardId,
          elementId: STREAMING_ELEMENT_ID,
          content,
          sequence: card.sequence + 1,
          accessToken: token,
          httpRequest: larkWire(runtime),
        })
      } catch (error) {
        diagSettle(putToken, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
        throw error
      }
      diagSettle(putToken, diagRes(result))
      // 成功响应后写回**捕获的 card**：即使 st.card 已被替换也不读空引用、
      // 不把本地 TypeError 伪装成未知投递（P1-2）。
      if (!result.ok) throw larkResultError(result, 'card element update failed')
      card.sequence += 1
      card.lastText = content
    }

    // 纯收卡信号（end/abort/dispose/turn 结算，每张 attempt 至多一次）：
    // 按 **Agent 对象 + attempt 身份**只收自己的卡（旧 A 的 end 绝不收 B 的卡）；
    // 从未开卡 → no-op；渠道已停（reload/卸载）→ 走 larkClosing 独立 cleanup 通路。
    async function larkFinishCard(payload, agent) {
      const runtime = state.larkRuntime
      const active = runtime || state.larkClosing
      const states = agent && (typeof agent === 'object' || typeof agent === 'function')
        ? state.larkAttemptStates.get(agent)
        : null
      const key = larkAttemptKey(payload)
      const st = states ? states.get(key) : null
      if (states) states.delete(key)
      if (!st) return
      larkClearTimer(st)
      if (!st.card) return // 从未开卡（静态/纯文本）→ 收卡 no-op
      if (!active) return // 渠道已停且无 closing 上下文：交 10 分钟自动关闭兑底
      // 纯收卡无正文：summary 取自本 attempt 自己累计的 lastText；
      // 进入同 attempt 传输串行链——若到期 timer/在途 PUT 排在前面，先等其落定，
      // 保证 close 序号严格接在已成功 PUT 之后且只收一次（P1-2）。
      return larkEnqueue(st, async () => {
        if (!st.card) return // 前序任务（如到期收尾）已关 → 幂等 no-op
        await larkCloseCard(active, st.card, { cleanup: !runtime, st })
      })
    }

    // hub：按 (Agent 对象, sessionId) 分桶隔离；mode 在建流时取当前 interactiveCard。
    // 回调绑定**真实 Agent 对象**（options.agent）：卡片/前缀进度/代理对缓存按
    // Agent+attempt 隔离，同 sessionId 的不同 Agent 对象绝不共享网络对象状态。
    const larkStreams = createLarkStreamHub({
      create: (options) => {
        // 每个流绑定匿名槽位与创建时的诊断 store（代隔离）：迟到帧只落原代。
        const diag = larkDiag()
        const slot = diag.slotOf(options.agent)
        return createLarkStream({
          ...options,
          mode: larkOutputMode(),
          throttleMs: LARK_STREAM_THROTTLE_MS,
          telemetry: (kind, detail) => diagSafe(() => diag.noteTelemetry(kind, detail, slot, undefined, options.agent)),
          onError: (error, info) => recordError('lark', error, 'assistant stream (' + (info && info.sessionId) + ')', false),
          sendTextDelta: (payload) => larkSendTextDelta(payload, options.agent),
          updateCardText: (payload) => larkPublishCardSnapshot(payload, options.agent),
          finishCard: (payload) => larkFinishCard(payload, options.agent),
        })
      },
    })

    // 全局实时帧入口：仅已绑定的飞书会话处理（外部/未绑定 agent 直接忽略），
    // 其余按 Agent 对象 + generation 隔离由 hub 与回调断言保证。
    function onLarkAssistantFrame(payload) {
      const agent = payload && payload.agent
      const frame = payload && payload.frame
      if (!agent || (typeof agent !== 'object' && typeof agent !== 'function') || !agent.session) return
      if (!frame || typeof frame.type !== 'string') return
      const sessionId = agent.session.id
      const record = state.sessionToConversation[sessionId]
      if (!record || record.channel !== 'lark') {
        // 仅已绑定会话；曾属飞书的 Agent 丢绑定时计入 unbound（不数无关渠道帧）。
        if (state.larkAgents.has(agent)) diagSafe(() => larkDiag().noteFrameRejected('unbound'))
        return
      }
      // 宿主 seen 计数：绑定会话的原始帧（未经引擎校验）。
      diagSafe(() => larkDiag().noteHostFrame(frame.type, frame.chunk && frame.chunk.type))
      if (!state.larkRuntime || !state.adapters.lark) {
        diagSafe(() => larkDiag().noteFrameRejected('unbound')) // 渠道未运行：不积压
        return
      }
      state.larkAgents.add(agent)
      state.larkAgentBySession.set(sessionId, agent)
      return larkStreams.handle(agent, sessionId, frame)
    }

    // agent/disposed：只清我们自己的流状态；借用（外部）agent 绝不 dispose。
    // attempt 表在引擎收卡队列完成后再删（收卡需要读表）。
    function onLarkAgentDisposed(payload) {
      const agent = payload && payload.agent
      if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return
      larkImageAgents.delete(agent)
      const imageEntry = larkImageAgentTools.get(agent)
      if (imageEntry) disposeLarkImageEntry(imageEntry)
      larkImageAgentTools.delete(agent)
      const imageMask = larkImageMasks.get(agent)
      if (imageMask) disposeLarkImageEntry({ dispose: imageMask })
      larkImageMasks.delete(agent)
      syncLarkImagesAvailable()
      // Agent 级 dispose：只终结该 Agent 自己的进行中诊断记录（不动并发 Agent）。
      diagSafe(() => {
        const d = larkDiag()
        d.noteAgentDispose(d.slotOf(agent), Date.now())
      })
      state.larkAgents.delete(agent)
      // Host LLM replacement may dispose an owned agent while metadata is pending.
      // Retire only that exact cached instance so bounded retry can resume it.
      for (const [key, entry] of Object.entries(state.conversationAgents)) {
        if (entry.agent === agent && entry.record?.channel === 'lark') delete state.conversationAgents[key]
      }
      for (const [sessionId, bound] of state.larkAgentBySession) {
        if (bound === agent) state.larkAgentBySession.delete(sessionId)
      }
      return Promise.resolve(larkStreams.disposeAgent(agent)).then(() => {
        state.larkAttemptStates.delete(agent)
      })
    }

    function larkAgentForSession(sessionId, record) {
      const bound = state.larkAgentBySession.get(sessionId)
      if (bound) return bound
      const entry = record && state.conversationAgents[record.key]
      return entry && entry.agent ? entry.agent : null
    }

    // 最终 assistant/message（先于 live end 到达）：按 turn/step 关联结算，
    // 去重/补尾；不回放任何 embedded stream。
    function deliverLarkFinal(sessionId, record, text, data) {
      const agent = larkAgentForSession(sessionId, record)
      if (!agent) return
      state.larkAgents.add(agent)
      state.larkAgentBySession.set(sessionId, agent)
      const turn = Number.isFinite(data.turn) ? data.turn : null
      const step = Number.isFinite(data.step) ? data.step : null
      // final 到达（独立于 live end，二者时序可区分）；多 step 同 turn 归同一回合。
      diagSafe(() => {
        const d = larkDiag()
        // message 域 interrupted：仅严格布尔透传；缺失/非法→null（由诊断侧忽略写入）。
        d.noteFinal(d.slotOf(agent), turn, step, Date.now(), agent,
          typeof (data && data.interrupted) === 'boolean' ? data.interrupted : null)
      })
      return larkStreams.get(agent, sessionId).setFinalMessage(text, { turn, step })
    }

    // turn/end：中止 → abort（丢未发尾部 + 幂等收卡）；正常 → 按 turn 身份 flush + 结算
    //（多 step 同 turn 一并收尾，绝不影响下一 turn）。返回是否命中流状态：未命中时
    // 调用方回退旧 turnBuffer 冲刷，不让缓冲期间的正文静默丢失。
    function handleLarkTurnEnd(sessionId, data) {
      const record = state.sessionToConversation[sessionId]
      const agent = larkAgentForSession(sessionId, record)
      if (!agent || !larkStreams.has(agent, sessionId)) return false
      const stream = larkStreams.get(agent, sessionId)
      const reason = data && data.reason
      const turn = data && Number.isFinite(data.turn) ? data.turn : null
      // 按 turn 身份三件套：abort({turn})/flushTurn({turn})/endTurn({turn})——
      // 迟到的旧 turn aborted 只中止自己的 turn，绝不取消新 turn 的在途输出；
      // 冲刷也只动本 turn 的全部 step，不碰其他 turn。
      const id = turn != null ? { turn } : undefined
      if (reason && reason.kind === 'aborted') {
        diagSafe(() => {
          const d = larkDiag()
          d.noteAbort(d.slotOf(agent), turn, Date.now(), agent)
        })
        stream.abort(id) // 引擎 abort(identity) 公共接口（1c2a08bc 已独立验收）
        return true
      }
      stream.flushTurn(id)
      stream.endTurn(id)
      diagSafe(() => {
        const d = larkDiag()
        d.noteTurnEnd(d.slotOf(agent), turn, Date.now(), agent)
      })
      return true
    }

    // reload/停用最先执行（逆序 disposer 首位，由 stopAdapter/disposeAdapters
    // 逆序运行）：同步失效普通出站门——在途分段回调的下一腿立即被拦；收卡改走
    // larkClosing 独立 cleanup 通路（捕获旧 cfg/token/已知 ID），不派新配置。
    function invalidateLarkRuntime() {
      if (state.larkRuntime) {
        state.larkClosing = state.larkRuntime
        state.larkRuntime = null
      }
    }

    // 适配器卸载（reload/停用/整体重建）：引擎 dispose 会先收已开的卡（走
    // larkClosing 通路），再清 attempt 表并作废旧上下文。
    function disposeLarkStreams() {
      invalidateLarkRuntime() // 兑底：正常已由逆序 disposer 最先执行
      const jobs = []
      for (const agent of state.larkAgents) jobs.push(larkStreams.disposeAgent(agent))
      const cleanup = () => {
        diagSafe(() => larkDiag().noteDispose(Date.now()))
        for (const agent of state.larkAgents) state.larkAttemptStates.delete(agent)
        state.larkAgents.clear()
        state.larkAgentBySession.clear()
        state.larkClosing = null
      }
      // 有界等待：网络悬挂不得让 reload 无限阻塞；超时即作废旧链（runtime 已失效，
      // 旧任务的后续腿会被 generation 断言拦下）。
      return Promise.race([
        Promise.all(jobs),
        new Promise((resolve) => { setTimeout(resolve, LARK_CLEANUP_WAIT_MS) }),
      ]).then(cleanup, cleanup)
    }

    function startLark(cfg) {
      const mode = cfg.mode === 'webhook' ? 'webhook' : 'long-connection'
      const disposers = []
      // 本次适配器代际快照：token/网络 await 之后逐次复核，旧链不派发到新配置。
      const runtime = {
        cfg,
        generation: state.channelGeneration.lark || 0,
        interactiveCard: Boolean(cfg.interactiveCard),
      }
      state.larkRuntime = runtime
      // 只读 scope 查询（grant 域）：每代一次、异步单飞，不阻塞消息链；失败不影响业务。
      // 微任务延迟到 startLark 同步体完成（adapters.lark 就位）后再发起。
      void diagSafe(() => Promise.resolve().then(() => larkScopeRead(runtime)).catch(() => {}))
      // 出站发送与订阅方式无关，两种入站方式共用。所有出站（含错误提示）都走这里：
      // interactiveCard 开 → 静态 interactive 卡；关 → text。超预算先分段，不静默截断。
      state.adapters.lark = {
        // 统一边界（legacy 缓冲/UI 手动/错误提示 + 流式单段）：非实时路径先校验
        // well-formed——畸形文本明确失败，绝不 trim 后静默发成功（P2）；分段循环
        // 每腿 await 后复核 generation；流式路径的 Agent/attempt 前缀进度在
        // larkDeliverSegments，这里是纯分段发送循环（无自动重试，不需进度槽）。
        sendText: async (conversation, text, meta) => {
          const raw = String(text == null ? '' : text)
          const diagCtx = diagCtxFromMeta(meta)
          if (!larkWellFormed(raw)) {
            // 纯本地拒绝：未派发网络，不计 static/text attempted，只进独立计数。
            diagSafe(() => larkDiag().noteLocalRefusal('malformed', Date.now()))
            return { ok: false, status: 0, error: 'lark outbound refused: malformed text (lone UTF-16 surrogate)' }
          }
          assertLarkRuntimeLive(runtime)
          const token = await larkTokenFor(runtime)
          assertLarkRuntimeLive(runtime) // await token 后 generation 复核
          const target = String(conversation).replace(/^lark:/, '')
          if (runtime.interactiveCard) return larkSendStaticCards(runtime, target, token, raw, diagCtx)
          const segments = larkSplitForText(raw)
          if (segments.length === 0) return { ok: true, status: 0, error: null }
          let last = null
          for (const segment of segments) {
            assertLarkRuntimeLive(runtime) // await 之后不再把旧链派到新配置
            const sendToken = diagAttempt('text_send', diagCtx)
            let response
            try {
              response = await httpPostJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
                receive_id: target,
                msg_type: 'text',
                content: JSON.stringify({ text: segment }),
              }, { Authorization: 'Bearer ' + token })
            } catch (error) {
              diagSettle(sendToken, { ok: false, status: null, apiCode: null, unknown: true, errorText: String((error && error.message) || error) })
              throw error // 网络层 reject 原样上抛（上层 larkUnknown 标未知投递）
            }
            last = larkHttpResult(response)
            diagSettle(sendToken, diagRes(last))
            if (!last.ok) return last
          }
          return last
        },
      }
      // reload/停用：cleanup 排最前（逆序最后执行：引擎先收卡再清表）；
      // invalidateLarkRuntime 在下面两条路径末尾 push（逆序最先执行）——普通出站
      // 立即失效、在途分段的下一腿被拦，收卡改走 larkClosing 独立通路。
      disposers.push(() => disposeLarkStreams())

      if (mode === 'long-connection') {
        // startLarkLongConnection 需要在握手前后都能记录状态，故异步启动；卸载时
        // 等它落地后调用真正的 close，避免把连接留给下一个适配器实例。
        const pending = startLarkLongConnection(cfg).catch((error) => {
          recordError('lark', 'long connection startup failed: ' + (error && error.message ? error.message : String(error)), 'connect', false)
          return []
        })
        disposers.push(() => {
          Promise.resolve(pending).then((inner) => {
            for (const dispose of inner) dispose()
          })
        })
        // 逆序最先执行：普通出站门同步失效（在途分段的下一腿被拦），
        // 收卡改走 larkClosing 独立通路（捕获旧 cfg/token/已知 ID）。
        disposers.push(() => invalidateLarkRuntime())
        return disposers
      }

      const path = cfg.webhookPath || '/messaging/lark/events'
      disposers.push(registerRoute(path, { channel: 'lark' }, async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const contentType = req.headers && (req.headers['content-type'] || req.headers['Content-Type']) || ''
        if (!isApplicationJson(contentType)) {
          recordError('lark', 'incoming webhook rejected: unsupported content-type', 'auth', false)
          return sendText(res, 415, 'unsupported media type')
        }
        const rawBody = await readBody(req, 2 * 1024 * 1024)
        const body = safeJsonParse(rawBody, null)
        if (!body) return sendJson(res, 400, { ok: false, error: 'invalid json' })
        if (cfg.encryptKey) {
          if (!body.encrypt) {
            recordError('lark', 'incoming webhook rejected: plain payload received while encryptKey configured', 'auth', false)
            return sendJson(res, 401, { ok: false, error: 'unauthorized' })
          }
          const timestamp = headerValue(req.headers, 'x-lark-request-timestamp')
          const nonce = headerValue(req.headers, 'x-lark-request-nonce')
          const signature = headerValue(req.headers, 'x-lark-signature')
          if (signature && !await verifyLarkSignature(cfg, req, rawBody)) {
            recordError('lark', 'incoming webhook rejected: signature verification failed', 'auth', false)
            return sendJson(res, 401, { ok: false, error: 'unauthorized' })
          }
          try {
            const decrypted = await larkDecrypt(cfg, body.encrypt)
            if (!decrypted) return sendJson(res, 401, { ok: false, error: 'decrypt failed' })
            const isChallenge = larkEventType(decrypted) === 'url_verification'
            if (!isChallenge && !signature) {
              recordError('lark', 'incoming webhook rejected: signature verification failed', 'auth', false)
              return sendJson(res, 401, { ok: false, error: 'unauthorized' })
            }
            // 官方 SDK 的 autoChallenge 在 dispatcher.invoke 验签前处理加密
            // url_verification；这里只在解密成功、类型正确且配置 token 校验通过时兼容无签名。
            if (isChallenge && !cfg.verificationToken) {
              recordError('lark', 'incoming encrypted challenge rejected: verificationToken is not configured', 'auth', false)
              return sendJson(res, 401, { ok: false, error: 'unauthorized' })
            }
            if (cfg.verificationToken && !constantTimeEqual(larkVerificationToken(decrypted), cfg.verificationToken)) {
              recordError('lark', 'incoming event rejected: verification token mismatch', 'auth', false)
              return sendJson(res, 401, { ok: false, error: 'unauthorized' })
            }
            const replayed = larkRequestSeen(timestamp, nonce, signature)
            if (isChallenge) return sendJson(res, 200, { challenge: decrypted.challenge })
            if (replayed) return sendJson(res, 200, { ok: true, replayed: true })
            try {
              await dispatchLarkEvent(decrypted)
            } catch (error) {
              // claim/bind/open 失败 → 非成功 ACK（500 → 平台重投；不泄原文）；
              // **不写成功 replay**：合法同 body 重试仍可真实 claim 成功。
              recordError('lark', error, 'dedup claim', false)
              return sendJson(res, 500, { ok: false, error: 'unavailable' })
            }
            // D：durable claim+bind 已成功 → 才登记成功 replay（防假 ACK 腐蚀）。
            rememberLarkRequest(timestamp, nonce, signature)
            return sendJson(res, 200, { ok: true })
          } catch {
            return sendJson(res, 401, { ok: false, error: 'decrypt failed' })
          }
          return sendJson(res, 401, { ok: false, error: 'decrypt failed' })
        }
        if (body.encrypt) return sendJson(res, 401, { ok: false, error: 'decrypt failed' })
        return handleLarkEvent(cfg, body, res, false)
      }))
      setChannelState('lark', 'running', { path, encrypted: Boolean(cfg.encryptKey) })
      warmLarkDedupStore()
      registerLarkImageToolOnce()
      // 逆序最先执行：普通出站门同步失效，收卡走 larkClosing 独立通路。
      disposers.push(() => invalidateLarkRuntime())
      return disposers
    }

    async function handleLarkEvent(cfg, event, res, wasEncrypted = false) {
      if (cfg.verificationToken) {
        if (!constantTimeEqual(larkVerificationToken(event), cfg.verificationToken)) {
          recordError('lark', 'incoming event rejected: verification token mismatch', 'auth', false)
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }
      } else if (cfg.encryptKey) {
        if (!wasEncrypted) {
          recordError('lark', 'incoming event rejected: plain payload received while encryptKey configured without token', 'auth', false)
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }
      } else {
        recordError('lark', 'incoming event rejected: neither verificationToken nor encryptKey configured', 'auth', false)
        return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      }
      if (larkEventType(event) === 'url_verification') return sendJson(res, 200, { challenge: event.challenge })
      try {
        await dispatchLarkEvent(event)
      } catch (error) {
        // claim/bind/open 失败 → 500（平台重投；不泄原文、不假成功 ACK）。
        recordError('lark', error, 'dedup claim', false)
        return sendJson(res, 500, { ok: false, error: 'unavailable' })
      }
      sendJson(res, 200, { ok: true })
    }

    // WeCom encrypted callback
    function startWecom(cfg) {
      const disposers = []
      const path = cfg.webhookPath || '/messaging/wecom/callback'
      state.adapters.wecom = {
        sendText: async (conversation, text) => {
          const token = await wecomAccessToken(cfg)
          const target = String(conversation).replace(/^wecom:/, '')
          const response = await httpPostJson('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
            touser: target,
            msgtype: 'text',
            agentid: Number(cfg.agentId),
            text: { content: text },
          })
          return { ok: response.ok && response.json && response.json.errcode === 0, status: response.status, error: response.json && response.json.errmsg || response.stderr || (!response.ok ? 'HTTP ' + response.status : null) }
        },
      }
      disposers.push(registerRoute(path, { channel: 'wecom' }, async (req, res) => {
        const query = parseQuery(req.url)
        if (req.method === 'GET') {
          if (!cfg.encodingAESKey) return sendText(res, 200, query.echostr || '')
          try {
            const verified = await companionRun('crypto-helper.cjs', [
              'wecom', 'verify-echostr',
            ], {
              echostr: query.echostr || '',
              signature: query.msg_signature || '',
              timestamp: query.timestamp || '',
              nonce: query.nonce || '',
              token: cfg.token,
              aesKey: cfg.encodingAESKey,
              receiveId: cfg.corpId,
            }, 15000)
            if (!verified || verified.ok !== true) throw new Error(verified && verified.error || 'wecom signature verification failed')
            return sendText(res, 200, verified.decrypted)
          } catch (error) {
            // 首次 URL 校验：成功的路径回 echostr（上面），失败只回固定短语；
            // 细节（可能带着 --token/--aes-key 命令行）只进内部记录。
            recordError('wecom', error, 'webhook verify-echostr', false)
            return sendText(res, 403, 'forbidden')
          }
        }
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const body = await readBody(req, 2 * 1024 * 1024)
        const encrypted = xmlTag(body, 'Encrypt')
        if (!encrypted) return sendText(res, 400, 'missing Encrypt')
        try {
          const decrypted = await companionRun('crypto-helper.cjs', [
            'wecom', 'decrypt',
          ], {
            encrypt: encrypted,
            signature: query.msg_signature || '',
            timestamp: query.timestamp || '',
            nonce: query.nonce || '',
            token: cfg.token,
            aesKey: cfg.encodingAESKey,
            receiveId: cfg.corpId,
          }, 15000)
          if (!decrypted || decrypted.ok !== true) throw new Error(decrypted && decrypted.error || 'wecom decrypt failed')
          const xml = decrypted.xml || decrypted.decrypted || ''
          const msgType = xmlTag(xml, 'MsgType')
          if (msgType === 'text') {
            const content = xmlTag(xml, 'Content')
            const fromUser = xmlTag(xml, 'FromUserName')
            if (content && fromUser) inbound('wecom', 'wecom:' + fromUser, content, {
              fromUser,
              toUser: xmlTag(xml, 'ToUserName'),
              msgType,
            })
          }
          sendText(res, 200, 'success')
        } catch (error) {
          recordError('wecom', error, 'webhook decrypt', false)
          sendText(res, 403, 'forbidden')
        }
      }))
      setChannelState('wecom', 'running', { path, encrypted: true })
      return disposers
    }

    async function wecomAccessToken(cfg) {
      const token = state.wecomToken
      if (token && token.expiresAt > now()) return token.value
      const response = await httpGetJson('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' + encodeURIComponent(cfg.corpId) + '&corpsecret=' + encodeURIComponent(cfg.secret), {}, { timeoutMs: 15000 })
      if (!response.ok || !response.json || !response.json.access_token) {
        throw new Error(response.json && response.json.errmsg || response.stderr || ('HTTP ' + response.status))
      }
      state.wecomToken = {
        value: response.json.access_token,
        expiresAt: now() + (Number(response.json.expires_in) || 7200) * 1000 - 60000,
      }
      return state.wecomToken.value
    }

    // Personal WeChat via the ilink Bot API (Tencent/openclaw-weixin protocol)
    function startWechat(cfg, credentialToken) {
      const disposers = []
      const baseUrl = trimTrailingSlash(cfg.baseUrl || 'https://ilinkai.weixin.qq.com')
      // P2b：token 优先取凭据 record；legacy config 里的旧 token 只作为未迁移时的读取兜底。
      const token = credentialToken || ''
      const baseInfo = { channel_version: '1.0.0', bot_agent: cfg.botAgent || 'dsh-messaging' }

      state.adapters.wechat = {
        sendText: async (conversation, text) => {
          const target = String(conversation).replace(/^wechat:/, '')
          const contextToken = state.wechatContextTokens[conversation] || ''
          const payload = {
            msg: {
              // 参考实现（openclaw-weixin / wechat-ilink-client 两源一致）的完整信封：
              // from_user_id 显式空串、client_id 唯一、message_type=BOT(2)、
              // message_state=FINISH(2)。缺 message_type/message_state 时网关照样
              // 返回 message_id，但**不作为机器人完成消息投递**——手机端看不到，
              // 这正是「回复没到手机」的根因。
              from_user_id: '',
              to_user_id: target,
              client_id: 'dsh-messaging-' + require('node:crypto').randomBytes(8).toString('hex'),
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text: String(text) } }],
              ...(contextToken ? { context_token: contextToken } : {}),
            },
            base_info: baseInfo,
          }
          const response = await httpPostJson(joinUrl(baseUrl, 'ilink/bot/sendmessage'), payload, ilinkHeaders(token))
          const json = response.json
          // sendmessage 成功时网关返回 { message_id: <num>} —— **没有 ret 字段**
          // （实测：200 + {"message_id":…}）。旧判据 ret===0 把这种成功判成失败，
          // 错误串恰为 'HTTP 200'，回复被误报为未送达。ret===0 的形状兼容保留。
          const success = response.ok && Boolean(json) && (
            (typeof json.ret === 'number' && json.ret === 0)
            || typeof json.message_id === 'number'
          )
          return {
            ok: success,
            status: response.status,
            error: success
              ? null
              : (json && json.errmsg) || response.stderr
                || ('HTTP ' + response.status + (response.text ? ' body=' + String(response.text).slice(0, 160) : '')),
          }
        },
      }

      const startLoop = () => {
        if (state.wechatPolling) return
        state.wechatPolling = true
        // 按渠道代际：只重建 wechat 时本循环自己过期。
        const loopGeneration = state.channelGeneration.wechat
        wechatPollLoop(cfg, baseUrl, token, baseInfo, loopGeneration)
          .catch((error) => {
            if (loopGeneration === state.channelGeneration.wechat) recordError('wechat', error, 'ilink long-poll loop')
          })
          .finally(() => {
            if (loopGeneration === state.channelGeneration.wechat) state.wechatPolling = false
          })
      }

      // Watchdog restarts the loop if it died; the loop itself is continuous.
      disposers.push(ctx.interval(startLoop, clamp(Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500), 1000, 60000)))
      startLoop()

      setChannelState('wechat', 'running', { driver: 'ilink', baseUrl })
      return disposers
    }

    // 可中断等待：优先走 ctx.timeout（宿主可注入、可随插件停用清理），没注入则退回定时器。
    function pause(ms) {
      return new Promise((resolve) => {
        if (typeof ctx.timeout === 'function') ctx.timeout(resolve, ms)
        else setTimeout(resolve, ms)
      })
    }

    async function wechatPollLoop(cfg, baseUrl, token, baseInfo, loopGeneration) {
      while (state.wechatPolling && loopGeneration === state.channelGeneration.wechat) {
        const pollStartedAt = now()
        const timeoutMs = Math.ceil((Number(cfg.longPollTimeoutSec || 35) + 15) * 1000)
        const payload = { get_updates_buf: state.wechatUpdatesBuf, base_info: baseInfo }
        const response = await httpPostJson(joinUrl(baseUrl, 'ilink/bot/getupdates'), payload, ilinkHeaders(token), { timeoutMs })
        if (loopGeneration !== state.channelGeneration.wechat) return
        if (!response.ok) {
          throw new Error((response.json && (response.json.errmsg || response.json.error)) || response.stderr || ('HTTP ' + response.status))
        }
        const body = response.json || {}
        if (body.ret !== undefined && body.ret !== 0) {
          if (body.ret === -14 || body.errcode === -14) {
            // Session expired: reset the sync cursor and retry after a short pause.
            state.wechatUpdatesBuf = ''
            await pause(2000)
            continue
          }
          throw new Error('getupdates ret=' + body.ret + ' errmsg=' + (body.errmsg || ''))
        }
        if (typeof body.get_updates_buf === 'string') state.wechatUpdatesBuf = body.get_updates_buf
        const msgs = Array.isArray(body.msgs) ? body.msgs : []
        for (const message of msgs) processIlinkMessage(message)
        setChannelState('wechat', 'running', { driver: 'ilink', baseUrl })
        // 最小轮询间隔（ILINK_MIN_POLL_GAP_MS）：网关秒回时补足差额再发下一次。
        // 请求本身耗时 ≥ 间隔则不等待；醒来后由 while 条件重新校验代际/停机。
        const elapsed = now() - pollStartedAt
        if (elapsed < ILINK_MIN_POLL_GAP_MS) await pause(ILINK_MIN_POLL_GAP_MS - elapsed)
      }
    }

    function processIlinkMessage(message) {
      if (!isObject(message)) return
      // Only USER-originated messages; BOT messages (message_type 2) are our own replies.
      if (message.message_type !== undefined && Number(message.message_type) !== 1) return
      const messageId = message.message_id !== undefined ? String(message.message_id) : (message.seq !== undefined ? String(message.seq) : null)
      if (messageId) {
        if (state.wechatSeen[messageId]) return
        state.wechatSeen[messageId] = true
        const seenKeys = Object.keys(state.wechatSeen)
        if (seenKeys.length > 5000) for (const key of seenKeys.slice(0, 2000)) delete state.wechatSeen[key]
      }
      const fromUser = message.from_user_id || ''
      if (!fromUser) return
      const text = extractIlinkText(message.item_list)
      if (!text) return
      const conversation = 'wechat:' + fromUser
      if (typeof message.context_token === 'string' && message.context_token) {
        state.wechatContextTokens[conversation] = message.context_token
      }
      inbound('wechat', conversation, text, {
        fromUser,
        messageId,
        sessionId: message.session_id || null,
      })
    }

    function extractIlinkText(itemList) {
      if (!Array.isArray(itemList)) return ''
      return itemList
        .map((item) => {
          if (!isObject(item)) return ''
          if (item.type === 1 && item.text_item && typeof item.text_item.text === 'string') return item.text_item.text
          return ''
        })
        .join('')
    }

    // --- ilink QR-code login (integrated from Tencent/openclaw-weixin src/auth/login-qr.ts) ---

    const ILINK_LOGIN_TTL_MS = 5 * 60 * 1000

    function purgeIlinkLogins() {
      for (const key of Object.keys(state.ilinkLogins)) {
        if (now() - state.ilinkLogins[key].startedAt > ILINK_LOGIN_TTL_MS) delete state.ilinkLogins[key]
      }
    }

    async function fetchIlinkQrCode() {
      const localTokens = []
      // 扫码需要带上已绑定的 bot token（凭据 record；legacy 时回退 config 里的旧值）。
      const existingToken = state.wechatCredential
        || (state.config.adapters && state.config.adapters.wechat && state.config.adapters.wechat.token)
        || ''
      if (existingToken) localTokens.push(existingToken)
      const response = await httpPostJson(joinUrl(ILINK_BASE_URL, 'ilink/bot/get_bot_qrcode?bot_type=3'), { local_token_list: localTokens }, ilinkHeaders(''))
      if (!response.ok || !response.json || !response.json.qrcode) {
        throw new Error((response.json && response.json.errmsg) || response.stderr || ('HTTP ' + response.status))
      }
      // qrcode_img_content 是「要编码进二维码的内容」（登录链接），不是图片
      // 地址：直接 GET 它拿到的是 liteapp 的 HTML 页面。宿主把它本地编码成
      // SVG data URL，qrcodeUrl 对 client 仍然是可直接作 <img src> 的图片源。
      const payload = String(response.json.qrcode_img_content || '')
      if (!payload) throw new Error('ilink get_bot_qrcode returned no qrcode_img_content')
      return {
        qrcode: String(response.json.qrcode),
        qrcodeUrl: qrSvgDataUrl(payload),
      }
    }

    async function startIlinkLogin() {
      purgeIlinkLogins()
      const qr = await fetchIlinkQrCode()
      const sessionKey = 'ilink-' + now() + '-' + Math.floor(Math.random() * 1000000)
      state.ilinkLogins[sessionKey] = {
        qrcode: qr.qrcode,
        qrcodeUrl: qr.qrcodeUrl,
        startedAt: now(),
        baseUrl: ILINK_BASE_URL,
        pendingVerifyCode: undefined,
      }
      return {
        ok: true,
        sessionKey,
        qrcodeUrl: qr.qrcodeUrl,
        expiresAt: now() + ILINK_LOGIN_TTL_MS,
      }
    }

    async function pollIlinkLoginStatus(sessionKey, verifyCode) {
      const login = state.ilinkLogins[sessionKey]
      if (!login) return { ok: false, error: 'no active login' }
      if (now() - login.startedAt > ILINK_LOGIN_TTL_MS) {
        delete state.ilinkLogins[sessionKey]
        return { status: 'expired', final: true }
      }
      if (verifyCode) login.pendingVerifyCode = String(verifyCode)
      let endpoint = 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(login.qrcode)
      if (login.pendingVerifyCode) endpoint += '&verify_code=' + encodeURIComponent(login.pendingVerifyCode)
      const response = await httpGetJson(joinUrl(login.baseUrl, endpoint), ilinkCommonHeaders(), { timeoutMs: 40000 })
      if (!response.ok) {
        // Network/gateway error: treat as wait and let the client retry (mirrors openclaw-weixin).
        return { status: 'wait' }
      }
      const body = response.json || {}
      const status = body.status || 'wait'
      if (status === 'confirmed') {
        const botToken = body.bot_token
        const botId = body.ilink_bot_id
        if (!botToken || !botId) {
          delete state.ilinkLogins[sessionKey]
          return { status: 'failed', final: true, error: 'server did not return ilink_bot_id' }
        }
        const accountBase = body.baseurl ? trimTrailingSlash(String(body.baseurl)) : login.baseUrl
        rememberSecretValues() // 换令牌前先记住旧值，旧 token 记录过的事件仍可脱敏
        // P2b：token 只进凭据 record，不再写 Config；没有凭据服务就明确报错，
        // 不回退成写配置（中英文案，code 供客户端换本地化文案）。
        try {
          await writeWechatCredential(String(botToken))
        } catch (error) {
          delete state.ilinkLogins[sessionKey]
          recordError('wechat', error, 'ilink login', false)
          return {
            status: 'failed',
            final: true,
            code: error && error.code ? error.code : 'CREDENTIALS_UNAVAILABLE',
            error: error && error.message ? error.message : String(error),
          }
        }
        state.wechatCredential = String(botToken)
        if (body.baseurl) await writeWechatBaseUrl(accountBase)
        delete state.ilinkLogins[sessionKey]
        return {
          status: 'confirmed',
          final: true,
          accountId: String(botId),
          baseUrl: accountBase,
          userId: body.ilink_user_id ? String(body.ilink_user_id) : null,
        }
      }
      if (status === 'binded_redirect') {
        // The scanned bot is already bound; existing credentials stay valid.
        delete state.ilinkLogins[sessionKey]
        return { status: 'confirmed', final: true, alreadyConnected: true }
      }
      if (status === 'scaned_but_redirect') {
        if (body.redirect_host) login.baseUrl = 'https://' + String(body.redirect_host)
        return { status: 'scaned' }
      }
      if (status === 'expired') {
        try {
          const fresh = await fetchIlinkQrCode()
          login.qrcode = fresh.qrcode
          login.qrcodeUrl = fresh.qrcodeUrl
          login.startedAt = now()
          login.pendingVerifyCode = undefined
        } catch (error) {
          // vendor 对容量溢出抛的是字符串而非 Error，取错误信息要兜住两种形态，
          // 否则 expired 自动刷新失败时 error 字段是 undefined，页面只剩通用文案。
          return { status: 'failed', final: true, error: error && error.message ? error.message : String(error) }
        }
        return { status: 'expired', qrcodeUrl: login.qrcodeUrl }
      }
      if (status === 'verify_code_blocked') {
        login.pendingVerifyCode = undefined
        return { status: 'verify_code_blocked' }
      }
      return { status: status || 'wait' }
    }

    // ── P2c：按渠道增量重建 ─────────────────────────────────────────────────
    // 作用域映射：
    //   adapters.<key>.* → 只重建该渠道
    //   agent.*          → 不重建任何适配器，也不动已有会话（见 applyConfigUpdate）
    //   其他（version/workspaceRoot/runtime.* 或未知字段）→ 兤底整体 rebuildAll
    //   （非 volatile 字段理论上不会走到增量路径：Loader 会重启 fiber）
    function diffConfigScopes(previous, next) {
      const scopes = new Set()
      for (const def of CHANNEL_DEFS) {
        if (!deepEqualValues(readPathValue(previous, 'adapters.' + def.key), readPathValue(next, 'adapters.' + def.key))) {
          scopes.add('adapter:' + def.key)
        }
      }
      if (!deepEqualValues(readPathValue(previous, 'agent'), readPathValue(next, 'agent'))) scopes.add('agent')
      const withoutChannels = (value) => {
        if (!isObject(value)) return value
        const copy = {}
        for (const key of Object.keys(value)) {
          if (key === 'adapters' || key === 'agent') continue
          copy[key] = value[key]
        }
        return copy
      }
      if (!deepEqualValues(withoutChannels(previous), withoutChannels(next))) scopes.add('global')
      return scopes
    }

    // 渠道私有的运行时状态，只在该渠道重建时重置（归属清单见回报）。
    // 注意两处刻意不清：wechatSeen（入站去重缓存）——重建后网关会重发历史消息，
    // 丢了去重会重复投递；ilinkLogins（进行中的扫码）——扫码不依赖适配器。
    function resetChannelRuntime(key) {
      if (key === 'telegram') {
        state.telegramOffset = 0
        state.telegramBotId = null
        state.telegramPolling = false
      } else if (key === 'lark') {
        // token 缓存随 runtime 对象回收（按代隔离），无全局槽需要清；
        // 拆渠道后不展示旧连接时间：重连成功时 onReady 会写新的。
        state.larkTrace.connectedAt = null
      } else if (key === 'wecom') {
        state.wecomToken = null
      } else if (key === 'wechat') {
        state.wechatPolling = false
        state.wechatUpdatesBuf = ''
        state.wechatContextTokens = Object.create(null)
      } else if (key === 'discord') {
        state.discordProc = null
      }
    }

    // 只 dispose 属于该渠道的会话；其他渠道的会话与 agent 句柄保持不变。
    async function disposeChannelSessions(channel) {
      const keys = new Set(Object.keys(state.sessions))
      for (const key of Object.keys(state.conversationAgents)) keys.add(key)
      for (const sessionKey of keys) {
        const record = state.sessions[sessionKey]
        const entry = state.conversationAgents[sessionKey]
        const owner = (record && record.channel) || (entry && entry.record && entry.record.channel)
        if (owner !== channel) continue
        if (entry && entry.handle) {
          try { await entry.handle.dispose() } catch {
            // The agent may already have been disposed by its owning fiber.
          }
        }
        delete state.conversationAgents[sessionKey]
        state.sessionSharedNotified.delete(sessionKey)
        if (record) {
          if (record.sessionId) {
            delete state.turnBuffer[record.sessionId]
            delete state.sessionToConversation[record.sessionId]
          }
          delete state.sessions[sessionKey]
        }
      }
      for (const sessionId of Object.keys(state.sessionToConversation)) {
        const mapped = state.sessionToConversation[sessionId]
        if (mapped && mapped.channel === channel) {
          delete state.sessionToConversation[sessionId]
          delete state.turnBuffer[sessionId]
        }
      }
    }

    // 拆一个渠道：路由/轮询/子进程 + 该渠道代际 + 私有状态 + 该渠道会话。
    async function stopAdapter(key) {
      if (key === 'lark') {
        larkImageAgents.clear()
        clearLarkImageTool()
      }
      const disposers = (state.disposersByChannel[key] || []).splice(0).reverse()
      for (const disposer of disposers) {
        try {
          const result = disposer()
          if (result && typeof result.then === 'function') await result
        } catch {
          // A single adapter disposer failure must not block the rest of teardown.
        }
      }
      // 代际：让该渠道在途的轮询/循环判定自己过期；别的渠道代际不变。
      state.channelGeneration[key] = (state.channelGeneration[key] || 0) + 1
      if (key === 'lark') releasePresetActivations()
      resetChannelRuntime(key)
      await disposeChannelSessions(key)
      delete state.adapters[key]
      const status = channelStatus(key)
      if (status) {
        status.enabled = false
        status.state = 'disabled'
        status.detail = {}
        status.lastError = null // 局部重建只清本渠道的错误
      }
    }

    async function restartChannels(keys) {
      const rebuilt = []
      for (const key of keys) {
        const def = CHANNEL_DEFS.find((entry) => entry.key === key)
        if (!def) continue
        await stopAdapter(key)
        await startAdapter(def)
        rebuilt.push(key)
      }
      return rebuilt
    }

    // 只重建指定渠道：用于“配置没变、只是运行时凭据变了”的场景
    // （credentials/record-updated 只重建 wechat）。
    async function rebuildChannelsOnly(keys) {
      state.generation += 1
      rememberSecretValues()
      const rebuilt = await restartChannels(keys)
      for (const key of rebuilt) recordRecent('reload', { channel: key, generation: state.generation })
      flushPendingNotices()
      return rebuilt
    }

    // 配置变化入口：按作用域决定重建范围（全部串在 enqueueRebuild 队列里）。
    async function applyConfigUpdate(next) {
      const scopes = diffConfigScopes(state.config, next)
      if (!scopes.size) return { scopes, rebuilt: [] }
      if (scopes.has('global')) {
        // 非 volatile 字段 / 派生值变化：兤底整体重建。
        await rebuildAll(next)
        return { scopes, rebuilt: CHANNEL_DEFS.map((def) => def.key) }
      }
      state.generation += 1
      rememberSecretValues()
      state.config = next
      state.workspaceRoot = String(next.workspaceRoot || state.workspaceRoot)
      state.configPath = configPathFor(state.workspaceRoot)
      rememberSecretValues()
      // agent.*（cwd/agentPreset/provider/model）：只影响**之后新建**的 agent 会话；
      // 已有会话保持不变（要让已有会话立即换 model 就得重启会话，那是另一个
      // 产品决定，先不自动做）。不重建任何适配器。
      if (scopes.has('agent')) recordRecent('reload', { scope: 'agent', generation: state.generation })
      const changed = CHANNEL_DEFS
        .filter((def) => scopes.has('adapter:' + def.key))
        .map((def) => def.key)
      const rebuilt = await restartChannels(changed)
      for (const key of rebuilt) recordRecent('reload', { channel: key, generation: state.generation })
      flushPendingNotices()
      return { scopes, rebuilt }
    }

    async function startAdapter(def) {
      const cfg = state.config.adapters && state.config.adapters[def.key] ? state.config.adapters[def.key] : {}
      const status = channelStatus(def.key)
      if (!cfg.enabled) {
        if (status) {
          status.enabled = false
          status.state = 'disabled'
          status.detail = {}
        }
        return
      }
      if (status) {
        status.enabled = true
        status.state = 'starting'
        status.detail = {}
      }
      try {
        let disposers = []
        if (def.key === 'onebot') disposers = startOnebot(cfg)
        else if (def.key === 'telegram') disposers = await startTelegram(cfg)
        else if (def.key === 'discord') disposers = await startDiscord(cfg)
        else if (def.key === 'slack') disposers = startSlack(cfg)
        else if (def.key === 'lark') disposers = startLark(cfg)
        else if (def.key === 'wecom') disposers = startWecom(cfg)
        else if (def.key === 'wechat') {
          // 凭据 record 是真源：每次重建前先刷新，再交给适配器。
          await refreshWechatCredential()
          disposers = startWechat(cfg, wechatTokenFor(cfg))
        }
        for (const disposer of disposers) {
          if (!state.disposersByChannel[def.key]) state.disposersByChannel[def.key] = []
          state.disposersByChannel[def.key].push(disposer)
        }
      } catch (error) {
        delete state.adapters[def.key]
        recordError(def.key, error, 'start adapter')
      }
    }

    async function disposeAdapters() {
      larkImageAgents.clear()
      clearLarkImageTool()
      for (const key of Object.keys(state.disposersByChannel)) {
        const disposers = state.disposersByChannel[key].splice(0).reverse()
        for (const disposer of disposers) {
          try {
            const result = disposer()
            if (result && typeof result.then === 'function') await result
          } catch {
            // A single adapter disposer failure must not block the rest of teardown.
          }
        }
      }
      // 整体重建：所有渠道的代际都推进，在途的轮询/循环都判定自己过期。
      for (const def of CHANNEL_DEFS) {
        state.channelGeneration[def.key] = (state.channelGeneration[def.key] || 0) + 1
      }
      for (const key of Object.keys(state.conversationAgents)) {
        const entry = state.conversationAgents[key]
        try {
          if (entry && entry.handle) await entry.handle.dispose()
        } catch (error) {
          // The agent may already have been disposed by its owning fiber.
        }
      }
      state.adapters = Object.create(null)
      state.conversationAgents = Object.create(null)
      state.sessionSharedNotified.clear()
      state.sessionToConversation = Object.create(null)
      state.sessions = Object.create(null)
      state.turnBuffer = Object.create(null)
      for (const def of CHANNEL_DEFS) resetChannelRuntime(def.key)
      // 整体重建（用户显式 reload / 初次启动）保持旧语义：连入站去重缓存一起清。
      state.wechatSeen = Object.create(null)
      state.ilinkLogins = Object.create(null)
      state.disposersByChannel = Object.create(null)
    }

    async function rebuildAll(overrideConfig) {
      state.generation += 1
      // 先把旧配置里的密钥记进值集合，再拆适配器（lark/wecom 缓存的运行时令牌
      // 也在这一刻被记住）：旧值要继续覆盖到已经记录下来的旧事件。
      rememberSecretValues()
      await disposeAdapters()
      state.recent = []
      state.errors = []
      if (admissionRegistrationFailed) {
        recordError(null, 'admission projection registration failed', 'admission registration', false)
      }
      state.telegramOffset = 0
      state.telegramBotId = null
      if (overrideConfig) {
        state.config = overrideConfig
        state.workspaceRoot = String(overrideConfig.workspaceRoot || state.workspaceRoot)
        state.configPath = configPathFor(state.workspaceRoot)
      } else {
        // Loader 路径：每次 rebuild 从引用现取快照，不缓存，热更新才能读到新值。
        const fromLoader = readLoaderConfig()
        if (fromLoader) {
          state.config = materializeConfig(fromLoader, configRoot, state.workspaceRoot)
          state.workspaceRoot = state.config.workspaceRoot
          state.configPath = configPathFor(state.workspaceRoot)
        } else {
          state.config = await loadConfig()
          state.workspaceRoot = state.config.workspaceRoot
        }
      }
      rememberSecretValues()
      resetChannelStatuses()
      for (const def of CHANNEL_DEFS) await startAdapter(def)
      recordRecent('reload', { generation: state.generation })
      // 重建刚把 errors/recent 清空，把排队的地址策略提示补写进来。
      flushPendingNotices()
    }

    // ── P2b：重建串行化（事件可能来自 Loader 与凭据两侧，不能交叠拆建适配器）──
    function enqueueRebuild(task) {
      // 无论上一次成功与否都继续排队，但把失败透传给当次调用者。
      rebuildQueue = rebuildQueue.then(() => task(), () => task())
      return rebuildQueue
    }

    // 用 Loader 的当前快照重建（已一致时跳过，避免重复拆建适配器）。
    async function applyLoaderSnapshot() {
      const snapshot = readLoaderConfig()
      if (!snapshot) return false
      const next = materializeConfig(snapshot, configRoot, state.workspaceRoot)
      if (deepEqualValues(state.config, next)) return false
      const { scopes } = await applyConfigUpdate(next)
      return scopes.size > 0
    }

    // 写入收敛后的唯一写入口：settings.update（只收 volatile 路径，写前会整树校验
    // 与 revision 校验）。internalWrite 用于区分“插件自己发起的写入”。
    async function updateViaSettings(patch, revision) {
      if (!settingsApi || !entryId) throw new Error('settings service is unavailable; the configuration was not saved')
      internalWrite += 1
      try {
        await settingsApi.update(entryId, patch, revision)
      } finally {
        internalWrite -= 1
      }
      if (pendingAddressClears.length) await flushAddressClears()
    }

    // settings 暂不可用时先记账的密钥清除，可用后补写（否则内存里清了、profile
    // 里没清，下一次重建又会被抬回来）。
    async function flushAddressClears() {
      if (!pendingAddressClears.length || !settingsApi || !entryId) return
      const ops = pendingAddressClears
      pendingAddressClears = []
      try {
        await settingsApi.mutate(entryId, ops.map((op) => ({ op: 'set', path: op.path.split('.'), value: op.value })))
      } catch (error) {
        pendingAddressClears = ops.concat(pendingAddressClears)
        recordError(null, error, 'address policy write-back')
      }
    }

    // 「改出站地址 → 清随行密钥」的落地：写 profile（清不进 profile 时先在内存里
    // 生效并记欠账）+ 删凭据 record。
    // 会触发 rebuild 的写入路径上，提示要活过 rebuildAll（它会清空 errors）：
    // 先记账，重建收尾时再写。
    function recordNotice(context, message) {
      pendingNotices.push({ context, message })
    }

    function flushPendingNotices() {
      if (!pendingNotices.length) return
      const list = pendingNotices
      pendingNotices = []
      for (const notice of list) recordError(null, notice.message, notice.context, false)
    }

    async function applyAddressPolicy(address) {
      for (const message of address.messages) recordNotice('address policy', message)
      // 只有 volatile 字段能写进 profile；wechat.token（P2b 已迁出 Config）只在内存里清。
      const volatileOps = address.ops.filter((op) => VOLATILE_CONFIG_PATHS.includes(op.path))
      if (!address.ops.length && !address.clearWechatRecord) return
      // 在副本上清：state.config 保持不动，好让 applyConfigUpdate 做出“只影响
      // onebot/wechat”的作用域判断（直接改 state.config 就 diff 不出来了）。
      const nextConfig = JSON.parse(JSON.stringify(state.config))
      for (const op of address.ops) writePathValue(nextConfig, op.path, op.value)
      if (volatileOps.length) {
        if (settingsApi && entryId) {
          try {
            await settingsApi.mutate(entryId, volatileOps.map((op) => ({ op: 'set', path: op.path.split('.'), value: op.value })))
          } catch (error) {
            recordError(null, error, 'address policy write-back')
            pendingAddressClears = pendingAddressClears.concat(volatileOps)
          }
        } else {
          pendingAddressClears = pendingAddressClears.concat(volatileOps)
        }
      }
      // 只重建受影响的渠道（P2c）。
      await applyConfigUpdate(nextConfig)
      if (address.clearWechatRecord) await clearWechatCredential()
    }

    // ── 微信凭据 record（P2b：token 从 Config 迁出）─────────────────────
    async function refreshWechatCredential() {
      if (!credentialsApi) {
        state.wechatCredential = ''
        return ''
      }
      try {
        const record = await credentialsApi.readRecord(WECHAT_CREDENTIAL_KEY)
        const payload = record && record.kind === 'grant' && record.payload ? record.payload : null
        state.wechatCredential = payload && payload.token ? String(payload.token) : ''
      } catch (error) {
        recordError('wechat', error, 'credentials read')
        state.wechatCredential = ''
      }
      return state.wechatCredential
    }

    async function writeWechatCredential(token) {
      if (!credentialsApi) {
        const error = new Error('credentials service is unavailable, the WeChat login token was not stored / 缺少凭据存储服务，微信登录 Token 未保存')
        error.code = 'CREDENTIALS_UNAVAILABLE'
        throw error
      }
      await credentialsApi.modifyRecord(WECHAT_CREDENTIAL_KEY, (current) => Promise.resolve({
        kind: 'grant',
        payload: Object.assign({}, (current && current.payload) || {}, {
          version: 1,
          token: String(token),
          updatedAt: new Date().toISOString(),
        }),
      }))
    }

    async function clearWechatCredential() {
      if (!credentialsApi) {
        recordError('wechat', 'credentials service is unavailable; the stored WeChat credential could not be cleared', 'address policy', false)
        return false
      }
      try {
        await credentialsApi.deleteRecord(WECHAT_CREDENTIAL_KEY)
        state.wechatCredential = ''
        return true
      } catch (error) {
        recordError('wechat', error, 'address policy', false)
        return false
      }
    }

    function wechatTokenFor(cfg) {
      if (state.wechatCredential) return state.wechatCredential
      return (cfg && cfg.token) || ''
    }

    // 扫码回写 baseUrl 是**插件内部**的写入：走 settings（Loader 路径）时由
    // updateViaSettings 标成 internalWrite，否则会命中「改出站地址就清凭据」
    // 的规则，把刚写进去的 record 又删掉。
    async function writeWechatBaseUrl(accountBase) {
      if (settingsApi && entryId) {
        try {
          await updateViaSettings(volatileProjection({ adapters: { wechat: { baseUrl: accountBase } } }))
        } catch (error) {
          recordError('wechat', error, 'ilink login baseUrl')
        }
        return
      }
      state.config.adapters.wechat.baseUrl = accountBase
      await saveConfig(state.config)
    }

    // ── 旧配置导入（P2b）：config.json → profile patch ─────────────────
    const legacySourcePath = () => configPathFor(configRoot)
    // 导入态直接用源文件改名表示（不另建 marker）：config.json → config.json.imported。
    const legacyImportedPath = () => legacySourcePath() + '.imported'

    function buildImportPatch(raw) {
      const patch = {}
      const dropped = []
      // 与 defaultConfig() 逐字段比（用文件自己的 workspaceRoot 兜底）：全部相等的
      // 文件就是“只有 runtime 骨架”/没有用户数据，不算可导入内容。
      const defaults = defaultConfig(String(raw.workspaceRoot || configRoot))
      for (const dotted of VOLATILE_CONFIG_PATHS) {
        const value = readPathValue(raw, dotted)
        if (value === undefined || value === null) continue
        if (deepEqualValues(value, readPathValue(defaults, dotted))) continue
        try {
          validateConfigValue(dotted, value)
        } catch (error) {
          dropped.push(dotted + ': ' + (error && error.message ? error.message : String(error)))
          continue
        }
        writePathValue(patch, dotted, value)
      }
      return { patch, dropped }
    }

    async function importLegacyConfig() {
      if (!settingsApi || !entryId) return 'blocked'
      if (existsSync(legacyImportedPath())) return 'done' // 已改名 = 已导入（幂等）
      if (!existsSync(legacySourcePath())) return 'absent'
      let raw
      try {
        raw = JSON.parse(readFileSync(legacySourcePath(), 'utf8'))
      } catch (error) {
        recordError(null, error, 'config import read')
        return 'blocked' // 解析不了：不改名、不写 profile，保留源文件
      }
      if (!isObject(raw)) return 'blocked'
      // 1) 微信 token → 凭据 record（先迁，失败就整体不开始：源文件与 token 原样保留）。
      const wechatSection = isObject(raw.adapters) && isObject(raw.adapters.wechat) ? raw.adapters.wechat : null
      const legacyToken = wechatSection && typeof wechatSection.token === 'string' ? wechatSection.token : ''
      let migratedToken = false
      if (legacyToken) {
        if (!credentialsApi) return 'blocked' // 凭据服务还没就绪：下次再试
        try {
          await writeWechatCredential(legacyToken)
        } catch (error) {
          recordError('wechat', error, 'config import credentials')
          return 'blocked' // 保留源文件与 token
        }
        migratedToken = true
        delete wechatSection.token // 成功后从旧文件里删掉（归档里也不留）
        state.wechatCredential = legacyToken
      }
      // 2) 只取用户改过、且能过 schema 校验的 volatile 字段：坏值逐字段丢弃并告警，
      //    其余照常导入；写入前再做一次完整校验。
      const { patch, dropped } = buildImportPatch(raw)
      const recordImportWarnings = async () => {
        if (!dropped.length) return
        // 导入触发的 rebuild 会清空 errors：等重建队列跑完再记，否则告警会被冲掉。
        await rebuildQueue.catch(() => {})
        for (const entry of dropped) recordError(null, 'config import dropped ' + entry, 'config import', false)
      }
      if (Object.keys(patch).length) {
        const check = Config['~standard'].validate(patch)
        if (check.issues && check.issues.length) {
          recordError(null, new Error('config import rejected by schema: ' + check.issues.map((issue) => issue.message).join('; ')), 'config import')
          await recordImportWarnings()
          return 'blocked' // 整体校验失败：源文件不动，下次重试
        }
      }
      // 3) 先改名再写 profile（照 importLegacyDocument 的 rename-first）：
      //    改名失败就中止，本轮不写 profile。
      try {
        if (migratedToken) {
          // 归档里不能留 token：先把剥掉 token 的内容落到 .imported，再删源文件。
          writeFileSync(legacyImportedPath(), JSON.stringify(raw, null, 2))
          unlinkSync(legacySourcePath())
        } else {
          renameSync(legacySourcePath(), legacyImportedPath())
        }
      } catch (error) {
        recordError(null, error, 'config import rename')
        await recordImportWarnings()
        return 'blocked' // 改名失败：源文件还在，下次重试
      }
      // 只有 runtime 骨架 / 全默认值的文件：已改名，但没有用户数据可导入。
      if (!Object.keys(patch).length) {
        await recordImportWarnings()
        return 'skipped'
      }
      // 4) 写 profile（不带 expectedRevision）；失败把 .imported 改回 config.json，
      //    下次启动重试。
      let failure = null
      try {
        await updateViaSettings(patch)
      } catch (error) {
        failure = error
      }
      await recordImportWarnings()
      if (failure) {
        recordError(null, failure, 'config import profile write')
        try {
          renameSync(legacyImportedPath(), legacySourcePath())
        } catch (restoreError) {
          recordError(null, restoreError, 'config import restore')
        }
        return 'failed'
      }
      return 'done'
    }

    function queueImport() {
      if (importStatus === 'done' || importStatus === 'skipped') return Promise.resolve(importStatus)
      if (importRunning) {
        // 上一轮可能因为缺凭据服务被 blocked：等它结束再试一次，否则两个服务
        // 同时注入时会把 blocked 当成终态。
        return importRunning.then(() => (importStatus === 'blocked' ? queueImport() : importStatus))
      }
      importRunning = importLegacyConfig()
        .then((status) => { importStatus = status; return status })
        .catch((error) => { recordError(null, error, 'config import'); importStatus = 'blocked'; return 'blocked' })
        .finally(() => { importRunning = null })
      return importRunning
    }

    // 可选注入：宿主没有 settings / credentials 时插件照常启动（降级路径见各调用点）。
    function optionalInject(name, assign) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject([name], (child) => {
        let service = null
        try { service = child.get ? child.get(name) : null } catch { service = null }
        if (!service) service = child[name]
        assign(service)
        if (typeof child.effect === 'function') child.effect(() => () => assign(null))
      })
    }

    function optionalImageService(name) {
      const bind = (child) => {
        let service
        try { service = child.get ? child.get(name) : undefined } catch { /* absent */ }
        if (!service) { try { service = child[name] } catch { /* absent */ } }
        if (!service || larkImagesStopped) return
        const binding = { service }
        larkImageServiceEpoch += 1
        clearLarkImageTool()
        larkImageServices[name] = binding
        registerLarkImageToolOnce()
        if (typeof child.effect === 'function') child.effect(() => () => {
          // An old optional scope may retire after its replacement is ready.
          if (larkImageServices[name] !== binding) return
          larkImageServiceEpoch += 1
          delete larkImageServices[name]
          clearLarkImageTool()
        })
      }
      if (typeof ctx.inject === 'function') ctx.inject([name], bind)
      else bind(ctx) // small standalone hosts without Cordis injection scopes
    }

    for (const name of ['tools', 'llm', 'attachments', 'sandboxPolicy']) optionalImageService(name)

    ctx.on('session/event', onSessionEvent)

    // 飞书实时帧：global:true 才能收到外部/复用 agent 的帧（会话被其他界面占用
    // 时消息并入那个 agent）；入口只处理已绑定的飞书会话，其余忽略。
    ctx.on('agent/assistant-stream', onLarkAssistantFrame, { global: true })
    // agent 销毁：只清自己的流状态，绝不 dispose 借用的 agent。
    ctx.on('agent/disposed', onLarkAgentDisposed, { global: true })
    ctx.on('agent/created', onLarkImageAgentCreated, { global: true })

    ctx.on('credentials/record-updated', (key) => {
      if (key !== WECHAT_CREDENTIAL_KEY) return
      enqueueRebuild(async () => {
        await refreshWechatCredential()
        // P2c：凭据变了只重建 wechat，其他渠道与它们的会话不受影响。
        await rebuildChannelsOnly(['wechat'])
      })
    })

    // 设置页改 volatile 字段：Loader 改写引用后广播该事件（fiber 不重启）。
    // P2b：先比对新旧快照做「改出站地址 → 清随行密钥」，再重建；按渠道增量重建
    // 留给 P2c。判定必须在 emit 当下同步取（internalWrite 异步就读不到了）。
    ctx.on('loader/volatile-update', () => {
      const snapshot = readLoaderConfig()
      if (!snapshot) return
      const previous = state.config
      const internal = internalWrite > 0
      enqueueRebuild(async () => {
        const latest = readLoaderConfig()
        if (!latest) return
        const next = materializeConfig(latest, configRoot, state.workspaceRoot)
        // P2c：按作用域增量重建；没变化就什么都不做。
        const { scopes } = await applyConfigUpdate(next)
        if (!scopes.size) return
        if (!previous) return
        const address = diffAddressSecrets(previous, next, { internal })
        if (!address.ops.length && !address.clearWechatRecord) return
        await applyAddressPolicy(address)
      })
    })

    // 可选服务注入必须排在上面三个监听器之后：导入一成功就会写 settings、
    // 触发首个 volatile-update，监听器还没挂上就会漏掉那次重建。
    // credentials 排在 settings 前面：导入第一步就要用它迁微信 token，先到位
    // 就不会白跑一次 blocked。
    if (typeof ctx.effect === 'function') ctx.effect(() => () => { messagingPresetStopped = true })
    for (const name of ['agentPresets', 'sessionProjections']) {
      if (typeof ctx.inject !== 'function') continue
      ctx.inject([name], (child) => {
        const binding = { service: child.get(name) }
        if (name === 'agentPresets') {
          messagingPresetBinding = binding
          messagingPresetSeen = true
        } else messagingProjectionBinding = binding
        child.effect(() => () => {
          if (name === 'agentPresets') {
            if (messagingPresetBinding === binding) messagingPresetBinding = null
          } else if (messagingProjectionBinding === binding) messagingProjectionBinding = null
        })
      })
    }
    optionalInject('sessions', (service) => { sessionsService = service })
    optionalInject('credentials', (service) => {
      credentialsApi = service
      if (!service) return
      refreshWechatCredential().catch(() => {})
      queueImport().catch(() => {}) // 之前因为缺凭据服务被 blocked 的导入，这里重试
    })
    optionalInject('settings', (service) => {
      settingsApi = service
      if (!service) return
      if (pendingAddressClears.length) flushAddressClears().catch(() => {})
      queueImport().catch(() => {})
    })

    function registerUiRoute(methods, path, handler) {
      const allowed = Array.isArray(methods) ? methods : [methods]
      const dispose = registerRoute(path, async (req, res) => {
        if (!allowed.includes(req.method)) {
          sendText(res, 405, 'method not allowed')
          return
        }
        if (!authenticateSameOrigin(req, res)) return
        let result
        try {
          result = await handler(req)
        } catch (error) {
          // UI 路由的抛错（ilink/login/*、/send 等）：error 文本先脱敏再回；
          // handler 可以用 error.status + error.publicMessage 指定公开状态码。
          if (res.headersSent) return
          const status = error && Number.isInteger(error.status) ? error.status : 500
          const body = error && error.publicMessage
            ? error.publicMessage
            : redactSecretText(error && error.message ? error.message : String(error), rememberSecretValues())
          sendJson(res, status, { ok: false, error: body })
          return
        }
        sendJson(res, 200, redactUiResponse(result))
      })
      // 必须随 fiber 注销：webServer 的 exact 路由是进程级注册表，停用插件时若不
      // 调 disposer，残留路由会让**再次启用**在首条注册就撞 "duplicate exact route"
      // （实测：disable→enable 后插件在本进程内永久无法激活）。
      ctx.effect(() => dispose)
      return dispose
    }

    // 静态 client 走这些同源端点；动态 RPC 通道已移除。
    // GET/POST 共用同一 path 时必须合成一条 exact 路由，否则后注册的会盖掉前者。
    registerUiRoute('GET', '/__dsh-messaging/status', async () => statusSnapshot())



    // P5 收口：`/__dsh-messaging/config`（GET/POST）已删除——配置的读写入口只剩官方
    // settings 通道（`settings.describe` → 页面 mirror；`settings.update` → loader/volatile-update
    // → diffAddressSecrets → 增量重建）。密钥的「已设置」状态来自 describe 的 secrets sidecar，
    // 不再有本插件自己的脱敏 GET 视图（role('secret') 的脱敏由 dsh-settings 负责）。
    registerUiRoute('POST', '/__dsh-messaging/reload', async () => {
      // P1 显式重开：先 close/drain 去重 store，rebuild 后 start 重新 open（清账本禁止）。
      await closeLarkDedupStore()
      // C-2：清恢复队列/计时器（attempts 保留→暂停语义跨 reload 连续；warm 重新种子）。
      if (larkRecoveryTimer) {
        clearTimeout(larkRecoveryTimer)
        larkRecoveryTimer = null
      }
      larkRecoveryQueue.clear()
      larkContentPayloads.clear()
      await enqueueRebuild(() => rebuildAll())
      return statusSnapshot()
    })
    registerUiRoute('POST', '/__dsh-messaging/send', async (req) => {
      const args = await readJsonBody(req)
      if (!isObject(args) || !args.channel || !args.conversation || args.text === undefined) {
        throw new Error('messaging_send requires channel, conversation, and text')
      }
      // 出站结果自带上游 stderr / HTTP body（可能回显命令行与 Authorization 头），
      // 返回前先过一遍出口过滤。
      return redactSecrets(await sendOutbound(args.channel, String(args.conversation), String(args.text), args.meta || {}))
    })
    // 显式权限刷新（UI 按钮）：与其它 UI 路由同一 same-origin 边界；单飞 + 5s 限频。
    // 响应只含白名单标量，不回显任何原始错误/URL/请求体/token。
    registerUiRoute('POST', '/__dsh-messaging/diagnostics/refresh-scope', async () => {
      const capturedGen = state.channelGeneration.lark || 0
      // 实例身份随请求捕获：跨 apply 的迟到响应必须带**旧实例**标记，绝不伪装新实例。
      const capturedEpoch = state.instanceEpoch
      const capturedView = diagSafe(() => larkDiag().permissionsView(Date.now())) || null
      const result = await larkScopeRead(state.larkRuntime, { force: true })
      if ((state.channelGeneration.lark || 0) !== capturedGen) {
        // 代已切换（reload）：旧响应不得冒充新代已刷新；固定 stale 结果，
        // generation/permissions/instanceEpoch 均为捕获时旧值，绝不与当前新代混拼。
        return { ok: false, refreshed: false, error: 'stale_generation', generation: capturedGen, instanceEpoch: capturedEpoch, permissions: capturedView }
      }
      const view = diagSafe(() => larkDiag().permissionsView(Date.now())) || null
      return {
        ok: result.ok === true,
        refreshed: result.ok === true,
        error: result.ok === true ? undefined : String(result.error || 'failed'),
        generation: capturedGen,
        instanceEpoch: capturedEpoch,
        permissions: view,
      }
    })
    registerUiRoute('POST', '/__dsh-messaging/ilink/login/start', async () => {
      try {
        return await startIlinkLogin()
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) }
      }
    })
    registerUiRoute('POST', '/__dsh-messaging/ilink/login/status', async (req) => {
      const args = await readJsonBody(req)
      return pollIlinkLoginStatus(args && args.sessionKey, args && args.verifyCode)
    })
    registerUiRoute('POST', '/__dsh-messaging/ilink/login/verify', async (req) => {
      const args = await readJsonBody(req)
      const login = args && args.sessionKey ? state.ilinkLogins[args.sessionKey] : null
      if (!login) return { ok: false, error: 'no active login' }
      login.pendingVerifyCode = String((args && args.verifyCode) || '')
      return { ok: true }
    })
    registerUiRoute('POST', '/__dsh-messaging/ilink/login/cancel', async (req) => {
      const args = await readJsonBody(req)
      if (args && args.sessionKey) delete state.ilinkLogins[args.sessionKey]
      return { ok: true }
    })

    ctx.effect(() => async () => {
      larkImagesStopped = true
      larkImageServiceEpoch += 1
      clearLarkImageTool()
      // 正常关闭卫生：清恢复队列/计时器/去重 lease/注册工具（apply 生命周期级；
      // reload 走 close/drain→重开，不置此标志）。
      state.larkDedupClosedForever = true
      if (larkRecoveryTimer) {
        clearTimeout(larkRecoveryTimer)
        larkRecoveryTimer = null
      }
      larkRecoveryQueue.clear()
      recoveryAttempts.clear()
      larkContentPayloads.clear()
      await closeLarkDedupStore()
      await disposeAdapters()
    })

    // 初次启动也排进重建队列：settings 注入后立刻触发的导入/事件可能已经排在
    // 前面，不串行就会出现两次 rebuildAll 并发拆建适配器。
    await enqueueRebuild(() => rebuildAll())
  }
