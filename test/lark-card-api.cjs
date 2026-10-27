require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

async function load() {
  return import(pathToFileURL(path.join(root, 'lib', 'lark-card-api.js')).href)
}

function makeHttpRequest(calls) {
  return async (method, url, headers, body) => {
    calls.push({ method, url, headers, body })
    return {
      ok: true,
      status: 200,
      json: { code: 0, msg: 'ok', data: { card_id: 'card_123', message_id: 'msg_456' } },
      stderr: '',
      text: '',
    }
  }
}

function makeFailingHttpRequest() {
  return async () => ({
    ok: true,
    status: 200,
    json: { code: 0, msg: 'ok', data: {} },
    stderr: '',
    text: '',
  })
}

// create 成功、引用发送缺 message_id（HTTP200 + code0 + data 无 message_id）
function makeCreateOkSendMissingMessageId(calls) {
  let n = 0
  return async (method, url, headers, body) => {
    calls.push({ method, url, headers, body })
    n += 1
    if (n === 1) {
      return { ok: true, status: 200, json: { code: 0, msg: 'ok', data: { card_id: 'card_123' } }, stderr: '', text: '' }
    }
    return { ok: true, status: 200, json: { code: 0, msg: 'ok', data: {} }, stderr: '', text: '' }
  }
}

// create 成功、引用发送 HTTP 失败
function makeCreateOkSendHttpFailure(calls) {
  let n = 0
  return async (method, url, headers, body) => {
    calls.push({ method, url, headers, body })
    n += 1
    if (n === 1) {
      return { ok: true, status: 200, json: { code: 0, msg: 'ok', data: { card_id: 'card_123' } }, stderr: '', text: '' }
    }
    return { ok: false, status: 500, json: null, stderr: '', text: '' }
  }
}

// create 缺 card_id（HTTP200 + code0 + data 无 card_id）
function makeCreateMissingCardId(calls) {
  return async (method, url, headers, body) => {
    calls.push({ method, url, headers, body })
    return { ok: true, status: 200, json: { code: 0, msg: 'ok', data: {} }, stderr: '', text: '' }
  }
}

// create 成功、引用 send 直接抛异常（如超时 ETIMEDOUT）
function makeCreateOkSendThrows(calls) {
  let n = 0
  return async (method, url, headers, body) => {
    calls.push({ method, url, headers, body })
    n += 1
    if (n === 1) {
      return { ok: true, status: 200, json: { code: 0, msg: 'ok', data: { card_id: 'card_probe' } }, stderr: '', text: '' }
    }
    const err = new Error('review simulated timeout')
    err.code = 'ETIMEDOUT'
    throw err
  }
}

// create 阶段就抛异常（超时，创建结果未知）
function makeCreateThrows(calls) {
  return async (method, url, headers, body) => {
    calls.push({ method, url, headers, body })
    const err = new Error('create simulated timeout')
    err.code = 'ETIMEDOUT'
    throw err
  }
}

// create HTTP 失败（ok:false / 500）
function makeCreateHttpFailure(calls) {
  return async (method, url, headers, body) => {
    calls.push({ method, url, headers, body })
    return { ok: false, status: 500, json: null, stderr: '', text: '' }
  }
}

;(async () => {
  const api = await load()

  // 1. createCardInstance 使用正确 method/body
  {
    const calls = []
    const cardSpec = { schema: '2.0', body: { elements: [] } }
    const result = await api.createCardInstance({
      cardSpec,
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(result.cardId, 'card_123')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/cardkit/v1/cards')
    assert.equal(calls[0].headers.Authorization, 'Bearer tk')
    // 模块只设置 Authorization；对象 payload 与 Content-Type 归引擎 JSON wrapper
    assert.deepEqual(calls[0].headers, { Authorization: 'Bearer tk' })
    // 精确 body shape：不双包 data 层
    assert.deepEqual(calls[0].body, { type: 'card_json', data: JSON.stringify(cardSpec) })
  }

  // 2. createCardInstance 缺 card_id 时返回 ok:false
  {
    const result = await api.createCardInstance({
      cardSpec: {},
      accessToken: 'tk',
      httpRequest: makeFailingHttpRequest(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.cardId, null)
    assert.ok(result.error.includes('card_id'))
  }

  // 3. sendCardByReference 使用正确 method/body
  {
    const calls = []
    const result = await api.sendCardByReference({
      conversation: 'lark:oc_abc',
      cardId: 'card_123',
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(result.messageId, 'msg_456')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
    // 精确 body shape
    assert.deepEqual(calls[0].body, {
      receive_id: 'oc_abc',
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: 'card_123' } }),
    })
  }

  // 4. sendInteractiveCardDirect 直接发送完整卡片
  {
    const calls = []
    const cardSpec = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'hi' }] } }
    const result = await api.sendInteractiveCardDirect({
      conversation: 'lark:oc_xyz',
      cardSpec,
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(result.messageId, 'msg_456')
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
    assert.equal(calls[0].body.msg_type, 'interactive')
    assert.equal(calls[0].body.receive_id, 'oc_xyz')
    const content = JSON.parse(calls[0].body.content)
    assert.deepEqual(content, cardSpec)
  }

  // 5. patchInteractiveCardDirect 使用 PATCH /im/v1/messages/:message_id
  {
    const calls = []
    const cardSpec = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'updated' }] } }
    const result = await api.patchInteractiveCardDirect({
      messageId: 'msg_456',
      cardSpec,
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0].method, 'PATCH')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/im/v1/messages/msg_456')
    assert.equal(calls[0].body.content, JSON.stringify(cardSpec))
  }

  // 6. updateCardElementContent 使用 PUT /cardkit/v1/cards/:card_id/elements/:element_id/content
  {
    const calls = []
    const result = await api.updateCardElementContent({
      cardId: 'card_123',
      elementId: 'elem_789',
      content: 'new text',
      sequence: 5,
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0].method, 'PUT')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/cardkit/v1/cards/card_123/elements/elem_789/content')
    assert.equal(calls[0].body.content, 'new text')
    assert.equal(calls[0].body.sequence, 5)
    assert.equal(calls[0].body.uuid, 'c_card_123_5')
    assert.ok(!('data' in calls[0].body), 'body must not be wrapped in data')
  }

  // 7. finishStreamingCard 使用 PATCH /cardkit/v1/cards/:card_id/settings
  {
    const calls = []
    const result = await api.finishStreamingCard({
      cardId: 'card_123',
      sequence: 9,
      summary: 'done',
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0].method, 'PATCH')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/cardkit/v1/cards/card_123/settings')
    const settings = JSON.parse(calls[0].body.settings)
    assert.equal(settings.config.streaming_mode, false)
    assert.deepEqual(settings.config.summary, { content: 'done' })
    assert.equal(calls[0].body.sequence, 9)
    assert.equal(calls[0].body.uuid, 's_card_123_9')
    assert.ok(!('data' in calls[0].body), 'body must not be wrapped in data')
  }

  // 8. sendInteractiveText 发送 static text card
  {
    const calls = []
    const result = await api.sendInteractiveText({
      conversation: 'lark:oc_txt',
      text: 'hello',
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0].body.msg_type, 'interactive')
    const content = JSON.parse(calls[0].body.content)
    assert.equal(content.schema, '2.0')
    assert.equal(content.body.elements[0].content, 'hello')
  }

  // 9. sendStreamingCard 组合 create + send
  {
    const calls = []
    const result = await api.sendStreamingCard({
      conversation: 'lark:oc_stream',
      text: 'streaming text',
      accessToken: 'tk',
      httpRequest: makeHttpRequest(calls),
    })
    assert.equal(result.ok, true)
    assert.equal(result.cardId, 'card_123')
    assert.equal(result.messageId, 'msg_456')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/cardkit/v1/cards')
    assert.equal(calls[1].method, 'POST')
    assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
  }

  // 10. API 错误传播
  {
    const httpRequest = async () => ({
      ok: true,
      status: 200,
      json: { code: 999, msg: 'bad request', data: {} },
      stderr: '',
      text: '',
    })
    const result = await api.sendInteractiveCardDirect({ conversation: 'lark:x', cardSpec: {}, accessToken: 'tk', httpRequest })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'bad request')
  }

  // 11. sendStreamingCard：create 缺 card_id → send 不发起、cardId 为 null、不重开
  {
    const calls = []
    const result = await api.sendStreamingCard({
      conversation: 'lark:oc_nocreate',
      text: 't',
      accessToken: 'tk',
      httpRequest: makeCreateMissingCardId(calls),
    })
    assert.equal(result.ok, false)
    assert.equal(result.cardId, null)
    assert.ok(result.error.includes('card_id'))
    assert.equal(calls.length, 1, 'send must not be attempted when create fails')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/cardkit/v1/cards')
  }

  // 12. sendStreamingCard：create 成功、send 缺 message_id → 保留 cardId + error
  //     供引擎幂等关闭，不盲重发第二张卡
  {
    const calls = []
    const result = await api.sendStreamingCard({
      conversation: 'lark:oc_nomsg',
      text: 't',
      accessToken: 'tk',
      httpRequest: makeCreateOkSendMissingMessageId(calls),
    })
    assert.equal(result.ok, false)
    assert.equal(result.cardId, 'card_123', 'created cardId must be retained for idempotent close')
    assert.equal(result.messageId, null)
    assert.ok(result.error.includes('message_id'))
    assert.equal(calls.length, 2, 'must not blind-resend a second card')
    assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
  }

  // 13. sendStreamingCard：create 成功、send HTTP 失败 → 实际返回 shape
  {
    const calls = []
    const result = await api.sendStreamingCard({
      conversation: 'lark:oc_httpfail',
      text: 't',
      accessToken: 'tk',
      httpRequest: makeCreateOkSendHttpFailure(calls),
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'HTTP 500')
    assert.equal(result.cardId, 'card_123', 'created cardId must survive send HTTP failure')
    assert.equal(result.messageId, null)
    assert.equal(result.raw.status, 500)
    assert.equal(calls.length, 2, 'must not blind-resend after send failure')
  }

  // 14. sendCardByReference 缺 message_id（单元 shape）
  {
    const result = await api.sendCardByReference({
      conversation: 'lark:oc_x',
      cardId: 'card_123',
      accessToken: 'tk',
      httpRequest: makeFailingHttpRequest(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.messageId, null)
    assert.ok(result.error.includes('message_id'))
  }

  // 15. sendInteractiveCardDirect 缺 message_id（静态卡单元 shape）
  {
    const result = await api.sendInteractiveCardDirect({
      conversation: 'lark:oc_x',
      cardSpec: { schema: '2.0', body: { elements: [] } },
      accessToken: 'tk',
      httpRequest: makeFailingHttpRequest(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.messageId, null)
    assert.ok(result.error.includes('message_id'))
  }

  // 16. P1 回归：create 成功、send 抛 ETIMEDOUT → 结构化失败保留 cardId/原因/投递未知，calls 恰 2
  {
    const calls = []
    const result = await api.sendStreamingCard({
      conversation: 'lark:oc_throw',
      text: 't',
      accessToken: 'tk',
      httpRequest: makeCreateOkSendThrows(calls),
    })
    assert.equal(result.ok, false)
    assert.equal(result.cardId, 'card_probe', 'created cardId must survive a thrown send so the engine can close the card')
    assert.equal(result.messageId, null)
    assert.equal(result.thrown, true)
    assert.equal(result.deliveryUnknown, true, 'timeout rejection may still have delivered; status is unknown')
    assert.equal(result.error, 'review simulated timeout', 'original reason must be preserved')
    assert.equal(result.code, 'ETIMEDOUT', 'original error code must be preserved')
    assert.ok(result.cause instanceof Error && result.cause.code === 'ETIMEDOUT')
    assert.equal(result.status, null)
    assert.equal(calls.length, 2, 'exactly create + one send attempt; no blind resend')
    assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/cardkit/v1/cards')
    assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
  }

  // 17. create 抛异常 → 结构化返回（创建结果未知，cardId:null），calls 恰 1，不透传裸 rejection
  {
    const calls = []
    const result = await api.sendStreamingCard({
      conversation: 'lark:oc_create_throw',
      text: 't',
      accessToken: 'tk',
      httpRequest: makeCreateThrows(calls),
    })
    assert.equal(result.ok, false)
    assert.equal(result.cardId, null, 'creation result unknown: identity not available')
    assert.equal(result.thrown, true)
    assert.equal(result.deliveryUnknown, true)
    assert.equal(result.error, 'create simulated timeout')
    assert.equal(result.code, 'ETIMEDOUT')
    assert.equal(calls.length, 1, 'no send attempt after create failure')
  }

  // 18. create HTTP 失败 → 不发起 send，结构化失败
  {
    const calls = []
    const result = await api.sendStreamingCard({
      conversation: 'lark:oc_create_http',
      text: 't',
      accessToken: 'tk',
      httpRequest: makeCreateHttpFailure(calls),
    })
    assert.equal(result.ok, false)
    assert.equal(result.cardId, null)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'HTTP 500')
    assert.equal(calls.length, 1, 'send must not be attempted after create HTTP failure')
  }

  console.log('lark-card-api ok')
})().catch((err) => { console.error(err); process.exit(1) })
