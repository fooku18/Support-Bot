/**
 * Pinned CLI artifact manifest (packaged-CLI/ENV-auth plan): cross-checks
 * deploy/docker/cli-tools-manifest.json against the Dockerfile build arguments so the
 * checked-in provenance record and the actual packaging never drift. Pure file
 * checks (no Docker, no network). The acli binary was removed: Atlassian access
 * is scoped read-only REST from the cli-runtime Node process.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface Manifest {
  manifestVersion: number;
  tools: Record<
    string,
    {
      version: string;
      versionOutput?: string;
      provenance: string;
      tokenType?: string;
      architectures: Record<string, { url: string; sha256: string }>;
    }
  >;
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const manifest: Manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'deploy/docker', 'cli-tools-manifest.json'), 'utf8'),
);
const dockerfile = readFileSync(path.join(REPO_ROOT, 'deploy/Dockerfile'), 'utf8');

function dockerArg(name: string): string {
  const match = new RegExp(`^ARG ${name}=([^\\s]+)$`, 'm').exec(dockerfile);
  expect(match, `Dockerfile ARG ${name}`).not.toBeNull();
  return match![1] ?? '';
}

describe('pinned CLI artifact manifest', () => {
  it('manifest versions and digests match the Dockerfile build arguments', () => {
    const glab = manifest.tools.glab!;
    expect(glab.version).toBe(dockerArg('GLAB_VERSION'));
    expect(glab.architectures.amd64!.sha256).toBe(dockerArg('GLAB_SHA256_AMD64'));
    expect(glab.architectures.arm64!.sha256).toBe(dockerArg('GLAB_SHA256_ARM64'));
    expect(Object.keys(manifest.tools)).toEqual(['glab']);
  });

  it('validates and checksum-verifies the selected glab release', () => {
    // The download is always checksum-verified, the values are validated,
    // and the installed binary must report the selected version.
    expect(dockerfile).toContain('glab_sha="${GLAB_SHA256_AMD64}"');
    expect(dockerfile).toContain('glab_sha="${GLAB_SHA256_ARM64}"');
    expect(dockerfile).toContain(`grep -Eqx '[0-9a-f]{64}'`);
    expect(dockerfile).toContain('echo "${glab_sha}  /tmp/glab.tar.gz" | sha256sum -c -');
    expect(dockerfile).toContain('glab --version | grep -qx "glab ${GLAB_VERSION}.*"');
    const instructions = dockerfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(instructions).not.toMatch(/releases\/latest|\/latest\//);
  });

  it('records exact immutable artifacts (no moving /latest/ URLs) with full digests and provenance', () => {
    for (const [name, toolDef] of Object.entries(manifest.tools)) {
      expect(toolDef!.provenance.length).toBeGreaterThan(20);
      for (const [arch, artifact] of Object.entries(toolDef!.architectures)) {
        expect(artifact!.url, `${name}/${arch}`).not.toMatch(/latest/);
        expect(artifact!.url, `${name}/${arch}`).toContain(toolDef!.version);
        expect(artifact!.sha256, `${name}/${arch}`).toMatch(/^[0-9a-f]{64}$/);
        expect(artifact!.url, `${name}/${arch}`).toMatch(/^https:\/\//);
      }
    }
  });

  it('packages the glab binary only into the cli-runtime target', () => {
    expect(dockerfile).toContain('FROM cli-tools AS cli-runtime');
    for (const target of ['adapter', 'admin', 'native-answer', 'native-coding']) {
      const stage = dockerfile
        .split(new RegExp(`^FROM [^\\n]+ AS ${target}\\n`, 'm'))[1]
        ?.split(/^FROM /m)[0];
      expect(stage, `packaged ${target} stage`).toBeDefined();
      expect(stage).not.toMatch(/(?:COPY|install)[^\n]*glab|COPY --from=cli-tools/i);
    }
    expect(dockerfile).not.toMatch(/acli/i);
  });
});
