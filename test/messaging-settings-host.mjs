// Current rc.3 SlotCore + real Cordis/UI ConfigForms, synthetic remote/settings
// and status only. React hooks/rendering and snapshot store are test adapters;
// no browser pixels, production editor, network, credentials or profile used.
import './_guard.cjs'
import assert from 'node:assert/strict'
import { LARK_SCOPE_CARDKIT_WRITE, LARK_IMAGE_SCOPE_GROUPS, LARK_IMAGE_GROUP_HISTORY_SCOPE } from '../lib/lark-diagnostics.js'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
const host = path.resolve(process.env.DSH_HOSTX_ROOT || '/tmp/dsh-hostx')
const modules = path.join(host, 'dsh/node_modules/@deepseek-ai')
const file = (pkg) => path.join(modules, pkg, 'lib/client.js')
assert.ok(fs.existsSync(file('dsh-client-ui-settings')), 'real host required; no silent skip')
const Cordis = await import(pathToFileURL(path.join(modules, 'cordis/lib/index.js')))
const frontend = path.join(modules, 'dsh-web-frontend/dist/assets')
const built = fs.readdirSync(frontend).filter(n => /^index-.*\.js$/.test(n)).map(n => fs.readFileSync(path.join(frontend, n), 'utf8')).find(s => s.includes('SlotCore:'))
assert.ok(built, 'rc.3 bundled SlotCore must exist')
const slotName = built.match(/SlotCore:([A-Za-z_$][\w$]*)/)[1]
// Keep the host's entire small slot module (helpers + classes), not a mirrored implementation.
const actualStart = built.indexOf('function kI(') // rc.3 frozen asset; fail explicitly on incompatible host
assert.ok(actualStart >= 0 && slotName === 'SI', 'host SlotCore extraction contract changed')
const sourceEnd = built.indexOf(';const jI=', actualStart)
const slotExports = vm.runInNewContext(built.slice(actualStart, sourceEnd + 1) + ';({ SlotCore: SI, resolveSlotLabel: $I })', { queueMicrotask })
const core = new slotExports.SlotCore()
const slots = {
  entries: name => core.entries(name), getVersion: name => core.getVersion(name),
  register: (options, component) => core.register(options, component),
  inject(name, register) {
    let off
    const sync = () => {
      if (core.record(name).spec && !off) off = register()
      else if (!core.record(name).spec && off) { off(); off = undefined }
    }
    const unsub = core.subscribeDeclaration(name, sync); sync()
    return () => { unsub(); off?.(); off = undefined }
  },
}
const snapshotStore = (initial) => {
  let state = initial; const listeners = new Set()
  return { getSnapshot: () => state, set(next) { state = next; for (const fn of [...listeners]) fn() }, update(fn) { const next = structuredClone(state); fn(next); this.set(next) }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
let active = null, effects = [], instances = new Map()
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.flat(Infinity) } : {}) } }),
  useId: () => 'synthetic-settings-title',
  useRef: initial => ({ current: initial }),
  useState(initial) {
    const owner = active, i = owner.cursor++
    if (!(i in owner.state)) owner.state[i] = typeof initial === 'function' ? initial() : initial
    return [owner.state[i], next => { owner.state[i] = typeof next === 'function' ? next(owner.state[i]) : next }]
  },
  useEffect(fn, deps) {
    const owner = active, i = owner.cursor++, prev = owner.effects[i]
    if (!prev || !deps || deps.some((v, j) => !Object.is(v, prev.deps?.[j]))) effects.push(() => { prev?.off?.(); owner.effects[i] = { deps, off: fn() } })
  },
}
function unmount() { for (const owner of instances.values()) for (const effect of Object.values(owner.effects)) effect.off?.(); instances = new Map() }
function render(node, key = 'root') {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n, i) => render(n, key + '/' + (n?.props?.key ?? i)))
  if (typeof node.type === 'function') {
    const id = key + ':' + node.type.name
    let owner = instances.get(id)
    if (!owner) instances.set(id, owner = { state: [], effects: {}, cursor: 0 })
    const previous = active; active = owner; owner.cursor = 0
    const result = node.type(node.props); active = previous
    return render(result, id)
  }
  return { type: node.type, props: node.props, children: render(node.props.children, key + '/' + node.type) }
}
const dictionaries = {}
const t = (key, vars) => (dictionaries.zh?.[key] || key).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? k))
function bound(entry, extra = {}) {
  const face = entry.inject?.() || {}, props = { ...extra, t }
  for (const [key, source] of Object.entries(face.hooks || {})) props['use' + key[0].toUpperCase() + key.slice(1)] = selector => {
    const [, bump] = React.useState(0)
    React.useEffect(() => source.subscribe(() => bump(n => n + 1)), [])
    return selector(source.getSnapshot())
  }
  for (const [key, value] of Object.entries(face)) if (key !== 'hooks') props[key] = value
  return { type: entry.component, props }
}
async function draw(entry, extra) { let tree = render(bound(entry, extra)); for (const fn of effects.splice(0)) fn(); await tick(); tree = render(bound(entry, extra)); for (const fn of effects.splice(0)) fn(); return tree }
function all(tree, predicate, visible = true) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(x => all(x, predicate, visible))
  if (visible && tree.props?.hidden) return []
  return [...(predicate(tree) ? [tree] : []), ...all(tree.children, predicate, visible)]
}
function text(tree) { if (tree == null || tree === false) return ''; if (typeof tree !== 'object') return String(tree); return Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.children) }
const button = (tree, label) => all(tree, x => x.type === 'button' && text(x).includes(label))[0]
const input = (tree, id) => all(tree, x => ['input', 'select'].includes(x.type) && x.props.id === 'dsh-messaging-' + id)[0]
function loadClient(source, require, fetch) {
  let factory
  vm.runInNewContext(source, { document: { body: {}, querySelector: () => ({}) }, window: { __ModuleLoader__: { load(x) { factory = x.factory } } }, fetch, setTimeout, clearTimeout, console, structuredClone, queueMicrotask })
  return factory(require)
}
let revision = 7, writable = true, served = true, failure = false, conflict = false
let value = { adapters: { onebot: { enabled: false }, lark: { enabled: true, mode: 'long-connection', appId: 'synthetic', interactiveCard: false }, wechat: { enabled: false, baseUrl: 'https://example.invalid' } }, agent: { agentPreset: '', cwd: '', provider: null, model: null } }
const mutations = [], requests = []
let diagnosticsMode = 'complete'
let mutationGate = null, statusFailure = false, runtimeState = 'running', imagePermissionsPresent = true, cardkitPermission = { grant: 'unknown', queryState: 'never' }
const view = () => ({ writable, namespaces: served ? [{ ns: 'dsh-messaging', revision, value: structuredClone(value), base: {}, user: {}, schema: { type: 'any' }, secrets: [{ path: ['adapters', 'lark', 'appSecret'], set: true }] }] : [] })
const remoteSettings = {
  async describe() { return { ok: true, value: view() } },
  async mutate(ns, ops, expected) {
    mutations.push(structuredClone({ ns, ops, expected }))
    if (mutationGate) await mutationGate
    if (failure) throw new Error('synthetic-private-error')
    if (conflict || expected !== revision) { revision++; return { ok: false, error: { message: 'conflict' } } }
    for (const op of ops) { let target = value; for (const key of op.path.slice(0, -1)) target = target[key] ||= {}; if (op.op === 'unset') delete target[op.path.at(-1)]; else target[op.path.at(-1)] = op.value }
    revision++; return { ok: true, value: view().namespaces[0] }
  },
}
const root = new Cordis.Context()
root.provide('remote', { settings: remoteSettings, $on: () => () => {} })
root.provide('remote.settings', remoteSettings)
root.provide('slots', slots)
root.provide('locale', { register(ns, dicts) { Object.assign(dictionaries, dicts); return () => {} } })
const { default: Timer } = await import(pathToFileURL(path.join(modules, 'cordis-plugin-timer/lib/index.js')))
root.plugin(Timer)
const settings = loadClient(fs.readFileSync(file('dsh-client-ui-settings'), 'utf8'), name => {
  if (name === '@deepseek-ai/cordis') return Cordis
  if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshotStore }
  throw new Error('Unexpected real UI settings dependency: ' + name)
})
let settingsFiber = root.plugin(settings); await tick()
const fetch = async (url, init = {}) => {
  requests.push({ url, method: init.method || 'GET' })
  if (statusFailure && url.endsWith('/status')) throw new Error('synthetic-secret-path-id-error')
  const data = url.endsWith('/status') ? { instanceEpoch: 1, channels: [{ key: 'lark', state: runtimeState, diagnostics: { schemaVersion: 1, generation: 1, configuredMode: 'text', permissions: { cardkitWrite: cardkitPermission }, images: imagePermissionsPresent ? { schemaVersion: 1, permissions: { upload: { grant: 'unknown', source: 'synthetic-private' }, download: { grant: 'granted', source: 'scope_read', checkedAt: 100, stale: true }, groupHistory: { grant: 'denied' } } } : null } }], sessions: [], recent: [], errors: [] } : { ok: false }
  if (data.channels) {
    const diag = data.channels[0].diagnostics
    if (diagnosticsMode === 'missing-diagnostics') delete data.channels[0].diagnostics
    if (diagnosticsMode === 'missing-cardkit') delete diag.permissions.cardkitWrite
    if (diagnosticsMode === 'missing-permissions') delete diag.permissions
    if (diagnosticsMode === 'missing-image-key') delete diag.images.permissions.download
    if (diagnosticsMode === 'missing-image-permissions') delete diag.images.permissions
    if (diagnosticsMode === 'no-lark') data.channels = []
  }
  return { ok: true, text: async () => JSON.stringify(data) }
}
// Exercise the real rc.3 SettingsForm owner as well as the slot/configForms.
const settingsFormStart = built.indexOf('function dR(')
const settingsFormEnd = built.indexOf('function fR(', settingsFormStart)
assert.ok(settingsFormStart >= 0 && settingsFormEnd > settingsFormStart, 'real SettingsForm extraction contract')
const names = built.match(/Zi=\{([^}]+)\}/)[1].split(',')
const settingsClasses = Object.fromEntries(names.map(pair => {
  const [key, variable] = pair.split(':')
  const match = built.match(new RegExp('(?:const |,)' + variable + '="([^"]+)"'))
  assert.ok(match, 'real SettingsForm class mapping: ' + key)
  return [key, match[1]]
}))
const formJsx = (type, props) => ({ type, props })
const RealSettingsForm = vm.runInNewContext(built.slice(settingsFormStart, settingsFormEnd) + ';dR', { C: React, d: { jsx: formJsx, jsxs: formJsx }, Zi: settingsClasses })
const client = loadClient(fs.readFileSync(process.env.MESSAGING_PREVIEW_CLIENT || new URL('../lib/client.js', import.meta.url), 'utf8'), name => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { SettingsForm: RealSettingsForm }
  throw new Error('unexpected client dependency')
}, fetch)
// Optional inert preview of the actually rendered synthetic trees. No scripts,
// live handlers, secrets or backend URLs are exported; browser pixels are NOT tested.
function preview(name, tree) {
  if (!process.env.MESSAGING_PREVIEW_DIR) return
  const out = path.resolve(process.env.MESSAGING_PREVIEW_DIR); fs.mkdirSync(out, { recursive: true })
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const unitless = new Set(['fontWeight', 'lineHeight', 'opacity', 'flex', 'flexGrow', 'flexShrink', 'order'])
  const css = style => Object.entries(style || {}).map(([key, value]) => key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ':' + (typeof value === 'number' && value !== 0 && !unitless.has(key) ? value + 'px' : value)).join(';')
  function html(node, selectedValue) {
    if (node == null || node === false) return ''
    if (Array.isArray(node)) return node.map(child => html(child, selectedValue)).join('')
    if (typeof node !== 'object') return escape(node)
    if (node.props.hidden) return ''
    if (node.type === 'style') return '<style>' + node.children.join('').replace(/<\/style/gi, '') + '</style>'
    const attrs = Object.entries({ ...node.props, ...(node.type === 'option' && node.props.value === selectedValue ? { selected: true } : {}) }).flatMap(([key, value]) => {
      if (key === 'children' || key.startsWith('on') || key === 'key' || key === 'ref' || value == null || value === false) return []
      if (key === 'style') return ['style="' + escape(css(value)) + '"']
      if (key === 'className') key = 'class'
      if (value === true) return [key + '="' + (key.startsWith('data-') ? 'true' : '') + '"']
      return [key + '="' + escape(value) + '"']
    }).join(' ')
    return '<' + node.type + ' ' + attrs + '>' + html(node.children, node.type === 'select' ? node.props.value : selectedValue) + '</' + node.type + '>'
  }
  const theme = fs.readFileSync(file('dsh-client-ui-theme'), 'utf8')
  const themeCss = [...theme.matchAll(/var (?:base|design_platform)_css_default = ("(?:[^"\\]|\\.)*");/g)].map(m => JSON.parse(m[1])).join('\n')
  const hostCss = fs.readdirSync(frontend).filter(n => n.endsWith('.css')).map(n => fs.readFileSync(path.join(frontend, n), 'utf8')).join('\n')
  const formCss = (hostCss.match(/[^{}]+\{[^{}]*\}/g) || []).filter(rule => Object.values(settingsClasses).some(cls => rule.includes('.' + cls))).join('\n')
  for (const mode of ['light', 'dark']) fs.writeFileSync(path.join(out, name + '-' + mode + '.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; connect-src \'none\'; form-action \'none\'"><title>合成渲染预览 · ' + name + '</title><style>' + themeCss + formCss + 'body{margin:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:13px/1.6 system-ui}main{max-width:560px;margin:24px auto;padding:24px}nav{padding:12px;background:var(--dsw-alias-bg-module-platform)}nav a{color:inherit;margin-right:12px}button,input,select{pointer-events:none}</style></head><body ' + (mode === 'dark' ? 'data-ds-dark-theme' : '') + '><nav>实际组件树 · 合成数据 · 静态预览，非像素验收 <a href="overview-' + mode + '.html">概览</a><a href="lark-' + mode + '.html">飞书详情</a><a href="diagnostics-' + mode + '.html">诊断</a></nav><main>' + html(tree) + '</main></body></html>')
}

const fiber = root.plugin(client); await tick()
assert.equal(core.entries('settings.section').length, 0, 'registration waits for actual slot declaration')
const declare = () => core.registerFactory({ name: 'test-host-shell', scope: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'plugins.row.config': { kind: 'keyed', scope: 'root' }, 'tool.view.cordis': { kind: 'keyed', scope: 'root' } } }, () => null)
let removeShell = declare(); await tick()
const entry = core.entries('settings.section')[0], diagnostic = core.entries('plugins.row.config')[0]
assert.equal(entry.options.id, 'messaging'); assert.equal(entry.options.label, 'Messaging')
assert.equal(diagnostic.options.key, 'dsh-messaging#dsh-messaging')
// Execute the real owner navigation projection and owner components, not only
// hand-declared slot types. Internal exports are instrumented in-memory solely
// to exercise the shipped rc.3 functions; owner apply/layers/browser are not run.
const generalSource = fs.readFileSync(file('dsh-client-ui-settings-general'), 'utf8')
const managerSource = fs.readFileSync(file('dsh-client-ui-plugin-manager'), 'utf8')
const jsx = { jsx: (type, props, key) => ({ type, props: { ...props, key } }), jsxs: (type, props, key) => ({ type, props: { ...props, key } }) }
const primitives = new Proxy({}, { get: (_, key) => key === 'useModalLayer' ? () => {} : function HostPrimitive(props) { return { type: 'span', props } } })
const ownerRequire = name => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return jsx
  if (name === 'react-dom') return { createPortal: node => node }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  if (name === '@deepseek-ai/dsh-client-ui-slots') return slotExports
  if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshotStore }
  throw new Error('unexpected owner import ' + name)
}
const generalOwner = loadClient(generalSource.replace('exports.apply = apply;', 'exports.__owner = SettingsPanel; exports.apply = apply;'), ownerRequire)
const managerOwner = loadClient(managerSource.replace('exports.apply = apply;', 'exports.__owner = RowDetail; exports.apply = apply;'), ownerRequire)
const mapStart = generalSource.indexOf('const version = ctx.slots.getVersion("settings.section");')
const mapEnd = generalSource.indexOf('return rows;', mapStart) + 'return rows;'.length
assert.ok(mapStart > 0 && mapEnd > mapStart)
const navRows = vm.runInNewContext('(function(){let rowsVersion=-1,rowsRevision=-1,rows=[];return () => {' + generalSource.slice(mapStart, mapEnd) + '};})()', { ctx: { slots, locale: { getSnapshot: () => ({ revision: 1 }) } }, _deepseek_ai_dsh_client_ui_slots: slotExports })
assert.equal(navRows()[0].label, 'Messaging', 'actual owner entries mapping produces navigation label')
assert.equal(navRows()[0].id, 'messaging')
const consumed = []
const renderSlot = (name, props, selected = {}) => {
  consumed.push({ name, selected, view: props.view })
  const selectedEntry = core.entries(name).find(row => (!selected.only || row.options.id === selected.only) && (!selected.entryKey || row.options.key === selected.entryKey))
  return selectedEntry ? bound(selectedEntry, props) : null
}
let ownerTree = await draw({ component: generalOwner.__owner }, { rows: navRows(), activeId: 'messaging', onSelect() {}, onClose() {}, renderSlot })
assert.ok(button(ownerTree, 'Messaging'), 'real SettingsPanel renders the nav button')
assert.ok(consumed.some(row => row.name === 'settings.section' && row.selected.only === 'messaging'), 'real owner consumes active settings slot')
unmount()
ownerTree = await draw({ component: managerOwner.__owner }, { pkg: { name: 'dsh-messaging', rows: [] }, row: { rowId: 'dsh-messaging', moduleName: 'dsh-messaging' }, t, resolveText: value => typeof value === 'string' ? value : undefined, onBack() {}, renderSlot, form: root.get('configForms').get('dsh-messaging') })
assert.ok(consumed.some(row => row.name === 'plugins.row.config' && row.view === 'page' && row.selected.entryKey === 'dsh-messaging#dsh-messaging'))
assert.ok(all(ownerTree, row => row.props?.['data-messaging-diagnostics']).length === 1, 'real RowDetail consumes diagnostic page')
unmount()
let tree = await draw(entry)
preview('overview', tree)
if (!process.env.MESSAGING_PREVIEW_CLIENT) {
  assert.equal(all(tree, row => row.props?.['data-messaging-ui']).length, 1)
  assert.equal(all(tree, row => row.props?.['data-channel-row']).length, 7)
  assert.equal(button(tree, '飞书 / Lark').props.style.border, 0, 'channel navigation is a row link, not a boxed button')
  const css = text(all(tree, row => row.type === 'style'))
  assert.ok(css.includes('--dsw-alias-label-primary') && css.includes('input[type=checkbox]'))
  assert.ok(!css.includes('--color-'), 'styles use real rc.3 theme namespace')
}
assert.equal(all(tree, x => x.type === 'button' && / ›$/.test(text(x))).length, 7)
assert.equal(input(tree, 'adapters.lark.appId'), undefined, 'detail fields hidden on overview')
if (!process.env.MESSAGING_PREVIEW_CLIENT) {
  const rows = all(tree, row => row.props?.['data-channel-row'])
  assert.deepEqual(rows.map(row => text(all(row, x => x.type === 'button')[0]).replace(/ ›$/, '')), ['飞书 / Lark', '企业微信', '个人微信', 'OneBot v11', 'Telegram', 'Discord', 'Slack'])
  const stateText = () => text(all(tree, row => row.props?.['data-channel-status'] === 'lark')[0])
  assert.equal(stateText(), '已启用·已连接')
  assert.equal(all(all(tree, row => row.props?.['data-channel-status'] === 'lark')[0], row => row.type === 'span').length, 1, 'status is a single span, without the old second line')
  const larkRow = rows[0]
  all(larkRow, row => row.type === 'input' && row.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } })
  tree = await draw(entry); assert.equal(stateText(), '已禁用', 'disabled draft wins over running evidence')
  assert.equal(mutations.length, 0, 'toggle remains an unsaved draft')
  unmount(); tree = await draw(entry)
  for (const [state, label] of [['error', '已启用·连接异常'], ['idle', '已启用·未连接'], ['starting', '已启用·未连接'], ['stopped', '已启用·未连接'], ['disabled', '已启用·未连接'], ['connected', '已启用·未连接'], [null, '已启用·未连接'], ['running', '已启用·已连接']]) {
    runtimeState = state; await diagnostic.inject().refreshStatus(); tree = await draw(entry); assert.equal(stateText(), label, 'runtime state: ' + state)
  }
  statusFailure = true; await diagnostic.inject().refreshStatus(); tree = await draw(entry)
  assert.equal(stateText(), '已启用·未连接', 'offline read must not reuse cached running as current connection')
  statusFailure = false; await diagnostic.inject().refreshStatus(); tree = await draw(entry)
  button(tree, '个人微信').props.onClick(); tree = await draw(entry)
  const sections = all(tree, row => (row.type === 'span' && text(row) === '扫码登录') || (row.type === 'summary' && text(row) === '高级设置'))
  assert.deepEqual(sections.map(text), ['扫码登录', '高级设置'], 'QR login precedes advanced settings')
  assert.ok(button(tree, '生成二维码'), 'QR action is retained')
  preview('wechat', tree)
  button(tree, '返回消息渠道').props.onClick(); tree = await draw(entry)
}
button(tree, '飞书 / Lark').props.onClick(); tree = await draw(entry)
preview('lark', tree)
if (!process.env.MESSAGING_PREVIEW_CLIENT) {
  assert.equal(button(tree, '返回消息渠道').props.style.alignSelf, 'flex-start')
  assert.ok(input(tree, 'adapters.lark.appId').props.style.background.includes('--dsw-alias-bg-layer-1'))
}
assert.ok(input(tree, 'adapters.lark.appId')); assert.equal(input(tree, 'adapters.lark.verificationToken'), undefined)
input(tree, 'adapters.lark.mode').props.onChange({ target: { value: 'webhook' } }); tree = await draw(entry)
assert.ok(input(tree, 'adapters.lark.verificationToken'), 'draft switches fields before save')
assert.equal(mutations.length, 0)
const secret = input(tree, 'adapters.lark.appSecret'); assert.equal(secret.props.value, ''); secret.props.onChange({ target: { value: '' } })
button(tree, '保存').props.onClick(); await tick(); tree = await draw(entry)
assert.deepEqual(mutations[0], { ns: 'dsh-messaging', ops: [{ op: 'set', path: ['adapters', 'lark', 'mode'], value: 'webhook' }], expected: 7 })
assert.equal(requests.filter(x => x.method !== 'GET').length, 0, 'no automatic scope query or sends')
input(tree, 'adapters.lark.appId').props.onChange({ target: { value: 'draft-kept' } }); failure = true; tree = await draw(entry); button(tree, '保存').props.onClick(); await tick(); tree = await draw(entry)
assert.equal(input(tree, 'adapters.lark.appId').props.value, 'draft-kept'); assert.ok(!text(tree).includes('synthetic-private-error'))
failure = false; conflict = true; button(tree, '保存').props.onClick(); await tick(); tree = await draw(entry); tree = await draw(entry)
assert.equal(input(tree, 'adapters.lark.appId').props.value, 'synthetic', 'conflict reloads and drops old draft'); conflict = false
writable = false; await root.get('configForms').describe().load(); tree = await draw(entry)
assert.equal(input(tree, 'adapters.lark.appId').props.disabled, true); writable = true; await root.get('configForms').describe().load()
unmount(); tree = await draw(diagnostic, { view: 'page' }); tree = await draw(diagnostic, { view: 'page' })
preview('diagnostics', tree)
assert.ok(text(tree).includes('未检测')); assert.ok(text(tree).includes('过期'))
for (const removed of ['imgOp_', 'dedup', 'completion', 'maintenance']) assert.equal(all(tree, x => String(x.props?.['data-diag'] || '').startsWith(removed)).length, 0)
assert.ok(!text(tree).includes('synthetic-private')); assert.equal(button(tree, '重新加载'), undefined)
assert.ok(button(tree, '刷新权限状态')); assert.equal(requests.filter(x => x.method !== 'GET').length, 0)
const assertPermissionOrder = tree => {
  const section = all(tree, row => row.props?.['data-permissions-only'])[0]
  assert.equal(section.children.at(-1).props['data-diag'], 'refresh', 'button is the actual final child, not just the last diagnostic row')
  const rows = all(section, row => row.props?.['data-diag'])
  const keys = rows.map(row => row.props['data-diag'])
  assert.equal(rows.at(-1).type, 'button')
  assert.equal(keys.at(-1), 'refresh', 'scope refresh button is the final element of the compact permission block')
  for (const key of ['grant', 'permission_upload', 'permission_download', 'permission_groupHistory', 'refreshHint']) assert.ok(keys.indexOf(key) >= 0 && keys.indexOf(key) < keys.indexOf('refresh'), key + ' must precede action')
  if (keys.includes('refreshStatus')) assert.ok(keys.indexOf('refreshStatus') < keys.indexOf('refresh'))
  assert.equal(all(tree, row => row.type === 'button' && text(row) === '刷新状态').length, 1, 'top-level read-only GET refresh remains separate')
}
assertPermissionOrder(tree)
const assertPermissionTable = tree => {
  const table = all(tree, row => row.type === 'table' && row.props['data-permission-table'])[0]
  assert.ok(table)
  assert.equal(all(table, row => row.type === 'thead').length, 1)
  assert.equal(all(table, row => row.type === 'tbody').length, 1)
  assert.deepEqual(all(table, row => row.type === 'th' && row.props.scope === 'col').map(text), ['功能', '官方权限名称与 ID', '检测结果'])
  const rows = all(table, row => row.type === 'tr' && row.props['data-diag'])
  assert.equal(rows.length, 4)
  const expected = { grant: [LARK_SCOPE_CARDKIT_WRITE], permission_upload: LARK_IMAGE_SCOPE_GROUPS.upload, permission_download: LARK_IMAGE_SCOPE_GROUPS.download, permission_groupHistory: [LARK_IMAGE_GROUP_HISTORY_SCOPE] }
  for (const row of rows) {
    assert.equal(all(row, cell => cell.type === 'th' && cell.props.scope === 'row').length, 1)
    const groupRows = all(table, candidate => candidate.type === 'tr' && candidate.props['data-permission-group'] === row.props['data-diag'])
    assert.deepEqual(all(groupRows, cell => cell.type === 'code').map(text).sort(), [...expected[row.props['data-diag']]].sort())
    assert.equal(all(row, cell => cell.props?.['data-permission-result'])[0].props.rowSpan, undefined, 'no rowSpan crosses collapsed content')
    if (expected[row.props['data-diag']].length > 1) {
      assert.ok(text(row).includes('以下任一权限'))
      assert.ok(text(row).includes(row.props['data-diag'] === 'permission_download' ? '含当前替代/历史兼容项的功能汇总，非逐 ID 检测。' : '功能汇总，非逐 ID 检测。'))
    }
  }
  const officialNames = {
    'cardkit:card:write': '创建与更新卡片',
    'im:resource': '获取与上传图片或文件资源',
    'im:resource:upload': '上传文件V2',
    'im:message': '获取与发送单聊、群组消息',
    'im:message:readonly': '获取单聊、群组消息',
    'im:message.history:readonly': '获取单聊、群组的历史消息',
    'im:message.group_msg': '获取群组中所有消息（敏感权限）',
  }
  const scopePairs = all(table, row => row.props?.['data-scope-pair'])
  assert.equal(scopePairs.length, 7, 'all seven IDs remain findable in four feature rows')
  for (const pair of scopePairs) {
    const codes = all(pair, cell => cell.type === 'code')
    assert.equal(codes.length, 1)
    assert.equal(text(all(pair, cell => cell.type === 'span')[0]), officialNames[text(codes[0])])
  }
  const groupRow = rows.find(row => row.props['data-diag'] === 'permission_groupHistory')
  assert.equal(text(all(groupRow, cell => cell.type === 'th' && cell.props.scope === 'row')[0]), '群消息恢复')
  assert.ok(text(groupRow).includes('中断后重新读取未处理完的群消息，避免漏处理。需要‘获取群组中所有消息’权限；该权限范围较大，也会扩大机器人可接收的群消息范围。'))
  assert.ok(text(groupRow).includes('获取群组中所有消息（敏感权限）'))
  const readRow = rows.find(row => row.props['data-diag'] === 'permission_download')
  assert.deepEqual(all(all(readRow, x => x.props?.['data-scope-primary'])[0], cell => cell.type === 'code').map(text), ['im:message:readonly'])
  const broader = all(readRow, x => x.type === 'details' && x.props['data-scope-alternative'])[0]
  const legacy = all(readRow, x => x.type === 'details' && x.props['data-scope-legacy'])[0]
  assert.equal(broader.props.open, undefined); assert.equal(legacy.props.open, undefined)
  assert.deepEqual(all(broader, cell => cell.type === 'code').map(text), ['im:message'])
  assert.ok(text(broader).includes('非历史'))
  assert.deepEqual(all(legacy, cell => cell.type === 'code').map(text), ['im:message.history:readonly'])
  assert.ok(text(legacy).includes('历史授权兼容'))
  assert.ok(text(readRow).includes('本插件建议（非官方排名）'))
  const uploadRow = rows.find(row => row.props['data-diag'] === 'permission_upload')
  assert.equal(all(all(uploadRow, x => x.props?.['data-scope-primary'])[0], cell => cell.type === 'code').length, 0, 'no arbitrary primary upload scope')
  const uploadChoices = all(uploadRow, x => x.type === 'details' && x.props['data-scope-current'])[0]
  assert.equal(uploadChoices.props.open, undefined)
  assert.deepEqual(all(uploadChoices, cell => cell.type === 'code').map(text), ['im:resource', 'im:resource:upload'])
  assert.ok(text(uploadRow).includes('两项无优先排名'))
  const guide = all(tree, x => x.props?.['data-permission-guide'])[0]
  assert.ok(guide)
  const unmeasured = all(guide, x => x.props?.['data-not-measured'])
  assert.equal(unmeasured.length, 4)
  assert.ok(unmeasured.every(x => text(x) === '当前诊断未单独检测' && !x.props.style?.color?.includes('success')))
  assert.equal(all(guide, x => x.props?.['data-permission-result']).length, 0)
  assert.ok(text(guide).includes('发送与接收须分别满足'))
  assert.ok(text(guide).includes('群 @ 权限不能保证无损替代'))
  assert.ok(text(guide).includes('群消息恢复须同时具备消息读取权限与 im:message.group_msg'))
  for (const anchor of all(guide, x => x.type === 'a')) {
    const url = new URL(anchor.props.href)
    assert.equal(url.origin, 'https://open.feishu.cn'); assert.equal(url.search, ''); assert.equal(url.username, '')
    assert.equal(anchor.props.rel, 'noopener noreferrer')
  }
  assert.ok(text(table).includes('不是完整必需权限清单'))
  assert.equal(all(table, cell => cell.props?.['data-permission-result']).length, 4, 'no per-ID grant results invented')
  assert.ok(text(table).includes('历史版本'))
  assert.ok(!text(table).includes('synthetic-private'))
  return rows
}
let permissionRows = assertPermissionTable(tree)
assert.ok(text(permissionRows[0]).includes('未检测'))
assert.ok(text(permissionRows[1]).includes('未检测'))
assert.ok(text(permissionRows[2]).includes('上次结果（已过期）'))
assert.ok(text(permissionRows[2]).includes('查询来源'))
assert.ok(text(permissionRows[3]).includes('查询为拒绝'))
imagePermissionsPresent = false
cardkitPermission = { grant: 'granted', stale: true, source: 'scope_read', checkedAt: 100, queryState: 'ok' }
await diagnostic.inject().refreshStatus(); tree = await draw(diagnostic, { view: 'page' })
permissionRows = assertPermissionTable(tree); assertPermissionOrder(tree)
assert.ok(text(permissionRows[0]).includes('上次结果（已过期）'))
for (const row of permissionRows.slice(1)) assert.ok(text(row).includes('未检测'), 'missing images remains unknown with authoritative IDs')
preview('diagnostics-missing-images', tree)
imagePermissionsPresent = true; cardkitPermission = { grant: 'granted', source: 'scope_read', checkedAt: 100, queryState: 'ok' }
await diagnostic.inject().refreshStatus(); tree = await draw(diagnostic, { view: 'page' })
permissionRows = assertPermissionTable(tree)
const resultMain = row => all(row, cell => cell.props?.['data-permission-result'])[0].children[0]
assert.equal(text(resultMain(permissionRows[0])), '已授权')
assert.ok(!text(permissionRows[0]).includes('查询已授权'))
statusFailure = true; await diagnostic.inject().refreshStatus(); tree = await draw(diagnostic, { view: 'page' })
permissionRows = assertPermissionTable(tree)
assert.equal(text(resultMain(permissionRows[0])), '上次结果（已过期）：已授权', 'offline cached authorization is explicitly historical')
assert.ok(!resultMain(permissionRows[0]).props.style.color.includes('success'))
preview('diagnostics-offline', tree)
statusFailure = false
for (const mode of ['missing-cardkit', 'missing-permissions', 'missing-image-key', 'missing-image-permissions', 'missing-diagnostics', 'no-lark']) {
  diagnosticsMode = mode; await diagnostic.inject().refreshStatus(); tree = await draw(diagnostic, { view: 'page' })
  permissionRows = assertPermissionTable(tree)
  const expectedUnknown = mode === 'missing-cardkit' || mode === 'missing-permissions' ? [0]
    : mode === 'missing-image-key' ? [2] : mode === 'missing-image-permissions' ? [1, 2, 3] : [0, 1, 2, 3]
  for (const index of expectedUnknown) {
    assert.equal(text(resultMain(permissionRows[index])), '未检测', mode + ' row ' + index)
    assert.ok(!resultMain(permissionRows[index]).props.style.color.includes('success'))
  }
  if (mode === 'missing-diagnostics' || mode === 'no-lark') assert.equal(button(tree, '刷新权限状态'), undefined, 'unavailable diagnostics retains safe hidden action')
  else assertPermissionOrder(tree)
  if (mode === 'missing-diagnostics') preview('diagnostics-undetected', tree)
}
const statusFace = diagnostic.inject().hooks.status
const savedStatusSnapshot = statusFace.getSnapshot()
statusFace.set({ data: null, error: 'status_failed', busy: false, scope: {} })
tree = await draw(diagnostic, { view: 'page' }); permissionRows = assertPermissionTable(tree)
for (const row of permissionRows) assert.equal(text(resultMain(row)), '未检测', 'no status snapshot retains every scope ID')
assert.equal(button(tree, '刷新权限状态'), undefined)
statusFace.set(savedStatusSnapshot)
diagnosticsMode = 'complete'; cardkitPermission = { grant: 'unknown', queryState: 'never' }
await diagnostic.inject().refreshStatus(); tree = await draw(diagnostic, { view: 'page' })
assert.equal(requests.filter(row => row.method !== 'GET').length, 0, 'table rendering never starts a scope query')
statusFailure = true
await diagnostic.inject().refreshStatus(); tree = await draw(diagnostic, { view: 'page' })
assert.ok(text(tree).includes('状态读取失败')); assert.ok(!text(tree).includes('synthetic-secret-path-id-error'))
statusFailure = false
const beforePermission = requests.filter(x => x.method === 'POST').length
button(tree, '刷新权限状态').props.onClick(); await tick(); await tick(); tree = await draw(diagnostic, { view: 'page' })
assertPermissionOrder(tree)
preview('diagnostics-feedback', tree)
assert.equal(requests.filter(x => x.method === 'POST').length, beforePermission + 1)
assert.ok(requests.filter(x => x.method === 'POST').every(x => x.url.endsWith('/diagnostics/refresh-scope')))

const namespaceForm = entry.inject().form
unmount(); served = false; await root.get('configForms').describe().load(); assert.equal(core.entries('settings.section').length, 0)
served = true; await root.get('configForms').describe().load(); assert.equal(core.entries('settings.section').length, 1)
assert.equal(core.entries('settings.section')[0].inject().form, namespaceForm, 'same provider retains shared form across namespace absence')
removeShell(); assert.equal(core.entries('settings.section').length, 0); removeShell = declare(); await tick(); assert.equal(core.entries('settings.section').length, 1)
const oldForm = entry.inject().form
await settingsFiber.dispose(); await tick(); assert.equal(core.entries('settings.section').length, 0, 'provider loss withdraws settings')
settingsFiber = root.plugin(settings); await tick(); await tick(); assert.equal(core.entries('settings.section').length, 1, 'replacement provider re-registers once')
const replacedEntry = core.entries('settings.section')[0]
assert.notEqual(replacedEntry.inject().form, oldForm, 'new owner must not reuse disposed provider form')
tree = await draw(replacedEntry); button(tree, '飞书 / Lark').props.onClick(); tree = await draw(replacedEntry)
input(tree, 'adapters.lark.appId').props.onChange({ target: { value: 'replacement-saved' } }); tree = await draw(replacedEntry)
const replacementRevision = revision, mutationCount = mutations.length
button(tree, '保存').props.onClick(); await tick(); tree = await draw(replacedEntry)
assert.equal(mutations.length, mutationCount + 1, 'replacement UI actually saves through current form')
assert.equal(mutations.at(-1).expected, replacementRevision)
assert.equal(value.adapters.lark.appId, 'replacement-saved')
// Real provider ownership: disposal waits for an already-active save, and the
// retired shared form cannot issue new mutations. Pages never dispose it.
let releaseSave
mutationGate = new Promise(resolve => { releaseSave = resolve })
const retiringForm = replacedEntry.inject().form
input(tree, 'adapters.lark.appId').props.onChange({ target: { value: 'old-provider-settled' } }); tree = await draw(replacedEntry)
button(tree, '保存').props.onClick(); await tick()
const beforeRetiredWrite = mutations.length
unmount()
let providerEnded = false
const retiring = settingsFiber.dispose().then(() => { providerEnded = true })
await tick(); assert.equal(providerEnded, false, 'real provider disposal awaits its active write')
releaseSave(); mutationGate = null; await retiring; await tick()
assert.equal(value.adapters.lark.appId, 'old-provider-settled')
assert.equal(await retiringForm.mutate([{ op: 'set', path: ['agent', 'model'], value: 'must-not-write' }], revision), false)
assert.equal(mutations.length, beforeRetiredWrite, 'disposed form issues zero later mutations')
settingsFiber = root.plugin(settings); await tick(); await tick()
const afterTailEntry = core.entries('settings.section')[0]
assert.notEqual(afterTailEntry.inject().form, retiringForm)
tree = await draw(afterTailEntry); button(tree, '飞书 / Lark').props.onClick(); tree = await draw(afterTailEntry)
assert.equal(input(tree, 'adapters.lark.appId').props.value, 'old-provider-settled', 'new provider reads authoritative settled value')
assert.equal(afterTailEntry.inject().form.getSnapshot().revision, revision)
unmount()

await fiber.dispose(); assert.equal(core.entries('tool.view.cordis').length, 0, 'legacy alias also retires with its owner'); assert.equal(core.entries('settings.section').length, 0); assert.equal(core.entries('plugins.row.config').length, 0)
removeShell(); await root.fiber.dispose()
console.log('messaging-settings-host ok | real rc.3 SlotCore/Cordis/UI ConfigForms; synthetic mirror transport/status; hook/store adapters; 7 channels, draft mode, revision, secret keep, failure/conflict, readonly, reduced diagnostics, real owner navigation+SettingsPanel/RowDetail slot consumption, provider replacement save+old-save disposal barrier, offline privacy+explicit scope action, delayed slots/service teardown; no real network')
