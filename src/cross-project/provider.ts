import type { GraphDiagnostic, GraphEdge, GraphNode, Workspace } from '../core/types.js';

export interface CrossProjectOverlay {
  edges: GraphEdge[];
  diagnostics: GraphDiagnostic[];
}

export interface CrossProjectContext {
  workspace: Workspace;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CrossProjectProvider {
  readonly id: string;
  supports(context: CrossProjectContext): boolean | Promise<boolean>;
  extract(context: CrossProjectContext): CrossProjectOverlay | Promise<CrossProjectOverlay>;
}
