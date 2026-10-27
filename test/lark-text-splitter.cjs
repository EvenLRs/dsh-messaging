require('./_guard.cjs')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// JSON 序列化字节度量：模拟卡片 content 字段的真实 wire 大小（含引号/反斜线/控制字符转义膨胀）。
const jsonByteLength = (str) => Buffer.byteLength(JSON.stringify(str), 'utf8')
const utf8Len = (str) => Buffer.byteLength(str, 'utf8')

// 手动代理对校验（与实现同口径，不依赖 String.prototype.isWellFormed() 等较新 API）。
const wellFormed = (str) => {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = str.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

;(async () => {
  const { splitText, utf8ByteLength } = await import(pathToFileURL(path.join(root, 'lib', 'lark-text-splitter.js')).href)

  // 1. 空文本
  assert.deepEqual(splitText(''), [])

  // 2. 短文本不分段
  assert.deepEqual(splitText('short'), ['short'])

  // 3. 超长文本强制截断
  const long = 'a'.repeat(5000)
  const segs = splitText(long, { maxLength: 3000 })
  assert.equal(segs.length, 2)
  assert.equal(segs[0].length, 3000)
  assert.equal(segs[1].length, 2000)

  // 4. 按段落边界切分——真实换行（'\n\n'，非字面反斜线+n）
  const paragraphs = ['paragraph one', 'paragraph two', 'paragraph three', 'paragraph four'].join('\n\n')
  assert.ok(paragraphs.includes('\n\n'), 'fixture must contain real double newlines')
  const paraSegs = splitText(paragraphs, { maxLength: 40 })
  assert.ok(paraSegs.length >= 2, 'should split into multiple segments')
  assert.ok(!paraSegs[0].includes('paragraph three'), 'should respect paragraph boundary when possible')
  assert.equal(paraSegs.join(''), paragraphs, 'paragraph split must not lose characters')

  // 5. 按句子边界切分
  const sentences = 'Hello world. This is a test. Another sentence here.'
  const sentSegs = splitText(sentences, { maxLength: 30 })
  assert.ok(sentSegs.length >= 2)

  // 6. 自定义长度
  const custom = splitText('0123456789abcdef', { maxLength: 8 })
  assert.equal(custom.length, 2)

  // 7. 分段不重复、不漏字
  const text = 'The quick brown fox jumps over the lazy dog.'
  assert.equal(splitText(text, { maxLength: 15 }).join(''), text)

  // 8. UTF-16 代理对：强制切分不得拆开 emoji，每段独立合法 Unicode
  {
    const emojiText = 'a' + '😀'.repeat(1500) // 1 + 3000 code units，maxLength=3000 必然落在代理对上
    const emojiSegs = splitText(emojiText, { maxLength: 3000 })
    assert.ok(emojiSegs.length >= 2, 'must split into multiple segments')
    for (const seg of emojiSegs) {
      assert.equal(wellFormed(seg), true, 'each segment must be independently well-formed Unicode')
    }
    assert.equal(emojiSegs.join(''), emojiText, 'no character may be lost or duplicated')
  }
  // 纯代理对开头 + 自然边界混合
  {
    const mixed = '😀'.repeat(50) + '\n\n' + '😀'.repeat(50)
    const mixedSegs = splitText(mixed, { maxLength: 60 })
    for (const seg of mixedSegs) {
      assert.equal(wellFormed(seg), true)
    }
    assert.equal(mixedSegs.join(''), mixed)
  }

  // 8c. 畸形 Unicode 输入：入口即拒绝（含短路径），不静默替换
  {
    assert.throws(() => splitText('\ud800'), TypeError, 'lone high surrogate must be rejected')
    assert.throws(() => splitText('a\udc00', { maxLength: 1 }), TypeError, 'lone low surrogate on short path must be rejected')
    assert.throws(() => splitText('\ud800abc', { maxLength: 2 }), (err) => err instanceof TypeError && /well-formed/.test(err.message))
    assert.throws(() => splitText('\ud800' + 'a'.repeat(5000)), TypeError, 'malformed long input rejected before splitting')
    // 空串与合法代理对不受影响
    assert.deepEqual(splitText(''), [])
    assert.deepEqual(splitText('\ud83d\ude00'), ['😀'])
  }

  // 8d. maxLength 是 UTF-16 code unit 软上限：单码点例外可超 1 单位
  {
    assert.deepEqual(splitText('😀😀', { maxLength: 1 }), ['😀', '😀'], 'length-2 segments over maxLength=1: complete code point wins')
    assert.deepEqual(splitText('a😀b', { maxLength: 2 }), ['a', '😀', 'b'], 'mid-string pair stays whole; leftover b splits off (😀b is 3 units > 2)')
    assert.deepEqual(splitText('😀'.repeat(3), { maxLength: 2 }), ['😀', '😀', '😀'])
    for (const seg of splitText('a😀b', { maxLength: 2 })) assert.equal(wellFormed(seg), true)
  }

  // 8e. maxLength=1 + emoji × 字节预算：完整前进且满足 maxBytes，不足则明确 RangeError
  {
    assert.deepEqual(splitText('😀x', { maxLength: 1, maxBytes: 4 }), ['😀', 'x'], 'jump to 2 units only when the full code point fits the byte budget')
    assert.throws(
      () => splitText('😀x', { maxLength: 1, maxBytes: 3 }),
      (err) => err instanceof RangeError && /maxBytes 3/.test(err.message)
    )
    // JSON 度量：'😀' 序列化后恰为 6 字节（"😀"），5 字节则拒绝
    assert.deepEqual(splitText('😀x', { maxLength: 1, maxBytes: 6, measure: jsonByteLength }), ['😀', 'x'])
    assert.throws(
      () => splitText('😀x', { maxLength: 1, maxBytes: 5, measure: jsonByteLength }),
      (err) => err instanceof RangeError && /maxBytes 5/.test(err.message)
    )
  }

  // 8f. JSON 度量对任意 UTF-16 前缀非单调：二分必须在码点边界搜索
  {
    assert.equal(jsonByteLength('a\ud83d'), 9, 'a + lone high escapes to \\ud83d => 9 bytes')
    assert.equal(jsonByteLength('a😀'), 7, 'completing the pair drops back to 7 bytes')
    assert.ok(jsonByteLength('a\ud83d') > jsonByteLength('a😀'), 'UTF-16-prefix JSON measure is NOT monotone (binary-search premise)')
    const segs = splitText('a😀b', { maxLength: 10, maxBytes: 7, measure: jsonByteLength })
    assert.equal(segs[0], 'a😀', 'code-point-boundary search must find prefix a😀 within 7 bytes')
    assert.equal(segs.join(''), 'a😀b')
    for (const seg of segs) {
      assert.ok(jsonByteLength(seg) <= 7, `segment json bytes ${jsonByteLength(seg)} must fit 7`)
      assert.equal(wellFormed(seg), true)
    }
  }

  // 9. maxLength 正整数校验：非法值直接抛错，防止 slice 不推进导致无限循环
  for (const bad of [0, -5, 1.5, NaN, Infinity, '3000', {}]) {
    assert.throws(
      () => splitText('abcdef', { maxLength: bad }),
      (err) => err instanceof TypeError && /maxLength must be a positive integer/.test(err.message),
      `maxLength ${String(bad)} must be rejected`
    )
  }
  // null 视为缺省（与 undefined 同）
  assert.deepEqual(splitText('short', { maxLength: null }), ['short'])
  // 缺省走 3000
  assert.deepEqual(splitText('x'.repeat(10)), ['x'.repeat(10)])

  // 10. UTF-8 字节度量导出 + 中文/emoji 字节预算
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('中'), 3)
  assert.equal(utf8ByteLength('😀'), 4)
  {
    const cn = '中'.repeat(4000) // 12000 bytes
    const byteSegs = splitText(cn, { maxLength: 3000, maxBytes: 3000 })
    assert.ok(byteSegs.length >= 4, 'byte budget must force extra splits beyond maxLength')
    for (const seg of byteSegs) {
      assert.ok(utf8ByteLength(seg) <= 3000, `segment ${utf8ByteLength(seg)} bytes must fit 3000-byte budget`)
    }
    assert.equal(byteSegs.join(''), cn)
  }

  // 11. JSON 膨胀预算：引号/反斜线/控制字符转义后仍受预算约束，正文不丢
  {
    const tricky = 'say "hi" \\ path\\to 中文😀\n\t'.repeat(400)
    const trickySegs = splitText(tricky, { maxLength: 1000, maxBytes: 800, measure: jsonByteLength })
    assert.ok(trickySegs.length >= 2, 'JSON byte budget must force splits')
    for (const seg of trickySegs) {
      assert.ok(jsonByteLength(seg) <= 800, `json bytes ${jsonByteLength(seg)} must fit 800-byte budget`)
      assert.equal(wellFormed(seg), true)
    }
    assert.equal(trickySegs.join(''), tricky, 'JSON budget split must not lose characters')
  }
  // 转义膨胀可被观测：同样文本 JSON 字节数 > UTF-8 字节数
  {
    const raw = 'quote " backslash \\ ctrl \u0001 end'
    assert.ok(jsonByteLength(raw) > utf8Len(raw), 'JSON escaping must inflate byte size')
    assert.equal(jsonByteLength('中'), utf8Len('"中"'), 'CJK must be measured as UTF-8 inside JSON')
  }

  // 12. 单字符超预算：明确抛 RangeError，不静默丢正文
  assert.throws(
    () => splitText('中文长文本', { maxLength: 10, maxBytes: 2 }),
    (err) => err instanceof RangeError && /single character/.test(err.message) && /maxBytes 2/.test(err.message)
  )
  assert.throws(
    () => splitText('😀😀😀', { maxLength: 10, maxBytes: 3, measure: jsonByteLength }),
    (err) => err instanceof RangeError && /exceeds maxBytes 3/.test(err.message)
  )

  // 13. measure 必须是函数且返回非负有限数
  assert.throws(() => splitText('abcdef', { maxBytes: 10, measure: 'nope' }), TypeError)
  assert.throws(
    () => splitText('abcdef', { maxLength: 2, maxBytes: 10, measure: () => NaN }),
    (err) => err instanceof TypeError && /non-negative finite/.test(err.message)
  )
  // maxBytes 自身也要正整数
  for (const bad of [0, -1, 2.5, '100']) {
    assert.throws(() => splitText('abcdef', { maxBytes: bad }), TypeError, `maxBytes ${bad} rejected`)
  }

  console.log('lark-text-splitter ok')
})().catch((err) => { console.error(err); process.exit(1) })
