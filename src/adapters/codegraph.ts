import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type {
  CodeGraphStatus,
  EvidenceClass,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Workspace,
} from '../core/types.js';

const execFileAsync = promisify(execFile);
const REQUIRED_TABLES = ['edges', 'files', 'nodes'] as const;

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
  projectId: string,
  nodeMap: Map<string, GraphNode>,
  edges: GraphEdge[],
): string {
  const directoryPath = posix.dirname(filePath);
  if (directoryPath === '.') return projectId;
  let parentId = projectId;
  let currentPath = '';
  for (const segment of directoryPath.split('/')) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const directoryId = `directory:${currentPath}`;
    if (!nodeMap.has(directoryId)) {
      nodeMap.set(
        directoryId,
        graphNode({
          id: directoryId,
          kind: 'directory',
          label: segment,
          filePath: currentPath,
          projectId: 'root',
        }),
      );
      edges.push(containsEdge(parentId, directoryId));
    }
    parentId = directoryId;
  }
  return parentId;
}

export async function loadCodeGraphSnapshot(
  workspace: Workspace,
  options: LoadOptions = {},
): Promise<GraphSnapshot> {
  const status = await inspectCodeGraph(workspace.rootPath);
  if (!status.initialized) {
    throw new Error('CodeGraph index not found. Run "codegraph init" in the workspace first.');
  }
  if (!status.compatible) {
    throw new Error(status.message ?? 'CodeGraph database is incompatible.');
  }

  const db = new DatabaseSync(status.databasePath, { readOnly: true });
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
    const workspaceId = `workspace:${workspace.config.id}`;
    const projectId = 'project:root';
    nodeMap.set(
      workspaceId,
      graphNode({ id: workspaceId, kind: 'workspace', label: workspace.config.name }),
    );
    nodeMap.set(
      projectId,
      graphNode({
        id: projectId,
        kind: 'project',
        label: workspace.config.projects[0]?.name ?? workspace.config.name,
        projectId: 'root',
      }),
    );
    allEdges.push(containsEdge(workspaceId, projectId));

    for (const file of fileRows) {
      const filePath = normalizePath(file.path);
      const parentId = addDirectoryChain(filePath, projectId, nodeMap, allEdges);
      const fileId = `file:${filePath}`;
      nodeMap.set(
        fileId,
        graphNode({
          id: fileId,
          kind: 'file',
          label: posix.basename(filePath),
          filePath,
          projectId: 'root',
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
        rawNodeIds.set(node.id, `file:${filePath}`);
        continue;
      }
      const id = `symbol:${node.id}`;
      rawNodeIds.set(node.id, id);
      nodeMap.set(
        id,
        graphNode({
          id,
          kind: node.kind,
          label: node.name,
          qualifiedName: node.qualified_name,
          filePath,
          projectId: 'root',
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
      allEdges.push(containsEdge(`file:${filePath}`, id));
    }

    for (const edge of edgeRows) {
      const source = rawNodeIds.get(edge.source) ?? `symbol:${edge.source}`;
      const target = rawNodeIds.get(edge.target) ?? `symbol:${edge.target}`;
      if (!nodeMap.has(source) || !nodeMap.has(target)) continue;
      allEdges.push({
        id: `codegraph-edge:${edge.id}`,
        source,
        target,
        kind: relationKind(edge.kind),
        sourceName: 'codegraph',
        evidenceClass: evidenceFor(edge.provenance),
        confidence: evidenceFor(edge.provenance) === 'heuristic' ? 0.72 : 0.96,
        metadata: {
          ...safeMetadata(edge.metadata),
          line: edge.line,
          column: edge.col,
          provenance: edge.provenance,
        },
      });
    }

    const uniqueEdges = new Map<string, GraphEdge>();
    for (const edge of allEdges) {
      uniqueEdges.set(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`, edge);
    }
    const normalizedEdges = [...uniqueEdges.values()];
    const allNodes = [...nodeMap.values()];
    const maxNodes = Math.max(1, options.maxNodes ?? 250_000);
    const maxEdges = Math.max(0, options.maxEdges ?? 1_000_000);
    const nodes = allNodes.slice(0, maxNodes);
    const returnedIds = new Set(nodes.map((node) => node.id));
    const eligibleEdges = normalizedEdges.filter(
      (edge) => returnedIds.has(edge.source) && returnedIds.has(edge.target),
    );
    const edges = eligibleEdges.slice(0, maxEdges);
    const truncated = nodes.length < allNodes.length || edges.length < eligibleEdges.length;
    const latestIndex = Math.max(0, ...fileRows.map((file) => file.indexed_at));

    return {
      version: `${workspace.config.id}:${fileRows.length}:${nodeRows.length}:${edgeRows.length}:${latestIndex}`,
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      counts: {
        totalNodes: allNodes.length,
        totalEdges: normalizedEdges.length,
        returnedNodes: nodes.length,
        returnedEdges: edges.length,
      },
      truncated,
      truncationReason: truncated
        ? nodes.length < allNodes.length
          ? `Result exceeded the ${maxNodes.toLocaleString()} node budget.`
          : `Result exceeded the ${maxEdges.toLocaleString()} edge budget.`
        : undefined,
    };
  } finally {
    db.close();
  }
}
