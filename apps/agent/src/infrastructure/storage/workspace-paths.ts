/** Stable retained workspace paths; IDs come from trusted application identity. */
import path from 'node:path';
export interface WorkspacePaths {
  root: string;
  /** Repository checkouts owned by the native Workspace. */
  checkouts: string;
  tmp: string;
}

export function workspacePaths(storageDir: string, workspaceId: string): WorkspacePaths {
  const root = path.join(storageDir, 'workspaces', workspaceId);
  return {
    root,
    checkouts: path.join(root, 'checkouts'),
    tmp: path.join(root, 'tmp'),
  };
}
