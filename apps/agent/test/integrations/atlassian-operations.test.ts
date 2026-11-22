import { describe, expect, it } from 'vitest';
import {
  ATLASSIAN_OPERATION_METADATA,
  ATLASSIAN_READ_OPERATIONS,
  atlassianProduct,
  defaultAtlassianOperations,
  sanitizeSearchTerms,
  validateAtlassianOperation as validate,
  validateTransportAtlassianArgs,
} from '../../src/integrations/atlassian/atlassian-operations.js';

describe('atlassian-read-v4 contract', () => {
  it('offers exactly seven read operations, all by default', () => {
    expect(defaultAtlassianOperations()).toEqual([
      'searchJiraIssues',
      'searchJiraIssuesUsingJql',
      'getJiraIssue',
      'listJiraIssueComments',
      'listJiraProjects',
      'searchConfluencePages',
      'getConfluencePage',
    ]);
    expect(ATLASSIAN_READ_OPERATIONS.filter((op) => atlassianProduct(op) === 'confluence')).toEqual(
      ['searchConfluencePages', 'getConfluencePage'],
    );
  });

  it('applies defaults and bounds', () => {
    expect(validate('searchJiraIssues', { query: 'release checklist' })).toEqual({
      kind: 'searchJiraIssues',
      query: 'release checklist',
      maxResults: 10,
    });
    expect(validate('listJiraIssueComments', { issueKey: 'ABC-123' })).toEqual({
      kind: 'listJiraIssueComments',
      issueKey: 'ABC-123',
      maxResults: 20,
      startAt: 0,
    });
    expect(validate('listJiraProjects', { maxResults: 50, startAt: 100 })).toEqual({
      kind: 'listJiraProjects',
      maxResults: 50,
      startAt: 100,
    });
    for (const [op, args] of [
      ['searchJiraIssues', { query: 'x', maxResults: 21 }],
      ['searchJiraIssuesUsingJql', { jql: 'project = A', maxResults: 0 }],
      ['searchConfluencePages', { query: 'x', maxResults: 1.5 }],
      ['listJiraProjects', { maxResults: 51 }],
      ['listJiraProjects', { startAt: -1 }],
      ['listJiraIssueComments', { issueKey: 'A-1', startAt: 100001 }],
      ['searchJiraIssues', { query: '' }],
      ['searchJiraIssues', { query: 'x'.repeat(201) }],
      ['searchJiraIssuesUsingJql', { jql: 'a'.repeat(2049) }],
      ['searchJiraIssuesUsingJql', { jql: 'a\nb' }],
      ['getJiraIssue', { issueKey: 'kan-1' }],
      ['getJiraIssue', { issueKey: 'KAN-01' }],
      ['getConfluencePage', { pageId: '0123' }],
      ['getConfluencePage', { pageId: 1234567890 }],
    ] as const)
      expect(() => validate(op, args)).toThrow();
  });

  it('rejects unknown operations, fields, and transport operation mismatch', () => {
    expect(() => validate('createJiraIssue', {})).toThrow(/unknown Atlassian operation/);
    expect(() =>
      validate('getJiraIssue', { issueKey: 'KAN-1', site: 'evil.atlassian.net' }),
    ).toThrow(/unknown argument/);
    expect(() => validate('searchJiraIssues', { query: 'x', url: 'https://evil' })).toThrow();
    expect(() => validate('getJiraIssue', null)).toThrow();
    expect(() =>
      validateTransportAtlassianArgs('getJiraIssue', { kind: 'getConfluencePage', pageId: '1' }),
    ).toThrow(/mismatch/);
    expect(
      validateTransportAtlassianArgs('getConfluencePage', {
        kind: 'getConfluencePage',
        pageId: '1234567890',
      }),
    ).toEqual({ kind: 'getConfluencePage', pageId: '1234567890' });
  });

  it('sanitizes search terms so query cannot inject JQL/CQL clauses', () => {
    expect(sanitizeSearchTerms('" OR project = HR')).toBe('OR project = HR');
    expect(sanitizeSearchTerms('a\\" OR (b) AND c~*?:/[x]{y}^!&|+-')).toBe('a OR b AND c x y');
    expect(sanitizeSearchTerms('  sample\trelease\nchecklist   pages ')).toBe(
      'sample release checklist pages',
    );
    expect(() => sanitizeSearchTerms('"()"')).toThrow(/search terms/);
    const injected = validate('searchJiraIssues', { query: 'x" OR project = "HR' });
    expect(injected).toMatchObject({ query: 'x OR project = HR' });
    expect(JSON.stringify(injected)).not.toContain('"HR');
    // Validation is idempotent on the broker-forwarded (already sanitized) value.
    expect(validateTransportAtlassianArgs('searchJiraIssues', injected)).toEqual(injected);
  });

  it('bounds project/space filters and continuation tokens', () => {
    expect(validate('searchJiraIssues', { query: 'x', projectKey: 'ABC' })).toMatchObject({
      projectKey: 'ABC',
    });
    expect(validate('searchConfluencePages', { query: 'x', spaceKey: '~123456789' })).toMatchObject(
      { spaceKey: '~123456789' },
    );
    for (const projectKey of ['abc', 'ABC" OR 1=1', 'A'.repeat(51), '1ABC'])
      expect(() => validate('searchJiraIssues', { query: 'x', projectKey })).toThrow(/projectKey/);
    for (const spaceKey of ['~', 'A B', 'X" OR space = "Y', '~~a'])
      expect(() => validate('searchConfluencePages', { query: 'x', spaceKey })).toThrow(/spaceKey/);
    expect(
      validate('searchJiraIssues', { query: 'x', nextPageToken: 'Ch0jU3RyaW5n+/=_-' }),
    ).toMatchObject({ nextPageToken: 'Ch0jU3RyaW5n+/=_-' });
    for (const token of ['', 'a b', 'a"b', 'a&jql=x', 'x'.repeat(1025)]) {
      expect(() => validate('searchJiraIssues', { query: 'x', nextPageToken: token })).toThrow();
      expect(() => validate('searchConfluencePages', { query: 'x', cursor: token })).toThrow();
    }
  });

  it('describes each operation with search guidance and the untrusted-data boundary', () => {
    const byName = new Map(ATLASSIAN_OPERATION_METADATA.map((m) => [m.name, m.description]));
    expect(byName.size).toBe(7);
    for (const description of byName.values()) expect(description).toMatch(/untrusted data/);
    for (const op of ['searchJiraIssues', 'searchConfluencePages'] as const) {
      expect(byName.get(op)).toMatch(/synonyms/);
      expect(byName.get(op)).toMatch(/German and English/);
      expect(byName.get(op)).toMatch(/one to three best hits/);
    }
    expect(byName.get('getJiraIssue')).toMatch(/Cite the issue key/);
  });
});
