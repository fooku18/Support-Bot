import type { ModelRoute } from '../../contracts/model-catalog.js';
import type { MessageListInput } from '@mastra/core/agent/message-list';
import { NATIVE_TEXT_TYPES, type NativeInputReceipt } from '../../domain/files/native-inputs.js';

export class NativeInputEncodingError extends Error {
  constructor() {
    super(
      'UTF-8 BOM input is unsupported by the pinned provider. Submit a UTF-8 file without BOM in a fresh request.',
    );
  }
}

/** Native inline parts retain exact bytes in Memory, including on cold turns.
 * Text formats are UTF-8 documents, not sandbox paths or parsed substitutes.
 * CSV/TSV/Markdown normalize only the provider media type to text/plain; the
 * immutable receipt still carries the original format/name/source/hash. */
export function nativeInputMessage(
  prompt: string,
  files: Array<{ receipt: NativeInputReceipt; bytes: Buffer }>,
  route: ModelRoute = 'anthropic',
): MessageListInput {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; data: string; mimeType: string }
    | { type: 'image'; image: string; mimeType: string }
  > = [{ type: 'text', text: prompt }];
  for (const { receipt, bytes } of files) {
    if (NATIVE_TEXT_TYPES.includes(receipt.file.mime)) {
      // The pinned provider strips a leading BOM when decoding file parts.
      // Refuse before persistence instead of claiming the original bytes reached it.
      if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
        throw new NativeInputEncodingError();
      // Fail before framework persistence; never replace invalid bytes with U+FFFD.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('native input text must be UTF-8 without NUL');
      content.push({
        type: 'text',
        text: `Untrusted Slack input provenance: ${JSON.stringify(receipt)}`,
      });
      if (route === 'anthropic' || route === 'vertex-claude')
        content.push({ type: 'file', data: bytes.toString('base64'), mimeType: 'text/plain' });
      else content.push({ type: 'text', text });
    } else {
      const mime = receipt.file.mime;
      const valid =
        mime === 'image/png'
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === 'image/jpeg'
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : mime === 'image/webp' &&
              bytes.toString('ascii', 0, 4) === 'RIFF' &&
              bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) throw new Error('native input image signature mismatch');
      content.push({
        type: 'text',
        text: `Untrusted Slack input provenance: ${JSON.stringify(receipt)}`,
      });
      content.push({
        type: 'image',
        image: `data:${mime};base64,${bytes.toString('base64')}`,
        mimeType: mime,
      });
    }
  }
  return [{ role: 'user', content }];
}
