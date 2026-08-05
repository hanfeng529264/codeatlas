import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type {
  CodeGraphStatus,
  EvidenceClass,
  GraphDiagnostic,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Workspace,
  WorkspaceProject,
} from '../core/types.js';
import { resolveProjectRoot } from '../core/workspace.js';
import { mergeDataFlowOverlay } from '../data-flow/merge.js';
import type { DataFlowOverlay } from '../data-flow/provider.js';
import { javaMyBatisProvider } from '../data-flow/providers/java-mybatis.js';
import { DataFlowProviderRegistry } from '../data-flow/registry.js';

const execFileAsync = promisify(execFile);
const REQUIRED_TABLES = ['edges', 'files', 'nodes'] as const;
const DATA_FLOW_PROVIDERS = new DataFlowProviderRegistry([javaMyBatisProvider]);

interface LoadOptions {
  maxNodes?: number;
  maxEdges?: number;
}

interface FileRow {
  path: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance?: string | null;
}

interface ProjectGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: GraphDiagnostic[];
  version: string;
  totalNodes: number;
  totalEdges: number;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

async function cliVersion(): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync('codegraph', ['--version'], {
      timeout: 2_000,
    });
    return { available: true, version: stdout.trim() || undefined };
  } catch {
    return { available: false };
  }
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function databaseCompatible(db: DatabaseSync): boolean {
  const tables = tableNames(db);
  return REQUIRED_TABLES.every((table) => tables.has(table));
}

export async function inspectCodeGraph(rootPath: string): Promise<CodeGraphStatus> {
  const indexPath = join(rootPath, '.codegraph');
  const databasePath = join(indexPath, 'codegraph.db');
  const cli = await cliVersion();
  const dbInfo = await stat(databasePath).catch(() => null);
  if (!dbInfo?.isFile()) {
    return {
      available: cli.available,
      initialized: false,
      compatible: true,
      version: cli.version,
      indexPath,
      databasePath,
      message: cli.available
        ? 'CodeGraph is available but this workspace is not indexed.'
        : 'CodeGraph is not installed and this workspace is not indexed.',
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const compatible = databaseCompatible(db);
    return {
      available: cli.available,
      initialized: true,
      compatible,
      version: cli.version,
      indexPath,
      databasePath,
      message: compatible
        ? undefined
        : 'CodeGraph database is missing required tables: nodes, edges, files.',
    };
  } catch (error) {
    return {
      available: cli.available,
      initialized: true,
      compatible: false,
      version: cli.version,
      indexPath,
      databasePath,
      message: `CodeGraph database could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    db?.close();
  }
}

function graphNode(
  input: Omit<GraphNode, 'source' | 'evidenceClass' | 'confidence' | 'metadata'> &
    Partial<Pick<GraphNode, 'source' | 'evidenceClass' | 'confidence' | 'metadata'>>,
): GraphNode {
  return {
    source: 'codeatlas',
    evidenceClass: 'verified',
    confidence: 1,
    metadata: {},
    ...input,
  };
}

function containsEdge(source: string, target: string): GraphEdge {
  return {
    id: `contains:${source}:${target}`,
    source,
    target,
    kind: 'CONTAINS',
    sourceName: 'codeatlas',
    evidenceClass: 'verified',
    confidence: 1,
    metadata: {},
  };
}

function safeMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

function evidenceFor(provenance: string | null | undefined): EvidenceClass {
  return provenance?.toLowerCase().includes('heuristic')
    ? 'heuristic'
    : 'static-derived';
}

function relationKind(kind: string): string {
  const normalized = kind.trim().replaceAll('-', '_').toUpperCase();
  const aliases: Record<string, string> = {
    CALL: 'CALLS',
    IMPORT: 'IMPORTS',
    EXTEND: 'EXTENDS',
    IMPLEMENT: 'IMPLEMENTS',
    REFERENCE: 'REFERENCES',
  };
  return aliases[normalized] ?? normalized;
}

function addDirectoryChain(
  filePath: string,
  project: WorkspaceProject,
  nodeMap: Map<string, GraphNode>,
  edges: GraphEdge[],
): string {
  const directoryPath = posix.dirname(filePath);
  const projectNodeId = `project:${project.id}`;
  if (directoryPath === '.') return projectNodeId;
  let parentId = projectNodeId;
  let currentPath = '';
  for (const segment of directoryPath.split('/')) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const directoryId = `directory:${project.id}:${currentPath}`;
    if (!nodeMap.has(directoryId)) {
      nodeMap.set(
        directoryId,
        graphNode({
          id: directoryId,
          kind: 'directory',
          label: segment,
          filePath: currentPath,
          projectId: project.id,
        }),
      );
      edges.push(containsEdge(parentId, directoryId));
    }
    parentId = directoryId;
  }
  return parentId;
}

async function loadProjectGraph(
  projectRoot: string,
  project: WorkspaceProject,
  databasePath: string,
): Promise<ProjectGraphData> {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const fileRows = db.prepare(`
      SELECT path, language, size, modified_at, indexed_at, node_count, errors
      FROM files ORDER BY path
    `).all() as unknown as FileRow[];
    const nodeRows = db.prepare(`
      SELECT id, kind, name, qualified_name, file_path, language,
             start_line, end_line, docstring, signature, visibility,
             is_exported, is_async, is_static, is_abstract
      FROM nodes ORDER BY file_path, start_line, id
    `).all() as unknown as NodeRow[];
    const edgeColumns = new Set(
      (db.prepare('PRAGMA table_info(edges)').all() as unknown as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const provenanceExpression = edgeColumns.has('provenance')
      ? 'provenance'
      : 'NULL AS provenance';
    const edgeRows = db.prepare(`
      SELECT id, source, target, kind, metadata, line, col, ${provenanceExpression}
      FROM edges ORDER BY id
    `).all() as unknown as EdgeRow[];

    const nodeMap = new Map<string, GraphNode>();
    const allEdges: GraphEdge[] = [];
    for (const file of fileRows) {
      const filePath = normalizePath(file.path);
      const parentId = addDirectoryChain(filePath, project, nodeMap, allEdges);
      const fileId = `file:${project.id}:${filePath}`;
      nodeMap.set(
        fileId,
        graphNode({
          id: fileId,
          kind: 'file',
          label: posix.basename(filePath),
          filePath,
          projectId: project.id,
          language: file.language,
          source: 'codegraph',
          evidenceClass: 'static-derived',
          confidence: 1,
          metadata: {
            size: file.size,
            modifiedAt: file.modified_at,
            indexedAt: file.indexed_at,
            nodeCount: file.node_count,
            errors: safeMetadata(file.errors),
          },
        }),
      );
      allEdges.push(containsEdge(parentId, fileId));
    }

    const rawNodeIds = new Map<string, string>();
    for (const node of nodeRows) {
      const filePath = normalizePath(node.file_path);
      if (node.kind === 'file') {
        rawNodeIds.set(node.id, `file:${project.id}:${filePath}`);
        continue;
      }
      const id = `symbol:${project.id}:${node.id}`;
      rawNodeIds.set(node.id, id);
      nodeMap.set(
        id,
        graphNode({
          id,
          kind: node.kind,
          label: node.name,
          qualifiedName: node.qualified_name,
          filePath,
          projectId: project.id,
          language: node.language,
          startLine: node.start_line,
          endLine: node.end_line,
          source: 'codegraph',
          evidenceClass: 'static-derived',
          confidence: 1,
          metadata: {
            signature: node.signature,
            docstring: node.docstring,
            visibility: node.visibility,
            exported: Boolean(node.is_exported),
            async: Boolean(node.is_async),
            static: Boolean(node.is_static),
            abstract: Boolean(node.is_abstract),
          },
        }),
      );
      allEdges.push(containsEdge(`file:${project.id}:${filePath}`, id));
    }

    for (const edge of edgeRows) {
      const source = rawNodeIds.get(edge.source) ?? `symbol:${project.id}:${edge.source}`;
      const target = rawNodeIds.get(edge.target) ?? `symbol:${project.id}:${edge.target}`;
      if (!nodeMap.has(source) || !nodeMap.has(target)) continue;
      const sourceNode = nodeMap.get(source);
      const targetNode = nodeMap.get(target);
      const normalizedKind = relationKind(edge.kind);
      const kind = normalizedKind === 'REFERENCES'
        && sourceNode?.kind === 'route'
        && (targetNode?.kind === 'method' || targetNode?.kind === 'function')
        ? 'ROUTES_TO'
        : normalizedKind;
      allEdges.push({
        id: `codegraph-edge:${project.id}:${edge.id}`,
        source,
        target,
        kind,
        sourceName: 'codegraph',
        evidenceClass: evidenceFor(edge.provenance),
        confidence: evidenceFor(edge.provenance) === 'heuristic' ? 0.72 : 0.96,
        metadata: {
          ...safeMetadata(edge.metadata),
          line: edge.line,
          column: edge.col,
          provenance: edge.provenance,
          projectRoot,
        },
      });
    }

    const uniqueEdges = new Map<string, GraphEdge>();
    for (const edge of allEdges) {
      uniqueEdges.set(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`, edge);
    }
    const normalizedEdges = [...uniqueEdges.values()];
    const allNodes = [...nodeMap.values()];
    const latestIndex = Math.max(0, ...fileRows.map((file) => file.indexed_at));
    return {
      nodes: allNodes,
      edges: normalizedEdges,
      diagnostics: [],
      version: `${project.id}:${fileRows.length}:${nodeRows.length}:${edgeRows.length}:${latestIndex}`,
      totalNodes: allNodes.length,
      totalEdges: normalizedEdges.length,
    };
  } finally {
    db.close();
  }
}

function overlayVersion(overlay: DataFlowOverlay): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      nodes: overlay.nodes.map((node) => [node.id, node.evidenceClass, node.confidence, node.metadata]),
      edges: overlay.edges.map((edge) => [
        edge.source,
        edge.target,
        edge.kind,
        edge.evidenceClass,
        edge.confidence,
        edge.metadata,
      ]),
      diagnostics: overlay.diagnostics,
    }))
    .digest('hex')
    .slice(0, 12);
  return `${overlay.nodes.length}:${overlay.edges.length}:${digest}`;
}

async function enrichProjectDataFlow(
  workspace: Workspace,
  projectRoot: string,
  project: WorkspaceProject,
  data: ProjectGraphData,
): Promise<ProjectGraphData> {
  const overlay = await DATA_FLOW_PROVIDERS.extract({
    workspaceRoot: workspace.rootPath,
    projectRoot,
    project,
  });
  const merged = mergeDataFlowOverlay(data.nodes, data.edges, overlay);
  return {
    ...data,
    ...merged,
    diagnostics: overlay.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      projectId: project.id,
    })),
    version: `${data.version}:dataflow:${overlayVersion(overlay)}`,
    totalNodes: merged.nodes.length,
    totalEdges: merged.edges.length,
  };
}

interface PackageManifestProject {
  project: WorkspaceProject;
  packageName?: string;
  dependencies: Record<string, string>;
}

async function readPackageManifest(
  workspace: Workspace,
  project: WorkspaceProject,
): Promise<PackageManifestProject> {
  const dependencies: Record<string, string> = {};
  try {
    const raw = await readFile(join(resolveProjectRoot(workspace, project), 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const section = manifest[key];
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
      for (const [name, value] of Object.entries(section)) {
        if (typeof value === 'string') dependencies[name] = value;
      }
    }
    return {
      project,
      packageName: typeof manifest.name === 'string' ? manifest.name : undefined,
      dependencies,
    };
  } catch {
    return { project, dependencies };
  }
}

async function packageDependencyEdges(workspace: Workspace): Promise<GraphEdge[]> {
  const manifests = await Promise.all(
    workspace.config.projects.map((project) => readPackageManifest(workspace, project)),
  );
  const projectsByPackage = new Map(
    manifests
      .filter((entry): entry is PackageManifestProject & { packageName: string } => Boolean(entry.packageName))
      .map((entry) => [entry.packageName, entry.project]),
  );
  const edges: GraphEdge[] = [];
  for (const manifest of manifests) {
    for (const [dependency, specifier] of Object.entries(manifest.dependencies)) {
      const target = projectsByPackage.get(dependency);
      if (!target || target.id === manifest.project.id) continue;
      edges.push({
        id: `package-dependency:${manifest.project.id}:${target.id}:${dependency}`,
        source: `project:${manifest.project.id}`,
        target: `project:${target.id}`,
        kind: 'DEPENDS_ON',
        sourceName: 'package.json',
        evidenceClass: 'static-derived',
        confidence: 1,
        metadata: { dependency, specifier, manifest: `${manifest.project.path}/package.json` },
      });
    }
  }
  return edges;
}

export async function loadCodeGraphSnapshot(
  workspace: Workspace,
  options: LoadOptions = {},
): Promise<GraphSnapshot> {
  if (workspace.config.projects.length === 0) {
    throw new Error('No projects are registered. Run "codeatlas project add" first.');
  }

  const workspaceId = `workspace:${workspace.config.id}`;
  const baseNodes: GraphNode[] = [
    graphNode({ id: workspaceId, kind: 'workspace', label: workspace.config.name }),
  ];
  const allEdges: GraphEdge[] = [];
  const projectResults: Array<{
    project: WorkspaceProject;
    status: CodeGraphStatus;
    data?: ProjectGraphData;
  }> = [];

  for (const project of workspace.config.projects) {
    const projectRoot = resolveProjectRoot(workspace, project);
    let status = await inspectCodeGraph(projectRoot);
    let data: ProjectGraphData | undefined;
    if (status.initialized && status.compatible) {
      try {
        const codeGraphData = await loadProjectGraph(projectRoot, project, status.databasePath);
        data = await enrichProjectDataFlow(workspace, projectRoot, project, codeGraphData);
      } catch (error) {
        status = {
          ...status,
          compatible: false,
          message: `CodeGraph project index could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const projectNodeId = `project:${project.id}`;
    baseNodes.push(
      graphNode({
        id: projectNodeId,
        kind: 'project',
        label: project.name,
        projectId: project.id,
        metadata: {
          path: project.path,
          indexed: status.initialized,
          compatible: status.compatible,
          message: status.message,
          diagnosticCount: data?.diagnostics.length ?? 0,
        },
      }),
    );
    allEdges.push(containsEdge(workspaceId, projectNodeId));
    if (data) {
      for (const node of data.nodes) baseNodes.push(node);
      for (const edge of data.edges) allEdges.push(edge);
    }
    projectResults.push({ project, status, data });
  }

  if (!projectResults.some((result) => result.data)) {
    throw new Error('No compatible CodeGraph project index is available. Initialize at least one project first.');
  }

  for (const edge of await packageDependencyEdges(workspace)) allEdges.push(edge);
  const uniqueEdges = new Map<string, GraphEdge>();
  for (const edge of allEdges) {
    uniqueEdges.set(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`, edge);
  }
  const normalizedEdges = [...uniqueEdges.values()];
  const maxNodes = Math.max(1, options.maxNodes ?? 250_000);
  const maxEdges = Math.max(0, options.maxEdges ?? 1_000_000);
  const nodes = baseNodes.slice(0, maxNodes);
  const returnedIds = new Set(nodes.map((node) => node.id));
  const eligibleEdges = normalizedEdges.filter(
    (edge) => returnedIds.has(edge.source) && returnedIds.has(edge.target),
  );
  const edges = eligibleEdges.slice(0, maxEdges);
  const unavailableProjects = projectResults.filter((result) => !result.data);
  const budgetReason = nodes.length < baseNodes.length
    ? `Result exceeded the ${maxNodes.toLocaleString()} node budget.`
    : edges.length < eligibleEdges.length
      ? `Result exceeded the ${maxEdges.toLocaleString()} edge budget.`
      : undefined;
  const unavailableReason = unavailableProjects.length > 0
    ? `Unavailable project indexes: ${unavailableProjects.map(({ project }) => project.name).join(', ')}.`
    : undefined;
  const truncationReason = [unavailableReason, budgetReason].filter(Boolean).join(' ');

  return {
    version: `${workspace.config.id}:${projectResults.map(({ data, project }) => data?.version ?? `${project.id}:missing`).join('|')}`,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    diagnostics: projectResults.flatMap(({ data }) => data?.diagnostics ?? []),
    counts: {
      totalNodes: baseNodes.length,
      totalEdges: normalizedEdges.length,
      returnedNodes: nodes.length,
      returnedEdges: edges.length,
    },
    projects: projectResults.map(({ project, status, data }) => ({
      ...project,
      indexed: status.initialized,
      compatible: status.compatible,
      available: status.available,
      version: status.version,
      message: status.message,
      totalNodes: data?.totalNodes ?? 0,
      totalEdges: data?.totalEdges ?? 0,
    })),
    truncated: Boolean(truncationReason),
    truncationReason: truncationReason || undefined,
  };
}
