const CHANNEL_DEFS = [
  { key: 'onebot', label: 'OneBot v11', kind: 'http' },
  { key: 'telegram', label: 'Telegram', kind: 'polling-or-http' },
  { key: 'discord', label: 'Discord', kind: 'gateway-ws' },
  { key: 'slack', label: 'Slack', kind: 'events-api' },
  { key: 'lark', label: 'Lark / Feishu', kind: 'events-api' },
  { key: 'wecom', label: 'WeCom', kind: 'callback' },
  { key: 'wechat', label: 'Personal WeChat', kind: 'bridge' },
]

// 配置根目录覆盖：启动壳会在注册前把本常量替换为用户主目录，
// 使配置与伴随脚本固定落在 ~/.dsh-messaging/（手动粘贴运行时保持空串 = 自动探测）。
const CONFIG_ROOT_OVERRIDE = ''

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

function hashString(value) {
  let hash = 0
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index)
    hash |= 0
  }
  return 'x' + Math.abs(hash).toString(16)
}

function safeSessionId(sessionKey) {
  const cleaned = String(sessionKey)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return 'dsh-msg-' + (cleaned || hashString(sessionKey))
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

return {
  name: 'dsh-messaging',
  inject: ['webServer', 'shell', 'fs', 'agents', 'timer', 'agentDefaultModel'],

  async apply(ctx) {
    const state = {
      config: null,
      workspaceRoot: '',
      configPath: '',
      generation: 0,
      messageSeq: 0,
      recent: [],
      errors: [],
      channels: [],
      sessions: Object.create(null),
      conversationAgents: Object.create(null),
      sessionToConversation: Object.create(null),
      turnBuffer: Object.create(null),
      adapters: Object.create(null),
      disposers: [],
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
    }

    function defaultConfig(root) {
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
            webhookPath: '/messaging/onebot',
            selfId: null,
          },
          telegram: {
            enabled: false,
            token: '',
            mode: 'polling',
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
            verificationToken: '',
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
            token: '',
            botAgent: 'dsh-messaging',
            pollIntervalMs: 2500,
            longPollTimeoutSec: 35,
          },
        },
      }
    }

    async function getFallbackRoot() {
      if (CONFIG_ROOT_OVERRIDE) return CONFIG_ROOT_OVERRIDE
      const policy = ctx.get('sandboxPolicy')
      if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
      if (policy && typeof policy.resolve === 'function') {
        const resolved = policy.resolve({})
        if (resolved && typeof resolved.workspaceRoot === 'string') return resolved.workspaceRoot
      }
      try {
        const target = await ctx.fs.resolve('.')
        if (target && typeof target.displayPath === 'string') return target.displayPath
      } catch {
        // Fall through to a relative fallback; session creation may still use config.agent.cwd.
      }
      return '.'
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

    async function writeJsonFile(path, value) {
      const target = await ctx.fs.resolve(path)
      await ctx.fs.writeText(target, JSON.stringify(value, null, 2))
    }

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
      if (detail !== undefined) channel.detail = detail
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

    function recordRecent(kind, entry) {
      state.recent.push(cleanJson({
        at: now(),
        kind,
        ...entry,
      }))
      if (state.recent.length > 120) state.recent.splice(0, state.recent.length - 120)
    }

    function recordError(channel, error, context) {
      const message = error instanceof Error ? error.message : String(error || 'unknown error')
      const status = channel ? channelStatus(channel) : null
      if (status) {
        status.lastError = message
        if (status.state === 'starting' || status.state === 'running') status.state = 'error'
      }
      state.errors.push(cleanJson({
        at: now(),
        channel: channel || null,
        message,
        context: context ? String(context) : null,
      }))
      if (state.errors.length > 50) state.errors.splice(0, state.errors.length - 50)
      recordRecent('error', { channel: channel || null, message })
    }

    function statusSnapshot() {
      return cleanJson({
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
      })
    }

    function sessionKey(channel, conversation) {
      return channel + ':' + conversation
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

    async function ensureAgent(record) {
      const existing = state.conversationAgents[record.key]
      if (existing && existing.agent) return existing.agent
      const sessionId = safeSessionId(record.key)
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
      const handle = await ctx.agents.create({
        sessionId,
        meta,
        agentOptions,
      })
      record.sessionId = sessionId
      record.agentId = handle.agent.id
      record.meta = deepMerge(record.meta || {}, {
        provider: agentOptions.provider || null,
        model: agentOptions.model || null,
      })
      record.meta = cleanJson(record.meta)
      state.sessionToConversation[sessionId] = record
      state.conversationAgents[record.key] = {
        handle,
        agent: handle.agent,
        record,
      }
      return handle.agent
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
        recordError(channel, error, 'agent followup')
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

    async function httpRequest(method, url, headers, body, options) {
      const opts = options || {}
      const timeoutMs = opts.timeoutMs || state.config.runtime.shellTimeoutMs || 60000
      const stdoutMaxBytes = Number(opts.stdoutMaxBytes || state.config.runtime.stdoutMaxBytes || 2 * 1024 * 1024)
      const timeoutSec = clamp(Math.ceil(timeoutMs / 1000), 1, 300)
      const parts = ['curl', '-sS', '--max-time', String(timeoutSec), '-X', String(method || 'GET')]
      for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue
        parts.push('-H', key + ': ' + value)
      }
      if (body !== undefined && body !== null) {
        parts.push('--data-binary', '@-')
      }
      parts.push('-w', '\n__DSH_STATUS__:%{http_code}')
      parts.push(url)
      const command = buildCommand(parts)
      const spec = ctx.shell.resolve({
        command,
        stdin: body === undefined || body === null ? undefined : String(body),
        timeoutMs,
        stdoutMaxBytes,
        sandboxPolicy: SHELL_SANDBOX_POLICY,
      })
      const result = await ctx.shell.run(spec)
      const stdout = (result.stdout && result.stdout.text) || ''
      const stderr = (result.stderr && result.stderr.text) || ''
      const marker = '\n__DSH_STATUS__:'
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

    function registerRoute(path, handler) {
      return ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      })
    }

    function companionCommand(script, args) {
      const nodePath = state.config.runtime.nodePath || 'node'
      const companionDir = state.config.runtime.companionDir || joinPath(state.workspaceRoot, '.dsh-messaging/companion')
      return buildCommand([nodePath, joinPath(companionDir, script), ...(args || [])])
    }

    async function companionRun(script, args, input, timeoutMs) {
      const result = await ctx.shell.run(ctx.shell.resolve({
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
      disposers.push(registerRoute(path, async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const body = safeJsonParse(await readBody(req, 4 * 1024 * 1024), null)
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
      setChannelState('onebot', 'running', { webhookPath: path, endpoint: cfg.endpoint })
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
        disposers.push(registerRoute(cfg.webhookPath || '/messaging/telegram/webhook', async (req, res) => {
          if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
          const body = safeJsonParse(await readBody(req, 4 * 1024 * 1024), null)
          if (body) processUpdate(body)
          sendJson(res, 200, { ok: true })
        }))
        setChannelState('telegram', 'running', { mode: 'webhook', path: cfg.webhookPath || '/messaging/telegram/webhook' })
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
          const generation = state.generation
          const timeoutSec = Number(cfg.longPollTimeoutSec || state.config.runtime.telegramLongPollTimeoutSec || 40)
          const offsetPart = state.telegramOffset ? '&offset=' + state.telegramOffset : ''
          httpGetJson(telegramApi(cfg, 'getUpdates') + '?timeout=' + timeoutSec + offsetPart, {}, { timeoutMs: (timeoutSec + 15) * 1000 })
            .then((response) => {
              if (generation !== state.generation) return
              if (!response.ok) throw new Error(response.json && response.json.description || response.stderr || ('HTTP ' + response.status))
              const updates = response.json && response.json.result
              if (Array.isArray(updates)) for (const update of updates) processUpdate(update)
              setChannelState('telegram', 'running', { mode: 'polling', pollIntervalMs: Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500) })
            })
            .catch((error) => {
              if (generation === state.generation) recordError('telegram', error, 'long poll')
            })
            .finally(() => {
              if (generation === state.generation) state.telegramPolling = false
            })
        }, clamp(Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500), 500, 60000)))
        setChannelState('telegram', 'running', { mode: 'polling', pollIntervalMs: Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500) })
      }
      return disposers
    }

    // Discord Gateway companion
    function startDiscord(cfg) {
      const disposers = []
      const modulePath = cfg.wsModulePath || state.config.runtime.wsModulePath
      const proc = ctx.shell.start(ctx.shell.resolve({
        command: companionCommand('discord-gateway.cjs', ['--ws-module', modulePath || 'ws']),
        stdin: JSON.stringify({ token: cfg.botToken, intents: cfg.intents || 33281 }),
        sandboxPolicy: SHELL_SANDBOX_POLICY,
      }))
      state.discordProc = proc
      disposers.push(ctx.effect(() => () => proc.kill()))
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
      disposers.push(registerRoute(path, async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const body = safeJsonParse(await readBody(req, 2 * 1024 * 1024), null)
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
      const result = await companionRun('crypto-helper.cjs', ['lark', 'decrypt', '--key', cfg.encryptKey], { encrypt: encrypted }, 15000)
      if (!result || result.ok !== true) throw new Error(result && result.error || 'lark decrypt failed')
      return safeJsonParse(result.json, null)
    }

    function startLark(cfg) {
      const disposers = []
      const path = cfg.webhookPath || '/messaging/lark/events'
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
      disposers.push(registerRoute(path, async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const body = safeJsonParse(await readBody(req, 2 * 1024 * 1024), null)
        if (!body) return sendJson(res, 400, { ok: false, error: 'invalid json' })
        if (body.type === 'url_verification') return sendJson(res, 200, { challenge: body.challenge })
        if (body.encrypt) {
          try {
            const decrypted = await larkDecrypt(cfg, body.encrypt)
            if (decrypted) return handleLarkEvent(cfg, decrypted, res)
          } catch (error) {
            return sendJson(res, 403, { ok: false, error: error.message })
          }
        }
        return handleLarkEvent(cfg, body, res)
      }))
      setChannelState('lark', 'running', { path, encrypted: Boolean(cfg.encryptKey) })
      return disposers
    }

    function handleLarkEvent(cfg, event, res) {
      if (cfg.verificationToken && event.token && event.token !== cfg.verificationToken) {
        return sendJson(res, 403, { ok: false, error: 'bad token' })
      }
      const callback = event.event || event
      if (callback.type === 'im.message.receive_v1') {
        const message = callback.message || {}
        const content = isObject(message.content) ? message.content : safeJsonParse(message.content, {})
        const text = content.text || content.content || ''
        const chatId = message.chat_id || callback.chat_id
        if (text && chatId) inbound('lark', 'lark:' + chatId, text, {
          messageId: message.message_id,
          chatId,
          senderId: message.sender && message.sender.sender_id && message.sender.sender_id.open_id,
        })
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
      disposers.push(registerRoute(path, async (req, res) => {
        const query = parseQuery(req.url)
        if (req.method === 'GET') {
          if (!cfg.encodingAESKey) return sendText(res, 200, query.echostr || '')
          try {
            const verified = await companionRun('crypto-helper.cjs', [
              'wecom', 'verify-echostr', '--token', cfg.token, '--aes-key', cfg.encodingAESKey, '--receiveid', cfg.corpId,
            ], {
              echostr: query.echostr || '',
              signature: query.msg_signature || '',
              timestamp: query.timestamp || '',
              nonce: query.nonce || '',
            }, 15000)
            if (!verified || verified.ok !== true) throw new Error(verified && verified.error || 'wecom signature verification failed')
            return sendText(res, 200, verified.decrypted)
          } catch (error) {
            return sendText(res, 403, error.message)
          }
        }
        if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
        const body = await readBody(req, 2 * 1024 * 1024)
        const encrypted = xmlTag(body, 'Encrypt')
        if (!encrypted) return sendText(res, 400, 'missing Encrypt')
        try {
          const decrypted = await companionRun('crypto-helper.cjs', [
            'wecom', 'decrypt', '--token', cfg.token, '--aes-key', cfg.encodingAESKey, '--receiveid', cfg.corpId,
          ], {
            encrypt: encrypted,
            signature: query.msg_signature || '',
            timestamp: query.timestamp || '',
            nonce: query.nonce || '',
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
          sendText(res, 403, error.message)
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
    function startWechat(cfg) {
      const disposers = []
      const baseUrl = trimTrailingSlash(cfg.baseUrl || 'https://ilinkai.weixin.qq.com')
      const token = cfg.token || ''
      const baseInfo = { channel_version: '1.0.0', bot_agent: cfg.botAgent || 'dsh-messaging' }

      state.adapters.wechat = {
        sendText: async (conversation, text) => {
          const target = String(conversation).replace(/^wechat:/, '')
          const contextToken = state.wechatContextTokens[conversation] || ''
          const payload = {
            msg: {
              to_user_id: target,
              ...(contextToken ? { context_token: contextToken } : {}),
              item_list: [{ type: 1, text_item: { text: String(text) } }],
            },
            base_info: baseInfo,
          }
          const response = await httpPostJson(joinUrl(baseUrl, 'ilink/bot/sendmessage'), payload, ilinkHeaders(token))
          const ret = response.json && typeof response.json.ret === 'number' ? response.json.ret : -1
          return {
            ok: response.ok && ret === 0,
            status: response.status,
            error: ret !== 0 ? (response.json && response.json.errmsg) || response.stderr || ('HTTP ' + response.status) : null,
          }
        },
      }

      const startLoop = () => {
        if (state.wechatPolling) return
        state.wechatPolling = true
        const loopGeneration = state.generation
        wechatPollLoop(cfg, baseUrl, token, baseInfo, loopGeneration)
          .catch((error) => {
            if (loopGeneration === state.generation) recordError('wechat', error, 'ilink long-poll loop')
          })
          .finally(() => {
            if (loopGeneration === state.generation) state.wechatPolling = false
          })
      }

      // Watchdog restarts the loop if it died; the loop itself is continuous.
      disposers.push(ctx.interval(startLoop, clamp(Number(cfg.pollIntervalMs || state.config.runtime.pollIntervalMs || 2500), 1000, 60000)))
      startLoop()

      setChannelState('wechat', 'running', { driver: 'ilink', baseUrl })
      return disposers
    }

    async function wechatPollLoop(cfg, baseUrl, token, baseInfo, loopGeneration) {
      while (state.wechatPolling && loopGeneration === state.generation) {
        const timeoutMs = Math.ceil((Number(cfg.longPollTimeoutSec || 35) + 15) * 1000)
        const payload = { get_updates_buf: state.wechatUpdatesBuf, base_info: baseInfo }
        const response = await httpPostJson(joinUrl(baseUrl, 'ilink/bot/getupdates'), payload, ilinkHeaders(token), { timeoutMs })
        if (loopGeneration !== state.generation) return
        if (!response.ok) {
          throw new Error((response.json && (response.json.errmsg || response.json.error)) || response.stderr || ('HTTP ' + response.status))
        }
        const body = response.json || {}
        if (body.ret !== undefined && body.ret !== 0) {
          if (body.ret === -14 || body.errcode === -14) {
            // Session expired: reset the sync cursor and retry after a short pause.
            state.wechatUpdatesBuf = ''
            await new Promise((resolve) => ctx.timeout(resolve, 2000))
            continue
          }
          throw new Error('getupdates ret=' + body.ret + ' errmsg=' + (body.errmsg || ''))
        }
        if (typeof body.get_updates_buf === 'string') state.wechatUpdatesBuf = body.get_updates_buf
        const msgs = Array.isArray(body.msgs) ? body.msgs : []
        for (const message of msgs) processIlinkMessage(message)
        setChannelState('wechat', 'running', { driver: 'ilink', baseUrl })
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
      const existingToken = state.config.adapters && state.config.adapters.wechat && state.config.adapters.wechat.token
      if (existingToken) localTokens.push(existingToken)
      const response = await httpPostJson(joinUrl(ILINK_BASE_URL, 'ilink/bot/get_bot_qrcode?bot_type=3'), { local_token_list: localTokens }, ilinkHeaders(''))
      if (!response.ok || !response.json || !response.json.qrcode) {
        throw new Error((response.json && response.json.errmsg) || response.stderr || ('HTTP ' + response.status))
      }
      return {
        qrcode: String(response.json.qrcode),
        qrcodeUrl: String(response.json.qrcode_img_content || ''),
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
        const wechatCfg = state.config.adapters.wechat
        wechatCfg.token = String(botToken)
        if (body.baseurl) wechatCfg.baseUrl = accountBase
        await saveConfig(state.config)
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
          return { status: 'failed', final: true, error: error.message }
        }
        return { status: 'expired', qrcodeUrl: login.qrcodeUrl }
      }
      if (status === 'verify_code_blocked') {
        login.pendingVerifyCode = undefined
        return { status: 'verify_code_blocked' }
      }
      return { status: status || 'wait' }
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
        else if (def.key === 'discord') disposers = startDiscord(cfg)
        else if (def.key === 'slack') disposers = startSlack(cfg)
        else if (def.key === 'lark') disposers = startLark(cfg)
        else if (def.key === 'wecom') disposers = startWecom(cfg)
        else if (def.key === 'wechat') disposers = startWechat(cfg)
        for (const disposer of disposers) state.disposers.push(disposer)
      } catch (error) {
        delete state.adapters[def.key]
        recordError(def.key, error, 'start adapter')
      }
    }

    async function disposeAdapters() {
      const disposers = state.disposers.splice(0).reverse()
      for (const disposer of disposers) {
        try {
          const result = disposer()
          if (result && typeof result.then === 'function') await result
        } catch (error) {
          // A single adapter disposer failure must not block the rest of teardown.
        }
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
      state.sessionToConversation = Object.create(null)
      state.sessions = Object.create(null)
      state.turnBuffer = Object.create(null)
      state.discordProc = null
      state.larkToken = null
      state.wecomToken = null
      state.telegramPolling = false
      state.wechatPolling = false
      state.wechatSeen = Object.create(null)
      state.wechatUpdatesBuf = ''
      state.wechatContextTokens = Object.create(null)
      state.ilinkLogins = Object.create(null)
    }

    async function rebuildAll(overrideConfig) {
      state.generation += 1
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
        state.config = await loadConfig()
        state.workspaceRoot = state.config.workspaceRoot
      }
      resetChannelStatuses()
      for (const def of CHANNEL_DEFS) await startAdapter(def)
      recordRecent('reload', { generation: state.generation })
    }

    ctx.on('session/event', onSessionEvent)

    harness.registerTool(ctx, harness.defineTool({
      name: 'messaging_status',
      description: 'Read the dsh-messaging gateway status: enabled channels, session mappings, and recent inbound/outbound/error events.',
      parameters: {
        channel: {
          type: 'string',
          description: 'Optional channel key to filter by: onebot, telegram, discord, slack, lark, wecom, or wechat.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const snapshot = statusSnapshot()
        if (args && args.channel) {
          snapshot.channels = snapshot.channels.filter((channel) => channel.key === args.channel)
          snapshot.sessions = snapshot.sessions.filter((session) => session.channel === args.channel)
          snapshot.recent = snapshot.recent.filter((event) => event.channel === args.channel || event.channel === null)
          snapshot.errors = snapshot.errors.filter((event) => event.channel === args.channel || event.channel === null)
        }
        return snapshot
      },
    }))

    harness.handle('messaging_status', async () => statusSnapshot())
    harness.handle('messaging_get_config', async () => ({ config: cleanJson(state.config) }))
    harness.handle('config-get', async () => ({ config: cleanJson(state.config) }))
    harness.handle('messaging_reload', async () => {
      await rebuildAll()
      return statusSnapshot()
    })
    harness.handle('messaging_set_config', async (args) => {
      if (!isObject(args)) throw new Error('config must be an object')
      const next = deepMerge(defaultConfig(state.workspaceRoot), args)
      next.workspaceRoot = String(args.workspaceRoot || state.workspaceRoot)
      next.agent.cwd = String((args.agent && args.agent.cwd) || next.workspaceRoot)
      await saveConfig(next)
      await rebuildAll(next)
      return statusSnapshot()
    })
    harness.handle('config-set', async (args) => {
      if (!isObject(args)) throw new Error('config must be an object')
      const next = deepMerge(defaultConfig(state.workspaceRoot), args)
      next.workspaceRoot = String(args.workspaceRoot || state.workspaceRoot)
      next.agent.cwd = String((args.agent && args.agent.cwd) || next.workspaceRoot)
      await saveConfig(next)
      await rebuildAll(next)
      return statusSnapshot()
    })
    harness.handle('messaging_send', async (args) => {
      if (!isObject(args) || !args.channel || !args.conversation || args.text === undefined) {
        throw new Error('messaging_send requires channel, conversation, and text')
      }
      const result = await sendOutbound(args.channel, String(args.conversation), String(args.text), args.meta || {})
      return result
    })
    harness.handle('ilink_login_start', async () => {
      try {
        return await startIlinkLogin()
      } catch (error) {
        return { ok: false, error: error.message }
      }
    })
    harness.handle('ilink_login_status', async (args) => {
      return pollIlinkLoginStatus(args && args.sessionKey, args && args.verifyCode)
    })
    harness.handle('ilink_login_verify', async (args) => {
      const login = args && args.sessionKey ? state.ilinkLogins[args.sessionKey] : null
      if (!login) return { ok: false, error: 'no active login' }
      login.pendingVerifyCode = String((args && args.verifyCode) || '')
      return { ok: true }
    })
    harness.handle('ilink_login_cancel', async (args) => {
      if (args && args.sessionKey) delete state.ilinkLogins[args.sessionKey]
      return { ok: true }
    })

    ctx.effect(() => async () => {
      await disposeAdapters()
    })

    await rebuildAll()
  },
}
