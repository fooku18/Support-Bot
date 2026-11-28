import { createPrivateKey } from 'node:crypto';
import { modelFetch } from '../../infrastructure/outbound.js';
import { readSecret } from '../../infrastructure/secret.js';
import { RuntimeConfigurationError } from '../../infrastructure/configuration-error.js';
import { JWT } from 'google-auth-library';
import {
  activeModelConnections,
  directModelBase,
  ModelConfigurationError,
  vertexPublisherBase,
  MODEL_STUB_KEY,
  MODEL_STUB_ORIGIN,
  modelConnection,
  parseModelCatalog,
  stubModelCatalog,
  vertexModelLocation,
  type ModelConnection,
  type ResolvedModel,
} from '../../contracts/model-catalog.js';
import type { RunAttribution } from './attribution.js';
import type { CostSink } from './ledger.js';

export type ProviderAccess =
  | {
      connection: 'anthropic';
      apiKey: string;
      origin?: typeof MODEL_STUB_ORIGIN;
      baseURL?: string;
      bearer?: boolean;
    }
  | { connection: 'openai'; apiKey: string; baseURL?: string }
  | {
      connection: 'vertex';
      baseURL: string;
      apiKey: string;
      authMode: 'bearer' | 'x-api-key' | 'x-goog-api-key';
    }
  | { connection: 'vertex'; project: string; location: string; host: string; authClient: JWT };

export interface ModelBinding {
  selection: ResolvedModel;
  access: ProviderAccess;
  fetchImpl?: typeof fetch;
  accounting?: { sink: CostSink; run: RunAttribution };
  onCitation?: (markdown: string) => void;
}

function apiKey(env: NodeJS.ProcessEnv, name: string) {
  const key = readSecret(env, name);
  if (!/^[!-~]{1,2048}$/.test(key) || /[,<>]/.test(key))
    throw new RuntimeConfigurationError(`${name} must contain one API key`);
  return key;
}

function vertexAccess(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch) {
  const gateway = Boolean(env.NATIVE_VERTEX_BASE_URL?.trim());
  const hasKey = Boolean(
    env.NATIVE_VERTEX_API_KEY?.trim() || env.NATIVE_VERTEX_API_KEY_FILE?.trim(),
  );
  const mode = env.NATIVE_VERTEX_AUTH_MODE?.trim() || 'bearer';
  if (
    (!gateway && env.NATIVE_VERTEX_AUTH_MODE?.trim()) ||
    (mode !== 'bearer' && mode !== 'x-api-key' && mode !== 'x-goog-api-key')
  )
    throw new RuntimeConfigurationError(
      'NATIVE_VERTEX_AUTH_MODE requires a valid gateway authentication mode',
    );
  if (gateway || hasKey) {
    if (
      !gateway ||
      !hasKey ||
      env.NATIVE_VERTEX_CREDENTIALS?.trim() ||
      env.NATIVE_VERTEX_CREDENTIALS_FILE?.trim()
    )
      throw new RuntimeConfigurationError(
        'Vertex gateway requires both NATIVE_VERTEX_BASE_URL and NATIVE_VERTEX_API_KEY (or _FILE) and excludes service account credentials',
      );
    const baseURL = vertexPublisherBase(env);
    return {
      access: {
        connection: 'vertex',
        baseURL,
        apiKey: apiKey(env, 'NATIVE_VERTEX_API_KEY'),
        authMode: mode,
      } satisfies ProviderAccess,
      identity: `vertex:${baseURL}`,
    };
  }
  const vertex = vertexModelLocation(env.NATIVE_VERTEX_PROJECT, env.NATIVE_VERTEX_LOCATION);
  const raw = readSecret(env, 'NATIVE_VERTEX_CREDENTIALS');
  let creds: unknown;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error('NATIVE_VERTEX_CREDENTIALS must contain service account credentials');
  }
  if (!creds || typeof creds !== 'object')
    throw new Error('NATIVE_VERTEX_CREDENTIALS must contain service account credentials');
  const {
    type,
    client_email: email,
    private_key: key,
    private_key_id: keyId,
    token_uri: tokenUri,
    universe_domain: universe,
  } = creds as Record<string, unknown>;
  if (
    type !== 'service_account' ||
    typeof email !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,199}@[a-z0-9][a-z0-9.-]{0,199}\.gserviceaccount\.com$/.test(email) ||
    typeof key !== 'string' ||
    typeof keyId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(keyId) ||
    tokenUri !== 'https://oauth2.googleapis.com/token' ||
    (universe !== undefined && universe !== 'googleapis.com')
  )
    throw new Error('NATIVE_VERTEX_CREDENTIALS must contain service account credentials');
  try {
    if (createPrivateKey(key).asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw new Error('NATIVE_VERTEX_CREDENTIALS must contain a valid RSA private key');
  }
  const authClient = new JWT({
    projectId: vertex.project,
    email,
    key,
    keyId,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    transporterOptions: {
      retry: false,
      fetchImplementation: async (input, init) => {
        if (String(input) !== 'https://oauth2.googleapis.com/token' || init?.method !== 'POST')
          throw new Error('Vertex token endpoint refused');
        try {
          const response = await fetchImpl(input, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) return response;
          await response.body?.cancel();
        } catch {
          // Keep errors carrying signed assertions and headers inside the auth client.
        }
        return new Response(null, { status: 503 });
      },
    },
  });
  // The token library supplies its own POST retry policy on each call.
  // Override that request policy as well as the transport defaults.
  authClient.transporter.interceptors.request.add({
    async resolved(config) {
      return { ...config, retry: false, retryConfig: { retry: 0 } };
    },
  });
  return {
    access: { ...vertex, authClient, connection: 'vertex' } satisfies ProviderAccess,
    identity: `vertex:${vertex.project}:${vertex.location}:${email}`,
  };
}

/** Load only credentials used by the trusted catalog. Studio uses the same process boundary. */
export function loadModelProviders(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch) {
  const catalog = parseModelCatalog(env.MODEL_CATALOG, env.MODEL_DEFAULT_KEY);
  const stub = env.NATIVE_MODEL_STUB === '1';
  const credentials = new Map<ModelConnection, { access: ProviderAccess; identity: string }>();
  if (stub) {
    credentials.set('anthropic', {
      access: { connection: 'anthropic', apiKey: MODEL_STUB_KEY, origin: MODEL_STUB_ORIGIN },
      identity: 'synthetic-messages',
    });
  } else {
    try {
      for (const connection of activeModelConnections(catalog)) {
        if (connection === 'vertex')
          credentials.set(connection, vertexAccess(env, fetchImpl ?? fetch));
        else {
          const name =
            connection === 'anthropic' ? 'NATIVE_ANTHROPIC_API_KEY' : 'NATIVE_OPENAI_API_KEY';
          const baseURL = directModelBase(env, connection);
          const mode = connection === 'anthropic' && env.NATIVE_ANTHROPIC_AUTH_MODE?.trim();
          if (mode && mode !== 'bearer' && mode !== 'x-api-key')
            throw new RuntimeConfigurationError('NATIVE_ANTHROPIC_AUTH_MODE is invalid');
          credentials.set(connection, {
            access: {
              connection,
              apiKey: apiKey(env, name),
              baseURL,
              ...(mode === 'bearer' && { bearer: true }),
            },
            identity:
              baseURL === `https://api.${connection}.com/v1`
                ? connection
                : `${connection}:${baseURL}`,
          });
        }
      }
    } catch (error) {
      if (error instanceof ModelConfigurationError)
        throw new RuntimeConfigurationError(error.message);
      throw error;
    }
  }
  const effective = stub ? stubModelCatalog(catalog) : catalog;
  const models = effective.models.map((model): ResolvedModel => ({
    ...model,
    connection: credentials.get(modelConnection(model.route))!.identity,
  }));
  function bind(selection: ResolvedModel, accounting?: ModelBinding['accounting']): ModelBinding {
    const credential = credentials.get(modelConnection(selection.route));
    if (
      !credential ||
      credential.identity !== selection.connection ||
      !models.some(
        (model) =>
          model.key === selection.key &&
          model.route === selection.route &&
          model.model === selection.model &&
          model.webSearch === selection.webSearch,
      )
    )
      throw new Error('model binding refused');
    return {
      selection,
      access: credential.access,
      fetchImpl: fetchImpl ?? (stub ? fetch : modelFetch),
      accounting,
    };
  }
  return { modelPolicy: { ...effective, models }, bind };
}
