// lark-fs-boundary.cjs —— 真实宿主 fs 服务边界探针（Lead：displayPath 非安全边界；
// targetKey=realpath canonical；signal 属 resolve/stat/readBytes 真签名的一部分）。
// 夹具要求：/tmp/dsh-hostx 宿主解包树（@deepseek-ai/dsh-fs 真服务；合成路径/文件，
// 不读真实用户数据）。mock 零读断言另在 host-smoke（标注 fake 层）。
process.env.DSH_TEST_TIMEOUT_MS = process.env.DSH_TEST_TIMEOUT_MS || '120000'
require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const HOST = (process.env.DSH_HOSTX_ROOT || process.env.DSH_HOSTX || '/tmp/dsh-hostx') + '/dsh/node_modules/@deepseek-ai/'
if (!fs.existsSync(path.join(HOST, 'dsh-fs-local'))) {
  throw new Error('host fixture missing: set DSH_HOSTX to an unpacked host tree (looked for dsh/node_modules/@deepseek-ai/dsh-fs-local)')
}

async function main() {
  const { Context } = await import(pathToFileURL(path.join(HOST, 'cordis/lib/index.js')).href)
  const hc = new Context()
  await hc.plugin((await import(pathToFileURL(path.join(HOST, 'dsh-fs-local/lib/index.js')).href)).default) // 真本地 fs 服务（提供 resolve/stat/readBytes/contains）
  const realFs = hc.fs
  assert.equal(typeof realFs.resolve, 'function', '真 fs.resolve 存在')
  assert.equal(typeof realFs.contains, 'function', '真 fs.contains（canonical 包含判定）存在')

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fs-boundary-'))
  fs.mkdirSync(path.join(cwd, 'sub'))
  fs.writeFileSync(path.join(cwd, 'sub', 'a.txt'), 'hello')
  fs.symlinkSync('/etc/passwd', path.join(cwd, 'evil.txt'))

  // 1) 正常读取：targetKey=realpath canonical，stat=file
  const okT = await realFs.resolve('sub/a.txt', { cwd })
  assert.ok(String(okT.targetKey).endsWith('/sub/a.txt'), 'targetKey 为 canonical 真实路径')
  const okInfo = await realFs.stat(okT)
  assert.equal(okInfo.type, 'file', '常规文件 stat=file')

  // 2) 符号链接：displayPath 在 root 内，但 targetKey 已归一到链接目标（出界）——
  //    证明 displayPath 只是展示、canonical 判定必须用 targetKey。
  const symT = await realFs.resolve('evil.txt', { cwd })
  assert.ok(String(symT.displayPath).includes('evil.txt'), 'displayPath 保留展示路径')
  assert.equal(realFs.contains({ targetKey: cwd }, symT), false, 'canonical(targetKey=/etc/passwd) 判定出界')

  // 3) 绝对路径越界：真 resolve 不吞（返回 canonical 由上层策略拒绝）
  const absT = await realFs.resolve('/etc/hosts', { cwd })
  assert.equal(realFs.contains({ targetKey: cwd }, absT), false, '绝对越界 canonical 判定出界')

  // 4) signal 真契约：预先中止 → resolve 抛 FS_ABORTED（零后续）
  await assert.rejects(
    () => realFs.resolve('sub/a.txt', { cwd, signal: AbortSignal.abort() }),
    (err) => String(err.code) === 'FS_ABORTED' || /abort/i.test(String(err.message)),
    '真 resolve 支持并强制 signal（FS_ABORTED）')

  // 5) readBytes 限额签名 (target, signal, maxBytes)
  const bytes = await realFs.readBytes(okT, undefined, 1024)
  assert.equal(Buffer.byteLength(bytes), 5, 'readBytes 限额内真实读取')

  // 6) 运行中取消：resolve 已返回后 abort → stat/read 按真签名携带 signal
  const midAbort = new AbortController()
  midAbort.abort()
  await assert.rejects(
    () => realFs.readBytes(okT, midAbort.signal, 1024),
    (err) => String(err.code) === 'FS_ABORTED' || /abort/i.test(String(err.message)),
    'readBytes 对已中止 signal 抛错（真签名 (target, signal, maxBytes)）')
  let statAborted = false
  try { await realFs.stat(okT, midAbort.signal) } catch (err) { statAborted = String(err.code) === 'FS_ABORTED' || /abort/i.test(String(err.message)) }
  console.log('stat-signal-abort=' + statAborted + '（真实签名支持情况如实记录）')

  console.log('lark-fs-boundary ok | real host fs | canonical targetKey boundary | signal FS_ABORTED | readBytes cap')
}

main().catch((err) => { console.error(err); process.exit(1) })
