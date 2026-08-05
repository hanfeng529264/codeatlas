import type { GraphEdge, GraphNode, GraphSnapshot } from '../core/types.js';

export type GraphView = 'full' | 'directory' | 'structure' | 'methods' | 'calls' | 'data';
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
    overview: boolean;
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

interface ViewOptions {
  complete?: boolean;
  maxNodes?: number;
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
const CALL_RELATIONS = new Set(['CALLS', 'REMOTE_CALLS', 'ROUTES_TO', 'PUBLISHES', 'SUBSCRIBES']);
const DATA_RESOURCE_KINDS = new Set([
  'cache',
  'database',
  'external_api',
  'table',
  'topic',
]);
const DATA_FLOW_RELATIONS = new Set([
  'CALLS',
  'REMOTE_CALLS',
  'CALLS_API',
  'MAPS_TO',
  'PUBLISHES_TO',
  'READS_FROM',
  'ROUTES_TO',
  'SUBSCRIBES_TO',
  'WRITES_TO',
]);
export const DEFAULT_OVERVIEW_NODE_LIMIT = 2_500;

const OVERVIEW_KIND_PRIORITY: Record<string, number> = {
  workspace: 1_000,
  database: 980,
  table: 970,
  topic: 960,
  cache: 950,
  external_api: 940,
  project: 900,
  module: 800,
  directory: 700,
  file: 500,
  class: 400,
  interface: 400,
  function: 300,
  method: 300,
};

function projection(
  snapshot: GraphSnapshot,
  nodes: GraphNode[],
  edges: GraphEdge[],
  totals = { nodes: nodes.length, edges: edges.length },
  truncationReason?: string,
  projectIds?: string[],
  overview = false,
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
      overview,
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

  view(view: GraphView, projectIds?: string[], options: ViewOptions = {}): GraphProjection {
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
      return this.limitView(scopedNodes, scopedEdges, projectIds, options, selectedProjects
        ? { nodes: scopedNodes.length, edges: scopedEdges.length }
        : { nodes: this.snapshot.counts.totalNodes, edges: this.snapshot.counts.totalEdges });
    }
    if (view === 'data') {
      return this.dataView(scopedNodes, scopedEdges, projectIds, options);
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
      return this.limitView(
        candidateNodes.filter((node) => connected.has(node.id)),
        candidateEdges,
        projectIds,
        options,
      );
    }
    return this.limitView(candidateNodes, candidateEdges, projectIds, options);
  }

  private dataView(
    scopedNodes: GraphNode[],
    scopedEdges: GraphEdge[],
    projectIds: string[] | undefined,
    options: ViewOptions,
  ): GraphProjection {
    const allowedEdges = scopedEdges.filter((edge) => DATA_FLOW_RELATIONS.has(edge.kind));
    const incoming = new Map<string, GraphEdge[]>();
    for (const edge of allowedEdges) {
      const values = incoming.get(edge.target) ?? [];
      values.push(edge);
      incoming.set(edge.target, values);
    }

    const resources = scopedNodes.filter((node) => DATA_RESOURCE_KINDS.has(node.kind));
    const reachable = new Set(resources.map((node) => node.id));
    const queue = [...reachable];
    let cursor = 0;
    while (cursor < queue.length) {
      const target = queue[cursor];
      cursor += 1;
      for (const edge of incoming.get(target) ?? []) {
        if (reachable.has(edge.source)) continue;
        reachable.add(edge.source);
        queue.push(edge.source);
      }
    }

    const nodes = scopedNodes.filter((node) => reachable.has(node.id));
    const edges = allowedEdges.filter(
      (edge) => reachable.has(edge.source) && reachable.has(edge.target),
    );
    return this.limitView(nodes, edges, projectIds, options);
  }

  private limitView(
    nodes: GraphNode[],
    edges: GraphEdge[],
    projectIds: string[] | undefined,
    options: ViewOptions,
    totals = { nodes: nodes.length, edges: edges.length },
  ): GraphProjection {
    const maxNodes = Math.max(100, Math.min(options.maxNodes ?? DEFAULT_OVERVIEW_NODE_LIMIT, 10_000));
    if (options.complete || nodes.length <= maxNodes) {
      return projection(
        this.snapshot,
        nodes,
        edges,
        totals,
        this.snapshot.truncated ? this.snapshot.truncationReason : undefined,
        projectIds,
      );
    }

    const selected = this.selectOverviewNodes(nodes, edges, maxNodes);
    const selectedIds = new Set(selected.map((node) => node.id));
    const matchingEdges = edges.filter(
      (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
    );
    const maxEdges = maxNodes * 8;
    const selectedEdges = matchingEdges.length <= maxEdges
      ? matchingEdges
      : [...matchingEdges]
          .sort((left, right) => this.overviewEdgeScore(right) - this.overviewEdgeScore(left)
            || left.id.localeCompare(right.id))
          .slice(0, maxEdges);
    const overviewReason = `当前为全空间代表性总览（${selected.length.toLocaleString()} / ${totals.nodes.toLocaleString()} 个匹配节点），点击“渲染全部”可加载完整图谱。`;
    const reason = [overviewReason, this.snapshot.truncated ? this.snapshot.truncationReason : undefined]
      .filter(Boolean)
      .join(' ');
    return projection(this.snapshot, selected, selectedEdges, totals, reason, projectIds, true);
  }

  private selectOverviewNodes(nodes: GraphNode[], edges: GraphEdge[], maxNodes: number): GraphNode[] {
    const candidateIds = new Set(nodes.map((node) => node.id));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const selected = new Map<string, GraphNode>();
    const roots = nodes.filter(
      (node) => node.kind === 'workspace' || node.kind === 'project' || DATA_RESOURCE_KINDS.has(node.kind),
    );
    for (const node of roots.slice(0, maxNodes)) selected.set(node.id, node);

    const containsBySource = new Map<string, string[]>();
    for (const edge of edges) {
      if (edge.kind !== 'CONTAINS' || !candidateIds.has(edge.source) || !candidateIds.has(edge.target)) continue;
      const children = containsBySource.get(edge.source) ?? [];
      children.push(edge.target);
      containsBySource.set(edge.source, children);
    }

    const projectRoots = roots.filter((node) => node.kind === 'project');
    const hierarchyBuckets = (projectRoots.length ? projectRoots : roots).map((root) => {
      const queue = [root.id];
      const visited = new Set(queue);
      const ordered: GraphNode[] = [];
      let cursor = 0;
      while (cursor < queue.length) {
        const parent = queue[cursor];
        cursor += 1;
        for (const child of containsBySource.get(parent) ?? []) {
          if (visited.has(child)) continue;
          visited.add(child);
          queue.push(child);
          const node = nodeById.get(child);
          if (node) ordered.push(node);
        }
      }
      return ordered;
    });
    const hierarchyTarget = Math.max(selected.size, Math.floor(maxNodes * 0.6));
    this.takeRoundRobin(hierarchyBuckets, selected, hierarchyTarget);

    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const buckets = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      if (selected.has(node.id)) continue;
      const key = node.projectId ?? '__workspace__';
      const bucket = buckets.get(key) ?? [];
      bucket.push(node);
      buckets.set(key, bucket);
    }
    const rankedBuckets = [...buckets.values()].map((bucket) => bucket.sort((left, right) => {
      const leftScore = (degree.get(left.id) ?? 0) * 1_000 + (OVERVIEW_KIND_PRIORITY[left.kind] ?? 0);
      const rightScore = (degree.get(right.id) ?? 0) * 1_000 + (OVERVIEW_KIND_PRIORITY[right.kind] ?? 0);
      return rightScore - leftScore || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
    }));
    this.takeRoundRobin(rankedBuckets, selected, maxNodes);
    return [...selected.values()];
  }

  private takeRoundRobin(
    buckets: GraphNode[][],
    selected: Map<string, GraphNode>,
    targetSize: number,
  ): void {
    const offsets = buckets.map(() => 0);
    let progressed = true;
    while (selected.size < targetSize && progressed) {
      progressed = false;
      for (let index = 0; index < buckets.length && selected.size < targetSize; index += 1) {
        const bucket = buckets[index];
        while (offsets[index] < bucket.length && selected.has(bucket[offsets[index]].id)) offsets[index] += 1;
        const node = bucket[offsets[index]];
        if (!node) continue;
        offsets[index] += 1;
        selected.set(node.id, node);
        progressed = true;
      }
    }
  }

  private overviewEdgeScore(edge: GraphEdge): number {
    if (edge.kind === 'CONTAINS') return 300;
    if (DATA_FLOW_RELATIONS.has(edge.kind)) return 250;
    if (CALL_RELATIONS.has(edge.kind)) return 200;
    if (STRUCTURE_RELATIONS.has(edge.kind)) return 100;
    return 0;
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
