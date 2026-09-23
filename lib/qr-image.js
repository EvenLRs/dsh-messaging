// 个人微信扫码登录的二维码渲染。
//
// ilink get_bot_qrcode 返回的 qrcode_img_content 是「要编码进二维码的内容」
// （登录链接，如 https://liteapp.weixin.qq.com/q/…），**不是图片地址**：
// openclaw-weixin 参考实现把它交给 qrcode-terminal 画成终端二维码，而用浏览器
// 直接 GET 该地址拿到的是 liteapp 的 HTML 页面——把它塞进 <img src> 永远显示
// 不出图（Content-Type: text/html）。这里在宿主本地把它编码成 SVG data URL，
// 对外契约（login/start 返回的 qrcodeUrl 仍是可直接作图片源的字符串）保持不变，
// lib/client.js 无需改动。
import qrcode from './vendor/qrcode.mjs'

// vendor 默认的 stringToBytes 把每个字符截断为一个字节（charCodeAt & 0xff），
// 非 ASCII 载荷会被截坏成另一个字符串——码能扫出来但内容是错的。改用 UTF-8。
qrcode.stringToBytes = function stringToBytesUtf8(input) {
  return Array.from(new TextEncoder().encode(input))
}

// quiet zone 按规范留 4 个模块（margin = 4 × cellSize）；crispEdges 保证
// 整数倍缩放下模块边缘不发虚，扫码器对摩尔纹更宽容。
const CELL_SIZE = 4
const QUIET_ZONE_MODULES = 4

export function qrSvgDataUrl(payload) {
  const text = String(payload)
  if (!text) throw new Error('qrSvgDataUrl: empty QR payload')
  // typeNumber 0 = 自动选版本；EC M = 中等容错（屏幕反光/摩尔纹下仍可读）。
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const svg = qr
    .createSvgTag({ cellSize: CELL_SIZE, margin: CELL_SIZE * QUIET_ZONE_MODULES, scalable: true })
    .replace('<svg ', '<svg shape-rendering="crispEdges" ')
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}
