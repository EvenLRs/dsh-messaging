import { spawnSync } from 'node:child_process'
import { createHash, createCipheriv, randomBytes } from 'node:crypto'
import protobuf from 'protobufjs'
// Real installed-version Cordis plugin, Agent/Session/projection/flush, Tools/SystemPrompt and
// native/PTC presentation; fake Feishu curl and model provider only.
import './_guard.cjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
const root = path.resolve(process.env.DSH_HOSTX_ROOT || '/tmp/dsh-hostx', 'dsh/node_modules/@deepseek-ai')
const imp = name => import(pathToFileURL(path.join(root, name, 'lib/index.js')))
await fs.access(path.join(root, 'dsh-tools/lib/index.js')) // missing real host is a failure
const { Context } = await imp('cordis')
const llm = await imp('dsh-llm'), Tools = await imp('dsh-tools'), Agent = await imp('dsh-agent')
const plugin = await import('../lib/index.js')
const { sessionIdForKey } = await import('../lib/session-id-migration.js')
const { openLarkDedupStore, larkDedupKey } = await import('../lib/lark-dedup.js')
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'messaging-interactions-host-'))
const bWire = []; let bGate, bCode = 0, bStatus = 200, wsDispatcher
const routes = new Map(), replies = [], reads = [], messages = new Map(), refs = new Map(), normalSends = []
const tick = () => new Promise(r => setTimeout(r, 25))
let replyGate, onDispatch, ledger, statusCode = 200, businessCode = 0, replyThrow = false, normalResponseChat
const ctx = new Context(), restoreFetch = globalThis.fetch
const axios = (await import('axios')).default, oldAxiosAdapter = axios.defaults.adapter
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
let downloads = 0, modelOutput = false, modelText = 'synthetic streaming answer'; const modelRequests=[]
const names = ['messaging_context', 'messaging_reply', 'messaging_capabilities', 'messaging_edit', 'messaging_recall', 'messaging_reaction_add', 'messaging_reaction_remove', 'messaging_reactions', 'messaging_read', 'messaging_read_events', 'messaging_card_publish', 'messaging_card_update', 'messaging_card_status']
try {
  axios.defaults.adapter = async config => {
    const url = String(config.url || '')
    if (url.includes('/auth/v3/')) return { data: { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }, status: 200, headers: {}, config }
    if (url.includes('/resources/')) { downloads++; return { data: Readable.from([PNG]), status: 200, headers: { 'content-type': 'image/png' }, config } }
    assert.fail('unexpected synthetic SDK wire')
  }
  await ctx.plugin((await imp('cordis-plugin-timer')).default)
  ctx.provide('dsh.home', home); ctx.provide('dshMessaging.root', home)
  ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'm' }) })
  ctx.provide('shell', { resolve: x => x, async run(req) {
    const stdin = String(req.stdin || '')
    if(String(req.command||'').includes('crypto-helper.cjs')) {
      const op=String(req.command).includes("'decrypt'")?'decrypt':'verify'
      const child=spawnSync(process.execPath,[path.resolve('companion/crypto-helper.cjs'),'lark',op],{input:stdin,encoding:'utf8'})
      return {exitCode:child.status,timedOut:false,aborted:false,stdout:{text:child.stdout},stderr:{text:child.stderr}}
    }
    let data = { code: 0 }, code = 200
    if (stdin.includes('/auth/v3/')) data = { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
    else if (stdin.includes('/application/v6/scopes')) data = { code: 0, data: { scopes: [{ scope_name: 'im:resource' }, { scope_name: 'im:message:readonly' }, { scope_name: 'im:message.group_msg' }] } }
    else if (stdin.includes('/reply')) {
      const url = stdin.split('\n').find(x => x.startsWith('url = ')); const body = stdin.split('\n').find(x => x.startsWith('data-binary = '))
      const payload = JSON.parse(body.slice('data-binary = '.length).slice(1, -1).replace(/\\(["\\])/g, '$1'))
      replies.push({ url, payload }); onDispatch?.(); if (replyGate) await replyGate
      if (replyThrow) throw new Error('raw-secret-error')
      code = statusCode; data = { code: businessCode, data: { message_id: 'synthetic-sent-' + replies.length, create_time: String(Date.now()) } }
    } else if (stdin.includes('/im/v1/messages?')) {
      const line = stdin.split('\n').find(x => x.startsWith('data-binary = '))
      const payload = JSON.parse(line.slice('data-binary = '.length).slice(1, -1).replace(/\\(["\\])/g, '$1'))
      const id = 'synthetic-bot-' + normalSends.length
      const item = { message_id: id, chat_id: payload.receive_id, create_time: String(Date.now()), msg_type: payload.msg_type, body: { content: payload.content } }
      normalSends.push({ payload, item }); messages.set(id, { ...item, msg_type: 'text', body: { content: JSON.stringify({ text: 'synthetic bot answer' }) } })
      data = { code: 0, data: { ...item, chat_id: normalResponseChat || item.chat_id } }
    } else if (stdin.includes('/cardkit/v1/cards')) {
      data = { code: 0, data: { card_id: 'synthetic-card' } }
    } else if (stdin.includes('/im/v1/messages/') && (stdin.includes('/reactions') || stdin.includes('/read_users') || /request = "(?:PUT|PATCH|DELETE)"/.test(stdin))) {
      const method = stdin.match(/request = "([^"]+)"/)[1]
      const url = stdin.split('\n').find(x => x.startsWith('url = '))
      const line = stdin.split('\n').find(x => x.startsWith('data-binary = '))
      const payload = line ? JSON.parse(line.slice('data-binary = '.length).slice(1,-1).replace(/\\(["\\])/g, '$1')) : undefined
      bWire.push({method,url,payload}); if (bGate) await bGate
      code = bStatus
      data = {code:bCode,data: method === 'POST' ? {reaction_id:'fixture-own-reaction',operator:{operator_type:'app',operator_id:'synthetic-app'}} : {items:[],has_more:false}}
    } else if (stdin.includes('/im/v1/messages/')) {
      const id = [...messages.keys()].find(k => stdin.includes('/messages/' + k + '"') || stdin.includes('/messages/' + k + '?card_msg_content_type=user_card_content"'))
      const item=messages.get(id), original=stdin.includes('?card_msg_content_type=user_card_content')
      reads.push(id); data = { code: 0, data: { items: id ? [{...item,...(original&&item.originalCard?{body:{content:JSON.stringify(item.originalCard)}}:{})}] : [] } }
    }
    return { exitCode: 0, timedOut: false, aborted: false, stdout: { text: JSON.stringify(data) + '\n__DSH_STATUS__:' + code }, stderr: { text: '' } }
  } })
  await ctx.plugin(llm.default)
  await ctx.plugin((await imp('dsh-session')).default)
  await ctx.plugin((await imp('dsh-fs-local')).default)
  await ctx.plugin((await imp('dsh-session-projection')).default)
  await ctx.plugin((await imp('dsh-sandbox-policy')).default, { workspaceRoot: home })
  await ctx.plugin((await imp('dsh-attachment-local')).default, { dshHome: home })
  await ctx.plugin((await imp('dsh-system-prompt')).default)
  class Mock extends llm.LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] } }
    async *stream(request) {
      modelRequests.push(request.messages)
      if (modelOutput) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: modelText }
        await new Promise(r => setTimeout(r, 500))
        yield { type: 'block-end', index: 0, block: { type: 'text', text: modelText } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new Mock())
  let toolsFiber = await ctx.plugin(Tools.default)
  await ctx.plugin(Agent.default)
  await ctx.plugin((await imp('dsh-session-persistence-jsonl')), { root: path.join(home, 'sessions') })
  await ctx.plugin((await imp('dsh-agent-loop')).default, { agents: [] })
  const config = plugin.defaultConfig(home)
  Object.assign(config.adapters.lark, { enabled: true, mode: 'webhook', appId: 'synthetic-app', appSecret: 'synthetic-secret', verificationToken: 'synthetic-verification' })
  Object.assign(config.agent, { provider: 'mock', model: 'm', cwd: home })
  let fiber = await ctx.plugin(plugin, config)
  ledger = await openLarkDedupStore(path.join(home, 'lark-dedup'))
  const post = async (id, chat = 'synthetic-chat', parent, typed = false, alreadyAdmitted = false) => {
    messages.set(id, { message_id: id, chat_id: chat, create_time: String(Date.now()), msg_type: 'text', body: { content: JSON.stringify({ text: 'synthetic ' + id }) } })
    const body = { schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'event-' + id, app_id:'synthetic-app', tenant_key:'synthetic-app-tenant', token: 'synthetic-verification' }, event: { message: { message_id: id, chat_id: chat, create_time: messages.get(id).create_time, chat_type: 'p2p', message_type: typed ? 'image' : 'text', content: JSON.stringify(typed ? { image_key: 'img_v3_synthetic' } : { text: 'synthetic ' + id }), ...(parent ? { parent_id: parent } : {}) }, sender: { sender_type: 'user', tenant_key:'synthetic-user-tenant', sender_id: { open_id: 'synthetic-user' } } } }
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
    let code
    if (routes.has('/messaging/lark/events')) await routes.get('/messaging/lark/events')(req, { writeHead(n) { code = n }, end() {} })
    else { assert.ok(wsDispatcher); await wsDispatcher.invoke(body); code = 200 }
    assert.equal(code, 200)
    for (let i = 0; i < 80; i++) {
      const a = ctx.agents.get(sessionIdForKey('lark:' + chat))
      if (a && ctx.tools.get('messaging_context', a) && ledger.get(larkDedupKey('synthetic-app', id))?.state === 'delivered') {
        const row = ledger.get(larkDedupKey('synthetic-app', id))
        const admitted = Array.from({ length: a.session.seq }, (_, n) => a.session.eventAt(n))
          .filter(e => e?.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted || []).find(m => m.id === row.userMessageId)
        const ref = JSON.stringify(admitted || '').match(/\[message ref: (msgref_[a-f0-9]+)\]/)?.[1]
        if (ref) refs.set(id, ref)
        const result = (ref || alreadyAdmitted) && await ctx.tools.execute({ agent: a, callId: 'wait-' + id, name: 'messaging_context', arguments: ref ? { target: ref } : {}, signal: new AbortController().signal })
        if (result?.value?.ok) return a
      }
      await tick()
    }
    assert.fail('normal plugin ingress did not expose usable current message reference')
  }
  const ordinaryHandle = await ctx.agents.create({ sessionId: 'synthetic-ordinary', meta: { cwd: home }, agentOptions: { provider: 'mock', model: 'm' } })
  const ordinary = ordinaryHandle.agent
  const foreground = await ctx.agents.create({ sessionId: sessionIdForKey('lark:synthetic-chat'), meta: { cwd: home }, agentOptions: { provider: 'mock', model: 'm' } })
  let bound = await post('incoming-one')
  assert.equal(bound, foreground.agent, 'busy foreground agent reused with same scoped tools')
  const call = (a, name, args = {}, id = name) => ctx.tools.execute({ agent: a, callId: id, name, arguments: args, signal: new AbortController().signal })
  for (const name of names) { assert.equal(ctx.tools.get(name), undefined); assert.equal(ctx.tools.get(name, ordinary), undefined); Tools.assertObjectJsonSchema(ctx.tools.get(name, bound).parameters) }
  const uiPost = async (route, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'
    req.headers = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' }
    let status, text = ''
    await routes.get(route)(req, { writeHead(n) { status = n }, end(data) { text = String(data || '') } })
    assert.equal(status, 200); return JSON.parse(text)
  }
  const first = (await call(bound, 'messaging_context')).value
  assert.ok(first.messageRef); assert.ok(!JSON.stringify(first).includes('incoming-one'))
  const sent = await call(bound, 'messaging_reply', { operation_id: 'first', text: 'synthetic reply' })
  assert.equal(sent.value.ok, true); assert.ok(sent.value.messageRef); assert.equal(replies.length, 1)
  assert.ok(replies[0].url.includes('/messages/incoming-one/reply'))
  assert.equal((await call(bound, 'messaging_reply', { operation_id: 'first', target: first.messageRef, text: 'synthetic reply' }, 'replay')).value.replayed, true)
  assert.equal((await call(bound, 'messaging_reply', { operation_id: 'first', target: first.messageRef, text: 'changed' }, 'conflict')).value.error.code, 'conflict'); assert.equal(replies.length, 1)
  const captured = ctx.tools.get('messaging_reply', bound)
  assert.equal((await captured.execute({ operation_id: 'forced', text: 'test' }, { agent: ordinary })).error.code, 'not_bound')
  assert.equal((await call(ordinary, 'messaging_reply', { operation_id: 'ordinary', text: 'test' })).isError, true)

  const { bindScopeParent } = await imp('dsh-scope')
  const childHandle = await bound.ctx.get('agents').create({ sessionId: 'synthetic-child', meta: { cwd: home }, agentOptions: { provider: 'mock', model: 'm' }, parentAgent: bound, setup(_ctx, agent) { bindScopeParent(agent, bound) } })
  const child = childHandle.agent
  for (const name of names) assert.equal(ctx.tools.get(name, child), undefined)
  ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' })
  const assemble = a => ctx.systemPrompt.assemble({ scope: a })
  const ptc = [ordinary, bound, child].map(a => a.ctx.get('tools').presentAs('ptc'))
  for (const a of [ordinary, bound, child]) {
    const view = await assemble(a); assert.deepEqual(view.tools.map(t => t.name), ['run_code'])
    for (const name of names) assert.equal(view.sections.find(s => s.name === 'tools:sdk').text.includes(name), a === bound)
  }
  ptc.forEach(off => off())
  // Real provider serializer sees valid object schemas; fake response is text-only.
  const ds = await imp('dsh-llm-deepseek'), requests = []
  const connection = ds.resolveAdapterOptions({ baseURL: 'http://synthetic.invalid/anthropic', models: [{ id: 'm', inputModalities: ['text'] }], thinking: 'disabled' })
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body)
    for (const tool of body.tools || []) Tools.assertObjectJsonSchema(tool.input_schema)
    const events = [['message_start', { type: 'message_start', message: { id: 'synthetic-response', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic answer' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }], ['message_stop', { type: 'message_stop' }]]
    return new Response(events.map(([k, v]) => 'event: ' + k + '\ndata: ' + JSON.stringify(v) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  ctx.llm.registerAdapter(['isolated'], new ds.DeepSeekAdapter({ options: () => connection, resolveAuth: async () => ({ headers: {} }), resolveFiles: () => ({}), resolveUserId: () => 'synthetic', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) }))
  for (const a of [ordinary, bound, child]) {
    const chunks = []; for await (const chunk of ctx.llm.stream({ provider: 'isolated', model: 'm', messages: [llm.createUserMessage({ content: [{ type: 'text', text: 'synthetic hello' }], source: { kind: 'user' } })], tools: (await assemble(a)).tools, signal: new AbortController().signal, reasoningEffort: 'off' })) chunks.push(chunk)
    assert.ok(chunks.some(x => JSON.stringify(x).includes('synthetic answer')))
    for (const name of names) assert.equal(requests.at(-1).tools.some(t => t.name === name), a === bound)
  }
  const sibling = await post('sibling-incoming', 'other-chat')
  assert.equal((await call(sibling, 'messaging_reply', { operation_id: 'cross', text: 'test', target: first.messageRef })).value.error.code, 'target_unverified'); assert.equal(replies.length, 1)
  await post('incoming-quote', 'synthetic-chat', 'incoming-one')
  const q = (await call(bound, 'messaging_context', { target: refs.get('incoming-quote') })).value
  assert.equal(q.quote.available, true); assert.ok(q.quote.text.includes('synthetic incoming-one'))
  assert.ok(reads.every(x => x === 'incoming-one'))
  // Projection/flush still admits one original input with quote context, never a second followup.
  const quoteRow = ledger.get(larkDedupKey('synthetic-app', 'incoming-quote'))
  const admittedQuote = () => Array.from({ length: bound.session.seq }, (_, i) => bound.session.eventAt(i))
    .filter(x => x?.type === 'agent/inbox/spliced').flatMap(x => x.data.inserted || []).filter(x => x.id === quoteRow.userMessageId)
  assert.equal(admittedQuote().length, 1, 'quote enrichment uses the original single admission')
  assert.ok(JSON.stringify(admittedQuote()).includes('Messaging quote context'))
  await post('incoming-quote', 'synthetic-chat', 'incoming-one')
  assert.equal(admittedQuote().length, 1, 'replayed quote does not enqueue again')

  const parallelStart = replies.length
  const parallel = await Promise.all([
    call(bound, 'messaging_reply', { operation_id: 'parallel', text: 'first chat' }),
    call(sibling, 'messaging_reply', { operation_id: 'parallel', text: 'second chat' }),
  ])
  assert.ok(parallel.every(x => x.value.ok))
  assert.deepEqual(replies.slice(parallelStart).map(x => x.url.match(/messages\/([^/]+)\/reply/)[1]).sort(), ['incoming-quote', 'sibling-incoming'].sort())
  assert.notEqual(replies[parallelStart].payload.uuid, replies[parallelStart + 1].payload.uuid)
  // C5: N remains explicit while N+1 arrives; neither default can drift.
  const ambiguous = await post('ambiguous-N', 'ambiguity-chat')
  await post('ambiguous-N1', 'ambiguity-chat')
  const nBefore = replies.length
  assert.equal((await call(ambiguous, 'messaging_reply', { operation_id: 'ambiguous', text: 'test' })).value.error.code, 'target_required')
  assert.equal(replies.length, nBefore)
  assert.equal((await call(ambiguous, 'messaging_reply', { operation_id: 'N', target: refs.get('ambiguous-N'), text: 'test' })).value.ok, true)
  assert.ok(replies.at(-1).url.includes('/messages/ambiguous-N/reply'))
  assert.equal((await call(ambiguous, 'messaging_reply', { operation_id: 'N1', text: 'test' })).value.ok, true)
  assert.ok(replies.at(-1).url.includes('/messages/ambiguous-N1/reply'))
  // Real adapter ordinary text (including every split segment) is referenceable.
  const botStart = normalSends.length
  assert.equal((await uiPost('/__dsh-messaging/send', { channel: 'lark', conversation: 'lark:synthetic-chat', text: 'x'.repeat(35000) })).ok, true)
  assert.ok(normalSends.length - botStart > 1)
  for (const [i, sent] of normalSends.slice(botStart).entries()) {
    await post('quote-text-segment-' + i, 'synthetic-chat', sent.item.message_id)
    assert.equal((await call(bound, 'messaging_context', { target: refs.get('quote-text-segment-' + i) })).value.quote.available, true)
  }
  // A success with an inconsistent returned chat is NOT registered, yet the
  // original ordinary send result is untouched.
  normalResponseChat = 'foreign-chat'
  assert.equal((await uiPost('/__dsh-messaging/send', { channel: 'lark', conversation: 'lark:synthetic-chat', text: 'synthetic mismatch' })).ok, true)
  normalResponseChat = undefined
  const wrongBot = normalSends.at(-1).item.message_id
  messages.set(wrongBot,{...messages.get(wrongBot),chat_id:'foreign-chat'}) // GET must also prove same-chat; do not fabricate a safe reply.
  await post('quote-wrong-bot', 'synthetic-chat', wrongBot)
  const readsBeforeWrong = reads.length
  assert.equal((await call(bound, 'messaging_context', { target: refs.get('quote-wrong-bot') })).value.quote.reason, 'target_unverified')
  assert.equal(reads.length, readsBeforeWrong+1, 'only the authenticated quote anchor permits this GET; wrong-chat response remains rejected')
  // C6: seed a true projection admission while real bindRoute is finishing.
  // Fresh v1=admitted must select that message without a second followup.
  const admittedSession = sessionIdForKey('lark:admitted-chat')
  const admittedHandle = await ctx.agents.create({ sessionId: admittedSession, meta: { cwd: home }, agentOptions: { provider: 'mock', model: 'm' } })
  const originalBind = ledger.store.bindRoute.bind(ledger.store)
  let seeded = false
  ledger.store.bindRoute = async (key, ...rest) => {
    const result = await originalBind(key, ...rest), row = ledger.get(key)
    if (!seeded && row?.messageId === 'fresh-admitted') {
      seeded = true
      admittedHandle.agent.followup({ id: row.userMessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'preexisting synthetic admission' }] })
    }
    return result
  }
  const admittedAgent = await post('fresh-admitted', 'admitted-chat', undefined, false, true)
  ledger.store.bindRoute = originalBind
  const admittedRow = ledger.get(larkDedupKey('synthetic-app', 'fresh-admitted'))
  const admittedCount = () => Array.from({ length: admittedAgent.session.seq }, (_, i) => admittedAgent.session.eventAt(i))
    .filter(e => e?.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted || []).filter(m => m.id === admittedRow.userMessageId).length
  assert.equal(admittedCount(), 1)
  assert.equal((await call(admittedAgent, 'messaging_reply', { operation_id: 'admitted-only', text: 'synthetic' })).value.ok, true)
  assert.ok(replies.at(-1).url.includes('/messages/fresh-admitted/reply')); assert.equal(admittedCount(), 1)
  // Typed image input receives its own metadata in the original one admission.
  const typedAgent = await post('typed-ref', 'typed-chat', undefined, true)
  assert.equal(downloads, 1)
  const typedRow = ledger.get(larkDedupKey('synthetic-app', 'typed-ref'))
  const typedMessages = Array.from({ length: typedAgent.session.seq }, (_, i) => typedAgent.session.eventAt(i))
    .filter(e => e?.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted || []).filter(m => m.id === typedRow.userMessageId)
  assert.equal(typedMessages.length, 1); assert.ok(JSON.stringify(typedMessages).includes('[message ref: '))
  await post('typed-ref', 'typed-chat', undefined, true)
  assert.equal(downloads, 1, 'typed replay never downloads or admits again')
  statusCode = 500
  const unknown = await call(bound, 'messaging_reply', { operation_id: 'unknown', target: q.messageRef, text: 'test' })
  assert.equal(unknown.value.status, 'unknown'); assert.ok(JSON.stringify(unknown.content).includes('do NOT retry'))
  const n = replies.length; await call(bound, 'messaging_reply', { operation_id: 'unknown', target: q.messageRef, text: 'test' }, 'unknown-again'); assert.equal(replies.length, n)
  statusCode = 200
  replyThrow = true
  const secretFailure = await call(bound, 'messaging_reply', { operation_id: 'secret-failure', target: q.messageRef, text: 'synthetic' })
  replyThrow = false
  assert.equal(secretFailure.value.status, 'unknown'); assert.ok(!JSON.stringify(secretFailure).includes('raw-secret-error'))
  const statusReq = Readable.from([]); statusReq.method = 'GET'; statusReq.headers = { host: '127.0.0.1:5173' }
  let safeStatus = ''
  await routes.get('/__dsh-messaging/status')(statusReq, { writeHead() {}, end(body) { safeStatus = String(body) } })
  assert.ok(!safeStatus.includes('raw-secret-error'), 'raw provider error never enters status/recordError')
  // Render separates definite platform rejection from unknown and local input.
  businessCode = 99991672
  const denied = await call(bound, 'messaging_reply', { operation_id: 'denied', target: q.messageRef, text: 'synthetic' })
  businessCode = 0
  assert.equal(denied.value.dispatched, true); assert.equal(denied.value.error.retryable, false)
  assert.ok(JSON.stringify(denied.content).includes('platform explicitly rejected'))
  const invalid = await call(bound, 'messaging_reply', { operation_id: 'invalid', text: 'x'.repeat(12001), target: q.messageRef })
  assert.equal(invalid.value.dispatched, false); assert.equal(invalid.value.error.retryable, false)
  assert.ok(JSON.stringify(invalid.content).includes('NOT dispatched'))
  const oldDefinition = ctx.tools.get('messaging_reply', bound), oldReference = q.messageRef
  let releaseReply, dispatchedReply
  replyGate = new Promise(r => { releaseReply = r })
  const wasDispatched = new Promise(r => { dispatchedReply = r })
  onDispatch = dispatchedReply
  const oldPending = call(bound, 'messaging_reply', { operation_id: 'during-tools-replacement', target: q.messageRef, text: 'pending' })
  await wasDispatched
  await toolsFiber.dispose(); await tick()
  releaseReply(); replyGate = null; onDispatch = null
  assert.equal((await oldPending).value.status, 'unknown', 'old in-flight call cannot publish success after service/agent retirement')
  for (const name of names) assert.equal(bound.ctx.get('tools')?.get(name, bound), undefined)
  toolsFiber = await ctx.plugin(Tools.default); await tick()
  assert.equal(ctx.agents.get(bound.session.id), undefined, 'real Host retires agents when Tools dependency is replaced')
  const retired = bound
  bound = await post('incoming-after-tools-replacement')
  assert.ok(ctx.tools.get('messaging_reply', bound))
  assert.equal((await oldDefinition.execute({ operation_id: 'old-definition', text: 'test' }, { agent: retired })).error.code, 'not_bound')
  assert.equal((await oldDefinition.execute({ operation_id: 'old-definition-new-agent', text: 'test' }, { agent: bound })).error.code, 'not_bound')
  assert.equal((await call(bound, 'messaging_context')).value.ok, true)
  const beforeDispose = replies.length
  await fiber.dispose(); await tick()
  assert.equal((await captured.execute({ operation_id: 'old-plugin', text: 'test' }, { agent: bound })).error.code, 'not_bound')
  fiber = await ctx.plugin(plugin, config); await tick()
  bound = await post('incoming-new-generation')
  assert.equal((await call(bound, 'messaging_reply', { operation_id: 'old-ref', text: 'test', target: oldReference })).value.error.code, 'target_unverified')
  assert.equal(replies.length, beforeDispose)
  assert.equal((await call(bound, 'messaging_capabilities')).value.capabilities['message.edit'].supported, true)
  await fiber.dispose()
  messages.set('cold-context', { message_id: 'cold-context', chat_id: 'synthetic-chat', create_time: String(Date.now()), msg_type: 'text', body: { content: JSON.stringify({ text: 'synthetic recovered input' }) } })
  const cold = await ledger.claim({ appId: 'synthetic-app', messageId: 'cold-context', chatId: 'synthetic-chat', chatType: 'p2p', sessionId: sessionIdForKey('lark:synthetic-chat'), sessionExisted: true })
  ledger.release(cold.record.key)
  fiber = await ctx.plugin(plugin, config)
  const until = Date.now() + 10000
  while (ledger.get(cold.record.key).state !== 'delivered') { assert.ok(Date.now() < until, 'cold recovery deadline'); await tick() }
  const resumed = ctx.agents.get(sessionIdForKey('lark:synthetic-chat'))
  assert.ok((await call(resumed, 'messaging_context')).value.messageRef, 'cold recovery signs a fresh current handle')
  assert.equal((await call(resumed, 'messaging_reply', { operation_id: 'cold-explicit', text: 'synthetic cold reply' })).value.ok, true)
  assert.ok(replies.at(-1).url.includes('/messages/cold-context/reply'))
  const coldAdmitted = Array.from({ length: resumed.session.seq }, (_, i) => resumed.session.eventAt(i))
    .filter(e => e?.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted || []).filter(m => m.id === cold.record.userMessageId)
  assert.equal(coldAdmitted.length, 1); assert.ok(JSON.stringify(coldAdmitted).includes('[message ref: '))
  await fiber.dispose()
  // C9: a recovery GET with a different chat must neither admit that body
  // nor register it in the returned foreign chat. Correcting fake data recovers.
  messages.set('wrong-chat-recovery', { message_id: 'wrong-chat-recovery', chat_id: 'wrong-returned-chat', create_time: String(Date.now()), msg_type: 'text', body: { content: JSON.stringify({ text: 'synthetic wrong-chat body' }) } })
  const wrongRecovery = await ledger.claim({ appId: 'synthetic-app', messageId: 'wrong-chat-recovery', chatId: 'synthetic-chat', chatType: 'p2p', sessionId: sessionIdForKey('lark:synthetic-chat'), sessionExisted: true })
  ledger.release(wrongRecovery.record.key)
  fiber = await ctx.plugin(plugin, config)
  const wrongDeadline = Date.now() + 10000
  while (!reads.includes('wrong-chat-recovery')) { assert.ok(Date.now() < wrongDeadline); await tick() }
  assert.equal(ledger.get(wrongRecovery.record.key).state, 'claimed')
  const wrongReturnAgent = await post('quote-wrong-recovery', 'wrong-returned-chat', 'wrong-chat-recovery')
  const wrongGets = reads.filter(x => x === 'wrong-chat-recovery').length
  // A NEW authenticated quote in the actual returned chat independently
  // authorizes its own read; this does not admit the original wrong-chat row.
  assert.equal((await call(wrongReturnAgent, 'messaging_context', { target: refs.get('quote-wrong-recovery') })).value.quote.available, true)
  assert.equal(reads.filter(x => x === 'wrong-chat-recovery').length, wrongGets+1)
  const mismatchedAgent = ctx.agents.get(sessionIdForKey('lark:synthetic-chat'))
  assert.equal(Array.from({ length: mismatchedAgent.session.seq }, (_, i) => mismatchedAgent.session.eventAt(i))
    .filter(e => e?.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted || []).filter(m => m.id === wrongRecovery.record.userMessageId).length, 0)
  messages.get('wrong-chat-recovery').chat_id = 'synthetic-chat'
  while (ledger.get(wrongRecovery.record.key).state !== 'delivered') { assert.ok(Date.now() < wrongDeadline); await tick() }
  await fiber.dispose()
  config.adapters.lark.interactiveCard = true
  fiber = await ctx.plugin(plugin, config)
  const cardAgent = await post('static-card-target', 'card-chat')
  const explicitCard = await call(cardAgent, 'messaging_reply', { operation_id: 'interactive-explicit', text: 'synthetic card reply' })
  assert.equal(explicitCard.value.ok, true); assert.equal(replies.at(-1).payload.msg_type, 'interactive')
  const cardStart = normalSends.length
  assert.equal((await uiPost('/__dsh-messaging/send', { channel: 'lark', conversation: 'lark:card-chat', text: 'c'.repeat(35000) })).ok, true)
  const cardSegments = normalSends.slice(cardStart)
  assert.ok(cardSegments.length > 1); assert.ok(cardSegments.every(x => x.payload.msg_type === 'interactive'))
  for (const [i, sent] of cardSegments.entries()) {
    await post('quote-card-segment-' + i, 'card-chat', sent.item.message_id)
    const staticQuote = (await call(cardAgent, 'messaging_context', { target: refs.get('quote-card-segment-' + i) })).value.quote
    assert.equal(staticQuote.available, true)
    assert.equal(staticQuote.message.type, 'static_card'); assert.equal(staticQuote.message.botAuthored, true)
    assert.equal((await call(cardAgent, 'messaging_edit', { target: staticQuote.messageRef, operation_id: 'static-edit-' + i, text: 'synthetic card replacement' })).value.ok, true)
    assert.equal(bWire.at(-1).method, 'PATCH'); assert.equal(JSON.parse(bWire.at(-1).payload.content).config.update_multi, true)
  }
  const streamStart = normalSends.length
  modelOutput = true
  const streamingAgent = await post('stream-model-input', 'stream-model-chat')
  for (let i = 0; normalSends.length === streamStart && i < 160; i++) await tick()
  modelOutput = false
  assert.ok(normalSends.length > streamStart, 'real agent-loop stream opens a CardKit reference message')
  const streamSent = normalSends[streamStart]
  assert.ok(JSON.parse(streamSent.payload.content).data.card_id)
  await new Promise(r => setTimeout(r, 600))
  const cataloguedBody='CATALOGUED_CARDKIT_BODY'
  messages.set(streamSent.item.message_id,{...streamSent.item,msg_type:'interactive',updated:true,body:{content:JSON.stringify({schema:'2.0',config:{streaming_mode:false},body:{elements:[{tag:'markdown',content:cataloguedBody}]}})}})
  await post('quote-stream-card', 'stream-model-chat', streamSent.item.message_id)
  const streamQuote = (await call(streamingAgent, 'messaging_context', { target: refs.get('quote-stream-card') })).value.quote
  assert.equal(streamQuote.available, true); assert.equal(streamQuote.message.type, 'cardkit')
  assert.equal(streamQuote.freshness,'unverified','provider messageType drives freshness for an already catalogued cardkit')
  for(let i=0;!modelRequests.some(ms=>JSON.stringify(ms).includes('synthetic quote-stream-card'))&&i<80;i++)await tick()
  const cataloguedInput=JSON.stringify(modelRequests.filter(ms=>JSON.stringify(ms).includes('synthetic quote-stream-card')).at(-1).filter(m=>m.role==='user').at(-1))
  assert.ok(cataloguedInput.includes(cataloguedBody));assert.ok(cataloguedInput.includes('may not reflect its latest edit'))
  assert.ok(cataloguedInput.includes('this is the explicitly quoted target, not the latest answer'))
  const beforeCardKitEdit = bWire.length
  assert.equal((await call(streamingAgent, 'messaging_edit', { target: streamQuote.messageRef, operation_id: 'cardkit-unsupported', text: 'no' })).value.error.code, 'unsupported_message_type')
  assert.equal(bWire.length, beforeCardKitEdit)
  await fiber.dispose()
  const missing = await ledger.claim({ appId: 'synthetic-app', messageId: 'missing-session-notice', chatId: 'card-chat', chatType: 'p2p', sessionId: 'synthetic-session-does-not-exist', sessionExisted: true })
  ledger.release(missing.record.key)
  const noticeStart = normalSends.length
  fiber = await ctx.plugin(plugin, config)
  const noticeDeadline = Date.now() + 10000
  while (ledger.get(missing.record.key).state !== 'rejected') { assert.ok(Date.now() < noticeDeadline); await tick() }
  const notice = normalSends[noticeStart]
  assert.ok(notice && notice.payload.msg_type === 'interactive')
  const noticeAgent = await post('quote-notice', 'card-chat', notice.item.message_id)
  assert.equal((await call(noticeAgent, 'messaging_context', { target: refs.get('quote-notice') })).value.quote.available, true)
  await fiber.dispose()
  // Batch B: real normal ingress -> host-issued refs -> real scoped Tools ->
  // provider/curl boundary, with synthetic endpoint responses only.
  config.adapters.lark.interactiveCard = false
  fiber = await ctx.plugin(plugin, config)
  const ba = await post('B-incoming','B-chat'), incomingRef = refs.get('B-incoming')
  const sentB = (await call(ba,'messaging_reply',{operation_id:'B-own',target:incomingRef,text:'synthetic own'})).value
  assert.equal(sentB.ok,true)
  const ownRef = sentB.messageRef
  assert.equal((await call(ba,'messaging_context',{target:ownRef})).value.message.botAuthored,true)
  assert.equal((await call(ba,'messaging_context',{target:ownRef})).value.message.type,'text')
  for (const name of names.slice(3)) {
    const def=ctx.tools.get(name,ba)
    assert.equal((await def.execute({}, {agent:ordinary})).error.code,'not_bound')
    assert.equal((await def.execute({}, {agent:child})).error.code,'not_bound')
  }
  const bStart=bWire.length
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-edit',target:ownRef,text:'replacement'})).value.ok,true)
  assert.equal(bWire.at(-1).method,'PUT');assert.equal(bWire.at(-1).payload.msg_type,'text')
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-edit',target:ownRef,text:'replacement'})).value.replayed,true)
  assert.equal(bWire.length,bStart+1)
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-not-own',target:incomingRef,text:'no'})).value.error.code,'not_owned')
  const ra=(await call(ba,'messaging_reaction_add',{operation_id:'B-react',target:incomingRef,emoji:'THUMBSUP'})).value
  assert.match(ra.reactionRef,/^reactionref_/)
  assert.equal((await call(ba,'messaging_reaction_remove',{operation_id:'B-remove',target:incomingRef,reaction_ref:ra.reactionRef})).value.ok,true)
  assert.equal(bWire.at(-1).method,'DELETE');assert.ok(bWire.at(-1).url.includes('/reactions/fixture-own-reaction'))
  assert.equal((await call(ba,'messaging_reactions',{target:incomingRef})).value.complete,true)
  const readB=(await call(ba,'messaging_read',{target:ownRef})).value
  assert.equal(readB.observedReaders,0);assert.equal(readB.unread,'unknown')
  const cross=await post('B-other','B-other-chat')
  for(const name of ['messaging_edit','messaging_recall','messaging_read','messaging_reactions']) {
    const input={target:ownRef,...(['messaging_edit','messaging_recall'].includes(name)?{operation_id:name}:{}),...(name==='messaging_edit'?{text:'no'}:{})}
    assert.equal((await call(cross,name,input)).value.error.code,'target_unverified')
  }
  bCode=99991672
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-denied',target:ownRef,text:'no'})).value.error.code,'permission_denied')
  bCode=0;bStatus=500
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-unknown',target:ownRef,text:'no'})).value.status,'unknown')
  bStatus=200;const afterUnknown=bWire.length
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-unknown',target:ownRef,text:'no'})).value.status,'unknown');assert.equal(bWire.length,afterUnknown)
  const sendEvent = async (type,id,event,token='synthetic-verification') => {
    const body={schema:'2.0',header:{event_type:type,event_id:id,app_id:'synthetic-app',token},event}
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={'content-type':'application/json'}
    let code;await routes.get('/messaging/lark/events')(req,{writeHead(n){code=n},end(){}});return code
  }
  const ownId='synthetic-sent-'+replies.length, eventAt=String(Date.now())
  const seqBefore=ba.session.seq, claimBefore=ledger.get(larkDedupKey('synthetic-app','B-incoming')).state
  const reader={reader:{reader_id:{open_id:'private-synthetic-reader'},read_time:eventAt},message_id_list:[ownId]}
  assert.equal(await sendEvent('im.message.message_read_v1','B-read',reader,'wrong-token'),401)
  assert.equal(await sendEvent('im.message.message_read_v1','B-read',reader),200)
  assert.equal(await sendEvent('im.message.message_read_v1','B-read',reader),200)
  const observedB=(await call(ba,'messaging_read_events',{target:ownRef})).value
  assert.equal(observedB.observedReaders,1);assert.equal(observedB.partial,true);assert.equal(observedB.unread,'unknown')
  const reactionEvent={message_id:ownId,operator_type:'user',user_id:{open_id:'private-synthetic-reactor'},reaction_type:{emoji_type:'SMILE'},action_time:eventAt}
  assert.equal(await sendEvent('im.message.reaction.created_v1','B-rc',reactionEvent),200)
  assert.equal((await call(ba,'messaging_read_events',{target:ownRef})).value.reactions.SMILE,1)
  assert.equal(await sendEvent('im.message.reaction.deleted_v1','B-rd',reactionEvent),200)
  assert.equal((await call(ba,'messaging_read_events',{target:ownRef})).value.reactions.SMILE,undefined)
  assert.equal(await sendEvent('im.message.recalled_v1','B-recalled',{message_id:ownId,chat_id:'B-chat',recall_time:eventAt}),200)
  const beforeInvalid=bWire.length
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-after-recall',target:ownRef,text:'no'})).value.error.code,'not_found_or_recalled')
  assert.equal(bWire.length,beforeInvalid);assert.equal(ba.session.seq,seqBefore,'new events never enqueue or trigger an agent turn')
  assert.equal(ledger.get(larkDedupKey('synthetic-app','B-incoming')).state,claimBefore)
  const ordinaryReply=(await call(ba,'messaging_reply',{operation_id:'B-recall-own',target:incomingRef,text:'own2'})).value
  assert.equal((await call(ba,'messaging_recall',{operation_id:'B-recall',target:ordinaryReply.messageRef})).value.ok,true)
  assert.equal(bWire.at(-1).method,'DELETE')
  // A real ordinary outgoing message carries own/type metadata, independently
  // of the explicit reply API. Its incoming quote yields the editable ref.
  await uiPost('/__dsh-messaging/send',{channel:'lark',conversation:'lark:B-chat',text:'ordinary bot answer'})
  const normalId=normalSends.at(-1).item.message_id
  await post('B-normal-quote','B-chat',normalId)
  const normalQuote=(await call(ba,'messaging_context',{target:refs.get('B-normal-quote')})).value.quote
  assert.equal(normalQuote.message.botAuthored,true);assert.equal(normalQuote.message.type,'text')
  assert.equal((await call(ba,'messaging_edit',{operation_id:'B-normal-edit',target:normalQuote.messageRef,text:'updated'})).value.ok,true)
  // Long-connection uses the real SDK dispatcher/parser, fake authenticated WS
  // transport only. Header/operator app_id collision is exercised explicitly.
  await fiber.dispose()
  const sdk=await import('@larksuiteoapi/node-sdk');let wsClosed=0
  const wsFrames=[], wsClients=[]
  class FakeWS extends sdk.WSClient {
    constructor(options){super(options);this.options=options;wsClients.push(this)}
    async start({eventDispatcher}){
      this.eventDispatcher=eventDispatcher;wsDispatcher=eventDispatcher
      this.wsConfig.setWSInstance({readyState:1,send(bytes,done){wsFrames.push(Buffer.from(bytes));done?.()},removeAllListeners(){},on(){},terminate(){},close(){}})
      this.options.onReady?.()
    }
    async close(){wsClosed++;super.close()}
  }
  ctx.provide('dshMessaging.larkSdk',{...sdk,WSClient:FakeWS})
  config.adapters.lark.mode='long-connection'
  fiber=await ctx.plugin(plugin,config)
  for(let i=0;!wsDispatcher&&i<80;i++)await tick()
  assert.ok(wsDispatcher)
  // Normal receive and new event types both traverse the real SDK parser.
  const wsAgent=await post('B-ws-input','B-ws-chat')
  const wsOwn=(await call(wsAgent,'messaging_reply',{operation_id:'B-ws-own',target:refs.get('B-ws-input'),text:'own'})).value
  const wsOwnId='synthetic-sent-'+replies.length
  const envelope={schema:'2.0',header:{event_type:'im.message.reaction.created_v1',event_id:'B-ws-react',app_id:'synthetic-app'},event:{message_id:wsOwnId,operator_type:'app',app_id:'other-operator-app',reaction_type:{emoji_type:'SMILE'},action_time:String(Date.now())}}
  await wsDispatcher.invoke(envelope)
  assert.equal((await call(wsAgent,'messaging_read_events',{target:wsOwn.messageRef})).value.reactions.SMILE,1)
  await wsDispatcher.invoke({...envelope,header:{...envelope.header,event_type:'im.message.reaction.deleted_v1',event_id:'B-ws-rd'}})
  assert.equal((await call(wsAgent,'messaging_read_events',{target:wsOwn.messageRef})).value.reactions.SMILE,undefined)
  const wsRead={schema:'2.0',header:{event_type:'im.message.message_read_v1',event_id:'B-ws-read',app_id:'synthetic-app'},event:{reader:{reader_id:{open_id:'private-ws-reader'},read_time:String(Date.now())},message_id_list:[wsOwnId]}}
  await wsDispatcher.invoke(wsRead);await wsDispatcher.invoke(wsRead)
  assert.equal((await call(wsAgent,'messaging_read_events',{target:wsOwn.messageRef})).value.observedReaders,1)
  const wsRecall={schema:'2.0',header:{event_type:'im.message.recalled_v1',event_id:'B-ws-recall',app_id:'synthetic-app'},event:{message_id:wsOwnId,chat_id:'B-ws-chat',recall_time:String(Date.now())}}
  await wsDispatcher.invoke(wsRecall)
  assert.equal((await call(wsAgent,'messaging_edit',{target:wsOwn.messageRef,operation_id:'recalled',text:'no'})).value.error.code,'not_found_or_recalled')
  const oldBDefinition=ctx.tools.get('messaging_edit',wsAgent)
  await fiber.dispose();assert.equal(wsClosed,1)
  await assert.rejects(wsDispatcher.invoke(wsRead),/interaction event unavailable/)
  assert.equal((await oldBDefinition.execute({target:wsOwn.messageRef,operation_id:'old',text:'no'},{agent:wsAgent})).error.code,'not_bound')
  // C: normal production-shaped trusted sender -> scoped card tools -> HTTP
  // callback -> real followup/projection/flush, never direct tool execution.
  config.adapters.lark.mode='webhook';config.adapters.lark.interactiveCard=false
  fiber=await ctx.plugin(plugin,config)
  const ca=await post('C-input','C-chat')
  const cardDto={title:'Synthetic C card',text:'Submit synthetic user data',fields:[{id:'answer',label:'Answer',type:'text',required:true,max_length:20,enum:['one','two']}],choices:[{id:'choose',label:'Choose'}]}
  const cPublished=(await call(ca,'messaging_card_publish',{operation_id:'C-publish',target:refs.get('C-input'),card:cardDto})).value
  assert.equal(cPublished.ok,true);assert.ok(cPublished.workflowRef);assert.ok(cPublished.messageRef)
  const cOther=await post('C-other','C-other-chat'),beforeCCross=replies.length
  assert.equal((await call(cOther,'messaging_card_publish',{operation_id:'C-cross',target:refs.get('C-input'),card:cardDto})).value.error.code,'target_unverified')
  assert.equal((await call(cOther,'messaging_card_update',{operation_id:'C-cross-update',workflow:cPublished.workflowRef,expected_version:1,card:cardDto})).value.error.code,'workflow_unverified')
  assert.equal(replies.length,beforeCCross)
  const cMessageId='synthetic-sent-'+replies.length,cWire=replies.at(-1),cCard=JSON.parse(cWire.payload.content)
  assert.equal(cWire.payload.msg_type,'interactive');assert.equal(cCard.schema,'2.0');assert.equal(cCard.config.update_multi,true)
  const cBody=(eventId,buttonName='submit',form={answer:'one'},card=cCard,message=cMessageId)=>{
    const button=buttonName==='cancel'?card.body.elements.find(e=>e.tag==='button'):card.body.elements.find(e=>e.tag==='form').elements.find(e=>e.name===buttonName)
    return {schema:'2.0',header:{event_type:'card.action.trigger',event_id:eventId,app_id:'synthetic-app',tenant_key:'synthetic-app-tenant',token:'synthetic-verification'},event:{token:'PRIVATE-CALLBACK-TOKEN',operator:{open_id:'synthetic-user',tenant_key:'synthetic-user-tenant'},context:{open_message_id:message,open_chat_id:'C-chat'},action:{tag:'button',name:button.name,value:button.behaviors[0].value,form_value:form}}}
  }
  const cHttp=async(body,extra={})=>{
    const text=typeof body==='string'?body:JSON.stringify(body),req=Readable.from([Buffer.from(text)])
    req.method=extra.method||'POST';req.headers={'content-type':'application/json',...extra.headers};let code,result,drop=extra.dropReply===true
    await routes.get('/messaging/lark/events')(req,{writeHead(n){code=n},end(v){if(drop){drop=false;throw new Error('synthetic response dropped')}try{result=JSON.parse(String(v||'{}'))}catch{result={text:String(v)}}}})
    return {code,result}
  }
  assert.equal((await cHttp(cBody('C-get'),{method:'GET'})).code,405)
  const wrongOwner=cBody('C-wrong-owner');wrongOwner.event.operator.open_id='foreign'
  assert.equal((await cHttp(wrongOwner)).result.toast.type,'error')
  let unblockFlush, cardFlushCalls=0
  const realFlush=ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush=async session=>{if(session===ca.session){cardFlushCalls++;if(cardFlushCalls===1){await new Promise(r=>unblockFlush=r);return false}if(cardFlushCalls===2)throw new Error('PRIVATE-FLUSH-ERROR')}return realFlush(session)}
  const cb=cBody('C-submit'),callbackStart=performance.now(),ack=await cHttp(cb)
  assert.equal(ack.code,200);assert.equal(ack.result.toast.type,'info');assert.ok(performance.now()-callbackStart<1000,'callback does not await admission/flush/LLM')
  for(let i=0;!unblockFlush&&i<80;i++)await tick();assert.ok(unblockFlush)
  const cInputs=()=>Array.from({length:ca.session.seq},(_,n)=>ca.session.eventAt(n)).filter(e=>e?.type==='agent/inbox/spliced').flatMap(e=>e.data.inserted||[]).filter(m=>JSON.stringify(m).includes('Messaging card input'))
  assert.equal(cInputs().length,1)
  const firstCardUmid=cInputs()[0].id
  assert.equal((await call(ca,'messaging_card_status',{workflow:cPublished.workflowRef})).value.phase,'accepted')
  await cHttp(cb);await cHttp({...cb,header:{...cb.header,event_id:'C-double'}});assert.equal(cInputs().length,1)
  unblockFlush();await tick();assert.equal((await call(ca,'messaging_card_status',{workflow:cPublished.workflowRef})).value.phase,'accepted','false flush is not delivered')
  let currentCard
  for(let i=0;i<180;i++){currentCard=(await call(ca,'messaging_card_status',{workflow:cPublished.workflowRef})).value;if(currentCard.phase==='input_admitted')break;await tick()}
  assert.equal(currentCard.phase,'input_admitted');assert.ok(cardFlushCalls>=3);assert.equal(cInputs().length,1);assert.equal(cInputs()[0].id,firstCardUmid,'projection-hit retries only flush, never another followup')
  ctx.sessions.flush=realFlush
  const freshCard=(await call(ca,'messaging_card_publish',{operation_id:'C-updateable',target:refs.get('C-input'),card:cardDto})).value
  const oldCard=JSON.parse(replies.at(-1).payload.content),freshMessage='synthetic-sent-'+replies.length
  const updatedCard=(await call(ca,'messaging_card_update',{operation_id:'C-update',workflow:freshCard.workflowRef,expected_version:1,card:{...cardDto,text:'Updated finite card'}})).value
  assert.equal(updatedCard.ok,true);assert.equal(updatedCard.version,2);assert.equal(bWire.at(-1).method,'PATCH')
  assert.equal((await cHttp(cBody('C-old-version','submit',{answer:'one'},oldCard,freshMessage))).result.toast.type,'error')
  const updatedJson=JSON.parse(bWire.at(-1).payload.content)
  assert.match((await cHttp(cBody('C-cancel','cancel',{},updatedJson,freshMessage))).result.toast.content,/已取消/)
  assert.equal((await call(ca,'messaging_card_status',{workflow:freshCard.workflowRef})).value.phase,'cancelled')
  // Durable takeover failure: a synthetic unsafe sidecar path is rejected before
  // ACK/queue, then restored. No raw path/token is returned or diagnosed.
  const failingCard=(await call(ca,'messaging_card_publish',{operation_id:'C-failure',target:refs.get('C-input'),card:cardDto})).value
  const failureCardJson=JSON.parse(replies.at(-1).payload.content),failureMessage='synthetic-sent-'+replies.length
  const cardRoot=path.join(home,'messaging-interactions-cards-v1'),day= (await fs.readdir(cardRoot)).find(x=>/^\d{8}$/.test(x)),sidecar=path.join(cardRoot,day,'workflows.jsonl')
  const beforeFailureInputs=cInputs().length
  await fs.rename(sidecar,sidecar+'.protected');await fs.symlink(sidecar+'.protected',sidecar)
  const failedCallback=await cHttp(cBody('C-durable-failure','submit',{answer:'one'},failureCardJson,failureMessage))
  assert.equal(failedCallback.code,503);assert.equal(failedCallback.result.toast.type,'error');assert.equal(cInputs().length,beforeFailureInputs)
  await fs.unlink(sidecar);await fs.rename(sidecar+'.protected',sidecar)
  assert.equal((await call(ca,'messaging_card_status',{workflow:failingCard.workflowRef})).value.phase,'active')
  const restoredCallback=await cHttp(cBody('C-durable-failure','submit',{answer:'one'},failureCardJson,failureMessage));assert.equal(restoredCallback.result.toast.type,'info')
  for(let i=0;cInputs().length<beforeFailureInputs+1&&i<80;i++)await tick()
  assert.equal(cInputs().length,beforeFailureInputs+1,'failed durable takeover left no successful replay that could suppress an explicit retry')
  const lostReply=(await call(ca,'messaging_card_publish',{operation_id:'C-lost-reply',target:refs.get('C-input'),card:cardDto})).value
  const lostJson=JSON.parse(replies.at(-1).payload.content),lostMessage='synthetic-sent-'+replies.length,lostBody=cBody('C-lost-response','submit',{answer:'one'},lostJson,lostMessage),beforeLostInputs=cInputs().length
  assert.equal((await cHttp(lostBody,{dropReply:true})).code,500)
  assert.equal((await cHttp(lostBody)).result.toast.type,'info')
  for(let i=0;cInputs().length<beforeLostInputs+1&&i<80;i++)await tick()
  assert.equal(cInputs().length,beforeLostInputs+1,'lost HTTP response and explicit replay admit only one stable input')
  assert.ok(lostReply.ok)
  const cStatusReq=Readable.from([]);cStatusReq.method='GET';cStatusReq.headers={host:'127.0.0.1:5173'};let cSafe=''
  await routes.get('/__dsh-messaging/status')(cStatusReq,{writeHead(){},end(v){cSafe=String(v)}})
  assert.ok(!cSafe.includes('PRIVATE-CALLBACK-TOKEN'));assert.ok(!cSafe.includes('PRIVATE-FLUSH-ERROR'))
  // Encrypted HTTP uses the existing real companion verify/decrypt on synthetic
  // bytes; callback response and signed replay must remain legal toast bodies.
  await fiber.dispose();config.adapters.lark.encryptKey='synthetic-encryption-key';fiber=await ctx.plugin(plugin,config)
  const encryptBody=body=>{const iv=randomBytes(16),key=createHash('sha256').update(config.adapters.lark.encryptKey).digest(),cipher=createCipheriv('aes-256-cbc',key,iv)
    return JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(JSON.stringify(body)),cipher.final()]).toString('base64')})}
  const encHeaders=raw=>{const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomBytes(8).toString('hex');return {'x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,'x-lark-signature':createHash('sha256').update(timestamp+nonce+config.adapters.lark.encryptKey+raw).digest('hex')}}
  const encryptedOld=encryptBody(cb),signed=encHeaders(encryptedOld)
  const oldResponse=await cHttp(encryptedOld,{headers:signed});assert.equal(oldResponse.code,200);assert.equal(oldResponse.result.toast.type,'error','old generation workflow cannot reenter')
  const repeatedResponse=await cHttp(encryptedOld,{headers:signed});assert.equal(repeatedResponse.code,200);assert.ok(repeatedResponse.result.toast,'encrypted replay never falls back to ordinary ok ACK')
  const badSignature=await cHttp(encryptedOld,{headers:{...signed,'x-lark-signature':'bad'}});assert.equal(badSignature.code,401)
  await fiber.dispose();config.adapters.lark.encryptKey='';config.adapters.lark.mode='long-connection';fiber=await ctx.plugin(plugin,config)
  const cws=await post('C-ws-input','C-chat')
  const wsCardResult=(await call(cws,'messaging_card_publish',{operation_id:'C-ws-publish',target:refs.get('C-ws-input'),card:cardDto})).value
  assert.equal(wsCardResult.ok,true)
  const wsCard=JSON.parse(replies.at(-1).payload.content),wsCardMessage='synthetic-sent-'+replies.length,frameEvent=cBody('C-frame','submit',{answer:'one'},wsCard,wsCardMessage)
  const ws=wsClients.at(-1),framesBefore=wsFrames.length
  const frame={SeqID:123,LogID:456,service:1,method:1,headers:[{key:'type',value:'event'},{key:'message_id',value:'synthetic-frame'},{key:'sum',value:'1'},{key:'seq',value:'0'}],payload:Buffer.from(JSON.stringify(frameEvent))}
  await ws.handleEventData(frame)
  assert.equal(wsFrames.length,framesBefore+1,'real SDK handleEventData -> sendMessage -> protobuf Frame.encode')
  const frameReader=protobuf.Reader.create(wsFrames.at(-1));let framePayload
  while(frameReader.pos<frameReader.len){const tag=frameReader.uint32();if((tag>>>3)===8)framePayload=frameReader.bytes();else frameReader.skipType(tag&7)}
  const responseFrame=JSON.parse(Buffer.from(framePayload).toString('utf8'));assert.equal(responseFrame.code,200)
  const responseToast=JSON.parse(Buffer.from(responseFrame.data,'base64').toString('utf8'));assert.equal(responseToast.toast.type,'info')
  await ws.handleEventData({...frame,headers:frame.headers.map(h=>h.key==='type'?{...h,value:'card'}:h)})
  assert.equal(wsFrames.length,framesBefore+1,'old card frame type is unsupported, not silently treated as modern event')
  await fiber.dispose()
  const afterCloseFrames=wsFrames.length;await ws.handleEventData({...frame,headers:frame.headers.map(h=>h.key==='message_id'?{...h,value:'late-frame'}:h)})
  assert.equal(wsFrames.length,afterCloseFrames,'closed old SDK transport has no writable socket')
  // Regression: an old bot answer survives in Feishu but not in the new
  // process catalogue. Recent assistant history is a DIFFERENT topic.
  config.adapters.lark.mode='webhook';config.adapters.lark.interactiveCard=false
  fiber=await ctx.plugin(plugin,config)
  const qOrigin=await post('qfix-origin','qfix-chat')
  const oldReply=(await call(qOrigin,'messaging_reply',{operation_id:'qfix-old',target:refs.get('qfix-origin'),text:'EARLIER_QUOTED_TOPIC: two synthetic paths'})).value
  assert.equal(oldReply.ok,true)
  const oldId='synthetic-sent-'+replies.length
  const oldItem={message_id:oldId,chat_id:'qfix-chat',create_time:String(Date.now()),msg_type:'text',body:{content:JSON.stringify({text:'EARLIER_QUOTED_TOPIC: two synthetic paths'})}}
  messages.set(oldId,oldItem)
  const qSendStart=normalSends.length
  modelText='RECENT_OTHER_TOPIC: five different synthetic paths';modelOutput=true
  await post('qfix-recent','qfix-chat')
  for(let i=0;normalSends.length===qSendStart&&i<160;i++)await tick()
  assert.ok(normalSends.length>qSendStart);await new Promise(r=>setTimeout(r,600));modelOutput=false
  await fiber.dispose();fiber=await ctx.plugin(plugin,config)
  const qReads=reads.length
  const qAgent=await post('qfix-question','qfix-chat',oldId)
  for(let i=0;!modelRequests.some(ms=>JSON.stringify(ms).includes('synthetic qfix-question'))&&i<80;i++)await tick()
  const qRequest=modelRequests.filter(ms=>JSON.stringify(ms).includes('synthetic qfix-question')).at(-1)
  assert.ok(qRequest,'actual normal model request observed')
  const qUser=qRequest.filter(m=>m.role==='user').at(-1)
  assert.ok(JSON.stringify(qUser).includes('EARLIER_QUOTED_TOPIC'),'last USER input contains the actual older quoted body')
  assert.ok(JSON.stringify(qRequest).includes('RECENT_OTHER_TOPIC'),'different latest answer remains history, not substituted')
  assert.ok(reads.slice(qReads).includes(oldId),'historical parent reached verified same-chat GET after catalogue reset')
  const qRow=ledger.get(larkDedupKey('synthetic-app','qfix-question'))
  const qAdmissions=()=>Array.from({length:qAgent.session.seq},(_,i)=>qAgent.session.eventAt(i)).filter(e=>e?.type==='agent/inbox/spliced').flatMap(e=>e.data.inserted||[]).filter(m=>m.id===qRow.userMessageId)
  assert.equal(qAdmissions().length,1);await post('qfix-question','qfix-chat',oldId);assert.equal(qAdmissions().length,1)
  const typedRequestStart=modelRequests.length
  await post('qfix-typed','qfix-chat',oldId,true)
  for(let i=0;modelRequests.length===typedRequestStart&&i<80;i++)await tick()
  const typedUser=JSON.stringify(modelRequests.at(-1).filter(m=>m.role==='user').at(-1))
  assert.ok(typedUser.includes('EARLIER_QUOTED_TOPIC'));assert.ok(typedUser.includes('image'))
  for(const [id,content,readable] of [
    ['qfix-static',{elements:[{tag:'div',text:{tag:'lark_md',content:'OLDER_STATIC_CARD_BODY'}}]},true],
    ['qfix-default-card',{title:'Official default card response',elements:[[{tag:'text',text:'OLDER_DEFAULT_CARD_BODY'}]]},true],
    ['qfix-stream',{schema:'2.0',body:{elements:[{tag:'markdown',content:'OLDER_STREAM_EMBEDDED_BODY'}]}},true],
    ['qfix-card-ref',{type:'card',data:{card_id:'PRIVATE-OPAQUE-CARD'}},false],
  ]){
    messages.set(id,{...oldItem,message_id:id,msg_type:'interactive',body:{content:JSON.stringify(content)}})
    await post('ask-'+id,'qfix-chat',id)
    for(let i=0;!modelRequests.some(ms=>JSON.stringify(ms).includes('synthetic ask-'+id))&&i<80;i++)await tick()
    const request=modelRequests.filter(ms=>JSON.stringify(ms).includes('synthetic ask-'+id)).at(-1)
    const input=JSON.stringify(request.filter(m=>m.role==='user').at(-1))
    assert.equal(input.includes('OLDER_'),readable)
    if(!readable){assert.ok(input.includes('Do not substitute the latest answer'));assert.ok(!input.includes('PRIVATE-OPAQUE-CARD'))}
  }
  // Exact live symptom across topics: the default projection contains only
  // an upgrade notice, while the original CardKit JSON has the old answer.
  const compatibilityNotice={title:null,elements:[[{tag:'img',image_key:'IMGKEY_MARKER'},{tag:'text',text:'请升级至最新版本客户端，以查看内容'},{tag:'text',text:''}]]}
  const e1Body='FINAL_MARKER '+'答'.repeat(3148) // 3161 code points; E1 field shape, synthetic content
  const e1Card={schema:'2.0',config:{streaming_mode:false,summary:{content:'SUMMARY_MARKER'},streaming_config:{print_frequency_ms:{default:70}}},body:{elements:[{tag:'markdown',element_id:'dsh_streaming_text',content:e1Body}]}}
  messages.set('qfix-live-card',{...oldItem,message_id:'qfix-live-card',msg_type:'interactive',updated:true,body:{content:JSON.stringify(compatibilityNotice)},originalCard:e1Card})
  await fiber.dispose();fiber=await ctx.plugin(plugin,config)
  const liveAgent=await post('qfix-live-question','qfix-chat','qfix-live-card')
  for(let i=0;!modelRequests.some(ms=>JSON.stringify(ms).includes('synthetic qfix-live-question'))&&i<80;i++)await tick()
  const liveRequest=modelRequests.filter(ms=>JSON.stringify(ms).includes('synthetic qfix-live-question')).at(-1)
  const liveInput=JSON.stringify(liveRequest.filter(m=>m.role==='user').at(-1))
  assert.ok(liveInput.includes(e1Body),'entire E1-shaped body reaches actual rc.5 model request')
  assert.ok(liveInput.includes('may not reflect its latest edit'));assert.ok(liveInput.includes('this is the explicitly quoted target, not the latest answer'))
  assert.ok(!liveInput.includes('SUMMARY_MARKER'));assert.ok(!liveInput.includes('dsh_streaming_text'))
  const liveContext=(await call(liveAgent,'messaging_context',{target:refs.get('qfix-live-question')})).value.quote
  assert.equal(liveContext.text,e1Body);assert.equal(liveContext.freshness,'unverified');assert.equal(liveContext.truncated,false)
  assert.ok(!liveInput.includes('请升级至'));assert.ok(JSON.stringify(liveRequest).includes('RECENT_OTHER_TOPIC'))
  const liveRow=ledger.get(larkDedupKey('synthetic-app','qfix-live-question'))
  const liveAdmissions=()=>Array.from({length:liveAgent.session.seq},(_,i)=>liveAgent.session.eventAt(i)).filter(e=>e?.type==='agent/inbox/spliced').flatMap(e=>e.data.inserted||[]).filter(m=>m.id===liveRow.userMessageId)
  await post('qfix-live-question','qfix-chat','qfix-live-card');assert.equal(liveAdmissions().length,1)
  // All R3 negative conditions also cross real ingress -> normal model input.
  for(const [id,kind,updated,card,readable] of [
    ['qfix-notice','interactive',true,compatibilityNotice,false],
    ['qfix-notice-title','interactive',true,{...compatibilityNotice,title:'ONLY_TITLE'},false],
    ['qfix-notice-space','interactive',true,{elements:[[{tag:'text',text:'请升级至最新版本客户端，以查看内容'},{tag:'text',text:'　 '}]]},false],
    ['qfix-streaming','interactive',true,{...e1Card,config:{streaming_mode:true}},false],
    ['qfix-ellipsis','interactive',true,{...e1Card,body:{elements:[{tag:'markdown',content:'…'}]}},false],
    ['qfix-unchanged','interactive',false,e1Card,true],
    ['qfix-updated-text','text',true,{text:'UNCHANGED_TEXT_TYPE_BODY'},true],
  ]){
    messages.set(id,{...oldItem,message_id:id,msg_type:kind,updated,body:{content:JSON.stringify(card)}})
    const agent=await post('ask-'+id,'qfix-chat',id)
    for(let i=0;!modelRequests.some(ms=>JSON.stringify(ms).includes('synthetic ask-'+id))&&i<80;i++)await tick()
    const user=modelRequests.filter(ms=>JSON.stringify(ms).includes('synthetic ask-'+id)).at(-1).filter(m=>m.role==='user').at(-1)
    const input=typeof user.content==='string'?user.content:user.content.map(b=>b.text||'').join('\n')
    const quote=(await call(agent,'messaging_context',{target:refs.get('ask-'+id)})).value.quote
    assert.equal(quote.available,readable,id);assert.equal(Object.hasOwn(quote,'freshness'),false,id)
    assert.ok(!input.includes('may not reflect its latest edit'),id)
    if(!readable){assert.ok(input.includes('"available":false'));assert.ok(input.includes('Do not substitute the latest answer'));assert.ok(!input.includes('请升级至'));assert.ok(!input.includes(e1Body));assert.ok(!input.includes('ONLY_TITLE'))}
  }

  await fiber.dispose()
  const coldId='qfix-cold-input'
  messages.set(coldId,{...oldItem,message_id:coldId,parent_id:oldId,body:{content:JSON.stringify({text:'qfix recovered question'})}})
  const coldClaim=await ledger.claim({appId:'synthetic-app',messageId:coldId,chatId:'qfix-chat',chatType:'p2p',sessionId:sessionIdForKey('lark:qfix-chat'),sessionExisted:true})
  ledger.release(coldClaim.record.key)
  fiber=await ctx.plugin(plugin,config)
  const coldLimit=Date.now()+12000
  while(!modelRequests.some(ms=>JSON.stringify(ms).includes('qfix recovered question'))){assert.ok(Date.now()<coldLimit);await tick()}
  const coldRequest=modelRequests.filter(ms=>JSON.stringify(ms).includes('qfix recovered question')).at(-1)
  assert.ok(JSON.stringify(coldRequest.filter(m=>m.role==='user').at(-1)).includes('EARLIER_QUOTED_TOPIC'))
  const coldAgent=ctx.agents.get(sessionIdForKey('lark:qfix-chat'))
  assert.equal(Array.from({length:coldAgent.session.seq},(_,i)=>coldAgent.session.eventAt(i)).filter(e=>e?.type==='agent/inbox/spliced').flatMap(e=>e.data.inserted||[]).filter(m=>m.id===coldClaim.record.userMessageId).length,1)
  await fiber.dispose()
  console.log('messaging-interactions-host: ok | real plugin ingress/Agent/Tools/native+PTC/DeepSeek serializer; fresh/recovery/typed/admitted refs, exact default targets, ordinary text/static/stream/notice quotes, wrong-chat recovery, render/redaction, reply/replay/unknown, B edits/recall/reactions/read aggregation and durable webhook+real-SDK WS events, native+PTC isolation/replacement; C workflow/real admission+flush/modern HTTP encrypted replay and real SDK protobuf frame response; fake network/model')
} finally {
  globalThis.fetch = restoreFetch
  axios.defaults.adapter = oldAxiosAdapter
  await ctx.fiber.dispose()
  if (ledger) await ledger.close()
  await fs.rm(home, { recursive: true, force: true })
}
