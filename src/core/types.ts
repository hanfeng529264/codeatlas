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
  schemaVersion: 2;
  id: string;
  name: string;
  root: '.';
  initializedAt: string;
  projects: WorkspaceProject[];
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

export interface GraphDiagnostic {
  providerId?: string;
  projectId?: string;
  severity: 'warning' | 'error';
  code: string;
  message: string;
  filePath?: string;
}

export interface GraphSnapshot {
  version: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: GraphDiagnostic[];
  counts: {
    totalNodes: number;
    totalEdges: number;
    returnedNodes: number;
    returnedEdges: number;
  };
  projects: Array<{
    id: string;
    name: string;
    path: string;
    indexed: boolean;
    compatible: boolean;
    available: boolean;
    version?: string;
    message?: string;
    totalNodes: number;
    totalEdges: number;
  }>;
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
