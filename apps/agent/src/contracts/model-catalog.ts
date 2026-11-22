export const MODEL_ROUTES = ['anthropic', 'openai', 'vertex-claude', 'vertex-gemini'] as const;
export type ModelRoute = (typeof MODEL_ROUTES)[number];

export interface CatalogEntry {
  key: string;
  route: ModelRoute;
  model: string;
  webSearch: boolean;
}

export interface ModelCatalog {
  defaultKey: string;
  models: CatalogEntry[];
}

export interface ResolvedModel extends CatalogEntry {
  connection: string;
}

export type ModelConnection = 'anthropic' | 'openai' | 'vertex';

export const MODEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
export const MODEL_SETTING_NAMES = [
  'MODEL_CATALOG',
  'MODEL_DEFAULT_KEY',
  'NATIVE_ANTHROPIC_BASE_URL',
  'NATIVE_ANTHROPIC_AUTH_MODE',
  'NATIVE_ANTHROPIC_API_KEY',
  'NATIVE_ANTHROPIC_API_KEY_FILE',
  'NATIVE_OPENAI_BASE_URL',
  'NATIVE_OPENAI_API_KEY',
  'NATIVE_OPENAI_API_KEY_FILE',
  'NATIVE_VERTEX_CREDENTIALS',
  'NATIVE_VERTEX_CREDENTIALS_FILE',
  'NATIVE_VERTEX_BASE_URL',
  'NATIVE_VERTEX_AUTH_MODE',
  'NATIVE_VERTEX_API_KEY',
  'NATIVE_VERTEX_API_KEY_FILE',
  'NATIVE_VERTEX_PROJECT',
  'NATIVE_VERTEX_LOCATION',
  'NATIVE_MODEL_STUB',
] as const;

const BODY_MODEL_ID = /^(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*\/)?[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:@[0-9]{8})?$/;
const MODEL_ID: Record<ModelRoute, RegExp> = {
  anthropic: BODY_MODEL_ID,
  openai: BODY_MODEL_ID,
  'vertex-claude': /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,109}(?:@[0-9]{8})?$/,
  'vertex-gemini': /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/,
};

export function validModelKey(value: unknown): value is string {
  return typeof value === 'string' && MODEL_KEY_PATTERN.test(value) && value !== 'default';
}

export function isModelRoute(value: unknown): value is ModelRoute {
  return typeof value === 'string' && MODEL_ROUTES.some((route) => route === value);
}

export function parseModelCatalog(
  raw: string | undefined,
  defaultKey: string | undefined,
): ModelCatalog {
  let models: unknown;
  try {
    models = JSON.parse(raw ?? '');
  } catch {
    throw new Error('MODEL_CATALOG must be a JSON array');
  }
  if (!Array.isArray(models) || models.length < 1 || models.length > 16)
    throw new Error('MODEL_CATALOG must contain one to 16 entries');
  const keys = new Set<string>();
  const entries: CatalogEntry[] = models.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('MODEL_CATALOG entries must be objects');
    const { key, route, model, webSearch } = entry as Record<string, unknown>;
    if (Object.keys(entry).some((name) => !['key', 'route', 'model', 'webSearch'].includes(name)))
      throw new Error('MODEL_CATALOG entry has an unknown field');
    if (!validModelKey(key) || keys.has(key))
      throw new Error('MODEL_CATALOG entry has an invalid or duplicate key');
    if (!isModelRoute(route)) throw new Error('MODEL_CATALOG entry has an invalid route');
    if (
      typeof model !== 'string' ||
      model.length > 128 ||
      /\s/.test(model) ||
      !MODEL_ID[route].test(model) ||
      model.includes('..')
    )
      throw new Error('MODEL_CATALOG entry has an invalid model ID');
    if (
      (Object.hasOwn(entry, 'webSearch') && typeof webSearch !== 'boolean') ||
      (route === 'vertex-gemini' && webSearch === true)
    )
      throw new Error('MODEL_CATALOG entry has an invalid webSearch capability');
    keys.add(key);
    return { key, route, model, webSearch: webSearch === true };
  });
  if (!validModelKey(defaultKey) || !keys.has(defaultKey))
    throw new Error('MODEL_DEFAULT_KEY must name a key in MODEL_CATALOG');
  return { models: entries, defaultKey };
}

export function modelConnection(route: ModelRoute): ModelConnection {
  return route === 'vertex-claude' || route === 'vertex-gemini' ? 'vertex' : route;
}

export function activeModelConnections(catalog: ModelCatalog): ModelConnection[] {
  return [...new Set(catalog.models.map(({ route }) => modelConnection(route)))];
}

export function vertexModelLocation(project: string | undefined, location: string | undefined) {
  if (!project || !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,24})$/.test(project))
    throw new ModelConfigurationError('NATIVE_VERTEX_PROJECT is invalid');
  if (
    !location ||
    !/^(?:global|[a-z]+(?:-[a-z0-9]+)*[0-9])$/.test(location) ||
    location.length > 32
  )
    throw new ModelConfigurationError('NATIVE_VERTEX_LOCATION is invalid');
  return {
    project,
    location,
    host:
      location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`,
  };
}

type ModelEnv = Record<string, string | undefined>;

export class ModelConfigurationError extends Error {}

function gatewayBase(env: ModelEnv, connection: ModelConnection) {
  const name = `NATIVE_${connection.toUpperCase()}_BASE_URL`;
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const url = URL.parse(raw);
  if (
    !url ||
    raw.length > 400 ||
    url.port === '0' ||
    url.hostname.length > 253 ||
    url.hostname.startsWith('127.') ||
    !/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?(?:\/[a-zA-Z0-9._~/-]*)?$/.test(raw) ||
    /\/\.{1,2}(?:\/|$)/.test(raw) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      url.hostname,
    ) ||
    /(?:^|\.)(?:localhost|localhost\.localdomain|metadata\.google\.internal)$/.test(url.hostname) ||
    url.hostname === 'instance-data.ec2.internal'
  )
    throw new ModelConfigurationError(`${name} must name a valid HTTPS gateway`);
  return url.href.replace(/\/+$/, '');
}

export function directModelBase(env: ModelEnv, connection: 'anthropic' | 'openai') {
  const base = gatewayBase(env, connection) ?? `https://api.${connection}.com`;
  return base.endsWith('/v1') ? base : base + '/v1';
}

export function vertexPublisherBase(env: ModelEnv) {
  const base = gatewayBase(env, 'vertex');
  const project = env.NATIVE_VERTEX_PROJECT?.trim();
  const location = env.NATIVE_VERTEX_LOCATION?.trim();
  const path = base && new URL(base).pathname;
  const embedded =
    path && /\/v1(?:beta1)?\/projects\/([^/]+)\/locations\/([^/]+)\/publishers$/.exec(path);
  if (base && embedded) {
    if ((project && project !== embedded[1]) || (location && location !== embedded[2]))
      throw new ModelConfigurationError(
        'NATIVE_VERTEX_BASE_URL conflicts with Vertex project or location',
      );
    vertexModelLocation(embedded[1], embedded[2]);
    return base;
  }
  if (
    base &&
    path?.endsWith('/publishers') &&
    !/\/(?:projects|locations|publishers)(?:\/|$)/.test(path.slice(0, -'/publishers'.length))
  ) {
    if (project || location)
      throw new ModelConfigurationError(
        'NATIVE_VERTEX_BASE_URL publisher root requires unset Vertex project and location',
      );
    return base;
  }
  if (path && /\/(?:projects|locations|publishers)(?:\/|$)/.test(path))
    throw new ModelConfigurationError('NATIVE_VERTEX_BASE_URL has an incomplete publisher path');
  const { host } = vertexModelLocation(project, location);
  const root = base ?? `https://${host}`;
  return `${/\/v1(?:beta1)?$/.test(root) ? root : root + '/v1'}/projects/${project}/locations/${location}/publishers`;
}

export function modelEgressHosts(catalog: ModelCatalog, env: ModelEnv) {
  return activeModelConnections(catalog).flatMap((connection) => {
    if (connection !== 'vertex') return [new URL(directModelBase(env, connection)).hostname];
    const host = new URL(vertexPublisherBase(env)).hostname;
    return env.NATIVE_VERTEX_BASE_URL?.trim() ? [host] : [host, 'oauth2.googleapis.com'];
  });
}

export function modelConversationIdentity(model: ResolvedModel) {
  return [model.route, model.model, model.connection];
}

export const MODEL_STUB_ORIGIN = 'http://model-stub:9877';
export const MODEL_STUB_KEY = 'stub-key-2';

export function stubModelCatalog(catalog: ModelCatalog): ModelCatalog {
  return {
    defaultKey: catalog.defaultKey,
    models: catalog.models.map((entry) => ({ ...entry, route: 'anthropic', webSearch: false })),
  };
}
