import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: './src/index.ts', 'storage/drizzle': './src/storage/drizzle.ts' },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
})
