import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, GraphSnapshot } from '../src/core/types.js';
import { GraphStore } from '../src/server/graph-store.js';

function largeSnapshot(): GraphSnapshot {
  const nodes: GraphNode[] = [{
    id: 'workspace:test',
    kind: 'workspace',
    label: 'Test workspace',
    source: 'test',
    evidenceClass: 'verified',
    confidence: 1,
    metadata: {},
  }];
  const edges: GraphEdge[] = [];
  for (const projectId of ['api', 'web', 'worker']) {
    const projectNode: GraphNode = {
      id: `project:${projectId}`,
      kind: 'project',
      label: projectId,
      projectId,
      source: 'test',
      evidenceClass: 'verified',
      confidence: 1,
      metadata: {},
    };
    nodes.push(projectNode);
    edges.push({
      id: `contains:${projectId}`,
      source: 'workspace:test',
      target: projectNode.id,
      kind: 'CONTAINS',
      sourceName: 'test',
      evidenceClass: 'verified',
      confidence: 1,
      metadata: {},
    });
    for (let index = 0; index < 120; index += 1) {
      const node: GraphNode = {
        id: `${projectId}:method:${index}`,
        kind: index < 4 ? 'directory' : 'method',
        label: `${projectId}-${index}`,
        projectId,
        source: 'test',
        evidenceClass: 'static-derived',
        confidence: 1,
        metadata: {},
      };
      nodes.push(node);
      edges.push({
        id: `${projectId}:edge:${index}`,
        source: projectNode.id,
        target: node.id,
        kind: 'CONTAINS',
        sourceName: 'test',
        evidenceClass: 'static-derived',
        confidence: 1,
        metadata: {},
      });
    }
  }
  return {
    version: 'test',
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    diagnostics: [],
    counts: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      returnedNodes: nodes.length,
      returnedEdges: edges.length,
    },
    projects: [],
    truncated: false,
  };
}

describe('large graph overview', () => {
  it('keeps every project represented while bounding the default projection', () => {
    const snapshot = largeSnapshot();
    const result = new GraphStore(snapshot).view('full', undefined, { maxNodes: 100 });

    expect(result.nodes).toHaveLength(100);
    expect(result.projection).toMatchObject({
      totalMatchedNodes: snapshot.nodes.length,
      returnedNodes: 100,
      truncated: true,
      overview: true,
    });
    expect(result.nodes.filter((node) => node.kind === 'project').map((node) => node.projectId)).toEqual([
      'api',
      'web',
      'worker',
    ]);
    for (const projectId of ['api', 'web', 'worker']) {
      expect(result.nodes.some((node) => node.projectId === projectId && node.kind !== 'project')).toBe(true);
    }
  });

  it('returns the complete graph only when explicitly requested', () => {
    const snapshot = largeSnapshot();
    const result = new GraphStore(snapshot).view('full', undefined, { maxNodes: 100, complete: true });

    expect(result.nodes).toHaveLength(snapshot.nodes.length);
    expect(result.edges).toHaveLength(snapshot.edges.length);
    expect(result.projection).toMatchObject({ truncated: false, overview: false });
  });
});
