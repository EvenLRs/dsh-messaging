'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P1 回归（P5 迁移版）：密钥明文绝不走 HTTP。
// 旧 GET /__dsh-messaging/config 已随 P5 收口删除，所以本文件守护的是**新路径**下的同一条不变量：
//   0) 配置的 HTTP 读写入口必须消失，掩码视图时代的产物（__clearSecrets / applySecretPolicy /
//      redactConfig）必须从源码里一起消失；
//   1) 磁盘仍是明文真源（脱敏只发生在出口）；
//   2) 插件的每一个 HTTP 出口（/status、/reload、/send …）都拿不到任何一个密钥值；
//   3) 覆盖位语义不变：空串 = 清空（写盘即清），缺省 = 不动（合并写盘时原值保留）。
// 「设置页那条通道」（settings.describe 脱敏视图 + settings.update 只收 ops + 非 volatile 拒收）
// 由 test/loader-integration.cjs（真实 SettingsForms）与 test/client-smoke.cjs（ops 构造）守护。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// 入站会触发会话 id 惰性迁移的存在性探测，绝不能指向真实家目录。
const fixtureDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-redaction-'))

const routes = new Map()
const writtenFiles = new Map()

const ctx = {
  get(name) {
    if (name === 'dshMessaging.root') return '/mock/workspace'
    if (name === 'sandboxPolicy') return { workspaceRoot: '/mock/workspace' }
    if (name === 'dsh.home') return fixtureDshHome
    return undefined
  },
  on() { return () => {} },
  effect() { return () => {} },
  interval() { return () => {} },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  shell: {
    resolve(request) { return request },
    async run() {
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        timeoutMs: 60000,
        stdout: { text: '\n__DSH_STATUS__:200', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
    start() {
      return { status: 'running', kill() { return false } }
    },
  },
  fs: {
    async resolve(filePath) { return { displayPath: filePath, targetKey: filePath } },
    async readText(target) {
      const existing = writtenFiles.get(target.displayPath)
      if (existing !== undefined) return existing
      const error = new Error('not found')
      error.code = 'FS_NOT_FOUND'
      throw error
    },
    async writeText(target, content) {
      writtenFiles.set(target.displayPath, content)
      return { version: 'v1' }
    },
  },
  agents: {
    async create(options) {
      return { agent: { id: options.sessionId, followup() {} }, async dispose() {} }
    },
  },
}

function fakeRequest(method, url, { body, headers } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers || {}
  req.socket = { encrypted: false }
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function fakeResponse() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = (status, headers) => {
    res.statusCode = status
    res.headers = headers || {}
    res.headersSent = true
  }
  res.end = (body) => {
    res.body = body
    res.finished = true
  }
  return res
}

async function invoke(method, routePath, opts) {
  const handler = routes.get(routePath)
  assert.ok(handler, 'missing route ' + routePath)
  const req = fakeRequest(method, routePath, opts)
  const res = fakeResponse()
  await handler(req, res)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  let json = null
  if (res.body) {
    try { json = JSON.parse(res.body) } catch { json = res.body }
  }
  return { status: res.statusCode, json, text: res.body }
}

function loopbackHeaders(extra) {
  return Object.assign({
    origin: 'http://127.0.0.1:3080',
    host: '127.0.0.1:3080',
    'content-type': 'application/json',
  }, extra || {})
}

const CONFIG_ROUTE = '/__dsh-messaging/config'

// 密钥全集（与 lib/index.js 的 SECRET_FIELDS 对齐；telegram.webhookSecret 只存在于
// 用户配置文件，defaultConfig 未声明，这里同样必须绝不出现在任何 HTTP 出口）。
const plaintext = {
  onebot: { accessToken: 'ob-access-PLAINTEXT', secret: 'ob-secret-PLAINTEXT' },
  telegram: { token: 'tg-token-PLAINTEXT', webhookSecret: 'tg-webhook-PLAINTEXT' },
  slack: {
    botToken: 'sl-bot-PLAINTEXT',
    signingSecret: 'sl-sign-PLAINTEXT',
    verificationToken: 'sl-verify-PLAINTEXT',
  },
  lark: {
    appSecret: 'lark-secret-PLAINTEXT',
    verificationToken: 'lark-verify-PLAINTEXT',
    encryptKey: 'lark-encrypt-PLAINTEXT',
  },
  wecom: {
    secret: 'wecom-secret-PLAINTEXT',
    token: 'wecom-token-PLAINTEXT',
    encodingAESKey: 'wecom-aes-PLAINTEXT',
  },
  wechat: { token: 'wechat-token-PLAINTEXT' },
}
// discord.botToken 故意留空，用来覆盖「未设置」这一侧。

const secretValues = []
for (const channel of Object.keys(plaintext)) {
  for (const key of Object.keys(plaintext[channel])) secretValues.push(plaintext[channel][key])
}

function secretPaths() {
  const paths = []
  for (const channel of Object.keys(plaintext)) {
    for (const key of Object.keys(plaintext[channel])) paths.push('adapters.' + channel + '.' + key)
  }
  return paths
}

function persistedConfig() {
  const key = [...writtenFiles.keys()]
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => entry.includes('.dsh-messaging/config.json'))
    .pop()
  assert.ok(key, 'the config file must have been written')
  const raw = writtenFiles.get(key) || writtenFiles.get(key.replace(/\//g, '\\'))
  return { raw, value: JSON.parse(raw) }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// 与 loadConfig 同语义的合并：base 落在 defaults 上，后写覆盖；缺省的键保持原值。
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return clone(patch)
  if (!isObjectLike(patch)) return patch
  const target = isObjectLike(base) ? clone(base) : {}
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    target[key] = isObjectLike(value) && isObjectLike(target[key])
      ? deepMerge(target[key], value)
      : (value === undefined ? target[key] : clone(value))
  }
  return target
}

function isObjectLike(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// P5：配置写 = 直写 config.json + POST /reload（线上等价路径：设置页保存 → settings.update
// → loader/volatile-update → 重建）。merge 语义对齐 loadConfig，所以「缺省 = 不动」成立。
async function postConfig(body) {
  const persisted = persistedConfig()
  const merged = deepMerge(persisted.value, body)
  const key = [...writtenFiles.keys()]
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => entry.includes('.dsh-messaging/config.json'))
    .pop()
  writtenFiles.set(key, JSON.stringify(merged))
  return invoke('POST', '/__dsh-messaging/reload', { headers: loopbackHeaders(), body: '{}' })
}

// 出口断言：插件的每个 HTTP 响应都不得出现任何密钥值与掩码时代的保留键。
async function assertNoExitSecret(hint) {
  const status = await invoke('GET', '/__dsh-messaging/status', { headers: loopbackHeaders() })
  assert.equal(status.status, 200, hint + ': status must be served')
  const reload = await invoke('POST', '/__dsh-messaging/reload', { headers: loopbackHeaders(), body: '{}' })
  assert.equal(reload.status, 200, hint + ': reload must be served')
  const send = await invoke('POST', '/__dsh-messaging/send', {
    headers: loopbackHeaders(),
    body: JSON.stringify({ channel: 'onebot', conversation: 'private:1001', text: 'probe' }),
  })
  const texts = [status.text, reload.text, send.text || JSON.stringify(send.json)]
  for (const text of texts) {
    for (const value of secretValues) {
      assert.equal(text.includes(value), false, hint + ': an exit leaks a secret: ' + value)
    }
    assert.equal(text.includes('__clearSecrets'), false, hint + ': the retired clear marker must not appear')
    assert.equal(text.includes('PLAINTEXT'), false, hint + ': no secret material at all')
  }
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  await plugin.apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))

  // 0) P5 收口：旧配置入口必须消失，掩码视图时代的产物必须从源码里一起消失。
  assert.equal(routes.has(CONFIG_ROUTE), false, 'the legacy config route must be gone (P5)')
  const libSource = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
  for (const relic of ['__clearSecrets', 'applySecretPolicy', 'redactConfig']) {
    assert.equal(libSource.includes(relic), false, relic + ' died with the config route (P5)')
  }
  const clientSource = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
  assert.equal(clientSource.includes(CONFIG_ROUTE), false, 'the client must not call the legacy config route (P5)')

  // 1) 首启把默认值落盘：密钥全空，且配置本体没有任何 HTTP 出口。
  let persisted = persistedConfig()
  for (const fieldPath of secretPaths()) {
    const [, channel, key] = fieldPath.split('.')
    const value = persisted.value.adapters[channel][key]
    assert.ok(value === undefined || value === '', fieldPath + ' starts unset')
  }
  await assertNoExitSecret('after first start')

  // 2) 写入全部密钥（直写 config.json + reload）。
  const seeded = clone(persisted.value)
  seeded.adapters.onebot.enabled = false // 关闭适配器：本测试只关心配置与出口。
  for (const channel of Object.keys(plaintext)) {
    Object.assign(seeded.adapters[channel], plaintext[channel])
  }
  const seededRes = await postConfig(seeded)
  assert.equal(seededRes.status, 200, 'seed reload must succeed: ' + String(seededRes.text))

  // 3) 磁盘必须有明文（脱敏只发生在出口），出口必须一个字都没有；非密钥字段正常读回。
  persisted = persistedConfig()
  for (const value of secretValues) {
    assert.equal(persisted.raw.includes(value), true, 'disk keeps the plaintext: ' + value)
  }
  await assertNoExitSecret('after seeding')
  assert.equal(persisted.value.adapters.telegram.webhookPath, '/messaging/telegram/webhook')
  assert.equal(persisted.value.adapters.lark.mode, 'long-connection')
  assert.equal(persisted.value.adapters.telegram.pollIntervalMs, 2500)
  assert.equal(routes.has(CONFIG_ROUTE), false, 'the config route never comes back')

  // 4) 普通字段更新；密钥缺省 = 不动（合并写盘原值保留）。
  const roundTrip = clone(persisted.value)
  roundTrip.adapters.telegram.pollIntervalMs = 4000
  delete roundTrip.adapters.wechat.token // 缺省也必须保留
  const roundTripRes = await postConfig(roundTrip)
  assert.equal(roundTripRes.status, 200, 'round trip must succeed: ' + String(roundTripRes.text))
  persisted = persistedConfig()
  for (const fieldPath of secretPaths()) {
    const [, channel, key] = fieldPath.split('.')
    assert.equal(
      persisted.value.adapters[channel][key],
      plaintext[channel][key],
      'persisted ' + channel + '.' + key + ' must survive an absent/empty write',
    )
  }
  assert.equal(persisted.value.adapters.telegram.pollIntervalMs, 4000, 'a normal field must update')
  await assertNoExitSecret('after round trip')

  // 5) 显式清空：空串写盘即清，其余密钥原样保留；掩码时代的保留键不得再出现。
  const clearing = clone(persisted.value)
  clearing.adapters.lark.encryptKey = ''
  const clearRes = await postConfig(clearing)
  assert.equal(clearRes.status, 200)
  persisted = persistedConfig()
  assert.equal(persisted.value.adapters.lark.encryptKey, '', 'the clear must reach the file')
  assert.equal(persisted.value.adapters.lark.appSecret, plaintext.lark.appSecret)
  assert.equal(persisted.value.adapters.lark.verificationToken, plaintext.lark.verificationToken)
  assert.equal('__clearSecrets' in persisted.value, false, 'the clear marker must not be persisted')
  await assertNoExitSecret('after clear')

  // 6) 覆盖写入：新值生效，并且立即进入出口脱敏范围。
  const overwrite = clone(persisted.value)
  overwrite.adapters.lark.encryptKey = 'lark-encrypt-ROTATED'
  assert.equal((await postConfig(overwrite)).status, 200)
  persisted = persistedConfig()
  assert.equal(persisted.value.adapters.lark.encryptKey, 'lark-encrypt-ROTATED', 'a typed value wins')
  await assertNoExitSecret('after rotation')

  // 7) 给原本为空的密钥赋值：正常更新，同样只在磁盘上。
  const fill = clone(persisted.value)
  fill.adapters.discord.botToken = 'dc-token-PLAINTEXT'
  assert.equal((await postConfig(fill)).status, 200)
  persisted = persistedConfig()
  assert.equal(persisted.value.adapters.discord.botToken, 'dc-token-PLAINTEXT')
  assert.equal(persisted.raw.includes('PLAINTEXT') || persisted.raw.includes('ROTATED'), true, 'secrets live on disk')
  await assertNoExitSecret('after fill')

  // 8) 清空后再回传空串：仍保持清空（合并语义不会把空串复活成旧值）。
  const clearAgain = clone(persisted.value)
  clearAgain.adapters.lark.encryptKey = ''
  assert.equal((await postConfig(clearAgain)).status, 200)
  persisted = persistedConfig()
  assert.equal(persisted.value.adapters.lark.encryptKey, '')

  fs.rmSync(fixtureDshHome, { recursive: true, force: true })
  console.log('config-redaction: ok')
  console.log('redacted secret fields:', secretPaths().length)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
