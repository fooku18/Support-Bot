# Agent application

This package owns the shared Mastra agent and its application
bindings. `src/mastra/index.ts` is the Studio entrypoint. Production executables
live in `src/bootstrap`.

`mastra/agents` defines the agent and its bounded configuration. `application`
composes authority, configuration, HTTP and Studio flows. `integrations` contains
service and Gateway adapters; `domain` owns authorization, file inputs and
delivery. `infrastructure` contains storage and process helpers. `contracts` is
the canonical source for generated admin and Slack transport clients.

The Slack receiver (`apps/slack`) and credential-owning HTTP service
(`apps/tool-runtime`) remain separate processes. Their images have separate runtime dependencies from the shared workspace lock. Run root `npm run typecheck:all`, `npm run test:packages`, `npm test`
and `npm run test:native:integration` for deterministic verification. Live
qualification uses only the designated test instance; see [testing](../../docs/testing.md).
