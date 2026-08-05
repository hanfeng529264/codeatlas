import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import type { GraphSnapshot, Workspace } from '../core/types.js';
import { GraphStore, type GraphDirection, type GraphView } from './graph-store.js';

interface BuildServerOptions {
  workspace: Workspace;
  snapshot: GraphSnapshot;
  token: string;
  logger?: boolean;
  staticRoot?: string;
}

const neighborhoodSchema = z.object({
  nodeId: z.string().min(1),
  direction: z.enum(['in', 'out', 'both']).optional(),
  depth: z.number().int().min(0).max(8).optional(),
  relationTypes: z.array(z.string()).optional(),
  maxNodes: z.number().int().positive().max(5_000).optional(),
});

const pathSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relationTypes: z.array(z.string()).optional(),
  maxDepth: z.number().int().positive().max(40).optional(),
});

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const store = new GraphStore(options.snapshot);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.headers['x-codeatlas-token'] !== options.token) {
      await reply.code(401).send({ error: 'A valid CodeAtlas session token is required.' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      void reply.code(400).send({ error: 'Invalid request.', issues: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.startsWith('Unknown graph node') ? 404 : 500;
    void reply.code(statusCode).send({ error: message });
  });

  app.get('/api/status', async () => {
    const projectStatuses = options.snapshot.projects;
    const codegraph = {
      available: projectStatuses.every((project) => project.available),
      initialized: projectStatuses.length > 0 && projectStatuses.every((project) => project.indexed),
      compatible: projectStatuses.every((project) => project.compatible),
      version: projectStatuses.find((project) => project.version)?.version,
      projects: projectStatuses,
    };
    return {
      workspace: {
        id: options.workspace.config.id,
        name: options.workspace.config.name,
        rootPath: options.workspace.rootPath,
        projects: options.workspace.config.projects,
      },
      codegraph,
      graph: {
        version: options.snapshot.version,
        totalNodes: options.snapshot.counts.totalNodes,
        totalEdges: options.snapshot.counts.totalEdges,
        returnedNodes: options.snapshot.counts.returnedNodes,
        returnedEdges: options.snapshot.counts.returnedEdges,
        truncated: options.snapshot.truncated,
        truncationReason: options.snapshot.truncationReason,
      },
    };
  });

  app.get('/api/search', async (request) => {
    const query = z.object({
      q: z.string().default(''),
      limit: z.coerce.number().optional(),
      project: z.string().optional(),
    }).parse(request.query);
    const projectIds = query.project?.split(',').map((value) => value.trim()).filter(Boolean);
    return { query: query.q, projectIds, results: store.search(query.q, query.limit, projectIds) };
  });

  app.get('/api/nodes/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const node = store.getNode(id);
    if (!node) return reply.code(404).send({ error: `Unknown graph node: ${id}` });
    return node;
  });

  app.get('/api/graph', async (request) => {
    const query = z
      .object({
        view: z.enum(['full', 'directory', 'structure', 'methods', 'calls']).default('full'),
        project: z.string().optional(),
        complete: z.enum(['0', '1']).default('0'),
        limit: z.coerce.number().int().min(100).max(10_000).optional(),
      })
      .parse(request.query);
    const projectIds = query.project?.split(',').map((value) => value.trim()).filter(Boolean);
    return store.view(query.view as GraphView, projectIds, {
      complete: query.complete === '1',
      maxNodes: query.limit,
    });
  });

  app.post('/api/graph/neighborhood', async (request) => {
    const body = neighborhoodSchema.parse(request.body);
    return store.neighborhood({
      ...body,
      direction: body.direction as GraphDirection | undefined,
    });
  });

  app.post('/api/graph/path', async (request) => {
    return store.shortestPath(pathSchema.parse(request.body));
  });

  if (options.staticRoot && (await access(options.staticRoot).then(() => true).catch(() => false))) {
    await app.register(fastifyStatic, {
      root: options.staticRoot,
      prefix: '/',
      index: 'index.html',
    });
  } else {
    app.get('/', async () => ({
      name: 'CodeAtlas',
      message: 'Web assets are not built. Run "npm run build:web".',
    }));
  }

  await app.ready();
  return app;
}
