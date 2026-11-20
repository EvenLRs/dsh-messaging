// 0.3.6 渠道默认工作区：lib/messaging-channel-workspace.js 单元回归。
// 宿主 workspaceController / workspaceRegistry 为同形 fake（规范路径用宿主同款
// fs/promises realpath）；全部路径在 mkdtemp 临时目录，不触碰真实 ~/.dsh 或 Documents。
import './_guard.cjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CHANNEL_WORKSPACE_STORE,
  DEFAULT_WORKSPACE_DIRECTORY,
  createChannelWorkspaces,
} from '../lib/messaging-channel-workspace.js'

const POSIX = process.platform !== 'win32'
const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('PASS | ' + name)
  } catch (error) {
    results.push({ name, ok: false })
    console.log('FAIL | ' + name + ' | ' + (error && error.stack ? error.stack : error))
  }
}

// 与 dsh-workspace 同形：create 只登记已存在目录，按规范路径幂等；get/list/delete。
function fakeHost({ initializeDefault } = {}) {
  const entities = new Map()
  const calls = { create: [], initializeDefault: [], get: 0, list: 0 }
  let seq = 0
  const registry = {
    get(id) { calls.get += 1; return entities.get(id) },
    list() { calls.list += 1; return [...entities.values()] },
    async delete(id) { return entities.delete(id) },
    register(p) {
      for (const entity of entities.values()) if (entity.path === p) return entity
      const entity = { workspaceId: 'ws-' + (++seq), path: p, title: path.basename(p) }
      entities.set(entity.workspaceId, entity)
      return entity
    },
  }
  const controller = {
    async initializeDefault(signal) {
      calls.initializeDefault.push(signal)
      return initializeDefault ? initializeDefault(signal) : undefined
    },
    async create(request) {
      calls.create.push(request)
      const canonical = await fsp.realpath(request.path)
      if (!(await fsp.stat(canonical)).isDirectory()) throw new Error('not a directory')
      const entity = registry.register(canonical)
      return { workspace: { ...entity, sessionIds: [] }, created: true }
    },
  }
  return { controller, registry, entities, calls }
}

async function fixture(options = {}) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chws-'))
  const base = path.join(temp, 'Documents', 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY)
  await fsp.mkdir(base, { recursive: true })
  const canonicalBase = await fsp.realpath(base)
  const root = path.join(temp, 'dsh-home', CHANNEL_WORKSPACE_STORE)
  const host = fakeHost({
    initializeDefault: options.initializeDefault === undefined
      ? () => ({ workspace: { workspaceId: 'ws-default', path: canonicalBase } })
      : options.initializeDefault,
  })
  const services = options.services || (() => ({ controller: host.controller, registry: host.registry }))
  const workspaces = createChannelWorkspaces({ root, services, now: () => 1700000000000, ...(options.lookupTimeoutMs ? { lookupTimeoutMs: options.lookupTimeoutMs } : {}) })
  return { temp, base, canonicalBase, root, host, workspaces, marker: ch => path.join(root, ch + '.json') }
}

await test('exports: store name and fixed host default directory name', () => {
  assert.equal(CHANNEL_WORKSPACE_STORE, 'messaging-channel-workspaces-v1')
  assert.equal(DEFAULT_WORKSPACE_DIRECTORY, 'default-workspace')
})

await test('first resolve creates <default>/<channel>, registers it once and writes marker', async () => {
  const f = await fixture()
  const cwd = await f.workspaces.resolve('lark')
  const expected = path.join(f.canonicalBase, 'lark')
  assert.equal(cwd, expected)
  assert.ok(fs.statSync(expected).isDirectory(), 'channel directory created')
  assert.equal(f.host.calls.initializeDefault.length, 1)
  assert.ok(f.host.calls.initializeDefault[0] instanceof AbortSignal, 'initializeDefault receives an AbortSignal')
  assert.equal(f.host.calls.create.length, 1)
  assert.equal(f.host.calls.create[0].path, expected)
  const ws = [...f.host.entities.values()].find(e => e.path === expected)
  assert.ok(ws, 'registered as a Workspace')
  assert.equal(ws.title, 'lark')
  const row = JSON.parse(fs.readFileSync(f.marker('lark'), 'utf8'))
  assert.deepEqual(row, { version: 1, channel: 'lark', path: expected, workspaceId: ws.workspaceId, createdAt: 1700000000000 })
  if (POSIX) assert.equal(fs.statSync(f.marker('lark')).mode & 0o777, 0o600, 'marker is owner-only')
  const leftovers = fs.readdirSync(f.root).filter(n => n !== 'lark.json')
  assert.deepEqual(leftovers, [], 'no temporary files left next to the marker')
})

await test('second resolve reuses marker without initializeDefault or create', async () => {
  const f = await fixture()
  const first = await f.workspaces.resolve('telegram')
  const again = await f.workspaces.resolve('telegram')
  assert.equal(again, first)
  assert.equal(f.host.calls.initializeDefault.length, 1)
  assert.equal(f.host.calls.create.length, 1)
  assert.ok(f.host.calls.get >= 1, 'marker reuse re-checks the registration')
})

await test('marker survives a new instance (process restart) and is reused', async () => {
  const f = await fixture()
  const first = await f.workspaces.resolve('wechat')
  const restarted = createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller, registry: f.host.registry }) })
  assert.equal(await restarted.resolve('wechat'), first)
  assert.equal(f.host.calls.create.length, 1)
})

await test('concurrent resolves of one channel create and register only once', async () => {
  const f = await fixture()
  const all = await Promise.all(Array.from({ length: 6 }, () => f.workspaces.resolve('discord')))
  assert.equal(new Set(all).size, 1)
  assert.equal(f.host.calls.create.length, 1)
  assert.equal(f.host.calls.initializeDefault.length, 1)
})

await test('different channels get separate folders and workspaces', async () => {
  const f = await fixture()
  const [a, b] = await Promise.all([f.workspaces.resolve('slack'), f.workspaces.resolve('wecom')])
  assert.equal(a, path.join(f.canonicalBase, 'slack'))
  assert.equal(b, path.join(f.canonicalBase, 'wecom'))
  assert.equal(f.host.entities.size, 2)
  assert.ok(fs.existsSync(f.marker('slack')) && fs.existsSync(f.marker('wecom')))
})

await test('user removed the channel workspace registration: null, never re-registered', async () => {
  const f = await fixture()
  await f.workspaces.resolve('lark')
  const id = JSON.parse(fs.readFileSync(f.marker('lark'), 'utf8')).workspaceId
  await f.host.registry.delete(id)
  assert.equal(await f.workspaces.resolve('lark'), null)
  assert.equal(await f.workspaces.resolve('lark'), null)
  assert.equal(f.host.calls.create.length, 1, 'no automatic re-registration')
  assert.ok(fs.existsSync(f.marker('lark')), 'marker kept so it is not recreated later')
})

await test('user deleted the channel folder: null, folder not recreated', async () => {
  const f = await fixture()
  const dir = await f.workspaces.resolve('onebot')
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(await f.workspaces.resolve('onebot'), null)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(f.host.calls.create.length, 1)
})

await test('without registry service the marker is still honoured when the folder exists', async () => {
  const f = await fixture()
  const dir = await f.workspaces.resolve('lark')
  const noRegistry = createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller }) })
  assert.equal(await noRegistry.resolve('lark'), dir)
})

await test('no host workspace services: null, nothing written', async () => {
  for (const services of [() => ({}), () => undefined, () => ({ registry: fakeHost().registry }), () => ({ controller: {} })]) {
    const f = await fixture({ services })
    assert.equal(await f.workspaces.resolve('lark'), null)
    assert.equal(fs.existsSync(f.root), false, 'marker store not created')
    assert.equal(fs.existsSync(path.join(f.canonicalBase, 'lark')), false)
  }
})

await test('initializeDefault undefined and no registry: null without side effects', async () => {
  const f = await fixture({ initializeDefault: () => undefined, services: undefined })
  const workspaces = createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller }) })
  assert.equal(await workspaces.resolve('lark'), null)
  assert.equal(f.host.calls.create.length, 0)
  assert.equal(fs.existsSync(f.root), false)
})

await test('initializeDefault undefined: falls back to a registered default-workspace folder', async () => {
  const f = await fixture({ initializeDefault: () => undefined })
  f.host.registry.register(path.join(f.temp, 'elsewhere'))
  f.host.registry.register(f.canonicalBase)
  const cwd = await f.workspaces.resolve('lark')
  assert.equal(cwd, path.join(f.canonicalBase, 'lark'))
  assert.ok(f.host.calls.list >= 1)
})

await test('initializeDefault undefined and only other workspaces registered: null', async () => {
  const f = await fixture({ initializeDefault: () => undefined })
  const other = path.join(f.temp, 'project')
  fs.mkdirSync(other)
  f.host.registry.register(other)
  assert.equal(await f.workspaces.resolve('lark'), null)
  assert.equal(f.host.calls.create.length, 0)
})

await test('default workspace path missing on disk: null, nothing created', async () => {
  const f = await fixture({ initializeDefault: () => ({ workspace: { path: '/definitely/missing/default-workspace' } }) })
  assert.equal(await f.workspaces.resolve('lark'), null)
  assert.equal(f.host.calls.create.length, 0)
})

await test('regular file at <default>/<channel> rejects and registers nothing', async () => {
  const f = await fixture()
  fs.writeFileSync(path.join(f.canonicalBase, 'lark'), 'not a folder')
  await assert.rejects(f.workspaces.resolve('lark'))
  assert.equal(f.host.calls.create.length, 0)
  assert.equal(fs.existsSync(f.marker('lark')), false)
})

await test('pre-existing plain channel folder is adopted', async () => {
  const f = await fixture()
  fs.mkdirSync(path.join(f.canonicalBase, 'lark'))
  fs.writeFileSync(path.join(f.canonicalBase, 'lark', 'keep.txt'), 'x')
  assert.equal(await f.workspaces.resolve('lark'), path.join(f.canonicalBase, 'lark'))
  assert.equal(fs.readFileSync(path.join(f.canonicalBase, 'lark', 'keep.txt'), 'utf8'), 'x', 'existing files untouched')
})

if (POSIX) {
  await test('channel folder symlinked outside the default workspace rejects', async () => {
    const f = await fixture()
    const outside = path.join(f.temp, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(f.canonicalBase, 'lark'))
    await assert.rejects(f.workspaces.resolve('lark'))
    assert.equal(f.host.calls.create.length, 0)
    assert.equal(fs.existsSync(f.marker('lark')), false)
  })

  await test('symlinked marker file is rejected (fail closed)', async () => {
    const f = await fixture()
    fs.mkdirSync(f.root, { recursive: true })
    const real = path.join(f.temp, 'real.json')
    fs.writeFileSync(real, JSON.stringify({ version: 1, channel: 'lark', path: path.join(f.canonicalBase, 'lark'), workspaceId: 'x', createdAt: 1 }))
    fs.symlinkSync(real, f.marker('lark'))
    await assert.rejects(f.workspaces.resolve('lark'), /channel_workspace_store_invalid/)
  })
}

await test('corrupt or foreign markers reject with a fixed message (no path or content)', async () => {
  const f = await fixture()
  fs.mkdirSync(f.root, { recursive: true })
  const good = { version: 1, channel: 'lark', path: path.join(f.canonicalBase, 'lark'), workspaceId: 'ws-x', createdAt: 1 }
  const bad = [
    '{not json',
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, channel: 'telegram' }),
    JSON.stringify({ ...good, path: 'relative/lark' }),
    JSON.stringify({ ...good, path: path.join(f.canonicalBase, 'other') }),
    JSON.stringify({ ...good, workspaceId: '' }),
    JSON.stringify({ ...good, createdAt: 'yesterday' }),
    JSON.stringify([good]),
    'null',
  ]
  for (const content of bad) {
    fs.writeFileSync(f.marker('lark'), content)
    await assert.rejects(f.workspaces.resolve('lark'), (error) => {
      assert.equal(error.message, 'channel_workspace_store_invalid')
      assert.ok(!error.message.includes(f.temp))
      return true
    }, 'marker must be rejected: ' + content.slice(0, 40))
  }
  assert.equal(f.host.calls.create.length, 0, 'corrupt marker never triggers re-registration')
})

await test('invalid channel keys resolve null before touching host services', async () => {
  const f = await fixture()
  for (const channel of ['', 'Lark', '../lark', 'lark/x', 'lark\\x', '1lark', 'a'.repeat(33), ' lark', 'lark.', null, undefined, 42, {}]) {
    assert.equal(await f.workspaces.resolve(channel), null, 'channel ' + String(channel))
  }
  assert.equal(f.host.calls.initializeDefault.length, 0)
  assert.equal(f.host.calls.create.length, 0)
  assert.equal(fs.existsSync(f.root), false)
})

await test('create returning a different path rejects without marker', async () => {
  const f = await fixture()
  f.host.controller.create = async () => ({ workspace: { workspaceId: 'ws-z', path: path.join(f.temp, 'elsewhere') } })
  await assert.rejects(f.workspaces.resolve('lark'))
  assert.equal(fs.existsSync(f.marker('lark')), false)
})

await test('create returning no workspace id rejects without marker', async () => {
  const f = await fixture()
  f.host.controller.create = async (request) => ({ workspace: { path: request.path } })
  await assert.rejects(f.workspaces.resolve('lark'))
  assert.equal(fs.existsSync(f.marker('lark')), false)
})

await test('failed create does not poison the channel queue; next call retries and succeeds', async () => {
  const f = await fixture()
  const original = f.host.controller.create
  let fail = true
  f.host.controller.create = async (request) => {
    if (fail) { fail = false; throw new Error('transient') }
    return original(request)
  }
  await assert.rejects(f.workspaces.resolve('lark'), /transient/)
  assert.equal(fs.existsSync(f.marker('lark')), false, 'marker only after successful registration')
  assert.equal(await f.workspaces.resolve('lark'), path.join(f.canonicalBase, 'lark'))
  assert.ok(fs.existsSync(f.marker('lark')))
})

await test('initializeDefault honours lookupTimeoutMs through its AbortSignal', async () => {
  const f = await fixture({
    lookupTimeoutMs: 30,
    initializeDefault: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true })
    }),
  })
  // AbortSignal.timeout 的定时器是 unref 的；真实宿主总有其他活动句柄，这里用一个
  // ref 住的 keepalive 模拟，否则 Node 会在事件循环空了时直接判定顶层 await 未决而退出。
  const keepalive = setInterval(() => {}, 1000)
  const started = Date.now()
  try {
    await assert.rejects(f.workspaces.resolve('lark'))
  } finally { clearInterval(keepalive) }
  assert.ok(Date.now() - started < 5000, 'timed out promptly')
  assert.equal(f.host.calls.create.length, 0)
  assert.equal(fs.existsSync(f.marker('lark')), false)
})

await test('rejection in one channel does not block another channel', async () => {
  const f = await fixture()
  fs.writeFileSync(path.join(f.canonicalBase, 'lark'), 'file')
  const [lark, telegram] = await Promise.allSettled([f.workspaces.resolve('lark'), f.workspaces.resolve('telegram')])
  assert.equal(lark.status, 'rejected')
  assert.equal(telegram.status, 'fulfilled')
  assert.equal(telegram.value, path.join(f.canonicalBase, 'telegram'))
})

await test('source uses the host realpath algorithm, not realpathSync.native', () => {
  const source = fs.readFileSync(new URL('../lib/messaging-channel-workspace.js', import.meta.url), 'utf8')
  assert.ok(!/realpathSync\.native|realpath\.native/.test(source), 'host dsh-workspace canonicalizes with fs/promises realpath; .native may differ on Windows')
})

const failed = results.filter(r => !r.ok)
console.log('messaging-channel-workspace: ' + (results.length - failed.length) + '/' + results.length + ' passed')
if (failed.length) process.exit(1)
