import { MODEL_SETTING_NAMES } from '../../contracts/model-catalog.js';
/** Shared repository path, command and environment policy. Native execution
 * and publication use these checks independently of the model tool surface. */

import path from 'node:path';
import fs from 'node:fs';
import { fsTreeLookup, linkOutsideMessage, resolveTreeLink } from './transfer.js';

export class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainmentError';
  }
}

/**
 * Resolves `requested` inside `workspaceRoot` the way the filesystem will
 *: component by component through lstat with the shared tree
 * resolver, expanding each link where it is met and never normalizing `..`
 * lexically first. With `perCheckout`, each top-level directory is one
 * checkout and a link inside it may only lead within that checkout; a link
 * may never lead into `.git`, be absolute, or loop. A dangling link counts
 * by where it points, so a dangling escape is refused like an existing one.
 * The lexically normalized path (what a tool that normalizes before opening
 * would use) must stay inside as well. Returns the destination below the
 * real workspace root; throws ContainmentError on any escape or a missing
 * root. Other-task paths can never resolve inside this workspace root
 * because the root itself is the per-task directory.
 */
export function resolveWithin(
  workspaceRoot: string,
  requested: string,
  options: { perCheckout?: boolean } = {},
): string {
  const escapes = () =>
    new ContainmentError(
      `path escapes the task workspace: ${String(requested).slice(0, 120)} (use a workspace-relative path such as src/file.ts)`,
    );
  const root = path.resolve(workspaceRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new ContainmentError('task workspace is missing');
  }
  if (typeof requested !== 'string' || requested.includes('\0')) throw escapes();
  let relative = requested;
  if (path.isAbsolute(requested)) {
    // A textual prefix only: no lexical normalization before link expansion.
    const base = [root, realRoot].find(
      (candidate) => requested === candidate || requested.startsWith(`${candidate}/`),
    );
    if (base === undefined) throw escapes();
    relative = requested.slice(base.length);
  }
  relative = relative.replace(/^\/+/, '');
  const lexical = path.posix.normalize(relative.length === 0 ? '.' : relative);
  if (lexical === '..' || lexical.startsWith('../')) throw escapes();
  const lookup = fsTreeLookup(realRoot);
  const unitDepth = options.perCheckout === true ? 1 : 0;
  const resolved = resolveTreeLink(lookup, relative, { unitDepth });
  if (!resolved.ok || !resolveTreeLink(lookup, lexical, { unitDepth }).ok)
    throw new ContainmentError(
      `${linkOutsideMessage(relative)} (use a workspace-relative path such as src/file.ts)`,
    );
  return path.join(realRoot, ...resolved.components);
}

/** True when `candidate` is inside `root` after normalization (no fs access). */
export function isWithin(root: string, candidate: string): boolean {
  const resolved = path.resolve(root, candidate);
  const rel = path.relative(path.resolve(root), resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The only permitted repository command is the operator-configured test
 * command. Comparison is on tokenized argv (whitespace split): the requested
 * command must equal the configured command exactly. No extra flags, pipes,
 * redirects, or command chaining are permitted.
 */
export function assertCommandAllowed(configured: string, requested: string): string[] {
  const want = tokenize(configured);
  const got = tokenize(requested);
  if (want.length === 0) {
    throw new ContainmentError('no test command is configured');
  }
  if (got.length !== want.length || !got.every((token, index) => token === want[index])) {
    throw new ContainmentError(
      `only the configured test command may run (requested: ${requested.slice(0, 120)})`,
    );
  }
  return got;
}

function tokenize(command: string): string[] {
  // Shell-word splitting honoring single/double quotes and backslash
  // escapes, so quoted segments (e.g. node -e "…") survive intact.
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;
  let hasContent = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      hasContent = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (quote !== null) {
    throw new ContainmentError('unterminated quote in command');
  }
  if (escaped) {
    current += '\\';
  }
  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

/** Names that must never appear in a repository command environment. */ const FORBIDDEN_ENV = [
  'SERVICE_TOKEN',
  'SUPPORT_AGENT_SERVICE_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  ...MODEL_SETTING_NAMES,
  'OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'GITLAB_TOKEN',
  'GLAB_TOKEN',
  'ADMIN_INTERNAL_TOKEN',
  'ADMIN_URL',
];

export function assertRepoEnvIsolated(env: Record<string, string>): void {
  for (const name of FORBIDDEN_ENV) {
    if (env[name] !== undefined) {
      throw new ContainmentError(`repository environment must not contain ${name}`);
    }
  }
}

/**
 * Minimal environment for repository commands: PATH/HOME/LANG plus CI
 * markers only. Never inherits the runner process environment (which carries
 * service and provider settings).
 */
export function buildRepoEnv(args: { pathValue: string; homeDir: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: args.pathValue,
    HOME: args.homeDir,
    LANG: 'C.UTF-8',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_NOGLOBAL: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    // Node/npm otherwise materialize hundreds of internal bytecode-cache
    // files under the sandbox /tmp. Those are not task outputs and can crowd
    // the bounded tree reconciliation after only a few local commands.
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
  // Preserve proxy *removal*: repository commands get no proxy variables, so
  // a fixture that needs no network cannot accidentally inherit a route. (No
  // full network-namespace isolation is claimed; see the containment report.)
  return env;
}
