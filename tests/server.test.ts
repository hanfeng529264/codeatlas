import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCodeGraphSnapshot } from '../src/adapters/codegraph.js';
import { initWorkspace } from '../src/core/workspace.js';
import { buildServer } from '../src/server/app.js';
import { createCodeGraphFixture } from './fixtures/codegraph-db.js';

describe('local query service', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-server-'));
    const workspace = await initWorkspace(root);
    createCodeGraphFixture(root);
    const snapshot = await loadCodeGraphSnapshot(workspace);
    app = await buildServer({ workspace, snapshot, token: 'test-token' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects API requests without the session token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/status' });

    expect(response.statusCode).toBe(401);
  });

  it('returns workspace health and complete graph counts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { 'x-codeatlas-token': 'test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspace: { name: expect.any(String) },
      graph: { totalNodes: 7, totalEdges: 7, truncated: false },
    });
  });

  it('searches symbols and returns their evidence', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=login',
      headers: { 'x-codeatlas-token': 'test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      label: 'login',
      evidenceClass: 'static-derived',
    });
  });

  it('returns a method neighborhood with explicit projection counts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/graph/neighborhood',
      headers: { 'x-codeatlas-token': 'test-token' },
      payload: {
        nodeId: 'symbol:n-auth',
        direction: 'out',
        depth: 1,
        relationTypes: ['CALLS'],
      },
    });

    expect(response.statusCode).toBe(200);
    const graph = response.json();
    expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual([
      'symbol:n-auth',
      'symbol:n-session',
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.projection).toMatchObject({ returnedNodes: 2, truncated: false });
  });

  it('finds the shortest path between two symbols', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/graph/path',
      headers: { 'x-codeatlas-token': 'test-token' },
      payload: {
        source: 'symbol:n-auth',
        target: 'symbol:n-session',
        relationTypes: ['CALLS'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().path).toEqual(['symbol:n-auth', 'symbol:n-session']);
  });
});
