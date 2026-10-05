'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P2a 回归：导出的 Config schema 必须能被 schemastery 解析、默认值与 defaultConfig
// 等价、密钥与表单字段的 role('secret')/volatile 元数据正确、非法值被拒。
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// Loader / Settings 只认这两个元数据：volatileForm()/isVolatilePath() 只投影
// volatile 字段（写非 volatile 路径直接抛 "is not volatile"），role('secret')
// 决定 describe 是否回传明文。
function leafPaths(node, prefix = [], out = []) {
  // schemastery 的 schema 是 function 实例（Object.setPrototypeOf(fn, Schema.prototype)），
  // 所以 typeof 判断必须把 function 也算进去。
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) return out
  if (node.dict && Object.keys(node.dict).length) {
    for (const key of Object.keys(node.dict)) leafPaths(node.dict[key], prefix.concat(key), out)
    return out
  }
  out.push({ path: prefix, meta: node.meta || {}, type: node.type })
  return out
}

function nodeAt(schema, parts) {
  let node = schema
  for (const key of parts) {
    assert.ok(node && node.dict && node.dict[key], 'schema is missing ' + parts.join('.'))
    node = node.dict[key]
  }
  return node
}

// Loader 传进来的 config 在 volatile 叶子上挂着引用（cosmokit 协议）。
function unwrapVolatile(value) {
  const WRITE = Symbol.for('cosmokit.volatile.write')
  if (value && typeof value === 'object' && WRITE in value) return unwrapVolatile(value.get())
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]))
  }
  return value
}

// schemastery 对「默认值为 null」的字段：值缺失时直接省略键（undefined ≡ null），
// 比较前把 null/undefined 一并抹掉，等价性只看真正有值的字段。
function stripNullish(value) {
  if (Array.isArray(value)) return value.map(stripNullish)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (child === null || child === undefined) continue
      out[key] = stripNullish(child)
    }
    return out
  }
  return value
}

function validate(config, value) {
  const result = config['~standard'].validate(value)
  return result.issues ? { issues: result.issues } : { value: result.value }
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  const { Config, defaultConfig, SECRET_FIELDS } = plugin

  // ── 1. Config 能被 schemastery 解析 ────────────────────────────────────────
  assert.ok(Config, 'lib/index.js must export Config at module top level')
  assert.equal(typeof Config.toJSON, 'function', 'Config must be a schemastery schema')
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.equal(plugin.apply.length, 2, 'apply must accept (ctx, config)')
  const empty = validate(Config, {})
  assert.equal(empty.issues, undefined, 'defaults must validate: ' + JSON.stringify(empty.issues))
  assert.ok(empty.value.adapters && empty.value.agent, 'the validated shape mirrors defaultConfig')

  // ── 2. 默认值与 defaultConfig 等价 ─────────────────────────────────────────
  const rootForDefaults = '/mock/workspace'
  const expected = defaultConfig(rootForDefaults)
  // P2b：微信 bot token 迁到凭据 record（dsh-messaging/wechat-bot）。Config 与
  // defaultConfig 都不再声明该字段——否则 Loader 路径下 GET 回来的 config 会带一个
  // 非 volatile 键，POST 时被 400 NON_VOLATILE_FIELD 拒掉；SECRET_FIELDS 仍保留它，
  // legacy config.json 里的旧值与出站错误消息还要靠它脱敏。
  const MOVED_TO_CREDENTIALS = ['adapters.wechat.token']
  assert.equal(expected.adapters.wechat.token, undefined, 'defaultConfig must not carry the migrated WeChat token either')
  delete expected.adapters.wechat.token
  const actual = unwrapVolatile(empty.value)
  // workspaceRoot / agent.cwd 依赖运行时根目录，不写进 schema default（由
  // materializeConfig 兜底），这里按同一语义补齐后再比。
  actual.workspaceRoot = actual.workspaceRoot || rootForDefaults
  actual.agent.cwd = actual.agent.cwd || actual.workspaceRoot
  assert.deepEqual(stripNullish(actual), stripNullish(expected), 'schema defaults must equal defaultConfig()')

  // 逐字段的键集合必须一致：漏一个字段就意味着 settings 表单少一项。
  const schemaLeaves = leafPaths(Config).map((entry) => entry.path.join('.'))
  const expectedLeaves = []
  const collectLeaves = (value, prefix = []) => {
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) collectLeaves(child, prefix.concat(key))
      else expectedLeaves.push(prefix.concat(key).join('.'))
    }
  }
  collectLeaves({ version: expected.version, workspaceRoot: expected.workspaceRoot, runtime: expected.runtime, agent: expected.agent, adapters: expected.adapters })
  assert.deepEqual(schemaLeaves.sort(), expectedLeaves.sort(), 'every defaultConfig field must be declared in Config')
  for (const movedPath of MOVED_TO_CREDENTIALS) {
    assert.equal(schemaLeaves.includes(movedPath), false, movedPath + ' must be gone from Config (moved to credentials)')
    assert.ok(SECRET_FIELDS[movedPath.split('.')[1]].includes(movedPath.split('.')[2]), movedPath + ' must stay in SECRET_FIELDS for redaction')
  }

  // ── 3. 密钥路径：与 SECRET_FIELDS 比对，全部 role('secret') + volatile ─────
  const leaves = leafPaths(Config)
  const secretPaths = leaves
    .filter((entry) => entry.meta.role === 'secret')
    .map((entry) => entry.path.join('.'))
    .sort()
  const declaredSecrets = []
  for (const channel of Object.keys(SECRET_FIELDS)) {
    for (const key of SECRET_FIELDS[channel]) {
      const dotted = 'adapters.' + channel + '.' + key
      if (MOVED_TO_CREDENTIALS.includes(dotted)) continue
      declaredSecrets.push(dotted)
    }
  }
  assert.deepEqual(secretPaths, declaredSecrets.sort(), 'role("secret") must cover exactly SECRET_FIELDS')
  for (const fieldPath of declaredSecrets) {
    const node = nodeAt(Config, fieldPath.split('.'))
    assert.equal(node.meta.role, 'secret', fieldPath + ' must be role("secret")')
    assert.equal(node.meta.volatile, true, fieldPath + ' must be volatile (settings cannot write it otherwise)')
  }

  // ── 4. 表单字段都是 volatile；安装环境派生值不是 ───────────────────────────
  const volatilePaths = leaves
    .filter((entry) => entry.meta.volatile)
    .map((entry) => entry.path.join('.'))
    .sort()
  const formPaths = []
  const ordinaryPaths = ['version', 'workspaceRoot']
  for (const [key, value] of Object.entries(expected.agent)) formPaths.push('agent.' + key)
  ordinaryPaths.push(...Object.keys(expected.runtime).map((key) => 'runtime.' + key))
  for (const channel of Object.keys(expected.adapters)) {
    for (const key of Object.keys(expected.adapters[channel])) formPaths.push('adapters.' + channel + '.' + key)
  }
  assert.deepEqual(volatilePaths, formPaths.sort(), 'every page-editable field must be volatile')
  for (const fieldPath of ordinaryPaths) {
    const node = nodeAt(Config, fieldPath.split('.'))
    assert.ok(!node.meta.volatile, fieldPath + ' is an install-derived value and must stay ordinary')
  }
  // 密钥必然也是表单字段（否则用户没法填）。
  for (const fieldPath of declaredSecrets) {
    assert.ok(volatilePaths.includes(fieldPath), fieldPath + ' must appear in the volatile form')
  }

  // ── 5. 真实配置能通过校验，密钥值原样保留 ──────────────────────────────────
  for (const fixture of ['config.example.json', 'config.json']) {
    const file = path.join(root, fixture)
    if (!fs.existsSync(file)) continue
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const parsed = validate(Config, raw)
    assert.equal(parsed.issues, undefined, fixture + ' must validate: ' + JSON.stringify(parsed.issues))
    const unwrapped = unwrapVolatile(parsed.value)
    for (const fieldPath of declaredSecrets) {
      const [, channel, key] = fieldPath.split('.')
      const stored = raw.adapters && raw.adapters[channel] ? raw.adapters[channel][key] : undefined
      if (stored === undefined) continue
      assert.equal(unwrapped.adapters[channel][key], stored, fixture + ' must keep ' + fieldPath)
    }
  }

  const withSecrets = stripNullish(unwrapVolatile(validate(Config, {
    adapters: {
      onebot: { enabled: true, secret: 'ob-secret-PLAINTEXT-0001', accessToken: 'ob-access-PLAINTEXT-0001' },
      telegram: { token: '8001234567:AAE-tgTokenPLAINTEXT0001', webhookSecret: 'tg-webhook-PLAINTEXT-0001' },
      lark: { appSecret: 'lark-appSecret-PLAINTEXT-0001' },
    },
  }).value))
  assert.equal(withSecrets.adapters.onebot.secret, 'ob-secret-PLAINTEXT-0001')
  assert.equal(withSecrets.adapters.telegram.webhookSecret, 'tg-webhook-PLAINTEXT-0001')
  assert.equal(withSecrets.adapters.lark.appSecret, 'lark-appSecret-PLAINTEXT-0001')

  // ── 6. 非法值被拒 ─────────────────────────────────────────────────────────
  const rejected = [
    ['malformed endpoint', { adapters: { onebot: { endpoint: 'not-a-url' } } }],
    ['endpoint without scheme', { adapters: { onebot: { endpoint: '127.0.0.1:5700' } } }],
    ['endpoint port above 65535', { adapters: { onebot: { endpoint: 'http://127.0.0.1:70000' } } }],
    ['webhook path without leading slash', { adapters: { telegram: { webhookPath: 'messaging/telegram' } } }],
    ['unknown mode', { adapters: { telegram: { mode: 'push' } } }],
    ['unknown lark mode', { adapters: { lark: { mode: 'longconnection' } } }],
    ['negative interval', { adapters: { telegram: { pollIntervalMs: -1 } } }],
    ['fractional interval', { adapters: { telegram: { pollIntervalMs: 2500.5 } } }],
    ['interval above the cap', { adapters: { telegram: { pollIntervalMs: 86400001 } } }],
    ['stdoutMaxBytes above 1 GiB', { runtime: { stdoutMaxBytes: 1099511627776 } }],
    ['non-boolean flag', { adapters: { telegram: { enabled: 'yes' } } }],
    ['non-numeric intents', { adapters: { discord: { intents: '33281' } } }],
    ['baseUrl without scheme', { adapters: { wechat: { baseUrl: 'ilinkai.weixin.qq.com' } } }],
  ]
  for (const [label, patch] of rejected) {
    const parsed = validate(Config, patch)
    assert.ok(parsed.issues, label + ' must be rejected')
  }

  // ── 7. 合法的边界值被接受 ─────────────────────────────────────────────────
  const accepted = validate(Config, {
    adapters: {
      onebot: { endpoint: 'http://[::1]:5700/api', selfId: 1001 },
      telegram: { mode: 'webhook', webhookPath: '/hooks/tg', pollIntervalMs: 86400000, longPollTimeoutSec: 86400 },
      lark: { mode: 'webhook' },
      wechat: { baseUrl: 'https://example.test:8443/' },
      discord: { intents: 2147483647 },
    },
  })
  assert.equal(accepted.issues, undefined, 'boundary values must be accepted: ' + JSON.stringify(accepted.issues))
  const acceptedValue = unwrapVolatile(accepted.value)
  assert.equal(acceptedValue.adapters.telegram.mode, 'webhook')
  assert.equal(acceptedValue.adapters.onebot.endpoint, 'http://[::1]:5700/api')

  // ── 8. role('secret') 被 dsh-settings 的结构化脱敏识别（可选依赖）──────────
  let redactedChecked = false
  try {
    const settings = await import('@deepseek-ai/dsh-settings')
    const redacted = settings.redactSecrets(Config, withSecrets)
    assert.equal(redacted.value.adapters.onebot.secret, undefined, 'redactSecrets must strip the secret')
    assert.equal(redacted.value.adapters.telegram.token, undefined, 'redactSecrets must strip the token')
    assert.equal(redacted.value.adapters.telegram.webhookPath, '/messaging/telegram/webhook', 'ordinary fields survive')
    const reported = new Set(redacted.secrets.map((entry) => entry.path.join('.')))
    assert.ok(reported.has('adapters.onebot.secret'), 'the sidecar must report the secret position')
    assert.ok(redacted.secrets.some((entry) => entry.set === true), 'the sidecar must report "has a value"')
    redactedChecked = true
  } catch (error) {
    console.log('config-schema: dsh-settings not importable, skipping redactSecrets check:', error.message)
  }

  console.log('config-schema: ok')
  console.log('schema fields:', schemaLeaves.length, '| volatile:', volatilePaths.length, '| secret:', secretPaths.length, '| redactSecrets checked:', redactedChecked)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
