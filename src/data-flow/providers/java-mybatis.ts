import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import type { EvidenceClass, GraphEdge, GraphNode } from '../../core/types.js';
import type {
  DataFlowDiagnostic,
  DataFlowOverlay,
  DataFlowProjectContext,
  DataFlowProvider,
} from '../provider.js';
import { extractSqlTableFacts, type SqlOperation } from '../sql.js';

const PROVIDER_ID = 'java-mybatis';
const MAX_FILES = 50_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  '.codeatlas',
  '.codegraph',
  '.git',
  '.gradle',
  '.idea',
  'build',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

interface JavaEntity {
  simpleName: string;
  qualifiedName: string;
  filePath: string;
  tableName: string;
  evidenceClass: EvidenceClass;
  confidence: number;
}

interface JavaMapper {
  simpleName: string;
  qualifiedName: string;
  filePath: string;
  entityType: string;
  importedEntity?: string;
}

function portablePath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\n') line += 1;
  }
  return line;
}

function maskWithoutRemovingLines(value: string): string {
  return value.replace(/[^\n]/g, ' ');
}

function sqlTextFromXml(value: string): string {
  return value
    .replace(/<!--([\s\S]*?)-->/g, (match) => maskWithoutRemovingLines(match))
    .replace(/<!\[CDATA\[/g, (match) => ' '.repeat(match.length))
    .replace(/\]\]>/g, (match) => ' '.repeat(match.length))
    .replace(/<\/?[A-Za-z][^>]*>/g, (match) => maskWithoutRemovingLines(match))
    .replace(/<\?[^>]*\?>/g, (match) => maskWithoutRemovingLines(match))
    .replace(/<!DOCTYPE[^>]*>/gi, (match) => maskWithoutRemovingLines(match));
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attributes);
  return match?.[2].trim() || undefined;
}

function normalizeTableName(value: string): string {
  return value
    .trim()
    .split(/\s*\.\s*/)
    .map((part) => part.replace(/^([`"\[])|([`"\]])$/g, ''))
    .join('.')
    .toLocaleLowerCase();
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLocaleLowerCase();
}

function nodeIdPart(value: string): string {
  return value.replaceAll(':', '%3A');
}

function sqlNodeId(projectId: string, namespace: string, statementId: string): string {
  return `dataflow:${PROVIDER_ID}:${projectId}:sql:${nodeIdPart(namespace)}#${nodeIdPart(statementId)}`;
}

function mapperNodeId(projectId: string, qualifiedName: string): string {
  return `dataflow:${PROVIDER_ID}:${projectId}:mapper:${nodeIdPart(qualifiedName)}`;
}

function tableNodeId(projectId: string, tableName: string): string {
  return `table:${projectId}:${nodeIdPart(tableName)}`;
}

function graphNode(input: Omit<GraphNode, 'source' | 'metadata'> & { metadata?: Record<string, unknown> }): GraphNode {
  const { metadata = {}, ...node } = input;
  return {
    ...node,
    source: PROVIDER_ID,
    metadata: { providerId: PROVIDER_ID, ...metadata },
  };
}

function graphEdge(input: Omit<GraphEdge, 'sourceName' | 'metadata'> & { metadata?: Record<string, unknown> }): GraphEdge {
  const { metadata = {}, ...edge } = input;
  return {
    ...edge,
    sourceName: PROVIDER_ID,
    metadata: { providerId: PROVIDER_ID, ...metadata },
  };
}

async function candidateFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [resolve(projectRoot)];

  while (pending.length > 0 && files.length < MAX_FILES) {
    const directory = pending.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && ['.java', '.xml'].includes(extname(entry.name).toLocaleLowerCase())) {
        files.push(path);
        if (files.length >= MAX_FILES) break;
      }
    }
  }

  return files.sort();
}

async function readableSource(filePath: string): Promise<string | undefined> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_FILE_SIZE) return undefined;
  return readFile(filePath, 'utf8');
}

function warning(code: string, message: string, filePath?: string): DataFlowDiagnostic {
  return { providerId: PROVIDER_ID, severity: 'warning', code, message, filePath };
}

function ensureTableNode(
  nodeMap: Map<string, GraphNode>,
  context: DataFlowProjectContext,
  tableName: string,
  evidenceClass: EvidenceClass,
  confidence: number,
  filePath: string,
  line?: number,
): string {
  const id = tableNodeId(context.project.id, tableName);
  if (!nodeMap.has(id)) {
    nodeMap.set(id, graphNode({
      id,
      kind: 'table',
      label: tableName,
      qualifiedName: tableName,
      projectId: context.project.id,
      filePath,
      startLine: line,
      evidenceClass,
      confidence,
      metadata: { tableName },
    }));
  }
  return id;
}

function extractXmlOverlay(
  content: string,
  filePath: string,
  context: DataFlowProjectContext,
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
  diagnostics: DataFlowDiagnostic[],
): void {
  if (!/<mapper\b/i.test(content)) return;
  const namespaceMatch = /<mapper\b([^>]*)>/i.exec(content);
  const namespace = namespaceMatch ? attribute(namespaceMatch[1], 'namespace') : undefined;
  if (!namespace) {
    diagnostics.push(warning(
      'mybatis-namespace-missing',
      'MyBatis mapper does not declare a namespace and was skipped.',
      filePath,
    ));
    return;
  }

  const statementPattern = /<(select|insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of content.matchAll(statementPattern)) {
    const operation = match[1].toLocaleLowerCase() as SqlOperation;
    const statementId = attribute(match[2], 'id');
    if (!statementId) {
      diagnostics.push(warning(
        'mybatis-statement-id-missing',
        `MyBatis ${operation} statement without an id was skipped.`,
        filePath,
      ));
      continue;
    }

    const matchOffset = match.index ?? 0;
    const bodyOffsetInMatch = match[0].indexOf(match[3]);
    const bodyOffset = matchOffset + Math.max(bodyOffsetInMatch, 0);
    const startLine = lineAt(content, matchOffset);
    const endLine = lineAt(content, matchOffset + match[0].length);
    const id = sqlNodeId(context.project.id, namespace, statementId);
    nodeMap.set(id, graphNode({
      id,
      kind: 'sql',
      label: statementId,
      qualifiedName: `${namespace}#${statementId}`,
      projectId: context.project.id,
      filePath,
      language: 'xml',
      startLine,
      endLine,
      evidenceClass: 'static-derived',
      confidence: 1,
      metadata: { namespace, statementId, operation },
    }));

    const sql = sqlTextFromXml(match[3]);
    for (const fact of extractSqlTableFacts(sql, lineAt(content, bodyOffset))) {
      const target = ensureTableNode(
        nodeMap,
        context,
        fact.tableName,
        'static-derived',
        1,
        filePath,
        fact.line,
      );
      const kind = fact.access === 'read' ? 'READS_FROM' : 'WRITES_TO';
      const edgeId = `${kind.toLocaleLowerCase()}:${id}:${target}`;
      edgeMap.set(edgeId, graphEdge({
        id: edgeId,
        source: id,
        target,
        kind,
        evidenceClass: 'static-derived',
        confidence: 1,
        metadata: {
          namespace,
          statementId,
          operation: fact.operation,
          tableName: fact.tableName,
          sourceFile: filePath,
          line: fact.line,
        },
      }));
    }
  }
}

function packageName(content: string): string | undefined {
  return /\bpackage\s+([\w.]+)\s*;/.exec(content)?.[1];
}

function qualifiedName(packageValue: string | undefined, simpleName: string): string {
  return packageValue ? `${packageValue}.${simpleName}` : simpleName;
}

function tableNameAnnotation(content: string): string | undefined {
  const annotation = /@TableName\s*\(([\s\S]*?)\)/.exec(content)?.[1];
  if (!annotation) return undefined;
  return /(?:\bvalue\s*=\s*)?["']([^"']+)["']/.exec(annotation)?.[1];
}

function parseEntity(content: string, filePath: string): JavaEntity | undefined {
  const classMatch = /\b(?:public\s+)?(?:abstract\s+)?(?:class|record)\s+(\w+)/.exec(content);
  if (!classMatch) return undefined;
  const simpleName = classMatch[1];
  const explicitTable = tableNameAnnotation(content);
  return {
    simpleName,
    qualifiedName: qualifiedName(packageName(content), simpleName),
    filePath,
    tableName: normalizeTableName(explicitTable ?? snakeCase(simpleName)),
    evidenceClass: explicitTable ? 'static-derived' : 'heuristic',
    confidence: explicitTable ? 1 : 0.65,
  };
}

function parseMapper(content: string, filePath: string): JavaMapper | undefined {
  const mapperMatch = /\binterface\s+(\w+)[^{]*\bextends\s+(?:[\w.]+\.)?BaseMapper\s*<\s*([\w.]+)\s*>/.exec(content);
  if (!mapperMatch) return undefined;
  const simpleName = mapperMatch[1];
  const entityType = mapperMatch[2];
  const entitySimpleName = entityType.split('.').at(-1) ?? entityType;
  const importMatch = new RegExp(`\\bimport\\s+([\\w.]+\\.${entitySimpleName})\\s*;`).exec(content);
  return {
    simpleName,
    qualifiedName: qualifiedName(packageName(content), simpleName),
    filePath,
    entityType,
    importedEntity: importMatch?.[1],
  };
}

function resolveEntity(
  mapper: JavaMapper,
  entitiesByQualifiedName: Map<string, JavaEntity>,
  entitiesBySimpleName: Map<string, JavaEntity[]>,
): JavaEntity | undefined {
  const exactName = mapper.entityType.includes('.') ? mapper.entityType : mapper.importedEntity;
  if (exactName && entitiesByQualifiedName.has(exactName)) return entitiesByQualifiedName.get(exactName);
  const simpleName = mapper.entityType.split('.').at(-1) ?? mapper.entityType;
  const matches = entitiesBySimpleName.get(simpleName) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function addMapperOverlay(
  mapper: JavaMapper,
  entity: JavaEntity | undefined,
  context: DataFlowProjectContext,
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
  diagnostics: DataFlowDiagnostic[],
): void {
  const entitySimpleName = mapper.entityType.split('.').at(-1) ?? mapper.entityType;
  const resolvedEntity: JavaEntity = entity ?? {
    simpleName: entitySimpleName,
    qualifiedName: mapper.importedEntity ?? mapper.entityType,
    filePath: mapper.filePath,
    tableName: snakeCase(entitySimpleName),
    evidenceClass: 'heuristic',
    confidence: 0.5,
  };
  if (!entity) {
    diagnostics.push(warning(
      'mybatis-plus-entity-source-missing',
      `BaseMapper entity "${mapper.entityType}" could not be resolved; its table name was inferred.`,
      mapper.filePath,
    ));
  }

  const source = mapperNodeId(context.project.id, mapper.qualifiedName);
  nodeMap.set(source, graphNode({
    id: source,
    kind: 'interface',
    label: mapper.simpleName,
    qualifiedName: mapper.qualifiedName,
    projectId: context.project.id,
    filePath: mapper.filePath,
    language: 'java',
    evidenceClass: 'static-derived',
    confidence: 1,
    metadata: { entityQualifiedName: resolvedEntity.qualifiedName },
  }));
  const target = ensureTableNode(
    nodeMap,
    context,
    resolvedEntity.tableName,
    resolvedEntity.evidenceClass,
    resolvedEntity.confidence,
    resolvedEntity.filePath,
  );
  const edgeId = `maps_to:${source}:${target}`;
  edgeMap.set(edgeId, graphEdge({
    id: edgeId,
    source,
    target,
    kind: 'MAPS_TO',
    evidenceClass: resolvedEntity.evidenceClass,
    confidence: resolvedEntity.confidence,
    metadata: {
      entityQualifiedName: resolvedEntity.qualifiedName,
      tableName: resolvedEntity.tableName,
      sourceFile: resolvedEntity.filePath,
    },
  }));
}

async function supports(context: DataFlowProjectContext): Promise<boolean> {
  for (const filePath of await candidateFiles(context.projectRoot)) {
    try {
      const content = await readableSource(filePath);
      if (!content) continue;
      if (extname(filePath).toLocaleLowerCase() === '.xml' && /<mapper\b[^>]*\bnamespace\s*=/i.test(content)) {
        return true;
      }
      if (extname(filePath).toLocaleLowerCase() === '.java' && /@TableName\b|\bBaseMapper\s*</.test(content)) {
        return true;
      }
    } catch {
      // Capability detection is best-effort. Extraction reports file-level diagnostics.
    }
  }
  return false;
}

async function extract(context: DataFlowProjectContext): Promise<DataFlowOverlay> {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  const diagnostics: DataFlowDiagnostic[] = [];
  const entities: JavaEntity[] = [];
  const mappers: JavaMapper[] = [];
  const files = await candidateFiles(context.projectRoot);
  if (files.length >= MAX_FILES) {
    diagnostics.push(warning(
      'java-mybatis-file-limit',
      `Candidate file scan reached the ${MAX_FILES} file safety limit.`,
    ));
  }

  for (const absolutePath of files) {
    const filePath = portablePath(context.projectRoot, absolutePath);
    try {
      const content = await readableSource(absolutePath);
      if (!content) {
        diagnostics.push(warning(
          'java-mybatis-file-skipped',
          `Candidate file exceeds the ${MAX_FILE_SIZE} byte safety limit.`,
          filePath,
        ));
        continue;
      }
      if (extname(absolutePath).toLocaleLowerCase() === '.xml') {
        extractXmlOverlay(content, filePath, context, nodeMap, edgeMap, diagnostics);
      } else {
        const entity = parseEntity(content, filePath);
        if (entity) entities.push(entity);
        const mapper = parseMapper(content, filePath);
        if (mapper) mappers.push(mapper);
      }
    } catch (error) {
      diagnostics.push(warning(
        'java-mybatis-file-read-failed',
        `Candidate file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        filePath,
      ));
    }
  }

  const entitiesByQualifiedName = new Map(entities.map((entity) => [entity.qualifiedName, entity]));
  const entitiesBySimpleName = new Map<string, JavaEntity[]>();
  for (const entity of entities) {
    const values = entitiesBySimpleName.get(entity.simpleName) ?? [];
    values.push(entity);
    entitiesBySimpleName.set(entity.simpleName, values);
  }
  for (const mapper of mappers) {
    addMapperOverlay(
      mapper,
      resolveEntity(mapper, entitiesByQualifiedName, entitiesBySimpleName),
      context,
      nodeMap,
      edgeMap,
      diagnostics,
    );
  }

  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()], diagnostics };
}

export const javaMyBatisProvider: DataFlowProvider = {
  id: PROVIDER_ID,
  supports,
  extract,
};
