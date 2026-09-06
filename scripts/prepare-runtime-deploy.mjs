import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseDocument } from 'yaml'

if (!process.argv[2]) throw new Error('usage: node scripts/prepare-runtime-deploy.mjs <source-workspace>')
const filename = resolve(process.argv[2], 'pnpm-workspace.yaml')
const document = parseDocument(await readFile(filename, 'utf8'))
if (document.errors.length) throw document.errors[0]
let changed = 0
// Explicit link overrides bypass pnpm deploy's workspace package injection.
for (const [name, specifier] of Object.entries(document.toJS().overrides ?? {})) {
  if (typeof specifier === 'string' && specifier.startsWith('link:')) {
    document.setIn(['overrides', name], `file:${specifier.slice(5)}`)
    changed++
  }
}
// Hoisting otherwise adds links back to unrelated original workspace projects.
document.set('hoistWorkspacePackages', false)
await writeFile(filename, document.toString(), 'utf8')
console.log(`runtime deploy: ${changed} link override(s) converted to file dependencies`)
