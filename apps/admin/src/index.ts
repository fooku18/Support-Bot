/**
 * Admin service entry: validates the environment, connects to the settings
 * database, and serves the admin UI, the JSON API and the internal
 * configuration API on ADMIN_PORT (reached only through the reverse proxy and the
 * Compose frontend network; no published host port).
 */

import http from 'node:http';
import { createApp } from './app.js';
import { LiveFeed, LiveSockets } from './live.js';
import { ConfigError, loadConfig } from './config.js';
import { configureOutbound } from './outbound.js';
import { SlackApi } from './slack.js';
import { AdminStore } from './store.js';

const COST_PRUNE_INTERVAL_MS = 3_600_000;

async function main(): Promise<void> {
  const config = loadConfig((name) => process.env[name]);
  configureOutbound(config.egressProxyUrl);
  const store = await AdminStore.open(config.database, config.storeKey);
  const feed = new LiveFeed();
  const slack = new SlackApi({ apiUrl: config.slackApiUrl });
  const app = createApp({ config, store, slack, feed });
  const server = http.createServer(app);
  const sockets = new LiveSockets({
    feed,
    publicUrl: config.publicUrl,
    resolveSession: app.resolveSession,
  });
  server.on('upgrade', (req, socket, head) => void sockets.handleUpgrade(req, socket, head));
  // Logout, password change and disable close that admin's sockets at once.
  store.onSessionsRevoked = (scope) => {
    if (scope.sessionId !== undefined) sockets.revokeSession(scope.sessionId);
    if (scope.adminId !== undefined) sockets.revokeAdmin(scope.adminId);
  };
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.listen(config.port, config.host, () => {
    console.log(
      `admin service listening port=${config.port} cost_retention_days=${config.costRetentionDays}`,
    );
  });
  // Cost ledger retention: at
  // startup and hourly; a pass that deletes rows is audited by the store.
  const prune = async (): Promise<void> => {
    try {
      const pruned = await store.pruneCosts(config.costRetentionDays);
      if (pruned.requests > 0 || pruned.runs > 0) {
        console.log(`cost ledger pruned requests=${pruned.requests} runs=${pruned.runs}`);
      }
    } catch (err) {
      console.error(`cost ledger prune failed: ${err instanceof Error ? err.name : 'error'}`);
    }
  };
  void prune();
  const pruneTimer = setInterval(prune, COST_PRUNE_INTERVAL_MS);
  pruneTimer.unref();
  const stop = (signal: string): void => {
    console.log(`received ${signal}; shutting down`);
    clearInterval(pruneTimer);
    // Sockets first, then the HTTP server, then the settings store.
    sockets.close();
    server.close(() => {
      void store.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    server.closeAllConnections();
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

try {
  await main();
} catch (err) {
  console.error(
    err instanceof ConfigError
      ? `startup failed:\n${err.message}`
      : `startup failed: ${err instanceof Error ? err.name : 'error'}`,
  );
  process.exitCode = 1;
}
