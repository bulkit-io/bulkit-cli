import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
});
