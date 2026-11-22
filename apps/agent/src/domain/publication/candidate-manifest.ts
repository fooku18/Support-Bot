/** Content manifests bind verification and publication to the exact candidate. */
import {
  buildTreeManifest,
  buildTreeManifestAsync,
  manifestDigest,
  type TransferPolicy,
  type TreeManifest,
} from './transfer.js';
export interface WorkExecResult {
  status: 'completed' | 'failed' | 'timed_out' | 'not_run';
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
}
export function buildCandidateManifest(
  workspaceDir: string,
  transfer: TransferPolicy,
): { manifest: TreeManifest; digest: string } {
  const manifest = buildTreeManifest(workspaceDir, transfer, 'checkout');
  return { manifest, digest: manifestDigest(manifest) };
}

/** `buildCandidateManifest` without blocking the event loop (publication). */
export async function buildCandidateManifestAsync(
  workspaceDir: string,
  transfer: TransferPolicy,
): Promise<{ manifest: TreeManifest; digest: string }> {
  const manifest = await buildTreeManifestAsync(workspaceDir, transfer, 'checkout');
  return { manifest, digest: manifestDigest(manifest) };
}
