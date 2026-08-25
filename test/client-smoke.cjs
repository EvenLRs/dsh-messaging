'use strict'
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
assert.ok(pkg.dsh.bundle.patch)
assert.match(clientSource, /window\.__ModuleLoader__\.load/)
assert.match(clientSource, /\/__dsh-messaging\/config/)
assert.match(clientSource, /\/__dsh-messaging\/status/)
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

function makeCtx() {
  const registrations = []
  const slots = {
    inject(name, callback) {
      if (name === 'settings.section' || name === 'tool.view.cordis') callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
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
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale,
    slots,
    interval() { return () => {} },
    timeout() { return () => {} },
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return locale
      return undefined
    },
  }
  return { ctx, registrations }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function main() {
  const calls = []
  const fetchImpl = (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', opts })
    let body = { ok: true }
    if (String(url).endsWith('/config') && (!opts || opts.method === 'GET' || !opts.method)) {
      body = { config: fixtureConfig }
    } else if (String(url).endsWith('/status')) {
      body = { channels: [], sessions: [], recent: [], errors: [] }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    })
  }

  const factory = loadFactory(fetchImpl)
  const store = {}
  const React = makeReact(store)
  const plugin = factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(plugin.name, 'dsh-messaging')
  assert.ok(plugin.inject.includes('slots'))
  assert.ok(plugin.inject.includes('locale'))

  const { ctx, registrations } = makeCtx()
  plugin.apply(ctx)
  assert.equal(calls.length, 0, 'apply itself must not fetch')

  const section = registrations.find((entry) => entry.options.name === 'settings.section')
  const panel = registrations.find((entry) => entry.options.name === 'tool.view.cordis')
  assert.ok(section, 'settings.section registration should exist')
  assert.equal(section.options.id, 'messaging')
  assert.equal(section.options.order, 25)
  assert.equal(section.options.label(), 'Message Channel Configuration')
  assert.ok(panel, 'tool.view.cordis registration should still exist')

  React.resetCursor()
  let tree = render(section.component, {})
  await flush()
  React.resetCursor()
  tree = render(section.component, {})
  const text = treeText(tree)
  assert.match(text, /Message Channel Configuration/)
  assert.match(text, /OneBot v11/)
  assert.match(text, /Telegram/)
  assert.match(text, /Personal WeChat/)
  assert.ok(calls.length >= 1, 'settings section loads config on mount')
  assert.ok(calls.every((c) => c.method === 'GET' && c.url === '/__dsh-messaging/config'), 'mount must only GET config, never POST/reload/status')
  assert.equal(calls[0].opts.credentials, 'same-origin')
  const callsBeforeSave = calls.length

  const saveBtn = findButton(tree, 'Save')
  assert.ok(saveBtn, 'save button should exist')
  saveBtn.props.onClick()
  await flush()
  assert.equal(calls.length, callsBeforeSave + 1, 'save should POST config once')
  const saveCall = calls[calls.length - 1]
  assert.equal(saveCall.url, '/__dsh-messaging/config')
  assert.equal(saveCall.method, 'POST')

  console.log('client-smoke: ok')
  console.log('fetch calls:', calls.map((c) => c.method + ' ' + c.url).join(', '))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
