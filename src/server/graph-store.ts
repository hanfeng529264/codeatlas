import type { GraphEdge, GraphNode, GraphSnapshot } from '../core/types.js';

export type GraphView = 'full' | 'directory' | 'structure' | 'methods' | 'calls';
export type GraphDirection = 'in' | 'out' | 'both';

export interface GraphProjection {
  version: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  projection: {
    totalMatchedNodes: number;
    totalMatchedEdges: number;
    returnedNodes: number;
    returnedEdges: number;
    truncated: boolean;
    truncationReason?: string;
    projectIds?: string[];
  };
  path?: string[];
}

interface NeighborhoodOptions {
  nodeId: string;
  direction?: GraphDirection;
  depth?: number;
  relationTypes?: string[];
  maxNodes?: number;
}

interface PathOptions {
  source: string;
  target: string;
  relationTypes?: string[];
  maxDepth?: number;
}

const DIRECTORY_KINDS = new Set(['workspace', 'project', 'module', 'directory', 'file']);
const STRUCTURE_RELATIONS = new Set([
  'CONTAINS',
  'DEFINES',
  'EXTENDS',
  'IMPLEMENTS',
  'IMPORTS',
  'REFERENCES',
]);
const METHOD_KINDS = new Set(['file', 'class', 'interface', 'function', 'method']);
const CALL_RELATIONS = new Set(['CALLS', 'ROUTES_TO', 'PUBLISHES', 'SUBSCRIBES']);

function projection(
  snapshot: GraphSnapshot,
  nodes: GraphNode[],
  edges: GraphEdge[],
  totals = { nodes: nodes.length, edges: edges.length },
  truncationReason?: string,
  projectIds?: string[],
): GraphProjection {
  return {
    version: snapshot.version,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    projection: {
      totalMatchedNodes: totals.nodes,
      totalMatchedEdges: totals.edges,
      returnedNodes: nodes.length,
      returnedEdges: edges.length,
      truncated: Boolean(truncationReason),
      truncationReason,
      projectIds,
    },
  };
}

export class GraphStore {
  readonly snapshot: GraphSnapshot;
  private readonly nodes = new Map<string, GraphNode>();
  private readonly incoming = new Map<string, GraphEdge[]>();
  private readonly outgoing = new Map<string, GraphEdge[]>();

  constructor(snapshot: GraphSnapshot) {
    this.snapshot = snapshot;
    for (const node of snapshot.nodes) this.nodes.set(node.id, node);
    for (const edge of snapshot.edges) {
      const outgoing = this.outgoing.get(edge.source) ?? [];
      outgoing.push(edge);
      this.outgoing.set(edge.source, outgoing);
      const incoming = this.incoming.get(edge.target) ?? [];
      incoming.push(edge);
      this.incoming.set(edge.target, incoming);
    }
  }

  getNode(id: string): (GraphNode & { incoming: number; outgoing: number }) | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    return {
      ...node,
      incoming: this.incoming.get(id)?.length ?? 0,
      outgoing: this.outgoing.get(id)?.length ?? 0,
    };
  }

  search(query: string, limit = 20, projectIds?: string[]): GraphNode[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const selectedProjects = projectIds?.length ? new Set(projectIds) : null;
    return [...this.nodes.values()]
      .filter((node) => !selectedProjects || Boolean(node.projectId && selectedProjects.has(node.projectId)))
      .map((node) => {
        const label = node.label.toLocaleLowerCase();
        const qualified = node.qualifiedName?.toLocaleLowerCase() ?? '';
        const file = node.filePath?.toLocaleLowerCase() ?? '';
        let score = 0;
        if (label === needle) score = 100;
        else if (label.startsWith(needle)) score = 70;
        else if (qualified.includes(needle)) score = 50;
        else if (label.includes(needle)) score = 40;
        else if (file.includes(needle)) score = 20;
        return { node, score };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((result) => result.node);
  }

  view(view: GraphView, projectIds?: string[]): GraphProjection {
    const selectedProjects = projectIds?.length ? new Set(projectIds) : null;
    const scopedNodes = selectedProjects
      ? this.snapshot.nodes.filter(
          (node) => node.kind === 'workspace' || Boolean(node.projectId && selectedProjects.has(node.projectId)),
        )
      : this.snapshot.nodes;
    const scopedNodeIds = new Set(scopedNodes.map((node) => node.id));
    const scopedEdges = selectedProjects
      ? this.snapshot.edges.filter(
          (edge) => scopedNodeIds.has(edge.source) && scopedNodeIds.has(edge.target),
        )
      : this.snapshot.edges;
    if (view === 'full') {
      return projection(
        this.snapshot,
        scopedNodes,
        scopedEdges,
        selectedProjects
          ? { nodes: scopedNodes.length, edges: scopedEdges.length }
          : { nodes: this.snapshot.counts.totalNodes, edges: this.snapshot.counts.totalEdges },
        this.snapshot.truncated ? this.snapshot.truncationReason : undefined,
        projectIds,
      );
    }

    const nodePredicate = (node: GraphNode): boolean => {
      if (view === 'directory') return DIRECTORY_KINDS.has(node.kind);
      if (view === 'methods') return METHOD_KINDS.has(node.kind);
      return true;
    };
    const candidateNodes = scopedNodes.filter(nodePredicate);
    const nodeIds = new Set(candidateNodes.map((node) => node.id));
    const edgePredicate = (edge: GraphEdge): boolean => {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
      if (view === 'directory') return edge.kind === 'CONTAINS';
      if (view === 'structure' || view === 'methods') return STRUCTURE_RELATIONS.has(edge.kind);
      return CALL_RELATIONS.has(edge.kind);
    };
    const candidateEdges = scopedEdges.filter(edgePredicate);
    if (view === 'calls') {
      const connected = new Set(candidateEdges.flatMap((edge) => [edge.source, edge.target]));
      const result = projection(
        this.snapshot,
        candidateNodes.filter((node) => connected.has(node.id)),
        candidateEdges,
      );
      result.projection.projectIds = projectIds;
      return result;
    }
    return projection(this.snapshot, candidateNodes, candidateEdges, undefined, undefined, projectIds);
  }

  neighborhood(options: NeighborhoodOptions): GraphProjection {
    const root = this.nodes.get(options.nodeId);
    if (!root) throw new Error(`Unknown graph node: ${options.nodeId}`);
    const direction = options.direction ?? 'both';
    const maxDepth = Math.max(0, Math.min(options.depth ?? 1, 8));
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 500, 5_000));
    const relationTypes = options.relationTypes?.length
      ? new Set(options.relationTypes.map((kind) => kind.toUpperCase()))
      : null;
    const visited = new Set([root.id]);
    let frontier = [root.id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const candidates = [
          ...(direction !== 'in' ? (this.outgoing.get(nodeId) ?? []) : []),
          ...(direction !== 'out' ? (this.incoming.get(nodeId) ?? []) : []),
        ];
        for (const edge of candidates) {
          if (relationTypes && !relationTypes.has(edge.kind)) continue;
          const adjacent = edge.source === nodeId ? edge.target : edge.source;
          if (!visited.has(adjacent) && visited.size < maxNodes) {
            visited.add(adjacent);
            next.push(adjacent);
          }
        }
      }
      frontier = next;
    }

    const nodes = [...visited].map((id) => this.nodes.get(id)).filter(Boolean) as GraphNode[];
    const edges = this.snapshot.edges.filter(
      (edge) =>
        visited.has(edge.source) &&
        visited.has(edge.target) &&
        (!relationTypes || relationTypes.has(edge.kind)),
    );
    const hitBudget = visited.size >= maxNodes;
    return projection(
      this.snapshot,
      nodes,
      edges,
      { nodes: nodes.length + (hitBudget ? 1 : 0), edges: edges.length },
      hitBudget ? `Neighborhood reached the ${maxNodes.toLocaleString()} node budget.` : undefined,
    );
  }

  shortestPath(options: PathOptions): GraphProjection {
    if (!this.nodes.has(options.source) || !this.nodes.has(options.target)) {
      throw new Error('Path source or target is not present in the graph.');
    }
    const relationTypes = options.relationTypes?.length
      ? new Set(options.relationTypes.map((kind) => kind.toUpperCase()))
      : null;
    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 12, 40));
    const previous = new Map<string, { node: string; edge: GraphEdge }>();
    const visited = new Set([options.source]);
    let frontier = [options.source];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const edge of this.outgoing.get(nodeId) ?? []) {
          if (relationTypes && !relationTypes.has(edge.kind)) continue;
          if (visited.has(edge.target)) continue;
          visited.add(edge.target);
          previous.set(edge.target, { node: nodeId, edge });
          if (edge.target === options.target) {
            frontier = [];
            next.length = 0;
            break;
          }
          next.push(edge.target);
        }
      }
      if (visited.has(options.target)) break;
      frontier = next;
    }

    if (!visited.has(options.target)) {
      return { ...projection(this.snapshot, [], []), path: [] };
    }
    const path = [options.target];
    const edges: GraphEdge[] = [];
    let current = options.target;
    while (current !== options.source) {
      const step = previous.get(current);
      if (!step) break;
      edges.unshift(step.edge);
      current = step.node;
      path.unshift(current);
    }
    const nodes = path.map((id) => this.nodes.get(id)).filter(Boolean) as GraphNode[];
    return { ...projection(this.snapshot, nodes, edges), path };
  }
}
