// Real extracted-host executors. No transport/runtime execution is simulated here.
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const root = () => path.join(process.env.DSH_HOSTX_ROOT || '/tmp/dsh-hostx', 'dsh/node_modules/@deepseek-ai')
const load = name => import(pathToFileURL(path.join(root(), name, 'lib/index.js')).href)
const mounted = new WeakMap()
exports.native = async ctx => {
  if (mounted.has(ctx)) return mounted.get(ctx)
  const mod = await load('dsh-tool-executor-native')
  const fiber = await ctx.plugin(mod)
  mounted.set(ctx, fiber)
  return fiber
}
exports.ptc = async agentCtx => {
  const { PtcExecutor } = await load('dsh-tool-executor-ptc')
  const tools = agentCtx.get('tools')
  const { NativeToolExecutor } = await load('dsh-tool-executor-native')
  const previous = new NativeToolExecutor(agentCtx)
  const off = tools.setExecutor(new PtcExecutor(agentCtx))
  return () => { off(); tools.setExecutor(previous) }
}
// Adapt the old single-call fixture input to the real executor's batch boundary.
exports.execute = async (tools, { callId, name, arguments: args, agent, signal, ...rest }) => {
  const batch = await tools.execute({ calls: [{ id: callId, name, arguments: JSON.stringify(args) }], agent, signal, ...rest })
  require('node:assert/strict').equal(batch.results.length, 1)
  require('node:assert/strict').equal(batch.results[0].callId, callId)
  return batch.results[0].result
}
