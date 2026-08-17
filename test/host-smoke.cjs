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

  const onebotRoute = routes.get('/messaging/onebot')
  const req = fakeRequest('POST', '/messaging/onebot', JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 1001,
    self_id: 999,
    raw_message: 'hello from smoke',
    sender: { user_id: 1001, nickname: 'smoke' },
  }))
  const res = fakeResponse()
  await onebotRoute(req, res)
  await tick()

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
