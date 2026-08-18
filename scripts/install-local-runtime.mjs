import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const archive = resolve(process.argv[2] ?? '')
const manifestFile = resolve(process.argv[3] ?? '')
const storeRoot = resolve(process.argv[4] ?? '')
if (archive.length === 0 || manifestFile.length === 0 || storeRoot.length === 0) {
  throw new Error('usage: node scripts/install-local-runtime.mjs <archive> <manifest> <store-root>')
}
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
globalThis.fetch = async () => new Response(Readable.toWeb(createReadStream(archive)), { status: 200 })
const { RuntimeStore } = await import(pathToFileURL(resolve('lib/runtime-store.js')).href)
const store = new RuntimeStore(storeRoot)
let reported = -1
const installed = await store.install(manifest, ({ received, total }) => {
  const percent = Math.floor((received / total) * 100)
  if (percent >= reported + 10) {
    reported = percent
    console.log(`local runtime install: ${percent}%`)
  }
})
await store.promote(manifest.dshVersion)
console.log(`local runtime installed: ${installed.directory}`)
