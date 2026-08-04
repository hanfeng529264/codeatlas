import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findWorkspaceRoot,
  initWorkspace,
  loadWorkspace,
} from '../src/core/workspace.js';

describe('workspace lifecycle', () => {
  it('initializes the explicit directory and persists a portable config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-workspace-'));

    const workspace = await initWorkspace(root);

    expect(workspace.rootPath).toBe(root);
    expect(workspace.config.schemaVersion).toBe(1);
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
});
