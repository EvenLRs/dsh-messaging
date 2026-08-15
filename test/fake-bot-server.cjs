// Fake bot server for messaging-gateway regression tests.
// Simulates a OneBot v11 HTTP API server AND a Telegram Bot API server.
// Usage: node fake-bot-server.js [port] [emitUrl]
//   port     - listen port (default 5700)
//   emitUrl  - when set, POST /__emit pushes a synthetic OneBot event to this URL
// Admin endpoints:
//   GET  /__log          -> recent requests [{t, method, path, body}]
//   POST /__reset        -> clear log + scripted telegram updates
//   POST /__emit         -> send synthetic OneBot event to emitUrl (body: {text, message_type, user_id, group_id})
//   POST /__updates      -> queue telegram updates to return on next getUpdates
const http = require('http')
const port = Number(process.argv[2] || 5700)
const emitUrl = process.argv[3] || ''
const log = []
let updates = []
let emitted = 0

function json(res, code, obj) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function httpPost(url, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj)
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Self-ID': '999' } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : {} } catch (e) { body = raw }
    const path = (req.url || '').split('?')[0]
    log.push({ t: Date.now(), method: req.method, path, body })
    if (log.length > 500) log.shift()

    if (path === '/__log') return json(res, 200, log)
    if (path === '/__reset') { log.length = 0; updates = []; emitted = 0; return json(res, 200, { ok: true }) }
    if (path === '/__emit') {
      if (!emitUrl) return json(res, 400, { ok: false, error: 'no emitUrl configured' })
      const ev = {
        post_type: 'message',
        message_type: body.message_type || 'private',
        user_id: body.user_id || 1001,
        self_id: 999,
        group_id: body.group_id,
        raw_message: body.text || 'hello from fake',
        message_id: 1000 + (++emitted),
        time: Math.floor(Date.now() / 1000),
        sender: { user_id: body.user_id || 1001, nickname: body.nickname || 'fake-user' }
      }
      return httpPost(emitUrl, ev).then((r) => json(res, 200, { ok: true, emit: r })).catch((e) => json(res, 500, { ok: false, error: String(e) }))
    }
    if (path === '/__updates') { updates = Array.isArray(body) ? body : [body]; return json(res, 200, { ok: true, n: updates.length }) }

    // OneBot HTTP API
    if (/^\/(send_|get_|set_|delete_|can_)/.test(path)) {
      return json(res, 200, { status: 'ok', retcode: 0, data: { message_id: Math.floor(Math.random() * 1e6) } })
    }

    // Telegram Bot API /bot<token>/<method>
    const m = path.match(/^\/bot[^/]+\/([a-zA-Z]+)/)
    if (m) {
      const method = m[1]
      if (method === 'getUpdates') {
        const batch = updates.slice()
        updates = []
        return json(res, 200, { ok: true, result: batch })
      }
      if (method === 'sendMessage') return json(res, 200, { ok: true, result: { message_id: 1, chat: { id: (body && body.chat_id) || 0 } } })
      if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: 'fakebot', username: 'fake_bot' } })
      return json(res, 200, { ok: true, result: true })
    }

    json(res, 404, { ok: false, error: 'not-found' })
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log('fake-bot-server listening on 127.0.0.1:' + port + (emitUrl ? ' emitUrl=' + emitUrl : ''))
})
