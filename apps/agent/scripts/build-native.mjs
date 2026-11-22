import { build } from 'esbuild';
await build({
  entryPoints: {
    main: 'src/bootstrap/main.ts',
    provision: 'src/bootstrap/provision.ts',
    telemetry: 'src/bootstrap/telemetry.ts',
  },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node26',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  outdir: 'dist/native',
  outExtension: { '.js': '.mjs' },
  metafile: true,
});
