import { describe, expect, it } from 'vitest';
import {
  DatafileReader,
  lookupOptimizely,
  OptimizelyReadError,
  readOptimizely,
  type LoadedDatafile,
} from '../../src/integrations/optimizely/datafile.js';

const condition = (name: string, value: string) => ({
  match: 'exact',
  name,
  type: 'custom_attribute',
  value,
});

const datafile = (environmentKey: string) => ({
  version: '4',
  revision: '42',
  projectId: '1001',
  environmentKey,
  featureFlags: [
    {
      id: 'f1',
      key: 'shop_new_banner',
      rolloutId: 'r1',
      experimentIds: ['9001'],
      variables: [{ id: 'v1', key: 'positions', type: 'json', defaultValue: '{"p":[1]}' }],
    },
    {
      id: 'f2',
      key: 'shop_banner_kill_switch',
      rolloutId: 'r2',
      experimentIds: [],
      variables: [],
    },
  ],
  experiments: [
    {
      id: '9001',
      key: 'banner_test',
      status: 'Running',
      audienceConditions: ['and', 'a1', 'a2'] as unknown[],
      variations: [
        { id: '7001', key: 'control', featureEnabled: false, variables: [] },
        {
          id: '7002',
          key: 'treatment',
          featureEnabled: true,
          variables: [{ id: 'v1', value: '{"p":[1,2]}' }],
        },
      ],
      trafficAllocation: [
        { entityId: '7001', endOfRange: 2500 },
        { entityId: '7002', endOfRange: 5000 },
      ],
      forcedVariations: { 'user-a': 'treatment', 'user-b': 'control' },
    },
  ],
  rollouts: [
    {
      id: 'r1',
      experiments: [
        {
          id: '8001',
          key: 'banner_de',
          status: 'Running',
          audienceIds: ['a1'],
          variations: [{ id: '7101', key: 'on', featureEnabled: true, variables: [] }],
          trafficAllocation: [{ entityId: '7101', endOfRange: 10000 }],
        },
        {
          id: '8002',
          key: 'default-rollout-1',
          status: 'Running',
          audienceIds: [],
          audienceConditions: [],
          variations: [{ id: '7102', key: 'off', featureEnabled: false, variables: [] }],
          trafficAllocation: [{ entityId: '7102', endOfRange: 10000 }],
        },
      ],
    },
    { id: 'r2', experiments: [] },
  ],
  audiences: [
    {
      id: 'a1',
      name: 'Storefront: DE',
      conditions: JSON.stringify(['or', condition('$opt_dummy_attribute', '$opt_dummy_value')]),
    },
    {
      id: 'a2',
      name: 'Platform iOS',
      conditions: JSON.stringify(['and', ['or', condition('x-platform', 'iOS')]]),
    },
  ],
  typedAudiences: [
    {
      id: 'a1',
      name: 'Storefront: DE',
      conditions: ['and', ['or', ['or', condition('x-storefront', 'de')]]],
    },
    { id: 'a3', name: 'Testers', conditions: ['or', condition('userId', 'user-c')] },
  ],
  events: [{ id: '5001', key: 'banner_clicked' }],
});

const file = (environment: string): LoadedDatafile => ({
  name: 'Shop',
  environment,
  fetchedAt: Date.UTC(2026, 10, 28),
  data: datafile(environment) as unknown as LoadedDatafile['data'],
});

type Found = { found: true; flags: Array<Record<string, unknown>>; absentIn: string[] };

describe('lookupOptimizely', () => {
  it('describes a flag: experiments, then delivery rules, with traffic, audiences and overrides', () => {
    const result = lookupOptimizely([file('production')], 'shop_new_banner') as Found;
    expect(result.found).toBe(true);
    const flag = result.flags[0]!;
    expect(flag).toMatchObject({ environment: 'production', projectId: '1001', revision: '42' });
    const rules = flag.rules as Array<Record<string, unknown>>;
    expect(rules.map((r) => [r.type, r.key])).toEqual([
      ['experiment', 'banner_test'],
      ['delivery rule', 'banner_de'],
      ['everyone else', 'default-rollout-1'],
    ]);
    expect(rules[0]).toMatchObject({
      audience: '(Storefront: DE AND Platform iOS)',
      allocatedPercent: 50,
      traffic: [
        { variation: 'control', percent: 25 },
        { variation: 'treatment', percent: 25 },
      ],
      whitelistedUsers: 2,
      audiences: [
        { id: 'a1', name: 'Storefront: DE', conditions: 'x-storefront exact "de"' },
        { id: 'a2', name: 'Platform iOS', conditions: 'x-platform exact "iOS"' },
      ],
    });
    expect((rules[0]!.variations as unknown[])[1]).toEqual({
      key: 'treatment',
      id: '7002',
      featureEnabled: true,
      variableOverrides: { positions: '{"p":[1,2]}' },
    });
    expect(rules[2]).toMatchObject({ audience: 'everyone', allocatedPercent: 100 });
    expect(JSON.stringify(result)).not.toContain('user-a');
  });

  it('resolves rule keys and experiment and variation IDs to their flag', () => {
    const development = file('development');
    development.data.featureFlags = [];
    for (const query of ['banner_test', '9001', '7002', 'banner_de']) {
      const result = lookupOptimizely([file('production'), development], query) as Found;
      expect(result.flags.map((f) => f.flag)).toEqual(['shop_new_banner']);
      expect(result.absentIn).toEqual(['Shop (development)']);
    }
  });

  it('searches keys case-insensitively and explains an absent key', () => {
    expect(lookupOptimizely([file('production')], 'BANNER')).toMatchObject({
      found: false,
      total: 5,
      matches: [
        { type: 'flag', key: 'shop_new_banner' },
        { type: 'flag', key: 'shop_banner_kill_switch' },
        { type: 'experiment', key: 'banner_test' },
        { type: 'delivery rule', key: 'banner_de' },
        { type: 'event', key: 'banner_clicked' },
      ],
    });
    const absent = lookupOptimizely([file('production')], 'shop_old_banner');
    expect(absent).toMatchObject({ found: false, total: 0 });
    expect((absent as { note: string }).note).toContain('is not in datafile');
  });

  it('lists the datafiles for an empty query', () => {
    expect(lookupOptimizely([file('production')], ' ')).toEqual({
      datafiles: [
        expect.objectContaining({ datafile: 'Shop', environment: 'production', flags: 2 }),
      ],
    });
  });

  it('hides values of personal attributes in audience conditions', () => {
    const data = file('production');
    data.data.experiments[0]!.audienceConditions = ['or', 'a3'];
    const text = JSON.stringify(lookupOptimizely([data], 'banner_test'));
    expect(text).toContain('userId exact <hidden>');
    expect(text).not.toContain('user-c');
  });
});

describe('DatafileReader', () => {
  const ok = () => new Response(JSON.stringify(datafile('production')), { status: 200 });
  const signal = new AbortController().signal;
  const ref = { name: 'Shop', sdkKey: 'AbCdEf1234567890' };

  it('fetches the fixed CDN URL without following redirects and caches for five minutes', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    let now = 0;
    const reader = new DatafileReader(
      (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return ok();
      }) as typeof fetch,
      () => now,
    );
    expect((await reader.load(ref, signal)).environment).toBe('production');
    now = 4 * 60_000;
    await reader.load(ref, signal);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://cdn.optimizely.com/datafiles/AbCdEf1234567890.json');
    expect(seen[0]!.init.redirect).toBe('error');
    now = 6 * 60_000;
    await reader.load(ref, signal);
    expect(seen).toHaveLength(2);
  });

  it('shares one fetch between concurrent loads and drops a failed fetch from the cache', async () => {
    let calls = 0;
    let fail = true;
    const reader = new DatafileReader((async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fail ? new Response('', { status: 503 }) : ok();
    }) as unknown as typeof fetch);
    const results = await Promise.allSettled([reader.load(ref, signal), reader.load(ref, signal)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
    fail = false;
    await Promise.all([reader.load(ref, signal), reader.load(ref, signal)]);
    expect(calls).toBe(2);
    const aborted = new AbortController();
    aborted.abort(new Error('run canceled'));
    await expect(reader.load(ref, aborted.signal)).rejects.toThrow('run canceled');
  });

  it('refuses bad keys, HTTP errors, oversized bodies and non-datafiles', async () => {
    const reader = (response: Response) =>
      new DatafileReader((async () => response) as unknown as typeof fetch);
    await expect(
      reader(ok()).load({ name: 'Shop', sdkKey: '../evil' }, signal),
    ).rejects.toBeInstanceOf(OptimizelyReadError);
    await expect(reader(new Response('', { status: 404 })).load(ref, signal)).rejects.toThrow(
      'HTTP 404',
    );
    await expect(reader(new Response('{"version":"3"}')).load(ref, signal)).rejects.toThrow(
      'not an Optimizely v4 datafile',
    );
    await expect(reader(new Response('x'.repeat(5_000_001))).load(ref, signal)).rejects.toThrow(
      'too large',
    );
  });

  it('answers from the datafiles that load and names the ones that failed', async () => {
    const reader = new DatafileReader((async (url: string) =>
      url.includes('Broken')
        ? new Response('', { status: 500 })
        : ok()) as unknown as typeof fetch);
    const { output: text, data } = await readOptimizely(
      reader,
      [ref, { name: 'App', sdkKey: 'Broken1234567890' }],
      'shop_new_banner',
      signal,
    );
    const output = JSON.parse(text) as Found & { unavailable: string[] };
    expect(data).toEqual(output);
    expect(output.flags).toHaveLength(1);
    expect(output.unavailable).toEqual(['App: the datafile "App" could not be fetched (HTTP 500)']);
    await expect(readOptimizely(reader, [ref], 'x'.repeat(201), signal)).rejects.toThrow(
      'at most 200',
    );
  });
});

describe('review fixes', () => {
  const signal = new AbortController().signal;

  it('hides camelCase user ID attributes too', () => {
    const data = file('production');
    data.data.typedAudiences![1]!.conditions = ['or', condition('shopUserId', '12345')];
    data.data.experiments[0]!.audienceConditions = ['or', 'a3'];
    const text = JSON.stringify(lookupOptimizely([data], 'banner_test'));
    expect(text).toContain('shopUserId exact <hidden>');
    expect(text).not.toContain('12345');
  });

  it('finds an experiment by ID even when no flag references it', () => {
    const data = file('production');
    data.data.featureFlags = [];
    expect(lookupOptimizely([data], '9001')).toMatchObject({
      found: false,
      matches: [{ type: 'experiment', key: 'banner_test', id: '9001' }],
    });
  });

  it('does not call a key archived when a datafile failed to load', async () => {
    const reader = new DatafileReader((async (url: string) =>
      url.includes('Broken')
        ? new Response('', { status: 500 })
        : new Response(JSON.stringify(datafile('development')))) as unknown as typeof fetch);
    const { data } = await readOptimizely(
      reader,
      [
        { name: 'Shop', sdkKey: 'Broken1234567890' },
        { name: 'Shop', sdkKey: 'AbCdEf1234567890' },
      ],
      'shop_old_banner',
      signal,
    );
    expect((data as { note: string }).note).toContain('do not call it archived');
  });

  it('refuses a datafile with malformed nested entries', async () => {
    const broken = datafile('production') as Record<string, unknown>;
    broken.typedAudiences = [{ id: 'a9', conditions: [] }];
    const reader = new DatafileReader(
      (async () => new Response(JSON.stringify(broken))) as unknown as typeof fetch,
    );
    await expect(reader.load({ name: 'Shop', sdkKey: 'AbCdEf1234567890' }, signal)).rejects.toThrow(
      'not an Optimizely v4 datafile',
    );
  });
});
