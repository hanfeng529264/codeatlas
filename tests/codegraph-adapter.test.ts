import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  inspectCodeGraph,
  loadCodeGraphSnapshot,
} from '../src/adapters/codegraph.js';
import { initWorkspace } from '../src/core/workspace.js';
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
        source: 'symbol:n-auth',
        target: 'symbol:n-session',
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
});
