// 将长文本切分为多条飞书可独立发送的文本段。
// 优先按自然边界（段落、换行、句子、空格）切分，找不到边界时按上限强制切分。
//
// 前提与保证（由 test/lark-text-splitter.cjs 动态验证）：
// 0. 输入必须是 well-formed Unicode：入口逐码元校验（手动验证代理对，不依赖
//    String.prototype.isWellFormed() 等较新 API），含孤立代理项直接抛 TypeError，
//    绝不静默替换字符；跨批次拼接的调用方负责自行缓存未完整的代理对，
//    拼完整后再调用本函数。
// 1. 不拆 UTF-16 代理对——在输入 well-formed 的前提下，每个片段单独都是
//    合法 Unicode，分段传输/渲染不会出现孤立代理项乱码；
// 2. segments.join('') === 原文，不重复、不丢字符；
// 3. maxLength 是 UTF-16 code unit **软上限**：必须是 >= 1 的整数，否则抛
//    TypeError（防 slice 不推进导致死循环）。唯一例外：为保持首码点完整，
//    maxLength=1 且首码点为代理对时该片段可为 2 个 code unit；若配置了
//    maxBytes，该片段仍必须满足 maxBytes（首码点自身超预算即抛 RangeError）；
// 4. 可选 maxBytes + measure(text) 字节预算：每段度量不超过 maxBytes；
//    单个字符（码点）自身就超预算时抛 RangeError，明确报错，绝不静默丢正文。
//    measure 契约：对 well-formed 文本的**码点对齐前缀**单调不减（UTF-8 字节与
//    JSON.stringify 字节均满足；任意 UTF-16 下标并不单调，例如 JSON 度量下
//    'a'+high 为 9 字节、补成 'a😀' 反而降为 7 字节）。二分只在码点边界上搜索；
//    不满足该契约的 measure 不保证找到最大可装前缀，也不声称二分正确。
//
// 注意：本函数只承诺自然边界优先，不承诺 code fence / Markdown 标记跨片段完整；
// 需要该语义的调用方应自行按行合并（参考官方 SDK splitWithCodeFences 模式）。

const DEFAULT_MAX_LENGTH = 3000

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

// 手动校验 well-formed：high 必须紧跟 low，low 必须前邻 high。
// 刻意不用 String.prototype.isWellFormed() 等较新 API，兼容更旧的 Node 运行时。
function isWellFormedString(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(str.charCodeAt(i + 1))) return false
      i += 1
    } else if (isLowSurrogate(code)) {
      return false
    }
  }
  return true
}

// UTF-8 字节长度（默认的 measure 实现，也可直接导出给上层做预算度量）。
export function utf8ByteLength(str) {
  return Buffer.byteLength(String(str), 'utf8')
}

// 若切点落在代理对中间则修正：优先后退一位把整对留在下一段；
// 退无可退（切点为 1，第一码点就是代理对）时前进一位，整对留在当前段。
// 任何情况下返回值 >= 1，保证主循环一定推进。
function avoidSplittingSurrogatePair(text, cut) {
  if (cut <= 0 || cut >= text.length) return cut
  const prev = text.charCodeAt(cut - 1)
  const next = text.charCodeAt(cut)
  if (isHighSurrogate(prev) && isLowSurrogate(next)) {
    return cut > 1 ? cut - 1 : Math.min(cut + 1, text.length)
  }
  return cut
}

// 文本的全部码点边界下标（含 0 与 text.length，升序）。
function codePointBoundaries(text) {
  const bounds = [0]
  let i = 0
  while (i < text.length) {
    const code = text.codePointAt(i)
    i += code > 0xffff ? 2 : 1
    bounds.push(i)
  }
  return bounds
}

// 在**码点边界**上二分求最大前缀下标 i，使 measure(text.slice(0, i)) <= budget。
// 只在码点边界搜索：JSON.stringify 字节长度对任意 UTF-16 前缀不单调
// （'a'+high 为 9 字节，补成 'a😀' 反而降为 7 字节），对码点对齐的合法前缀才单调。
// measure 必须满足「对 well-formed 文本的码点前缀单调不减」契约
// （utf8 字节、JSON 字节均满足）；不满足契约的 measure 不保证返回最大可装前缀。
function largestFitIndex(text, budget, measure) {
  const bounds = codePointBoundaries(text)
  let lo = 0
  let hi = bounds.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, bounds[mid])) <= budget) lo = mid
    else hi = mid - 1
  }
  return bounds[lo]
}

export function splitText(text, options = {}) {
  const opts = options || {}

  // 3. maxLength 正整数校验：非整数、< 1、NaN、非 number 一律拒绝。
  const maxLength = opts.maxLength === undefined || opts.maxLength === null
    ? DEFAULT_MAX_LENGTH
    : opts.maxLength
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new TypeError('splitText: maxLength must be a positive integer, got ' + String(maxLength))
  }

  // 4. 可选字节预算：maxBytes 与 measure(text)。
  const maxBytes = opts.maxBytes === undefined || opts.maxBytes === null
    ? undefined
    : opts.maxBytes
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
    throw new TypeError('splitText: maxBytes must be a positive integer, got ' + String(maxBytes))
  }
  const measure = opts.measure === undefined || opts.measure === null
    ? utf8ByteLength
    : opts.measure
  if (typeof measure !== 'function') {
    throw new TypeError('splitText: measure must be a function, got ' + typeof measure)
  }

  if (!text) return []
  if (typeof text !== 'string') {
    throw new TypeError('splitText: text must be a string, got ' + typeof text)
  }

  // 0. 输入前置校验：孤立代理项（如 '\ud800'）在短路径与切分路径都必须拒绝，
  //    不能原样返不间断——原文保留与修复非法码点不可兼得，不静默替换，交上层处理。
  if (!isWellFormedString(text)) {
    throw new TypeError(
      'splitText: text must be well-formed Unicode (no lone surrogates); '
      + 'buffer incomplete surrogate pairs upstream instead of passing them through'
    )
  }

  const measureStr = (str) => {
    const value = measure(str)
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('splitText: measure(text) must return a non-negative finite number, got ' + String(value))
    }
    return value
  }

  const fits = (str) =>
    str.length <= maxLength && (maxBytes === undefined || measureStr(str) <= maxBytes)

  if (fits(text)) return [text]

  const segments = []
  let remaining = text

  while (remaining.length > 0) {
    if (fits(remaining)) {
      segments.push(remaining)
      break
    }

    // 字节预算先收紧切分上限；单字符超预算直接明确报错（不静默丢正文）。
    let limit = maxLength
    if (maxBytes !== undefined) {
      const firstChar = String.fromCodePoint(remaining.codePointAt(0))
      const firstBytes = measureStr(firstChar)
      if (firstBytes > maxBytes) {
        throw new RangeError(
          'splitText: single character ' + JSON.stringify(firstChar)
          + ' measures ' + firstBytes + ' which exceeds maxBytes ' + maxBytes
          + '; cannot split further without dropping content'
        )
      }
      const fit = largestFitIndex(remaining, maxBytes, measureStr)
      limit = Math.min(limit, Math.max(fit, firstChar.length, 1))
    }

    // 1. 自然边界优先，兜底强制切到 limit；
    // 2. 修正代理对；两者共同保证 1 <= cut < remaining.length，循环必推进。
    let cut = avoidSplittingSurrogatePair(remaining, findCutPoint(remaining, limit))
    if (cut < 1) cut = 1

    segments.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }

  return segments
}

function findCutPoint(text, maxLength) {
  // 1. 优先按段落边界（双换行）
  const paragraph = text.lastIndexOf('\n\n', maxLength)
  if (paragraph > maxLength * 0.5) return paragraph

  // 2. 其次按单换行
  const line = text.lastIndexOf('\n', maxLength)
  if (line > maxLength * 0.5) return line

  // 3. 再按句子结束标点后的空格
  const sentence = findSentenceBoundary(text, maxLength)
  if (sentence > maxLength * 0.6) return sentence

  // 4. 兜底按空格
  const space = text.lastIndexOf(' ', maxLength)
  if (space > maxLength * 0.7) return space

  // 5. 强制截断
  return maxLength
}

function findSentenceBoundary(text, maxLength) {
  const delimiters = /[.!?。！？]\s+/g
  let match
  let best = -1
  while ((match = delimiters.exec(text)) !== null) {
    if (match.index + match[0].length > maxLength) break
    best = match.index + match[0].length
  }
  return best
}
