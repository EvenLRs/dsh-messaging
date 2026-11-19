// Single-writer (the Lark lease owns this home) fsynced generation journal.
// No chat/message ids or incoming text are stored. Generation zero is unchanged.
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, lstatSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { sessionIdForKey } from './session-id-migration.js'
const hash = value => createHash('sha256').update(String(value)).digest('hex')
export function createLarkSessionGenerations(root) {
  function load(key) {
    const file = join(root, hash(key) + '.json')
    let row
    try {
      if (!lstatSync(file).isFile()) throw new Error('generation_store_invalid')
      row = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return { generation: 0, triggers: [], startedAt: null }
      // Reject corruption/permissions/symlinks without echoing file content or paths.
      throw new Error('generation_store_invalid')
    }
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.version !== 1 || !Number.isSafeInteger(row.generation) || row.generation < 1 || !Array.isArray(row.triggers) || row.triggers.length !== row.generation || row.triggers.some(x => !/^[a-f0-9]{64}$/.test(x)) || new Set(row.triggers).size !== row.triggers.length || !Number.isFinite(row.startedAt)) throw new Error('generation_store_invalid')
    return row
  }
  return {
    current(key, sessionKey = key) {
      const row = load(key)
      return { ...row, sessionId: sessionIdForKey(row.generation === 0 ? sessionKey : sessionKey + ':generation:' + row.generation) }
    },
    advance(key, trigger, now = Date.now()) {
      const row = load(key), digest = hash(trigger)
      if (row.triggers.includes(digest)) return row.generation
      const next = { version: 1, generation: row.generation + 1, triggers: [...row.triggers, digest], startedAt: now }
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const file = join(root, hash(key) + '.json'), tmp = file + '.tmp-' + process.pid
      try {
        writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
        const fd = openSync(tmp, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(tmp, file)
        const dir = openSync(root, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
      } finally { if (existsSync(tmp)) unlinkSync(tmp) }
      return next.generation
    },
  }
}
