import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const bootPackage = '@deepseek-ai/dsh-app-boot'

function version(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)
    ? value : undefined
}

function packageVersion(filename, name) {
  try {
    const manifest = JSON.parse(readFileSync(filename, 'utf8'))
    if (manifest.name === name) return version(manifest.version)
  } catch { /* Unavailable metadata leaves the version unknown. */ }
}

// Resolve from the backend entry so a plugin's development or bundled
// dependencies cannot shadow the host's app-boot package.
async function readHostVersion() {
  const entry = process.argv[1]
  if (!entry || !isAbsolute(entry)) return undefined
  const hostRequire = createRequire(entry)
  try {
    const boot = await import(pathToFileURL(hostRequire.resolve(bootPackage)).href)
    const current = version(boot.getDshRuntimeVersion?.())
    if (current) return current
  } catch { /* Fall back to the same host package's version metadata. */ }
  try {
    return packageVersion(hostRequire.resolve(bootPackage + '/package.json'), bootPackage)
  } catch { return undefined }
}

const pluginVersion = packageVersion(fileURLToPath(new URL('../package.json', import.meta.url)), 'dsh-messaging')

export async function messagingRuntimeInfo() {
  const hostVersion = await readHostVersion()
  let uptime
  try { uptime = process.uptime() } catch { /* No uptime source. */ }
  return { hostVersion, uptime, pluginVersion }
}
