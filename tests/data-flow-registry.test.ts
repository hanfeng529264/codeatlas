import { describe, expect, it, vi } from 'vitest';
import type { GraphEdge, GraphNode } from '../src/core/types.js';
import type {
  DataFlowOverlay,
  DataFlowProjectContext,
  DataFlowProvider,
} from '../src/data-flow/provider.js';
import { DataFlowProviderRegistry } from '../src/data-flow/registry.js';

const context: DataFlowProjectContext = {
  workspaceRoot: '/workspace',
  projectRoot: '/workspace/orders',
  project: { id: 'orders', name: 'Orders', path: 'orders' },
};

function node(id: string): GraphNode {
  return {
    id,
    kind: 'table',
    label: id,
    projectId: 'orders',
    source: 'test-provider',
    evidenceClass: 'static-derived',
    confidence: 1,
    metadata: {},
  };
}

function edge(id: string): GraphEdge {
  return {
    id,
    source: 'sql:orders:list',
    target: 'table:orders:order_info',
    kind: 'READS_FROM',
    sourceName: 'test-provider',
    evidenceClass: 'static-derived',
    confidence: 1,
    metadata: {},
  };
}

function provider(id: string, overlay: DataFlowOverlay, supported = true): DataFlowProvider {
  return {
    id,
    supports: vi.fn().mockResolvedValue(supported),
    extract: vi.fn().mockResolvedValue(overlay),
  };
}

describe('DataFlowProviderRegistry', () => {
  it('runs every matching provider so polyglot projects can combine facts', async () => {
    const java = provider('java-mybatis', {
      nodes: [node('table:orders:order_info')],
      edges: [edge('reads:orders:list:order_info')],
      diagnostics: [],
    });
    const typescript = provider('typescript-prisma', {
      nodes: [node('table:orders:customer')],
      edges: [],
      diagnostics: [],
    });

    const overlay = await new DataFlowProviderRegistry([java, typescript]).extract(context);

    expect(overlay.nodes.map(({ id }) => id)).toEqual([
      'table:orders:order_info',
      'table:orders:customer',
    ]);
    expect(java.extract).toHaveBeenCalledWith(context);
    expect(typescript.extract).toHaveBeenCalledWith(context);
  });

  it('skips unsupported providers and deduplicates shared graph facts by ID', async () => {
    const sharedNode = node('table:orders:order_info');
    const sharedEdge = edge('reads:orders:list:order_info');
    const first = provider('first', { nodes: [sharedNode], edges: [sharedEdge], diagnostics: [] });
    const second = provider('second', { nodes: [sharedNode], edges: [sharedEdge], diagnostics: [] });
    const unsupported = provider('python-sqlalchemy', { nodes: [node('unexpected')], edges: [], diagnostics: [] }, false);

    const overlay = await new DataFlowProviderRegistry([first, unsupported, second]).extract(context);

    expect(overlay.nodes).toEqual([sharedNode]);
    expect(overlay.edges).toEqual([sharedEdge]);
    expect(unsupported.extract).not.toHaveBeenCalled();
  });

  it('isolates provider failures and returns diagnostics without losing other facts', async () => {
    const healthy = provider('java-mybatis', {
      nodes: [node('table:orders:order_info')],
      edges: [],
      diagnostics: [],
    });
    const broken: DataFlowProvider = {
      id: 'typescript-prisma',
      supports: () => true,
      extract: () => { throw new Error('fixture failed'); },
    };

    const overlay = await new DataFlowProviderRegistry([broken, healthy]).extract(context);

    expect(overlay.nodes).toHaveLength(1);
    expect(overlay.diagnostics).toEqual([
      {
        providerId: 'typescript-prisma',
        severity: 'error',
        code: 'provider-extraction-failed',
        message: 'Data-flow provider "typescript-prisma" failed during extraction: fixture failed',
      },
    ]);
  });

  it('rejects duplicate provider IDs', () => {
    const registry = new DataFlowProviderRegistry([provider('java-mybatis', { nodes: [], edges: [], diagnostics: [] })]);

    expect(() => registry.register(provider('java-mybatis', { nodes: [], edges: [], diagnostics: [] })))
      .toThrow('Data-flow provider "java-mybatis" is already registered.');
  });
});
