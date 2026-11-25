// 0.3.6/0.3.7 渠道默认工作区与成员登记：lib/messaging-channel-workspace.js 单元回归。
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

// ---- 0.3.7 成员登记：lookup / attach ----
// 与 dsh-workspace 同形的 resolveByPath → { id, path, sessionIds, attachSession, detachSession }。
function membership(f, { attachImpl, idFor } = {}) {
  const members = new Map() // workspaceId -> Set(sessionId)
  const calls = []
  const resolveCalls = []
  f.host.registry.resolveByPath = async (p) => {
    resolveCalls.push(p)
    let canonical = p
    try { canonical = await fsp.realpath(p) } catch { /* missing */ }
    for (const e of f.host.entities.values()) {
      if (e.path !== canonical) continue
      const set = members.get(e.workspaceId) || new Set()
      members.set(e.workspaceId, set)
      return {
        id: idFor ? idFor(e) : e.workspaceId,
        path: e.path,
        get sessionIds() { return [...set] },
        async attachSession(id) { calls.push(id); if (attachImpl) await attachImpl(id); set.add(id) },
        async detachSession(id) { set.delete(id) },
      }
    }
    return undefined
  }
  const memberOf = (dir) => {
    for (const e of f.host.entities.values()) if (e.path === dir) return [...(members.get(e.workspaceId) || [])]
    return []
  }
  return { members, calls, resolveCalls, memberOf }
}
const readMarker = (f, ch = 'lark') => JSON.parse(fs.readFileSync(f.marker(ch), 'utf8'))

await test('lookup: no marker → null and never initializes, creates or registers', async () => {
  const f = await fixture()
  assert.equal(f.workspaces.lookup('lark'), null)
  assert.equal(f.host.calls.initializeDefault.length, 0)
  assert.equal(f.host.calls.create.length, 0)
  assert.equal(fs.existsSync(path.join(f.canonicalBase, 'lark')), false)
  assert.equal(fs.existsSync(f.root), false)
  assert.equal(f.workspaces.lookup('../x'), null)
  assert.equal(f.workspaces.lookup(''), null)
})

await test('lookup: returns the validated marker path after resolve; null once registration is gone', async () => {
  const f = await fixture()
  const dir = await f.workspaces.resolve('lark')
  const before = f.host.calls.create.length
  assert.equal(f.workspaces.lookup('lark'), dir)
  assert.equal(f.host.calls.create.length, before, 'lookup is read-only')
  f.host.entities.clear()
  assert.equal(f.workspaces.lookup('lark'), null)
})

await test('lookup: 0.3.6 marker without attachedSessionIds stays valid', async () => {
  const f = await fixture()
  const dir = await f.workspaces.resolve('lark')
  const row = readMarker(f)
  assert.equal(row.attachedSessionIds, undefined, 'resolve alone writes no receipts')
  const legacy = createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller, registry: f.host.registry }) })
  assert.equal(legacy.lookup('lark'), dir)
  assert.equal(await legacy.resolve('lark'), dir)
})

await test('attach: joins the channel workspace and appends a durable 0600 receipt', async () => {
  const f = await fixture()
  const m = membership(f)
  const dir = await f.workspaces.resolve('lark')
  const before = readMarker(f)
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  assert.deepEqual(m.calls, ['s-1'])
  assert.deepEqual(m.memberOf(dir), ['s-1'])
  const row = readMarker(f)
  assert.deepEqual(row.attachedSessionIds, ['s-1'])
  for (const k of ['version', 'channel', 'path', 'workspaceId', 'createdAt']) assert.equal(row[k], before[k], 'marker field kept: ' + k)
  if (POSIX) assert.equal(fs.statSync(f.marker('lark')).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(f.root).filter(n => n.includes('.tmp-')), [], 'no temp files left')
})

await test('attach: recorded session is never attached again, also after restart', async () => {
  const f = await fixture()
  const m = membership(f)
  const dir = await f.workspaces.resolve('lark')
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  const restarted = createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller, registry: f.host.registry }) })
  await restarted.attach('lark', { sessionId: 's-1', cwd: dir })
  assert.deepEqual(m.calls, ['s-1'])
  assert.deepEqual(readMarker(f).attachedSessionIds, ['s-1'])
})

await test('attach: user removed the session from the workspace → stays removed', async () => {
  const f = await fixture()
  const m = membership(f)
  const dir = await f.workspaces.resolve('lark')
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  const ws = await f.host.registry.resolveByPath(dir)
  await ws.detachSession('s-1')
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  assert.deepEqual(m.memberOf(dir), [], 'manual removal respected')
  assert.deepEqual(m.calls, ['s-1'])
})

await test('attach: cwd different from the marker path, or no marker → skipped silently', async () => {
  const f = await fixture()
  const m = membership(f)
  await f.workspaces.attach('lark', { sessionId: 's-0', cwd: path.join(f.canonicalBase, 'lark') })
  assert.equal(fs.existsSync(f.marker('lark')), false, 'attach never creates a marker')
  const dir = await f.workspaces.resolve('lark')
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: f.canonicalBase })
  await f.workspaces.attach('lark', { sessionId: 's-2', cwd: dir + path.sep + 'sub' })
  await f.workspaces.attach('telegram', { sessionId: 's-3', cwd: dir })
  assert.deepEqual(m.calls, [])
  assert.equal(readMarker(f).attachedSessionIds, undefined)
})

await test('attach: invalid inputs resolve without touching services', async () => {
  let touched = 0
  const f = await fixture({ services: () => { touched += 1; return {} } })
  for (const args of [['../x', { sessionId: 's', cwd: '/x' }], ['lark', { sessionId: '', cwd: '/x' }], ['lark', { sessionId: 's', cwd: '' }], ['lark', { sessionId: 1, cwd: '/x' }]]) {
    assert.equal(await f.workspaces.attach(...args), undefined)
  }
  assert.equal(touched, 0)
})

await test('attach: no registry, no resolveByPath, or no workspace at the path → silent, no receipt', async () => {
  const f = await fixture()
  const dir = await f.workspaces.resolve('lark')
  const noRegistry = createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller }) })
  await noRegistry.attach('lark', { sessionId: 's-1', cwd: dir })
  await f.workspaces.attach('lark', { sessionId: 's-2', cwd: dir }) // registry without resolveByPath
  const m = membership(f)
  f.host.registry.resolveByPath = async () => undefined
  await f.workspaces.attach('lark', { sessionId: 's-3', cwd: dir })
  assert.deepEqual(m.calls, [])
  assert.equal(readMarker(f).attachedSessionIds, undefined)
})

await test('attach: workspace at the path carries a different id than the marker → skipped', async () => {
  const f = await fixture()
  const m = membership(f, { idFor: () => 'ws-replaced' })
  const dir = await f.workspaces.resolve('lark')
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  assert.deepEqual(m.calls, [])
  assert.equal(readMarker(f).attachedSessionIds, undefined)
})

await test('attach: channel registration removed (registry.get misses) → skipped, nothing re-registered', async () => {
  const f = await fixture()
  const m = membership(f)
  const dir = await f.workspaces.resolve('lark')
  const creates = f.host.calls.create.length
  f.host.entities.clear()
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  assert.deepEqual(m.calls, [])
  assert.equal(f.host.calls.create.length, creates)
})

await test('attach: host rejection propagates without receipt, is throttled in-process, retried by a fresh process', async () => {
  const f = await fixture()
  let fail = true
  const m = membership(f, { attachImpl: async () => { if (fail) throw new Error('boom') } })
  const dir = await f.workspaces.resolve('lark')
  await assert.rejects(f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir }))
  assert.equal(readMarker(f).attachedSessionIds, undefined, 'no receipt on failure')
  fail = false
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir })
  const sameProcess = createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller, registry: f.host.registry }) })
  await sameProcess.attach('lark', { sessionId: 's-1', cwd: dir })
  assert.deepEqual(m.calls, ['s-1'], 'throttled for the rest of this process, even across plugin re-apply')
  await f.workspaces.attach('lark', { sessionId: 's-2', cwd: dir })
  assert.deepEqual(m.calls, ['s-1', 's-2'], 'throttle is per session, not per channel')
  const fresh = await import('../lib/messaging-channel-workspace.js?fresh-process=' + Date.now())
  const next = fresh.createChannelWorkspaces({ root: f.root, services: () => ({ controller: f.host.controller, registry: f.host.registry }) })
  await next.attach('lark', { sessionId: 's-1', cwd: dir })
  assert.deepEqual(m.calls, ['s-1', 's-2', 's-1'])
  assert.deepEqual(readMarker(f).attachedSessionIds, ['s-2', 's-1'])
})

await test('attach: current() false before or during attachment writes no receipt', async () => {
  const f = await fixture()
  let active = true
  const m = membership(f, { attachImpl: async (id) => { if (id === 's-2') active = false } })
  const dir = await f.workspaces.resolve('lark')
  await f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir, current: () => false })
  assert.deepEqual(m.calls, [], 'not current: host never called')
  await f.workspaces.attach('lark', { sessionId: 's-2', cwd: dir, current: () => active })
  assert.deepEqual(m.calls, ['s-2'])
  assert.equal(readMarker(f).attachedSessionIds, undefined, 'went stale during host attach: no receipt')
})

await test('attach: concurrent attaches are serialized — same id once, different ids all kept', async () => {
  const f = await fixture()
  const m = membership(f, { attachImpl: () => new Promise(r => setTimeout(r, 5)) })
  const dir = await f.workspaces.resolve('lark')
  await Promise.all([
    f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir }),
    f.workspaces.attach('lark', { sessionId: 's-1', cwd: dir }),
    f.workspaces.attach('lark', { sessionId: 's-2', cwd: dir }),
    f.workspaces.attach('lark', { sessionId: 's-3', cwd: dir }),
  ])
  assert.deepEqual(m.calls, ['s-1', 's-2', 's-3'])
  assert.deepEqual(readMarker(f).attachedSessionIds, ['s-1', 's-2', 's-3'], 'no lost update')
})

await test('attach: receipt list at the 10,000 cap stops auto-joining instead of evicting', async () => {
  const f = await fixture()
  const m = membership(f)
  const dir = await f.workspaces.resolve('lark')
  const row = readMarker(f)
  const ids = Array.from({ length: 10000 }, (_, i) => 'old-' + i)
  fs.writeFileSync(f.marker('lark'), JSON.stringify({ ...row, attachedSessionIds: ids }), { mode: 0o600 })
  await f.workspaces.attach('lark', { sessionId: 'new', cwd: dir })
  assert.deepEqual(m.calls, [])
  assert.equal(readMarker(f).attachedSessionIds.length, 10000)
  assert.equal(f.workspaces.lookup('lark'), dir, 'full marker still valid')
})

await test('marker with malformed attachedSessionIds rejects with the fixed message', async () => {
  for (const bad of ['s-1', [1], [''], Array.from({ length: 10001 }, (_, i) => 'x' + i)]) {
    const f = await fixture()
    await f.workspaces.resolve('lark')
    fs.writeFileSync(f.marker('lark'), JSON.stringify({ ...readMarker(f), attachedSessionIds: bad }))
    await assert.rejects(f.workspaces.resolve('lark'), (e) => e.message === 'channel_workspace_store_invalid')
    assert.throws(() => f.workspaces.lookup('lark'), (e) => e.message === 'channel_workspace_store_invalid')
  }
})

const failed = results.filter(r => !r.ok)
console.log('messaging-channel-workspace: ' + (results.length - failed.length) + '/' + results.length + ' passed')
if (failed.length) process.exit(1)
