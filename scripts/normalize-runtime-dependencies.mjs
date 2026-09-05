import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '')
if (!root) throw new Error('usage: node scripts/normalize-runtime-dependencies.mjs <deployed-package>')

const packageVersions = new Map()
const manifests = []

async function visit(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.git') await visit(path)
    } else if (entry.name === 'package.json') {
      try {
        const packageJson = JSON.parse(await readFile(path, 'utf8'))
        if (typeof packageJson.name === 'string' && typeof packageJson.version === 'string') {
          packageVersions.set(packageJson.name, packageJson.version)
          manifests.push({ path, packageJson })
        }
      } catch (error) {
        throw new Error('Invalid package manifest: ' + path + ': ' + error.message)
      }
    }
  }
}

await visit(root)
let changed = 0
const unresolved = []
for (const { path, packageJson } of manifests) {
  const isRootManifest = path === join(root, 'package.json')
  for (const section of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      if (typeof specifier !== 'string' || !specifier.startsWith('workspace:')) continue
      const version = packageVersions.get(name)
      if (!version) {
        if (isRootManifest && section === 'devDependencies') {
          delete packageJson[section][name]
          changed++
          continue
        }
        unresolved.push(name + ' (' + specifier + ') in ' + path)
        continue
      }
      packageJson[section][name] = version
      changed++
    }
  }
  if (JSON.stringify(packageJson).includes('workspace:')) { unresolved.push('workspace protocol remains in ' + path); continue }
  await writeFile(path, JSON.stringify(packageJson, null, 2) + String.fromCharCode(10), 'utf8')
}
if (unresolved.length) throw new Error('Unable to normalize runtime workspace dependencies:' + String.fromCharCode(10) + unresolved.join(String.fromCharCode(10)))
console.log('normalized ' + changed + ' workspace dependency specifier(s)')
