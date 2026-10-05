'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// P1b 回归：status 快照（GET /status、POST /config、POST /reload 共用 statusSnapshot）
// 不得把任何密钥发到浏览器——哪怕它藏在错误消息、事件文本、lastError 或 meta 里。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const fixtureDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-messaging-status-'))

const routes = new Map()
const writtenFiles = new Map()
const shellCalls = []
// P5：每次 shell 调用的 command/argv 单独记录一份（不含 stdin 配置），供“argv 零密钥”清扫。
const shellArgvs = []

// 三个可切换的“泄密场景”：
//  · leakyHttp  —— curl 失败，stderr 回显整条命令（含 -H 'Authorization: Bearer …'）
//  · staleStderr—— 额外拼进 stderr 的陈旧文本（模拟仍在跑的旧任务持有旧密钥）
//  · failSpawn  —— 后台进程起不来，异常消息回显 argv + stdin（stdin 里是 bot token）
let leakyHttp = false
let staleStderr = ''
let failSpawn = false

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
      // P5：URL/请求头进了 stdin 的 curl 配置，记录「命令行 + 配置」。
      shellCalls.push(String(request.command) + '\n' + String(request.stdin || ''))
      shellArgvs.push(String(request.command))
      // companion 校验走这里：成功返回 ok，否则入站永远过不了签名。
      if (String(request.command).includes('crypto-helper.cjs')) {
        return {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          timeoutMs: request.timeoutMs || 60000,
          stdout: { text: '{"ok":true}', truncated: false },
          stderr: { text: '', truncated: false },
        }
      }
      if (leakyHttp) {
        return {
          exitCode: 1,
          timedOut: false,
          aborted: false,
          timeoutMs: request.timeoutMs || 60000,
          stdout: { text: '', truncated: false },
          stderr: { text: 'curl: (7) connection refused\n' + staleStderr + request.command + '\n' + String(request.stdin || ''), truncated: false },
        }
      }
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        timeoutMs: request.timeoutMs || 60000,
        stdout: { text: '\n__DSH_STATUS__:200', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
    start(request) {
      if (failSpawn) {
        // 真实故障里，spawn 失败常常连命令行和负载一起抛出来。
        throw new Error('spawn failed: cmd=' + request.command + ' payload=' + request.stdin)
      }
      return {
        status: 'running',
        readOutput() { return { delta: '', lossy: false } },
        kill() { return false },
      }
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
  // 入站消息会建会话：resume 必须抛 SessionPersistenceNotFoundError 才会落到
  // create，否则 ensureAgent 会把错误记进 errors[]，把待验证的信号淹掉。
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
      return {
        agent: { id: options.sessionId, followup() {} },
        async dispose() {},
      }
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
const STATUS_ROUTE = '/__dsh-messaging/status'

// 配置里的密钥（全部带可识别子串 PLAINTEXT，便于做“一处都没有”的兜底断言）。
const seeded = {
  onebot: { enabled: true, accessToken: 'ob-access-PLAINTEXT-0001', secret: 'ob-secret-PLAINTEXT-0001' },
  telegram: { token: '8001234567:AAE-tgTokenPLAINTEXT0001' },
  discord: { botToken: 'discord-botToken-PLAINTEXT-0001' },
  slack: { signingSecret: 'slack-sign-PLAINTEXT-0001' },
  lark: { appSecret: 'lark-appSecret-PLAINTEXT-0001' },
  wecom: {
    secret: 'wecom-secret-PLAINTEXT-0001',
    token: 'wecom-token-PLAINTEXT-0001',
    encodingAESKey: 'wecom-aesKey-PLAINTEXT-0001',
  },
  wechat: { token: 'wechat-botToken-PLAINTEXT-0001' },
}
const WECOM_SECRET_OLD = seeded.wecom.secret
const WECOM_SECRET_NEW = 'wecom-secret-ROTATED-0002'
// 不在配置里、只能靠模式匹配命中的“运行时令牌”。
const RUNTIME_ACCESS_TOKEN = 'RT-UNKNOWN-TOKEN-XYZ99'
const RUNTIME_BEARER = 'RT-BEARER-UNKNOWN-7788'

function allConfiguredSecrets() {
  const values = []
  for (const channel of Object.keys(seeded)) {
    for (const key of Object.keys(seeded[channel])) {
      if (typeof seeded[channel][key] === 'string') values.push(seeded[channel][key])
    }
  }
  return values
}

function assertNoPlaintext(label, text, extra) {
  for (const value of allConfiguredSecrets().concat(extra || [])) {
    assert.equal(text.includes(value), false, label + ' must not contain ' + value)
  }
  assert.equal(text.includes('PLAINTEXT'), false, label + ' must not contain any PLAINTEXT marker')
  assert.equal(text.includes('ROTATED'), false, label + ' must not contain the rotated value either')
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

async function getStatus() {
  return invoke('GET', STATUS_ROUTE, { headers: loopbackHeaders() })
}

async function postOnebotMessage(text) {
  const payload = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 1001,
    self_id: 999,
    raw_message: text,
    sender: { user_id: 1001, nickname: 'smoke' },
  })
  const signature = 'sha1=' + crypto.createHmac('sha1', seeded.onebot.secret).update(payload, 'utf8').digest('hex')
  return invoke('POST', '/messaging/onebot', {
    headers: loopbackHeaders({
      'x-signature': signature,
      'x-self-id': '999',
    }),
    body: payload,
  })
}

async function main() {
  const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  await plugin.apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))

  // P5 收口回归：配置的 HTTP 读写入口必须已经消失。
  assert.equal(routes.has(CONFIG_ROUTE), false, 'the legacy config route must be gone (P5)')

  // 1) 灌入全部密钥（onebot 开启并带 secret，这样入站 webhook 会被注册）。
  const base = (await getConfig()).json.config
  for (const channel of Object.keys(seeded)) {
    Object.assign(base.adapters[channel], seeded[channel])
  }
  const seededRes = await postConfig(base)
  assert.equal(seededRes.status, 200)
  assertNoPlaintext('POST /config (seed)', seededRes.text)
  assert.equal(routes.has('/messaging/onebot'), true, 'onebot webhook must be registered')

  // 2) 出站失败：stderr 回显整条 curl 命令，其中含 -H 'Authorization: Bearer <token>'。
  leakyHttp = true
  const sendRes = await invoke('POST', '/__dsh-messaging/send', {
    headers: loopbackHeaders(),
    body: JSON.stringify({ channel: 'onebot', conversation: 'private:1001', text: 'ping' }),
  })
  assert.equal(sendRes.status, 200)
  leakyHttp = false

  let status = await getStatus()
  assert.equal(status.status, 200)
  assertNoPlaintext('GET /status (after outbound failure)', status.text)
  assert.ok(status.text.includes('***'), 'the leak must be replaced by ***')
  assert.ok(
    status.text.includes('Bearer ***') || status.text.includes('Authorization: Bearer ***'),
    'the Authorization header must be masked',
  )
  const onebotChannel = status.json.channels.find((entry) => entry.key === 'onebot')
  assert.equal(onebotChannel.detail.endpoint, 'http://127.0.0.1:5700', 'non-secret detail stays intact')
  assert.equal(onebotChannel.detail.webhookPath, '/messaging/onebot', 'non-secret detail stays intact')
  assert.ok(onebotChannel.lastError, 'the outbound failure must be recorded')
  assertNoPlaintext('channels[].lastError', JSON.stringify(onebotChannel.lastError))
  const outboundError = status.json.errors.find((entry) => entry.context === 'outbound')
  assert.ok(outboundError, 'the outbound error must be in errors[]')
  assert.ok(outboundError.message.includes('***'), 'the recorded message must be redacted')
  const outboundRecent = status.json.recent.find((entry) => entry.kind === 'error' && entry.channel === 'onebot')
  assert.ok(outboundRecent, 'the error must be mirrored into recent[]')
  assertNoPlaintext('recent[] (error mirror)', JSON.stringify(outboundRecent))

  // 3) 入站消息文本进 recent：telegram URL / corpsecret / Bearer / --token --aes-key
  //    命令行，以及只能靠模式匹配命中的运行时令牌。
  const messages = [
    'tg url https://api.telegram.org/bot8001234567:AAE-tgTokenPLAINTEXT0001/getUpdates failed',
    'runtime access_token=' + RUNTIME_ACCESS_TOKEN + ' corpsecret=' + seeded.wecom.secret
      + ' and Bearer ' + RUNTIME_BEARER,
    'cmd node crypto-helper.cjs wecom decrypt --token ' + seeded.wecom.token
      + ' --aes-key ' + seeded.wecom.encodingAESKey + ' done',
    'header Authorization: Bearer ' + seeded.slack.signingSecret + ' end',
    'plain message stays intact hello world',
  ]
  for (const message of messages) {
    assert.ok(message.length < 140, 'textPreview truncates at 140 chars: ' + message)
    const inboundRes = await postOnebotMessage(message)
    assert.equal(inboundRes.status, 200, 'the inbound webhook must accept the signed payload')
  }

  status = await getStatus()
  assertNoPlaintext('GET /status (after inbound)', status.text, [RUNTIME_ACCESS_TOKEN, RUNTIME_BEARER])
  assert.ok(status.text.includes('plain message stays intact hello world'), 'ordinary message text must survive')
  const session = status.json.sessions.find((entry) => entry.conversation === 'private:1001')
  assert.ok(session, 'the session must exist')
  assert.equal(session.conversation, 'private:1001', 'conversation ids are not secrets')
  assert.ok(session.messageCount >= 5, 'counts are not secrets')
  const inboundTexts = status.json.recent
    .filter((entry) => entry.kind === 'inbound')
    .map((entry) => entry.text)
  assert.ok(inboundTexts.length >= 5, 'every inbound message must be in recent')
  assert.ok(inboundTexts.includes('plain message stays intact hello world'))
  assert.ok(
    inboundTexts.some((text) => text.includes('/bot***/getUpdates')),
    'the telegram bot URL must be masked',
  )
  assert.ok(
    inboundTexts.some((text) => text.includes('access_token=***')),
    'an unknown runtime token must be masked by the pattern layer',
  )
  assert.ok(
    inboundTexts.some((text) => text.includes('Bearer ***')),
    'an unknown bearer token must be masked by the pattern layer',
  )
  assert.ok(
    inboundTexts.some((text) => text.includes('--token ***') && text.includes('--aes-key ***')),
    'companion command line flags must be masked',
  )
  assert.ok(
    inboundTexts.some((text) => text.includes('corpsecret=***')),
    'the wecom corpsecret must be masked',
  )
  assert.ok(
    inboundTexts.some((text) => text.includes('Authorization: Bearer ***')),
    'the Authorization header in message text must be masked',
  )

  // 4) POST /config 的响应同样是 statusSnapshot：起适配器失败时错误会被写进快照，
  //    异常消息里带着 stdin 中的 discord bot token，出口必须拦住。
  failSpawn = true
  const discordConfig = clone((await getConfig()).json.config)
  discordConfig.adapters.discord.enabled = true
  const discordRes = await postConfig(discordConfig)
  assert.equal(discordRes.status, 200)
  assertNoPlaintext('POST /config (start failure)', discordRes.text)
  assert.ok(discordRes.text.includes('***'), 'the start failure must be recorded and masked')
  const discordError = discordRes.json.errors.find((entry) => entry.channel === 'discord')
  assert.ok(discordError, 'startAdapter must record the failure into the snapshot')
  assert.ok(discordError.message.includes('***'), 'the recorded message must be masked')
  const discordChannel = discordRes.json.channels.find((entry) => entry.key === 'discord')
  assertNoPlaintext('POST /config channels[].lastError', JSON.stringify(discordChannel.lastError))

  // 5) POST /reload 与之同构，同样必须脱敏。
  const reloadRes = await invoke('POST', '/__dsh-messaging/reload', {
    headers: loopbackHeaders(),
    body: '{}',
  })
  assert.equal(reloadRes.status, 200)
  assertNoPlaintext('POST /reload', reloadRes.text)
  assert.ok(reloadRes.json.errors.some((entry) => entry.channel === 'discord' && entry.message.includes('***')))

  // 6) 配置轮换后，旧密钥必须继续被覆盖（旧值只存在于历史值集合里）。
  failSpawn = false
  const rotated = clone((await getConfig()).json.config)
  rotated.adapters.wecom.secret = WECOM_SECRET_NEW
  rotated.adapters.discord.enabled = false
  const rotateRes = await postConfig(rotated)
  assert.equal(rotateRes.status, 200)
  assertNoPlaintext('POST /config (after rotation)', rotateRes.text)

  staleStderr = 'stale job still holds old=' + WECOM_SECRET_OLD + ' new=' + WECOM_SECRET_NEW + '\n'
  leakyHttp = true
  await invoke('POST', '/__dsh-messaging/send', {
    headers: loopbackHeaders(),
    body: JSON.stringify({ channel: 'onebot', conversation: 'private:1001', text: 'ping again' }),
  })
  leakyHttp = false
  staleStderr = ''

  status = await getStatus()
  assertNoPlaintext('GET /status (after rotation)', status.text)
  const rotatedError = status.json.errors.find((entry) => entry.context === 'outbound')
  assert.ok(rotatedError, 'the post-rotation error must be recorded')
  assert.ok(
    rotatedError.message.includes('old=***') && rotatedError.message.includes('new=***'),
    'both the retired and the current secret must be masked: ' + rotatedError.message,
  )

  // 7) 普通文本/非密钥字段全程保持不变。
  assert.equal(status.json.configPath, '/mock/workspace/.dsh-messaging/config.json')
  assert.equal(status.json.generation >= 1, true)
  assert.ok(
    status.json.recent.some((entry) => entry.kind === 'reload'),
    'non-secret events survive',
  )

  // 8) P5：argv 清扫——凭据只能走 stdin；把每一次 shell 调用的 command/argv 与
  //    SECRET_FIELDS 全量种子 + 运行时令牌对照，一个都不许出现。
  assert.ok(shellArgvs.length > 0, 'the sweep must see recorded shell calls')
  for (const argv of shellArgvs) {
    assertNoPlaintext('shell argv', argv, [RUNTIME_ACCESS_TOKEN])
  }

  fs.rmSync(fixtureDshHome, { recursive: true, force: true })
  console.log('status-redaction: ok')
  console.log('redacted events checked:', status.json.recent.length, 'recent,', status.json.errors.length, 'errors')
  console.log('shell argv swept:', shellArgvs.length)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
