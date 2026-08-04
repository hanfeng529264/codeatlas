export type EvidenceClass =
  | 'verified'
  | 'static-derived'
  | 'heuristic'
  | 'ai-inferred'
  | 'user-defined';

export interface WorkspaceProject {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceConfig {
  schemaVersion: 1;
  id: string;
  name: string;
  root: '.';
  initializedAt: string;
  projects: WorkspaceProject[];
  codegraph: {
    path: '.';
  };
}

export interface Workspace {
  rootPath: string;
  configPath: string;
  config: WorkspaceConfig;
  created: boolean;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  qualifiedName?: string;
  projectId?: string;
  filePath?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  source: string;
  evidenceClass: EvidenceClass;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  sourceName: string;
  evidenceClass: EvidenceClass;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface GraphSnapshot {
  version: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: {
    totalNodes: number;
    totalEdges: number;
    returnedNodes: number;
    returnedEdges: number;
  };
  truncated: boolean;
  truncationReason?: string;
}

export interface CodeGraphStatus {
  available: boolean;
  initialized: boolean;
  compatible: boolean;
  version?: string;
  indexPath: string;
  databasePath: string;
  lastIndexed?: string | null;
  message?: string;
}
