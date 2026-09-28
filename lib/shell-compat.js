// ctx.shell 双代际适配层。
//
// dsh-shell 有两代并存的公开契约（实证）：
//   · ≤0.1.6 线（dev 构建 / master 检出）：`run(spec)` 前台等待并返回结果，
//     `start(spec)` 返回后台句柄；
//   · ≥0.1.7-rc.2（本机安装版运行时）：统一为 `execute(spec)` —— **立即返回
//     统一句柄**，前台 = `await handle.result()`（字段与旧 run 同名同义：
//     exitCode / signal / timedOut / aborted / timeoutMs /
//     stdout:{text,truncated} / stderr:{text,truncated}），后台 = 保留句柄
//     （readOutput()/kill()/done 与旧 ShellProcess 同表面）。
//
// 只认 run/start 的插件在0.1.7 运行时上会以 `ctx.shell.run is not a function`
// 崩掉**全部经 shell curl 的 HTTP**（本插件所有入站轮询与出站发送）。所有调用
// 一律经由本模块，两代运行时皆可工作。
//
// 注意：0.1.7 的 `resolve()` 默认 `onExpiry: 'kill'`（前台超时即杀，等价旧
// run 语义，正合 HTTP 需要）；**常驻后台进程必须显式 `onExpiry: 'none'`**，
// 否则会被 resolve 填入的默认 timeoutMs 到点杀掉。旧代 resolve 会丢弃这个
// 未知字段、start 本就忽略超时——传了对旧代也无害。

/**
 * 前台执行：旧代走 run()，新代 execute() 后等 result()。
 * 拒绝仅表示基础设施故障；非零退出/超时/中止都随结果对象返回。
 * @param shell - `ctx.shell` 服务实例
 * @param spec - `shell.resolve()` 产出的已解析执行规格
 * @returns 与旧 run() 同形的执行结果
 */
export async function shellRun(shell, spec) {
  if (typeof shell.run === 'function') return shell.run(spec)
  if (typeof shell.execute !== 'function') {
    throw new Error('ctx.shell exposes neither run() nor execute()')
  }
  const handle = await shell.execute(spec)
  return handle.result()
}

/**
 * 后台启动：旧代走 start()，新代直接返回 execute() 的句柄（调用方以
 * readOutput()/kill()/done 消费，两代表面一致）。
 * @param shell - `ctx.shell` 服务实例
 * @param spec - 已解析执行规格；新代下调用方须确保 onExpiry:'none'
 * @returns 后台进程句柄
 */
export async function shellStart(shell, spec) {
  if (typeof shell.start === 'function') return shell.start(spec)
  if (typeof shell.execute !== 'function') {
    throw new Error('ctx.shell exposes neither start() nor execute()')
  }
  return shell.execute(spec)
}
