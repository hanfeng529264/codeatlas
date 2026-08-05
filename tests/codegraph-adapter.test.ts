import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  inspectCodeGraph,
  loadCodeGraphSnapshot,
} from '../src/adapters/codegraph.js';
import { addWorkspaceProject, initWorkspace } from '../src/core/workspace.js';
import { createCodeGraphFixture } from './fixtures/codegraph-db.js';

describe('CodeGraph adapter', () => {
  it('reports an uninitialized workspace without failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));

    const status = await inspectCodeGraph(root);

    expect(status.initialized).toBe(false);
    expect(status.compatible).toBe(true);
    expect(status.databasePath).toContain('.codegraph/codegraph.db');
  });

  it('normalizes the complete CodeGraph database into one workspace graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const workspace = await initWorkspace(root);
    createCodeGraphFixture(root);

    const snapshot = await loadCodeGraphSnapshot(workspace);

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.nodes.find((node) => node.kind === 'workspace')).toBeTruthy();
    expect(snapshot.nodes.filter((node) => node.kind === 'file')).toHaveLength(2);
    expect(snapshot.nodes.some((node) => node.id.startsWith('symbol:file:'))).toBe(false);
    expect(snapshot.nodes.filter((node) => node.kind === 'function')).toHaveLength(2);
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        source: 'symbol:root:n-auth',
        target: 'symbol:root:n-session',
        kind: 'CALLS',
        evidenceClass: 'static-derived',
      }),
    );
    expect(snapshot.counts.totalNodes).toBe(snapshot.nodes.length);
  });

  it('rejects an incompatible database instead of guessing its schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const indexDirectory = join(root, '.codegraph');
    await mkdir(indexDirectory);
    const db = new DatabaseSync(join(indexDirectory, 'codegraph.db'));
    db.exec('CREATE TABLE something_else (id TEXT)');
    db.close();

    const status = await inspectCodeGraph(root);

    expect(status.initialized).toBe(true);
    expect(status.compatible).toBe(false);
    expect(status.message).toContain('required tables');
  });

  it('reports explicit truncation when a node budget is applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const workspace = await initWorkspace(root);
    createCodeGraphFixture(root);

    const snapshot = await loadCodeGraphSnapshot(workspace, { maxNodes: 4 });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncationReason).toContain('node budget');
    expect(snapshot.counts.totalNodes).toBeGreaterThan(snapshot.counts.returnedNodes);
  });

  it('aggregates independent project indexes with namespaced ids and package dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const webRoot = join(root, 'apps', 'web');
    const apiRoot = join(root, 'services', 'api');
    await mkdir(webRoot, { recursive: true });
    await mkdir(apiRoot, { recursive: true });
    await initWorkspace(root, { empty: true });
    await addWorkspaceProject(root, webRoot, { name: 'Web' });
    const apiProject = await addWorkspaceProject(root, apiRoot, { name: 'API' });
    createCodeGraphFixture(webRoot);
    createCodeGraphFixture(apiRoot);
    await writeFile(
      join(webRoot, 'package.json'),
      `${JSON.stringify({ name: '@example/web', dependencies: { '@example/api': 'workspace:*' } })}\n`,
    );
    await writeFile(
      join(apiRoot, 'package.json'),
      `${JSON.stringify({ name: '@example/api' })}\n`,
    );

    const snapshot = await loadCodeGraphSnapshot(apiProject.workspace);

    expect(snapshot.projects).toEqual([
      expect.objectContaining({ id: 'web', indexed: true, compatible: true }),
      expect.objectContaining({ id: 'api', indexed: true, compatible: true }),
    ]);
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'symbol:web:n-auth', projectId: 'web' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'symbol:api:n-auth', projectId: 'api' }));
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      source: 'project:web',
      target: 'project:api',
      kind: 'DEPENDS_ON',
      sourceName: 'package.json',
      evidenceClass: 'static-derived',
    }));
    expect(snapshot.truncated).toBe(false);
  });

  it('keeps healthy projects visible and reports missing project indexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const readyRoot = join(root, 'ready');
    const missingRoot = join(root, 'missing');
    await mkdir(readyRoot);
    await mkdir(missingRoot);
    await initWorkspace(root, { empty: true });
    await addWorkspaceProject(root, readyRoot, { name: 'Ready' });
    const missingProject = await addWorkspaceProject(root, missingRoot, { name: 'Missing' });
    createCodeGraphFixture(readyRoot);

    const snapshot = await loadCodeGraphSnapshot(missingProject.workspace);

    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'project:ready' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'project:missing' }));
    expect(snapshot.projects.find((project) => project.id === 'missing')).toMatchObject({ indexed: false });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncationReason).toContain('Missing');
  });
});
