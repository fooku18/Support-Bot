/** GENERATED from apps/agent/src/domain/delivery/native-exports.ts; run npm run generate:protocol. */
import { createHash } from 'node:crypto';

export const NATIVE_EXPORT_COUNT = 4;
export const NATIVE_EXPORT_BYTES = 2 * 1024 ** 2;
export interface NativeExport {
  id: string;
  name: string;
  sha256: string;
  bytes: number;
  data: string;
}
export interface NativeExportReceipt {
  id: string;
  sha256: string;
  bytes: number;
  fileId: string;
  permalink: string;
}
export function nativeExportName(name: string) {
  if (!name || name.length > 160 || /[\p{Cc}/\\]/u.test(name) || ['.', '..'].includes(name))
    throw new Error('invalid export name');
  return name;
}
export function nativeExportBytes(file: NativeExport): Buffer {
  nativeExportName(file.name);
  if (
    !/^[a-f0-9]{64}$/.test(file.id) ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 1 ||
    file.bytes > NATIVE_EXPORT_BYTES ||
    typeof file.data !== 'string' ||
    file.data.length > Math.ceil(NATIVE_EXPORT_BYTES / 3) * 4
  )
    throw new Error('invalid export bounds');
  const bytes = Buffer.from(file.data, 'base64');
  if (
    bytes.length !== file.bytes ||
    bytes.toString('base64') !== file.data ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new Error('export byte identity mismatch');
  return bytes;
}
