import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli } from '../src/cli.js';

async function runCli(args: string[]): Promise<string> {
  const output: string[] = [];
  await createCli({
    stdout: (message) => output.push(message),
    stderr: (message) => output.push(message),
  }).parseAsync(['node', 'codeatlas', ...args]);
  return output.join('\n');
}

describe('CodeAtlas CLI', () => {
  it('initializes the current directory without requiring CodeGraph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));

    const output = await runCli(['init', root, '--skip-codegraph']);

    expect(output).toContain('Workspace initialized');
    expect(JSON.parse(await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'))).toMatchObject({
      root: '.',
      schemaVersion: 1,
    });
  });

  it('prints machine-readable status from a nested or explicit path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));
    await runCli(['init', root, '--skip-codegraph']);

    const output = await runCli(['status', root, '--json']);
    const status = JSON.parse(output);

    expect(status.workspace.rootPath).toBe(root);
    expect(status.codegraph.initialized).toBe(false);
    expect(status.graph).toBeNull();
  });

  it('is idempotent and reports an existing workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));
    await runCli(['init', root, '--skip-codegraph']);

    const output = await runCli(['init', root, '--skip-codegraph']);

    expect(output).toContain('already exists');
  });
});
