import { defineConfig } from 'tsdown'

const common = {
  outDir: 'lib',
  platform: 'node' as const,
  target: 'node24',
  sourcemap: true,
  dts: false,
  deps: {
    neverBundle: ['electron', 'electron-updater', 'extract-zip', 'semver'],
  },
}

export default defineConfig([
  {
    ...common,
    entry: ['src/main.ts', 'src/backend.ts', 'src/runtime-store.ts', 'src/shutdown-hook.ts'],
    format: 'esm',
    fixedExtension: false,
    clean: true,
  },
  {
    ...common,
    entry: ['src/preload.ts'],
    format: 'cjs',
    outExtensions: () => ({ js: '.cjs' }),
    clean: false,
  },
  {
    outDir: 'lib',
    entry: { 'skin-react-runtime.global': 'src/skin-react-runtime.ts' },
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
    globalName: 'DshSkinReactRuntimeBundle',
    minify: true,
    sourcemap: false,
    dts: false,
    clean: false,
    deps: { alwaysBundle: [/^react(?:-dom)?(?:\/.*)?$/] },
  },
])
