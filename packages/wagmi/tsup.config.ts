import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/connector.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['viem', 'wagmi', '@wagmi/core'],
})
