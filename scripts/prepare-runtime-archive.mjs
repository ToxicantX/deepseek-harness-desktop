import { copyFile, lstat, mkdir, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const sourceRoot = resolve(process.argv[2] ?? '')
const destinationRoot = resolve(process.argv[3] ?? '')
if (sourceRoot.length === 0 || destinationRoot.length === 0 || sourceRoot === destinationRoot) {
  throw new Error('usage: node scripts/prepare-runtime-archive.mjs <runtime> <archive-staging>')
}

const physicalSourceRoot = await realpath(sourceRoot)
const links = []
const tasks = [{ source: sourceRoot, destination: destinationRoot }]
const relativeToPhysicalRoot = filename => relative(physicalSourceRoot, filename)
const insideSource = filename => {
  const path = relativeToPhysicalRoot(filename)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
const archivePath = filename => relative(sourceRoot, filename).split(sep).join('/')
const physicalArchivePath = filename => relativeToPhysicalRoot(filename).split(sep).join('/')

async function processEntry(source, destination) {
  const entry = await lstat(source)
  if (entry.isSymbolicLink()) {
    const rawTarget = await readlink(source)
    let target
    try {
      target = await realpath(source)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`runtime link target is missing: ${archivePath(source)} -> ${rawTarget}`, { cause: error })
      }
      throw error
    }
    if (!insideSource(target)) throw new Error(`runtime link escapes archive root: ${archivePath(source)}`)
    const targetEntry = await lstat(target)
    if (targetEntry.isDirectory()) {
      links.push({ path: archivePath(source), target: physicalArchivePath(target), kind: 'junction' })
      return
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(target, destination)
    return
  }
  if (entry.isDirectory()) {
    await mkdir(destination, { recursive: true })
    const children = await readdir(source, { withFileTypes: true })
    for (const child of children) {
      tasks.push({ source: resolve(source, child.name), destination: resolve(destination, child.name) })
    }
    return
  }
  if (!entry.isFile()) throw new Error(`unsupported runtime entry: ${archivePath(source)}`)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

await rm(destinationRoot, { recursive: true, force: true })
await mkdir(destinationRoot, { recursive: true })
let cursor = 0
while (cursor < tasks.length) {
  const batch = tasks.slice(cursor, cursor + 24)
  cursor += batch.length
  await Promise.all(batch.map(task => processEntry(task.source, task.destination)))
}
links.sort((left, right) => left.path.localeCompare(right.path))
await writeFile(
  resolve(destinationRoot, 'runtime-links.json'),
  `${JSON.stringify({ schemaVersion: 1, links }, undefined, 2)}\n`,
  'utf8',
)
console.log(`runtime archive staging: ${links.length} junction(s) recorded`)
