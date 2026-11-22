import type { ModelRoute } from '../../contracts/model-catalog.js';

/** Local transport and attachment limits; the provider owns token accounting. */
export const MAX_MODEL_REQUEST_BYTES = 32 * 1024 ** 2;

const REASONS = {
  bytes: 'serialized model request exceeds 32 MiB',
  images: 'model request exceeds 20 images',
  document: 'native PDF route is not qualified; use sandbox page preparation',
  nesting: 'model request nesting exceeds bounds',
  json: 'model request must be a JSON object',
  media: 'model request contains unsupported or remote media',
} as const;

export class ModelRequestAdmissionError extends Error {
  constructor(readonly reason: keyof typeof REASONS) {
    super(`model_request_${reason}: ${REASONS[reason]}`);
    this.name = 'ModelRequestAdmissionError';
  }
}

export function admitModelRequest(
  body: Buffer,
  nativeTextDocuments = false,
  route: ModelRoute = 'anthropic',
): Record<string, unknown> {
  if (body.length > MAX_MODEL_REQUEST_BYTES) throw new ModelRequestAdmissionError('bytes');
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    request = parsed as Record<string, unknown>;
  } catch {
    throw new ModelRequestAdmissionError('json');
  }
  let images = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 100) throw new ModelRequestAdmissionError('nesting');
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (
      object.type === 'image' ||
      object.type === 'input_image' ||
      Object.hasOwn(object, 'inlineData')
    ) {
      if (++images > 20) throw new ModelRequestAdmissionError('images');
      const source = object.source as Record<string, unknown> | undefined;
      if (
        (object.type === 'image' && source?.type === 'url') ||
        (object.type === 'input_image' &&
          (typeof object.image_url !== 'string' ||
            !/^data:image\/(?:png|jpeg|webp);base64,/.test(object.image_url))) ||
        (object.inlineData &&
          !/^image\/(?:png|jpeg|webp)$/.test(
            String((object.inlineData as Record<string, unknown>).mimeType),
          ))
      )
        throw new ModelRequestAdmissionError('media');
      return;
    }
    if (object.type === 'input_file' || Object.hasOwn(object, 'fileData'))
      throw new ModelRequestAdmissionError('media');
    if (object.type === 'document') {
      const source = object.source as Record<string, unknown> | undefined;
      if (
        !nativeTextDocuments ||
        source?.type !== 'text' ||
        source.media_type !== 'text/plain' ||
        typeof source.data !== 'string' ||
        Buffer.byteLength(source.data) > 200 * 1024
      )
        throw new ModelRequestAdmissionError('document');
    }
    for (const child of Object.values(object)) walk(child, depth + 1);
  };
  if (route === 'openai') walk(request.input, 0);
  else if (route === 'vertex-gemini') {
    walk(request.contents, 0);
    walk(request.systemInstruction, 0);
  } else {
    walk(request.messages, 0);
    walk(request.system, 0);
  }
  return request;
}
