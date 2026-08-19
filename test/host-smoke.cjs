const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const root = path.resolve(__dirname, '..')
const hostSource = fs.readFileSync(path.join(root, 'dynamic', 'host.js'), 'utf8')

const tools = {}
const rpc = {}
const harness = {
  defineTool(tool) { return tool },
  registerTool(_ctx, tool) { tools[tool.name] = tool; return () => {} },
  handle(method, handler) { rpc[method] = handler; return () => {} },
}

const hostFactory = new Function('harness', hostSource)
const plugin = hostFactory(harness)

const routes = new Map()
const listeners = new Map()
const shellCalls = []
const writtenFiles = new Map()
const createdAgents = []

const fsService = {
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
}

const fakeShell = {
  resolve(request) {
    return request
  },
  async run(request) {
    shellCalls.push(request)
    if (request.command.includes('crypto-helper.cjs')) {
      const parts = request.command.split(/(?<!')\s+(?!')|\s+/)
      const secretIndex = parts.indexOf("'--secret'") >= 0 ? parts.indexOf("'--secret'") : parts.indexOf('--secret')
      const secretRaw = secretIndex >= 0 ? parts[secretIndex + 1] : ''
      const secret = secretRaw.replace(/^'|'$/g, '').replace(/''/g, "'")
      const input = JSON.parse(request.stdin || '{}')
      const crypto = require('node:crypto')
      const hmac = crypto.createHmac('sha1', secret).update(input.rawBody || '', 'utf8').digest('hex')
      const expected = 'sha1=' + hmac
      const match = input.signature === expected
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: request.timeoutMs || 60000,
        stdout: { text: JSON.stringify(match ? { ok: true } : { ok: false, error: 'mismatch' }), truncated: false },
        stderr: { text: '', truncated: false },
      }
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: request.timeoutMs || 60000,
      stdout: { text: '\n__DSH_STATUS__:200', truncated: false },
      stderr: { text: '', truncated: false },
    }
  },
  start(request) {
    return {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput() { return { delta: '', lossy: false } },
      kill() { return false },
    }
  },
}

const ctx = {
  get(name) {
    if (name === 'sandboxPolicy') return { workspaceRoot: '/mock/workspace' }
    return undefined
  },
  on(name, listener) { listeners[name] = listener; return () => {} },
  effect() { return () => {} },
  interval() { return () => {} },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  shell: fakeShell,
  fs: fsService,
  agents: {
    async create(options) {
      const agent = {
        id: options.sessionId,
        messages: [],
        followup(message) { agent.messages.push(message) },
      }
      const handle = {
        agent,
        async dispose() {},
      }
      createdAgents.push({ options, agent, handle })
      return handle
    },
  },
}

function fakeRequest(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body) {
      const bytes = Buffer.from(body)
      req.emit('data', bytes)
    }
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
  }
  res.end = (body) => {
    res.body = body
    res.finished = true
  }
  return res
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function main() {
  await plugin.apply(ctx)
  await tick()

  assert.equal(writtenFiles.size > 0, true, 'config should be written on first start')
  assert.equal(routes.has('/messaging/onebot'), true, 'onebot webhook should be registered')

  // Set mock secret for onebot adapter
  const config = await rpc.messaging_get_config()
  config.config.adapters.onebot.secret = 'test-secret-456'
  config.config.adapters.onebot.accessToken = 'test-token-789'
  await rpc.messaging_set_config(config.config)
  await tick()

  const onebotRoute = routes.get('/messaging/onebot')

  const samplePayload = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 1001,
    self_id: 999,
    raw_message: 'hello from smoke',
    sender: { user_id: 1001, nickname: 'smoke' },
  })

  // 1. Negative assertion: Non-application/json content-type (e.g. text/plain CSRF attempt) -> 415
  const csrfReq = fakeRequest('POST', '/messaging/onebot', samplePayload)
  csrfReq.headers = { 'content-type': 'text/plain' }
  const csrfRes = fakeResponse()
  await onebotRoute(csrfReq, csrfRes)
  await tick()
  assert.equal(csrfRes.statusCode, 415, 'text/plain request must return 415 unsupported media type')
  assert.equal(createdAgents.length, 0, 'no agent should be created for CSRF text/plain request')

  // 2. Negative assertion: Missing X-Signature when secret is configured -> 401
  const unauthReq = fakeRequest('POST', '/messaging/onebot', samplePayload)
  unauthReq.headers = { 'content-type': 'application/json' }
  const unauthRes = fakeResponse()
  await onebotRoute(unauthReq, unauthRes)
  await tick()
  assert.equal(unauthRes.statusCode, 401, 'request without X-Signature must return 401')
  assert.equal(createdAgents.length, 0, 'no agent should be created for unsigned request')

  // 3. Negative assertion: Invalid X-Signature -> 401
  const badReq = fakeRequest('POST', '/messaging/onebot', samplePayload)
  badReq.headers = {
    'content-type': 'application/json',
    'x-signature': 'sha1=0000000000000000000000000000000000000000',
  }
  const badRes = fakeResponse()
  await onebotRoute(badReq, badRes)
  await tick()
  assert.equal(badRes.statusCode, 401, 'request with bad X-Signature must return 401')
  assert.equal(createdAgents.length, 0, 'no agent should be created for bad signature request')

  // 4. Positive assertion: Valid X-Signature with application/json (fake-bot-server protocol)
  const crypto = require('node:crypto')
  const validHmac = crypto.createHmac('sha1', 'test-secret-456').update(samplePayload, 'utf8').digest('hex')
  const req = fakeRequest('POST', '/messaging/onebot', samplePayload)
  req.headers = {
    'content-type': 'application/json',
    'x-signature': 'sha1=' + validHmac,
    'x-self-id': '999',
  }
  const res = fakeResponse()
  await onebotRoute(req, res)
  await tick()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(createdAgents.length, 1, 'one agent should be created for the inbound message')
  assert.equal(createdAgents[0].agent.messages.length, 1)
  assert.equal(createdAgents[0].agent.messages[0].content[0].text, 'hello from smoke')

  const agentId = createdAgents[0].agent.id
  listeners['session/event']({ id: agentId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'hello back' }] } },
  })
  listeners['session/event']({ id: agentId }, {
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  })
  await tick()

  const outboundCurl = shellCalls.find((call) => call.command.includes('send_private_msg'))
  assert.equal(Boolean(outboundCurl), true, 'outbound reply should use curl')
  assert.equal(outboundCurl.command.includes('--data-binary'), true, 'outbound JSON body should be sent via curl stdin')

  const status = await rpc.messaging_status()
  const onebot = status.channels.find((channel) => channel.key === 'onebot')
  assert.equal(onebot.state, 'running')
  assert.equal(onebot.inboundCount, 1)
  assert.equal(onebot.outboundCount, 1)
  assert.equal(status.sessions.length, 1)
  assert.equal(status.sessions[0].conversation, 'private:1001')

  const toolResult = await tools.messaging_status.execute({})
  assert.equal(toolResult.channels.length, 7)
  const configResult = await rpc.messaging_get_config()
  assert.equal(configResult.config.adapters.onebot.enabled, true)

  console.log('host-smoke: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
