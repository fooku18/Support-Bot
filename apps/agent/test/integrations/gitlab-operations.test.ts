import { describe, expect, it } from 'vitest';
import {
  GITLAB_CONTRACT_VERSION,
  GITLAB_CONTROLLER_OPERATIONS,
  GITLAB_OPERATION_METADATA,
  GITLAB_OPERATIONS,
  GITLAB_READ_OPERATIONS,
  GITLAB_WRITE_OPERATIONS,
  isGitlabOperationName,
  isGitlabTransportOperationName,
  isGitlabWriteOperation,
  operationProject,
  operationScopeLabel,
  parseGroupRef,
  parseProjectRef,
  validateGitlabOperation,
  validateTransportGitlabArgs,
} from '../../src/integrations/gitlab/gitlab-operations.js';
import {
  buildGitlabRequest,
  cleanTraceText,
  decodeRepositoryFileOutput,
  gitlabUrl,
  MAX_TRACE_BYTES,
  normalizeGitlabOutput,
  renderGitlabResultText,
  type GitlabTraceData,
} from '../../src/integrations/gitlab/gitlab-rest-adapter.js';
import {
  FAKE_FLAKY_TEST,
  FAKE_TRACE_TOKEN,
  fakeJobTrace,
  runtimeTraceAnswer,
} from './helpers/gitlab.js';

const request = (operation: string, args: Record<string, unknown>) =>
  buildGitlabRequest(validateGitlabOperation(operation, args));

describe('typed GitLab operations (contract v5)', () => {
  it('exposes the read and write catalog under contract v5', () => {
    expect(GITLAB_CONTRACT_VERSION).toBe(6);
    expect(GITLAB_READ_OPERATIONS).toHaveLength(21);
    expect(GITLAB_READ_OPERATIONS).toContain('get_job_trace');
    expect(GITLAB_WRITE_OPERATIONS).toEqual([
      'create_merge_request_note',
      'create_issue_note',
      'create_issue',
      'update_merge_request',
      'create_merge_request',
      'retry_job',
      'create_pipeline',
    ]);
    expect(GITLAB_OPERATIONS).toHaveLength(28);
    for (const name of GITLAB_OPERATIONS) expect(isGitlabOperationName(name)).toBe(true);
    for (const name of GITLAB_WRITE_OPERATIONS) expect(isGitlabWriteOperation(name)).toBe(true);
    expect(isGitlabWriteOperation('get_project')).toBe(false);
    // Not part of the contract: merging, deleting, settings, raw access.
    for (const name of ['merge_merge_request', 'delete_branch', 'glab', 'api', 'graphql'])
      expect(isGitlabOperationName(name)).toBe(false);
  });

  it('serves get_current_user (GET /user) to controller code only, never as a model tool', () => {
    expect(GITLAB_CONTROLLER_OPERATIONS).toEqual(['get_current_user']);
    expect(isGitlabOperationName('get_current_user')).toBe(false);
    expect(isGitlabTransportOperationName('get_current_user')).toBe(true);
    expect(isGitlabTransportOperationName('get_project')).toBe(true);
    expect(isGitlabTransportOperationName('api')).toBe(false);
    expect(request('get_current_user', {})).toMatchObject({
      method: 'GET',
      endpoint: 'user',
      body: null,
    });
    expect(() => validateGitlabOperation('get_current_user', { project: 'g/p' })).toThrow(
      /unknown argument "project"/,
    );
    expect(validateTransportGitlabArgs('get_current_user', { kind: 'get_current_user' })).toEqual({
      kind: 'get_current_user',
    });
    const user = normalizeGitlabOutput({
      operation: 'get_current_user',
      project: 'instance',
      httpStatus: 200,
      status: 'completed',
      output: JSON.stringify({
        id: 7,
        username: 'bot',
        name: 'Bot',
        email: 'bot@example.test',
        commit_email: 'bot-commits@example.test',
        public_email: '',
        private_profile: false,
        identities: [{ provider: 'ldap' }],
      }),
    });
    expect(user.data).toEqual({
      id: 7,
      username: 'bot',
      name: 'Bot',
      email: 'bot@example.test',
      commit_email: 'bot-commits@example.test',
      public_email: '',
    });
  });

  it('accepts project paths and numeric IDs and rejects URLs, hosts, traversal, and encodings', () => {
    expect(parseProjectRef('example-group/test', 'op')).toBe('example-group/test');
    expect(parseProjectRef('group/sub.group/my-app_2', 'op')).toBe('group/sub.group/my-app_2');
    expect(parseProjectRef(100001, 'op')).toBe('100001');
    expect(parseProjectRef('100001', 'op')).toBe('100001');
    for (const hostile of [
      'https://gitlab.com/group/app',
      'gitlab.com:group/app',
      'git@gitlab.com:group/app',
      'group/../other/app',
      '../app',
      'group//app',
      '/group/app',
      'group/app/',
      'group%2Fapp',
      'group/app%2F..%2Fx',
      'group\\app',
      'group/app?x=1',
      'group/app#frag',
      'group/app.git',
      'group/.hidden',
      'app',
      'group/ app',
      '',
      0,
      -1,
      1.5,
      null,
      { path: 'group/app' },
    ]) {
      expect(() => parseProjectRef(hostile, 'op'), JSON.stringify(hostile)).toThrow();
    }
  });

  it('validates every operation strictly and requires project where it addresses one', () => {
    expect(validateGitlabOperation('get_project', { project: 'g/p' })).toEqual({
      kind: 'get_project',
      project: 'g/p',
    });
    expect(() => validateGitlabOperation('get_project', {})).toThrow(/project/);
    expect(() => validateGitlabOperation('get_project', { project: 'g/p', host: 'x' })).toThrow(
      /unknown argument/,
    );
    expect(() => validateGitlabOperation('nope', {})).toThrow(/unknown GitLab operation/);
    expect(() => validateGitlabOperation('get_issue', { project: 'g/p' })).toThrow(/issue_iid/);
    expect(() => validateGitlabOperation('get_issue', { project: 'g/p', issue_iid: -1 })).toThrow(
      /positive/,
    );
    // Project search scopes vs instance-wide scopes.
    expect(() =>
      validateGitlabOperation('search', { project: 'g/p', scope: 'projects', search: 'x' }),
    ).toThrow(/scope/);
    expect(validateGitlabOperation('search', { scope: 'projects', search: 'x' })).toMatchObject({
      kind: 'search',
      scope: 'projects',
    });
    expect(() => validateGitlabOperation('search', { project: 'g/p', scope: 'issues' })).toThrow(
      /search is required/,
    );
    expect(() =>
      validateGitlabOperation('list_merge_requests', { project: 'g/p', state: 'reopened' }),
    ).toThrow(/state/);
    expect(() =>
      validateGitlabOperation('list_pipelines', { project: 'g/p', status: 'bogus' }),
    ).toThrow(/status/);
    expect(() => validateGitlabOperation('list_repository_tree', { project: 'g/p' })).toThrow(
      /ref is required/,
    );
    expect(() => validateGitlabOperation('get_commit', { project: 'g/p', sha: 'zzzz' })).toThrow(
      /sha/,
    );
    expect(() =>
      validateGitlabOperation('search', { project: 'g/p', scope: 'issues', search: 'x', page: 0 }),
    ).toThrow(/page/);
    expect(() =>
      validateGitlabOperation('list_branches', { project: 'g/p', per_page: 101 }),
    ).toThrow(/per_page/);
    // Without a phrase: the first 50 member projects (list once, never guess).
    expect(validateGitlabOperation('list_projects', {})).toEqual({
      kind: 'list_projects',
      page: 1,
      per_page: 50,
    });
    expect(validateGitlabOperation('list_projects', { per_page: 5 })).toMatchObject({
      per_page: 5,
    });
    expect(validateGitlabOperation('list_projects', { search: 'app' })).toMatchObject({
      kind: 'list_projects',
      search: 'app',
    });
  });

  it('validates write bodies, labels, users, and branch rules', () => {
    expect(() =>
      validateGitlabOperation('create_merge_request_note', {
        project: 'g/p',
        merge_request_iid: 1,
        body: '   ',
      }),
    ).toThrow(/body/);
    expect(() =>
      validateGitlabOperation('create_issue_note', {
        project: 'g/p',
        issue_iid: 1,
        body: 'x'.repeat(60_001),
      }),
    ).toThrow(/body/);
    expect(() =>
      validateGitlabOperation('create_issue', { project: 'g/p', title: 't', labels: ['a,b'] }),
    ).toThrow(/labels/);
    expect(() =>
      validateGitlabOperation('create_issue', { project: 'g/p', title: 't', assignee_ids: [0] }),
    ).toThrow(/assignee_ids/);
    expect(() =>
      validateGitlabOperation('update_merge_request', { project: 'g/p', merge_request_iid: 2 }),
    ).toThrow(/nothing to update/);
    expect(() =>
      validateGitlabOperation('update_merge_request', {
        project: 'g/p',
        merge_request_iid: 2,
        state_event: 'merge',
      }),
    ).toThrow(/state_event/);
    expect(() =>
      validateGitlabOperation('create_merge_request', {
        project: 'g/p',
        source_branch: 'feature',
        target_branch: 'feature',
        title: 't',
      }),
    ).toThrow(/must differ/);
    expect(() =>
      validateGitlabOperation('create_merge_request', {
        project: 'g/p',
        source_branch: 'feature',
        target_branch: 'support-agent/0123456789abcdef',
        title: 't',
      }),
    ).toThrow(/never merge targets/);
    expect(() =>
      validateGitlabOperation('create_pipeline', { project: 'g/p', ref: 'main\nX' }),
    ).toThrow(/unsupported characters/);
  });

  it('builds exact methods, endpoints, and JSON bodies with literal URL encoding', () => {
    const cases: Array<[string, Record<string, unknown>, string, string, unknown]> = [
      ['get_project', { project: 'group/sub/app' }, 'GET', 'projects/group%2Fsub%2Fapp', null],
      ['get_project', { project: 42 }, 'GET', 'projects/42', null],
      [
        'list_projects',
        { search: 'a b' },
        'GET',
        'projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&search=a%20b&page=1&per_page=20',
        null,
      ],
      [
        'search',
        { scope: 'blobs', search: '@x --field=y' },
        'GET',
        `search?scope=blobs&search=${encodeURIComponent('@x --field=y')}&page=1&per_page=20`,
        null,
      ],
      [
        'search',
        { project: 'g/p', scope: 'commits', search: 'fix' },
        'GET',
        'projects/g%2Fp/search?scope=commits&search=fix&page=1&per_page=20',
        null,
      ],
      [
        'list_branches',
        { project: 'g/p', search: 'feat' },
        'GET',
        'projects/g%2Fp/repository/branches?search=feat&page=1&per_page=20',
        null,
      ],
      [
        'list_merge_requests',
        { project: 'g/p', state: 'all', source_branch: 'support-agent/abc', target_branch: 'main' },
        'GET',
        'projects/g%2Fp/merge_requests?source_branch=support-agent%2Fabc&target_branch=main&order_by=updated_at&sort=desc&page=1&per_page=20',
        null,
      ],
      [
        'get_repository_file',
        { project: 'g/p', file_path: 'dir/file name.ts', ref: 'feature/x' },
        'GET',
        'projects/g%2Fp/repository/files/dir%2Ffile%20name.ts?ref=feature%2Fx',
        null,
      ],
      [
        'get_issue_notes',
        { project: 'g/p', issue_iid: 3 },
        'GET',
        'projects/g%2Fp/issues/3/notes?page=1&per_page=20&sort=asc&order_by=created_at',
        null,
      ],
      [
        'create_merge_request_note',
        { project: 'g/p', merge_request_iid: 12, body: 'Looks good' },
        'POST',
        'projects/g%2Fp/merge_requests/12/notes',
        { body: 'Looks good' },
      ],
      [
        'create_issue_note',
        { project: 'g/p', issue_iid: 5, body: 'Noted' },
        'POST',
        'projects/g%2Fp/issues/5/notes',
        { body: 'Noted' },
      ],
      [
        'create_issue',
        { project: 'g/p', title: 'Bug', description: 'd', labels: ['a', 'b'], assignee_ids: [7] },
        'POST',
        'projects/g%2Fp/issues',
        { title: 'Bug', description: 'd', labels: 'a,b', assignee_ids: [7] },
      ],
      [
        'update_merge_request',
        { project: 'g/p', merge_request_iid: 12, title: 'T', state_event: 'close' },
        'PUT',
        'projects/g%2Fp/merge_requests/12',
        { title: 'T', state_event: 'close' },
      ],
      [
        'create_merge_request',
        { project: 'g/p', source_branch: 'feat', target_branch: 'main', title: 'T' },
        'POST',
        'projects/g%2Fp/merge_requests',
        { source_branch: 'feat', target_branch: 'main', title: 'T', remove_source_branch: false },
      ],
      ['retry_job', { project: 'g/p', job_id: 9 }, 'POST', 'projects/g%2Fp/jobs/9/retry', {}],
      [
        'create_pipeline',
        { project: 'g/p', ref: 'release/1' },
        'POST',
        'projects/g%2Fp/pipeline?ref=release%2F1',
        {},
      ],
    ];
    for (const [operation, args, method, endpoint, body] of cases) {
      const built = request(operation, args);
      expect(built.method, operation).toBe(method);
      expect(built.endpoint, operation).toBe(endpoint);
      expect(built.body, operation).toEqual(body);
    }
  });

  it('pins the host and the API path; nothing can move a request elsewhere', () => {
    const { endpoint } = request('get_repository_file', {
      project: 'group/sub/app',
      file_path: 'docs/on call.md',
      ref: 'release/1',
    });
    expect(gitlabUrl('GitLab.example.com', endpoint).href).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp/repository/files/docs%2Fon%20call.md?ref=release%2F1',
    );
    for (const hostile of [
      '../../admin',
      'projects/../user',
      'projects/%2e%2e/user',
      'projects/..',
      'projects/x#fragment',
      'projects\\x',
    ])
      expect(() => gitlabUrl('gitlab.example.com', hostile), hostile).toThrow(/pinned API surface/);
    for (const host of ['user@evil.example', 'a:b@evil.example', 'evil.example/x?', '', 'a b'])
      expect(() => gitlabUrl(host, 'user'), host).toThrow(/pinned API surface/);
  });

  it('normalizes success and error envelopes, including conflicts and write results', () => {
    const ok = normalizeGitlabOutput({
      operation: 'get_project',
      project: 'group/project',
      httpStatus: 200,
      status: 'completed',
      output: JSON.stringify({
        id: 1,
        path_with_namespace: 'group/project',
        default_branch: 'main',
        web_url: 'https://h/group/project',
        runners_token: 'secret-ish',
      }),
    });
    expect(ok.ok).toBe(true);
    expect(ok.data).toEqual({
      id: 1,
      path_with_namespace: 'group/project',
      default_branch: 'main',
      web_url: 'https://h/group/project',
    });
    const malformed = normalizeGitlabOutput({
      operation: 'get_project',
      project: 'group/project',
      httpStatus: 200,
      status: 'completed',
      output: '{"id":',
    });
    expect(malformed).toMatchObject({ ok: false, errorCategory: 'invalid_response' });
    for (const [httpStatus, category, output] of [
      [404, 'not_found'],
      [401, 'authentication'],
      [403, 'forbidden'],
      [409, 'conflict'],
      [422, 'invalid_input'],
      [400, 'conflict', '{"message":["Another open merge request already exists"]}'],
      [429, 'rate_limit'],
      [501, 'unsupported'],
      [502, 'upstream'],
      [405, 'upstream'],
      [null, 'upstream'],
      // The status decides; words of the answer's text do not.
      [500, 'upstream', '{"message":"upstream said 404 not found, 401 unauthorized"}'],
    ] as const) {
      const failed = normalizeGitlabOutput({
        operation: 'create_issue',
        project: 'group/project',
        status: 'failed',
        httpStatus,
        output: output ?? '',
      });
      expect(failed, String(httpStatus)).toMatchObject({ ok: false, errorCategory: category });
    }
    const note = normalizeGitlabOutput({
      operation: 'create_merge_request_note',
      project: 'group/project',
      httpStatus: 200,
      status: 'completed',
      output: JSON.stringify({
        id: 77,
        body: 'hi',
        author: { id: 1, username: 'bot', email: 'x@y' },
        system: false,
      }),
    });
    expect(note.data).toEqual({
      id: 77,
      body: 'hi',
      author: { id: 1, username: 'bot' },
      system: false,
    });
    const timedOut = normalizeGitlabOutput({
      operation: 'get_project',
      project: 'group/project',
      httpStatus: null,
      status: 'timed_out',
      output: '',
    });
    expect(timedOut).toMatchObject({ ok: false, errorCategory: 'timeout' });
  });

  it('keeps a bounded, scrubbed excerpt of a failure outside the model text', () => {
    const failed = normalizeGitlabOutput({
      operation: 'create_merge_request',
      project: 'company/handbook',
      status: 'failed',
      httpStatus: 500,
      output: `could not decode\n  via https://oauth2:glpat-abcdefghijklmnop@gitlab.example/api   Authorization: Bearer abc.def-123\n${'x'.repeat(2000)}`,
    });
    expect(failed).toMatchObject({
      ok: false,
      errorCategory: 'upstream',
      error: 'GitLab upstream error (HTTP 500)',
    });
    expect(failed.detail).toMatch(
      /^HTTP 500 \| could not decode via https:\/\/\[redacted\]@gitlab\.example\/api Authorization: Bearer \[redacted\]/,
    );
    expect(failed.detail).not.toMatch(/glpat-|abc\.def-123/);
    expect(failed.detail!.length).toBeLessThanOrEqual(500);
    expect(failed.detail).toContain('…');
    expect(renderGitlabResultText(failed)).not.toContain('could not decode');
    const unreached = normalizeGitlabOutput({
      operation: 'create_merge_request',
      project: 'company/handbook',
      status: 'failed',
      httpStatus: null,
      output: '',
      error: 'GitLab could not be reached',
    });
    expect(unreached).toMatchObject({ errorCategory: 'upstream', detail: unreached.error });
    // Successes and timeouts carry no detail.
    expect(
      normalizeGitlabOutput({
        operation: 'get_project',
        project: 'g/p',
        status: 'timed_out',
        httpStatus: null,
        output: '',
      }).detail,
    ).toBeUndefined();
  });

  it('bounds collections and decodes repository files explicitly', () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      id: index,
      iid: index,
      title: `mr ${index}`,
    }));
    const listed = normalizeGitlabOutput({
      operation: 'list_merge_requests',
      project: 'group/project',
      httpStatus: 200,
      status: 'completed',
      output: JSON.stringify(many),
    });
    expect(listed.ok).toBe(true);
    expect((listed.data as unknown[]).length).toBeLessThanOrEqual(100);
    expect(listed.truncated).toBe(true);

    // The tool runtime decodes the file before its redaction; the shared
    // normalization only bounds what the runtime decoded.
    const readFile = (content: Buffer | string, captureBound?: number) =>
      normalizeGitlabOutput({
        operation: 'get_repository_file',
        project: 'group/project',
        httpStatus: 200,
        status: 'completed',
        output: decodeRepositoryFileOutput(
          JSON.stringify({
            file_path: 'hello',
            size: content.length,
            encoding: 'base64',
            content: Buffer.from(content).toString('base64'),
            ref: 'main',
          }),
          captureBound,
        ),
      });
    const file = readFile('amber-falcon-3102\n');
    expect(file.ok).toBe(true);
    expect(file.data).toEqual({
      file_path: 'hello',
      size: 18,
      ref: 'main',
      encoding: 'text',
      content: 'amber-falcon-3102\n',
    });
    const binary = readFile(Buffer.from([0, 1, 2, 3]));
    expect(binary.data).toMatchObject({ content: null, binary: true });
    const long = readFile('x'.repeat(20_000));
    expect((long.data as { content: string }).content).toMatch(
      /^x{12000}\n\[…truncated 8000 chars\]$/,
    );
    expect(long.data).toMatchObject({ content_truncated: true });
    const oversize = readFile('y'.repeat(70_000));
    expect(oversize.data).toMatchObject({
      file_path: 'hello',
      content: null,
      content_truncated: true,
      content_note: expect.stringMatching(/exceeds the 60000-byte bound/),
    });
    const cut = readFile('z', 48_000);
    expect(cut.ok).toBe(true);
    expect(cut.data).toMatchObject({
      content: null,
      content_truncated: true,
      content_note: expect.stringMatching(/48000-byte capture bound/),
    });
    // Base64 the runtime did not decode is withheld, never decoded here.
    const undecoded = normalizeGitlabOutput({
      operation: 'get_repository_file',
      project: 'group/project',
      httpStatus: 200,
      status: 'completed',
      output: JSON.stringify({
        file_path: 'hello',
        encoding: 'base64',
        content: Buffer.from('glpat-undecoded-secret').toString('base64'),
      }),
    });
    expect(undecoded.data).toEqual({
      file_path: 'hello',
      content: null,
      content_note: 'repository file content was not decoded by the tool runtime',
    });
    const blobs = normalizeGitlabOutput({
      operation: 'search',
      project: 'instance',
      httpStatus: 200,
      status: 'completed',
      output: JSON.stringify([{ project_id: 5, path: 'a.ts', data: 'x', ref: 'main', id: null }]),
      scope: 'blobs',
    });
    expect(blobs.data).toEqual([{ project_id: 5, path: 'a.ts', data: 'x', ref: 'main' }]);
  });

  it('re-validates the runner-validated transport shape (matching kind) at the runtime boundary', () => {
    const project = validateGitlabOperation('get_project', { project: 'g/p' });
    expect(validateTransportGitlabArgs('get_project', project)).toEqual(project);
    const note = validateGitlabOperation('create_issue_note', {
      project: 7,
      issue_iid: 2,
      body: 'hello',
    });
    expect(validateTransportGitlabArgs('create_issue_note', note)).toEqual({
      kind: 'create_issue_note',
      project: '7',
      issue_iid: 2,
      body: 'hello',
    });
    expect(() =>
      validateTransportGitlabArgs('get_project', { ...project, kind: 'get_issue' }),
    ).toThrow(/mismatch/);
    expect(() =>
      validateTransportGitlabArgs('get_project', { kind: 'get_project', project: 'g/p', x: 1 }),
    ).toThrow(/unknown argument/);
    expect(() =>
      validateTransportGitlabArgs('get_project', {
        kind: 'get_project',
        project: 'https://evil/g/p',
      }),
    ).toThrow(/project/);
  });

  describe('merge request and issue lists (people, group, instance, dates)', () => {
    const INSTANCE_REFUSAL =
      'list_merge_requests: without project or group the list covers the whole instance and needs at least one of author_username, assignee_username, reviewer_username, search, labels or milestone';

    it('accepts project, group, or no scope, never both, and refuses an unnarrowed instance list', () => {
      expect(
        validateGitlabOperation('list_merge_requests', { author_username: 'alex.rivera' }),
      ).toEqual({
        kind: 'list_merge_requests',
        state: 'opened',
        author_username: 'alex.rivera',
        order_by: 'updated_at',
        sort: 'desc',
        page: 1,
        per_page: 20,
      });
      expect(
        validateGitlabOperation('list_merge_requests', { group: 'example-group', state: 'all' }),
      ).toMatchObject({ group: 'example-group', state: 'all' });
      expect(validateGitlabOperation('list_issues', { group: 42 })).toMatchObject({
        kind: 'list_issues',
        group: '42',
        order_by: 'created_at',
        sort: 'desc',
      });
      expect(() =>
        validateGitlabOperation('list_merge_requests', { project: 'g/p', group: 'g' }),
      ).toThrow('list_merge_requests: give either project or group, not both');
      expect(() => validateGitlabOperation('list_issues', { project: 'g/p', group: 'g' })).toThrow(
        /either project or group/,
      );
      // Decision 3: an unfiltered instance-wide list is refused with an explicit message.
      expect(() => validateGitlabOperation('list_merge_requests', {})).toThrow(INSTANCE_REFUSAL);
      expect(() =>
        validateGitlabOperation('list_merge_requests', {
          state: 'all',
          source_branch: 'main',
          draft: true,
          created_after: '2026-09-01T00:00:00Z',
          labels: [],
        }),
      ).toThrow(INSTANCE_REFUSAL);
      expect(() => validateGitlabOperation('list_issues', { state: 'all' })).toThrow(
        'list_issues: without project or group the list covers the whole instance and needs at least one of author_username, assignee_username, search, labels or milestone',
      );
      for (const narrowing of [
        { author_username: 'a' },
        { assignee_username: 'a' },
        { reviewer_username: 'a' },
        { search: 'fix' },
        { labels: ['bug'] },
        { milestone: 'None' },
      ]) {
        expect(
          validateGitlabOperation('list_merge_requests', narrowing),
          JSON.stringify(narrowing),
        ).not.toHaveProperty('project');
      }
      // Issues have no reviewers.
      expect(() => validateGitlabOperation('list_issues', { reviewer_username: 'a' })).toThrow(
        /unknown argument "reviewer_username"/,
      );
    });

    it('validates groups like projects, except that a top-level group is one segment', () => {
      expect(parseGroupRef('example-group', 'op')).toBe('example-group');
      expect(parseGroupRef('group/sub', 'op')).toBe('group/sub');
      expect(parseGroupRef(77, 'op')).toBe('77');
      for (const hostile of [
        'https://gitlab.com/group',
        'gitlab.com:group',
        'group/../other',
        '..',
        'group%2Fsub',
        'group//sub',
        '/group',
        'group sub',
        'group?x=1',
        '',
        0,
        null,
      ]) {
        expect(() => parseGroupRef(hostile, 'op'), JSON.stringify(hostile)).toThrow(/group/);
      }
      // A project still needs its group.
      expect(() => parseProjectRef('example-group', 'op')).toThrow(/must include its group/);
    });

    it('takes one GitLab username per people filter and rejects IDs and other forms', () => {
      for (const field of ['author_username', 'assignee_username', 'reviewer_username']) {
        expect(
          validateGitlabOperation('list_merge_requests', {
            project: 'g/p',
            [field]: 'alex.rivera',
          }),
        ).toMatchObject({ [field]: 'alex.rivera' });
        for (const bad of [
          '@x',
          'a b',
          'https://gitlab.com/x',
          'gitlab.com/x',
          '-lead',
          '',
          'a'.repeat(256),
          ['a'],
          7,
        ]) {
          expect(
            () => validateGitlabOperation('list_merge_requests', { project: 'g/p', [field]: bad }),
            `${field} ${JSON.stringify(bad)}`,
          ).toThrow(new RegExp(`${field} must be one GitLab username`));
        }
      }
      for (const unknown of [
        'author_id',
        'assignee_id',
        'reviewer_id',
        'approved_by_usernames',
        'not',
        'my_reaction_emoji',
        'scope',
        'wip',
      ]) {
        expect(
          () => validateGitlabOperation('list_merge_requests', { project: 'g/p', [unknown]: 1 }),
          unknown,
        ).toThrow(`list_merge_requests: unknown argument "${unknown}"`);
      }
      expect(() =>
        validateGitlabOperation('list_issues', { project: 'g/p', author_id: 5 }),
      ).toThrow('list_issues: unknown argument "author_id"');
    });

    it('validates timestamps, ordering, draft, and milestone per operation', () => {
      const valid = validateGitlabOperation('list_issues', {
        project: 'g/p',
        created_after: '2026-09-01T00:00:00Z',
        created_before: '2026-09-30T23:59:59.5+02:00',
        updated_after: '2026-01-01T00:00:00Z',
        updated_before: '2026-12-31T00:00:00-05:00',
        order_by: 'due_date',
        sort: 'asc',
        milestone: 'Any',
      });
      expect(valid).toMatchObject({
        created_after: '2026-09-01T00:00:00Z',
        created_before: '2026-09-30T23:59:59.5+02:00',
        updated_after: '2026-01-01T00:00:00Z',
        updated_before: '2026-12-31T00:00:00-05:00',
        order_by: 'due_date',
        sort: 'asc',
        milestone: 'Any',
      });
      for (const bad of [
        'yesterday',
        '2026-09-01',
        '2026-09-01 00:00:00Z',
        '2026-09-01T00:00:00',
        '2026-02-30T00:00:00Z',
        '2026-13-01T00:00:00Z',
        '2026-09-01T25:00:00Z',
        1788220800000,
      ]) {
        expect(
          () =>
            validateGitlabOperation('list_merge_requests', { project: 'g/p', updated_after: bad }),
          JSON.stringify(bad),
        ).toThrow(/updated_after must be an RFC 3339 timestamp/);
      }
      expect(() =>
        validateGitlabOperation('list_merge_requests', { project: 'g/p', order_by: 'due_date' }),
      ).toThrow('list_merge_requests: order_by must be one of created_at, updated_at');
      expect(() =>
        validateGitlabOperation('list_issues', { project: 'g/p', order_by: 'title' }),
      ).toThrow('list_issues: order_by must be one of created_at, updated_at, due_date');
      expect(() =>
        validateGitlabOperation('list_issues', { project: 'g/p', sort: 'DESC' }),
      ).toThrow('list_issues: sort must be one of asc, desc');
      expect(() =>
        validateGitlabOperation('list_merge_requests', { project: 'g/p', draft: 'yes' }),
      ).toThrow('list_merge_requests: draft must be a boolean');
      expect(() => validateGitlabOperation('list_issues', { project: 'g/p', draft: true })).toThrow(
        /unknown argument "draft"/,
      );
      for (const bad of ['', '   ', 'x'.repeat(256), 'a\u0000b', 3]) {
        expect(
          () => validateGitlabOperation('list_merge_requests', { project: 'g/p', milestone: bad }),
          JSON.stringify(bad),
        ).toThrow(/milestone must be a milestone title/);
      }
    });

    it('builds exact endpoints for all three scopes of both lists', () => {
      const cases: Array<[string, Record<string, unknown>, string, string]> = [
        [
          'list_merge_requests',
          {
            project: 'group/sub/app',
            state: 'merged',
            author_username: 'alex.rivera',
            labels: ['a', 'b'],
            draft: true,
          },
          'projects/group%2Fsub%2Fapp/merge_requests?state=merged&author_username=alex.rivera&labels=a%2Cb&wip=yes&order_by=updated_at&sort=desc&page=1&per_page=20',
          'merge_requests@group/sub/app',
        ],
        [
          'list_merge_requests',
          {
            group: 'group/sub',
            state: 'all',
            reviewer_username: 'carol-x',
            draft: false,
            milestone: 'v1 release',
            created_after: '2026-09-01T00:00:00+02:00',
            order_by: 'created_at',
            sort: 'asc',
          },
          'groups/group%2Fsub/merge_requests?reviewer_username=carol-x&milestone=v1%20release&wip=no&created_after=2026-09-01T00%3A00%3A00%2B02%3A00&order_by=created_at&sort=asc&page=1&per_page=20',
          'merge_requests@group:group/sub',
        ],
        [
          'list_merge_requests',
          {
            author_username: 'alex.rivera',
            state: 'all',
            assignee_username: 'bob',
            updated_before: '2026-10-01T00:00:00Z',
            per_page: 1,
          },
          'merge_requests?scope=all&author_username=alex.rivera&assignee_username=bob&updated_before=2026-10-01T00%3A00%3A00Z&order_by=updated_at&sort=desc&page=1&per_page=1',
          'merge_requests@instance',
        ],
        [
          'list_issues',
          { project: 'g/p', state: 'closed', labels: ['bug'], search: 'crash' },
          'projects/g%2Fp/issues?state=closed&search=crash&labels=bug&order_by=created_at&sort=desc&page=1&per_page=20',
          'issues@g/p',
        ],
        [
          'list_issues',
          {
            group: 'example-group',
            created_after: '2026-01-01T00:00:00Z',
            order_by: 'due_date',
            sort: 'asc',
          },
          'groups/example-group/issues?state=opened&created_after=2026-01-01T00%3A00%3A00Z&order_by=due_date&sort=asc&page=1&per_page=20',
          'issues@group:example-group',
        ],
        [
          'list_issues',
          { assignee_username: 'bob', state: 'all', updated_after: '2026-09-01T00:00:00Z' },
          'issues?scope=all&assignee_username=bob&updated_after=2026-09-01T00%3A00%3A00Z&order_by=created_at&sort=desc&page=1&per_page=20',
          'issues@instance',
        ],
      ];
      for (const [operation, args, endpoint, identity] of cases) {
        const built = request(operation, args);
        expect(built.method, endpoint).toBe('GET');
        expect(built.endpoint).toBe(endpoint);
        expect(built.body).toBeNull();
        expect(built.resourceIdentity).toBe(identity);
      }
      // state=all omits state; the instance form always sends scope=all.
      expect(
        request('list_merge_requests', { project: 'g/p', state: 'all' }).endpoint,
      ).not.toContain('state=');
      expect(request('list_issues', { search: 'x' }).endpoint).toMatch(/^issues\?scope=all&/);
    });

    it('labels the evidence scope as project, group:<path>, or instance', () => {
      const project = validateGitlabOperation('list_merge_requests', { project: 'g/p' });
      const group = validateGitlabOperation('list_merge_requests', { group: 'g/sub' });
      const instance = validateGitlabOperation('list_issues', { author_username: 'bob' });
      expect([project, group, instance].map(operationScopeLabel)).toEqual([
        'g/p',
        'group:g/sub',
        'instance',
      ]);
      expect([project, group, instance].map(operationProject)).toEqual(['g/p', null, null]);
      expect(
        operationScopeLabel(validateGitlabOperation('search', { scope: 'projects', search: 'x' })),
      ).toBe('instance');
      expect(operationScopeLabel(validateGitlabOperation('get_project', { project: 9 }))).toBe('9');
    });

    it('projects people, milestone, and the new merge request and issue fields', () => {
      const person = (id: number) => ({
        id,
        username: `user${id}`,
        name: `User ${id}`,
        state: 'active',
        avatar_url: 'https://h/a.png',
        web_url: `https://h/user${id}`,
      });
      const listed = normalizeGitlabOutput({
        operation: 'list_merge_requests',
        project: 'instance',
        httpStatus: 200,
        status: 'completed',
        output: JSON.stringify([
          {
            id: 1,
            iid: 5,
            project_id: 9,
            title: 't',
            state: 'merged',
            author: person(1),
            assignee: person(2),
            assignees: [person(2)],
            reviewers: Array.from({ length: 25 }, (_, index) => person(100 + index)),
            merged_at: '2026-09-02T00:00:00Z',
            closed_at: null,
            merged_by: person(3),
            detailed_merge_status: 'mergeable',
            has_conflicts: false,
            milestone: { id: 4, iid: 1, title: 'v1', state: 'active', web_url: 'https://h/m/1' },
            user_notes_count: 3,
            references: { full: 'g/p!5' },
            time_stats: { total_time_spent: 0 },
            task_completion_status: { count: 0 },
          },
        ]),
      });
      const [mr] = listed.data as Array<Record<string, unknown>>;
      expect(Object.keys(mr!).sort()).toEqual(
        [
          'id',
          'iid',
          'project_id',
          'title',
          'state',
          'author',
          'assignees',
          'reviewers',
          'reviewers_truncated',
          'merged_at',
          'closed_at',
          'detailed_merge_status',
          'has_conflicts',
          'milestone',
          'user_notes_count',
        ].sort(),
      );
      expect(mr!.author).toEqual({ id: 1, username: 'user1', name: 'User 1' });
      expect(mr!.assignees).toEqual([{ id: 2, username: 'user2', name: 'User 2' }]);
      expect(mr!.reviewers).toHaveLength(20);
      expect((mr!.reviewers as unknown[])[19]).toEqual({
        id: 119,
        username: 'user119',
        name: 'User 119',
      });
      expect(mr!.reviewers_truncated).toBe(true);
      expect(mr!.milestone).toEqual({ id: 4, title: 'v1' });

      const issue = normalizeGitlabOutput({
        operation: 'get_issue',
        project: 'g/p',
        httpStatus: 200,
        status: 'completed',
        output: JSON.stringify({
          id: 2,
          iid: 7,
          title: 'bug',
          author: person(1),
          assignees: [person(2), person(3)],
          closed_at: '2026-09-03T00:00:00Z',
          closed_by: person(4),
          due_date: '2026-10-01',
          milestone: { id: 4, title: 'v1', description: 'long' },
          confidential: true,
          user_notes_count: 0,
          weight: 3,
          time_stats: {},
        }),
      });
      expect(issue.data).toEqual({
        id: 2,
        iid: 7,
        title: 'bug',
        author: { id: 1, username: 'user1', name: 'User 1' },
        assignees: [
          { id: 2, username: 'user2', name: 'User 2' },
          { id: 3, username: 'user3', name: 'User 3' },
        ],
        closed_at: '2026-09-03T00:00:00Z',
        due_date: '2026-10-01',
        milestone: { id: 4, title: 'v1' },
        confidential: true,
        user_notes_count: 0,
      });
    });

    it('re-validates the group and instance list shapes at the runtime boundary', () => {
      const group = validateGitlabOperation('list_merge_requests', {
        group: 'g/sub',
        reviewer_username: 'carol-x',
        draft: false,
        labels: ['a'],
        created_before: '2026-09-01T00:00:00Z',
      });
      expect(validateTransportGitlabArgs('list_merge_requests', group)).toEqual(group);
      const instance = validateGitlabOperation('list_issues', {
        author_username: 'alex.rivera',
        state: 'all',
        order_by: 'updated_at',
      });
      expect(validateTransportGitlabArgs('list_issues', instance)).toEqual(instance);
      expect(() =>
        validateTransportGitlabArgs('list_merge_requests', { ...instance, kind: 'list_issues' }),
      ).toThrow(/mismatch/);
      expect(() =>
        validateTransportGitlabArgs('list_issues', { ...instance, kind: 'list_merge_requests' }),
      ).toThrow(/mismatch/);
      // The runtime refuses what the runner would refuse.
      expect(() =>
        validateTransportGitlabArgs('list_merge_requests', {
          kind: 'list_merge_requests',
          state: 'all',
          order_by: 'updated_at',
          sort: 'desc',
          page: 1,
          per_page: 20,
        }),
      ).toThrow(INSTANCE_REFUSAL);
      expect(() =>
        validateTransportGitlabArgs('list_merge_requests', { ...group, project: 'g/p' }),
      ).toThrow(/either project or group/);
    });
  });
});

describe('get_job_trace', () => {
  const traceResult = (part: 'head' | 'tail', body = fakeJobTrace()) => {
    const answer = runtimeTraceAnswer(body, part);
    return normalizeGitlabOutput({
      operation: 'get_job_trace',
      project: 'g/p',
      httpStatus: answer.httpStatus,
      status: 'completed',
      output: answer.output,
      textMeta: answer.textMeta,
    });
  };

  it('validates project, job_id and an optional boolean head; nothing else', () => {
    expect(validateGitlabOperation('get_job_trace', { project: 'g/p', job_id: 9 })).toEqual({
      kind: 'get_job_trace',
      project: 'g/p',
      job_id: 9,
      head: false,
    });
    expect(
      validateGitlabOperation('get_job_trace', { project: 42, job_id: 9, head: true }),
    ).toEqual({ kind: 'get_job_trace', project: '42', job_id: 9, head: true });
    expect(() =>
      validateGitlabOperation('get_job_trace', { project: 'g/p', job_id: 9, head: 'yes' }),
    ).toThrow(/head must be a boolean/);
    for (const extra of [{ offset: 0 }, { range: '0-100' }, { tail: true }, { lines: 50 }])
      expect(() =>
        validateGitlabOperation('get_job_trace', { project: 'g/p', job_id: 9, ...extra }),
      ).toThrow(/unknown argument/);
    for (const job_id of [0, -1, 1.5, '9', undefined])
      expect(() => validateGitlabOperation('get_job_trace', { project: 'g/p', job_id })).toThrow(
        /job_id must be a positive safe integer/,
      );
    // The runner-validated form (with kind) survives the transport boundary.
    expect(
      validateTransportGitlabArgs('get_job_trace', {
        kind: 'get_job_trace',
        project: 'g/p',
        job_id: 9,
        head: true,
      }),
    ).toEqual({ kind: 'get_job_trace', project: 'g/p', job_id: 9, head: true });
    expect(isGitlabWriteOperation('get_job_trace')).toBe(false);
  });

  it('maps to GET jobs/<id>/trace as a bounded text request', () => {
    const tail = request('get_job_trace', { project: 'group/sub/app', job_id: 77 });
    expect(tail).toEqual({
      operation: 'get_job_trace',
      method: 'GET',
      endpoint: 'projects/group%2Fsub%2Fapp/jobs/77/trace',
      body: null,
      resourceIdentity: 'job 77 trace@group/sub/app',
      responseKind: 'text',
      retain: { bytes: MAX_TRACE_BYTES, part: 'tail' },
    });
    expect(request('get_job_trace', { project: 'g/p', job_id: 77, head: true }).retain).toEqual({
      bytes: 48_000,
      part: 'head',
    });
    // Every other operation stays a JSON request without retention.
    expect(request('get_job', { project: 'g/p', job_id: 77 })).toMatchObject({
      endpoint: 'projects/g%2Fp/jobs/77',
      responseKind: 'json',
      retain: null,
    });
  });

  it('describes the bound and the log sensitivity; get_job points at the trace', () => {
    const describe = (name: string) =>
      GITLAB_OPERATION_METADATA.find((entry) => entry.name === name)!.description;
    expect(describe('get_job_trace')).toMatch(/last 48 KB .* first 48 KB with head: true/);
    expect(describe('get_job_trace')).toMatch(/quote only what the question needs/);
    expect(describe('get_job_trace')).toMatch(/list_pipelines and get_pipeline_jobs first/);
    expect(describe('get_job')).toContain('Use get_job_trace for the log.');
    expect(describe('get_job')).not.toContain('No trace download');
  });

  it('cleans ANSI escapes, carriage-return overwrites and GitLab section markers', () => {
    expect(
      cleanTraceText(
        'section_start:1760000000:prepare_executor\r\x1b[0K\x1b[0K\x1b[36;1mPreparing\x1b[0;m\n' +
          'Downloading 10%\rDownloading 55%\rDownloading 100%\n' +
          'section_end:1760000004:prepare_executor\r\x1b[0K' +
          'section_start:1760000005:step_script[collapsed=true]\r\x1b[0K\n' +
          '\x1b[32m✓\x1b[39m ok\r\n' +
          'bell\x07 and \x1b]8;;https://x\x07link\x1b]8;;\x07 done\n',
      ),
    ).toBe(
      '[section prepare_executor] Preparing\n' +
        'Downloading 100%\n' +
        '[end section prepare_executor]\n' +
        '[section step_script]\n' +
        '✓ ok\n' +
        'bell and link done\n',
    );
  });

  it('returns the bounded tail by default with byte counts, truncation and a warning', () => {
    const body = fakeJobTrace();
    const total = Buffer.byteLength(body);
    expect(total).toBeGreaterThan(MAX_TRACE_BYTES);
    const result = traceResult('tail', body);
    expect(result.ok).toBe(true);
    const data = result.data as GitlabTraceData;
    expect(data.part).toBe('tail');
    expect(data.total_bytes).toBe(total);
    expect(data.returned_bytes).toBeLessThanOrEqual(MAX_TRACE_BYTES);
    expect(data.returned_bytes).toBeGreaterThan(MAX_TRACE_BYTES - 200);
    expect(data.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain(
      `trace bounded to the last 48 000 bytes of ${total}; call with head: true for the beginning`,
    );
    // The end of the log, cleaned: reporter summary with the retried test.
    expect(data.text).toContain(`${FAKE_FLAKY_TEST} (retry #1) (12.4s)`);
    expect(data.text).toContain('1 flaky');
    expect(data.text).toContain('[end section step_script]');
    expect(data.text).not.toContain('\x1b');
    expect(data.text).not.toContain('\r');
    expect(data.text).not.toContain('trace-head-marker');
    // The cut edge starts at a whole line.
    expect(data.text.startsWith('filler line ')).toBe(true);
    const rendered = renderGitlabResultText(result);
    expect(rendered).toContain('ok (get_job_trace @ g/p)');
    expect(rendered).toContain(
      `part: tail, total_bytes: ${total}, returned_bytes: ${data.returned_bytes}, truncated: true`,
    );
    // The log renders verbatim, not as a JSON string.
    expect(rendered).toContain(`\n  41 passed (3.2m)\n`);
  });

  it('returns the bounded head with head: true; printed credentials are redacted', () => {
    const result = traceResult('head');
    const data = result.data as GitlabTraceData;
    expect(data.part).toBe('head');
    expect(data.truncated).toBe(true);
    expect(result.warnings[0]).toMatch(
      /^trace bounded to the first 48 000 bytes of \d+; call without head/,
    );
    expect(data.text).toContain('[section prepare_executor] Preparing the "docker" executor');
    expect(data.text).toContain('Downloading browsers 100%');
    expect(data.text).not.toContain('Downloading browsers 10%');
    expect(data.text).toContain('trace-head-marker start-of-log');
    expect(data.text).not.toContain(FAKE_FLAKY_TEST);
    expect(data.text.endsWith('of the e2e setup output\n')).toBe(true);
    expect(data.text).not.toContain(FAKE_TRACE_TOKEN);
    expect(data.text).not.toContain('hunter2-private-value');
    expect(data.text).not.toContain('dXNlcjpwYXNzd29yZA');
    expect(data.text).toContain('$ git clone https://[redacted]@gitlab.example.test/g/p.git');
    expect(data.text).toContain('PRIVATE-TOKEN: [redacted]');
    expect(data.text).toContain('Authorization: [redacted]');
  });

  it('reports a short trace whole and untruncated', () => {
    const result = traceResult('tail', 'section_start:1:build\r\x1b[0KBuild\nok\n');
    expect(result).toMatchObject({ ok: true, truncated: false, warnings: [] });
    expect(result.data).toEqual({
      text: '[section build] Build\nok\n',
      total_bytes: 35,
      returned_bytes: 35,
      part: 'tail',
      truncated: false,
    });
  });

  it('reports a hard cut as truncated with the counted bytes', () => {
    const result = normalizeGitlabOutput({
      operation: 'get_job_trace',
      project: 'g/p',
      httpStatus: 200,
      status: 'completed',
      output: 'last line\n',
      textMeta: { totalBytes: 8_400_000, returnedBytes: 10, part: 'tail', cut: true },
    });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.warnings).toEqual([
      'trace bounded to the last 48 000 bytes of more than 8400000; call with head: true for the beginning',
      'trace read stopped at the 8388608-byte hard cut; total_bytes counts what was read',
    ]);
  });

  it('keeps the error classification of a JSON error body and refuses a trace without retention', () => {
    const missing = normalizeGitlabOutput({
      operation: 'get_job_trace',
      project: 'g/p',
      status: 'failed',
      httpStatus: 404,
      output: '{"message":"404 Not found"}',
    });
    expect(missing).toMatchObject({ ok: false, errorCategory: 'not_found' });
    expect(
      normalizeGitlabOutput({
        operation: 'get_job_trace',
        project: 'g/p',
        status: 'failed',
        httpStatus: 403,
        output: '{"message":"403 Forbidden"}',
      }),
    ).toMatchObject({ ok: false, errorCategory: 'forbidden' });
    expect(
      normalizeGitlabOutput({
        operation: 'get_job_trace',
        project: 'g/p',
        httpStatus: null,
        status: 'timed_out',
        output: '',
      }),
    ).toMatchObject({ ok: false, errorCategory: 'timeout' });
    // A trace is never JSON-parsed; without the runtime's report it is not trusted.
    expect(
      normalizeGitlabOutput({
        operation: 'get_job_trace',
        project: 'g/p',
        httpStatus: 200,
        status: 'completed',
        output: 'plain text',
      }),
    ).toMatchObject({ ok: false, errorCategory: 'invalid_response' });
  });

  it('fits the model bound even when JSON escaping grows the text', () => {
    const quotes = '"\\'.repeat(16_000);
    const result = normalizeGitlabOutput({
      operation: 'get_job_trace',
      project: 'g/p',
      httpStatus: 200,
      status: 'completed',
      output: quotes,
      textMeta: { totalBytes: 48_000, returnedBytes: 48_000, part: 'tail', cut: false },
    });
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThanOrEqual(60_000);
  });

  it('renders every record of a bounded result and marks a cut text', () => {
    const issues = Array.from({ length: 100 }, (_, i) => ({
      iid: i + 1,
      state: 'opened',
      labels: ['bug', 'checkout'],
      title: `issue ${i + 1} ${'x'.repeat(500)}`,
    }));
    const result = {
      ok: true,
      operation: 'list_issues' as const,
      project: 'g/p',
      data: issues,
      pagination: {},
      truncated: false,
      warnings: [],
    };
    expect(JSON.stringify(issues).length).toBeLessThan(60_000);
    expect(JSON.stringify(issues, null, 2).length).toBeGreaterThan(60_000);
    const rendered = renderGitlabResultText(result);
    expect(rendered).toContain('"title":"issue 100 ');
    expect(rendered).not.toContain('[truncated');
    const cut = renderGitlabResultText({ ...result, data: [...issues, ...issues] });
    expect(cut).toContain('[truncated');
  });
});
