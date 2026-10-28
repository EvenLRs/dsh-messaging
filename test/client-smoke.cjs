'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const clientSource = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const exampleConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'))
const fixtureConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))

assert.equal(pkg.name, 'dsh-messaging')
assert.equal(pkg.exports['./client'], './lib/client.js')
assert.equal(pkg.dsh.client.platform, 'web')
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'), 'the Plugins page must be composed so the row config slot exists')
assert.ok(pkg.dsh.bundle.patch)
assert.match(clientSource, /window\.__ModuleLoader__\.load/)
// P3：配置入口迁到插件页，客户端不再调用遗留的配置路由。
assert.doesNotMatch(clientSource, /__dsh-messaging\/config/, 'the page must not talk to the legacy config route')
assert.match(clientSource, /\/__dsh-messaging\/status/)
assert.match(clientSource, /plugins\.row\.config/, 'the row config slot must be registered')
assert.match(clientSource, /slots\.inject\('settings\.section'/, 'Messaging must be registered in native Settings')
assert.match(clientSource, /credentials: 'same-origin'/)
assert.match(clientSource, /diagnostics\/refresh-scope/, 'the read-only scope refresh endpoint is wired')
assert.doesNotMatch(clientSource, /host\.call/)
assert.doesNotMatch(clientSource, /Authorization/)
// 诊断面板：不引入内联 HTML（XSS 面），不用 firstVisible 命名，不自行调 scope API。
assert.doesNotMatch(clientSource, /dangerouslySetInnerHTML/)
assert.doesNotMatch(clientSource, /firstVisible/)
assert.doesNotMatch(clientSource, /application\/v6\/scopes/)
assert.equal(exampleConfig.adapters.lark.interactiveCard, false, 'config.example.json must default interactive cards to off')

function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    params && name in params ? String(params[name]) : match,
  )
}

function render(node, extraProps) {
  if (node == null || node === false) return node
  if (typeof node === 'function') return render(node(extraProps || {}), extraProps)
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => render(child, extraProps))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    return render(node.type(Object.assign({}, extraProps, node.props)), extraProps)
  }
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  return {
    type: node.type,
    props: node.props || {},
    children: kids.flat(Infinity).map((child) => render(child, extraProps)),
  }
}

function treeText(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join(' ')
  if (typeof node !== 'object') return ''
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(node.children)
  return kids.map(treeText).join(' ')
}

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found) return found
    }
    return null
  }
  const text = treeText(node).replace(/\s+/g, ' ').trim()
  if (node.type === 'button' && text.includes(label)) return node
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  for (const child of kids) {
    const found = findButton(child, label)
    if (found) return found
  }
  return null
}

function findInputByPlaceholder(node, placeholder) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findInputByPlaceholder(child, placeholder)
      if (found) return found
    }
    return null
  }
  if (node.type === 'input' && node.props && node.props.placeholder === placeholder) return node
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  for (const child of kids) {
    const found = findInputByPlaceholder(child, placeholder)
    if (found) return found
  }
  return null
}

function loadFactory(fetchImpl) {
  let factory = null
  const sandbox = {
    console: console,
    fetch: fetchImpl,
    window: {
      __ModuleLoader__: {
        load(spec) {
          factory = spec.factory
        },
      },
    },
  }
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' })
  assert.equal(typeof factory, 'function')
  return factory
}

function makeReact(store) {
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const i = cursor++
      if (!Object.prototype.hasOwnProperty.call(store, i)) store[i] = initial
      return [
        store[i],
        (next) => {
          store[i] = typeof next === 'function' ? next(store[i]) : next
        },
      ]
    },
    useEffect(effect) {
      effect()
    },
    resetCursor() {
      cursor = 0
    },
  }
}

// 每个 store 只订一次（mock 的 useEffect 不跑 cleanup，重复订阅会让计数下不去）。
const HOOK_SUBSCRIPTIONS = new Map()

function bindFace(face, extra, dicts, React) {
  const props = Object.assign({}, extra)
  props.t = (key, params) => {
    const dict = dicts['dsh-messaging']
    return interpolate((dict && dict.en && dict.en[key]) || key, params)
  }
  for (const name of Object.keys(face.hooks || {})) {
    const source = face.hooks[name]
    const hookName = 'use' + name[0].toUpperCase() + name.slice(1)
    props[hookName] = (selector) => {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        if (!HOOK_SUBSCRIPTIONS.has(source)) {
          HOOK_SUBSCRIPTIONS.set(source, source.subscribe(() => bump((value) => value + 1)))
        }
        return undefined
      }, [])
      return selector(source.getSnapshot())
    }
  }
  for (const key of Object.keys(face)) if (key !== 'hooks') props[key] = face[key]
  return props
}

// 组件函数体（slots 约定：业务状态在 controller，组件只碰 props）。
function componentBody(source, name) {
  const at = source.indexOf('function ' + name + '(')
  if (at === -1) return ''
  const rest = source.slice(at + 1)
  const endMarkers = [/\n        function /, /\n        slots\.inject\(/, /\n        ctx\.effect\(/, /\n    exports\.name/]
  let cut = rest.length
  for (const marker of endMarkers) {
    const found = rest.search(marker)
    if (found >= 0 && found < cut) cut = found
  }
  return rest.slice(0, cut)
}

function makeCtx(options) {
  const opts = options || {}
  const registrations = []
  const intervals = []
  const timeouts = []
  const dicts = {}
  const locale = {
    register(ns, value) {
      dicts[ns] = value
      return () => {}
    },
    bind(ns) {
      return (key, params) => interpolate((dicts[ns] && dicts[ns].en && dicts[ns].en[key]) || key, params)
    },
  }

  // settings 镜像桩：与官方 whileServed 同语义——命名空间被提供时注册、停止提供时注销。
  const mirrorListeners = new Set()
  const configForms = {
    row: opts.row,
    served: opts.served !== false,
    writable: opts.writable !== false,
    setRow(next) {
      configForms.row = next
      for (const listener of [...mirrorListeners]) listener()
    },
    setWritable(next) {
      configForms.writable = next
      for (const listener of [...mirrorListeners]) listener()
    },
    setServed(next) {
      configForms.served = next
      for (const listener of [...mirrorListeners]) listener()
    },
    describe() {
      return {
        namespace(ns) {
          if (!configForms.served || !configForms.row || configForms.row.ns !== ns) return undefined
          return configForms.row
        },
        // 真实 mirror 的可写性在 view 层（不在行上）；controller 从这里读 writable。
        getSnapshot() {
          return { status: 'ready', view: { writable: configForms.writable } }
        },
        subscribe(listener) {
          mirrorListeners.add(listener)
          return () => mirrorListeners.delete(listener)
        },
        load() {
          return Promise.resolve()
        },
      }
    },
    whileServed(namespaces, register) {
      let off
      const sync = () => {
        const watched = namespaces.some((ns) => configForms.served && configForms.row && configForms.row.ns === ns)
        if (watched && off === undefined) off = register(new Set(namespaces))
        else if (!watched && off !== undefined) {
          off()
          off = undefined
        }
      }
      mirrorListeners.add(sync)
      sync()
      return () => {
        mirrorListeners.delete(sync)
        if (off !== undefined) {
          off()
          off = undefined
        }
      }
    },
  }

  const slots = {
    inject(name, callback) {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    register(options, component) {
      const entry = { options, component, disposed: false }
      registrations.push(entry)
      return () => {
        entry.disposed = true
      }
    },
  }

  const ctx = {
    effect(fn) {
      return fn()
    },
    locale,
    slots,
    interval(fn, ms) {
      const handle = { fn, ms, disposed: false }
      intervals.push(handle)
      return () => { handle.disposed = true }
    },
    timeout(fn, ms) {
      const handle = { fn, ms, cleared: false }
      timeouts.push(handle)
      return () => {
        handle.cleared = true
      }
    },
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return locale
      if (name === 'configForms') return configForms
      return undefined
    },
  }
  return { ctx, registrations, intervals, timeouts, configForms, dicts }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

// 官方外壳的替身：验证我们把 state/labels/onSave/onDiscard/children 交给它，
// 并按官方语义渲染（unavailable / readOnly / 保存门控 / 失败行 / children）。
function SettingsFormStub(props) {
  const marker = { type: 'span', props: { 'data-official': 'true' }, children: ['official-shell'] }
  if (!props.state || !props.state.available) {
    return { type: 'div', props: {}, children: [marker, String(props.labels.unavailable)] }
  }
  const kids = [marker]
  if (!props.state.writable) kids.push({ type: 'p', props: {}, children: [String(props.labels.readOnly)] })
  kids.push(props.children)
  kids.push({
    type: 'button',
    props: {
      'data-role': 'save',
      disabled: !props.state.dirty || props.state.invalid || props.state.saving,
      onClick: props.onSave,
    },
    children: [String(props.state.saving ? props.labels.saving : props.labels.save)],
  })
  if (props.state.failed) kids.push({ type: 'p', props: { 'data-role': 'failed' }, children: [String(props.labels.saveFailed)] })
  return { type: 'div', props: { 'data-official': 'true' }, children: kids }
}

// 把 fixture 变成 Host 交给页面的 volatile 投影：没有 version/workspaceRoot/runtime，
// 密钥不回显（describe 已 redactSecrets）。
function projectVolatile(config) {
  const value = JSON.parse(JSON.stringify(config))
  delete value.version
  delete value.workspaceRoot
  delete value.runtime
  const secretKeys = ['accessToken', 'secret', 'token', 'botToken', 'signingSecret', 'verificationToken', 'appSecret', 'encodingAESKey', 'webhookSecret']
  for (const channel of Object.keys(value.adapters)) {
    for (const key of Object.keys(value.adapters[channel])) {
      if (secretKeys.indexOf(key) !== -1) delete value.adapters[channel][key]
    }
  }
  return value
}

function hasAttr(node, name) {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => hasAttr(child, name))
  if (node.props && node.props[name] !== undefined) return true
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  return kids.some((child) => hasAttr(child, name))
}

function descendantInput(node) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = descendantInput(child)
      if (found) return found
    }
    return null
  }
  if (node.type === 'input') return node
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  return descendantInput(kids)
}

// 按标签文本找字段输入框（label 是英文文案，取唯一的一条）。
function findInputByLabel(node, label) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findInputByLabel(child, label)
      if (found) return found
    }
    return null
  }
  if (node.type === 'label' && treeText(node).indexOf(label) !== -1) return descendantInput(node)
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  return findInputByLabel(kids, label)
}

function descendantSelect(node) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = descendantSelect(child)
      if (found) return found
    }
    return null
  }
  if (node.type === 'select') return node
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  return descendantSelect(kids)
}

function findSelectByLabel(node, label) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSelectByLabel(child, label)
      if (found) return found
    }
    return null
  }
  if (node.type === 'label' && treeText(node).indexOf(label) !== -1) return descendantSelect(node)
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(...[].concat(node.children))
  return findSelectByLabel(kids, label)
}

function selectOptions(select) {
  const options = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'option') {
      options.push({ value: node.props.value, label: treeText(node) })
      return
    }
    const kids = []
    if (node.props && node.props.children != null) kids.push(node.props.children)
    if (node.children) kids.push(...[].concat(node.children))
    kids.forEach(walk)
  }
  walk(select)
  return options
}

async function main() {
  const calls = []
  // 页面不再调用 /__dsh-messaging/config；只有状态面板还打 /status（P4 再处理）。
  // 权限刷新探针：记录 method/path/body，并支持成功/服务端错误/未知错误/离线/挂起五种模式。
  const refreshCalls = []
  // 状态重读后 fetch 桩要回放测试注入的 channels，否则刷新后的面板会丢卡片。
  let statusChannels = []
  let refreshMode = 'ok'
  let releaseHang = null
  let releasePost = null
  let statusFailNext = false
  let statusHttpNext = false
  let statusMalformedNext = false
  let statusShapeNext = false
  let statusShapePayload = null
  // 按序持有真实 status GET（请求闭包在发起时冻结响应），用于乱序结算探针。
  let statusHoldPayloads = null
  const heldStatusGets = []
  // 顶层 generation 保留（真实后端字段，客户端不再用作实例身份）；实例身份用
  // instanceEpoch（匿名随机非负整数，只比相等；同一次插件 apply 稳定，新 apply 不同）。
  let statusTopGeneration = 3
  let statusInstanceEpoch = 101
  let statusHasEpoch = true // 旧后端兼容：无 instanceEpoch 字段
  let refreshEpochMode = 'current' // current | missing | fixed
  let refreshFixedEpoch = null
  let holdStatus = false
  let releaseStatus = null
  const scopeRefreshResponse = (payload) => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  const statusBody = () => {
    const body = {
      generation: statusTopGeneration,
      channels: statusChannels,
      sessions: [],
      // 飞书入站痕迹（lark-drop）：面板要能展示它，且缺 text 时不得渲染成 undefined。
      recent: [{ at: 1790000000000, kind: 'lark-drop', channel: 'lark', reason: 'unsupported message_type', messageType: 'image', chatType: 'p2p', textLen: null }],
      errors: [],
    }
    if (statusHasEpoch) body.instanceEpoch = statusInstanceEpoch
    return body
  }
  // 成功响应的 generation 必须与 scopeBase 一致（代际三方绑定链）；instanceEpoch 按模式携带。
  const okPayload = { ok: true, refreshed: true, generation: 5, permissions: { grant: 'unknown', source: null, checkedAt: 1790000000000, queryState: 'ok', failedCategory: null, stale: false } }
  const refreshPayload = () => {
    const payload = Object.assign({}, okPayload)
    if (refreshEpochMode === 'current') payload.instanceEpoch = statusInstanceEpoch
    else if (refreshEpochMode === 'fixed') payload.instanceEpoch = refreshFixedEpoch
    // 'missing'：不带 instanceEpoch（旧后端/缺失兼容）
    return payload
  }
  const fetchImpl = (url, opts) => {
    const urlText = String(url)
    calls.push({ url: urlText, method: (opts && opts.method) || 'GET', opts })
    if (urlText.indexOf('/diagnostics/refresh-scope') !== -1) {
      refreshCalls.push({ url: urlText, method: (opts && opts.method) || 'GET', body: opts && opts.body })
      if (refreshMode === 'offline') return Promise.reject(new Error('raw offline error sk-SECRET-LEAK'))
      if (refreshMode === 'hang') {
        const frozen = refreshPayload() // 发起时冻结响应（实例身份取当时值）
        return new Promise((resolve) => {
          releaseHang = () => resolve(scopeRefreshResponse(frozen))
        })
      }
      if (refreshMode === 'hang_post') {
        const frozen = refreshPayload()
        return new Promise((resolve) => {
          releasePost = () => resolve(scopeRefreshResponse(frozen))
        })
      }
      if (refreshMode === 'stale_resp') return scopeRefreshResponse({ ok: true, refreshed: true, generation: 4, instanceEpoch: statusInstanceEpoch, permissions: null })
      if (refreshMode === 'server_error') return scopeRefreshResponse({ ok: false, refreshed: false, error: 'rate_limited', generation: 5, permissions: null })
      if (refreshMode === 'server_stale') return scopeRefreshResponse({ ok: false, refreshed: false, error: 'stale_generation', generation: 5, permissions: null })
      if (refreshMode === 'server_read_failed') return scopeRefreshResponse({ ok: false, refreshed: false, error: 'scope read failed', generation: 5, permissions: null })
      if (refreshMode === 'unknown_error') return scopeRefreshResponse({ ok: false, refreshed: false, error: 'weird <script>alert(1)</script> raw', generation: 5, permissions: null })
      return scopeRefreshResponse(refreshPayload())
    }
    if (urlText.endsWith('/status')) {
      if (statusHoldPayloads && statusHoldPayloads.length) {
        const payload = statusHoldPayloads.shift()
        return new Promise((resolve) => { heldStatusGets.push(() => resolve(scopeRefreshResponse(payload))) })
      }
      if (statusFailNext) { statusFailNext = false; return Promise.reject(new Error('SYNTHETIC_PRIVATE_ERROR_STATUS')) }
      if (statusHttpNext) { statusHttpNext = false; return Promise.resolve({ ok: false, status: 503, text: async () => JSON.stringify({ error: 'HTTP 503 SYNTHETIC_HTTP_PRIVATE' }) }) }
      if (statusMalformedNext) { statusMalformedNext = false; return Promise.resolve({ ok: true, status: 200, text: async () => '<html>oops SYNTHETIC_HTML_PRIVATE</html>' }) }
      if (statusShapeNext) { statusShapeNext = false; return Promise.resolve(scopeRefreshResponse(statusShapePayload)) }
      if (holdStatus) {
        // 一次性持有：响应在请求时冻结，后续 GET（如 reload）正常放行。
        holdStatus = false
        const frozen = statusBody()
        return new Promise((resolve) => { releaseStatus = () => resolve(scopeRefreshResponse(frozen)) })
      }
      return Promise.resolve(scopeRefreshResponse(statusBody()))
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
  }

  const factory = loadFactory(fetchImpl)
  const store = {}
  const React = makeReact(store)
  const plugin = factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { SettingsForm: SettingsFormStub }
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(plugin.name, 'dsh-messaging')
  assert.ok(plugin.inject.includes('slots'))
  assert.ok(plugin.inject.includes('locale'))
  assert.ok(plugin.inject.includes('configForms'), 'the page depends on the settings form service')

  // Host 交给页面的形状：volatile 投影 + describe 的 secrets 侧车 + revision。
  const formValue = projectVolatile(fixtureConfig)
  const configFormsRow = {
    ns: 'dsh-messaging',
    revision: 7,
    secrets: [{ path: ['adapters', 'telegram', 'token'], set: true }],
    value: formValue,
  }
  const formState = { status: 'ready', writable: true, revision: 7, value: formValue }
  const mutateCalls = []
  let mutateImpl = async (ops, revision) => {
    mutateCalls.push({ ops, revision })
    return true
  }
  const form = {
    get state() { return formState },
    mutate(ops, revision) { return mutateImpl(ops, revision) },
  }

  const { ctx, registrations, intervals, timeouts, configForms, dicts } = makeCtx({ row: configFormsRow })
  plugin.apply(ctx)
  assert.equal(calls.length, 0, 'apply itself must not fetch')

  // ── P3-1：注册的是 plugins.row.config，key 正确，且 settings.section 已消失 ──
  const diagnosticsEntry = registrations.find((entry) => entry.options.name === 'plugins.row.config')
  assert.equal(diagnosticsEntry.options.key, 'dsh-messaging#dsh-messaging')
  const rowEntry = registrations.find((entry) => entry.options.name === 'settings.section')
  assert.ok(rowEntry, 'the row config slot must be registered')
  assert.equal(rowEntry.options.id, 'messaging')
  assert.equal(rowEntry.options.label, 'Messaging')
  assert.equal(
    registrations.some((entry) => entry.options.name === 'settings.section'),
    true,
    'Messaging is registered as a settings section',
  )
  const panel = registrations.find((entry) => entry.options.name === 'tool.view.cordis')
  assert.ok(panel, 'the status panel stays for P4')
  assert.equal(calls.length, 0, 'the page must not talk to the legacy config route')

  // 宿主渲染时会把 inject 面绑成 props（hooks → useXxx(selector)），这里模拟它。
  const pageFace = rowEntry.options.inject()
  const pageProps = (extra) => bindFace(pageFace, extra, dicts, React)
  // ── P3-2：summary / page 两种视图都能渲染 ────────────────────────────────
  const resetState = () => {
    for (const key of Object.keys(store)) delete store[key]
    React.resetCursor()
  }
  // 只重渲染不重置状态（保留草稿）：mock 的 hook 游标必须每次归零。
  const rerender = () => {
    React.resetCursor()
    return render(rowEntry.component, pageProps({ view: 'page', form }))
  }
  const renderPage = async () => {
    resetState()
    render(rowEntry.component, pageProps({ view: 'page', form }))
    await flush()
    resetState()
    return render(rowEntry.component, pageProps({ view: 'page', form }))
  }

  resetState()
  const summary = render(diagnosticsEntry.component, bindFace(diagnosticsEntry.options.inject(), { view: 'summary' }, dicts, React))
  assert.match(
    treeText(summary),
    /Connection and Feishu permission diagnostics/,
    'the summary one-liner renders',
  )

  let tree = await renderPage()
  let text = treeText(tree)
  assert.match(text, /Messaging/)
  assert.match(text, /OneBot v11/)
  assert.match(text, /Telegram/)
  assert.match(text, /Personal WeChat/)
  assert.ok(hasAttr(tree, 'data-official'), 'the official SettingsForm shell is used when ui-primitives resolves')
  assert.ok(calls.every((call) => call.method === 'GET'), 'configuration rendering may read status but must not send or refresh scopes')

  // ── P3-2b：飞书交互式卡片用 Yes/No 下拉，默认 false ────────────────────
  assert.equal(dicts['dsh-messaging'].zh['field.lark.interactiveCard'], '是否启用交互式卡片')
  assert.equal(dicts['dsh-messaging'].zh['settings.yes'], '是')
  assert.equal(dicts['dsh-messaging'].zh['settings.no'], '否')
  assert.equal(dicts['dsh-messaging'].en['field.lark.interactiveCard'], 'Enable interactive cards')
  assert.equal(dicts['dsh-messaging'].en['settings.yes'], 'Yes')
  assert.equal(dicts['dsh-messaging'].en['settings.no'], 'No')
  const interactiveCardSelect = findSelectByLabel(tree, 'Enable interactive cards')
  assert.ok(interactiveCardSelect, 'the Lark interactive-card field renders')
  assert.equal(interactiveCardSelect.props.value, 'false', 'the field defaults to No when the stored value is absent')
  assert.deepEqual(selectOptions(interactiveCardSelect), [
    { value: 'true', label: 'Yes' },
    { value: 'false', label: 'No' },
  ], 'the boolean field is serialized as a Yes/No dropdown')

  // ── P3-3：Lark webhookOnly 字段仍按模式显隐 ───────────────────────────────
  const larkInputCount = async (mode) => {
    formState.value.adapters.lark = Object.assign({}, formState.value.adapters.lark, { enabled: true, mode })
    const rendered = await renderPage()
    let count = 0
    const walk = (node, insideLark) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach((child) => walk(child, insideLark))
      const inLark = insideLark || (node.type === 'section' && node.props && node.props.key === 'lark')
      if (inLark && node.type === 'input') count += 1
      const kids = []
      if (node.props && node.props.children != null) kids.push(node.props.children)
      if (node.children) kids.push(...[].concat(node.children))
      kids.forEach((child) => walk(child, inLark))
    }
    walk(rendered, false)
    return count
  }
  const longConnInputs = await larkInputCount('long-connection')
  const webhookInputs = await larkInputCount('webhook')
  assert.equal(webhookInputs - longConnInputs, 3, 'the three webhook-only lark fields must be hidden in long connection mode')
  const restoredFixture = projectVolatile(fixtureConfig)
  formState.value = restoredFixture
  configFormsRow.value = restoredFixture
  configForms.setRow(configFormsRow) // 换值对象后通知镜像，controller 重新读

  // ── P3-4：编辑 → 保存生成 ops，并带上 revision；密钥留空不生成 op ─────────
  tree = await renderPage()
  const endpointInput = findInputByLabel(tree, 'OneBot endpoint')
  assert.ok(endpointInput, 'the OneBot endpoint field renders')
  endpointInput.props.onChange({ target: { value: 'http://127.0.0.1:6001' } })
  await flush()
  tree = rerender()
  const saveButton = findButton(tree, 'Save')
  assert.ok(saveButton, 'the official shell renders the save control')
  assert.equal(saveButton.props.disabled, false, 'a dirty form enables save')
  saveButton.props.onClick()
  await flush()
  assert.equal(mutateCalls.length, 1, 'saving writes once')
  assert.deepEqual(JSON.parse(JSON.stringify(mutateCalls[0].ops)), [
    { op: 'set', path: ['adapters', 'onebot', 'endpoint'], value: 'http://127.0.0.1:6001' },
  ], 'the edit becomes one set op')
  assert.equal(mutateCalls[0].revision, 7, 'the save carries the revision it read')
  assert.equal(
    mutateCalls[0].ops.some((op) => op.path.join('.').indexOf('token') !== -1),
    false,
    'a secret left blank generates no op at all',
  )

  // 密钥：已设置（sidecar）→ 占位提示 + 清除入口；输入 → set；清除 → unset。
  const secretInput = findInputByPlaceholder(tree, 'Set — leave blank to keep')
  assert.ok(secretInput, 'a stored secret renders the write-only placeholder')
  assert.equal(secretInput.props.value, '', 'the stored plaintext never reaches the input')
  secretInput.props.onChange({ target: { value: 'tg-new-token' } })
  await flush()
  tree = rerender()
  findButton(tree, 'Save').props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(mutateCalls[1].ops)), [
    { op: 'set', path: ['adapters', 'telegram', 'token'], value: 'tg-new-token' },
  ], 'typing a secret becomes a set op')
  assert.equal(mutateCalls[1].revision, 7, 'the secret save carries the revision')

  const clearButton = findButton(tree, 'Clear')
  assert.ok(clearButton, 'a stored secret offers a clear action')
  clearButton.props.onClick()
  await flush()
  tree = rerender()
  assert.ok(findInputByPlaceholder(tree, 'User override removed on save; composition defaults may remain'), 'the pending clear is announced')
  findButton(tree, 'Save').props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(mutateCalls[2].ops)), [
    { op: 'unset', path: ['adapters', 'telegram', 'token'] },
  ], 'clearing a secret becomes an unset op (drop the override)')

  // ── P3-4b：interactiveCard 序列化为 boolean set，而不是字符串 true/false ──
  const interactiveCardBaseline = projectVolatile(fixtureConfig)
  interactiveCardBaseline.adapters.lark.interactiveCard = true
  formState.value = interactiveCardBaseline
  configFormsRow.value = interactiveCardBaseline
  configForms.setRow(configFormsRow)
  tree = await renderPage()
  const interactiveCardTrueSelect = findSelectByLabel(tree, 'Enable interactive cards')
  assert.equal(interactiveCardTrueSelect.props.value, 'true', 'a stored true value selects Yes')
  interactiveCardTrueSelect.props.onChange({ target: { value: 'false' } })
  await flush()
  tree = rerender()
  findButton(tree, 'Save').props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(mutateCalls[mutateCalls.length - 1].ops)), [
    { op: 'set', path: ['adapters', 'lark', 'interactiveCard'], value: false },
  ], 'selecting No serializes a boolean false set op')
  const restoredInteractiveCard = projectVolatile(fixtureConfig)
  formState.value = restoredInteractiveCard
  configFormsRow.value = restoredInteractiveCard
  configForms.setRow(configFormsRow)

  // ── P3-5：冲突 → 提示并丢弃草稿 ─────────────────────────────────────────
  mutateImpl = async () => {
    const error = new Error('settings namespace "dsh-messaging" changed since it was read')
    error.name = 'SettingsConflictError'
    error.code = 'SETTINGS_CONFLICT'
    throw error
  }
  tree = await renderPage()
  const conflictInput = findInputByLabel(tree, 'OneBot endpoint')
  conflictInput.props.onChange({ target: { value: 'http://127.0.0.1:7777' } })
  await flush()
  tree = rerender()
  findButton(tree, 'Save').props.onClick()
  await flush()
  tree = rerender()
  const conflictText = treeText(tree)
  assert.match(conflictText, /The configuration changed elsewhere and has been reloaded/, 'the conflict copy is shown')
  const afterConflict = findInputByLabel(tree, 'OneBot endpoint')
  assert.equal(
    afterConflict.props.value,
    'http://127.0.0.1:5700',
    'the draft is discarded after a conflict, the baseline value shows again',
  )
  mutateImpl = async (ops, revision) => {
    mutateCalls.push({ ops, revision })
    return true
  }

  // ── P3-6：form 缺失 → 降级文案，不崩 ────────────────────────────────────
  resetState()
  const missing = render(rowEntry.component, pageProps({ view: 'page' }))
  assert.match(treeText(missing), /Configuration is unavailable right now/, 'a missing form degrades to a notice')

  // ── P3-7：whileServed 撤销 → 页面随之注销 ───────────────────────────────
  assert.equal(rowEntry.disposed, false, 'the registration is alive while the namespace is served')
  configForms.setServed(false)
  assert.equal(rowEntry.disposed, true, 'stopping serving the namespace unregisters the page')
  configForms.setServed(true)

  // ── P3-8：拿不到 ui-primitives 时退回自绘外壳，页面仍可用 ────────────────
  const fallbackFactory = loadFactory(fetchImpl)
  const fallbackStore = {}
  const fallbackReact = makeReact(fallbackStore)
  const fallbackPlugin = fallbackFactory((name) => {
    if (name === 'react') return fallbackReact
    throw new Error('ui-primitives unavailable: ' + name)
  })
  const fallbackCtxBundle = makeCtx({ row: configFormsRow })
  fallbackPlugin.apply(fallbackCtxBundle.ctx)
  const fallbackEntry = fallbackCtxBundle.registrations.find((entry) => entry.options.name === 'settings.section')
  assert.ok(fallbackEntry, 'the page registers even without ui-primitives')
  fallbackReact.resetCursor()
  const fallbackTree = render(fallbackEntry.component, bindFace(fallbackEntry.options.inject(), { view: 'page', form }, dicts, fallbackReact))
  assert.equal(hasAttr(fallbackTree, 'data-official'), false, 'the fallback shell is used when the module is missing')
  assert.ok(findButton(fallbackTree, 'Save'), 'the fallback shell still offers save')

  // ── P4：组件函数体内不得出现 ctx（业务/传输状态都在 controller 里）────
  for (const name of ['PluginConfigSection', 'MessagingSettingsPage', 'WeChatLoginPanel', 'LarkSetupPanel', 'MessagingPanel', 'Field', 'LarkDiagnosticsPanel']) {
    const body = componentBody(clientSource, name)
    assert.ok(body.length > 0, 'component exists: ' + name)
    assert.equal(/ctx\./.test(body), false, name + ' must not touch ctx (it takes props only)')
  }

  // ── P4：StatusController 没有订阅者时不发请求，最后一个退订后停掉 interval ─
  // Unmount settings/fallback hook consumers before testing the shared status lifetime.
  for (const off of HOOK_SUBSCRIPTIONS.values()) off()
  HOOK_SUBSCRIPTIONS.clear()
  intervals.length = 0
  calls.length = 0
  const statusFace = panel.options.inject()
  const statusStore = statusFace.hooks.status
  assert.equal(typeof statusFace.reload, 'function', 'the panel inject carries the reload action')
  const statusCalls = (url) => calls.filter((entry) => entry.url === url).length
  assert.equal(statusCalls('/__dsh-messaging/status'), 0, 'no subscriber → no status request')
  assert.equal(intervals.length, 0, 'no subscriber → no poll timer')
  const offStatus = statusStore.subscribe(() => {})
  await flush()
  assert.equal(intervals.length, 1, 'the first subscriber starts the poll timer')
  assert.equal(statusCalls('/__dsh-messaging/status') >= 1, true, 'and the first status read fires')
  const beforeFire = calls.length
  intervals[0].fn()
  await flush()
  assert.ok(calls.length > beforeFire, 'the interval keeps polling while subscribed')
  offStatus()
  assert.equal(intervals[0].disposed, true, 'the last unsubscribe stops the timer')
  const afterStop = calls.length
  await flush()
  assert.equal(calls.length, afterStop, 'no further request after the last subscriber left')

  // ── P4/P5 step0：只读部署（writable:false）下输入与清除按钮都要禁掉 ──────
  //     P5 起 writable 由 mirror 的 view 层下发（与 revision/secrets 同一快照）。
  configForms.setWritable(false)
  tree = await renderPage()
  const readOnlyInput = findInputByLabel(tree, 'OneBot endpoint')
  assert.ok(readOnlyInput, 'the field still renders in read-only mode')
  assert.equal(readOnlyInput.props.disabled, true, 'inputs are disabled when the host says read-only')
  const readOnlyClear = findButton(tree, 'Clear')
  assert.equal(readOnlyClear && readOnlyClear.props.disabled, true, 'the clear action is disabled too')
  assert.match(treeText(tree), /These settings are read-only/, 'the read-only notice is shown')
  configForms.setWritable(true)

  // ── P5 step0：value / writable 都以 mirror 为准（故意让 form.state 不一致）──
  const mirrorBaseline = projectVolatile(fixtureConfig)
  mirrorBaseline.adapters.onebot.endpoint = 'http://mirror-only.example:5700'
  const formOnlyValue = { adapters: { onebot: { endpoint: 'http://form-only.example:5700' } } }
  formState.value = formOnlyValue
  configFormsRow.value = mirrorBaseline
  configForms.setRow(configFormsRow)
  tree = await renderPage()
  const mirrorInput = findInputByLabel(tree, 'OneBot endpoint')
  assert.ok(mirrorInput, 'the endpoint field renders from the mirror value')
  assert.equal(
    mirrorInput.props.value,
    'http://mirror-only.example:5700',
    'the page reads value from the mirror row, never from form.state',
  )
  // mirror 说只读（view.writable=false）→ 即使 form.state.writable 仍为 true 也必须禁用。
  configForms.setWritable(false)
  tree = await renderPage()
  const mirrorReadOnly = findInputByLabel(tree, 'OneBot endpoint')
  assert.equal(mirrorReadOnly.props.disabled, true, 'writable comes from the mirror view, not form.state')
  configForms.setWritable(true)
  // 恢复现场，后续断言不受影响。
  formState.value = restoredFixture
  configFormsRow.value = restoredFixture
  configForms.setRow(configFormsRow)

  // ── 状态面板展示飞书入站痕迹（lark-drop）：显示原因，且缺 text 不渲染 undefined ──
  resetState()
  const panelFace = bindFace(statusFace, {}, dicts, React)
  render(panel.component, panelFace)
  await flush()
  resetState()
  const panelTree = render(panel.component, panelFace)
  const panelText = treeText(panelTree)
  assert.match(panelText, /lark-drop/, 'the drop trace is visible in the status panel')
  assert.match(panelText, /unsupported message_type/, 'the drop reason is visible')
  assert.equal(panelText.includes('undefined'), false, 'a drop row without text must not render "undefined"')

  // ── 飞书诊断面板（schemaVersion 1）：四域分离 / unknown / denied / 静态收尾并列 /
  //    缺 diagnostics/未知 schema / 恶意对象数据 / 脱敏与 XSS 回归 ──
  const findDiag = (node, key) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findDiag(child, key)
        if (found) return found
      }
      return null
    }
    if (node.props && node.props['data-diag'] === key) return node
    const kids = []
    if (node.props && node.props.children != null) kids.push(node.props.children)
    if (node.children) kids.push(...node.children)
    for (const child of kids) {
      const found = findDiag(child, key)
      if (found) return found
    }
    return null
  }
  const diagText = (node, key) => {
    const found = findDiag(node, key)
    return found ? treeText(found) : null
  }
  const countButtons = (node) => {
    if (!node || typeof node !== 'object') return 0
    if (Array.isArray(node)) return node.reduce((sum, child) => sum + countButtons(child), 0)
    let count = node.type === 'button' ? 1 : 0
    const kids = []
    if (node.props && node.props.children != null) kids.push(node.props.children)
    if (node.children) kids.push(...node.children)
    return count + kids.reduce((sum, child) => sum + countButtons(child), 0)
  }
  // 危险属性（href/src/innerHTML…）整树扫描：诊断值永远不进属性。
  const findDangerousAttr = (node) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findDangerousAttr(child)
        if (found) return found
      }
      return null
    }
    const props = node.props || {}
    for (const name of ['href', 'src', 'srcdoc', 'innerHTML', 'dangerouslySetInnerHTML', 'action', 'formAction']) {
      if (props[name] !== undefined) return name
    }
    const kids = []
    if (props.children != null) kids.push(props.children)
    if (node.children) kids.push(...node.children)
    for (const child of kids) {
      const found = findDangerousAttr(child)
      if (found) return found
    }
    return null
  }
  const larkChannel = (extra) => Object.assign({
    key: 'lark', label: 'Lark / Feishu', state: 'running',
    inboundCount: 3, outboundCount: 5, lastError: '',
  }, extra || {})
  // 面板头的「重新加载」是既有全局动作；按钮禁令只约束飞书卡片/诊断面板内部。
  const larkCardOf = (node) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = larkCardOf(child)
        if (found) return found
      }
      return null
    }
    if (node.type === 'div' && node.props && node.props.key === 'lark') return node
    const kids = []
    if (node.props && node.props.children != null) kids.push(node.props.children)
    if (node.children) kids.push(...node.children)
    for (const child of kids) {
      const found = larkCardOf(child)
      if (found) return found
    }
    return null
  }
  const renderPanelWith = async (channels) => {
    statusChannels = channels
    statusStore.set({ data: { channels, sessions: [], recent: [], errors: [] }, error: '', busy: false })
    resetState()
    render(panel.component, panelFace)
    await flush()
    resetState()
    return render(panel.component, panelFace)
  }
  // 只重渲染不改 store（保留最近一次 load 的 data，用于断言乱序结算后的权威视图）。
  const renderNow = () => {
    resetState()
    return render(panel.component, panelFace)
  }

  // (1) 正常全量 v1：grant 与 operationsVerified/证据分域；计数/时序/引擎/操作桶齐全。
  const diagNormal = {
    schemaVersion: 1,
    generation: 4,
    configuredMode: 'card',
    permissions: {
      cardkitWrite: { grant: 'granted', source: 'scope_read', checkedAt: 1790000000000, queryState: 'ok', failedCategory: null, stale: false },
    },
    cardkit: { requiredScope: 'cardkit:card:write', state: 'observed_success', operationsVerified: ['card_create', 'card_put'], lastFailure: null },
    operations: {
      card_create: { state: 'ok', attempted: 1, succeeded: 1, failed: 0, deliveryUnknown: 0 },
      card_reference: { attempted: 3, succeeded: 3, failed: 0, deliveryUnknown: 0 },
      card_put: { attempted: 7, succeeded: 7, failed: 0, deliveryUnknown: 0 },
      card_close: { attempted: 1, succeeded: 1, failed: 0, deliveryUnknown: 0 },
      static_interactive: { attempted: 0, succeeded: 0, failed: 0, deliveryUnknown: 0 },
      text_send: { attempted: 0, succeeded: 0, failed: 0, deliveryUnknown: 0 },
      scope_read: { attempted: 1, succeeded: 1, failed: 0, deliveryUnknown: 0 },
    },
    stream: {
      hostSeen: { start: 2, chunk: 9, textDelta: 12, blockEnd: 2, end: 2 },
      engineAccepted: { start: 2, textDelta: 12, end: 2 },
      engineRejected: { duplicateRevision: 0, duplicateIndex: 2, regressedRevision: 0, denseIndexGap: 0, shape: 0, unbound: 0, stale: 0 },
      localRefusals: { count: 3, lastCategory: 'budget_exceeded', lastAt: 1790000002000 },
      finalReceived: 2,
      turnEndReceived: 2,
      aborted: 0,
      observedMode: 'live_card',
      finalStatic: { count: 0, lastReason: null, lastAt: null },
    },
    userState: 'completed',
    turn: {
      turnId: 7,
      step: 1,
      startedAt: 1790000000000,
      outcome: 'completed',
      failureReason: null,
      endKind: 'committed',
      completion: { pendingTasks: 0, pendingOps: 0, enginesPending: 0, cardsOpened: 1, cardsClosed: 1, incompleteSteps: 0 },
      timings: {
        firstAcceptedTextDeltaMs: 40,
        firstDeliveryAckMs: 842,
        firstPutDispatchMs: 700,
        lastPutDispatchMs: 1400,
        firstPutSuccessMs: 900,
        lastPutSuccessMs: 1500,
        finalReceivedMs: 2000,
        liveEndMs: 2100,
        turnEndMs: 2200,
        terminalCloseMs: 2300,
      },
      counts: { acceptedTextDelta: 12, putBeforeFinal: 3, putBeforeTurnEnd: 4, putDispatchedBeforeFinal: 5, putDispatchedBeforeTurnEnd: 6, putTotal: 7 },
      staticFinal: { used: false, reason: null },
      events: [{ seq: 1, atMs: 40, kind: 'first_delta' }],
    },
    recentTurns: [],
  }
  let diagTree = await renderPanelWith([larkChannel({ diagnostics: diagNormal })])
  assert.match(diagText(diagTree, 'connection'), /running/, 'the connection row keeps the raw state')
  assert.match(diagText(diagTree, 'configured'), /Interactive card/, 'configured mode renders')
  assert.match(diagText(diagTree, 'observed'), /Live card/, 'observed mode renders')
  const grantRow1 = diagText(diagTree, 'grant')
  assert.match(grantRow1, /Query reports granted/, 'grant shows the scope-read result')
  assert.match(grantRow1, /scope_read/, 'grant carries its source')
  assert.match(grantRow1, /query ok/, 'grant carries the query state')
  assert.equal(grantRow1.includes('Observed success'), false, 'grant row never doubles as operation evidence')
  const evRow1 = diagText(diagTree, 'evidence')
  assert.match(evRow1, /Observed success/, 'operation evidence renders separately')
  assert.match(evRow1, /Verified operations: create\/update/, 'operationsVerified renders with labels')
  assert.equal(evRow1.includes('Query reports granted'), false, 'evidence row never doubles as grant')
  assert.match(diagText(diagTree, 'userState'), /Turn completed/, 'userState completed renders')
  assert.match(diagText(diagTree, 'staticFinal'), /0×/, 'stream finalStatic row renders alongside completed')
  const ackRow1 = diagText(diagTree, 'firstAck')
  assert.match(ackRow1, /First-segment delivery ack \(from first accepted text delta\): 842 ms/, 'firstDeliveryAckMs uses the exact label and value')
  assert.match(ackRow1, /not screen-visible latency/, 'the ack is explicitly not screen-visible latency')
  const counters1 = diagText(diagTree, 'counters')
  assert.match(counters1, /accepted text-delta 12/, 'accepted text-delta renders')
  assert.match(counters1, /PUT confirmed ok before final 3/, 'pre-final PUT count is labeled confirmed-success (ACK)')
  assert.match(counters1, /PUT confirmed ok before turnEnd 4/, 'pre-turnEnd PUT count is labeled confirmed-success (ACK)')
  assert.match(counters1, /PUT dispatched before final 5 · before turnEnd 6 \(dispatch ≠ confirmed ACK\)/, 'dispatch counts render distinctly from ACK counts')
  assert.match(counters1, /PUT total 7/, 'PUT total renders')
  const timings1 = diagText(diagTree, 'timings')
  assert.match(timings1, /first dispatch 700/, 'firstPutDispatchMs renders')
  assert.match(timings1, /last dispatch 1400/, 'lastPutDispatchMs renders')
  assert.match(timings1, /first PUT 900/, 'firstPutSuccessMs renders')
  assert.match(timings1, /close 2300/, 'terminalCloseMs renders')
  assert.match(diagText(diagTree, 'turn'), /Turn 7 · step 1 · Completed/, 'anonymous numeric turnId and v1 outcome render')
  assert.match(diagText(diagTree, 'endKind'), /End kind: Committed/, 'endKind renders as its fixed label')
  assert.match(diagText(diagTree, 'completion'), /cards open 1\/closed 1/, 'completion progress renders')
  assert.equal(findDiag(diagTree, 'failureReason'), null, 'a completed turn without a failure reason shows no failure row')
  const engine1 = diagText(diagTree, 'engine')
  assert.match(engine1, /host seen s:2 c:9 δ:12 b:2 e:2/, 'hostSeen renders')
  assert.match(engine1, /engine accepted s:2 δ:12 e:2/, 'engineAccepted renders')
  assert.match(engine1, /engine rejected dup0 dupIndex 2/, 'engineRejected renders with duplicateIndex')
  const refusals1 = diagText(diagTree, 'refusals')
  assert.match(refusals1, /Local refusals \(no request sent\): 3× · reason Budget exceeded/, 'local refusals render with the no-request label and category')
  assert.match(diagText(diagTree, 'turnEvents'), /final 2 · turnEnd 2 · aborted 0/, 'turn events render')
  assert.match(diagText(diagTree, 'ops'), /create tried 1\/ok 1\/failed 0\/unknown 0/, 'operation counters render')
  assert.match(diagText(diagTree, 'ops'), /update tried 7\/ok 7/, 'card_put counters render')
  assert.match(diagText(diagTree, 'generation'), /generation 4/, 'generation renders')
  assert.equal(findDiag(diagTree, 'fix'), null, 'no fix steps when nothing is denied')
  const refreshBtn1 = findDiag(diagTree, 'refresh')
  assert.ok(refreshBtn1 && refreshBtn1.type === 'button', 'the read-only refresh button renders')
  assert.equal(refreshBtn1.props.disabled, false, 'the refresh button is enabled when idle')
  assert.equal(countButtons(larkCardOf(diagTree)), 1, 'only the refresh button exists (no apply/probe/text-downgrade buttons)')
  assert.match(diagText(diagTree, 'refreshHint'), /does not verify live streaming/, 'the read-only hint disclaims streaming verification')

  // (1b) completed 与 staticFinal.used、observedMode 并列，不互相掩盖。
  const diagCompletedStatic = JSON.parse(JSON.stringify(diagNormal))
  diagCompletedStatic.stream.observedMode = 'static_interactive'
  diagCompletedStatic.stream.finalStatic = { count: 1, lastReason: 'non_streaming', lastAt: 1790000005000 }
  diagCompletedStatic.turn.staticFinal = { used: true, reason: 'non_streaming' }
  const completedTree = await renderPanelWith([larkChannel({ diagnostics: diagCompletedStatic })])
  assert.match(diagText(completedTree, 'userState'), /Turn completed/, 'userState stays completed')
  assert.match(diagText(completedTree, 'observed'), /Final static card/, 'observedMode still shows the static card')
  assert.match(diagText(completedTree, 'staticFinal'), /1×/, 'stream finalStatic count still shows')
  assert.match(diagText(completedTree, 'turnStatic'), /Yes \(non-streaming turn\)/, 'turn staticFinal.used still shows')

  // (2) unknown / 缺字段：grant=query never、证据空、首延迟未观测，绝不假绿。
  const diagUnknown = {
    schemaVersion: 1,
    configuredMode: 'card',
    permissions: { cardkitWrite: { grant: 'unknown', source: null, checkedAt: null, queryState: 'never', failedCategory: null, stale: false } },
    cardkit: { requiredScope: 'cardkit:card:write', state: 'unknown', operationsVerified: [], lastFailure: null },
    operations: {},
    stream: { observedMode: 'pending' },
    turn: null,
  }
  const unknownTree = await renderPanelWith([larkChannel({ diagnostics: diagUnknown })])
  const unknownGrant = diagText(unknownTree, 'grant')
  assert.match(unknownGrant, /Not verified yet/, 'unknown grant is not verified yet')
  assert.match(unknownGrant, /never queried/, 'the never-queried state renders')
  assert.match(diagText(unknownTree, 'evidence'), /No operation evidence yet/, 'no evidence is stated')
  assert.match(diagText(unknownTree, 'userState'), /Not verified yet/, 'missing userState stays unknown')
  assert.match(diagText(unknownTree, 'firstAck'), /Not observed/, 'turn=null → first ack is not observed')
  assert.equal(treeText(unknownTree).includes('Observed success'), false, 'unknown never claims observed success')
  assert.equal(treeText(unknownTree).includes('Query reports granted'), false, 'unknown never claims granted')
  assert.notEqual(
    findDiag(unknownTree, 'grant').props.style,
    findDiag(diagTree, 'grant').props.style,
    'unknown grant is not painted with the granted style',
  )
  assert.equal(findDiag(unknownTree, 'fix'), null, 'unknown shows no fix steps')

  // (3) denied：grant 与证据同时给出 → 缺权最少步骤；无 secret、无降级、无按钮。
  const diagDenied = {
    schemaVersion: 1,
    generation: 7,
    configuredMode: 'card',
    permissions: { cardkitWrite: { grant: 'denied', source: 'scope_read', checkedAt: 1790000002000, queryState: 'ok', failedCategory: null, stale: false } },
    cardkit: {
      requiredScope: 'cardkit:card:write',
      state: 'denied',
      operationsVerified: [],
      lastFailure: { operation: 'card_create', httpStatus: 403, apiCode: 99991672, category: 'scope_denied', scope: 'cardkit:card:write', at: 1790000002500 },
    },
    operations: {
      card_create: { attempted: 1, succeeded: 0, failed: 1, deliveryUnknown: 0 },
      static_interactive: { attempted: 1, succeeded: 1, failed: 0, deliveryUnknown: 0 },
    },
    stream: {
      hostSeen: { start: 1, chunk: 4, textDelta: 4, blockEnd: 1, end: 1 },
      engineAccepted: { start: 1, textDelta: 4, end: 1 },
      finalReceived: 1,
      turnEndReceived: 1,
      aborted: 0,
      observedMode: 'static_interactive',
      finalStatic: { count: 1, lastReason: 'permission_denied', lastAt: 1790000003000 },
    },
    userState: 'missing_scope',
    turn: null,
  }
  const deniedTree = await renderPanelWith([larkChannel({ diagnostics: diagDenied })])
  const deniedGrant = diagText(deniedTree, 'grant')
  assert.match(deniedGrant, /Not granted/, 'denied grant renders')
  assert.match(deniedGrant, /scope_read/, 'denied grant keeps its source')
  const deniedEv = diagText(deniedTree, 'evidence')
  assert.match(deniedEv, /Real call denied/, 'denied evidence renders')
  assert.match(deniedEv, /HTTP 403/, 'the http status renders')
  assert.match(deniedEv, /code 99991672/, 'the platform code renders')
  assert.match(deniedEv, /Missing scope cardkit:card:write/, 'the missing scope renders')
  assert.match(deniedEv, /Missing scope/, 'the scope_denied category renders with its locale label')
  assert.match(diagText(deniedTree, 'userState'), /Missing CardKit permission/, 'missing_scope renders')
  assert.match(diagText(deniedTree, 'staticFinal'), /1×/, 'final static count renders')
  assert.match(diagText(deniedTree, 'staticFinal'), /permission denied/, 'final static reason renders')
  assert.match(diagText(deniedTree, 'observed'), /Final static card/, 'observedMode renders alongside')
  assert.match(diagText(deniedTree, 'firstAck'), /Not observed/, 'turn=null → not observed')
  const deniedText = treeText(deniedTree)
  assert.match(deniedText, /How to add the missing permission/, 'the minimal fix steps appear')
  assert.match(deniedText, /"Permissions"/, 'fix step 1 points at the app console')
  assert.match(deniedText, /one new message to verify/, 'fix step 3 asks for one new message')
  assert.match(deniedText, /Never paste any secret/, 'no-secret note is shown')
  assert.match(deniedText, /never auto-downgrades to plain text/, 'no automatic text downgrade is offered')
  assert.equal(countButtons(larkCardOf(deniedTree)), 1, 'even when denied: only the refresh button, no apply/probe/text-downgrade buttons')

  // (4) 300311（目标卡片身份）绝不当缺权：不显示 fix，按实际失败展示。
  const diagCardIdentity = {
    schemaVersion: 1,
    configuredMode: 'card',
    permissions: { cardkitWrite: { grant: 'unknown', source: null, checkedAt: null, queryState: 'failed', failedCategory: 'network', stale: false } },
    cardkit: {
      requiredScope: 'cardkit:card:write',
      state: 'denied',
      operationsVerified: [],
      lastFailure: { operation: 'card_put', httpStatus: 200, apiCode: 300311, category: 'card_identity', scope: '', at: 1790000004000 },
    },
    operations: { card_put: { attempted: 3, succeeded: 2, failed: 1, deliveryUnknown: 0 } },
    stream: { observedMode: 'static_interactive', finalStatic: { count: 1, lastReason: 'delivery_unknown', lastAt: 1790000004500 } },
    userState: 'unknown_delivery',
    turn: null,
  }
  const cardIdentityTree = await renderPanelWith([larkChannel({ diagnostics: diagCardIdentity })])
  const ciEv = diagText(cardIdentityTree, 'evidence')
  assert.match(ciEv, /code 300311/, 'the real code renders')
  assert.match(ciEv, /HTTP 200/, 'the http status renders')
  assert.match(ciEv, /Target card identity/, 'card_identity is classified as card identity, not scope')
  assert.match(diagText(cardIdentityTree, 'grant'), /query failed \(network\)/, 'grant query failure renders with its category on the grant row')
  assert.equal(findDiag(cardIdentityTree, 'fix'), null, '300311 must not trigger scope-fix steps')
  assert.match(diagText(cardIdentityTree, 'userState'), /Delivery unknown \(no resend\)/, 'unknown_delivery renders')
  assert.match(diagText(cardIdentityTree, 'grant'), /Not verified yet/, 'grant stays unknown without scope-read grant data')

  // (4b) 固定 scope 白名单与缺权判定：state/category 规则、300311 排除、任意字符串不进 UI。
  const makeScopeDiag = (cardkitOver) => {
    const diag = {
      schemaVersion: 1,
      configuredMode: 'card',
      permissions: { cardkitWrite: { grant: 'unknown', source: null, checkedAt: null, queryState: 'ok', failedCategory: null, stale: false } },
      cardkit: { requiredScope: 'evil:scope"onmouseover', state: 'unknown', operationsVerified: [], lastFailure: null },
      operations: {},
      stream: { observedMode: 'static_interactive', finalStatic: { count: 0, lastReason: null, lastAt: null } },
      userState: 'static_final',
      turn: null,
    }
    Object.assign(diag.cardkit, cardkitOver)
    return diag
  }
  // b1：cardkit.state=denied + 固定 scope（无 code）→ 缺权步骤出现，且只显示固定 scope
  const scopeStateTree = await renderPanelWith([larkChannel({ diagnostics: makeScopeDiag({
    state: 'denied',
    lastFailure: { operation: 'card_create', httpStatus: 403, scope: 'cardkit:card:write', at: 1790000005000 },
  }) })])
  assert.ok(findDiag(scopeStateTree, 'fix'), 'cardkit.state=denied with the fixed scope triggers fix steps without any code')
  assert.ok(treeText(scopeStateTree).includes('Required scope: cardkit:card:write'), 'only the fixed scope renders')
  assert.equal(treeText(scopeStateTree).includes('evil:scope'), false, 'the backend requiredScope string never renders')
  // b2：category=scope_denied + 固定 scope（无 code）→ 出现，且证据行显示类别译名
  const scopeCategoryTree = await renderPanelWith([larkChannel({ diagnostics: makeScopeDiag({
    lastFailure: { operation: 'card_create', category: 'scope_denied', scope: 'cardkit:card:write' },
  }) })])
  assert.ok(findDiag(scopeCategoryTree, 'fix'), 'category=scope_denied with the fixed scope triggers fix steps')
  assert.match(diagText(scopeCategoryTree, 'evidence'), /Missing scope/, 'the scope_denied category label renders')
  // b3：300311 即使 state=denied + 固定 scope 也不算缺权；card_identity 类别译名显示
  const scopeCardTree = await renderPanelWith([larkChannel({ diagnostics: makeScopeDiag({
    state: 'denied',
    lastFailure: { operation: 'card_put', apiCode: 300311, category: 'card_identity', scope: 'cardkit:card:write' },
  }) })])
  assert.equal(findDiag(scopeCardTree, 'fix'), null, '300311 never triggers scope-fix steps even with a matching scope')
  assert.ok(treeText(scopeCardTree).includes('code 300311'), 'the real code still renders')
  assert.match(diagText(scopeCardTree, 'evidence'), /Target card identity/, '300311 stays classified as card identity')
  // b4：operation 不在白名单 → 丢弃不渲染
  const scopeOpTree = await renderPanelWith([larkChannel({ diagnostics: makeScopeDiag({
    state: 'denied',
    lastFailure: { operation: 'evil_op', scope: 'cardkit:card:write' },
  }) })])
  assert.ok(findDiag(scopeOpTree, 'fix'), 'fix still shows from state+fixed scope')
  assert.equal(treeText(scopeOpTree).includes('evil_op'), false, 'a non-whitelisted operation string is dropped, not rendered')

  // (4c) 同 operation 不同 category 区分可见；未知类别显示占位、不原样渲染。
  const rateTree = await renderPanelWith([larkChannel({ diagnostics: makeScopeDiag({
    lastFailure: { operation: 'card_put', apiCode: 99991471, category: 'rate_limited' },
  }) })])
  const networkTree = await renderPanelWith([larkChannel({ diagnostics: makeScopeDiag({
    lastFailure: { operation: 'card_put', apiCode: 99991636, category: 'network_unknown' },
  }) })])
  assert.match(diagText(rateTree, 'evidence'), /Rate limited/, 'rate_limited renders its label')
  assert.match(diagText(networkTree, 'evidence'), /Network unknown/, 'network_unknown renders its label')
  assert.notEqual(diagText(rateTree, 'evidence'), diagText(networkTree, 'evidence'), 'same operation with different categories is visibly different')
  assert.equal(findDiag(rateTree, 'fix'), null, 'rate_limited never becomes a scope claim')
  assert.equal(findDiag(networkTree, 'fix'), null, 'network_unknown never becomes a scope claim')
  const weirdTree = await renderPanelWith([larkChannel({ diagnostics: makeScopeDiag({
    lastFailure: { operation: 'card_put', category: 'weird_cat', scope: '' },
  }) })])
  assert.match(diagText(weirdTree, 'evidence'), /Unknown category/, 'an unknown category shows the placeholder')
  assert.equal(treeText(weirdTree).includes('weird_cat'), false, 'the raw unknown category string is never rendered')

  // (5) 缺 diagnostics / 未知 schema / 非 lark 渠道：安全降级、不崩、不假绿。
  const missingTree = await renderPanelWith([larkChannel()])
  assert.match(diagText(missingTree, 'connection'), /running/, 'connection still renders without diagnostics')
  assert.match(diagText(missingTree, 'missing'), /does not provide diagnostics yet/, 'missing data is stated honestly')
  assert.equal(treeText(missingTree).includes('Observed success'), false, 'missing diagnostics never goes green')
  const unknownSchemaTree = await renderPanelWith([larkChannel({ diagnostics: { schemaVersion: 2, userState: 'completed' } })])
  assert.match(diagText(unknownSchemaTree, 'missing'), /unknown schema/, 'an unknown schemaVersion degrades safely')
  assert.equal(treeText(unknownSchemaTree).includes('Turn completed'), false, 'unknown schema renders no state claims')
  const otherTree = await renderPanelWith([{ key: 'telegram', label: 'Telegram', state: 'running', inboundCount: 1, outboundCount: 1 }])
  assert.equal(findDiag(otherTree, 'title'), null, 'only the lark channel gets the diagnostics panel')

  // (6) 恶意对象数据与脱敏：诊断值永不进属性，未知字段永不被渲染。
  const diagEvil = {
    schemaVersion: 1,
    configuredMode: 'card',
    session: 'oc_secret_session',
    token: 'sk-LIVE-SECRET',
    permissions: { cardkitWrite: { grant: 'granted', source: 'scope_read', checkedAt: 1790000000000, queryState: 'ok', failedCategory: null, stale: false } },
    cardkit: { state: 'observed_success', operationsVerified: ['card_create'], requiredScope: 'evil:scope"onmouseover', lastFailure: null },
    operations: {},
    stream: {
      body: 'user private message text',
      url: 'https://evil.example/leak?sid=1',
      observedMode: 'live_card',
      finalStatic: { count: 0, lastReason: null, lastAt: null },
      localRefusals: { count: 'x', lastCategory: 'weird_cat', lastAt: 'boom' },
    },
    userState: 'live_card',
    turn: {
      turnId: 'S'.repeat(100),
      step: 1,
      startedAt: 1790000000000,
      outcome: 'ok\u0007<img src=x onerror=alert(1)>',
      timings: { firstDeliveryAckMs: 'x<script>' },
      counts: { acceptedTextDelta: '12<script>', putBeforeFinal: -5 },
      staticFinal: { used: false, reason: null },
    },
  }
  const evilTree = await renderPanelWith([larkChannel({ diagnostics: diagEvil })])
  const evilText = treeText(evilTree)
  assert.equal(findDangerousAttr(evilTree), null, 'no href/src/innerHTML attribute ever receives diagnostic values')
  assert.equal(evilText.includes('oc_secret_session'), false, 'session ids are never rendered')
  assert.equal(evilText.includes('sk-LIVE-SECRET'), false, 'tokens are never rendered')
  assert.equal(evilText.includes('user private message text'), false, 'bodies are never rendered')
  assert.equal(evilText.includes('evil.example'), false, 'urls are never rendered')
  assert.equal(evilText.includes('\u0007'), false, 'control characters are stripped')
  assert.equal(evilText.includes('S'.repeat(17)), false, 'overlong fields are truncated')
  assert.equal(evilText.includes('weird_cat'), false, 'an unknown local-refusal category string is never rendered')
  assert.equal(findDiag(evilTree, 'refusals'), null, 'all-invalid localRefusals render no row at all')
  assert.match(diagText(evilTree, 'firstAck'), /Not observed/, 'non-numeric firstDeliveryAckMs falls back to not-observed')
  assert.equal(evilText.includes('accepted text-delta'), false, 'invalid counters are dropped entirely')
  assert.equal(evilText.includes('PUT confirmed ok before final'), false, 'negative counters are dropped')
  assert.match(diagText(evilTree, 'grant'), /Query reports granted/, 'grant still renders from whitelisted fields')
  assert.equal(evilText.includes('evil:scope'), false, 'an arbitrary requiredScope string never renders')
  assert.equal(evilText.includes('<img'), false, 'a non-identifier outcome is dropped instead of rendered')

  // (6b) 短且格式完全合法的隐私样式字符串同样被拒（不是只防 HTML/超长）。
  const diagShortLeak = {
    schemaVersion: 1,
    configuredMode: 'card',
    permissions: { cardkitWrite: { grant: 'unknown', source: null, checkedAt: null, queryState: 'never', failedCategory: null, stale: false } },
    cardkit: { state: 'unknown', operationsVerified: [], lastFailure: null },
    operations: {},
    stream: { observedMode: 'pending' },
    userState: 'receiving_no_output',
    turn: {
      turnId: 'ou_FAKE_PRIVATE',
      step: 1,
      startedAt: 1790000000000,
      outcome: 'SECRET_SYNTHETIC',
      timings: {},
      counts: {},
      staticFinal: { used: false, reason: null },
    },
  }
  const shortLeakTree = await renderPanelWith([larkChannel({ diagnostics: diagShortLeak })])
  const shortLeakText = treeText(shortLeakTree)
  assert.equal(shortLeakText.includes('ou_FAKE_PRIVATE'), false, 'a short identifier-shaped turnId is rejected (turnId is local anonymous safe integers only)')
  assert.equal(shortLeakText.includes('SECRET_SYNTHETIC'), false, 'a short identifier-shaped outcome is rejected (v1 enum only)')
  assert.match(shortLeakText, /Turn — · step 1 · — ·/, 'the row degrades to placeholders instead of raw strings')
  assert.equal(findDangerousAttr(shortLeakTree), null, 'still no dangerous attributes')

  // (6c) 合法匿名数字 turnId 与全部 v1 outcome 枚举显示。
  const legalTurnTree = await renderPanelWith([larkChannel({ diagnostics: Object.assign({}, diagShortLeak, {
    turn: Object.assign({}, diagShortLeak.turn, { turnId: 123, outcome: 'aborted' }),
  }) })])
  assert.match(treeText(legalTurnTree), /Turn 123 · step 1 · Aborted/, 'a safe-integer turnId and enum outcome render')
  for (const pair of [['in_progress', 'In progress'], ['completed', 'Completed'], ['canceled', 'Canceled'], ['aborted', 'Aborted'], ['failed', 'Failed']]) {
    const outcomeTree = await renderPanelWith([larkChannel({ diagnostics: Object.assign({}, diagShortLeak, {
      turn: Object.assign({}, diagShortLeak.turn, { turnId: 1, outcome: pair[0] }),
    }) })])
    assert.ok(treeText(outcomeTree).includes(pair[1]), 'outcome ' + pair[0] + ' renders as ' + pair[1])
  }

  // (6d) 失败原因固定译名（5 枚举）/未知与原文不泄露/缺字段=未提供/数值严格拒绝/
  // 旧 schema 无新字段安全降级；派发与 ACK 确认两套口径始终分开。
  const failedBase = JSON.parse(JSON.stringify(diagNormal))
  failedBase.userState = 'failed'
  failedBase.turn.outcome = 'failed'
  failedBase.turn.failureReason = null
  failedBase.turn.endKind = 'committed'
  failedBase.turn.completion = { pendingTasks: 2, pendingOps: 1, enginesPending: 0, cardsOpened: 1, cardsClosed: 0, incompleteSteps: 1 }
  const failureReasonExpectations = [
    ['cards_unclosed', /Cards still open at settlement/],
    ['delivery_unknown', /Delivery result unknown/],
    ['engine_incomplete', /Engine turn incomplete/],
    ['transport_failure', /Transport failure/],
    ['local_refusal', /Local refusal \(no request sent\)/],
  ]
  for (const [reason, expected] of failureReasonExpectations) {
    const fixture = JSON.parse(JSON.stringify(failedBase))
    fixture.turn.failureReason = reason
    const tree = await renderPanelWith([larkChannel({ diagnostics: fixture })])
    const rowText = diagText(tree, 'failureReason')
    assert.match(rowText, /Failure reason: /, 'the failure-reason row renders for ' + reason)
    assert.match(rowText, expected, reason + ' maps to its fixed label')
  }
  // failed 但无字段（null 或整字段缺失，旧版形态）→ 固定「未提供」，不猜。
  const missingReasonTrees = []
  const missingNull = JSON.parse(JSON.stringify(failedBase))
  missingNull.turn.failureReason = null
  missingReasonTrees.push(await renderPanelWith([larkChannel({ diagnostics: missingNull })]))
  const missingAbsent = JSON.parse(JSON.stringify(failedBase))
  delete missingAbsent.turn.failureReason
  missingReasonTrees.push(await renderPanelWith([larkChannel({ diagnostics: missingAbsent })]))
  for (const tree of missingReasonTrees) {
    assert.match(diagText(tree, 'failureReason'), /Failure reason: Not provided/, 'missing failureReason stays honest, no guessing')
  }
  // 未知枚举/任意原文/非字符串：固定占位，raw 绝不泄露。
  for (const raw of ['weird_reason', 'HTTP 500 <script>alert(1)</script>', 123]) {
    const fixture = JSON.parse(JSON.stringify(failedBase))
    fixture.turn.failureReason = raw
    const tree = await renderPanelWith([larkChannel({ diagnostics: fixture })])
    const rowText = diagText(tree, 'failureReason')
    assert.match(rowText, /Failure reason: Unknown reason \(raw value not shown\)/, 'unknown reason uses the fixed placeholder')
    assert.equal(rowText.includes(String(raw)), false, 'the raw failureReason never renders: ' + String(raw))
    assert.equal(treeText(tree).includes('<script>'), false, 'no markup leak through the failure reason')
    assert.equal(findDangerousAttr(tree), null, 'still no dangerous attributes')
  }
  // 数值严格拒绝：小数/字符串/负数/非有限对 completion、派发计数、派发时刻一律拒绝。
  const junkFixture = JSON.parse(JSON.stringify(failedBase))
  junkFixture.turn.failureReason = 'cards_unclosed'
  junkFixture.turn.completion = { pendingTasks: -1, pendingOps: '2', enginesPending: 1.5, cardsOpened: 3, cardsClosed: 0, incompleteSteps: Infinity }
  junkFixture.turn.counts.putDispatchedBeforeFinal = -2
  junkFixture.turn.counts.putDispatchedBeforeTurnEnd = '9x'
  junkFixture.turn.timings.firstPutDispatchMs = '500'
  junkFixture.turn.timings.lastPutDispatchMs = 2.5
  const junkTree = await renderPanelWith([larkChannel({ diagnostics: junkFixture })])
  const junkComp = diagText(junkTree, 'completion')
  assert.match(junkComp, /cards open 3\/closed 0/, 'valid completion integers render')
  assert.match(junkComp, /tasks pending —/, 'invalid completion numbers are rejected, not coerced')
  assert.match(junkComp, /incomplete steps —/, 'non-finite completion numbers are rejected')
  assert.equal(diagText(junkTree, 'counters').includes('PUT dispatched'), false, 'invalid dispatch counts drop the dispatch line')
  assert.match(diagText(junkTree, 'counters'), /PUT confirmed ok before final 3/, 'ACK counters unaffected by junk dispatch fields')
  const junkTimings = diagText(junkTree, 'timings')
  assert.match(junkTimings, /first dispatch —/, 'invalid dispatch timings fall back to a placeholder')
  assert.equal(junkTimings.includes('first dispatch 500'), false, 'string ms never coerced')
  assert.match(diagText(junkTree, 'failureReason'), /Cards still open at settlement/, 'the failure reason row survives junk elsewhere')
  // 旧 schema：turn 在但完全没有新增字段 → 未提供 + 无 completion/endKind 行 + 无派发行。
  const legacyTurnFixture = JSON.parse(JSON.stringify(failedBase))
  legacyTurnFixture.turn.outcome = 'failed'
  delete legacyTurnFixture.turn.failureReason
  delete legacyTurnFixture.turn.endKind
  delete legacyTurnFixture.turn.completion
  delete legacyTurnFixture.turn.counts.putDispatchedBeforeFinal
  delete legacyTurnFixture.turn.counts.putDispatchedBeforeTurnEnd
  delete legacyTurnFixture.turn.timings.firstPutDispatchMs
  delete legacyTurnFixture.turn.timings.lastPutDispatchMs
  const legacyTurnTree = await renderPanelWith([larkChannel({ diagnostics: legacyTurnFixture })])
  assert.match(diagText(legacyTurnTree, 'failureReason'), /Failure reason: Not provided/, 'old schema without the field is safe and honest')
  assert.equal(findDiag(legacyTurnTree, 'completion'), null, 'no completion row when the field is absent')
  assert.equal(findDiag(legacyTurnTree, 'endKind'), null, 'no endKind row when the field is absent')
  const legacyCounters = diagText(legacyTurnTree, 'counters')
  assert.equal(legacyCounters.includes('PUT dispatched'), false, 'no dispatch line when dispatch counts are absent')
  assert.match(legacyCounters, /PUT confirmed ok before final 3/, 'ACK counters keep working on old data')
  assert.match(diagText(legacyTurnTree, 'timings'), /first dispatch —/, 'absent dispatch timings show placeholders')
  assert.equal(treeText(legacyTurnTree).includes('undefined'), false, 'no undefined leaks into the legacy view')
  assert.equal(findDangerousAttr(legacyTurnTree), null, 'legacy turn view still has no dangerous attributes')
  // turn=null（旧版无 diagnostics turn）本就不出任何 turn 相关行。
  assert.equal(findDiag(unknownTree, 'failureReason'), null, 'turn=null never renders a failure row')
  assert.equal(findDiag(unknownTree, 'completion'), null, 'turn=null never renders a completion row')
  assert.equal(findDiag(unknownTree, 'endKind'), null, 'turn=null never renders an end-kind row')

  // (6e) 去重账本 + 图片诊断：跨模块消费**真实** createLarkDiagnostics().serialize() 出口
  // （不自造 shape，不与 client 内部互相印证）；lastError 两份枚举对照；容量 source 契约；
  // 历史背压与当前满分离；W1/W2 文案；图片操作桶防御与旧 schema 回归。
  {
    const base = JSON.parse(JSON.stringify(diagNormal))
    // 后台 serializer（lib/lark-diagnostics.js，仅测试导入，不进生产 client 加载路径）。
    const D = await import(require('node:url').pathToFileURL(path.join(root, 'lib', 'lark-diagnostics.js')).href)
    const mkDiag = (dedupSrc, imgSetup) => {
      const d = D.createLarkDiagnostics(4)
      d.setDedupReader(() => dedupSrc)
      d.setImagesAvailable(true)
      if (imgSetup) imgSetup(d)
      return d.serialize({ configuredMode: 'card', running: true, now: 1790000000000 })
    }
    const stats = { claims: 12, delivered: 10, rejected: 1, recoverable: 1, sendRecords: 1234, sendCapacityErrors: 0, sendSent: 1200, poisoned: false, lockMode: 'flock' }

    const unknown = mkDiag({ stats, lastError: '/synthetic/private/token' })
    assert.equal(unknown.dedup.lastError, null)
    assert.equal(unknown.dedup.lastErrorUnknown, true)
    const unknownTree = await renderPanelWith([larkChannel({ diagnostics: unknown })])
    assert.match(diagText(unknownTree, 'dedupStatus'), /Unknown ledger error/)
    assert.equal(treeText(unknownTree).includes('/synthetic/private/token'), false)

    // ---- X1 满容量 1234/1234（U1 回归：counts.* 唯一计数源，背压可见）----
    const full = mkDiag({ stats, sendCapacity: 1234, lastError: null })
    const fullTree = await renderPanelWith([larkChannel({ diagnostics: full })])
    assert.match(diagText(fullTree, 'dedupStatus'), /Capacity reached: new records are explicitly refused/, 'U1: used>=capacity shows explicit backpressure')
    const fullCounts = diagText(fullTree, 'dedupCounts')
    assert.match(fullCounts, /Inbound claims 12/, 'U1: counts render from counts.* (not flat fields)')
    assert.match(fullCounts, /Send receipts 1234\/1234/, 'U1: sendRecords vs capacity renders')
    assert.match(fullCounts, /Sends succeeded 1200/, 'counts.sendSent renders')
    assert.match(diagText(fullTree, 'dedupHint'), /Capacity configuration not yet wired/, 'W2: capacity config caveat, no config promise')
    assert.match(diagText(fullTree, 'dedupHint'), /no clear\/delete-ledger feature/, 'no clear feature note kept')

    // ---- X2 receiptErrors 整数（U2：后台单个非负整数，非枚举 map）----
    const rcpt = mkDiag({ stats, sendCapacity: 2000, lastError: null }, (d) => { d.noteImageReceiptError() })
    assert.equal(rcpt.images.receiptErrors, 1, 'backend serializes receiptErrors as an integer')
    const rcptTree = await renderPanelWith([larkChannel({ diagnostics: rcpt })])
    assert.match(diagText(rcptTree, 'imgReceipts'), /Send receipt store errors x1/, 'U2: integer receipt errors render as one fixed line')

    // ---- X3 容量来源契约：缺容量→“未提供”，绝不由 UI 补默认 2000（U3）----
    // backend 已落位 capacity:{sendReceipts,source}（缺值→null/null，不伪造）；
    // 全部场景走真实 serialize，不手工改写字段。
    const noCap = mkDiag({ stats, lastError: null }) // 不提供 sendCapacity → 真实缺容量
    assert.equal(noCap.dedup.capacity.sendReceipts, null, 'backend serializes missing capacity as null (no fallback 2000)')
    assert.equal(noCap.dedup.capacity.source, null, 'missing capacity carries source:null')
    const noCapTree = await renderPanelWith([larkChannel({ diagnostics: noCap })])
    const noCapCounts = diagText(noCapTree, 'dedupCounts')
    assert.match(noCapCounts, /Send receipts 1234\/—/, 'missing capacity shows the placeholder, never 2000')
    assert.match(noCapCounts, /capacity not provided/, 'missing capacity is explicit')
    assert.equal(noCapCounts.includes('2000'), false, 'U3: UI never invents the default capacity')
    assert.equal(treeText(noCapTree).includes('Capacity reached'), false, 'no backpressure claim without a known capacity')
    const cfgCap = mkDiag({ stats: { ...stats, sendRecords: 10 }, sendCapacity: 5000, sendCapacitySource: 'configured', lastError: null })
    assert.equal(cfgCap.dedup.capacity.source, 'configured', 'backend forwards the configured source')
    assert.match(diagText(await renderPanelWith([larkChannel({ diagnostics: cfgCap })]), 'dedupCounts'), /5000 \(configured\)/, 'configured source label from real serialize')
    const defCap = mkDiag({ stats: { ...stats, sendRecords: 10 }, sendCapacity: 2000, sendCapacitySource: 'default', lastError: null })
    assert.equal(defCap.dedup.capacity.source, 'default', 'backend forwards the default source')
    assert.match(diagText(await renderPanelWith([larkChannel({ diagnostics: defCap })]), 'dedupCounts'), /2000 \(default\)/, 'default source label from real serialize')

    // ---- X4 历史背压 ≠ 当前满（U4）：5000 容量已用 10、历史 errors=3 ----
    const hist = mkDiag({ stats: { ...stats, sendRecords: 10, sendCapacityErrors: 3 }, sendCapacity: 5000, lastError: null })
    const histTree = await renderPanelWith([larkChannel({ diagnostics: hist })])
    assert.equal(treeText(histTree).includes('Capacity reached'), false, 'U4: historical errors never claim current fullness')
    assert.match(diagText(histTree, 'dedupCounts'), /historical capacity backpressure x3/, 'U4: historical backpressure shown separately')

    // ---- X5 lastError 枚举两份对照（U5/U6）：backend 导出枚举逐项 UI 有译名且绝不 healthy ----
    const uiErrorsMatch = /const DIAG_DEDUP_ERRORS = \[([^\]]*)\]/.exec(clientSource)
    assert.ok(uiErrorsMatch, 'UI error enum is readable from the client source')
    const uiErrors = uiErrorsMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    const backendErrors = [...D.LARK_DEDUP_LAST_ERRORS]
    for (const code of backendErrors) {
      assert.ok(uiErrors.includes(code), 'UI enum covers backend error ' + code)
      const expected = dicts['dsh-messaging'].en['diag.dedupErr.' + code]
      assert.ok(expected, 'UI translation exists for ' + code)
      const tree = await renderPanelWith([larkChannel({ diagnostics: mkDiag({ stats, sendCapacity: 2000, lastError: code }) })])
      const status = diagText(tree, 'dedupStatus')
      assert.ok(status.includes(expected), code + ' renders its fixed translation: ' + status)
      assert.equal(status.includes('Ledger healthy'), false, code + ' never renders Ledger healthy')
    }
    const uiExtra = uiErrors.filter((e) => !backendErrors.includes(e))
    assert.deepEqual([...uiErrors].sort(), [...backendErrors].sort(), 'lastError enums match exactly after backend sync (both sides 9 items)')
    assert.match(fs.readFileSync(path.join(root, 'lib', 'lark-dedup.js'), 'utf8'), /LarkDedupError\('seq_exhausted'/, 'ledger really throws seq_exhausted (both sides now carry it)')

    // ---- X6 poisoned 真实链路 + reopen 权威字段（U7）+ W1 文案 ----
    const pois = mkDiag({ stats: { ...stats, poisoned: true }, sendCapacity: 2000, lastError: null })
    assert.equal(pois.dedup.reopen, 'needed', 'U7: backend serializes reopen:needed (authoritative)')
    assert.equal(pois.dedup.lastError, 'store_poisoned', 'backend derives store_poisoned for poisoned')
    const poisTree = await renderPanelWith([larkChannel({ diagnostics: pois })])
    const poisStatus = diagText(poisTree, 'dedupStatus')
    assert.match(poisStatus, /Ledger disabled \(write outcome uncertain\)/, 'poisoned renders')
    assert.ok(poisStatus.includes('dsh-messaging gateway'), 'W1: reload guidance points at the status panel')
    assert.match(poisStatus, /record retention awaits wiring verification/, 'W1: retention marked as awaiting wiring verification (no unverified promise)')
    assert.equal(poisStatus.includes('settings page'), false, 'W1: settings-page wording removed')
    assert.equal(poisStatus.includes('no records are ever cleared'), false, 'W1: unverified retention promise removed')

    // ---- X7 reader 缺失：backend available:false，UI 不假称健康；N2 读数行隐藏 ----
    const none = mkDiag(null)
    assert.equal(none.dedup.available, false, 'backend reports unavailable when the reader is missing')
    assert.equal(none.dedup.reopen, 'none', 'reopen is none for a non-poisoned unavailable reader')
    assert.equal(none.dedup.counts, null, 'backend emits counts:null when unavailable (full-zero rows are not real readings)')
    const noneTree = await renderPanelWith([larkChannel({ diagnostics: none })])
    assert.match(diagText(noneTree, 'dedupStatus'), /Ledger unavailable/, 'unavailable reader never claims health')
    assert.equal(findDiag(noneTree, 'dedupCounts'), null, 'N2: real-serialize full-zero counts/capacity row hidden when available!==true')
    assert.equal(findDiag(noneTree, 'dedupHint'), null, 'N2: capacity note rides the readings row and hides with it')

    // ---- N1：白名单外 lastError（短枚举 / raw 对象）→ 固定“未知账本错误” ----
    const weirdEnum = mkDiag({ stats, sendCapacity: 2000, lastError: null })
    weirdEnum.dedup.lastError = 'weird_short' // 消费端防御：backend 白名单外的值
    const weirdEnumTree = await renderPanelWith([larkChannel({ diagnostics: weirdEnum })])
    const weirdEnumStatus = diagText(weirdEnumTree, 'dedupStatus')
    assert.match(weirdEnumStatus, /Unknown ledger error/, 'N1 out-of-whitelist enum gets the fixed placeholder')
    assert.equal(weirdEnumStatus.includes('weird_short'), false, 'N1 raw enum never rendered')
    assert.equal(weirdEnumStatus.includes('Ledger healthy'), false, 'N1 never healthy while an unknown error value is present')
    const weirdObject = mkDiag({ stats, sendCapacity: 2000, lastError: null })
    weirdObject.dedup.lastError = { secret: 'raw_object_leak' }
    const weirdObjectTree = await renderPanelWith([larkChannel({ diagnostics: weirdObject })])
    const weirdObjectStatus = diagText(weirdObjectTree, 'dedupStatus')
    assert.match(weirdObjectStatus, /Unknown ledger error/, 'N1 raw object degrades to the same placeholder')
    assert.equal(treeText(weirdObjectTree).includes('raw_object_leak'), false, 'N1 raw object never leaks')
    assert.equal(weirdObjectStatus.includes('Ledger healthy'), false, 'N1 raw object is still an error state')

    // ---- N2：严格 boolean——字符串 'true' 不算可用，读数行隐藏、状态行保留 ----
    const strAvail = mkDiag({ stats, sendCapacity: 1234, lastError: null })
    strAvail.dedup.available = 'true'
    const strAvailTree = await renderPanelWith([larkChannel({ diagnostics: strAvail })])
    assert.match(diagText(strAvailTree, 'dedupStatus'), /Ledger unavailable/, "N2 string 'true' is not available (strict boolean)")
    assert.equal(findDiag(strAvailTree, 'dedupCounts'), null, "N2 counts/capacity row hidden for available='true'")
    assert.match(diagText(strAvailTree, 'dedupStatus'), /Ledger unavailable/, 'N2 fixed status row still renders')

    // ---- X8 'link' 虚假锁能力经 backend 归一 → UI 显示无锁（双方白名单一致）----
    const linkCase = mkDiag({ stats: { ...stats, lockMode: 'link' }, sendCapacity: 2000, lastError: null })
    assert.equal(linkCase.dedup.lockMode, null, "backend normalizes 'link' → null")
    assert.match(diagText(await renderPanelWith([larkChannel({ diagnostics: linkCase })]), 'dedupStatus'), /System file lock unavailable/, 'UI shows no-lock for a normalized null lockMode')

    // ---- X9 lock_unavailable：影响面只限飞书 + reopen 权威 none（不误导重开）----
    const noLock = mkDiag({ stats: { ...stats, lockMode: null }, sendCapacity: 2000, lastError: 'lock_unavailable' })
    assert.equal(noLock.dedup.reopen, 'none', 'reopen none when not poisoned')
    const noLockStatus = diagText(await renderPanelWith([larkChannel({ diagnostics: noLock })]), 'dedupStatus')
    assert.match(noLockStatus, /file lock capability missing/, 'lock_unavailable fixed translation')
    assert.match(noLockStatus, /other channels are unaffected/, 'other channels are not claimed failed')
    assert.equal(noLockStatus.includes('reopens the ledger'), false, 'no misleading reopen hint when reopen=none')

    // ---- X10 图片三权限经真实 setPermissions → serialize → renderer ----
    const perms = mkDiag({ stats, sendCapacity: 2000, lastError: null }, (d) => d.setPermissions({ images: {
      upload: { grant: 'granted', source: 'scope_read', checkedAt: 1790000000000 },
      download: { grant: 'unknown' },
      groupHistory: { grant: 'denied', source: 'scope_read', checkedAt: 1 }, // 老时间戳 → stale
    } }))
    const permsTree = await renderPanelWith([larkChannel({ diagnostics: perms })])
    const upRow = diagText(permsTree, 'imgPermUpload')
    assert.match(upRow, /Granted/, 'upload grant renders granted')
    assert.match(upRow, /requires any of: im:resource \| im:resource:upload/, 'upload OR-group scope note is the fixed constant')
    const dlRow = diagText(permsTree, 'imgPermDownload')
    assert.match(dlRow, /Unknown \(not returned \/ query failed\)/, 'download unknown is not judged denied')
    assert.match(dlRow, /im:message \| im:message:readonly \| im:message.history:readonly/, 'download OR-group note')
    assert.equal(dlRow.includes('im:message.group_msg'), false, 'download row never leaks the group-history scope')
    const ghRow = diagText(permsTree, 'imgPermGroupHistory')
    assert.match(ghRow, /Denied/, 'groupHistory deny renders independently')
    assert.match(ghRow, /\(result stale\)/, 'stale marker renders from checkedAt age')
    assert.match(ghRow, /im:message.group_msg/, 'groupHistory note uses only the history-re-fetch scope')

    // ---- X11 权限查询失败 → 三权限 stale=true（backend 910a17f6 规则），UI 显示过期括注 ----
    const failedQuery = mkDiag({ stats, sendCapacity: 2000, lastError: null }, (d) => d.setPermissions({ queryState: 'failed', images: { download: { grant: 'unknown' } } }))
    const failedQueryTree = await renderPanelWith([larkChannel({ diagnostics: failedQuery })])
    assert.match(diagText(failedQueryTree, 'imgPermDownload'), /\(result stale\)/, 'failed scope query marks image permissions stale')
    assert.match(diagText(failedQueryTree, 'imgPermDownload'), /Unknown \(not returned \/ query failed\)/, 'failed query stays unknown, never judged denied or granted')
    // F) 图片：三权限部分授予/未知/deny + 三操作桶 + receipt 固定译名。
    const images = JSON.parse(JSON.stringify(base))
    images.images = {
      schemaVersion: 1, available: true,
      permissions: {
        upload: { grant: 'granted', source: 'scope_read', checkedAt: 1790000000000, stale: false },
        download: { grant: 'unknown', source: null, checkedAt: null, stale: false },
        groupHistory: { grant: 'denied', source: 'scope_read', checkedAt: 1790000000000, stale: true },
      },
      operations: {
        image_upload: { attempted: 3, succeeded: 3, failed: 0, deliveryUnknown: 0 },
        image_download: { attempted: 2, succeeded: 1, failed: 1, deliveryUnknown: 0 },
        image_send: { attempted: 0, succeeded: 0, failed: 0, deliveryUnknown: 0 },
      },
      // receiptErrors 的整数形态已在 X2 走真实链路；此处不带 → 无行。
    }
    const imagesTree = await renderPanelWith([larkChannel({ diagnostics: images })])
    const uploadRow = diagText(imagesTree, 'imgPermUpload')
    assert.match(uploadRow, /Granted/, 'upload grant renders granted')
    assert.match(uploadRow, /requires any of: im:resource \| im:resource:upload/, 'upload OR-group scope note is the fixed constant')
    const downloadRow = diagText(imagesTree, 'imgPermDownload')
    assert.match(downloadRow, /Unknown \(not returned \/ query failed\)/, 'download unknown is not judged denied')
    assert.match(downloadRow, /im:message \| im:message:readonly \| im:message.history:readonly/, 'download OR-group note')
    const historyRow = diagText(imagesTree, 'imgPermGroupHistory')
    assert.match(historyRow, /Denied/, 'groupHistory deny renders')
    assert.match(historyRow, /\(result stale\)/, 'stale marker renders')
    assert.match(historyRow, /im:message.group_msg/, 'groupHistory note uses only the history-re-fetch scope, never a "group send" name')
    assert.equal(diagText(imagesTree, 'imgPermDownload').includes('im:message.group_msg'), false, 'download row never leaks the group-history scope')
    const uploadOp = diagText(imagesTree, 'imgOp_image_upload')
    assert.match(uploadOp, /tried 3\/ok 3\/failed 0\/unknown 0/, 'upload operation bucket renders independently')
    const downloadOp = diagText(imagesTree, 'imgOp_image_download')
    assert.match(downloadOp, /tried 2\/ok 1\/failed 1/, 'download bucket keeps its own evidence')
    assert.equal(findDiag(imagesTree, 'imgOp_image_send'), null, 'all-zero operation bucket renders no row')
    assert.equal(findDiag(imagesTree, 'imgReceipts'), null, 'no receipt row without receipt data')
    assert.match(diagText(imagesTree, 'imgStatus'), /not proof of any successful transfer/, 'service availability never claims a successful transfer')
    // G) 旧单域 imagesGrant（编辑态偶现）只当未知：绝不映射成 granted。
    const legacyGrant = JSON.parse(JSON.stringify(base))
    legacyGrant.images = { schemaVersion: 1, available: true, grant: 'granted', operations: {}, receiptErrors: {} }
    const legacyTree = await renderPanelWith([larkChannel({ diagnostics: legacyGrant })])
    assert.match(diagText(legacyTree, 'imgPermUpload'), /Unknown \(not returned \/ query failed\)/, 'legacy single-domain grant is treated as unknown, never granted')
    assert.equal(findDiag(legacyTree, 'imgReceipts'), null, 'no receipt row without receipt data')
    // H) 未知 schemaVersion → 整块隐藏。
    const futureSchema = JSON.parse(JSON.stringify(base))
    futureSchema.images = { schemaVersion: 2, available: true, permissions: { upload: { grant: 'granted' } } }
    const futureTree = await renderPanelWith([larkChannel({ diagnostics: futureSchema })])
    assert.equal(findDiag(futureTree, 'imgStatus'), null, 'unknown images schemaVersion hides the whole block')
    assert.equal(findDiag(futureTree, 'imgPermUpload'), null, 'no permission row under an unknown schema')
    // I) 恶意输入：dedup 面经真实 backend serialize（白名单归一）→ UI 双层防御；
    //    images 面由 UI reader 直接防御（手写非法注入）。
    const evil = JSON.parse(JSON.stringify(base))
    const evilDedupDiag = mkDiag({
      stats: { claims: NaN, delivered: 'x', sendRecords: { evil: 1 }, sendSent: Infinity, sendConflicts: {}, poisoned: false, lockMode: 'flock' },
      sendCapacity: '999secret',
      lastError: 'SECRET_TOKEN_XYZ',
    })
    evil.dedup = evilDedupDiag.dedup
    evil.images = {
      schemaVersion: 1, available: 'yes',
      permissions: {
        upload: { grant: 'ou_private_id', source: 'http://evil.example', checkedAt: 'boom<script>', stale: 'yes' },
        download: { grant: 'granted', source: 'scope_read', checkedAt: 1790000000000, stale: false },
        groupHistory: { grant: {}, source: 'scope_read', checkedAt: [], stale: false },
      },
      operations: { image_upload: { attempted: 3, succeeded: -1, failed: 'x', deliveryUnknown: '9secret' } },
      receiptErrors: 'SECRETLEAK',
    }
    const evilImageTree = await renderPanelWith([larkChannel({ diagnostics: evil })])
    const evilTextAll = treeText(evilImageTree)
    for (const secret of ['SECRET_TOKEN_XYZ', 'ou_private_id', 'evil.example', 'boom', 'SECRETLEAK', '999secret', '9secret', '<img']) {
      assert.equal(evilTextAll.includes(secret), false, 'diagnostics never leak: ' + secret)
    }
    assert.equal(findDangerousAttr(evilImageTree), null, 'no dangerous attributes from dedup/images blocks')
    assert.equal(diagText(evilImageTree, 'dedupStatus').includes('SECRET_TOKEN_XYZ'), false, 'unknown lastError never renders raw (backend normalizes, UI whitelist second layer)')
    assert.match(diagText(evilImageTree, 'dedupCounts'), /Inbound claims 0/, 'non-numeric counters normalize to 0 at backend, never render garbage')
    assert.match(diagText(evilImageTree, 'imgPermUpload'), /Unknown \(not returned \/ query failed\)/, 'unknown grant string degrades to unknown')
    assert.match(diagText(evilImageTree, 'imgPermGroupHistory'), /Unknown \(not returned \/ query failed\)/, 'object grant degrades to unknown')
    const evilUploadOp = diagText(evilImageTree, 'imgOp_image_upload')
    assert.match(evilUploadOp, /tried 3\/ok —\/failed —\/unknown —/, 'illegal operation numbers degrade to placeholders (no coercion)')
    const evilReceiptsTree = diagText(evilImageTree, 'imgReceipts')
    assert.equal(evilReceiptsTree, null, 'non-integer receiptErrors never render a receipt row')
    assert.equal(findDiag(evilImageTree, 'dedupCounts') !== null && treeText(evilImageTree).includes('999secret'), false, 'non-numeric capacity never renders raw')
    // J) 旧版缺新块：安全隐藏，旧诊断 UI 回归。
    const legacy = JSON.parse(JSON.stringify(base))
    const legacyTree2 = await renderPanelWith([larkChannel({ diagnostics: legacy })])
    assert.equal(findDiag(legacyTree2, 'dedupStatus'), null, 'missing dedup block renders nothing')
    assert.equal(findDiag(legacyTree2, 'imgStatus'), null, 'missing images block renders nothing')
    assert.match(diagText(legacyTree2, 'userState'), /Turn completed/, 'legacy diagnostics regression intact')
  }

  // (7) 中英文 locale 完整性与首延迟口径。
  const zhDict = dicts['dsh-messaging'].zh
  const enDict = dicts['dsh-messaging'].en
  const diagKeys = Object.keys(zhDict).filter((key) => key.indexOf('diag.') === 0)
  assert.ok(diagKeys.length >= 70, 'the zh diagnostics locale block is complete: ' + diagKeys.length)
  for (const key of diagKeys) {
    assert.ok(zhDict[key], 'zh locale empty: ' + key)
    assert.ok(enDict[key], 'en locale missing: ' + key)
  }
  assert.equal(zhDict['diag.firstAckLabel'], '首段发送确认延迟（从首个有效文本增量起）', 'the ack label names its start point')
  assert.match(zhDict['diag.firstAckNote'], /非屏幕首显延迟/, 'zh says the ack is not screen-visible latency')
  assert.match(enDict['diag.firstAckLabel'], /from first accepted text delta/, 'en ack label names its start point')
  assert.match(enDict['diag.firstAckNote'], /not screen-visible latency/, 'en says the ack is not screen-visible latency')
  assert.notEqual(zhDict['diag.title'], enDict['diag.title'], 'zh and en differ')
  assert.doesNotMatch(clientSource, /JSON\.stringify\([^)]*diagnostics/, 'the whole diagnostics object is never stringified for display/copy')

  // (8) 只读权限刷新闭环：请求形状 → 权威 status 重读 → 成功≠granted →
  //     错误枚举本地映射 → 离线/旧版安全 → 单飞 + 5s 最小间隔。
  const scopeBase = {
    schemaVersion: 1,
    generation: 5,
    configuredMode: 'card',
    permissions: { cardkitWrite: { grant: 'unknown', source: null, checkedAt: null, queryState: 'never', failedCategory: null, stale: false } },
    cardkit: { state: 'unknown', operationsVerified: [], lastFailure: null },
    operations: {},
    stream: { observedMode: 'pending' },
    turn: null,
  }
  const clickRefresh = async (tree) => {
    const btn = findDiag(tree, 'refresh')
    assert.ok(btn && btn.type === 'button', 'the refresh button is present')
    assert.equal(btn.props.disabled, false, 'the button must be enabled before clicking')
    btn.props.onClick()
    await flush()
    await flush()
    resetState()
    return render(panel.component, panelFace)
  }

  refreshMode = 'ok'
  let refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  const statusBefore = statusCalls('/__dsh-messaging/status')
  refreshTree = await clickRefresh(refreshTree)
  assert.equal(refreshCalls.length, 1, 'exactly one refresh request')
  assert.equal(refreshCalls[0].method, 'POST', 'refresh uses POST')
  assert.ok(refreshCalls[0].url.endsWith('/__dsh-messaging/diagnostics/refresh-scope'), 'the exact endpoint path is used')
  assert.equal(refreshCalls[0].body, '{}', 'the request body is {}')
  assert.ok(statusCalls('/__dsh-messaging/status') > statusBefore, 'status is re-read after refresh (authoritative diagnostics)')
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, 'success shows Query complete')
  assert.match(diagText(refreshTree, 'grant'), /Not verified yet/, 'success ≠ granted: grant keeps the authoritative status value')
  const winBtn = findDiag(refreshTree, 'refresh')
  assert.equal(winBtn.props.disabled, true, 'the button is disabled inside the 5s window')
  await panelFace.refreshScope()
  await flush()
  assert.equal(refreshCalls.length, 1, 'a direct call inside the 5s window sends no second request')

  refreshMode = 'server_error'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Too frequent, please retry shortly/, 'rate_limited maps to its local label')
  assert.equal(refreshCalls.length, 2)

  refreshMode = 'unknown_error'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Unexpected API response/, 'an unknown server error maps to the generic local label')
  assert.equal(treeText(refreshTree).includes('<script>'), false, 'the raw error string is never rendered')

  refreshMode = 'offline'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Unreachable \(offline or older backend without this endpoint\)/, 'offline/older backend shows unreachable')
  assert.equal(treeText(refreshTree).includes('sk-SECRET-LEAK'), false, 'the raw offline exception is never rendered')

  refreshMode = 'hang'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  const hangBtn = findDiag(refreshTree, 'refresh')
  assert.ok(hangBtn && hangBtn.type === 'button', 'the button renders before the hang')
  const beforeHang = refreshCalls.length
  hangBtn.props.onClick()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  const inflightBtn = findDiag(refreshTree, 'refresh')
  assert.equal(inflightBtn.props.disabled, true, 'in-flight disables the button')
  assert.ok(treeText(refreshTree).includes('Refreshing'), 'the in-flight label renders')
  await panelFace.refreshScope()
  await flush()
  assert.equal(refreshCalls.length, beforeHang + 1, 'single-flight: no second request while in flight')
  releaseHang()
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, 'a released hang completes normally')

  // (8f) POST ok 但权威 GET 失败：不得绿色完成；固定本地译名；原始异常/HTTP 错误不进 UI。
  refreshMode = 'ok'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  statusFailNext = true
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Status read failed/, 'GET 失败不得显示 Query complete')
  assert.equal(treeText(refreshTree).includes('Query complete'), false, '旧状态不得被绿色完成遮住')
  assert.ok(treeText(refreshTree).includes('Status read failed (previous snapshot still shown)'), '刷新行显示固定本地译名')
  assert.ok(treeText(refreshTree).includes('Status read failed (no fresh diagnostics)'), '全局错误行也映射固定译名')
  assert.equal(treeText(refreshTree).includes('SYNTHETIC_PRIVATE_ERROR_STATUS'), false, 'GET 原始异常不进 UI')

  refreshMode = 'ok'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  statusHttpNext = true
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Status read failed/, 'HTTP 错误同样固定译名')
  assert.equal(treeText(refreshTree).includes('SYNTHETIC_HTTP_PRIVATE'), false, 'HTTP 原始错误不进 UI')

  refreshMode = 'ok'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  statusMalformedNext = true
  refreshTree = await clickRefresh(refreshTree)
  assert.equal(treeText(refreshTree).includes('Query complete'), false, '畸形状态不判成功')
  assert.equal(treeText(refreshTree).includes('SYNTHETIC_HTML_PRIVATE'), false, '畸形状态原文不进 UI')

  // (8g) generation 三方绑定（请求发起 / 返回 / 权威 GET 后）：缺失与跨代都不判成功。
  const noGen = JSON.parse(JSON.stringify(scopeBase))
  delete noGen.generation
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: noGen })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Unexpected API response/, '缺代际的畸形成功不判成功')
  assert.equal(treeText(refreshTree).includes('Query complete'), false)

  refreshMode = 'stale_resp'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Generation changed/, '返回代际≠请求代际 → stale_generation')
  assert.equal(treeText(refreshTree).includes('Query complete'), false)

  refreshMode = 'hang_post'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  findDiag(refreshTree, 'refresh').props.onClick()
  await flush()
  const gen6 = JSON.parse(JSON.stringify(scopeBase))
  gen6.generation = 6
  statusChannels = [larkChannel({ diagnostics: gen6 })] // POST 挂起期间权威状态换代
  releasePost() // 返回 generation 5
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Generation changed/, '权威 GET 后代际≠返回代际 → stale_generation')
  assert.equal(treeText(refreshTree).includes('Query complete'), false, '旧代响应不得显示为新代成功')
  // 代际只增不减：后续场景跟随已观测的最新代（真实宿主语义），保持夹具单调。
  scopeBase.generation = 6
  okPayload.generation = 6

  // (8h) 权威 GET 挂起：单飞覆盖整个闭环，无第二个 POST。
  refreshMode = 'ok'
  holdStatus = true
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  const postsBeforeHold = refreshCalls.length
  findDiag(refreshTree, 'refresh').props.onClick()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.equal(findDiag(refreshTree, 'refresh').props.disabled, true, 'GET 挂起期间按钮仍禁用')
  assert.ok(treeText(refreshTree).includes('Refreshing'), 'GET 挂起期间仍显示查询中')
  await panelFace.refreshScope()
  await panelFace.refreshScope()
  assert.equal(refreshCalls.length, postsBeforeHold + 1, 'GET 挂起期间不发第二个 POST（单飞覆盖 await load）')
  releaseStatus()
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, 'GET 结算后闭环完成')
  holdStatus = false

  // (8i) 冷却到期由本地定时器通知解除，不依赖轮询。
  refreshMode = 'ok'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  const statusBeforeCooldown = statusCalls('/__dsh-messaging/status')
  findDiag(refreshTree, 'refresh').props.onClick()
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.equal(findDiag(refreshTree, 'refresh').props.disabled, true, '完成后进入冷却')
  const cooldownTimer = timeouts.filter((h) => h.ms === 5000 && !h.cleared).pop()
  assert.ok(cooldownTimer, '存在 5 秒冷却本地定时器')
  cooldownTimer.fn() // 到期通知（不靠轮询重渲染）
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.equal(findDiag(refreshTree, 'refresh').props.disabled, false, '冷却到期由本地通知解除')
  assert.equal(statusCalls('/__dsh-messaging/status'), statusBeforeCooldown + 1, '冷却解除不产生新的 status 请求')

  // (8k) 刷新在途 + 真实并发轮询异常：原始异常绝不进全局 UI，过期成功不假绿。
  refreshMode = 'ok'
  holdStatus = true // 一次性持有刷新的 GET
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  findDiag(refreshTree, 'refresh').props.onClick()
  await flush()
  // 触发一次真实轮询路径：优先复用既有 5s 轮询句柄，否则订阅启动一个。
  let pollTick = intervals.find((h) => h.ms === 5000 && !h.cleared)
  if (!pollTick) {
    const offPoll = statusStore.subscribe(() => {})
    pollTick = intervals.find((h) => h.ms === 5000 && !h.cleared)
    void offPoll
  }
  assert.ok(pollTick, '存在可用的状态轮询触发')
  await flush()
  statusFailNext = true // 轮询 GET 抛合成私密错误
  pollTick.fn()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  const pollLeakText = treeText(refreshTree)
  assert.ok(pollLeakText.includes('Status read failed (no fresh diagnostics)'), '轮询失败也走固定本地译名')
  assert.equal(pollLeakText.includes('SYNTHETIC_POLL_PRIVATE'), false, '轮询原始异常不进全局 UI')
  assert.ok(pollLeakText.includes('Refreshing'), '刷新仍在途（单飞未提前结算）')
  assert.equal(findDiag(refreshTree, 'refresh').props.disabled, true, '在途期间按钮仍禁用')
  releaseStatus() // 释放受保护的刷新 GET（比失败轮询更旧的请求序）
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.equal(treeText(refreshTree).includes('Query complete'), false, '被更新请求取代的旧 GET 不得显示成功')
  assert.match(diagText(refreshTree, 'refreshStatus'), /Generation changed/, '过期成功归类为代际/过期变化')
  assert.ok(treeText(refreshTree).includes('Status read failed (no fresh diagnostics)'), '轮询失败的固定错误保留到下次成功读取')
  holdStatus = false

  // (8l) reload（GET gen7 先到）后，旧刷新 GET（冻结 gen6 后释放）不得发布/回滚/成功。
  refreshMode = 'ok'
  holdStatus = true
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })]) // gen5
  findDiag(refreshTree, 'refresh').props.onClick()
  await flush()
  const gen7Diag = JSON.parse(JSON.stringify(scopeBase))
  gen7Diag.generation = 7
  statusChannels = [larkChannel({ diagnostics: gen7Diag })]
  await panelFace.reload() // POST /reload + 新 GET（gen7 先结算）
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.ok(treeText(refreshTree).includes('generation 7'), 'reload 后界面确认 generation 7')
  releaseStatus() // 释放旧刷新 GET（冻结的 gen6）
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.equal(treeText(refreshTree).includes('Query complete'), false, '旧 gen6 GET 不显示成功')
  assert.match(diagText(refreshTree, 'refreshStatus'), /Generation changed/, '旧 GET 归类代际变化，不回滚')
  assert.ok(treeText(refreshTree).includes('generation 7'), '权威代际不被旧响应回滚')
  holdStatus = false

  // (8m) HTTP 200 畸形 status：保旧快照 + 固定错误 + 组件不抛。
  const shapeVariants = [
    { channels: { synthetic: 'x' }, sessions: [], recent: [], errors: [] },
    { channels: 'nope', sessions: [], recent: [], errors: [] },
    { channels: [null], sessions: [], recent: [], errors: [] },
    { channels: [], sessions: { a: 1 }, recent: [], errors: [] },
    [{ key: 'lark' }],
  ]
  for (const shape of shapeVariants) {
    refreshMode = 'ok'
    statusShapeNext = true
    statusShapePayload = shape
    refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
    refreshTree = await clickRefresh(refreshTree) // 内部重渲染：不抛即通过
    assert.ok(findDiag(refreshTree, 'title'), '旧快照（lark 卡片）保留')
    assert.match(diagText(refreshTree, 'refreshStatus'), /Status read failed/, '畸形 shape → 固定读取失败')
    assert.equal(treeText(refreshTree).includes('Query complete'), false, '畸形 shape 不判成功')
    assert.equal(treeText(refreshTree).includes('synthetic'), false, '畸形字段内容不被渲染')
  }
  statusShapeNext = false
  statusShapePayload = null

  // (8n) 服务端固定错误键与失败也重读：stale_generation 有译名；scope read failed；未知/异常同样重读。
  const statusCount = () => statusCalls('/__dsh-messaging/status')
  refreshMode = 'server_stale'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  let beforeN = statusCount()
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Generation changed/, '服务端 stale_generation 键有本地译名')
  assert.equal(statusCount(), beforeN + 1, '服务端失败也重读权威 status')

  refreshMode = 'server_read_failed'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  beforeN = statusCount()
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Scope read failed/, 'scope read failed 键有本地译名')
  assert.equal(statusCount(), beforeN + 1)

  refreshMode = 'unknown_error'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  beforeN = statusCount()
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Unexpected API response/, '未知键 → 通用本地文案')
  assert.equal(statusCount(), beforeN + 1, '未知错误也重读')

  refreshMode = 'offline'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  beforeN = statusCount()
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Unreachable/, 'POST 异常 → 不可达译名')
  assert.equal(statusCount(), beforeN + 1, 'POST 异常也重读（原始异常不进 UI）')
  assert.equal(treeText(refreshTree).includes('sk-SECRET-LEAK'), false)
  refreshMode = 'ok'

  // (8p) 可信实例身份 instanceEpoch（只比相等不比大小）：换实例后 generation 任意（降/等）
  // 都恢复；迟到旧实例响应不回滚（即便旧 epoch 数字更大）；普通 reload epoch 不变不重置；
  // refresh 结果 epoch 不符/缺失不绿；旧后端无 instanceEpoch 保兼容（同实例护栏）。
  refreshMode = 'ok'
  scopeBase.generation = 7
  okPayload.generation = 7
  statusInstanceEpoch = 101
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, '实例 101 上 gen7 闭环成功')

  // 普通 reload：epoch 不变（101）→ 无实例重置，代际正常前进。
  const gen8Diag2 = JSON.parse(JSON.stringify(scopeBase))
  gen8Diag2.generation = 8
  statusChannels = [larkChannel({ diagnostics: gen8Diag2 })]
  await panelFace.reload()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.ok(treeText(refreshTree).includes('generation 8'), '同实例普通 reload 正常前进 gen8')
  assert.equal(statusInstanceEpoch, 101, '普通 reload 不改变实例身份')

  // 宿主重启：instanceEpoch 101→202，generation 从 8 降到 1（合法：新实例任意起点）。
  statusInstanceEpoch = 202
  const gen1Diag = JSON.parse(JSON.stringify(scopeBase))
  gen1Diag.generation = 1
  statusChannels = [larkChannel({ diagnostics: gen1Diag })]
  await panelFace.reload()
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.ok(treeText(refreshTree).includes('generation 1'), '新实例 gen1（比旧代小）成功恢复')
  assert.equal(findButton(refreshTree, 'Reload').props.disabled, false, 'busy 已释放')

  // 新实例闭环：refresh 回包携带 instanceEpoch 202。
  okPayload.generation = 1
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: gen1Diag })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, '实例 202 上 gen1 闭环成功')

  // 等值恢复：再重启 202→303，generation 仍为 1（相等也可恢复，只比 epoch 相等）。
  statusInstanceEpoch = 303
  await panelFace.reload()
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.ok(treeText(refreshTree).includes('generation 1'), '新实例 generation 相等也恢复')

  // 迟到旧实例响应：旧实例 epoch 999（数字更大也不认）冻结后新实例 404 先落地。
  statusInstanceEpoch = 999
  statusChannels = [larkChannel({ diagnostics: scopeBase })] // 旧实例 gen7
  holdStatus = true
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  findDiag(refreshTree, 'refresh').props.onClick() // 冻结旧实例响应（epoch 999/gen7）
  await flush()
  statusInstanceEpoch = 404
  const gen2Diag = JSON.parse(JSON.stringify(scopeBase))
  gen2Diag.generation = 2
  statusChannels = [larkChannel({ diagnostics: gen2Diag })]
  await panelFace.reload() // 新实例请求先结算：epoch 404≠捕获 303 且≠观测 303 → 实例更替 + 应用 gen2
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.ok(treeText(refreshTree).includes('generation 2'), '实例更替后权威代际为 gen2')
  releaseStatus() // 旧 epoch(999) GET 晚回（请求序更旧）
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.ok(treeText(refreshTree).includes('generation 2'), '迟到旧实例响应（epoch 更大）不覆盖新实例 gen2')
  assert.equal(treeText(refreshTree).includes('Query complete'), false, '旧实例响应不产生旧代成功')
  holdStatus = false

  // refresh 结果 epoch 不符 / 缺失 → 不绿（status 有实例身份时）。
  refreshEpochMode = 'fixed'
  refreshFixedEpoch = 12345
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: gen2Diag })])
  const beforeEpochFail = statusCalls('/__dsh-messaging/status')
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Generation changed/, 'refresh 结果 epoch 不符 → 不判成功')
  assert.equal(treeText(refreshTree).includes('Query complete'), false)
  assert.ok(statusCalls('/__dsh-messaging/status') > beforeEpochFail, 'epoch 不符也重读 status')
  refreshEpochMode = 'missing'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: gen2Diag })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Unexpected API response/, 'refresh 结果缺 instanceEpoch → 不虚构成功')
  assert.equal(treeText(refreshTree).includes('Query complete'), false)
  refreshEpochMode = 'current'

  // 旧后端（无 instanceEpoch）：保兼容——同实例护栏照旧，跨实例恢复需重新打开面板。
  statusHasEpoch = false
  const legacyDiag = JSON.parse(JSON.stringify(gen2Diag))
  legacyDiag.generation = 1
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: gen2Diag })])
  statusChannels = [larkChannel({ diagnostics: legacyDiag })]
  await panelFace.reload()
  await flush()
  await flush()
  resetState()
  refreshTree = render(panel.component, panelFace)
  assert.ok(treeText(refreshTree).includes('generation 2'), '旧后端无实例身份：同实例代际护栏照旧（不虚构跨实例成功）')
  assert.equal(findButton(refreshTree, 'Reload').props.disabled, false, '旧后端过期路径也释放 busy')
  statusHasEpoch = true

  // (8o) 可渲染列表 null 项：当前有效代际的 HTTP200 sessions/recent [null] 不发布、不崩、保旧快照。
  const gen8Diag = JSON.parse(JSON.stringify(scopeBase))
  gen8Diag.generation = 8
  const shapeItemVariants = [
    { channels: [larkChannel({ diagnostics: gen8Diag })], sessions: [null], recent: [], errors: [] },
    { channels: [larkChannel({ diagnostics: gen8Diag })], sessions: [], recent: [null], errors: [] },
  ]
  for (const shape of shapeItemVariants) {
    refreshMode = 'ok'
    statusShapeNext = true
    statusShapePayload = shape
    refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
    refreshTree = await clickRefresh(refreshTree) // 内部重渲染：不抛即通过
    assert.ok(findDiag(refreshTree, 'title'), '旧快照（lark 卡片）保留')
    assert.match(diagText(refreshTree, 'refreshStatus'), /Status read failed/, 'null 列表项 → 固定读取失败')
    assert.equal(treeText(refreshTree).includes('Query complete'), false, 'null 列表项不判成功')
  }
  statusShapeNext = false
  statusShapePayload = null

  // (8q) 发起/POST/最终采用 status 必须三方同实例：POST 正确回旧 epoch900，但权威 GET 已换
  // 实例 epoch100（generation 相同）→ 不得 Query complete（旧实例查询不能证明新实例完成）。
  refreshMode = 'ok'
  scopeBase.generation = 10
  okPayload.generation = 10
  statusInstanceEpoch = 900
  await panelFace.reload() // 先实际加载：建立 epoch900/gen10 观测
  await flush()
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, 'epoch900/gen10 闭环成功')
  // 再次刷新：POST 挂住（回包=发起时冻结的 epoch900/gen10）
  refreshMode = 'hang_post'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  findDiag(refreshTree, 'refresh').props.onClick()
  await flush()
  statusInstanceEpoch = 100 // 释放 POST 前：权威宿主已换实例（generation 仍为 10）
  releasePost()
  await flush()
  await flush()
  resetState()
  refreshTree = renderNow()
  assert.equal(statusStore.getSnapshot().data.instanceEpoch, 100, '权威 GET 已发布新实例 epoch100')
  assert.match(diagText(refreshTree, 'refreshStatus'), /Generation changed/, 'POST 属旧实例而权威 GET 已换代 → 不判成功')
  assert.equal(treeText(refreshTree).includes('Query complete'), false, '旧实例的查询不能证明新实例完成')
  assert.ok(treeText(refreshTree).includes('generation 10'), '诊断/权限数据仍正常显示（同 generation 不掩盖实例变化）')

  // (8r) 真实注册 poll 的 10 个在途 GET 乱序结算：新 epoch200 先到，旧 epoch100 后到
  // 不回滚——捕获身份用请求闭包存活到结算（无容量逐出），请求序更新也不可信旧 epoch。
  refreshMode = 'ok'
  const makeDiagPayload = (epoch, gen, userState) => {
    const d = JSON.parse(JSON.stringify(scopeBase))
    d.generation = gen
    d.userState = userState
    return { instanceEpoch: epoch, generation: gen, channels: [larkChannel({ diagnostics: d })], sessions: [], recent: [], errors: [] }
  }
  // 10 个 GET 发起时均观测 epoch100（当前观测值）。
  statusHoldPayloads = [
    makeDiagPayload(200, 5, 'completed'), // 请求序最小：新实例 epoch200 先结算
    makeDiagPayload(100, 5, 'failed'), // 请求序更大：旧实例 epoch100 后结算
  ].concat(Array.from({ length: 8 }, () => makeDiagPayload(100, 5, 'failed')))
  let raceTick = pollTick
  if (!raceTick) {
    const offRace = statusStore.subscribe(() => {})
    raceTick = intervals.find((h) => h.ms === 5000 && !h.cleared)
    void offRace
  }
  assert.ok(raceTick, '存在可用的状态轮询触发')
  for (let i = 0; i < 10; i++) raceTick.fn() // 10 个真实注册 poll 发起的挂起 GET
  assert.equal(heldStatusGets.length, 10, '10 个 GET 均挂起')
  assert.equal(statusHoldPayloads.length, 0, '响应按发起序冻结待释放')
  heldStatusGets[0]() // 新 epoch200 先到
  await flush()
  await flush()
  let raceTree = renderNow()
  assert.equal(statusStore.getSnapshot().data.instanceEpoch, 200, '新实例 epoch200 先应用')
  assert.match(diagText(raceTree, 'userState'), /Turn completed/, '新实例视图生效')
  heldStatusGets[1]() // 请求序更大、旧 epoch100 后到
  await flush()
  await flush()
  raceTree = renderNow()
  assert.equal(statusStore.getSnapshot().data.instanceEpoch, 200, '更旧实例响应即便请求序更新也不回滚')
  assert.match(diagText(raceTree, 'userState'), /Turn completed/, '旧实例内容不覆盖新视图')
  for (let i = 2; i < 10; i++) heldStatusGets[i]()
  await flush()
  await flush()
  assert.equal(statusStore.getSnapshot().data.instanceEpoch, 200, '其余旧实例响应全部拒绝')
  statusHoldPayloads = null
  raceTree = renderNow()
  assert.ok(treeText(raceTree).includes('generation 5'), '最终视图保持新实例数据')

  // (8s) instanceEpoch:null（后端随机源失败的明确未知身份）：status/诊断仍可读，
  // 但不虚构跨实例确认成功（固定提示），null==null 不绿；恢复合法 epoch 后流程照旧。
  refreshMode = 'ok'
  scopeBase.generation = 10
  okPayload.generation = 10
  statusInstanceEpoch = 300
  await panelFace.reload() // 先建立对 epoch300 的观测
  await flush()
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, '合法 epoch300 闭环成功')
  statusInstanceEpoch = null // 后端随机源失败：明确返回 instanceEpoch:null
  await panelFace.reload()
  await flush()
  await flush()
  const identUnknownTree = renderNow()
  assert.ok(findDiag(identUnknownTree, 'title'), '身份未知时诊断面板仍显示')
  assert.ok(findDiag(identUnknownTree, 'grant'), '权限查询数据仍显示（status 仍可读）')
  assert.match(diagText(identUnknownTree, 'refreshStatus'), /Identity unverifiable \(reload the page to rebuild the connection\)/, '身份未知 → 固定提示，不假绿')
  assert.equal(treeText(identUnknownTree).includes('Query complete'), false, 'null 身份不得判成功')
  // 身份未知时刷新：同样固定提示（不因 null==null 绿）
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  const beforeUnknown = statusCalls('/__dsh-messaging/status')
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Identity unverifiable/, '刷新也固定提示身份不可验证')
  assert.equal(treeText(refreshTree).includes('Query complete'), false)
  assert.ok(statusCalls('/__dsh-messaging/status') > beforeUnknown, '仍安全重读 status')
  // 恢结合法 epoch：流程照旧
  statusInstanceEpoch = 300
  await panelFace.reload()
  await flush()
  await flush()
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, '身份恢复后合法闭环照旧')
  statusInstanceEpoch = 101

  // (8t) 有效非过期 GET 报告 identityEpoch:null / 字段缺失且 generation 更低（10→1）：
  // 撤绿必须发生在低代早返之前——旧 marker 不得继续 Query complete；缓存代保留但边界诚实。
  refreshMode = 'ok'
  scopeBase.generation = 10
  okPayload.generation = 10
  statusHasEpoch = true
  statusInstanceEpoch = 900
  statusChannels = [larkChannel({ diagnostics: scopeBase })]
  await panelFace.reload() // 实际 reload：epoch900/gen10
  await flush()
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, 'refresh 成功 marker900/gen10 绿建立')
  // 探针A：新有效 GET = instanceEpoch:null + generation 1（低代会被早返拒绝，但旧绿先撤）
  const gen1NullDiag = JSON.parse(JSON.stringify(scopeBase))
  gen1NullDiag.generation = 1
  statusInstanceEpoch = null
  statusChannels = [larkChannel({ diagnostics: gen1NullDiag })]
  await panelFace.reload()
  await flush()
  await flush()
  let probeTree = renderNow()
  assert.match(diagText(probeTree, 'refreshStatus'), /Identity unverifiable \(reload the page to rebuild the connection\)/, 'null 身份 + 低代：固定 identity_unknown 提示（低代早返不绕过撤绿）')
  assert.equal(treeText(probeTree).includes('Query complete'), false, '旧 marker 已撤销，不再 Query complete')
  assert.equal(statusStore.getSnapshot().data.instanceEpoch, 900, '缓存边界诚实：低代响应被旧响应护栏拒绝，快照仍是旧实例')
  assert.ok(treeText(probeTree).includes('generation 10'), '旧权限/诊断缓存仍可读，但已失去当前实例保证')
  assert.ok(findDiag(probeTree, 'grant'), '权限查询数据仍显示')
  assert.ok(findDiag(probeTree, 'title'), '组件不抛、状态可读')
  // 探针B：独立路径——字段完全省略（旧后端/降级形态）+ generation 1
  statusInstanceEpoch = 300 // 恢复合法身份（清除 unknown 标记）以独立建立新绿
  statusHasEpoch = true
  statusChannels = [larkChannel({ diagnostics: scopeBase })]
  await panelFace.reload()
  await flush()
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  refreshTree = await clickRefresh(refreshTree)
  assert.match(diagText(refreshTree, 'refreshStatus'), /Query complete/, '探针B 独立绿建立（marker300/gen10）')
  const gen1MissingDiag = JSON.parse(JSON.stringify(scopeBase))
  gen1MissingDiag.generation = 1
  statusHasEpoch = false // 字段缺失
  statusChannels = [larkChannel({ diagnostics: gen1MissingDiag })]
  await panelFace.reload()
  await flush()
  await flush()
  probeTree = renderNow()
  assert.equal(treeText(probeTree).includes('Query complete'), false, '字段缺失 + 低代：旧绿已撤销（未确认）')
  assert.equal(diagText(probeTree, 'refreshStatus'), null, '未确认：不显成功行、不虚构降级错误')
  assert.ok(treeText(probeTree).includes('generation 10'), '缓存代保持，读数边界诚实')
  assert.ok(findDiag(probeTree, 'grant'), '权限缓存可读')
  assert.ok(findDiag(probeTree, 'title'), '组件不抛')
  statusHasEpoch = true
  statusInstanceEpoch = 101

  // (8j) dispose：清冷却定时器；挂起 POST 迟到不发 GET、不更新状态。
  refreshMode = 'hang_post'
  refreshTree = await renderPanelWith([larkChannel({ diagnostics: scopeBase })])
  findDiag(refreshTree, 'refresh').props.onClick()
  await flush()
  const scopeAtDispose = JSON.parse(JSON.stringify(statusStore.getSnapshot().scope))
  const statusBeforeDispose = statusCalls('/__dsh-messaging/status')
  const pendingCooldown = timeouts.filter((h) => h.ms === 5000 && !h.cleared).pop()
  assert.ok(pendingCooldown, '刷新期间存在冷却定时器')
  statusFace.dispose()
  assert.equal(pendingCooldown.cleared, true, 'dispose 清理冷却定时器')
  releasePost() // 迟到 POST 结算
  await flush()
  await flush()
  assert.equal(
    JSON.stringify(statusStore.getSnapshot().scope),
    JSON.stringify(scopeAtDispose),
    'dispose 后迟到结果不更新 scope 状态',
  )
  assert.equal(statusCalls('/__dsh-messaging/status'), statusBeforeDispose, 'dispose 后迟到 POST 不再触发 GET')

  console.log('client-smoke: ok')
  console.log('mutate calls:', mutateCalls.length, '| ops:', JSON.stringify(mutateCalls.map((entry) => entry.ops)))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
