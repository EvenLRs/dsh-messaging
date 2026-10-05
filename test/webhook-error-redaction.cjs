'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P1c 回归：对外（外部平台回调）的错误体只回固定短语，UI 路由抛错 / 透传的
// 上游 error 文本必须脱敏，/send 的出站结果必须脱敏；扫码相关的字段原值返回。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const fixtureDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-webhook-'))

const routes = new Map()
const writtenFiles = new Map()
const shellCalls = []
// P5：command/argv 单独记录（不含 stdin 配置），供“argv 零密钥”清扫。
const shellArgvs = []

// 可切换的故障注入：
//  · companionFail —— crypto-helper 非零退出，stderr 回显整条命令行（含 --secret 等）
//  · httpLeaky     —— curl 失败，stderr 回显命令行（含 Authorization 头）
//  · staleStderr   —— 追加进 stderr 的陈旧密钥文本
let companionFail = false
let httpLeaky = false
let staleStderr = ''

const QR_PAYLOAD = 'https://liteapp.weixin.qq.com/q/abc123?token=QR-PAYLOAD-LEAK-0001'

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
    async run(request) {
      // P5：URL 进了 stdin 的 curl 配置，记录与分发都用「命令行 + 配置」。
      const command = String(request.command)
      const blob = command + '\n' + String(request.stdin || '')
      shellCalls.push(blob)
      shellArgvs.push(String(request.command))
      const ok = (text) => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        timeoutMs: request.timeoutMs || 60000,
        stdout: { text, truncated: false },
        stderr: { text: '', truncated: false },
      })
      const fail = (text) => ({
        exitCode: 1,
        timedOut: false,
        aborted: false,
        timeoutMs: request.timeoutMs || 60000,
        stdout: { text: '', truncated: false },
        stderr: { text, truncated: false },
      })
      if (blob.includes('crypto-helper.cjs')) {
        if (companionFail) return fail(command)
        return ok(JSON.stringify({
          ok: true,
          decrypted: 'echo-ok-123',
          xml: '<xml><MsgType>text</MsgType><FromUserName>wecom-user</FromUserName><Content>hi wecom</Content></xml>',
        }))
      }
      if (blob.includes('getMe')) return ok('{"ok":true,"result":{"id":777}}\n__DSH_STATUS__:200')
      // 泄露点 3 已修：命令行只剩 `curl --config -`，请求头与 URL 都在配置里；
      // 这里把配置一起吐进 stderr，用来验证状态接口确实会把它脱敏。
      if (httpLeaky) return fail('curl: (7) connection refused\n' + staleStderr + blob)
      if (blob.includes('get_bot_qrcode')) {
        return ok(JSON.stringify({ qrcode: 'QR-TEST-123', qrcode_img_content: QR_PAYLOAD }) + '\n__DSH_STATUS__:200')
      }
      return ok('\n__DSH_STATUS__:200')
    },
    start() {
      return { status: 'running', readOutput() { return { delta: '', lossy: false } }, kill() { return false } }
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
  agentDefaultModel: {
    currentSelection() { return null },
  },
  agents: {
    async resume() {
      const error = new Error('session not found')
      error.name = 'SessionPersistenceNotFoundError'
      throw error
    },
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
  const req = fakeRequest(method, (opts && opts.url) || routePath, opts)
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
const STATUS_ROUTE = '/__dsh-messaging/status'

const secrets = {
  onebotAccessToken: 'ob-access-PLAINTEXT-0001',
  onebotSecret: 'ob-secret-PLAINTEXT-0001',
  telegramWebhookSecret: 'tg-webhook-PLAINTEXT-0001',
  slackSigningSecret: 'slack-sign-PLAINTEXT-0001',
  wecomSecret: 'wecom-secret-PLAINTEXT-0001',
  wecomToken: 'wecom-token-PLAINTEXT-0001',
  wecomAesKey: 'wecom-aesKey-PLAINTEXT-0001',
  wechatToken: 'wechat-botToken-PLAINTEXT-0001',
  larkAppSecret: 'lark-appSecret-PLAINTEXT-0001',
  discordBotToken: 'discord-botToken-PLAINTEXT-0001',
}
const secretValues = Object.values(secrets)

function assertNoSecret(label, text) {
  for (const value of secretValues) {
    assert.equal(String(text).includes(value), false, label + ' must not contain ' + value)
  }
  assert.equal(String(text).includes('PLAINTEXT'), false, label + ' must not contain a PLAINTEXT marker')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// P5：配置的 HTTP 入口已删（/__dsh-messaging/config）。读 = config.json（loadConfig 的真源），
// 写 = 直写文件 + POST /reload；reload 的响应与旧 POST /config 同为 statusSnapshot，
// 所以下面所有出口断言（errors[] / channels[].lastError 的脱敏）原样成立。
function configFileEntry() {
  const entry = [...writtenFiles.keys()]
    .find((candidate) => candidate.replace(/\\/g, '/').includes('.dsh-messaging/config.json'))
  assert.ok(entry, 'config.json must exist after the first start')
  return entry
}

async function getConfig() {
  const entry = configFileEntry()
  const text = writtenFiles.get(entry)
  return { status: 200, json: { config: JSON.parse(text) }, text }
}

async function postConfig(body) {
  writtenFiles.set(configFileEntry(), JSON.stringify(body))
  return invoke('POST', '/__dsh-messaging/reload', { headers: loopbackHeaders(), body: '{}' })
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  const { qrSvgDataUrl } = await import(pathToFileURL(path.join(root, 'lib', 'qr-image.js')).href)
  const indexSource = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')

  await plugin.apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))

  // P5 收口回归：配置的 HTTP 读写入口必须已经消失。
  assert.equal(routes.has(CONFIG_ROUTE), false, 'the legacy config route must be gone (P5)')

  // 0) 灌配置：onebot/slack/wecom/telegram(webhook) 开启并带凭据。
  const seed = (await getConfig()).json.config
  Object.assign(seed.adapters.onebot, { enabled: true, secret: secrets.onebotSecret, accessToken: secrets.onebotAccessToken })
  Object.assign(seed.adapters.slack, { enabled: true, signingSecret: secrets.slackSigningSecret, botToken: 'slack-bot-PLAINTEXT-0001' })
  Object.assign(seed.adapters.wecom, {
    enabled: true,
    corpId: 'corp-test',
    agentId: '1000002',
    secret: secrets.wecomSecret,
    token: secrets.wecomToken,
    encodingAESKey: secrets.wecomAesKey,
  })
  Object.assign(seed.adapters.telegram, { enabled: true, mode: 'webhook', webhookSecret: secrets.telegramWebhookSecret })
  seed.adapters.wechat.token = secrets.wechatToken // 关闭状态下也要被脱敏
  seed.adapters.lark.appSecret = secrets.larkAppSecret
  seed.adapters.discord.botToken = secrets.discordBotToken
  secrets.slackBotToken = 'slack-bot-PLAINTEXT-0001'
  secretValues.push(secrets.slackBotToken)
  const seedRes = await postConfig(seed)
  assert.equal(seedRes.status, 200)
  assertNoSecret('POST /config (seed)', seedRes.text)
  for (const webhook of ['/messaging/onebot', '/messaging/slack/events', '/messaging/wecom/callback', '/messaging/telegram/webhook']) {
    assert.equal(routes.has(webhook), true, 'webhook must be registered: ' + webhook)
  }

  // 1) telegram：未通过 secret 校验 → 固定短语，401 语义不变。
  const tg = await invoke('POST', '/messaging/telegram/webhook', {
    headers: loopbackHeaders({ 'x-telegram-bot-api-secret-token': 'wrong' }),
    body: JSON.stringify({ update_id: 1 }),
  })
  assert.equal(tg.status, 401)
  assert.equal(tg.text, '{"ok":false,"error":"unauthorized"}', 'telegram keeps its fixed 401 body')
  assertNoSecret('telegram webhook 401', tg.text)

  // 2) onebot：companion 校验进程失败，stderr 回显整条命令行（含 --secret <真值>）。
  companionFail = true
  const obPayload = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 1001,
    self_id: 999,
    raw_message: 'hello',
    sender: { user_id: 1001, nickname: 'smoke' },
  })
  const obSignature = 'sha1=' + crypto.createHmac('sha1', secrets.onebotSecret).update(obPayload, 'utf8').digest('hex')
  const obRes = await invoke('POST', '/messaging/onebot', {
    headers: loopbackHeaders({ 'x-signature': obSignature, 'x-self-id': '999' }),
    body: obPayload,
  })
  assert.equal(obRes.status, 500, 'an unexpected webhook failure must be a 500')
  assert.equal(obRes.text, 'internal error', 'external callers only get a fixed phrase')
  assertNoSecret('onebot webhook failure body', obRes.text)

  const statusAfterOb = await invoke('GET', STATUS_ROUTE, { headers: loopbackHeaders() })
  assertNoSecret('GET /status after onebot failure', statusAfterOb.text)
  const obError = statusAfterOb.json.errors.find((entry) => entry.channel === 'onebot' && entry.context === 'webhook')
  assert.ok(obError, 'the detail must be recorded internally')
  assert.ok(obError.message.includes('onebot'), 'the internal record keeps the subcommand shape')
  assert.equal(obError.message.includes('--secret'), false, 'the companion argv no longer carries --secret')
  assert.equal(
    obError.message.includes(secrets.onebotSecret),
    false,
    'the secret rides stdin, so an echoed argv can never leak it',
  )
  const obChannel = statusAfterOb.json.channels.find((entry) => entry.key === 'onebot')
  assert.ok(obChannel.lastError, 'lastError mirrors the failure')
  assertNoSecret('onebot lastError', JSON.stringify(obChannel.lastError))

  // 3) slack：同一条路径，--signing-secret 不得出现在响应里。
  const slackRes = await invoke('POST', '/messaging/slack/events', {
    headers: loopbackHeaders({
      'x-slack-request-timestamp': '1700000000',
      'x-slack-signature': 'v0=deadbeef',
    }),
    body: JSON.stringify({ type: 'event_callback', event: { type: 'message', text: 'x', channel: 'C1' } }),
  })
  assert.equal(slackRes.status, 500)
  assert.equal(slackRes.text, 'internal error')
  assertNoSecret('slack webhook failure body', slackRes.text)
  companionFail = false

  // 4) wecom：失败只回 'forbidden'（403 语义不变），成功路径（回 echostr / 解密）
  //    必须原样可用。
  companionFail = true
  const wecomQuery = '?msg_signature=sig&timestamp=1700000000&nonce=n1&echostr=echo-payload'
  const wecomGetFail = await invoke('GET', '/messaging/wecom/callback', { url: '/messaging/wecom/callback' + wecomQuery })
  assert.equal(wecomGetFail.status, 403)
  assert.equal(wecomGetFail.text, 'forbidden', 'URL 校验失败只回固定短语')
  assertNoSecret('wecom echostr failure body', wecomGetFail.text)

  const wecomPostFail = await invoke('POST', '/messaging/wecom/callback', {
    url: '/messaging/wecom/callback' + wecomQuery,
    headers: loopbackHeaders(),
    body: '<xml><Encrypt>ciphertext</Encrypt></xml>',
  })
  assert.equal(wecomPostFail.status, 403)
  assert.equal(wecomPostFail.text, 'forbidden', '解密失败只回固定短语')
  assertNoSecret('wecom decrypt failure body', wecomPostFail.text)

  companionFail = false
  const wecomGetOk = await invoke('GET', '/messaging/wecom/callback', { url: '/messaging/wecom/callback' + wecomQuery })
  assert.equal(wecomGetOk.status, 200, '首次 URL 校验成功仍然回 echostr')
  assert.equal(wecomGetOk.text, 'echo-ok-123')
  const wecomPostOk = await invoke('POST', '/messaging/wecom/callback', {
    url: '/messaging/wecom/callback' + wecomQuery,
    headers: loopbackHeaders(),
    body: '<xml><Encrypt>ciphertext</Encrypt></xml>',
  })
  assert.equal(wecomPostOk.status, 200, '解密成功仍然 200')
  assert.equal(wecomPostOk.text, 'success')

  // 5) POST /send：出站结果里的上游 stderr（含 Authorization 头）必须脱敏。
  httpLeaky = true
  const sendRes = await invoke('POST', '/__dsh-messaging/send', {
    headers: loopbackHeaders(),
    body: JSON.stringify({ channel: 'onebot', conversation: 'private:1001', text: 'ping' }),
  })
  assert.equal(sendRes.status, 200)
  assertNoSecret('POST /send body', sendRes.text)
  assert.ok(sendRes.json.error.includes('***'), 'the outbound error must be masked: ' + sendRes.json.error)
  httpLeaky = false

  // 6) UI 路由抛错 → 500 + error 字段 + 出口抹密钥。
  //    （P5 迁移：原载体 /config POST 落盘失败已随路由删除；「消息里带密钥 → 抹成 ***」
  //     这一半由 §5 /send 与 §7 login/start 的在带断言继续守护，这里守护 500 形状本身。）
  const brokenSend = await invoke('POST', '/__dsh-messaging/send', {
    headers: loopbackHeaders(),
    body: JSON.stringify({ channel: 'onebot' }),
  })
  assert.equal(brokenSend.status, 500, 'a thrown UI handler must be a 500')
  assert.ok(brokenSend.json && brokenSend.json.error, 'the client still gets an error field')
  assertNoSecret('POST /send invalid body', brokenSend.text)

  // 7) UI 路由的**成功**响应里透传的上游 error 字符串（ilink login/start）同样要脱敏。
  httpLeaky = true
  staleStderr = 'gateway refused bot_token=' + secrets.wechatToken + '\n'
  const loginFail = await invoke('POST', '/__dsh-messaging/ilink/login/start', {
    headers: loopbackHeaders(),
    body: '{}',
  })
  assert.equal(loginFail.status, 200)
  assert.equal(loginFail.json.ok, false, 'login/start reports the failure in-band')
  assertNoSecret('ilink login/start failure body', loginFail.text)
  assert.ok(loginFail.json.error.includes('***'), 'the upstream error string must be masked: ' + loginFail.json.error)
  httpLeaky = false
  staleStderr = ''

  // 8) 扫码与配对码：qrcodeUrl 原值返回，pendingVerifyCode 不进值集合。
  const loginStart = await invoke('POST', '/__dsh-messaging/ilink/login/start', {
    headers: loopbackHeaders(),
    body: '{}',
  })
  assert.equal(loginStart.status, 200)
  assert.equal(loginStart.json.ok, true, 'the login flow must still start')
  assert.equal(
    loginStart.json.qrcodeUrl,
    qrSvgDataUrl(QR_PAYLOAD),
    'qrcodeUrl must be byte-identical: it is a UI image source',
  )
  const sessionKey = loginStart.json.sessionKey
  assert.ok(sessionKey)
  const verifyRes = await invoke('POST', '/__dsh-messaging/ilink/login/verify', {
    headers: loopbackHeaders(),
    body: JSON.stringify({ sessionKey, verifyCode: '424242' }),
  })
  assert.equal(verifyRes.status, 200)
  assert.equal(verifyRes.json.ok, true)

  const statusCall = await invoke('POST', '/__dsh-messaging/ilink/login/status', {
    headers: loopbackHeaders(),
    body: JSON.stringify({ sessionKey, verifyCode: '424242' }),
  })
  assert.equal(statusCall.status, 200)
  assert.ok(
    shellCalls.some((command) => command.includes('verify_code=424242')),
    'the pairing code must reach the gateway untouched (redaction never touches server-side logic)',
  )

  // 配对码是客户端自己提交的：它不得进入值集合，否则消息文本里的同一串数字会被打掉。
  const pairingPayload = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 1002,
    self_id: 999,
    raw_message: 'pairing 424242 confirmed',
    sender: { user_id: 1002, nickname: 'smoke' },
  })
  const pairingSig = 'sha1=' + crypto.createHmac('sha1', secrets.onebotSecret).update(pairingPayload, 'utf8').digest('hex')
  const pairingIn = await invoke('POST', '/messaging/onebot', {
    headers: loopbackHeaders({ 'x-signature': pairingSig, 'x-self-id': '999' }),
    body: pairingPayload,
  })
  assert.equal(pairingIn.status, 200)
  const finalStatus = await invoke('GET', STATUS_ROUTE, { headers: loopbackHeaders() })
  assertNoSecret('GET /status (final)', finalStatus.text)
  assert.ok(
    finalStatus.text.includes('pairing 424242 confirmed'),
    'the pairing code must not be masked in displayed message text',
  )

  // 9) 源码级守卫：这两处曾是对外回显内部错误的地方。
  assert.doesNotMatch(indexSource, /sendText\(res, 403, error\.message\)/, 'no webhook may echo error.message')
  assert.doesNotMatch(
    indexSource,
    /sendJson\(res, 500, \{ ok: false, error: error/,
    'the generic catch must not echo raw error messages',
  )
  assert.match(indexSource, /sendText\(res, 500, 'internal error'\)/, 'external failures answer with a fixed phrase')
  assert.match(indexSource, /redactUiResponse\(result\)/, 'UI responses must pass the redaction layer')

  // 9) P5：argv 清扫——每一次 shell 调用的 command/argv 都不得含密钥值（凭据只走 stdin）。
  assert.ok(shellArgvs.length > 0, 'the sweep must see recorded shell calls')
  for (const argv of shellArgvs) {
    assertNoSecret('shell argv', argv)
  }

  fs.rmSync(fixtureDshHome, { recursive: true, force: true })
  console.log('webhook-error-redaction: ok')
  console.log('shell argv swept:', shellArgvs.length)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
