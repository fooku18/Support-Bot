/**
 * Argument validation for Datadog MCP tools against the upstream JSON schema
 * pinned by readiness. The model-facing SDK schema is a passthrough, so this
 * is where invalid arguments are refused (in the broker before dispatch and
 * again in the runtime).
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';

const MAX_ARGUMENT_BYTES = 64_000;
const MAX_COMPILED_SCHEMAS = 2_000;
const UNCOMPILABLE = 'the pinned upstream schema cannot be compiled';

export class DatadogArgumentError extends Error {}

export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((key) => [key, canonicalJson(obj[key])]),
  );
}

const newAjv = () =>
  new Ajv({ strict: false, allErrors: false, validateFormats: false, validateSchema: false });
let ajv = newAjv();
let compiled = new Map<string, ValidateFunction | null>();

const schemaKey = (schema: object): string => JSON.stringify(canonicalJson(schema));

function validatorFor(key: string): ValidateFunction | null {
  let entry = compiled.get(key);
  if (entry === undefined) {
    if (compiled.size >= MAX_COMPILED_SCHEMAS) {
      ajv = newAjv();
      compiled = new Map();
    }
    const copy = JSON.parse(key) as object;
    try {
      entry = ajv.compile(copy);
    } catch {
      entry = null;
    } finally {
      ajv.removeSchema(copy);
    }
    compiled.set(key, entry);
  }
  return entry;
}

function schemaError(validate: ValidateFunction): string {
  const first = validate.errors?.[0];
  return `${first?.instancePath ? `${first.instancePath} ` : ''}${first?.message ?? 'invalid'}`;
}

/** The MCP client's output-schema validator, sharing the content-keyed compile cache. */
export const datadogOutputValidator: jsonSchemaValidator = {
  getValidator<T>(schema: object) {
    const key = schemaKey(schema);
    return (input: unknown) => {
      const validate = validatorFor(key);
      if (!validate) return { valid: false as const, data: undefined, errorMessage: UNCOMPILABLE };
      if (validate(input))
        return { valid: true as const, data: input as T, errorMessage: undefined };
      return {
        valid: false as const,
        data: undefined,
        errorMessage: schemaError(validate).slice(0, 300),
      };
    };
  },
};

/** Returns the arguments as a plain object, or throws a bounded, model-safe reason. */
export function validateDatadogArguments(
  schema: Record<string, unknown>,
  args: unknown,
): Record<string, unknown> {
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input))
    throw new DatadogArgumentError('arguments must be an object');
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(input));
  } catch {
    throw new DatadogArgumentError('arguments must be JSON');
  }
  if (size > MAX_ARGUMENT_BYTES)
    throw new DatadogArgumentError(`arguments exceed ${MAX_ARGUMENT_BYTES} bytes`);
  const validate = validatorFor(schemaKey(schema));
  if (!validate) throw new DatadogArgumentError(UNCOMPILABLE);
  // Validate a JSON copy: the upstream sees exactly what was checked.
  const copy = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  if (!validate(copy))
    throw new DatadogArgumentError(
      `arguments do not match the tool schema: ${schemaError(validate)}`.slice(0, 300),
    );
  return copy;
}
