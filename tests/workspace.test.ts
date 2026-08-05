import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addWorkspaceProject,
  findWorkspaceRoot,
  initWorkspace,
  loadWorkspace,
  removeWorkspaceProject,
  resolveProjectRoot,
} from '../src/core/workspace.js';

describe('workspace lifecycle', () => {
  it('initializes the explicit directory and persists a portable config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));

    const workspace = await initWorkspace(root);

    expect(workspace.rootPath).toBe(root);
    expect(workspace.config.schemaVersion).toBe(2);
    expect(workspace.config.root).toBe('.');
    expect(workspace.config.name).toBe(root.split('/').at(-1));
    const persisted = JSON.parse(
      await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'),
    );
    expect(persisted.id).toBe(workspace.config.id);
  });

  it('is idempotent and keeps the workspace identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));

    const first = await initWorkspace(root);
    const second = await initWorkspace(root);

    expect(second.config.id).toBe(first.config.id);
    expect(second.created).toBe(false);
  });

  it('finds and loads a workspace from a nested directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));
    const nested = join(root, 'packages', 'app', 'src');
    await mkdir(nested, { recursive: true });
    await initWorkspace(root);

    expect(await findWorkspaceRoot(nested)).toBe(root);
    expect((await loadWorkspace(nested)).rootPath).toBe(root);
  });

  it('rejects a path that does not exist', async () => {
    const root = join(tmpdir(), `missing-codeatlas-${Date.now()}`);

    await expect(initWorkspace(root)).rejects.toThrow('does not exist');
  });

  it('creates an empty Schema 2 workspace for multi-project aggregation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));

    const workspace = await initWorkspace(root, { empty: true });

    expect(workspace.config.schemaVersion).toBe(2);
    expect(workspace.config.projects).toEqual([]);
    const persisted = JSON.parse(
      await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'),
    );
    expect(persisted).not.toHaveProperty('codegraph');
  });

  it('migrates a Schema 1 workspace without changing its identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));
    const directory = join(root, '.codeatlas');
    await mkdir(directory);
    await writeFile(
      join(directory, 'workspace.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: '2bb87472-0491-4a09-98ce-d6aba9dfd20d',
        name: 'legacy',
        root: '.',
        initializedAt: '2026-08-04T00:00:00.000Z',
        projects: [{ id: 'root', name: 'legacy', path: '.' }],
        codegraph: { path: '.' },
      }, null, 2)}\n`,
    );

    const workspace = await loadWorkspace(root);

    expect(workspace.config).toMatchObject({
      schemaVersion: 2,
      id: '2bb87472-0491-4a09-98ce-d6aba9dfd20d',
      projects: [{ id: 'root', name: 'legacy', path: '.' }],
    });
    const persisted = JSON.parse(
      await readFile(join(root, '.codeatlas', 'workspace.json'), 'utf8'),
    );
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted).not.toHaveProperty('codegraph');
  });

  it('adds and removes a portable project inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));
    const projectRoot = join(root, 'services', 'billing');
    await mkdir(projectRoot, { recursive: true });
    await initWorkspace(root, { empty: true });

    const added = await addWorkspaceProject(root, projectRoot, { name: 'Billing API' });

    expect(added.project).toMatchObject({
      id: 'billing-api',
      name: 'Billing API',
      path: 'services/billing',
    });
    expect(resolveProjectRoot(added.workspace, added.project)).toBe(projectRoot);
    expect((await loadWorkspace(root)).config.projects).toHaveLength(1);

    const removed = await removeWorkspaceProject(root, 'billing-api');
    expect(removed.project.id).toBe('billing-api');
    expect(removed.workspace.config.projects).toEqual([]);
  });

  it('rejects duplicate and out-of-workspace project paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));
    const projectRoot = join(root, 'app');
    const outside = await mkdtemp(join(tmpdir(), 'codeatlas-outside-'));
    await mkdir(projectRoot);
    await initWorkspace(root, { empty: true });
    await addWorkspaceProject(root, projectRoot);

    await expect(addWorkspaceProject(root, projectRoot)).rejects.toThrow('already registered');
    await expect(addWorkspaceProject(root, outside)).rejects.toThrow('inside the workspace');
  });
});
