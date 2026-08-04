export type EvidenceClass =
  | 'verified'
  | 'static-derived'
  | 'heuristic'
  | 'ai-inferred'
  | 'user-defined';

export interface AtlasNode {
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
  incoming?: number;
  outgoing?: number;
}

export interface AtlasEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  sourceName: string;
  evidenceClass: EvidenceClass;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface GraphProjection {
  version: string;
  generatedAt: string;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  projection: {
    totalMatchedNodes: number;
    totalMatchedEdges: number;
    returnedNodes: number;
    returnedEdges: number;
    truncated: boolean;
    truncationReason?: string;
  };
  path?: string[];
}

export interface WorkspaceStatus {
  workspace: {
    id: string;
    name: string;
    rootPath: string;
    projects: Array<{ id: string; name: string; path: string }>;
  };
  codegraph: {
    available: boolean;
    initialized: boolean;
    compatible: boolean;
    version?: string;
    message?: string;
  };
  graph: {
    version: string;
    totalNodes: number;
    totalEdges: number;
    returnedNodes: number;
    returnedEdges: number;
    truncated: boolean;
    truncationReason?: string;
  };
}

export type ViewId = 'full' | 'directory' | 'structure' | 'methods' | 'calls';
