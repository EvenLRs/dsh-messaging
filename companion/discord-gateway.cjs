#!/usr/bin/env node
'use strict'

function argValue(name) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function emit(packet) {
  try {
    process.stdout.write(JSON.stringify(packet) + '\n')
  } catch {
    // The host may have closed the pipe during teardown.
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getGateway(token) {
  const response = await fetch('https://discord.com/api/v10/gateway/bot', {
    headers: { Authorization: 'Bot ' + token },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error('gateway lookup failed: HTTP ' + response.status + ' ' + text)
  }
  const data = await response.json()
  if (!data.url) throw new Error('gateway lookup returned no url')
  return data.url
}

async function main() {
  const stdinPayload = safeParse(await readStdin())
  const token = process.argv.includes('--token') ? argValue('token') : stdinPayload.token || ''
  if (!token) throw new Error('discord token is required')
  const intents = Number(argValue('intents') || stdinPayload.intents || 33281)
  const wsModulePath = argValue('ws-module') || 'ws'
  const WebSocket = require(wsModulePath)
  const gatewayUrl = await getGateway(token)

  let sessionId = null
  let sequence = null
  let heartbeat = null
  let manualReconnect = false

  const connect = async (resume) => {
    const url = gatewayUrl + (gatewayUrl.includes('?') ? '&' : '?') + 'v=10&encoding=json'
    const socket = new WebSocket(url)
    let helloReceived = false

    const armHeartbeat = (intervalMs) => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: 1, d: sequence ?? null }))
        }
      }, intervalMs)
    }

    socket.on('open', () => {
      if (resume && sessionId && sequence !== null) {
        socket.send(JSON.stringify({
          op: 6,
          d: {
            token,
            session_id: sessionId,
            seq: sequence,
          },
        }))
      } else {
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token,
            intents,
            properties: {
              os: 'dsh',
              browser: 'dsh-messaging',
              device: 'dsh-messaging',
            },
          },
        }))
      }
    })

    socket.on('message', (raw) => {
      let payload
      try {
        payload = JSON.parse(String(raw))
      } catch {
        return
      }
      if (payload.s !== undefined) sequence = payload.s
      const op = payload.op
      const d = payload.d
      if (op === 10) {
        helloReceived = true
        armHeartbeat(d && d.heartbeat_interval)
        if (!resume) emit({ type: 'starting', url: gatewayUrl })
      } else if (op === 11) {
        // heartbeat ack; no action
      } else if (op === 0) {
        if (payload.t === 'READY') {
          sessionId = d && d.session_id
          emit({ type: 'ready', url: gatewayUrl, sessionId })
        } else if (payload.t === 'MESSAGE_CREATE' && d) {
          const author = d.author || {}
          const content = d.content || ''
          emit({
            type: 'message',
            channelId: d.channel_id,
            guildId: d.guild_id || null,
            authorId: author.id,
            authorBot: Boolean(author.bot),
            content,
            messageId: d.id,
          })
        }
      } else if (op === 7) {
        manualReconnect = true
        try { socket.close(1000, 'reconnect requested') } catch {}
      } else if (op === 9) {
        sessionId = null
        sequence = null
        manualReconnect = true
        try { socket.close(1000, 'invalid session') } catch {}
      }
    })

    socket.on('error', (error) => {
      emit({ type: 'error', message: error && error.message ? error.message : String(error) })
    })

    socket.on('close', async () => {
      if (heartbeat) clearInterval(heartbeat)
      if (!helloReceived && !manualReconnect) {
        emit({ type: 'error', message: 'gateway socket closed before hello' })
      }
      const shouldResume = Boolean(sessionId && sequence !== null)
      manualReconnect = false
      emit({ type: 'reconnecting', afterMs: 2000, resume: shouldResume })
      await wait(2000)
      connect(shouldResume).catch((error) => emit({ type: 'error', message: error && error.message ? error.message : String(error) }))
    })

    return socket
  }

  connect(false).catch((error) => emit({ type: 'error', message: error && error.message ? error.message : String(error) }))
}

function safeParse(text) {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

main().catch((error) => {
  emit({ type: 'error', message: error && error.message ? error.message : String(error) })
  process.exitCode = 1
})
