import { describe, expect, it } from 'vitest';
import {
  approvedTransportUrl,
  checkoutSlug,
  identityFromProject,
  taskBranchName,
  validateTargetBranch,
  GitLabPolicyError,
} from '../../../src/domain/publication/gitlab-policy.js';

describe('GitLab destination policy (token-bounded, configured host)', () => {
  it("derives the identity from GitLab's own project answer on the configured host", () => {
    const identity = identityFromProject(
      'GitLab.com',
      { id: 100001, path_with_namespace: 'example-group/test' },
      'main',
    );
    expect(identity).toEqual({
      host: 'gitlab.com',
      projectId: 100001,
      canonicalPath: 'example-group/test',
      transportUrl: 'https://gitlab.com/example-group/test.git',
      targetBranch: 'main',
    });
    expect(approvedTransportUrl('gitlab.com', 'a/b')).toBe('https://gitlab.com/a/b.git');
  });

  it('rejects answers without a numeric ID, unsupported paths, and non-host values', () => {
    for (const project of [
      { id: '1', path_with_namespace: 'a/b' },
      { id: 0, path_with_namespace: 'a/b' },
      { id: 1, path_with_namespace: 'single' },
      { id: 1, path_with_namespace: 'a/../b' },
      { id: 1, path_with_namespace: 'https://evil/a/b' },
    ]) {
      expect(() => identityFromProject('gitlab.com', project, 'main')).toThrow(GitLabPolicyError);
    }
    expect(() =>
      identityFromProject('user:pass@gitlab.com', { id: 1, path_with_namespace: 'a/b' }, 'main'),
    ).toThrow(/host name/);
  });

  it('accepts plain target branches and never support-agent/ targets', () => {
    expect(validateTargetBranch('release/2026.09')).toBe('release/2026.09');
    for (const branch of [
      'support-agent/0123456789abcdef',
      '../main',
      '-f',
      'a b',
      '',
      '/main',
      'main/',
      'a//b',
    ]) {
      expect(() => validateTargetBranch(branch), branch).toThrow(GitLabPolicyError);
    }
  });

  it('derives opaque task branches and checkout slugs (no Slack text)', () => {
    expect(taskBranchName('0123456789abcdef0123')).toBe('support-agent/0123456789abcdef');
    expect(() => taskBranchName('Robert; rm -rf')).toThrow(GitLabPolicyError);
    expect(checkoutSlug('group/sub/app')).toBe('group__sub__app');
  });
});
