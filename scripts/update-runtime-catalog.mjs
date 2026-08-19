import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rcompare } from 'semver'

function argument(name, required = true) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (required && value === undefined) throw new Error(`missing --${name}`)
  return value
}

const manifestFile = resolve(argument('manifest'))
const outputFile = resolve(argument('output'))
const existingValue = argument('existing', false)
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
const incomingRevision = manifest.runtimeRevision ?? 0
if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 0) throw new Error('manifest runtimeRevision must be a nonnegative safe integer')
let releases = []
if (existingValue !== undefined) {
  try {
    const existing = JSON.parse(await readFile(resolve(existingValue), 'utf8'))
    if (existing.schemaVersion === 1 && Array.isArray(existing.releases)) releases = existing.releases
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
const previous = releases.find(release => release.dshVersion === manifest.dshVersion)
if (previous !== undefined) {
  const previousRevision = previous.runtimeRevision ?? 0
  if (!Number.isSafeInteger(previousRevision) || previousRevision < 0) throw new Error('existing runtimeRevision must be a nonnegative safe integer')
  if (incomingRevision <= previousRevision) {
    throw new Error(`runtime revision must increase for DSH ${manifest.dshVersion}: existing ${previousRevision}, incoming ${incomingRevision}`)
  }
}
releases = releases.filter(release => release.dshVersion !== manifest.dshVersion)
releases.push(manifest)
releases.sort((left, right) => rcompare(left.dshVersion, right.dshVersion))
const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releases,
}
await writeFile(outputFile, `${JSON.stringify(catalog, undefined, 2)}\n`, 'utf8')
console.log(`runtime catalog: ${releases.length} release(s), latest DSH ${releases[0]?.dshVersion ?? 'none'}`)
