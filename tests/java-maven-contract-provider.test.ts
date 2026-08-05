import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, Workspace } from '../src/core/types.js';
import { javaMavenContractProvider, javaMavenInternals } from '../src/cross-project/providers/java-maven.js';

function node(input: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'label'>): GraphNode {
  return { source: 'codegraph', evidenceClass: 'static-derived', confidence: 1, metadata: {}, ...input };
}

function contains(source: string, target: string): GraphEdge {
  return {
    id: `contains:${source}:${target}`, source, target, kind: 'CONTAINS', sourceName: 'codegraph',
    evidenceClass: 'static-derived', confidence: 1, metadata: {},
  };
}

async function fixture(options: { dependency?: boolean; duplicateTarget?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codeatlas-java-contract-'));
  const consumerRoot = join(root, 'consumer');
  const providerRoot = join(root, 'provider');
  const consumerFile = 'src/main/java/com/example/api/OrderAppService.java';
  await mkdir(join(consumerRoot, 'src/main/java/com/example/api'), { recursive: true });
  await mkdir(join(providerRoot, 'contract'), { recursive: true });
  await writeFile(join(consumerRoot, consumerFile), `
package com.example.api;
import com.example.contract.OrderFacade;
public class OrderAppService {
  private final OrderFacade orderFacade;
  public Order getOrder(String id) {
    return orderFacade.getOrder(id);
  }
}
`);
  await writeFile(join(consumerRoot, 'pom.xml'), `
<project>
  <parent><groupId>com.example</groupId><artifactId>parent</artifactId><version>1</version></parent>
  <artifactId>consumer</artifactId>
  <dependencies>${options.dependency === false ? '' : `
    <dependency><groupId>com.example</groupId><artifactId>order-contract</artifactId><version>2.1</version></dependency>`}
  </dependencies>
</project>`);
  await writeFile(join(providerRoot, 'contract/pom.xml'), `
<project><groupId>com.example</groupId><artifactId>order-contract</artifactId><version>2.1</version></project>`);

  const workspace: Workspace = {
    rootPath: root,
    configPath: join(root, '.codeatlas/workspace.json'),
    created: false,
    config: {
      schemaVersion: 2, id: 'workspace', name: 'workspace', root: '.',
      initializedAt: '2026-08-05T00:00:00.000Z',
      projects: [
        { id: 'consumer', name: 'Consumer', path: 'consumer' },
        { id: 'provider', name: 'Provider', path: 'provider' },
      ],
    },
  };
  const nodes: GraphNode[] = [
    node({
      id: 'consumer:getOrder', kind: 'method', label: 'getOrder', projectId: 'consumer',
      language: 'java', filePath: consumerFile, startLine: 6, endLine: 8,
      qualifiedName: 'com.example.api::OrderAppService::getOrder', metadata: { signature: 'Order (String id)' },
    }),
    node({
      id: 'provider:facade', kind: 'interface', label: 'OrderFacade', projectId: 'provider',
      language: 'java', qualifiedName: 'com.example.contract::OrderFacade',
    }),
    node({
      id: 'provider:getOrder', kind: 'method', label: 'getOrder', projectId: 'provider',
      language: 'java', qualifiedName: 'com.example.contract::OrderFacade::getOrder',
      metadata: { signature: 'Order (String id)' },
    }),
  ];
  const edges = [contains('provider:facade', 'provider:getOrder')];
  if (options.duplicateTarget) {
    nodes.push(node({
      id: 'provider:getOrder-overload', kind: 'method', label: 'getOrder', projectId: 'provider',
      language: 'java', qualifiedName: 'com.example.contract::OrderFacade::getOrder',
      metadata: { signature: 'Order (Object value)' },
    }));
    edges.push(contains('provider:facade', 'provider:getOrder-overload'));
  }
  return { workspace, nodes, edges };
}

describe('Java Maven contract provider', () => {
  it('connects a typed Java call through its Maven dependency', async () => {
    const overlay = await javaMavenContractProvider.extract(await fixture());

    expect(overlay.diagnostics).toEqual([]);
    expect(overlay.edges).toEqual([
      expect.objectContaining({
        source: 'consumer:getOrder', target: 'provider:getOrder', kind: 'REMOTE_CALLS',
        evidenceClass: 'static-derived', confidence: 0.94,
        metadata: expect.objectContaining({
          interface: 'com.example.contract.OrderFacade', dependency: 'com.example:order-contract', argumentCount: 1,
        }),
      }),
    ]);
  });

  it('does not bridge a same-name contract without a Maven dependency', async () => {
    expect((await javaMavenContractProvider.extract(await fixture({ dependency: false }))).edges).toEqual([]);
  });

  it('skips targets that remain ambiguous after arity matching', async () => {
    const overlay = await javaMavenContractProvider.extract(await fixture({ duplicateTarget: true }));
    expect(overlay.edges).toEqual([]);
    expect(overlay.diagnostics).toContainEqual(expect.objectContaining({
      code: 'java-contract-call-ambiguous', projectId: 'consumer',
    }));
  });

  it('counts nested call arguments and generic signature parameters', () => {
    expect(javaMavenInternals.parameterCount('Result (Map<String, Value> values, String id)')).toBe(2);
    expect(javaMavenInternals.callArgumentCount('(first(a, b), Map.of("x", 1))', 0)).toBe(2);
  });
});
