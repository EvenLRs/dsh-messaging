// Independent R3 checks: synthetic provider, real scope catalogue/core, no network/storage.
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const core = process.env.DSH_QUOTE_CORE || fileURLToPath(new URL('../lib/messaging-interactions.js', import.meta.url))
const { createMessagingInteractions } = await import(pathToFileURL(core))
const cases = [
  ['uncatalogued updated interactive', null, 'interactive', true, true, true],
  ['catalogued cardkit updated interactive', 'cardkit', 'interactive', true, true, true],
  ['catalogued static_card updated interactive', 'static_card', 'interactive', true, true, true],
  ['unchanged interactive', 'cardkit', 'interactive', false, true, false],
  ['updated text', null, 'text', true, true, false],
  ['catalogued cardkit but GET returns text', 'cardkit', 'text', true, true, false],
  ['unavailable quote', 'cardkit', 'interactive', true, false, false],
]
let failures = 0
for (const [name, directoryType, messageType, updated, available, expected] of cases) {
  const agent = {}, binding = { agent, appId: 'a', chatId: 'c', sessionId: 's', record: {}, runtime: {}, generation: 1 }
  const host = createMessagingInteractions({ bindingOf: a => a === agent ? binding : null, receipts: {},
    provider: { quote: async () => available ? { ok: true, text: 'EXPLICIT_OLDER_TARGET', messageType, updated } : { ok: false, code: 'unavailable' } } })
  try {
    if (directoryType) host.remember({ appId: 'a', chatId: 'c', messageId: 'p', messageType: directoryType, botAuthored: true })
    host.remember({ appId: 'a', chatId: 'c', messageId: 'q', parentId: 'p', trustedQuote: true })
    const ref = host.select(agent, 'q'), result = await host.context(agent, { target: ref })
    assert.equal(result.quote.available, available)
    assert.equal(Object.hasOwn(result.quote, 'freshness'), expected)
    if (expected) assert.equal(result.quote.freshness, 'unverified')
    const enriched = await host.enrich(agent, 'q', 'How many paths in the quote?')
    assert.equal(enriched.includes('may not reflect its latest edit'), expected)
    assert.equal(enriched.includes('"freshness":"unverified"'), expected)
    if (available) {
      assert.ok(enriched.includes('EXPLICIT_OLDER_TARGET'))
      assert.ok(enriched.includes('this is the explicitly quoted target, not the latest answer'))
    } else assert.ok(enriched.includes('Do not substitute the latest answer'))
    if (directoryType && available) assert.equal(result.quote.message.type, directoryType)
    console.log('PASS R3 ' + name)
  } catch (error) { failures++; console.log('FAIL R3 ' + name + ': ' + error.message) }
}
console.log('SUMMARY R3 total=' + cases.length + ' fail=' + failures)
if (failures) process.exitCode = 1
