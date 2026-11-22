import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import type { WorkspaceFilesystem } from '@mastra/core/workspace';
import { z } from 'zod';
import { NATIVE_EXPORT_BYTES, nativeExportName } from '../../domain/delivery/native-exports.js';

/** Workspace owns file creation/editing/containment. Explicit designation takes
 * an immutable bounded snapshot; later edits cannot change delivered bytes. */
export function nativeExportTool(options: {
  filesystem: WorkspaceFilesystem;
  authorize(): Promise<void>;
  register(file: { path: string; name: string; sha256: string; bytes: Buffer }): Promise<unknown>;
}) {
  return createTool({
    id: 'export_file',
    description:
      'Designate a Workspace file for delivery to the requester in Slack. Snapshots exact bytes now; maximum four files of 2 MiB each per request. Does not publish to GitLab. Only use when the requester asks for a file.',
    inputSchema: z.object({
      path: z.string().min(1).max(1024),
      name: z.string().min(1).max(160).optional(),
    }),
    execute: async (args) => {
      await options.authorize();
      if (
        path.isAbsolute(args.path) ||
        args.path.split(/[\\/]/).some((p) => ['..', '.git'].includes(p))
      )
        throw new Error('export requires a relative Workspace file');
      const name = nativeExportName(args.name ?? path.basename(args.path));
      const stat = await options.filesystem.stat(args.path);
      if (stat.type !== 'file' || stat.size < 1 || stat.size > NATIVE_EXPORT_BYTES)
        throw new Error('export file bounds');
      const bytes = Buffer.from(await options.filesystem.readFile(args.path));
      if (bytes.length !== stat.size || bytes.length > NATIVE_EXPORT_BYTES)
        throw new Error('export file changed during read');
      await options.authorize();
      return options.register({
        path: args.path,
        name,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    },
  });
}
