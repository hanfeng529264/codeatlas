import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Workspace, WorkspaceConfig, WorkspaceProject } from './types.js';

export const CODEATLAS_DIRECTORY = '.codeatlas';
export const WORKSPACE_CONFIG = 'workspace.json';

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
});

const workspaceSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1),
  root: z.literal('.'),
  initializedAt: z.string().datetime(),
  projects: z.array(projectSchema),
  codegraph: z.object({ path: z.literal('.') }),
});

const workspaceSchemaV2 = z.object({
  schemaVersion: z.literal(2),
  id: z.string().uuid(),
  name: z.string().min(1),
  root: z.literal('.'),
  initializedAt: z.string().datetime(),
  projects: z.array(projectSchema),
});

const workspaceSchema = z.union([workspaceSchemaV2, workspaceSchemaV1]);

export interface InitWorkspaceOptions {
  empty?: boolean;
}

export interface AddWorkspaceProjectOptions {
  name?: string;
}

async function assertDirectory(rootPath: string): Promise<void> {
  try {
    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${rootPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('not a directory')) {
      throw error;
    }
    throw new Error(`Workspace path does not exist: ${rootPath}`);
  }
}

function configPathFor(rootPath: string): string {
  return join(rootPath, CODEATLAS_DIRECTORY, WORKSPACE_CONFIG);
}

async function writeConfig(configPath: string, config: WorkspaceConfig): Promise<void> {
  const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporaryPath, configPath);
}

async function readConfig(configPath: string): Promise<WorkspaceConfig> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = workspaceSchema.parse(JSON.parse(raw));
  if (parsed.schemaVersion === 2) return parsed;
  const migrated: WorkspaceConfig = {
    schemaVersion: 2,
    id: parsed.id,
    name: parsed.name,
    root: '.',
    initializedAt: parsed.initializedAt,
    projects: parsed.projects,
  };
  await writeConfig(configPath, migrated);
  return migrated;
}

export async function initWorkspace(
  inputPath = process.cwd(),
  options: InitWorkspaceOptions = {},
): Promise<Workspace> {
  const rootPath = resolve(inputPath);
  await assertDirectory(rootPath);
  const directory = join(rootPath, CODEATLAS_DIRECTORY);
  const configPath = configPathFor(rootPath);

  try {
    await access(configPath);
    return {
      rootPath,
      configPath,
      config: await readConfig(configPath),
      created: false,
    };
  } catch {
    // The workspace has not been initialized yet.
  }

  await mkdir(directory, { recursive: true });
  const name = basename(rootPath);
  const config: WorkspaceConfig = {
    schemaVersion: 2,
    id: randomUUID(),
    name,
    root: '.',
    initializedAt: new Date().toISOString(),
    projects: options.empty ? [] : [{ id: 'root', name, path: '.' }],
  };
  await writeConfig(configPath, config);

  return { rootPath, configPath, config, created: true };
}

export async function findWorkspaceRoot(startPath = process.cwd()): Promise<string | null> {
  let current = resolve(startPath);
  const startInfo = await stat(current).catch(() => null);
  if (startInfo?.isFile()) current = dirname(current);

  while (true) {
    try {
      await access(configPathFor(current));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export async function loadWorkspace(startPath = process.cwd()): Promise<Workspace> {
  const rootPath = await findWorkspaceRoot(startPath);
  if (!rootPath) {
    throw new Error(`No CodeAtlas workspace found from ${resolve(startPath)}. Run "codeatlas init" first.`);
  }
  const configPath = configPathFor(rootPath);
  return {
    rootPath,
    configPath,
    config: await readConfig(configPath),
    created: false,
  };
}

function portableProjectPath(workspaceRoot: string, projectRoot: string): string {
  const value = relative(workspaceRoot, projectRoot).replaceAll('\\', '/');
  if (value === '') return '.';
  if (value === '..' || value.startsWith('../') || isAbsolute(value)) {
    throw new Error(`Project path must be inside the workspace: ${projectRoot}`);
  }
  return value.replace(/^\.\//, '');
}

function projectId(name: string, projects: WorkspaceProject[]): string {
  const base = name
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';
  const ids = new Set(projects.map((project) => project.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function resolveProjectRoot(workspace: Workspace, project: WorkspaceProject): string {
  return resolve(workspace.rootPath, project.path);
}

export async function addWorkspaceProject(
  startPath: string,
  inputPath: string,
  options: AddWorkspaceProjectOptions = {},
): Promise<{ workspace: Workspace; project: WorkspaceProject }> {
  const workspace = await loadWorkspace(startPath);
  const projectRoot = resolve(inputPath);
  await assertDirectory(projectRoot);
  const path = portableProjectPath(workspace.rootPath, projectRoot);
  if (workspace.config.projects.some((project) => project.path === path)) {
    throw new Error(`Project path is already registered: ${path}`);
  }
  const name = options.name?.trim() || basename(projectRoot);
  const project: WorkspaceProject = {
    id: projectId(name, workspace.config.projects),
    name,
    path,
  };
  const config: WorkspaceConfig = {
    ...workspace.config,
    projects: [...workspace.config.projects, project],
  };
  await writeConfig(workspace.configPath, config);
  return { workspace: { ...workspace, config }, project };
}

export async function removeWorkspaceProject(
  startPath: string,
  input: string,
): Promise<{ workspace: Workspace; project: WorkspaceProject }> {
  const workspace = await loadWorkspace(startPath);
  const project = workspace.config.projects.find(
    (candidate) => candidate.id === input || candidate.name === input,
  );
  if (!project) throw new Error(`Unknown workspace project: ${input}`);
  const config: WorkspaceConfig = {
    ...workspace.config,
    projects: workspace.config.projects.filter((candidate) => candidate.id !== project.id),
  };
  await writeConfig(workspace.configPath, config);
  return { workspace: { ...workspace, config }, project };
}
