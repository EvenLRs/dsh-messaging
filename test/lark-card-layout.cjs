require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

async function load() {
  return import(pathToFileURL(path.join(root, 'lib', 'lark-card-layout.js')).href)
}

;(async () => {
  const {
    STREAMING_ELEMENT_ID,
    createStreamingCard,
    createStaticCard,
    createTextSegmentCard,
    createErrorCard,
    createCardReferencePayload,
    createStreamingSettingsPayload,
  } = await load()

  // 0. element_id 必须满足官方组件 ID 语法：字母/数字/下划线、以字母开头、≤20 字符
  assert.equal(STREAMING_ELEMENT_ID, 'dsh_streaming_text')
  assert.match(STREAMING_ELEMENT_ID, /^[A-Za-z][A-Za-z0-9_]*$/, 'element_id must be letters/digits/underscore starting with a letter')
  assert.ok(STREAMING_ELEMENT_ID.length <= 20, 'element_id must be at most 20 characters')

  // 1. 流式卡片必须满足 CardKit 2.0 契约
  const streaming = createStreamingCard('hello', { hint: 'typing…' })
  assert.equal(streaming.schema, '2.0', 'streaming card must declare schema 2.0')
  assert.equal(streaming.config.streaming_mode, true, 'streaming_mode must be true')
  assert.equal(streaming.config.update_multi, true, 'update_multi must be true')
  assert.ok(streaming.config.summary, 'streaming card must have summary')
  assert.ok(streaming.config.streaming_config, 'streaming card must have streaming_config')
  assert.equal(streaming.body.elements.length, 1)
  assert.equal(streaming.body.elements[0].tag, 'markdown')
  assert.equal(streaming.body.elements[0].element_id, 'dsh_streaming_text')
  assert.match(streaming.body.elements[0].element_id, /^[A-Za-z][A-Za-z0-9_]*$/, 'card element_id must satisfy official syntax')
  assert.ok(streaming.body.elements[0].element_id.length <= 20, 'card element_id must be at most 20 characters')
  assert.equal(streaming.body.elements[0].content, 'hello')

  // 2. 静态文本卡片
  const staticCard = createStaticCard('static text')
  assert.equal(staticCard.schema, '2.0')
  assert.equal(staticCard.config.update_multi, true)
  assert.equal(staticCard.body.elements[0].tag, 'markdown')
  assert.equal(staticCard.body.elements[0].content, 'static text')
  assert.ok(!staticCard.body.elements[0].element_id, 'static card element needs no element_id')

  // 3. 文本段卡片与静态卡片等价
  const segment = createTextSegmentCard('segment text')
  assert.equal(segment.schema, '2.0')
  assert.equal(segment.body.elements[0].content, 'segment text')

  // 4. 错误卡片
  const errorCard = createErrorCard(new Error('boom'), { title: '错误' })
  assert.equal(errorCard.header.title.content, '错误')
  assert.ok(errorCard.body.elements[0].content.includes('boom'))

  // 5. CardKit 引用 payload
  const ref = createCardReferencePayload('card_123')
  assert.deepEqual(ref, { type: 'card', data: { card_id: 'card_123' } })

  // 6. 流式关闭 settings payload
  const settings = createStreamingSettingsPayload('final summary')
  assert.equal(settings.config.streaming_mode, false)
  assert.deepEqual(settings.config.summary, { content: 'final summary' })

  // 7. streaming_mode 不在顶层
  assert.ok(!('streaming_mode' in streaming), 'streaming_mode must not be a top-level card property')

  console.log('lark-card-layout ok')
})().catch((err) => { console.error(err); process.exit(1) })
