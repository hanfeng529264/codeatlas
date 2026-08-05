#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { inspectCodeGraph, loadCodeGraphSnapshot } from './adapters/codegraph.js';
import {
  addWorkspaceProject,
  discoverWorkspaceProjects,
  findWorkspaceRoot,
  initWorkspace,
  loadWorkspace,
  removeWorkspaceProject,
  resolveProjectRoot,
} from './core/workspace.js';
import type { Workspace } from './core/types.js';
import { buildServer } from './server/app.js';
import type { FastifyInstance } from 'fastify';

const execFileAsync = promisify(execFile);
const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export interface CliIO {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const defaultIO: CliIO = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

async function runCodeGraph(args: string[], io: CliIO): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync('codegraph', args, {
      maxBuffer: 20 * 1024 * 1024,
    });
    if (stdout.trim()) io.stdout(stdout.trim());
    if (stderr.trim()) io.stderr(stderr.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CodeGraph command failed: ${message}`);
  }
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function listenLocally(
  app: FastifyInstance,
  requestedPort: number,
  io: CliIO,
): Promise<void> {
  try {
    await app.listen({ host: '127.0.0.1', port: requestedPort });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    io.stdout(`Port ${requestedPort} is already in use; selecting an available port automatically.`);
    await app.listen({ host: '127.0.0.1', port: 0 });
  }
}

export interface PrepareWorkspaceForUseOptions {
  create: boolean;
  discover: boolean;
  index: boolean;
  io: CliIO;
}

export async function prepareWorkspaceForUse(
  inputPath: string,
  options: PrepareWorkspaceForUseOptions,
): Promise<Workspace> {
  const existingRoot = await findWorkspaceRoot(inputPath);
  let workspace: Workspace;
  if (existingRoot) {
    workspace = await loadWorkspace(existingRoot);
  } else if (options.create) {
    const initialized = await initWorkspace(inputPath);
    options.io.stdout(`Workspace initialized automatically: ${initialized.rootPath}`);
    workspace = initialized;
  } else {
    workspace = await loadWorkspace(inputPath);
  }

  if (options.discover) {
    const discovery = await discoverWorkspaceProjects(workspace.rootPath);
    const rootProject = workspace.config.projects.length === 1
      && workspace.config.projects[0]?.path === '.';
    const conventionalMultiProjectLayout = discovery.scanRoot !== workspace.rootPath
      && discovery.candidates.length > 0;
    if (rootProject && conventionalMultiProjectLayout) {
      await removeWorkspaceProject(workspace.rootPath, workspace.config.projects[0]!.id);
      workspace = await loadWorkspace(workspace.rootPath);
      options.io.stdout('Converted root registration to a multi-project workspace.');
    }

    let added = 0;
    for (const candidate of discovery.candidates) {
      const result = await addWorkspaceProject(workspace.rootPath, candidate.rootPath, {
        name: candidate.name,
      });
      workspace = result.workspace;
      added += 1;
    }
    if (added > 0) {
      options.io.stdout(`Multi-project layout detected: ${added} projects registered automatically.`);
    }
  }

  workspace = await loadWorkspace(workspace.rootPath);
  if (options.index) {
    for (const project of workspace.config.projects) {
      const projectRoot = resolveProjectRoot(workspace, project);
      const status = await inspectCodeGraph(projectRoot);
      if (!status.available) {
        options.io.stderr(`CodeGraph is not installed. ${project.name} is registered but not indexed.`);
      } else if (!status.initialized) {
        options.io.stdout(`Building the CodeGraph index for ${project.name}…`);
        await runCodeGraph(['init', projectRoot], options.io);
      } else {
        options.io.stdout(`CodeGraph index ready for ${project.name}${status.version ? ` (v${status.version})` : ''}.`);
      }
    }
  }

  return workspace;
}

async function statusFor(inputPath?: string) {
  const workspace = await loadWorkspace(inputPath);
  const projectStatuses = await Promise.all(
    workspace.config.projects.map(async (project) => ({
      project,
      status: await inspectCodeGraph(resolveProjectRoot(workspace, project)),
    })),
  );
  const firstStatus = projectStatuses[0]?.status;
  const codegraph = {
    available: projectStatuses.length === 0 ? await inspectCodeGraph(workspace.rootPath).then((status) => status.available) : projectStatuses.every(({ status }) => status.available),
    initialized: projectStatuses.length > 0 && projectStatuses.every(({ status }) => status.initialized),
    compatible: projectStatuses.every(({ status }) => status.compatible),
    version: firstStatus?.version,
    projects: projectStatuses.map(({ project, status }) => ({ ...project, ...status })),
  };
  const graph = projectStatuses.some(({ status }) => status.initialized && status.compatible)
    ? await loadCodeGraphSnapshot(workspace).then((snapshot) => ({
        version: snapshot.version,
        nodes: snapshot.counts.totalNodes,
        edges: snapshot.counts.totalEdges,
        truncated: snapshot.truncated,
      }))
    : null;
  return {
    workspace: {
      id: workspace.config.id,
      name: workspace.config.name,
      rootPath: workspace.rootPath,
      projects: workspace.config.projects,
    },
    codegraph,
    graph,
  };
}

export function createCli(io: CliIO = defaultIO): Command {
  const program = new Command();
  program
    .name('codeatlas')
    .description('Local code cartography for humans and AI')
    .version(packageVersion)
    .configureOutput({
      writeOut: (value) => io.stdout(value.trimEnd()),
      writeErr: (value) => io.stderr(value.trimEnd()),
    });

  program
    .command('init')
    .description('Initialize a CodeAtlas workspace and its CodeGraph index')
    .argument('[path]', 'workspace path', process.cwd())
    .option('--skip-codegraph', 'create only the CodeAtlas workspace')
    .option('--empty', 'create an empty multi-project workspace')
    .option('--no-discover', 'disable automatic multi-project discovery')
    .action(async (
      inputPath: string,
      flags: { skipCodegraph?: boolean; empty?: boolean; discover: boolean },
    ) => {
      const workspace = await initWorkspace(inputPath, { empty: flags.empty });
      io.stdout(
        workspace.created
          ? `Workspace initialized: ${workspace.rootPath}`
          : `Workspace already exists: ${workspace.rootPath}`,
      );
      if (flags.empty) {
        io.stdout('Empty multi-project workspace ready. Add projects with "codeatlas project add".');
        return;
      }
      await prepareWorkspaceForUse(workspace.rootPath, {
        create: false,
        discover: flags.discover,
        index: !flags.skipCodegraph,
        io,
      });
      if (flags.skipCodegraph) {
        io.stdout('CodeGraph initialization skipped.');
      }
    });

  const project = program
    .command('project')
    .description('Manage projects in a CodeAtlas workspace');

  project
    .command('add')
    .description('Add a project to the workspace')
    .argument('<project-path>', 'project directory')
    .option('-w, --workspace <path>', 'workspace path', process.cwd())
    .option('-n, --name <name>', 'project display name')
    .option('--skip-codegraph', 'register the project without initializing CodeGraph')
    .action(async (
      projectPath: string,
      flags: { workspace: string; name?: string; skipCodegraph?: boolean },
    ) => {
      const added = await addWorkspaceProject(flags.workspace, projectPath, { name: flags.name });
      io.stdout(`Project added: ${added.project.name} (${added.project.id})`);
      if (flags.skipCodegraph) {
        io.stdout('CodeGraph initialization skipped.');
        return;
      }
      const projectRoot = resolveProjectRoot(added.workspace, added.project);
      const status = await inspectCodeGraph(projectRoot);
      if (!status.available) {
        io.stderr('CodeGraph is not installed. The project is registered but not indexed.');
        return;
      }
      if (!status.initialized) {
        io.stdout(`Building the CodeGraph index for ${added.project.name}…`);
        await runCodeGraph(['init', projectRoot], io);
      } else {
        io.stdout(`CodeGraph index ready for ${added.project.name}${status.version ? ` (v${status.version})` : ''}.`);
      }
    });

  project
    .command('scan')
    .description('Discover and add first-level projects in one command')
    .argument('[directory]', 'directory to scan; defaults to projects/ when present')
    .option('-w, --workspace <path>', 'workspace path', process.cwd())
    .option('--skip-codegraph', 'register projects without initializing CodeGraph')
    .action(async (
      inputPath: string | undefined,
      flags: { workspace: string; skipCodegraph?: boolean },
    ) => {
      const discovery = await discoverWorkspaceProjects(flags.workspace, inputPath);
      io.stdout(`Scanning for projects: ${discovery.scanRoot}`);
      let added = 0;
      let indexed = 0;
      let failed = 0;

      for (const candidate of discovery.candidates) {
        try {
          const result = await addWorkspaceProject(flags.workspace, candidate.rootPath, {
            name: candidate.name,
          });
          added += 1;
          io.stdout(`Project added: ${result.project.name} (${result.project.id})`);
          if (flags.skipCodegraph) continue;

          const projectRoot = resolveProjectRoot(result.workspace, result.project);
          const status = await inspectCodeGraph(projectRoot);
          if (!status.available) {
            failed += 1;
            io.stderr(`CodeGraph is not installed. ${result.project.name} was registered but not indexed.`);
          } else if (!status.initialized) {
            io.stdout(`Building the CodeGraph index for ${result.project.name}…`);
            await runCodeGraph(['init', projectRoot], io);
            indexed += 1;
          } else {
            indexed += 1;
            io.stdout(`CodeGraph index ready for ${result.project.name}${status.version ? ` (v${status.version})` : ''}.`);
          }
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          io.stderr(`Project failed: ${candidate.name} · ${message}`);
        }
      }

      for (const registered of discovery.alreadyRegistered) {
        io.stdout(`Project already registered: ${registered.name} (${registered.id})`);
      }
      io.stdout(
        `Scan complete: ${added} added · ${indexed} indexed · ${discovery.alreadyRegistered.length} already registered · ${failed} failed`,
      );
    });

  project
    .command('list')
    .description('List projects in the workspace')
    .argument('[path]', 'workspace path')
    .option('--json', 'print machine-readable JSON')
    .action(async (inputPath: string | undefined, flags: { json?: boolean }) => {
      const workspace = await loadWorkspace(inputPath);
      if (flags.json) {
        io.stdout(JSON.stringify({
          workspace: { id: workspace.config.id, name: workspace.config.name, rootPath: workspace.rootPath },
          projects: workspace.config.projects,
        }));
        return;
      }
      if (workspace.config.projects.length === 0) {
        io.stdout('No projects registered.');
        return;
      }
      for (const entry of workspace.config.projects) {
        io.stdout(`${entry.id}\t${entry.name}\t${entry.path}`);
      }
    });

  project
    .command('remove')
    .description('Remove a project from the workspace without deleting its files')
    .argument('<project>', 'project id or exact name')
    .option('-w, --workspace <path>', 'workspace path', process.cwd())
    .action(async (input: string, flags: { workspace: string }) => {
      const removed = await removeWorkspaceProject(flags.workspace, input);
      io.stdout(`Project removed: ${removed.project.name} (${removed.project.id})`);
    });

  program
    .command('status')
    .description('Show workspace and graph health')
    .argument('[path]', 'workspace path')
    .option('--json', 'print machine-readable JSON')
    .action(async (inputPath: string | undefined, flags: { json?: boolean }) => {
      const status = await statusFor(inputPath);
      if (flags.json) {
        io.stdout(JSON.stringify(status));
        return;
      }
      io.stdout(`Workspace  ${status.workspace.name}`);
      io.stdout(`Root       ${status.workspace.rootPath}`);
      const indexedProjects = status.codegraph.projects.filter((project) => project.initialized).length;
      io.stdout(`Projects   ${status.workspace.projects.length} · ${indexedProjects} indexed`);
      io.stdout(`CodeGraph  ${status.codegraph.initialized ? 'all indexed' : 'partial or not indexed'}${status.codegraph.version ? ` · v${status.codegraph.version}` : ''}`);
      io.stdout(`Graph      ${status.graph ? `${status.graph.nodes.toLocaleString()} nodes · ${status.graph.edges.toLocaleString()} edges` : 'unavailable'}`);
    });

  program
    .command('sync')
    .description('Synchronize CodeGraph with workspace changes')
    .argument('[path]', 'workspace path')
    .action(async (inputPath?: string) => {
      const workspace = await loadWorkspace(inputPath);
      if (workspace.config.projects.length === 0) {
        throw new Error('No projects are registered. Run "codeatlas project add" first.');
      }
      for (const projectEntry of workspace.config.projects) {
        const projectRoot = resolveProjectRoot(workspace, projectEntry);
        const status = await inspectCodeGraph(projectRoot);
        if (!status.available || !status.initialized) {
          throw new Error(`CodeGraph is not ready for ${projectEntry.name}. Initialize that project first.`);
        }
        await runCodeGraph(['sync', projectRoot], io);
        io.stdout(`Synchronized ${projectEntry.name}.`);
      }
      io.stdout('Workspace graph synchronized.');
    });

  program
    .command('open')
    .description('Initialize, discover, index, and open a CodeAtlas workspace')
    .argument('[path]', 'workspace path', process.cwd())
    .option('-p, --port <number>', 'local port', '43117')
    .option('--no-browser', 'do not launch the browser')
    .option('--no-discover', 'disable automatic multi-project discovery')
    .action(async (
      inputPath: string,
      flags: { port: string; browser: boolean; discover: boolean },
    ) => {
      const workspace = await prepareWorkspaceForUse(inputPath, {
        create: true,
        discover: flags.discover,
        index: true,
        io,
      });
      const snapshot = await loadCodeGraphSnapshot(workspace);
      const token = randomBytes(24).toString('base64url');
      const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/web');
      const app = await buildServer({
        workspace,
        snapshot,
        token,
        staticRoot,
        logger: false,
      });
      const port = Number.parseInt(flags.port, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error(`Invalid port: ${flags.port}`);
      }
      await listenLocally(app, port, io);
      const address = app.server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(token)}`;
      io.stdout(`CodeAtlas is ready: ${url}`);
      io.stdout(`Loaded ${snapshot.counts.returnedNodes.toLocaleString()} / ${snapshot.counts.totalNodes.toLocaleString()} nodes and ${snapshot.counts.returnedEdges.toLocaleString()} / ${snapshot.counts.totalEdges.toLocaleString()} edges.`);
      if (flags.browser) openBrowser(url);
      const shutdown = async () => {
        await app.close();
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

export function isMainModule(argvEntry: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvEntry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argvEntry) === realpathSync(modulePath);
  } catch {
    return resolve(argvEntry) === resolve(modulePath);
  }
}

if (isMainModule(process.argv[1])) {
  main().catch((error) => {
    defaultIO.stderr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
