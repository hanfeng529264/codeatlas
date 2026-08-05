import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, isMainModule, prepareWorkspaceForUse } from '../src/cli.js';

async function runCli(args: string[]): Promise<string> {
  const output: string[] = [];
  await createCli({
    stdout: (message) => output.push(message),
    stderr: (message) => output.push(message),
  }).parseAsync(['node', 'codeatlas', ...args]);
  return output.join('\n');
}

describe('CodeAtlas CLI', () => {
  it('recognizes a symlinked executable as the main module', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-entry-'));
    const target = join(root, 'cli.js');
    const executable = join(root, 'codeatlas');
    await writeFile(target, '#!/usr/bin/env node\n');
    await symlink(target, executable);

    expect(isMainModule(executable, pathToFileURL(target).href)).toBe(true);
  });

  it('initializes the current directory without requiring CodeGraph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));

    const output = await runCli(['init', root, '--skip-codegraph']);

    expect(output).toContain('Workspace initialized');
    expect(JSON.parse(await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'))).toMatchObject({
      root: '.',
      schemaVersion: 2,
    });
  });

  it('initializes an empty multi-project workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));

    const output = await runCli(['init', root, '--empty']);
    const config = JSON.parse(await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'));

    expect(output).toContain('Empty multi-project workspace ready');
    expect(config.projects).toEqual([]);
  });

  it('automatically discovers a multi-project layout during init', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));
    await mkdir(join(root, 'projects', 'api', '.git'), { recursive: true });
    await mkdir(join(root, 'projects', 'web', 'src'), { recursive: true });

    const output = await runCli(['init', root, '--skip-codegraph']);
    const config = JSON.parse(await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'));

    expect(output).toContain('Multi-project layout detected: 2 projects');
    expect(config.projects.map((project: { path: string }) => project.path)).toEqual([
      'projects/api',
      'projects/web',
    ]);
  });

  it('can disable automatic discovery during init', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));
    await mkdir(join(root, 'projects', 'api', '.git'), { recursive: true });

    await runCli(['init', root, '--skip-codegraph', '--no-discover']);
    const config = JSON.parse(await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'));

    expect(config.projects).toEqual([{ id: 'root', name: root.split('/').at(-1), path: '.' }]);
  });

  it('prepares an uninitialized workspace for zero-configuration open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));
    await mkdir(join(root, 'projects', 'api', '.git'), { recursive: true });
    const output: string[] = [];

    const workspace = await prepareWorkspaceForUse(root, {
      create: true,
      discover: true,
      index: false,
      io: {
        stdout: (message) => output.push(message),
        stderr: (message) => output.push(message),
      },
    });

    expect(workspace.created).toBe(false);
    expect(workspace.config.projects).toEqual([
      { id: 'api', name: 'api', path: 'projects/api' },
    ]);
    expect(output.join('\n')).toContain('Workspace initialized automatically');
  });

  it('adds, lists, and removes workspace projects without indexing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));
    const projectRoot = join(root, 'services', 'catalog');
    await mkdir(projectRoot, { recursive: true });
    await runCli(['init', root, '--empty']);

    const added = await runCli([
      'project', 'add', projectRoot,
      '--workspace', root,
      '--name', 'Catalog API',
      '--skip-codegraph',
    ]);
    const listed = JSON.parse(await runCli(['project', 'list', root, '--json']));

    expect(added).toContain('Project added: Catalog API (catalog-api)');
    expect(listed.projects).toEqual([
      { id: 'catalog-api', name: 'Catalog API', path: 'services/catalog' },
    ]);

    const removed = await runCli(['project', 'remove', 'catalog-api', '--workspace', root]);
    expect(removed).toContain('Project removed: Catalog API (catalog-api)');
    expect(JSON.parse(await runCli(['project', 'list', root, '--json'])).projects).toEqual([]);
  });

  it('scans and registers all discovered projects in one command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cli-'));
    const projectsRoot = join(root, 'projects');
    await mkdir(join(projectsRoot, 'api', '.git'), { recursive: true });
    await mkdir(join(projectsRoot, 'web', 'src'), { recursive: true });
    await mkdir(join(projectsRoot, 'docs'), { recursive: true });
    await runCli(['init', root, '--empty']);

    const output = await runCli([
      'project', 'scan', '--workspace', root, '--skip-codegraph',
    ]);
    const listed = JSON.parse(await runCli(['project', 'list', root, '--json']));

    expect(output).toContain(`Scanning for projects: ${projectsRoot}`);
    expect(output).toContain('Project added: api (api)');
    expect(output).toContain('Project added: web (web)');
    expect(output).toContain('Scan complete: 2 added · 0 indexed · 0 already registered · 0 failed');
    expect(listed.projects.map((project: { path: string }) => project.path)).toEqual([
      'projects/api',
      'projects/web',
    ]);
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
