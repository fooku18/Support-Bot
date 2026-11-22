import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  // Native Mastra includes CommonJS transports; preserve Node builtin require.
  banner: {
    js: "import { createRequire as nativeRequire } from 'node:module'; const require = nativeRequire(import.meta.url);",
  },
  outfile: 'dist/index.js',
  packages: 'external',
  sourcemap: true,
});
