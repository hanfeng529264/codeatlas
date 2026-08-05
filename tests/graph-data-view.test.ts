import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, GraphSnapshot } from '../src/core/types.js';
import { GraphStore } from '../src/server/graph-store.js';

function node(id: string, kind: string, projectId = 'orders'): GraphNode {
  return {
    id,
    kind,
    label: id,
    projectId,
    source: 'test',
    evidenceClass: 'static-derived',
    confidence: 1,
    metadata: {},
  };
}

function edge(id: string, source: string, target: string, kind: string): GraphEdge {
  return {
    id,
    source,
    target,
    kind,
    sourceName: 'test',
    evidenceClass: 'static-derived',
    confidence: 1,
    metadata: {},
  };
}

function snapshot(nodes: GraphNode[], edges: GraphEdge[]): GraphSnapshot {
  return {
    version: 'data-test',
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

describe('data graph projection', () => {
  it('keeps only directed call chains that can reach a data resource', () => {
    const nodes = [
      node('route:list', 'route'),
      node('controller:list', 'method'),
      node('service:list', 'method'),
      node('sql:list', 'method'),
      node('table:orders:order_info', 'table'),
      node('controller:health', 'method'),
      node('service:health', 'method'),
    ];
    const edges = [
      edge('route-controller', 'route:list', 'controller:list', 'ROUTES_TO'),
      edge('controller-service', 'controller:list', 'service:list', 'CALLS'),
      edge('service-sql', 'service:list', 'sql:list', 'CALLS'),
      edge('sql-table', 'sql:list', 'table:orders:order_info', 'READS_FROM'),
      edge('health-call', 'controller:health', 'service:health', 'CALLS'),
      edge('unrelated-reference', 'service:health', 'sql:list', 'REFERENCES'),
    ];

    const result = new GraphStore(snapshot(nodes, edges)).view('data', undefined, { complete: true });

    expect(result.nodes.map(({ id }) => id)).toEqual([
      'route:list',
      'controller:list',
      'service:list',
      'sql:list',
      'table:orders:order_info',
    ]);
    expect(result.edges.map(({ id }) => id)).toEqual([
      'route-controller',
      'controller-service',
      'service-sql',
      'sql-table',
    ]);
    expect(result.projection).toMatchObject({
      totalMatchedNodes: 5,
      totalMatchedEdges: 4,
      returnedNodes: 5,
      returnedEdges: 4,
      truncated: false,
    });
  });

  it('includes mapper-to-table mappings and isolates selected projects', () => {
    const nodes = [
      node('mapper:orders', 'interface', 'orders'),
      node('table:orders:shared', 'table', 'orders'),
      node('mapper:billing', 'interface', 'billing'),
      node('table:billing:shared', 'table', 'billing'),
    ];
    const edges = [
      edge('orders-map', 'mapper:orders', 'table:orders:shared', 'MAPS_TO'),
      edge('billing-map', 'mapper:billing', 'table:billing:shared', 'MAPS_TO'),
    ];

    const result = new GraphStore(snapshot(nodes, edges)).view('data', ['billing'], { complete: true });

    expect(result.nodes.map(({ id }) => id)).toEqual(['mapper:billing', 'table:billing:shared']);
    expect(result.edges.map(({ id }) => id)).toEqual(['billing-map']);
    expect(result.projection.projectIds).toEqual(['billing']);
  });

  it('preserves table nodes when a large data graph is reduced to an overview', () => {
    const table = node('table:orders:order_info', 'table');
    const callers = Array.from({ length: 130 }, (_, index) => node(`method:${index}`, 'method'));
    const edges = callers.map((caller, index) => edge(
      `edge:${index}`,
      caller.id,
      index === callers.length - 1 ? table.id : callers[index + 1].id,
      index === callers.length - 1 ? 'READS_FROM' : 'CALLS',
    ));

    const result = new GraphStore(snapshot([...callers, table], edges)).view('data', undefined, { maxNodes: 100 });

    expect(result.nodes).toHaveLength(100);
    expect(result.nodes).toContainEqual(expect.objectContaining({ id: table.id }));
    expect(result.projection).toMatchObject({
      totalMatchedNodes: 131,
      returnedNodes: 100,
      truncated: true,
      overview: true,
    });
  });
});
