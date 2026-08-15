#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function argValue(name) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function sha1Hex(value) {
  return crypto.createHash('sha1').update(value, 'utf8').digest('hex')
}

function decodeAesKey(raw) {
  const value = String(raw || '')
  const padding = value.length % 4 ? '='.repeat(4 - value.length % 4) : ''
  const key = Buffer.from(value + padding, 'base64')
  if (key.length !== 32) throw new Error('encodingAESKey must decode to 32 bytes')
  return key
}

function wecomSignature(token, timestamp, nonce, encrypted) {
  return sha1Hex([token, timestamp, nonce, encrypted].sort().join(''))
}

function aesCbcDecrypt(key, iv, encryptedBase64) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()])
  if (!decrypted.length) throw new Error('decrypted data is empty')
  const pad = decrypted[decrypted.length - 1]
  if (pad <= 0 || pad > 32 || pad > decrypted.length) throw new Error('invalid PKCS7 padding')
  return decrypted.subarray(0, decrypted.length - pad)
}

function wecomDecrypt(encrypted, aesKey, receiveId) {
  const iv = aesKey.subarray(0, 16)
  const plain = aesCbcDecrypt(aesKey, iv, encrypted)
  if (plain.length < 20) throw new Error('wecom plaintext too short')
  const messageLength = plain.readUInt32BE(16)
  const message = plain.subarray(20, 20 + messageLength).toString('utf8')
  const actualReceiveId = plain.subarray(20 + messageLength).toString('utf8')
  if (receiveId && actualReceiveId !== receiveId) throw new Error('receiveid mismatch')
  return message
}

function verifyWecomSignature(token, signature, timestamp, nonce, encrypted) {
  const expected = wecomSignature(token, timestamp, nonce, encrypted)
  return expected === String(signature || '')
}

function output(value) {
  try {
    process.stdout.write(JSON.stringify(value) + '\n')
  } catch {
    // The host may have closed the pipe during teardown.
  }
}

async function main() {
  const [node, script, command, op] = process.argv
  const input = safeParse(await readStdin())
  try {
    if (command === 'wecom') {
      const token = argValue('token')
      const aesKeyRaw = argValue('aes-key')
      const receiveId = argValue('receiveid')
      const aesKey = decodeAesKey(aesKeyRaw)
      const encrypted = input.encrypt || input.echostr || ''
      const signature = input.signature || ''
      const timestamp = input.timestamp || ''
      const nonce = input.nonce || ''
      if (!verifyWecomSignature(token, signature, timestamp, nonce, encrypted)) {
        return output({ ok: false, error: 'signature mismatch' })
      }
      const decrypted = wecomDecrypt(encrypted, aesKey, receiveId)
      if (op === 'verify-echostr') return output({ ok: true, decrypted })
      return output({ ok: true, xml: decrypted, decrypted })
    }

    if (command === 'lark' && op === 'decrypt') {
      const key = crypto.createHash('sha256').update(String(argValue('key')), 'utf8').digest()
      const encrypted = input.encrypt || ''
      const iv = key.subarray(0, 16)
      const plain = aesCbcDecrypt(key, iv, encrypted)
      return output({ ok: true, json: plain.toString('utf8') })
    }

    output({ ok: false, error: 'unknown command' })
  } catch (error) {
    output({ ok: false, error: error && error.message ? error.message : String(error) })
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

main()
