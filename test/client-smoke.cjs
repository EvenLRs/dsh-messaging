const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const clientSource = fs.readFileSync(path.join(root, 'dynamic', 'client.js'), 'utf8')
const fixtureConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))

const registrations = []
const hostCalls = []
const host = {
  async call(method) {
    hostCalls.push(method)
    if (method === 'messaging_get_config') return { config: fixtureConfig }
    if (method === 'messaging_status') return { channels: [], sessions: [], recent: [], errors: [] }
    return {}
  },
}

function makeReact(initialValues) {
  const values = [...initialValues]
  return {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity),
      }
    },
    useState(initial) {
      const value = values.length ? values.shift() : initial
      return [value, () => {}]
    },
    useEffect(effect) { effect() },
  }
}

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

const ctx = {
  get(name) {
    if (name === 'slots') return slots
    return undefined
  },
  interval() { return () => {} },
}

function treeText(node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const own = node.props && node.props.children ? String(node.props.children) : ''
  return own + ' ' + (node.children || []).map(treeText).join(' ')
}

function main() {
  const React = makeReact([fixtureConfig, '', '', false])
  const factory = new Function('React', 'host', clientSource)
  const plugin = factory(React, host)
  plugin.apply(ctx)

  const section = registrations.find((entry) => entry.options.name === 'settings.section')
  const panel = registrations.find((entry) => entry.options.name === 'tool.view.cordis')
  assert.ok(section, 'settings.section registration should exist')
  assert.equal(section.options.id, 'messaging')
  assert.equal(section.options.label(), 'Messaging')
  assert.ok(panel, 'tool.view.cordis registration should still exist')

  const element = section.component({ close() {} })
  const text = treeText(element)
  assert.match(text, /Message Channel Configuration/)
  assert.match(text, /OneBot v11/)
  assert.match(text, /Telegram/)
  assert.match(text, /Personal WeChat/)
  assert.ok(hostCalls.includes('messaging_get_config'), 'section should load host config')

  console.log('client-smoke: ok')
}

main()
