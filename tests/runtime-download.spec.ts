import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeStore } from '../src/runtime-store.ts'
import type { RuntimeManifest } from '../src/catalog.ts'

const roots: string[] = []
const body = Buffer.from('verified runtime archive fixture')

async function fixture(url = 'https://example.test/runtime.zip') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-download-'))
  roots.push(root)
  const destination = join(root, 'runtime.zip.part')
  const manifest = { archive: {
    url, size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  } } as RuntimeManifest
  const store = new RuntimeStore(root)
  return { destination, run: () => (store as any).download(manifest, destination, vi.fn()) as Promise<void> }
}

function interrupted() {
  let sent = false
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(body.subarray(0, 8)) }
      else controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }))
    },
  }))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('resumes a terminated response from verified received bytes', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(interrupted()).mockResolvedValueOnce(new Response(body.subarray(8), {
    status: 206, headers: { 'content-range': `bytes 8-${body.length - 1}/${body.length}` },
  }))
  vi.stubGlobal('fetch', fetcher)
  const { destination, run } = await fixture()
  await run()
  expect(new Headers(fetcher.mock.calls[1]?.[1].headers).get('range')).toBe('bytes=8-')
  expect(await readFile(destination)).toEqual(body)
})

it('restarts safely when a server ignores the Range request', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(interrupted()).mockResolvedValueOnce(new Response(body)))
  const { destination, run } = await fixture()
  await run()
  expect(await readFile(destination)).toEqual(body)
})

it('reports download stage, byte count and safe cause after bounded retries', async () => {
  const fetcher = vi.fn(async () => interrupted())
  vi.stubGlobal('fetch', fetcher)
  const { run } = await fixture()
  await expect(run()).rejects.toThrow(/下载失败.*3.*8.*UND_ERR_SOCKET/u)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('rejects a mismatched resume range without installing or retrying it', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(interrupted()).mockResolvedValueOnce(new Response(body.subarray(8), {
    status: 206, headers: { 'content-range': `bytes 0-${body.length - 9}/${body.length}` },
  }))
  vi.stubGlobal('fetch', fetcher)
  const { run } = await fixture()
  await expect(run()).rejects.toThrow('Content-Range')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('does not retry or accept an archive with a wrong hash', async () => {
  const fetcher = vi.fn(async () => new Response(Buffer.alloc(body.length)))
  vi.stubGlobal('fetch', fetcher)
  const { run } = await fixture()
  await expect(run()).rejects.toThrow('SHA-256 mismatch')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('retries temporary HTTP errors but never retries a missing archive', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(body))
  vi.stubGlobal('fetch', fetcher)
  await (await fixture()).run()
  expect(fetcher).toHaveBeenCalledTimes(2)
  fetcher.mockReset().mockResolvedValue(new Response(null, { status: 404 }))
  await expect((await fixture()).run()).rejects.toThrow('unavailable')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('resumes a short clean response and still validates the whole hash', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(body.subarray(0, 8))).mockResolvedValueOnce(new Response(body.subarray(8), {
    status: 206, headers: { 'content-range': `bytes 8-${body.length - 1}/${body.length}` },
  }))
  vi.stubGlobal('fetch', fetcher)
  const { destination, run } = await fixture()
  await run()
  expect(await readFile(destination)).toEqual(body)
})

it('recovers a real HTTP socket disconnect with a Range request', async () => {
  const ranges: Array<string | undefined> = []
  const server = createServer((request, response) => {
    ranges.push(request.headers.range)
    if (ranges.length === 1) {
      response.writeHead(200, { 'content-length': body.length })
      response.write(body.subarray(0, 8))
      setTimeout(() => { response.destroy() }, 20)
    } else {
      response.writeHead(206, {
        'content-length': body.length - 8,
        'content-range': `bytes 8-${body.length - 1}/${body.length}`,
      })
      response.end(body.subarray(8))
    }
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing HTTP address')
    const { destination, run } = await fixture(`http://127.0.0.1:${address.port}/runtime.zip`)
    await run()
    expect(ranges).toEqual([undefined, 'bytes=8-'])
    expect(await readFile(destination)).toEqual(body)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  }
})

it('does not retry an oversized archive', async () => {
  const fetcher = vi.fn(async () => new Response(Buffer.concat([body, body])))
  vi.stubGlobal('fetch', fetcher)
  const { run } = await fixture()
  await expect(run()).rejects.toThrow('exceeded its declared size')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('retries a network failure before receiving headers', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response(body))
  vi.stubGlobal('fetch', fetcher)
  const { destination, run } = await fixture()
  await run()
  expect(await readFile(destination)).toEqual(body)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
