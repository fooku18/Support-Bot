import { createHash } from 'node:crypto';
import { LocalFilesystem } from '@mastra/core/workspace';
import { expect, it, vi } from 'vitest';
import { nativeExportTool } from '../../src/mastra/tools/native-exports.js';

function exportFixture() {
  const bytes = Buffer.from('name,value\nsample,42\n');
  const filesystem = new LocalFilesystem({
    basePath: '/unused',
    contained: true,
    allowedPaths: [],
  });
  const stat = vi.spyOn(filesystem, 'stat').mockResolvedValue({
    name: 'sample.csv',
    path: 'sample.csv',
    type: 'file',
    size: bytes.length,
    createdAt: new Date(0),
    modifiedAt: new Date(0),
  });
  const readFile = vi.spyOn(filesystem, 'readFile').mockResolvedValue(bytes);
  const authorize = vi.fn(async () => {});
  const register = vi.fn(async () => ({ registered: true }));
  const tool = nativeExportTool({ filesystem, authorize, register });
  return { tool, stat, readFile, authorize, register, bytes };
}

it.each([
  '../sample.csv',
  'sub/../sample.csv',
  'sub\\..\\sample.csv',
  'sub\\../sample.csv',
  'sub/..',
  '..',
  '/sample.csv',
  '.git/sample.csv',
  'sub/.git/sample.csv',
])('refuses export path %s before filesystem access or registration', async (requested) => {
  const { tool, stat, readFile, authorize, register } = exportFixture();
  await expect(tool.execute!({ path: requested }, {} as never)).rejects.toThrow(
    'export requires a relative Workspace file',
  );
  expect(authorize).toHaveBeenCalledOnce();
  expect(stat).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

it('snapshots a file inside a directory whose name begins with two dots', async () => {
  const { tool, stat, readFile, authorize, register, bytes } = exportFixture();
  await expect(tool.execute!({ path: '..notes/sample.csv' }, {} as never)).resolves.toEqual({
    registered: true,
  });
  expect(stat).toHaveBeenCalledExactlyOnceWith('..notes/sample.csv');
  expect(readFile).toHaveBeenCalledExactlyOnceWith('..notes/sample.csv');
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(register).toHaveBeenCalledExactlyOnceWith({
    path: '..notes/sample.csv',
    name: 'sample.csv',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
});
