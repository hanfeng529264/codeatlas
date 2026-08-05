import type { GraphEdge, GraphNode } from '../core/types.js';
import type { DataFlowOverlay } from './provider.js';

export interface MergedDataFlowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const DATA_RESOURCE_KINDS = new Set([
  'cache',
  'database',
  'external_api',
  'table',
  'topic',
]);

function normalized(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function canonicalQualifiedName(value: string | undefined): string {
  return normalized(value).replaceAll('::', '.').replaceAll('#', '.');
}

function fileAnchorKey(node: GraphNode): string | undefined {
  if (!node.filePath || !node.language) return undefined;
  return `${normalized(node.filePath)}\0${normalized(node.language)}\0${normalized(node.label)}`;
}

function qualifiedAnchorKey(node: GraphNode): string | undefined {
  const qualifiedName = canonicalQualifiedName(node.qualifiedName);
  if (!qualifiedName || !node.language) return undefined;
  return `${normalized(node.language)}\0${qualifiedName}`;
}

function addCandidate(index: Map<string, GraphNode[]>, key: string | undefined, node: GraphNode): void {
  if (!key) return;
  const candidates = index.get(key) ?? [];
  candidates.push(node);
  index.set(key, candidates);
}

function uniqueCandidate(index: Map<string, GraphNode[]>, key: string | undefined): GraphNode | undefined {
  if (!key) return undefined;
  const candidates = index.get(key) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function providerId(node: GraphNode): string {
  const metadataId = node.metadata.providerId;
  return typeof metadataId === 'string' ? metadataId : node.source;
}

function annotateProvider(node: GraphNode, id: string): GraphNode {
  const existing = Array.isArray(node.metadata.dataFlowProviders)
    ? node.metadata.dataFlowProviders.filter((value): value is string => typeof value === 'string')
    : [];
  const dataFlowProviders = [...new Set([...existing, id])].sort();
  return { ...node, metadata: { ...node.metadata, dataFlowProviders } };
}

export function mergeDataFlowOverlay(
  baseNodes: GraphNode[],
  baseEdges: GraphEdge[],
  overlay: DataFlowOverlay,
): MergedDataFlowGraph {
  const nodeMap = new Map(baseNodes.map((node) => [node.id, node]));
  const fileAnchors = new Map<string, GraphNode[]>();
  const qualifiedAnchors = new Map<string, GraphNode[]>();
  for (const node of baseNodes) {
    addCandidate(fileAnchors, fileAnchorKey(node), node);
    addCandidate(qualifiedAnchors, qualifiedAnchorKey(node), node);
  }

  const remappedIds = new Map<string, string>();
  for (const node of overlay.nodes) {
    const exact = nodeMap.get(node.id);
    const matched = DATA_RESOURCE_KINDS.has(node.kind)
      ? exact
      : exact
        ?? uniqueCandidate(fileAnchors, fileAnchorKey(node))
        ?? uniqueCandidate(qualifiedAnchors, qualifiedAnchorKey(node));
    if (matched) {
      remappedIds.set(node.id, matched.id);
      nodeMap.set(matched.id, annotateProvider(matched, providerId(node)));
    } else {
      remappedIds.set(node.id, node.id);
      nodeMap.set(node.id, node);
    }
  }

  const edgeMap = new Map<string, GraphEdge>();
  for (const edge of baseEdges) {
    edgeMap.set(`${edge.source}\0${edge.target}\0${edge.kind}`, edge);
  }
  for (const edge of overlay.edges) {
    const source = remappedIds.get(edge.source) ?? edge.source;
    const target = remappedIds.get(edge.target) ?? edge.target;
    if (!nodeMap.has(source) || !nodeMap.has(target)) continue;
    const key = `${source}\0${target}\0${edge.kind}`;
    if (edgeMap.has(key)) continue;
    edgeMap.set(key, {
      ...edge,
      id: `dataflow-edge:${edge.sourceName}:${edge.kind}:${source}:${target}`,
      source,
      target,
    });
  }

  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}
