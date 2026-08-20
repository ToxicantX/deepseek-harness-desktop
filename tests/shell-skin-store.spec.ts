import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isInjectableClientBundle, resolveClientEntry, resolveShellSkinAsset, ShellSkinStore } from '../src/shell-skin-store.ts'

afterEach(() => { vi.unstubAllGlobals() })

async function withClientFiles<T>(files: Record<string, string>, run: (source: string) => Promise<T>): Promise<T> {
  const source = await mkdtemp(join(tmpdir(), 'dsh-shell-skin-store-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(source, path, '..'), { recursive: true })
      await writeFile(join(source, path), content)
    }
    return await run(source)
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}

describe('resolveClientEntry', () => {
  it('uses a string ./client export', async () => {
    await withClientFiles({ 'dist/client.js': '' }, async source => {
      await expect(resolveClientEntry({ exports: { './client': './dist/client.js' } }, source)).resolves.toBe('./dist/client.js')
    })
  })

  it('resolves conditional client exports through default and import', async () => {
    await withClientFiles({ 'dist/default-client.js': '', 'dist/import-client.js': '' }, async source => {
      await expect(resolveClientEntry({ exports: { './client': { default: './dist/default-client.js' } } }, source)).resolves.toBe('./dist/default-client.js')
      await expect(resolveClientEntry({ exports: { './client': { import: './dist/import-client.js', default: './dist/default-client.js' } } }, source)).resolves.toBe('./dist/import-client.js')
    })
  })

  it.each(['lib/client.js', 'plugin/client.js'])('uses the conventional %s fallback', async entry => {
    await withClientFiles({ [entry]: '' }, async source => {
      await expect(resolveClientEntry({}, source)).resolves.toBe('./' + entry)
    })
  })
})

describe('resolveShellSkinAsset', () => {
  it('resolves route-prefixed assets and native-dist JavaScript', async () => {
    await withClientFiles({ 'assets/wallpaper.jpg': 'jpg', 'native-dist/client.js': 'js' }, async source => {
      await expect(resolveShellSkinAsset(source, '/aemeath-skin/wallpaper.jpg')).resolves.toMatchObject({ contentType: 'image/jpeg' })
      await expect(resolveShellSkinAsset(source, '/client.js')).resolves.toMatchObject({ contentType: 'text/javascript; charset=utf-8' })
    })
  })
  it('denies traversal and package-root client.js', async () => {
    await withClientFiles({ 'client.js': 'secret' }, async source => {
      await expect(resolveShellSkinAsset(source, '../client.js')).rejects.toThrow()
      await expect(resolveShellSkinAsset(source, '/client.js')).rejects.toThrow()
    })
  })
})

describe('ShellSkinStore preview proxy', () => {
  const entry = (url: string) => ({ id: 'preview.skin', name: { zh: '预览', en: 'Preview' }, author: 'author', description: '', repo: 'https://github.com/example/skin', package: 'skin', install: { version: '1.0.0', commit: '0123456789abcdef' }, screenshots: [url] })
  const store = (url: string) => { const value = new ShellSkinStore('unused'); (value as unknown as { catalogValue: unknown[] }).catalogValue = [entry(url)]; return value }

  it('returns and caches a trusted image data URL', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    const value = store('https://raw.githubusercontent.com/example/skin/commit/preview.png')
    await expect(value.preview('preview.skin', 0)).resolves.toBe('data:image/png;base64,iVBORw==')
    await expect(value.preview('preview.skin', 0)).resolves.toBe('data:image/png;base64,iVBORw==')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(value.list().skins[0]?.screenshots).toEqual(['0'])
  })

  it.each(['http://raw.githubusercontent.com/example/a.png', 'https://example.com/a.png'])('rejects an untrusted preview source: %s', async url => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(store(url).preview('preview.skin', 0)).rejects.toThrow('来源不受信任')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects invalid indexes, MIME types, and oversized responses', async () => {
    const value = store('https://kingofsoysauce.github.io/dsh-skin-market/preview.png')
    await expect(value.preview('preview.skin', 1)).rejects.toThrow('预览图不存在')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('html', { headers: { 'content-type': 'text/html' } })))
    await expect(value.preview('preview.skin', 0)).rejects.toThrow('响应类型无效')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(12 * 1024 * 1024 + 1) } })))
    await expect(value.preview('preview.skin', 0)).rejects.toThrow('超过 12 MB')
  })
})

describe('isInjectableClientBundle', () => {
  it('accepts a ModuleLoader wrapper after a BOM and block comments', () => {
    const bundle='\uFEFF/* generated client bundle */\n/* reviewed wrapper */\nwindow.__ModuleLoader__.load({ id: \'skin\', factory(exports) { exports.apply = () => {} } })'

    expect(isInjectableClientBundle(bundle)).toBe(true)
  })

  it('defers apply-export validation to controlled runtime execution', () => {
    expect(isInjectableClientBundle('window.__ModuleLoader__.load({ id: \'skin\', factory: () => ({ apply() {} }) })')).toBe(true)
  })

  it.each([
    'exports.apply = () => {}',
    '/* ModuleLoader load apply */',
  ])('rejects a bundle without a real ModuleLoader wrapper: %s', bundle => {
    expect(isInjectableClientBundle(bundle)).toBe(false)
  })
})
