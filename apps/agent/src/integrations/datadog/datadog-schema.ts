/**
 * Argument validation for Datadog MCP tools against the upstream JSON schema
 * pinned by readiness. The model-facing SDK schema is a passthrough, so this
 * is where invalid arguments are refused (in the broker before dispatch and
 * again in the runtime).
 */
import { Ajv, type ValidateFunction } from 'ajv';

const MAX_ARGUMENT_BYTES = 64_000;

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const compiled = new WeakMap<object, ValidateFunction | Error>();

export class DatadogArgumentError extends Error {}

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  let entry = compiled.get(schema);
  if (entry === undefined) {
    try {
      entry = ajv.compile(schema);
    } catch {
      entry = new Error('the pinned upstream schema cannot be compiled');
    }
    compiled.set(schema, entry);
  }
  if (entry instanceof Error) throw new DatadogArgumentError(entry.message);
  return entry;
}

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
  const validate = validatorFor(schema);
  // Validate a JSON copy: the upstream sees exactly what was checked.
  const copy = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  if (!validate(copy)) {
    const first = validate.errors?.[0];
    const where = first?.instancePath ? `${first.instancePath} ` : '';
    throw new DatadogArgumentError(
      `arguments do not match the tool schema: ${where}${first?.message ?? 'invalid'}`.slice(
        0,
        300,
      ),
    );
  }
  return copy;
}
