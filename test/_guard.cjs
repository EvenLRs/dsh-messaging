'use strict'
// 统一超时兜底：任何 test 脚本挂住都必须以非零码退出，npm test 不会被拖死。
//
// 用法：脚本开头 `require('./_guard.cjs')` 即可（脚本名取自 argv[1]）。
// 超时可用环境变量 DSH_TEST_TIMEOUT_MS 覆盖（默认 60000）。
//
// 两层防护：
//   1) 主线程 unref 定时器——兜「还有真实定时器/句柄把事件循环占着」的挂起。
//      unref 保证它自己不阻止进程自然退出：测试跑完、循环清空时 exit(0)，它永不触发。
//   2) worker 线程硬杀——**微任务风暴**会把主线程饿死，连 1) 的定时器都排不进来
//      （9/24 那个空转 22 小时的残留进程就是这一类）。worker 跑在独立线程上不受
//      饿死影响：超时先同步向 stderr 打出脚本名，再对整个进程 SIGKILL，
//      npm test 拿到非零码即失败。
//
// 产品侧根治见 lib/index.js 的 ILINK_MIN_POLL_GAP_MS（wechatPollLoop 最小轮询间隔）。
const path = require('node:path')

const name = path.basename(process.argv[1] || 'test')
const timeoutMs = Number(process.env.DSH_TEST_TIMEOUT_MS || 60000)

// 1) 主线程兜底（干净退出，能带上脚本名）。
const guard = setTimeout(() => {
  console.error(name + ': timeout after ' + timeoutMs + 'ms')
  process.exit(1)
}, timeoutMs)
guard.unref()

// 2) 独立线程硬杀（对抗微任务风暴饿死主线程）。
//    worker 内的定时器必须保持 ref：否则 worker 自己的事件循环先空掉、线程提前退出，
//    硬杀永远不触发。主侧已 worker.unref()，不会拖住正常进程退出。
try {
  const { Worker } = require('node:worker_threads')
  const workerSource = [
    "const { parentPort, workerData } = require('node:worker_threads')",
    "const fs = require('node:fs')",
    'setTimeout(() => {',
    // 同步写 fd：紧跟就是 SIGKILL，异步 write 来不及冲刷。
    "  try { fs.writeSync(2, workerData.name + ': timeout after ' + workerData.ms + 'ms (starved main thread)\\n') } catch {}",
    "  try { process.kill(workerData.pid, 'SIGKILL') } catch {}",
    '}, workerData.ms)',
    'parentPort.unref()',
  ].join(';')
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { ms: timeoutMs, pid: process.pid, name },
  })
  worker.unref()
  worker.on('error', () => {})
} catch {
  // worker_threads 不可用时只有第 1) 层（正常挂起仍会被兜住）。
}

module.exports = guard
