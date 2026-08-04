#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { inspectCodeGraph, loadCodeGraphSnapshot } from './adapters/codegraph.js';
import { initWorkspace, loadWorkspace } from './core/workspace.js';
import { buildServer } from './server/app.js';

const execFileAsync = promisify(execFile);

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

async function statusFor(inputPath?: string) {
  const workspace = await loadWorkspace(inputPath);
  const codegraph = await inspectCodeGraph(workspace.rootPath);
  const graph = codegraph.initialized && codegraph.compatible
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
    .version('0.1.0')
    .configureOutput({
      writeOut: (value) => io.stdout(value.trimEnd()),
      writeErr: (value) => io.stderr(value.trimEnd()),
    });

  program
    .command('init')
    .description('Initialize a CodeAtlas workspace and its CodeGraph index')
    .argument('[path]', 'workspace path', process.cwd())
    .option('--skip-codegraph', 'create only the CodeAtlas workspace')
    .action(async (inputPath: string, flags: { skipCodegraph?: boolean }) => {
      const workspace = await initWorkspace(inputPath);
      io.stdout(
        workspace.created
          ? `Workspace initialized: ${workspace.rootPath}`
          : `Workspace already exists: ${workspace.rootPath}`,
      );
      if (flags.skipCodegraph) {
        io.stdout('CodeGraph initialization skipped.');
        return;
      }
      const status = await inspectCodeGraph(workspace.rootPath);
      if (!status.available) {
        io.stderr('CodeGraph is not installed. The workspace is ready, but no code facts were generated.');
        return;
      }
      if (!status.initialized) {
        io.stdout('Building the CodeGraph index…');
        await runCodeGraph(['init', workspace.rootPath], io);
      } else {
        io.stdout(`CodeGraph index ready${status.version ? ` (v${status.version})` : ''}.`);
      }
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
      io.stdout(`CodeGraph  ${status.codegraph.initialized ? 'indexed' : 'not indexed'}${status.codegraph.version ? ` · v${status.codegraph.version}` : ''}`);
      io.stdout(`Graph      ${status.graph ? `${status.graph.nodes.toLocaleString()} nodes · ${status.graph.edges.toLocaleString()} edges` : 'unavailable'}`);
    });

  program
    .command('sync')
    .description('Synchronize CodeGraph with workspace changes')
    .argument('[path]', 'workspace path')
    .action(async (inputPath?: string) => {
      const workspace = await loadWorkspace(inputPath);
      const status = await inspectCodeGraph(workspace.rootPath);
      if (!status.available || !status.initialized) {
        throw new Error('CodeGraph is not ready. Run "codeatlas init" first.');
      }
      await runCodeGraph(['sync', workspace.rootPath], io);
      io.stdout('Workspace graph synchronized.');
    });

  program
    .command('open')
    .description('Start the local CodeAtlas web application')
    .argument('[path]', 'workspace path')
    .option('-p, --port <number>', 'local port', '43117')
    .option('--no-browser', 'do not launch the browser')
    .action(async (inputPath: string | undefined, flags: { port: string; browser: boolean }) => {
      const workspace = await loadWorkspace(inputPath);
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
      await app.listen({ host: '127.0.0.1', port });
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

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    defaultIO.stderr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
