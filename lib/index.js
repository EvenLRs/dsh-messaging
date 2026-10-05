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
import { dirname, join } from 'node:path'
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
      agentPreset: 'standard',
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
    agentPreset: fieldText('standard'),
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

export async function apply(ctx, config) {
    const configRoot = resolveConfigRoot(ctx)
    const dshHomeRoot = resolveDshHomeRoot(ctx)
    // P2a 真源：Loader 传入的 config（volatile 字段是引用，热更新原地改写，fiber
    // 不重启）。未被 Loader 挂载时（老客户端直连、测试直接调用 apply(ctx)）为
    // null，继续读 ~/.dsh-messaging/config.json —— 这条兼容路径与 /config 路由
    // 一起保留到 P2b（旧文件导入/凭据迁移）。
    const loaderConfig = config === undefined ? null : config
    const readLoaderConfig = () => (loaderConfig ? unwrapVolatile(loaderConfig) : null)
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
      larkToken: null,
      wecomToken: null,
      wechatSeen: Object.create(null),
      wechatPolling: false,
      wechatUpdatesBuf: '',
      wechatContextTokens: Object.create(null),
      ilinkLogins: Object.create(null),
      discordProc: null,
      // 凭据 record 里的微信 token（P2b 起不进 Config）：只在内存里用于出站/扫码。
      wechatCredential: '',
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
      if (state.larkToken) push(state.larkToken.value)
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
        generation: state.generation,
        updatedAt: now(),
        configPath: state.configPath,
        channels: state.channels.map((channel) => ({ ...channel })),
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
      const reuse = (agent) => {
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
          const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
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
      const existing = state.conversationAgents[record.key]
      if (existing && existing.agent) {
        if (existing.owned) return existing.agent
        // 复用的外部 agent：每次复核还活着（对方关闭会话后要重新解析，
        // 否则会一直对着一个死 agent 发消息）。
        const live = typeof ctx.agents.get === 'function'
          ? ctx.agents.get(record.sessionId || sessionIdForKey(record.key))
          : undefined
        if (live === existing.agent) return existing.agent
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
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
        resolved = { handle, agent: handle.agent, owned: true }
      } catch (error) {
        if (error && error.name === 'SessionPersistenceNotFoundError') {
          const handle = await ctx.agents.create({
            sessionId,
            meta,
            agentOptions,
          })
          resolved = { handle, agent: handle.agent, owned: true }
        } else if (isSessionBusyError(error)) {
          resolved = await attachBusySession(sessionId, agentOptions, record)
        } else {
          throw error
        }
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
      return resolved.agent
    }

    function makeUserMessage(text) {
      state.messageSeq += 1
      return {
        id: 'dsh-msg-' + now() + '-' + state.messageSeq,
        role: 'user',
        content: [{ type: 'text', text: String(text || '') }],
        source: { kind: 'user' },
      }
    }

    async function inbound(channel, conversation, text, meta) {
      if (!String(text || '').trim()) return
      const status = channelStatus(channel)
      if (status) {
        status.enabled = true
        status.inboundCount += 1
        status.lastInboundAt = now()
      }
      const record = ensureSessionRecord(channel, conversation, meta)
      record.lastInboundAt = now()
      record.messageCount += 1
      recordRecent('inbound', {
        channel,
        conversation,
        text: textPreview(text),
        meta: record.meta || {},
      })
      try {
        const agent = await ensureAgent(record)
        agent.followup(makeUserMessage(text))
      } catch (error) {
        // 会话占用是「会话层」的冲突，不是适配器故障：不把渠道打进 error 状态，
        // 否则状态页会把排查引向连接（实机上就是这样被带偏的）。
        recordError(channel, error, 'agent followup', !isSessionBusyError(error))
      }
    }

    async function sendOutbound(channel, conversation, text, meta) {
      const adapter = state.adapters[channel]
      if (!adapter || typeof adapter.sendText !== 'function') {
        throw new Error('adapter not ready: ' + channel)
      }
      const record = ensureSessionRecord(channel, conversation, meta)
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
      if (event.type === 'assistant/message') {
        const record = state.sessionToConversation[session.id]
        if (!record) return
        const text = extractTextBlocks(event.data && event.data.message && event.data.message.content)
        if (text) state.turnBuffer[session.id] = (state.turnBuffer[session.id] || '') + text
      } else if (event.type === 'turn/end') {
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

    // Lark / Feishu
    async function larkAccessToken(cfg) {
      const token = state.larkToken
      if (token && token.expiresAt > now()) return token.value
      const response = await httpPostJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: cfg.appId,
        app_secret: cfg.appSecret,
      })
      if (!response.ok || !response.json || !response.json.tenant_access_token) {
        throw new Error(response.json && response.json.msg || response.stderr || ('HTTP ' + response.status))
      }
      state.larkToken = {
        value: response.json.tenant_access_token,
        expiresAt: now() + (Number(response.json.expire) || 7200) * 1000 - 60000,
      }
      return state.larkToken.value
    }

    async function larkDecrypt(cfg, encrypted) {
      const result = await companionRun('crypto-helper.cjs', ['lark', 'decrypt'], { encrypt: encrypted, key: cfg.encryptKey }, 15000)
      if (!result || result.ok !== true) throw new Error(result && result.error || 'lark decrypt failed')
      return safeJsonParse(result.json, null)
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
    function dispatchLarkEvent(event) {
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
      const text = larkMessageText(message, content)
      if (text === null) {
        dropLarkEvent('unsupported message_type', meta, null)
        return
      }
      if (!String(text).trim()) {
        dropLarkEvent('no text', meta, String(text).length)
        return
      }
      const chatId = message.chat_id || bodyChatId
      if (!chatId) {
        dropLarkEvent('no chatId', meta, String(text).length)
        return
      }
      inbound('lark', 'lark:' + chatId, String(text), {
        messageId: message.message_id,
        chatId,
        senderId: sender && sender.sender_id && sender.sender_id.open_id,
      })
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
          dispatchLarkEvent(data)
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

    function startLark(cfg) {
      const mode = cfg.mode === 'webhook' ? 'webhook' : 'long-connection'
      const disposers = []
      // 出站发送与订阅方式无关，两种入站方式共用。
      state.adapters.lark = {
        sendText: async (conversation, text) => {
          const token = await larkAccessToken(cfg)
          const target = String(conversation).replace(/^lark:/, '')
          const response = await httpPostJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
            receive_id: target,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          }, { Authorization: 'Bearer ' + token })
          return { ok: response.ok && response.json && response.json.code === 0, status: response.status, error: response.json && response.json.msg || response.stderr || (!response.ok ? 'HTTP ' + response.status : null) }
        },
      }

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
        const body = safeJsonParse(await readBody(req, 2 * 1024 * 1024), null)
        if (!body) return sendJson(res, 400, { ok: false, error: 'invalid json' })
        if (body.type === 'url_verification') return handleLarkEvent(cfg, body, res, false)
        if (body.encrypt) {
          try {
            const decrypted = await larkDecrypt(cfg, body.encrypt)
            if (decrypted) return handleLarkEvent(cfg, decrypted, res, true)
          } catch (error) {
            return sendJson(res, 401, { ok: false, error: 'decrypt failed' })
          }
        }
        return handleLarkEvent(cfg, body, res, false)
      }))
      setChannelState('lark', 'running', { path, encrypted: Boolean(cfg.encryptKey) })
      return disposers
    }

    function handleLarkEvent(cfg, event, res, wasEncrypted = false) {
      if (cfg.verificationToken) {
        if (!event || !event.token || !constantTimeEqual(event.token, cfg.verificationToken)) {
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
      if (event.type === 'url_verification') return sendJson(res, 200, { challenge: event.challenge })
      dispatchLarkEvent(event)
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
        state.larkToken = null
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

    ctx.on('session/event', onSessionEvent)

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
      await disposeAdapters()
    })

    // 初次启动也排进重建队列：settings 注入后立刻触发的导入/事件可能已经排在
    // 前面，不串行就会出现两次 rebuildAll 并发拆建适配器。
    await enqueueRebuild(() => rebuildAll())
  }
