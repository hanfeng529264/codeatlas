import type { GraphDiagnostic, GraphEdge, GraphNode, WorkspaceProject } from '../core/types.js';

export type DataFlowDiagnosticSeverity = 'warning' | 'error';

export interface DataFlowDiagnostic extends GraphDiagnostic {
  providerId: string;
}

export interface DataFlowOverlay {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: DataFlowDiagnostic[];
}

export interface DataFlowProjectContext {
  workspaceRoot: string;
  projectRoot: string;
  project: WorkspaceProject;
}

export interface DataFlowProvider {
  readonly id: string;
  supports(context: DataFlowProjectContext): boolean | Promise<boolean>;
  extract(context: DataFlowProjectContext): DataFlowOverlay | Promise<DataFlowOverlay>;
}

export function emptyDataFlowOverlay(): DataFlowOverlay {
  return { nodes: [], edges: [], diagnostics: [] };
}
