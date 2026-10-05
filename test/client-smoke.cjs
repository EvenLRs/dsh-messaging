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
assert.doesNotMatch(clientSource, /slots\.inject\('settings\.section'/, 'settings.section must be gone')
assert.match(clientSource, /credentials: 'same-origin'/)
assert.doesNotMatch(clientSource, /host\.call/)
assert.doesNotMatch(clientSource, /Authorization/)

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
  const endMarkers = [/\n        function /, /\n        slots\.inject\(/, /\n    exports\.name/]
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
    timeout() { return () => {} },
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return locale
      if (name === 'configForms') return configForms
      return undefined
    },
  }
  return { ctx, registrations, intervals, configForms, dicts }
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

async function main() {
  const calls = []
  // 页面不再调用 /__dsh-messaging/config；只有状态面板还打 /status（P4 再处理）。
  const fetchImpl = (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', opts })
    const body = String(url).endsWith('/status')
      ? {
        channels: [],
        sessions: [],
        // 飞书入站痕迹（lark-drop）：面板要能展示它，且缺 text 时不得渲染成 undefined。
        recent: [{ at: 1790000000000, kind: 'lark-drop', channel: 'lark', reason: 'unsupported message_type', messageType: 'image', chatType: 'p2p', textLen: null }],
        errors: [],
      }
      : { ok: true }
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) })
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

  const { ctx, registrations, intervals, configForms, dicts } = makeCtx({ row: configFormsRow })
  plugin.apply(ctx)
  assert.equal(calls.length, 0, 'apply itself must not fetch')

  // ── P3-1：注册的是 plugins.row.config，key 正确，且 settings.section 已消失 ──
  const rowEntry = registrations.find((entry) => entry.options.name === 'plugins.row.config')
  assert.ok(rowEntry, 'the row config slot must be registered')
  assert.equal(rowEntry.options.key, 'dsh-messaging#dsh-messaging', 'the row key follows cordis.patch.yml (id: dsh-messaging)')
  assert.equal(
    registrations.some((entry) => entry.options.name === 'settings.section'),
    false,
    'settings.section must no longer be registered',
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
  const summary = render(rowEntry.component, pageProps({ view: 'summary' }))
  assert.match(
    treeText(summary),
    /Configure message channels, QR login and inbound credentials/,
    'the summary one-liner renders',
  )

  let tree = await renderPage()
  let text = treeText(tree)
  assert.match(text, /Message Channel Configuration/)
  assert.match(text, /OneBot v11/)
  assert.match(text, /Telegram/)
  assert.match(text, /Personal WeChat/)
  assert.ok(hasAttr(tree, 'data-official'), 'the official SettingsForm shell is used when ui-primitives resolves')
  assert.equal(calls.length, 0, 'no config fetch while rendering the page')

  // ── P3-3：Lark webhookOnly 字段仍按模式显隐 ───────────────────────────────
  const larkInputCount = async (mode) => {
    formState.value.adapters.lark = Object.assign({}, formState.value.adapters.lark, { enabled: true, mode })
    const rendered = await renderPage()
    let count = 0
    const walk = (node, insideLark) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach((child) => walk(child, insideLark))
      const inLark = insideLark || (node.type === 'details' && node.props && node.props.key === 'lark')
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
  assert.ok(findInputByPlaceholder(tree, 'Cleared when you save'), 'the pending clear is announced')
  findButton(tree, 'Save').props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(mutateCalls[2].ops)), [
    { op: 'unset', path: ['adapters', 'telegram', 'token'] },
  ], 'clearing a secret becomes an unset op (drop the override)')

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
  const fallbackEntry = fallbackCtxBundle.registrations.find((entry) => entry.options.name === 'plugins.row.config')
  assert.ok(fallbackEntry, 'the page registers even without ui-primitives')
  fallbackReact.resetCursor()
  const fallbackTree = render(fallbackEntry.component, bindFace(fallbackEntry.options.inject(), { view: 'page', form }, dicts, fallbackReact))
  assert.equal(hasAttr(fallbackTree, 'data-official'), false, 'the fallback shell is used when the module is missing')
  assert.ok(findButton(fallbackTree, 'Save'), 'the fallback shell still offers save')

  // ── P4：组件函数体内不得出现 ctx（业务/传输状态都在 controller 里）────
  for (const name of ['PluginConfigSection', 'MessagingSettingsPage', 'WeChatLoginPanel', 'LarkSetupPanel', 'MessagingPanel', 'Field']) {
    const body = componentBody(clientSource, name)
    assert.ok(body.length > 0, 'component exists: ' + name)
    assert.equal(/ctx\./.test(body), false, name + ' must not touch ctx (it takes props only)')
  }

  // ── P4：StatusController 没有订阅者时不发请求，最后一个退订后停掉 interval ─
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

  console.log('client-smoke: ok')
  console.log('mutate calls:', mutateCalls.length, '| ops:', JSON.stringify(mutateCalls.map((entry) => entry.ops)))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
