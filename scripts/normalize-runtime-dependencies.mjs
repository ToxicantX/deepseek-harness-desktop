import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '')
if (!root) throw new Error('usage: node scripts/normalize-runtime-dependencies.mjs <deployed-package>')

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
for (const { path, packageJson } of manifests) {
  for (const section of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      if (typeof specifier === 'string' && specifier.startsWith('workspace:')) {
        delete packageJson[section][name]
        changed++
      }
    }
  }
  await writeFile(path, JSON.stringify(packageJson, null, 2) + String.fromCharCode(10), 'utf8')
}
console.log('removed ' + changed + ' workspace dependency entr' + (changed === 1 ? 'y' : 'ies'))
