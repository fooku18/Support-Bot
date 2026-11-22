import { createAdminConfigSync } from './admin-sync.js';
import {
  deriveCoordinatorConfig,
  type CoordinatorConfig,
  type CoordinatorDeploymentConfig,
} from './config.js';

/** Reuse the trusted writer's validation/ETag transport without its legacy config
 * table. Each authority boundary revalidates the current admin document. An
 * outage refuses work, including a cold continuation; there is no policy seed. */
export function nativeConfiguration(options: {
  adminUrl: string;
  adminToken: string;
  deployment: CoordinatorDeploymentConfig;
}) {
  let current: CoordinatorConfig | undefined;
  const sync = createAdminConfigSync({
    ...options,
    async applyDocument(document) {
      const next = deriveCoordinatorConfig(document, options.deployment);
      if (
        current &&
        (next.version < current.version ||
          (next.version === current.version && next.hash !== current.hash))
      )
        throw new Error('admin configuration identity regressed');
      current = next;
    },
  });
  return async () => {
    if ((await sync.refresh()).status === 'unavailable' || !current)
      throw new Error('current admin configuration unavailable');
    return current;
  };
}
