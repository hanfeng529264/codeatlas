import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Workspace, WorkspaceConfig } from './types.js';

export const CODEATLAS_DIRECTORY = '.codeatlas';
export const WORKSPACE_CONFIG = 'workspace.json';

const workspaceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1),
  root: z.literal('.'),
  initializedAt: z.string().datetime(),
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), path: z.string() }),
  ),
  codegraph: z.object({ path: z.literal('.') }),
});

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

async function readConfig(configPath: string): Promise<WorkspaceConfig> {
  const raw = await readFile(configPath, 'utf8');
  return workspaceSchema.parse(JSON.parse(raw)) as WorkspaceConfig;
}

export async function initWorkspace(inputPath = process.cwd()): Promise<Workspace> {
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
    schemaVersion: 1,
    id: randomUUID(),
    name,
    root: '.',
    initializedAt: new Date().toISOString(),
    projects: [{ id: 'root', name, path: '.' }],
    codegraph: { path: '.' },
  };
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporaryPath, configPath);

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
