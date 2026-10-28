import { defineConfig } from 'tsdown'

/**
 * The bridge package ships the plugin and protocol module — the extension imports
 * `@yuxianglin/dsh-bridge-browser/protocol`, so the protocol bundle is part
 * of the published surface, not an internal module.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/protocol.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
