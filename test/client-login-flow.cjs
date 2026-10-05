'use strict'
// 统一超时兜底：挂住即非零退出，npm test 不被拖死（见 test/_guard.cjs）。
require('./_guard.cjs')
// 扫码登录轮询的回归测试（评审发现的既有缺陷）：
// 服务端 expired 自动换码后，client 必须回到 wait 继续轮询——否则新码再次扫码的
// confirmed 永远收不到，登录卡死。本用例用「队列化定时器 + 手动渲染周期」模拟
// React 的 effect 生命周期，走完 生成 → wait → expired 换码 → wait → confirmed。
// 旧实现在 expired 处把状态置为 expired，effect 守卫（只放行 wait/scaned）终止
// 轮询：状态请求数停在 2，本用例第 3 次轮询断言即失败。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const clientSource = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const fixtureConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))

const QR1 = 'data:image/svg+xml;base64,UVJfRlJFU0g='
const QR2 = 'data:image/svg+xml;base64,UVJfUkVGUkVTSA=='

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
  return { type: node.type, props: node.props || {}, children: kids.flat(Infinity).map((child) => render(child, extraProps)) }
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

function countImages(node) {
  if (!node || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countImages(child), 0)
  const self = node.type === 'img' ? 1 : 0
  const kids = []
  if (node.props && node.props.children != null) kids.push(node.props.children)
  if (node.children) kids.push(node.children)
  return self + kids.flat(Infinity).reduce((sum, child) => sum + countImages(child), 0)
}

function loadFactory(fetchImpl) {
  let factory = null
  const sandbox = {
    fetch: fetchImpl,
    window: { __ModuleLoader__: { load(spec) { factory = spec.factory } } },
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
    // 与 client-smoke 同款近似：effect 无条件执行；本用例额外把 ctx.timeout 做成
    // 可排队、可逐个推进的定时器，用 drainOne() 扮演时间流逝。
    useEffect(effect) {
      effect()
    },
    resetCursor() {
      cursor = 0
    },
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
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

async function main() {
  const counts = { config: 0, start: 0, status: 0 }
  const statusScript = ['wait', 'expired', 'wait', 'confirmed']
  const fetchImpl = (url, opts) => {
    const method = (opts && opts.method) || 'GET'
    const u = String(url)
    let body
    if (u.endsWith('/ilink/login/start') && method === 'POST') {
      counts.start++
      body = { ok: true, sessionKey: 's1', qrcodeUrl: QR1, expiresAt: Date.now() + 60000 }
    } else if (u.endsWith('/ilink/login/status') && method === 'POST') {
      const scripted = statusScript[counts.status]
      counts.status++
      if (scripted === 'expired') body = { status: 'expired', qrcodeUrl: QR2 }
      else if (scripted === 'confirmed') body = { status: 'confirmed' }
      else body = { status: scripted || 'wait' }
    } else if (u.endsWith('/config')) {
      counts.config++
      body = { config: JSON.parse(JSON.stringify(fixtureConfig)) }
    } else {
      body = {}
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  }

  // settings 镜像桩：页面通过 whileServed 挂载、从 namespace 行读 revision/secrets。
  const mirrorRow = { ns: 'dsh-messaging', revision: 1, secrets: [], value: {} }
  const configForms = {
    describe() {
      return {
        namespace(ns) { return ns === mirrorRow.ns ? mirrorRow : undefined },
        subscribe() { return () => {} },
        load() { return Promise.resolve() },
      }
    },
    whileServed(namespaces, register) {
      if (namespaces.indexOf(mirrorRow.ns) !== -1) return register(new Set(namespaces))
      return () => {}
    },
  }
  // Host 交给页面的 volatile 投影（配置不再从 /config 拉）。
  const formValue = JSON.parse(JSON.stringify(fixtureConfig))
  delete formValue.version
  delete formValue.workspaceRoot
  delete formValue.runtime
  const formState = { status: 'ready', writable: true, revision: 1, value: formValue }
  const form = {
    get state() { return formState },
    mutate() { return Promise.resolve(true) },
  }
  const timers = []
  const registrations = []
  const dicts = {}
  const slots = {
    inject(name, callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const locale = {
    register(ns, value) {
      dicts[ns] = value
      return () => {}
    },
    bind(ns) {
      return (key, params) => interpolate((dicts[ns] && dicts[ns].en && dicts[ns].en[key]) || key, params)
    },
  }
  const ctx = {
    effect(fn) { return fn() },
    locale,
    slots,
    interval() { return () => {} },
    timeout(fn) {
      const entry = { fn, cancelled: false }
      timers.push(entry)
      return () => { entry.cancelled = true }
    },
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return locale
      if (name === 'configForms') return configForms
      return undefined
    },
  }

  const factory = loadFactory(fetchImpl)
  const store = {}
  const React = makeReact(store)
  const plugin = factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  plugin.apply(ctx)

  const section = registrations.find((entry) => entry.options.name === 'plugins.row.config')
  assert.ok(section, 'the plugin page must be registered')
  assert.equal(registrations.some((entry) => entry.options.name === 'settings.section'), false, 'settings.section is gone')
  // 宿主把 inject 面绑成 props（hooks → useXxx(selector)），这里模拟它。
  const pageFace = section.options.inject()

  const cycle = async () => {
    React.resetCursor()
    const tree = render(section.component, bindFace(pageFace, { view: 'page', form }, dicts, React))
    await flush()
    return tree
  }
  // 推进一个存活的定时器（扮演 1 秒后的新一轮轮询）
  const drainOne = async () => {
    while (timers.length) {
      const entry = timers.shift()
      if (!entry.cancelled) {
        entry.fn()
        await flush()
        return true
      }
    }
    return false
  }

  // 1) 首渲：config 未就绪，只有 loading；effect 拉取 config
  let tree = await cycle()
  assert.equal(counts.config, 0, 'the page must not fetch the legacy config route')

  // 2) config 就绪 → 个人微信登录面板出现，尚未开始登录
  tree = await cycle()
  const generate = findButton(tree, 'Generate')
  assert.ok(generate, 'wechat login panel must render once config loaded')
  assert.equal(counts.status, 0, 'no polling before generate')

  // 3) 点「生成二维码」→ login/start
  generate.props.onClick()
  await flush()
  assert.equal(counts.start, 1, 'generate must call login/start once')
  assert.equal(counts.status, 0, 'polling starts on the next effect cycle, not inside the click')

  // 4) effect 启动轮询 → 第一次 status（wait），并排好下一次定时器
  tree = await cycle()
  assert.equal(counts.status, 1, 'first poll must fire on mount cycle')
  assert.match(treeText(tree), /Waiting for scan/, 'status should read wait')

  // 5) 时间推进 → 服务端 expired + 宿主自动换的新码
  assert.equal(await drainOne(), true, 'a follow-up timer must be scheduled after wait')
  assert.equal(counts.status, 2, 'second poll returns the expiry')

  // 6) 关键回归点：expired 换码后状态必须回到 wait 且轮询继续。
  //    旧实现在这里停摆（状态 expired → 守卫终止，counts.status 停在 2）。
  tree = await cycle()
  assert.equal(counts.status, 3, 'polling must resume after the QR auto-refresh')
  assert.match(treeText(tree), /Waiting for scan/, 'refreshed QR must show the wait status again')
  assert.ok(countImages(tree) >= 1, 'the refreshed QR image must be displayed')

  // 7) 推进 expired 分支排的定时器 → confirmed
  assert.equal(await drainOne(), true, 'the refresh branch must schedule the next poll')
  assert.equal(counts.status, 4, 'confirmation must be observed after the refresh')

  tree = await cycle()
  const text = treeText(tree)
  assert.match(text, /Login successful, token saved\./, 'the panel must report a successful login')
  assert.equal(countImages(tree), 0, 'confirmed must clear the QR image')
  assert.ok(findButton(tree, 'Generate'), 'panel must return to the generate state')

  // ── P4：退订必须取消待发的轮询 timer（卸载后不留 timer）────────────────
  const loginStore = pageFace.hooks.wechatLogin
  await pageFace.generate()
  await flush()
  const mark = timers.length
  React.resetCursor()
  render(section.component, bindFace(pageFace, { view: 'page', form }, dicts, React))
  await flush()
  const pendingTimer = timers.slice(mark).find((entry) => !entry.cancelled)
  assert.ok(pendingTimer, 'a waiting login schedules a poll timer')
  const loginHookOff = HOOK_SUBSCRIPTIONS.get(loginStore)
  assert.ok(loginHookOff, 'the page subscribed the login hook')
  loginHookOff()
  HOOK_SUBSCRIPTIONS.delete(loginStore)
  assert.equal(pendingTimer.cancelled, true, 'the last unsubscribe cancels the pending timer')

  console.log('client-login-flow: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
