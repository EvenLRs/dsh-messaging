#!/usr/bin/env node
// 分级会话 id 迁移工具（详见 lib/session-id-migration.js 头注释）。
//
// 用法：
//   node scripts/migrate-sessions.cjs --stage ids    --key <channel:conv> [--key ...] [--apply]
//   node scripts/migrate-sessions.cjs --stage legacy --key <channel:conv> [--key ...] [--apply]
//   node scripts/migrate-sessions.cjs --stage cleanup [--apply]
//   node scripts/migrate-sessions.cjs --home <dsh-home> ...
//
// 默认 dry-run（只打印计划）；--home 缺省取 $DSH_HOME 或 ~/.dsh。
// 退出码：存在 conflict（目标已存在）时为 1，其余 0。
'use strict'
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

function parseArgs(argv) {
  const args = { stage: null, keys: [], apply: false, home: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--stage') args.stage = argv[++i]
    else if (arg === '--key') args.keys.push(argv[++i])
    else if (arg === '--home') args.home = argv[++i]
    else if (arg === '--apply') args.apply = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.stage) {
    console.log('usage: node scripts/migrate-sessions.cjs --stage ids|legacy|cleanup [--key <sessionKey> ...] [--apply] [--home <path>]')
    process.exit(args.help ? 0 : 2)
  }
  const home = args.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const { runMigrationStage } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'session-id-migration.js')).href)

  console.log((args.apply ? 'APPLY' : 'DRY-RUN') + ' stage=' + args.stage + ' home=' + home
    + (args.keys.length ? '\nkeys:\n  ' + args.keys.join('\n  ') : ''))
  const results = runMigrationStage(home, args.stage, args.keys, { apply: args.apply, log: (line) => console.log(line) })

  let conflicts = 0
  let moved = 0
  for (const r of results) {
    if (r.reason === 'target-exists') conflicts += 1
    if (r.moved) moved += 1
    console.log('  => ' + (r.oldId ? r.oldId + ' -> ' + r.newId + ': ' : '')
      + (r.moved ? 'MIGRATED' : r.reason || 'unchanged'))
  }
  console.log('summary: ' + results.length + ' item(s), moved=' + moved + ', conflicts=' + conflicts)
  process.exit(conflicts ? 1 : 0)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error)
    process.exit(1)
  })
}

module.exports = { parseArgs, main }
