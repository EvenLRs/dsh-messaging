'use strict'
// ctx.shell 双代际适配单测（lib/shell-compat.js）。
// 背景：dsh-shell 存在两代公开契约——≤0.1.6 线 run/start、≥0.1.7-rc.2 线
// execute 句柄（前台 result()、后台保留句柄）。安装版运行时是后者，只认
// run/start 的插件会以 ctx.shell.run is not a function 崩掉全部 shell HTTP。
// 这里锁死两条分支的选择、结果透传、拒绝透传与错误文案。
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

async function main() {
  const { shellRun, shellStart } = await import(
    pathToFileURL(path.join(root, 'lib', 'shell-compat.js')).href)

  // 1) 旧代（≤0.1.6）：run 存在 → 直接用，execute 绝不被碰
  const oldResult = {
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
    stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
  }
  let runCalled = 0
  const oldShell = {
    run: async (spec) => { runCalled += 1; assert.equal(spec.command, 'curl …'); return oldResult },
    execute: async () => { throw new Error('execute must not be called when run exists') },
  }
  assert.equal(await shellRun(oldShell, { command: 'curl …' }), oldResult, 'run 路径结果原样透传')
  assert.equal(runCalled, 1)

  // 2) 新代（0.1.7-rc.2 安装版）：execute → 句柄.result()
  const newResult = {
    exitCode: 7, signal: null, timedOut: false, aborted: false, timeoutMs: 9,
    stdout: { text: 'body', truncated: true }, stderr: { text: 'warn', truncated: false },
  }
  let resultAwaited = 0
  const newShell = {
    execute: async (spec) => {
      assert.equal(spec.command, 'curl …')
      return {
        result: async () => { resultAwaited += 1; return newResult },
        readOutput: () => ({ delta: '', lossy: false }),
        kill: () => true,
        done: Promise.resolve(),
      }
    },
  }
  assert.equal(await shellRun(newShell, { command: 'curl …' }), newResult, 'execute→result() 结果原样透传')
  assert.equal(resultAwaited, 1, '前台必须等待 result()')

  // 3) 后台：旧代 start 直通 / 新代 execute 句柄直通（readOutput/kill/done 同表面）
  const bgHandle = { readOutput: () => ({ delta: 'x' }), kill: () => true, done: Promise.resolve() }
  assert.equal(await shellStart({ start: async () => bgHandle }, {}), bgHandle, '旧代 start 直通')
  assert.equal(await shellStart({ execute: async () => bgHandle }, {}), bgHandle, '新代 execute 句柄直通')

  // 4) 两代皆无 → 描述性错误（而不是 "not a function"）
  await assert.rejects(() => shellRun({}, {}), /neither run\(\) nor execute\(\)/)
  await assert.rejects(() => shellStart({}, {}), /neither start\(\) nor execute\(\)/)

  // 5) 基础设施拒绝原样抛出（result() 只在基础设施故障时 reject）
  const failing = { execute: async () => ({ result: async () => { throw new Error('spawn died') } }) }
  await assert.rejects(() => shellRun(failing, {}), /spawn died/)

  console.log('shell-compat: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
