import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addWorkspaceProject, initWorkspace } from '../dist/core/workspace.js';
import { loadCodeGraphSnapshot } from '../dist/adapters/codegraph.js';
import { buildServer } from '../dist/server/app.js';

function createProjectIndex(projectRoot) {
  const indexRoot = join(projectRoot, '.codegraph');
  mkdirSync(indexRoot, { recursive: true });
  const db = new DatabaseSync(join(indexRoot, 'codegraph.db'));
  db.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0, errors TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, docstring TEXT, signature TEXT, visibility TEXT, is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0, decorators TEXT, type_parameters TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT DEFAULT NULL);
    INSERT INTO files VALUES ('src/auth.ts','a','typescript',200,1,2,2,NULL), ('src/session.ts','b','typescript',160,1,2,1,NULL);
    INSERT INTO nodes (id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,signature,visibility,is_exported,updated_at) VALUES
      ('n-service','class','AuthService','AuthService','src/auth.ts','typescript',1,18,0,1,'class AuthService','public',1,2),
      ('n-login','method','login','AuthService::login','src/auth.ts','typescript',3,10,0,1,'(email: string)','public',0,2),
      ('n-session','function','createSession','session.createSession','src/session.ts','typescript',2,7,0,1,'(userId: string)','public',1,2);
    INSERT INTO edges (source,target,kind,metadata,line,col,provenance) VALUES
      ('n-login','n-session','calls','{}',7,2,'static'),
      ('n-service','n-login','contains','{}',3,0,'static');
  `);
  db.close();
}

const root = await mkdtemp(join(tmpdir(), 'codeatlas-e2e-'));
const frontendRoot = join(root, 'apps', 'frontend');
const apiRoot = join(root, 'services', 'api');
await mkdir(frontendRoot, { recursive: true });
await mkdir(apiRoot, { recursive: true });

const workspace = await initWorkspace(root, { empty: true });
await addWorkspaceProject(root, frontendRoot, { name: 'Frontend' });
const apiProject = await addWorkspaceProject(root, apiRoot, { name: 'API' });
createProjectIndex(frontendRoot);
createProjectIndex(apiRoot);
await writeFile(
  join(frontendRoot, 'package.json'),
  `${JSON.stringify({ name: '@codeatlas/frontend', dependencies: { '@codeatlas/api': 'workspace:*' } })}\n`,
);
await writeFile(join(apiRoot, 'package.json'), `${JSON.stringify({ name: '@codeatlas/api' })}\n`);

const snapshot = await loadCodeGraphSnapshot(apiProject.workspace);
const dataTableId = 'table:api:audit_log';
snapshot.nodes.push({
  id: dataTableId,
  kind: 'table',
  label: 'audit_log',
  qualifiedName: 'audit_log',
  projectId: 'api',
  source: 'java-mybatis',
  evidenceClass: 'static-derived',
  confidence: 1,
  metadata: { providerId: 'java-mybatis', tableName: 'audit_log' },
});
snapshot.edges.push({
  id: 'e2e-data-read',
  source: 'symbol:api:n-session',
  target: dataTableId,
  kind: 'READS_FROM',
  sourceName: 'java-mybatis',
  evidenceClass: 'static-derived',
  confidence: 1,
  metadata: {
    providerId: 'java-mybatis',
    operation: 'select',
    sourceFile: 'src/session.ts',
  },
});
snapshot.diagnostics.push({
  providerId: 'java-mybatis',
  projectId: 'api',
  severity: 'warning',
  code: 'e2e-dynamic-table',
  message: 'One dynamic table expression could not be resolved.',
  filePath: 'src/session.ts',
});
snapshot.counts.totalNodes = snapshot.nodes.length;
snapshot.counts.returnedNodes = snapshot.nodes.length;
snapshot.counts.totalEdges = snapshot.edges.length;
snapshot.counts.returnedEdges = snapshot.edges.length;
snapshot.version += ':e2e-data';
const app = await buildServer({
  workspace: { ...workspace, config: apiProject.workspace.config },
  snapshot,
  token: 'e2e-token',
  staticRoot: resolve('dist/web'),
});
await app.listen({ host: '127.0.0.1', port: 43118 });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
