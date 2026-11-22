import { describe, expect, it } from 'vitest';
import { selectInputs, parseFileDescriptors } from '../../src/domain/files/file-inputs.js';
import type { SlackFileDescriptorDto } from '../../src/contracts/dto.js';
const file = (id: string, sourceTs = '1.1'): SlackFileDescriptorDto => ({
  id,
  sourceTs,
  name: 'fixture',
  mime: 'text/plain',
  bytes: 100,
  revision: 'rev',
  hosted: true,
});
describe('attachment inventory', () => {
  it('prioritizes trigger files and discloses all excluded files', () => {
    const inventory = Array.from({ length: 12 }, (_, i) => file(`F${i}`, `1.${i + 10}`));
    const result = selectInputs(inventory, '1.10', 'claude');
    expect(result[0]?.file.id).toBe('F0');
    expect(result).toHaveLength(12);
    expect(result.filter((f) => f.status === 'selected')).toHaveLength(10);
    expect(result.filter((f) => f.status === 'not_loaded')).toHaveLength(2);
  });
  it('refuses oversized inventories, remote files and mode-specific oversized inputs', () => {
    expect(() =>
      selectInputs(
        Array.from({ length: 201 }, () => file('F1')),
        '1.1',
        'claude',
      ),
    ).toThrow('200');
    expect(selectInputs([{ ...file('F1'), hosted: false }], '1.1', 'claude')[0]?.status).toBe(
      'rejected',
    );
    const large = { ...file('F1'), bytes: 300000 };
    expect(selectInputs([large], '1.1', 'claude')[0]?.status).toBe('rejected');
    expect(selectInputs([large], '1.1', 'claude-code')[0]?.status).toBe('selected');
  });
  it('stores only safe descriptors, never download URLs or arbitrary IDs', () => {
    const parsed = parseFileDescriptors(
      [{ ...file('F1'), name: '../a\n', url_private: 'secret' }],
      '1.1',
    );
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(parsed[0]?.name).toBe('.._a_');
    expect(() => parseFileDescriptors([{ id: 'https://evil.test' }], '1.1')).toThrow();
  });
});
