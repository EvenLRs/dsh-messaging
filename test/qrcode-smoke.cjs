'use strict'
// 二维码烟测：lib/qr-image.js 把登录载荷编成 SVG data URL，这里再用一个
// **独立实现的解码器**（按 ISO/IEC 18004 手写：格式信息 BCH、功能图形、
// zigzag 反掩码、RS 分块反交织、字节模式段解析）把它解回原始字符串。
// 编码器（vendored qrcode-generator）与本解码器来自不同作者，双向一致才算
// 「生成的码真的能被扫出来」；结构断言（定位/分隔/定时/静区）兜住渲染层。
const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

// --- 从 vendored 源码里取权威表格（避免手抄 RS 分块/校正图形坐标出错） ---
function extractArray(src, name) {
  const at = src.indexOf('const ' + name + ' = ')
  assert.ok(at >= 0, 'missing ' + name + ' in vendored source')
  const open = src.indexOf('[', at)
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']') {
      depth--
      if (depth === 0) break
    }
  }
  const literal = src.slice(open, i + 1).replace(/^\s*\/\/.*$/gm, '')
  // JSON 回转：vm 新 realm 里的数组原型与本 realm 不同，deepStrictEqual 会拒。
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + literal + ')')))
}

// --- data URL -> 模块矩阵（从 <path> 的 M 命令还原，验证真实渲染产物） ---
function matrixFromDataUrl(dataUrl, cell, margin) {
  assert.ok(dataUrl.startsWith('data:image/svg+xml;base64,'), 'must be an svg data url')
  const b64 = dataUrl.slice('data:image/svg+xml;base64,'.length)
  const svg = Buffer.from(b64, 'base64').toString('utf8')
  assert.ok(svg.includes('shape-rendering="crispEdges"'), 'crispEdges must be present')
  assert.match(svg, /fill="white"/, 'white background required')
  const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  assert.ok(vb, 'viewBox missing')
  const size = Number(vb[1])
  assert.equal(Number(vb[2]), size, 'square viewBox')
  assert.equal(size % 1, 0)
  const count = (size - margin * 2) / cell
  assert.ok(Number.isInteger(count), 'viewBox must be a whole number of modules+quiet zone')
  assert.equal((count - 17) % 4, 0, 'QR size must be 17+4k')

  const grid = Array.from({ length: count }, () => Array(count).fill(false))
  const d = (svg.match(/<path d="([^"]+)"/) || [])[1]
  assert.ok(d, 'path data missing')
  const re = /M(-?\d+),(-?\d+)/g
  let m
  let placed = 0
  while ((m = re.exec(d))) {
    const c = (Number(m[1]) - margin) / cell
    const r = (Number(m[2]) - margin) / cell
    assert.ok(Number.isInteger(r) && Number.isInteger(c), 'module origin must land on the grid')
    assert.ok(r >= 0 && r < count && c >= 0 && c < count, 'module inside quiet zone bound')
    grid[r][c] = true
    placed++
  }
  assert.ok(placed > 0, 'at least one dark module')
  return { grid, count, svg }
}

// --- 结构断言：定位图形 / 分隔符 / 定时图形 / 静区 ---
function assertStructure(grid, count) {
  const expectFinder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        const expected = ring === 3 || ring <= 1
        assert.equal(grid[r0 + r][c0 + c], expected, `finder(${r0 + r},${c0 + c})`)
      }
    }
  }
  expectFinder(0, 0)
  expectFinder(0, count - 7)
  expectFinder(count - 7, 0)

  // 分隔符全白
  for (let i = 0; i <= 7; i++) {
    assert.equal(grid[7][i], false, `sep row7 col${i}`)
    assert.equal(grid[i][7], false, `sep col7 row${i}`)
    assert.equal(grid[7][count - 1 - i], false, `sep row7 col${count - 1 - i}`)
    assert.equal(grid[i][count - 8], false, `sep col${count - 8} row${i}`)
    assert.equal(grid[count - 8][i], false, `sep row${count - 8} col${i}`)
    assert.equal(grid[count - 1 - i][7], false, `sep col7 row${count - 1 - i}`)
  }

  // 定时图形（偶数位为黑），夹在分隔符之间
  for (let c = 8; c <= count - 9; c++) assert.equal(grid[6][c], c % 2 === 0, `timing row6 col${c}`)
  for (let r = 8; r <= count - 9; r++) assert.equal(grid[r][6], r % 2 === 0, `timing col6 row${r}`)

  // 固定黑模块（格式信息第二份旁边的 dark module）
  assert.equal(grid[count - 8][8], true, 'dark module')
}

// --- 格式信息：读取 + BCH(15,5) 暴力比对（正/反序各试一次，要求唯一命中） ---
const G15 = 0b10100110111
const MASK15 = 0b101010000010010
function bitLen(n) {
  let l = 0
  while (n) {
    l++
    n >>>= 1
  }
  return l
}
function formatValue(data5) {
  let d = data5 << 10
  while (bitLen(d) >= bitLen(G15)) d ^= G15 << (bitLen(d) - bitLen(G15))
  return ((data5 << 10) | d) ^ MASK15
}
function reverse15(v) {
  let r = 0
  for (let i = 0; i < 15; i++) r = (r << 1) | ((v >> i) & 1)
  return r
}
function readFormat(grid) {
  const positions = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  let read = 0
  for (const [r, c] of positions) read = (read << 1) | (grid[r][c] ? 1 : 0)
  const hits = []
  for (let data5 = 0; data5 < 32; data5++) {
    const fv = formatValue(data5)
    if (fv === read || reverse15(fv) === read) hits.push(data5)
  }
  assert.equal(hits.length, 1, 'format info must match exactly one (ec, mask) pair')
  const data5 = hits[0]
  return { ecIndicator: data5 >> 3, mask: data5 & 7, data5 }
}

// --- 第二份格式信息交叉核对（右上行8 + 左下列8）：两份必须编码同一 (EC, mask) ---
function assertFormatCopy2(grid, count, expectedData5, label) {
  const rowA = []
  const colB = []
  for (let c = count - 8; c <= count - 1; c++) rowA.push(grid[8][c] ? 1 : 0)
  for (let r = count - 7; r <= count - 1; r++) colB.push(grid[r][8] ? 1 : 0)
  const rev = (bits) => bits.slice().reverse()
  const variants = []
  for (const a of [rowA, rev(rowA)]) {
    for (const b of [colB, rev(colB)]) {
      variants.push(a.concat(b))
      variants.push(b.concat(a))
    }
  }
  let matched = false
  for (const bits of variants) {
    let read = 0
    for (const bit of bits) read = (read << 1) | bit
    for (let d = 0; d < 32; d++) {
      const fv = formatValue(d)
      if ((fv === read || reverse15(fv) === read) && d === expectedData5) matched = true
    }
  }
  assert.ok(matched, label + ': second format copy must encode the same (ec, mask)')
}

// --- 版本信息块（v≥7）：两块都必须以 BCH(18,6) 编出真实版本号 ---
const G18 = 0b1111100100101 // ISO/IEC 18004 版本信息生成多项式 x^12+…+1
function versionValue(v) {
  let d = v << 12
  while (bitLen(d) >= bitLen(G18)) d ^= G18 << (bitLen(d) - bitLen(G18))
  return (v << 12) | d
}
function bitsToNumber(bits) {
  let n = 0
  for (const bit of bits) n = (n << 1) | bit
  return n
}
// 18 个格子的所有合理线性化方向（行/列优先 × 两轴各自正逆 × 整体反转），
// 任一读法得到 versionValue(version) 即证明该块内容与摆放都对。
function gridLinearizations(block) {
  const h = block.length
  const w = block[0].length
  const order = (n, flip) => Array.from({ length: n }, (_, i) => (flip ? n - 1 - i : i))
  const out = []
  for (const rowFlip of [false, true]) {
    for (const colFlip of [false, true]) {
      const rs = order(h, rowFlip)
      const cs = order(w, colFlip)
      const rowMajor = []
      for (const r of rs) for (const c of cs) rowMajor.push(block[r][c] ? 1 : 0)
      out.push(rowMajor)
      const colMajor = []
      for (const c of cs) for (const r of rs) colMajor.push(block[r][c] ? 1 : 0)
      out.push(colMajor)
    }
  }
  return out.concat(out.map((bits) => bits.slice().reverse()))
}
function assertVersionInfo(grid, count, version, label) {
  const expected = versionValue(version)
  const topRight = []
  const bottomLeft = []
  for (let r = 0; r < 6; r++) {
    const row = []
    for (let c = count - 11; c <= count - 9; c++) row.push(grid[r][c])
    topRight.push(row)
  }
  for (let r = count - 11; r <= count - 9; r++) {
    const row = []
    for (let c = 0; c < 6; c++) row.push(grid[r][c])
    bottomLeft.push(row)
  }
  for (const [where, block] of [['top-right', topRight], ['bottom-left', bottomLeft]]) {
    const ok = gridLinearizations(block).some((bits) => bitsToNumber(bits) === expected)
    assert.ok(ok, label + ': version info ' + where + ' block must BCH-encode v' + version)
  }
}

// --- RS 校验子：纠错码字必须让 c(α^j) = 0（j = 0..e-1），否则真扫码器会把
// 完好的码字图误判为损坏。GF(256) 本原多项式 x^8+x^4+x^3+x^2+1 (0x11d)。 ---
const GF_EXP = new Uint16Array(512)
const GF_LOG = new Uint16Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}
function assertRsSyndromes(blocks, label) {
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]
    const total = block.total
    const ecCount = block.total - block.data
    const cw = block.dataCw.concat(block.ecCw)
    for (let j = 0; j < ecCount; j++) {
      let acc = 0
      const alpha = GF_EXP[j]
      for (let i = 0; i < total; i++) acc = gfMul(acc, alpha) ^ cw[i]
      assert.equal(acc, 0, label + ': RS syndrome S' + j + ' of block ' + bi + ' must vanish')
    }
  }
}

// --- 功能图形地图（与规格一致：三个定位区 + 定时 + 校正 + 版本信息） ---
function functionMap(count, version, alignCenters) {
  const f = Array.from({ length: count }, () => Array(count).fill(false))
  const mark = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r++) {
      for (let c = c0; c < c0 + w; c++) {
        if (r >= 0 && r < count && c >= 0 && c < count) f[r][c] = true
      }
    }
  }
  mark(0, 0, 9, 9) // 定位+分隔+格式信息(第一份)
  mark(0, count - 8, 9, 8) // 右上：定位+分隔+格式信息(第二份, 行8)
  mark(count - 8, 0, 8, 9) // 左下：定位+分隔+格式信息(第二份, 列8)+dark module
  mark(6, 0, 1, count) // 定时行
  mark(0, 6, count, 1) // 定时列
  if (version >= 7) {
    mark(0, count - 11, 6, 3) // 版本信息(右上)
    mark(count - 11, 0, 3, 6) // 版本信息(左下)
  }
  // 校正图形：与定位区重叠的 3 个组合按规格省略
  for (const r of alignCenters) {
    for (const c of alignCenters) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= count - 9) || (r >= count - 9 && c <= 8)
      if (nearFinder) continue
      mark(r - 2, c - 2, 5, 5)
    }
  }
  return f
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
]

// --- zigzag 反掩码读取码字 ---
function readCodewords(grid, f, count, mask) {
  const maskFn = MASKS[mask]
  const bits = []
  let upward = true
  for (let right = count - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 第6列是定时图形，成对列要跳过
    for (let v = 0; v < count; v++) {
      const row = upward ? count - 1 - v : v
      for (let k = 0; k < 2; k++) {
        const col = right - k
        if (f[row][col]) continue
        let bit = grid[row][col]
        if (maskFn(row, col)) bit = !bit
        bits.push(bit)
      }
    }
    upward = !upward
  }
  const codewords = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ? 1 : 0)
    codewords.push(b)
  }
  return codewords
}

// --- RS 分块反交织（与规格的数据/纠错两轮 round-robin 一致） ---
function deinterleave(codewords, blocks) {
  let idx = 0
  for (const b of blocks) {
    b.dataCw = new Array(b.data).fill(0)
    b.ecCw = new Array(b.total - b.data).fill(0)
  }
  const maxData = Math.max(...blocks.map((b) => b.data))
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data) b.dataCw[i] = codewords[idx++]
  }
  const maxEc = Math.max(...blocks.map((b) => b.total - b.data))
  for (let i = 0; i < maxEc; i++) {
    for (const b of blocks) if (i < b.total - b.data) b.ecCw[i] = codewords[idx++]
  }
  assert.equal(idx, codewords.length, 'every codeword must be consumed by de-interleaving')
  return [].concat(...blocks.map((b) => b.dataCw))
}

// --- 字节模式段解析 ---
function parseByteSegment(dataCw, version) {
  let bitPos = 0
  const take = (n) => {
    let v = 0
    for (let i = 0; i < n; i++) {
      const byte = dataCw[bitPos >> 3]
      assert.ok(byte !== undefined, 'data stream truncated')
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1)
      bitPos++
    }
    return v
  }
  assert.equal(take(4), 4, 'mode indicator must be byte mode')
  const count = take(version < 10 ? 8 : 16)
  const bytes = []
  for (let i = 0; i < count; i++) bytes.push(take(8))
  return Buffer.from(bytes).toString('utf8')
}

async function main() {
  const { qrSvgDataUrl } = await import(pathToFileURL(path.join(root, 'lib', 'qr-image.js')).href)
  const src = fs.readFileSync(path.join(root, 'lib', 'vendor', 'qrcode.mjs'), 'utf8')
  const rsBlockTable = extractArray(src, 'RS_BLOCK_TABLE')
  const alignTable = extractArray(src, 'PATTERN_POSITION_TABLE')
  assert.equal(rsBlockTable.length, 40 * 4, 'RS block table must cover 40 versions x 4 EC levels')
  assert.equal(alignTable.length, 40, 'alignment table must cover 40 versions')

  // 表完整性 + 规范锚点：表格虽解析自 vendored 源，但「同一版本四个 EC 行的总
  // 码字数必须相等」（总码字数与纠错级别无关）是硬约束，再叠几个取自
  // ISO/IEC 18004 的已知值，防整表被换成另一套自洽数据后编解码同错同对。
  for (let v = 1; v <= 40; v++) {
    const totals = [0, 1, 2, 3].map((level) => {
      const row = rsBlockTable[(v - 1) * 4 + level]
      let sum = 0
      for (let i = 0; i < row.length; i += 3) sum += row[i] * row[i + 1]
      return sum
    })
    assert.equal(new Set(totals).size, 1, 'v' + v + ': EC rows must share one total-codeword count')
  }
  assert.deepEqual(rsBlockTable.slice(0, 4), [[1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9]], 'spec anchor: v1 RS blocks L/M/Q/H')
  assert.deepEqual(rsBlockTable[(10 - 1) * 4 + 1], [4, 69, 43, 1, 70, 44], 'spec anchor: v10-M RS blocks')
  assert.deepEqual(alignTable[1], [6, 18], 'spec anchor: v2 alignment centers')
  assert.deepEqual(alignTable[6], [6, 22, 38], 'spec anchor: v7 alignment centers')

  const CELL = 4
  const QUIET = 16 // 4 modules
  const cases = [
    {
      name: 'ilink 登录链接（真实形状）',
      payload:
        'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=7b2d11e374ce8d171a189c57aad04926&bot_type=3',
    },
    { name: '极短载荷（v1）', payload: 'HELLO' },
    {
      name: '非 ASCII 载荷（UTF-8 字节模式）',
      payload: 'https://例子.example.com/扫码登录?next=%E9%A6%96%E9%A1%B5',
    },
    { name: '长载荷（≥v7，覆盖版本信息块）', payload: 'https://liteapp.weixin.qq.com/q/' + 'x'.repeat(1500) },
  ]

  let sawVersionInfo = false
  for (const { name, payload } of cases) {
    const dataUrl = qrSvgDataUrl(payload)
    const { grid, count } = matrixFromDataUrl(dataUrl, CELL, QUIET)
    assert.equal(QUIET / CELL, 4, 'quiet zone must be 4 modules')
    assertStructure(grid, count)

    const version = (count - 17) / 4
    const { ecIndicator, mask, data5 } = readFormat(grid)
    assert.equal(ecIndicator, 0, name + ': EC level must be M (indicator 00)')
    assertFormatCopy2(grid, count, data5, name)
    if (version >= 7) assertVersionInfo(grid, count, version, name)

    const f = functionMap(count, version, alignTable[version - 1])
    const codewords = readCodewords(grid, f, count, mask)

    // RS 分块行：表格顺序 L,M,Q,H；EC 指示位 M=00 → 行偏移1
    const row = rsBlockTable[(version - 1) * 4 + 1]
    const blocks = []
    for (let i = 0; i < row.length; i += 3) {
      for (let j = 0; j < row[i]; j++) blocks.push({ total: row[i + 1], data: row[i + 2] })
    }
    const totalCw = blocks.reduce((sum, b) => sum + b.total, 0)
    assert.equal(codewords.length, totalCw, name + ': codeword count must match version capacity')

    const dataCw = deinterleave(codewords, blocks)
    assertRsSyndromes(blocks, name) // 纠错码字必须满足 RS 校验子全零
    const decoded = parseByteSegment(dataCw, version)
    assert.equal(decoded, payload, name + ': decode round-trip')

    if (version >= 7) sawVersionInfo = true
    console.log(`  ok: ${name} (v${version}, ${count}x${count}, mask ${mask})`)
  }
  assert.ok(sawVersionInfo, 'at least one fixture must exercise version info blocks')

  // 同一载荷必须产出同一码（数据 URL 可比对、可缓存）
  assert.equal(qrSvgDataUrl(cases[0].payload), qrSvgDataUrl(cases[0].payload), 'deterministic')

  // 空载荷必须显式报错，而不是画一个扫了没用的空码
  assert.throws(() => qrSvgDataUrl(''), /empty QR payload/)

  console.log('qrcode-smoke: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
