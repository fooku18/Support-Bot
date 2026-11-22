/** Compose interpolation takes application values from the designated env file.
 * Only host transport/runtime essentials may be inherited. Explicit operation
 * settings (such as a candidate secret reference) are added by the caller. */
export function composeHostEnvironment(source = process.env) {
  const env = {};
  for (const key of [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'XDG_RUNTIME_DIR',
    'SSH_AUTH_SOCK',
  ])
    if (source[key]) env[key] = source[key];
  return env;
}
