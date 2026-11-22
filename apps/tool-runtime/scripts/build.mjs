import { build } from 'esbuild';
// Domain HTTP service only: no generic runner, SDK executor or Code Mode child.
await build({
  entryPoints: {
    'cli-runtime-service': 'src/main.ts',
    'qualification/cloudflare-api-adapter':
      '../agent/src/integrations/cloudflare/cloudflare-api-adapter.ts',
    'qualification/cloudflare-api-provider':
      '../agent/src/integrations/cloudflare/cloudflare-api-provider.ts',
    'qualification/datadog-mcp-adapter': '../agent/src/integrations/datadog/datadog-mcp-adapter.ts',
    'qualification/datadog-mcp-provider':
      '../agent/src/integrations/datadog/datadog-mcp-provider.ts',
  },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node26',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  outdir: 'dist',
});
