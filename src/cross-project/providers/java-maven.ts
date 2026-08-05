import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { GraphDiagnostic, GraphEdge, GraphNode, WorkspaceProject } from '../../core/types.js';
import { resolveProjectRoot } from '../../core/workspace.js';
import type {
  CrossProjectContext,
  CrossProjectOverlay,
  CrossProjectProvider,
} from '../provider.js';

const PROVIDER_ID = 'java-maven-contract';
const MAX_POM_DEPTH = 4;
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.codeatlas', '.codegraph', 'node_modules', 'target', 'build', 'dist',
]);

interface MavenDependency {
  coordinate: string;
  groupId: string;
  artifactId: string;
  version?: string;
  manifest: string;
}

interface MavenProjectFacts {
  project: WorkspaceProject;
  coordinates: MavenDependency[];
  dependencies: MavenDependency[];
}

interface JavaMethodTarget {
  node: GraphNode;
  arity: number;
}

function tag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]?.trim();
}

function directProjectValue(xml: string, name: string): string | undefined {
  const withoutParent = xml.replace(/<parent\b[\s\S]*?<\/parent>/i, '');
  return tag(withoutParent, name) ?? tag(tag(xml, 'parent') ?? '', name);
}

function resolveProperty(value: string | undefined, properties: Map<string, string>): string | undefined {
  if (!value) return undefined;
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => properties.get(name) ?? match);
}

function parsePom(xml: string, manifest: string, project: WorkspaceProject): MavenProjectFacts {
  const properties = new Map<string, string>();
  const propertiesXml = tag(xml, 'properties') ?? '';
  for (const match of propertiesXml.matchAll(/<([A-Za-z0-9_.-]+)\b[^>]*>([^<]*)<\/\1>/g)) {
    properties.set(match[1], match[2].trim());
  }

  const groupId = directProjectValue(xml, 'groupId');
  const artifactId = directProjectValue(xml, 'artifactId');
  const version = resolveProperty(directProjectValue(xml, 'version'), properties);
  const coordinates: MavenDependency[] = groupId && artifactId
    ? [{ coordinate: `${groupId}:${artifactId}`, groupId, artifactId, version, manifest }]
    : [];

  const directDependenciesXml = xml.replace(/<dependencyManagement\b[\s\S]*?<\/dependencyManagement>/gi, '');
  const dependencies: MavenDependency[] = [];
  for (const match of directDependenciesXml.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
    const block = match[1];
    const dependencyGroup = resolveProperty(tag(block, 'groupId'), properties);
    const dependencyArtifact = resolveProperty(tag(block, 'artifactId'), properties);
    if (!dependencyGroup || !dependencyArtifact) continue;
    dependencies.push({
      coordinate: `${dependencyGroup}:${dependencyArtifact}`,
      groupId: dependencyGroup,
      artifactId: dependencyArtifact,
      version: resolveProperty(tag(block, 'version'), properties),
      manifest,
    });
  }
  return { project, coordinates, dependencies };
}

async function pomFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_POM_DEPTH) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'pom.xml') files.push(join(root, entry.name));
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    files.push(...await pomFiles(join(root, entry.name), depth + 1));
  }
  return files;
}

async function mavenFacts(context: CrossProjectContext): Promise<{
  facts: MavenProjectFacts[];
  diagnostics: GraphDiagnostic[];
}> {
  const results: MavenProjectFacts[] = [];
  const diagnostics: GraphDiagnostic[] = [];
  for (const project of context.workspace.config.projects) {
    const root = resolveProjectRoot(context.workspace, project);
    const aggregate: MavenProjectFacts = { project, coordinates: [], dependencies: [] };
    for (const path of await pomFiles(root)) {
      const manifest = relative(root, path).replaceAll('\\', '/');
      try {
        const xml = await readFile(path, 'utf8');
        const facts = parsePom(xml, manifest, project);
        aggregate.coordinates.push(...facts.coordinates);
        aggregate.dependencies.push(...facts.dependencies);
      } catch (error) {
        diagnostics.push(warning(
          project.id,
          'maven-manifest-unreadable',
          `Could not read Maven manifest: ${error instanceof Error ? error.message : String(error)}`,
          manifest,
        ));
      }
    }
    results.push(aggregate);
  }
  return { facts: results, diagnostics };
}

function dottedType(qualifiedName: string | undefined): string | undefined {
  if (!qualifiedName) return undefined;
  return qualifiedName.replaceAll('::', '.');
}

function parameterCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const start = value.indexOf('(');
  if (start < 0) return undefined;
  let depth = 0;
  let count = 0;
  let hasToken = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === ')' && depth === 0) return hasToken ? count + 1 : 0;
    if ('(<[{'.includes(char)) depth += 1;
    else if (')>]}'.includes(char)) depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      count += 1;
      hasToken = false;
    } else if (!/\s/.test(char)) hasToken = true;
  }
  return undefined;
}

function callArgumentCount(source: string, openingParen: number): number | undefined {
  let depth = 0;
  let count = 0;
  let hasToken = false;
  let quote = '';
  for (let index = openingParen + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') quote = '';
      hasToken = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if ('([{<'.includes(char)) {
      depth += 1;
      hasToken = true;
    } else if (char === ')' && depth === 0) {
      return hasToken ? count + 1 : 0;
    } else if (')]}>' .includes(char)) {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      count += 1;
      hasToken = false;
    } else if (!/\s/.test(char)) {
      hasToken = true;
    }
  }
  return undefined;
}

function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

function lineAt(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

function importedTypes(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
    const qualified = match[1];
    imports.set(qualified.slice(qualified.lastIndexOf('.') + 1), qualified);
  }
  return imports;
}

function receiverTypes(
  source: string,
  offsets: number[],
  imports: Map<string, string>,
): Map<string, Array<{ line: number; type: string }>> {
  const values = new Map<string, Array<{ line: number; type: string }>>();
  const declaration = /\b([A-Z][\w$.]*(?:\s*<[^;=(){}]+>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?=[;=,)])/g;
  for (const match of source.matchAll(declaration)) {
    const rawType = match[1].replace(/<[^>]*>/g, '').replace(/\[\]$/, '').trim();
    const type = rawType.includes('.') ? rawType : imports.get(rawType);
    if (!type) continue;
    const declarations = values.get(match[2]) ?? [];
    declarations.push({ line: lineAt(offsets, match.index), type });
    values.set(match[2], declarations);
  }
  return values;
}

function enclosingMethod(methods: GraphNode[], filePath: string, line: number): GraphNode | undefined {
  const candidates = methods.filter((node) =>
    node.filePath === filePath
      && (node.startLine ?? Number.MAX_SAFE_INTEGER) <= line
      && (node.endLine ?? -1) >= line,
  );
  candidates.sort(
    (a, b) => ((a.endLine ?? 0) - (a.startLine ?? 0)) - ((b.endLine ?? 0) - (b.startLine ?? 0)),
  );
  return candidates.length === 1 || candidates[0]?.startLine !== candidates[1]?.startLine
    ? candidates[0]
    : undefined;
}

function targetIndex(nodes: GraphNode[], edges: GraphEdge[]): Map<string, JavaMethodTarget[]> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, JavaMethodTarget[]>();
  for (const edge of edges) {
    if (edge.kind !== 'CONTAINS') continue;
    const owner = nodeById.get(edge.source);
    const method = nodeById.get(edge.target);
    if (owner?.kind !== 'interface' || method?.kind !== 'method' || owner.projectId !== method.projectId) continue;
    const type = dottedType(owner.qualifiedName);
    const arity = parameterCount(String(method.metadata.signature ?? ''));
    if (!type || arity === undefined) continue;
    const key = `${owner.projectId}\u0000${type}\u0000${method.label}\u0000${arity}`;
    const targets = result.get(key) ?? [];
    targets.push({ node: method, arity });
    result.set(key, targets);
  }
  return result;
}

function warning(projectId: string, code: string, message: string, filePath?: string): GraphDiagnostic {
  return { providerId: PROVIDER_ID, projectId, severity: 'warning', code, message, filePath };
}

async function extractJavaMaven(context: CrossProjectContext): Promise<CrossProjectOverlay> {
  const maven = await mavenFacts(context);
  const facts = maven.facts;
  const coordinateOwners = new Map<string, Set<string>>();
  for (const fact of facts) {
    for (const coordinate of fact.coordinates) {
      const owners = coordinateOwners.get(coordinate.coordinate) ?? new Set<string>();
      owners.add(fact.project.id);
      coordinateOwners.set(coordinate.coordinate, owners);
    }
  }

  const dependencyTargets = new Map<string, Map<string, MavenDependency[]>>();
  for (const fact of facts) {
    for (const dependency of fact.dependencies) {
      const owners = coordinateOwners.get(dependency.coordinate);
      if (owners?.size !== 1) continue;
      const targetProjectId = [...owners][0];
      if (targetProjectId === fact.project.id) continue;
      const byTarget = dependencyTargets.get(fact.project.id) ?? new Map<string, MavenDependency[]>();
      const dependencies = byTarget.get(targetProjectId) ?? [];
      dependencies.push(dependency);
      byTarget.set(targetProjectId, dependencies);
      dependencyTargets.set(fact.project.id, byTarget);
    }
  }

  const targets = targetIndex(context.nodes, context.edges);
  const edges: GraphEdge[] = [];
  const diagnostics: GraphDiagnostic[] = [...maven.diagnostics];
  for (const fact of facts) {
    const byTarget = dependencyTargets.get(fact.project.id);
    if (!byTarget) continue;
    const root = resolveProjectRoot(context.workspace, fact.project);
    const methods = context.nodes.filter((node) =>
      node.projectId === fact.project.id
        && node.language?.toLowerCase() === 'java'
        && node.kind === 'method',
    );
    const methodsByFile = new Map<string, GraphNode[]>();
    for (const method of methods) {
      if (!method.filePath) continue;
      const fileMethods = methodsByFile.get(method.filePath) ?? [];
      fileMethods.push(method);
      methodsByFile.set(method.filePath, fileMethods);
    }
    let ambiguous = 0;
    for (const [filePath, fileMethods] of methodsByFile) {
      let source: string;
      try {
        source = await readFile(join(root, filePath), 'utf8');
      } catch (error) {
        diagnostics.push(warning(
          fact.project.id,
          'java-source-unreadable',
          `Could not read Java source: ${error instanceof Error ? error.message : String(error)}`,
          filePath,
        ));
        continue;
      }
      const imports = importedTypes(source);
      const offsets = lineOffsets(source);
      const declarations = receiverTypes(source, offsets, imports);
      for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const line = lineAt(offsets, match.index);
        const receiver = declarations.get(match[1])
          ?.filter((entry) => entry.line <= line)
          .sort((a, b) => b.line - a.line)[0];
        if (!receiver) continue;
        const arity = callArgumentCount(source, match.index + match[0].lastIndexOf('('));
        const caller = enclosingMethod(fileMethods, filePath, line);
        if (arity === undefined || !caller) continue;
        const matches: Array<{
          target: JavaMethodTarget;
          dependency: MavenDependency;
          targetProjectId: string;
        }> = [];
        for (const [targetProjectId, dependencies] of byTarget) {
          const candidates = targets.get(
            `${targetProjectId}\u0000${receiver.type}\u0000${match[2]}\u0000${arity}`,
          ) ?? [];
          for (const target of candidates) matches.push({ target, dependency: dependencies[0], targetProjectId });
        }
        if (matches.length !== 1) {
          if (matches.length > 1) ambiguous += 1;
          continue;
        }
        const selected = matches[0];
        edges.push({
          id: `remote-call:${fact.project.id}:${caller.id}:${selected.targetProjectId}:${selected.target.node.id}:${line}`,
          source: caller.id,
          target: selected.target.node.id,
          kind: 'REMOTE_CALLS',
          sourceName: PROVIDER_ID,
          evidenceClass: 'static-derived',
          confidence: 0.94,
          metadata: {
            consumerProjectId: fact.project.id,
            providerProjectId: selected.targetProjectId,
            interface: receiver.type,
            method: match[2],
            argumentCount: arity,
            dependency: selected.dependency.coordinate,
            dependencyVersion: selected.dependency.version,
            manifest: selected.dependency.manifest,
            filePath,
            line,
          },
        });
      }
    }
    if (ambiguous > 0) {
      diagnostics.push(warning(
        fact.project.id,
        'java-contract-call-ambiguous',
        `${ambiguous} Java contract call(s) had multiple workspace targets and were skipped.`,
      ));
    }
  }
  return { edges, diagnostics };
}

export const javaMavenContractProvider: CrossProjectProvider = {
  id: PROVIDER_ID,
  async supports(context) {
    return context.workspace.config.projects.length > 1;
  },
  extract: extractJavaMaven,
};

export const javaMavenInternals = { parsePom, parameterCount, callArgumentCount };
