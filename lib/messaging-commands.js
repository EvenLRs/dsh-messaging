// Pure command grammar and bounded host-owned response formatting.
export const MODEL_USAGE = '用法：/model；/model list；/model switch [-p|-t] <编号 | 供应商id/模型id>'
export const COMMAND_HELP = '/help 查看帮助\n/stop 停止当前回复\n/new 开始新会话\n/status 查看状态\n/model 查看当前模型；/model list 列出模型；/model switch [-p|-t] <编号 | 供应商id/模型id> 切换模型'
export const COMMAND_TEXT = Object.freeze({ denied: '你没有执行此命令的权限', expired: '命令已过期，未执行', stopped: '已停止当前回复', idle: '当前没有进行中的回复', fresh: '已开始新会话，之前的对话仍保留在 DeepSeek Harness 中', busy: '当前正在回复，请稍后再切换', unavailable: '模型不可用', modelService: '模型服务暂不可用，请稍后重试', failed: '命令暂时无法执行，请稍后重试' })
export const validOpenId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(value)
export function parseMessagingCommand({ text, messageType, chatType, mentions = [], botOpenId, enabled = true }) {
  if (!enabled || messageType !== 'text' || !['p2p', 'group'].includes(chatType) || typeof text !== 'string') return null
  let source = text.trim(), addressed = false
  for (const mention of mentions) {
    if (botOpenId && mention?.id?.open_id === botOpenId && typeof mention.key === 'string' && /^@_user_\d+$/.test(mention.key) && source.includes(mention.key)) {
      source = source.split(mention.key).join(' '); addressed = true
    }
  }
  if (chatType === 'group' && !addressed) return null
  const match = source.trim().match(/^[\/／](help|stop|new|status|model)(?:\s+([\s\S]*))?$/i)
  if (!match || (match[2] && match[1].toLowerCase() !== 'model')) return null
  const name = match[1].toLowerCase(), argument = match[2]?.trim() || null
  if (name !== 'model') return { name, argument }
  if (!argument) return { name, argument, action: 'current' }
  const parts = argument.split(/\s+/)
  if (parts.length === 1 && /^list$/i.test(parts[0])) return { name, argument, action: 'list' }
  if (/^switch$/i.test(parts[0])) {
    let mode = 'p', target
    if (parts.length === 2) target = parts[1]
    if (parts.length === 3 && /^-[pt]$/i.test(parts[1])) { mode = parts[1].slice(1).toLowerCase(); target = parts[2] }
    if (target && !target.startsWith('-')) return { name, argument, action: 'switch', mode, target }
  }
  return { name, argument, action: 'usage' }
}
export const mutatingCommand = command => ['stop', 'new'].includes(command.name) || (command.name === 'model' && command.action === 'switch')
export function commandAllowed(command, chatType, senderOpenId, allowed = []) {
  return chatType === 'p2p' || (chatType === 'group' && (!mutatingCommand(command) || (validOpenId(senderOpenId) && allowed.includes(senderOpenId))))
}
export function commandExpired(command, createTime, now) {
  if (!(command.name === 'stop' || (command.name === 'model' && command.action === 'switch'))) return false
  const time = Number(createTime)
  return !Number.isFinite(time) || time <= 0 || time > now + 5000 || now - time > 60000
}
// Display values come from host metadata. Keep them on a single bounded line.
function displayLabel(value) {
  return typeof value === 'string' && value.trim() && value.length <= 100
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value.trim() : undefined
}

async function modelName(llm, selection, listedName) {
  const name = displayLabel(listedName)
  if (name && name !== selection.model) return name
  // The browser catalog uses listModels().name. Some adapters return an ID
  // there or omit the selection entirely, but resolve richer model metadata.
  try {
    const info = await llm.resolveModelInfo?.(selection.provider, selection.model)
    const resolvedName = displayLabel(info?.name)
    if (resolvedName && resolvedName !== selection.model) return resolvedName
  } catch { /* An unavailable model can still be displayed by its ID. */ }
  return undefined
}

async function currentModelLine(llm, selection) {
  if (!selection) return '当前模型：未知'
  let providerName, listedName
  try {
    const provider = (await llm.listProviders()).find(item => item?.id === selection.provider)
    providerName = displayLabel(provider?.name)
  } catch { /* Provider metadata is optional. */ }
  try {
    const model = (await llm.listModels(selection.provider)).find(item => item?.id === selection.model)
    listedName = model?.name
  } catch { /* An unlisted selection may still resolve. */ }
  const name = await modelName(llm, selection, listedName)
  return '当前模型：' + (providerName || displayLabel(selection.provider) || '未知')
    + '/' + (name || displayLabel(selection.model) || '未知')
}

function localStartTime(value) {
  if (value == null || value === '') return '未知'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '未知'
  const pad = n => String(n).padStart(2, '0')
  return String(date.getFullYear()).padStart(4, '0') + '-' + pad(date.getMonth() + 1)
    + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function uptimeLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未知'
  const hours = Math.floor(seconds / 3600)
  if (hours === 0) return '不到 1 小时'
  if (hours < 24) return hours + ' 小时'
  return Math.floor(hours / 24) + ' 天 ' + hours % 24 + ' 小时'
}

export async function commandModels(llm) {
  const result = []
  for (const provider of await llm.listProviders()) {
    const id = typeof provider === 'string' ? provider : provider.id
    if (!id) continue
    for (const model of await llm.listModels(id)) {
      if (!model?.id) continue
      result.push({ provider: id, model: model.id, name: model.name })
    }
  }
  return result
}
export function resolveCommandModel(models, argument) {
  if (/^[1-9]\d*$/.test(argument)) return models[Number(argument) - 1] || null
  return models.find(m => m.provider + '/' + m.model === argument) || null
}

export async function executeSessionCommand(command, env) {
  const check = () => { if (!env.current()) throw new Error('stale_command') }
  check()
  if (command.action === 'usage') return MODEL_USAGE
  if (!commandAllowed(command, env.chatType, env.senderOpenId, env.allowedOpenIds)) return COMMAND_TEXT.denied
  if (env.recovery && commandExpired(command, env.createTime, env.now())) return COMMAND_TEXT.expired
  if (command.name === 'help') return COMMAND_HELP
  if (command.name === 'new') { await env.newSession(); check(); return COMMAND_TEXT.fresh }
  let agent = env.getAgent()
  if (command.name === 'stop') {
    if (agent?.status !== 'running') return COMMAND_TEXT.idle
    agent.cancel({ kind: 'user' }, { keepInbox: true }); return COMMAND_TEXT.stopped
  }
  if (!agent && (command.name === 'status' || (command.name === 'model' && !command.argument))) {
    agent = await env.resumeAgent(false); check()
  }
  if (command.name === 'status' || command.action === 'current') {
    const model = await currentModelLine(env.llm, agent?.model?.current?.())
    check()
    if (command.action === 'current') {
      const pending = env.pendingModel?.()
      return model + (pending ? '\n下一条消息将使用：' + pending.provider + '/' + pending.model : '')
    }
    const start = env.startedAt() ?? agent?.session?.header?.createdAt
    const runtime = await env.runtimeInfo?.()
    check()
    const lines = [
      '会话状态：' + (agent ? agent.status === 'running' ? '正在回复' : '空闲' : '未加载'),
      model,
      '会话开始时间：' + localStartTime(start),
      'DeepSeek Harness：' + (runtime?.hostVersion || '未知') + '，已运行 ' + uptimeLabel(runtime?.uptime),
      'dsh-messaging：' + (runtime?.pluginVersion || '未知'),
    ]
    if (env.chatType === 'p2p' && validOpenId(env.senderOpenId)) lines.push('你的 open_id：' + env.senderOpenId)
    return lines.join('\n')
  }
  if (command.action === 'switch' && agent?.status === 'running') return COMMAND_TEXT.busy
  if (!env.llm) {
    env.reportFailure?.('model_catalog_unavailable')
    return COMMAND_TEXT.modelService
  }
  const models = await commandModels(env.llm); check()
  if (command.action === 'list') return models.slice(0,50).map((m,i) => (i+1) + ':' + m.provider + '/' + m.model).join('\n') + (models.length > 50 ? '\n仅显示前 50 个' : '') + '\n' + MODEL_USAGE
  const chosen = resolveCommandModel(models, command.target)
  if (!chosen) return COMMAND_TEXT.unavailable
  const selection = { provider: chosen.provider, model: chosen.model }
  try { await env.llm.resolveCallConfig(selection) } catch { return COMMAND_TEXT.unavailable }
  const name = await modelName(env.llm, selection, chosen.name)
  check()
  if (env.recovery && commandExpired(command, env.createTime, env.now())) return COMMAND_TEXT.expired
  if (!agent) { agent = await env.resumeAgent(); check() }
  if (env.recovery && commandExpired(command, env.createTime, env.now())) return COMMAND_TEXT.expired
  if (!agent || !env.agentCurrent(agent)) return COMMAND_TEXT.unavailable
  if (agent.status !== 'idle') return COMMAND_TEXT.busy
  if (env.switchModel) await env.switchModel(agent, selection, command.mode)
  else agent.model.select(selection)
  // Strict durability, not just an in-memory selection.
  if (await env.flush(agent) !== true) {
    env.reportFailure?.('model_flush_unconfirmed')
    return COMMAND_TEXT.failed
  }
  check()
  return '已切换为 ' + chosen.provider + '/' + chosen.model + (name ? '（' + name + '）' : '') + (command.mode === 't' ? '，仅下一条消息生效' : '，仅对当前会话生效')
}
