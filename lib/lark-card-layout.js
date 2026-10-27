// Feishu / Lark CardKit 2.0 卡片布局构建器。
// 仅生成普通 JSON 对象，不依赖任何运行时状态，便于单元测试与快照比对。
// 官方契约（本地 SDK lib/index.js:103641-103694、105128-105207）：
// - 根对象必须含 schema: "2.0"
// - streaming_mode 必须放在 config 对象内
// - 可更新组件必须带 element_id

// 组件 ID 官方约束：字母、数字、下划线，以字母开头，≤20 字符；本值 18 字符。
export const STREAMING_ELEMENT_ID = 'dsh_streaming_text'

function baseCard(options = {}) {
  const card = { schema: '2.0' }
  if (options.config) card.config = options.config
  return card
}

function markdownElement(content, elementId) {
  const el = {
    tag: 'markdown',
    content: String(content || ''),
  }
  if (elementId) el.element_id = elementId
  return el
}

export function createStreamingCard(text, options = {}) {
  const card = baseCard({
    config: {
      streaming_mode: true,
      summary: { content: options.summary || 'DeepSeek Harness 正在生成…' },
      streaming_config: {
        print_frequency_ms: { default: options.printFrequencyMs ?? 70 },
        print_step: { default: options.printStep ?? 1 },
        print_strategy: options.printStrategy || 'fast',
      },
      update_multi: true,
    },
  })
  card.body = {
    direction: 'vertical',
    elements: [
      markdownElement(text || options.hint || '…', STREAMING_ELEMENT_ID),
    ],
  }
  return card
}

export function createStaticCard(text, options = {}) {
  const card = baseCard({
    config: {
      update_multi: true,
    },
  })
  if (options.header) card.header = options.header
  card.body = {
    direction: 'vertical',
    elements: [
      markdownElement(text),
    ],
  }
  return card
}

export function createTextSegmentCard(text, options = {}) {
  return createStaticCard(text, options)
}

export function createErrorCard(error, options = {}) {
  return createStaticCard('请求处理异常：' + String(error || ''), {
    header: {
      title: {
        tag: 'plain_text',
        content: options.title || '输出异常',
      },
    },
  })
}

export function createCardReferencePayload(cardId) {
  return {
    type: 'card',
    data: { card_id: cardId },
  }
}

export function createStreamingSettingsPayload(summary) {
  const config = { streaming_mode: false }
  if (summary !== undefined) config.summary = { content: String(summary) }
  return { config }
}
