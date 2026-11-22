import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTool } from '@mastra/core/tools';
import type { Tool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, Workspace } from '@mastra/core/workspace';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import { CheckoutManager } from '../../domain/publication/checkouts.js';
import {
  publishCheckout,
  type PublishProjectOptions,
} from '../../domain/publication/publish-project.js';
import { workspacePaths } from '../../infrastructure/storage/workspace-paths.js';
import type { NativeInputReceipt } from '../../domain/files/native-inputs.js';
import { nativeExportTool } from './native-exports.js';
import { createNativeCodeMode } from './code-mode.js';

export interface NativeCodingOptions
  extends Omit<
    PublishProjectOptions,
    'paths' | 'checkouts' | 'authorize' | 'beforeRemote' | 'confirmed' | 'remoteEffect'
  > {
  /** Application-owned identity, never an argument to a model tool. */
  authorize(): Promise<void>;
  /** Persist uncertain BEFORE calling; never replay unknown publication. */
  publication<T>(
    project: string,
    send: (beforeRemote: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
  exportFile?: Parameters<typeof nativeExportTool>[0]['register'];
}

const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' };
function sandbox(directory: string) {
  return new LocalSandbox({
    workingDirectory: directory,
    isolation: 'bwrap',
    env,
    nativeSandbox: { allowNetwork: false, allowSystemBinaries: false },
    timeout: 30000,
  });
}

/** Qualify the actual framework sandbox before admitting coding on this host.
 * The application process can own credentials; a verification process cannot
 * inherit them, its network namespace, capabilities or protected filesystem. */
export async function checkNativeCodingSandbox(storageDir: string) {
  const directory = path.join(storageDir, 'sandbox-readiness');
  await fs.mkdir(directory, { recursive: true });
  const parentNetwork = await fs.readlink('/proc/self/ns/net');
  const execution = sandbox(directory);
  try {
    const result = await execution.executeCommand!(process.execPath, [
      '-e',
      `const fs=require('node:fs');
      const cap=fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s*(\\w+)/m)?.[1];
      const hidden=['/app','/run/secrets'].every(p=>!fs.existsSync(p));
      const clean=Object.keys(process.env).every(k=>['PATH','HOME','TMPDIR','LANG','PWD','SHLVL','_'].includes(k));
      const isolated=fs.readlinkSync('/proc/self/ns/net')!==${JSON.stringify(parentNetwork)};
      if(!hidden||!clean||!isolated||!cap||!/^0+$/.test(cap))process.exit(1);
      console.log('native-sandbox-ready');`,
    ]);
    if (result.exitCode !== 0 || result.stdout.trim() !== 'native-sandbox-ready')
      throw new Error('native coding sandbox qualification failed');
  } finally {
    await execution.stop();
  }
}

/** One task's real filesystem. Metadata, credentials and publication staging are
 * siblings outside the mounted checkout root; only domain closures see them. */
export async function createNativeCodingBinding(parent: NativeCodingOptions, reads: ToolsInput) {
  // Mastra supplies the run abort signal to tool execution. Domain callbacks
  // must observe it too when invoked by Studio (without the Slack service loop).
  const toolSignal = new AsyncLocalStorage<AbortSignal>();
  const parentSignal = parent.signal ?? new AbortController().signal;
  const options: NativeCodingOptions & { signal: AbortSignal } = {
    ...parent,
    get signal() {
      return AbortSignal.any([
        parentSignal,
        ...(toolSignal.getStore() ? [toolSignal.getStore()!] : []),
      ]);
    },
    async authorize() {
      options.signal.throwIfAborted();
      await parent.authorize();
      options.signal.throwIfAborted();
    },
  };
  if (!/^[a-f0-9]{32,64}$/.test(options.workspaceId) || !path.isAbsolute(options.storageDir))
    throw new Error('Trusted native workspace identity required');
  const paths = workspacePaths(options.storageDir, options.workspaceId);
  await fs.mkdir(paths.checkouts, { recursive: true });
  const execution = sandbox(paths.checkouts);
  const currentGitlab: NativeCodingOptions['gitlab'] = async (operation) => {
    await options.authorize();
    const result = await options.gitlab(operation);
    await options.authorize();
    return result;
  };
  const checkouts = new CheckoutManager({
    ...options,
    gitlab: currentGitlab,
    paths,
    stagingRoot: options.storageDir,
    runSeq: options.run.runSeq,
    register: async () => options.authorize(),
    onCloned() {},
    maxOutputBytes: 16000,
    executeInPlace: async ({ dir, argv, cwd, timeoutMs }) => {
      await options.authorize();
      const result = await execution.executeCommand!(
        'sh',
        ['-c', `cd ${quote(cwd ? path.join(dir, cwd) : dir)} && exec ${argv.map(quote).join(' ')}`],
        {
          cwd: cwd ? path.join(dir, cwd) : dir,
          timeout: timeoutMs,
          abortSignal: options.signal,
          maxRetainedBytes: 16000,
        },
      );
      await options.authorize();
      return {
        status: result.timedOut ? 'timed_out' : result.killed ? 'failed' : 'completed',
        exitCode: result.exitCode,
        durationMs: result.executionTimeMs,
        output: result.stdout + result.stderr,
        truncated: !!(result.stdoutTruncated || result.stderrTruncated),
      };
    },
  });
  const workspace = new Workspace({
    id: `coding-${options.workspaceId}`,
    filesystem: new LocalFilesystem({
      basePath: paths.checkouts,
      contained: true,
      allowedPaths: [],
    }),
    sandbox: execution,
    // Enable the bounded facilities actually used by this vertical. No unmanaged
    // background commands, shell environment overrides, LSP, exports or browser.
    tools: {
      enabled: false,
      ...Object.fromEntries(
        [
          'read_file',
          'write_file',
          'edit_file',
          'list_files',
          'grep',
          'file_stat',
          'mkdir',
          'apply_patch',
        ].map((name) => [`mastra_workspace_${name}`, { enabled: true }]),
      ),
      mastra_workspace_read_file: { enabled: true, mediaTypes: false },
      hooks: {
        beforeToolCall: () => options.authorize(),
        afterToolCall: () => options.authorize(),
      },
    },
  });
  const guarded = async <T>(work: () => Promise<T>) => {
    await options.authorize();
    const result = await work();
    await options.authorize();
    return result;
  };
  const code = createNativeCodeMode(reads, options.authorize);
  const tools = {
    ...(options.exportFile
      ? {
          export_file: nativeExportTool({
            filesystem: workspace.filesystem!,
            authorize: options.authorize,
            register: options.exportFile,
          }),
        }
      : {}),
    clone_repository: createTool({
      id: 'clone_repository',
      description: 'Clone an assigned GitLab repository into this task workspace.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]),
        ref: z.string().optional(),
      }),
      execute: (args) => guarded(() => checkouts.clone(args.project, args.ref)),
    }),
    verify: createTool({
      id: 'verify',
      description:
        'Run a repository verification command in the isolated native sandbox. Records exact current-tree authority for publication.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        argv: z.array(z.string().min(1)).min(1).max(64),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().min(1).max(30000).default(30000),
      }),
      execute: (args) => guarded(() => checkouts.verify(args)),
    }),
    publish: createTool({
      id: 'publish',
      description:
        'Publish the exact verified current tree to the task branch and open task MR. Unknown outcomes require operator reconciliation; never retry.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        title: z.string().max(240),
        description: z.string().max(40000).optional(),
      }),
      execute: (args) =>
        guarded(() => {
          const record = checkouts.resolve(args.project);
          return options.publication(record.project, (beforeRemote) =>
            publishCheckout(
              {
                ...options,
                gitlab: currentGitlab,
                paths,
                checkouts,
                authorize: options.authorize,
                beforeRemote: async () => {
                  await options.authorize();
                  await beforeRemote();
                },
                confirmed: async () => options.authorize(),
                remoteEffect: async (_operation, send) => guarded(send),
              },
              args,
            ),
          );
        }),
    }),
  };
  const scopeTool = (tool: Tool) => {
    const execute = tool.execute!;
    tool.execute = (args, context) =>
      toolSignal.run(context?.abortSignal ?? parentSignal, () => execute(args, context));
    return tool;
  };
  return {
    workspace,
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, scopeTool(tool as Tool)]),
    ),
    codeMode: { [code.id]: scopeTool(code) },
    async stageInputs(files: Array<{ receipt: NativeInputReceipt; bytes: Buffer }>) {
      return guarded(async () => {
        const staged = [];
        for (const { receipt, bytes } of files) {
          const filename = `.slack-inputs/${options.run.runId}/${receipt.file.id}/${receipt.file.name}`;
          await workspace.filesystem!.writeFile(filename, bytes, {
            recursive: true,
            overwrite: false,
          });
          staged.push({ path: filename, sha256: receipt.sha256, bytes: bytes.length });
        }
        return staged;
      });
    },
    async close() {
      await workspace.stop();
    },
  };
}
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export type NativeCodingBinding = Awaited<ReturnType<typeof createNativeCodingBinding>>;
