import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  inspectCodeGraph,
  loadCodeGraphSnapshot,
} from '../src/adapters/codegraph.js';
import { addWorkspaceProject, initWorkspace } from '../src/core/workspace.js';
import { createCodeGraphFixture } from './fixtures/codegraph-db.js';

describe('CodeGraph adapter', () => {
  it('reports an uninitialized workspace without failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));

    const status = await inspectCodeGraph(root);

    expect(status.initialized).toBe(false);
    expect(status.compatible).toBe(true);
    expect(status.databasePath).toContain('.codegraph/codegraph.db');
  });

  it('normalizes the complete CodeGraph database into one workspace graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const workspace = await initWorkspace(root);
    createCodeGraphFixture(root);

    const snapshot = await loadCodeGraphSnapshot(workspace);

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.nodes.find((node) => node.kind === 'workspace')).toBeTruthy();
    expect(snapshot.nodes.filter((node) => node.kind === 'file')).toHaveLength(2);
    expect(snapshot.nodes.some((node) => node.id.startsWith('symbol:file:'))).toBe(false);
    expect(snapshot.nodes.filter((node) => node.kind === 'function')).toHaveLength(2);
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        source: 'symbol:root:n-auth',
        target: 'symbol:root:n-session',
        kind: 'CALLS',
        evidenceClass: 'static-derived',
      }),
    );
    expect(snapshot.counts.totalNodes).toBe(snapshot.nodes.length);
  });

  it('rejects an incompatible database instead of guessing its schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const indexDirectory = join(root, '.codegraph');
    await mkdir(indexDirectory);
    const db = new DatabaseSync(join(indexDirectory, 'codegraph.db'));
    db.exec('CREATE TABLE something_else (id TEXT)');
    db.close();

    const status = await inspectCodeGraph(root);

    expect(status.initialized).toBe(true);
    expect(status.compatible).toBe(false);
    expect(status.message).toContain('required tables');
  });

  it('reports explicit truncation when a node budget is applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const workspace = await initWorkspace(root);
    createCodeGraphFixture(root);

    const snapshot = await loadCodeGraphSnapshot(workspace, { maxNodes: 4 });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncationReason).toContain('node budget');
    expect(snapshot.counts.totalNodes).toBeGreaterThan(snapshot.counts.returnedNodes);
  });

  it('aggregates independent project indexes with namespaced ids and package dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const webRoot = join(root, 'apps', 'web');
    const apiRoot = join(root, 'services', 'api');
    await mkdir(webRoot, { recursive: true });
    await mkdir(apiRoot, { recursive: true });
    await initWorkspace(root, { empty: true });
    await addWorkspaceProject(root, webRoot, { name: 'Web' });
    const apiProject = await addWorkspaceProject(root, apiRoot, { name: 'API' });
    createCodeGraphFixture(webRoot);
    createCodeGraphFixture(apiRoot);
    await writeFile(
      join(webRoot, 'package.json'),
      `${JSON.stringify({ name: '@example/web', dependencies: { '@example/api': 'workspace:*' } })}\n`,
    );
    await writeFile(
      join(apiRoot, 'package.json'),
      `${JSON.stringify({ name: '@example/api' })}\n`,
    );

    const snapshot = await loadCodeGraphSnapshot(apiProject.workspace);

    expect(snapshot.projects).toEqual([
      expect.objectContaining({ id: 'web', indexed: true, compatible: true }),
      expect.objectContaining({ id: 'api', indexed: true, compatible: true }),
    ]);
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'symbol:web:n-auth', projectId: 'web' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'symbol:api:n-auth', projectId: 'api' }));
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      source: 'project:web',
      target: 'project:api',
      kind: 'DEPENDS_ON',
      sourceName: 'package.json',
      evidenceClass: 'static-derived',
    }));
    expect(snapshot.truncated).toBe(false);
  });

  it('keeps healthy projects visible and reports missing project indexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-'));
    const readyRoot = join(root, 'ready');
    const missingRoot = join(root, 'missing');
    await mkdir(readyRoot);
    await mkdir(missingRoot);
    await initWorkspace(root, { empty: true });
    await addWorkspaceProject(root, readyRoot, { name: 'Ready' });
    const missingProject = await addWorkspaceProject(root, missingRoot, { name: 'Missing' });
    createCodeGraphFixture(readyRoot);

    const snapshot = await loadCodeGraphSnapshot(missingProject.workspace);

    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'project:ready' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'project:missing' }));
    expect(snapshot.projects.find((project) => project.id === 'missing')).toMatchObject({ indexed: false });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncationReason).toContain('Missing');
  });

  it('merges data-flow overlays into existing CodeGraph mapper and XML nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-data-'));
    const javaPath = 'src/main/java/com/example/mapper/OrderMapper.java';
    const controllerPath = 'src/main/java/com/example/controller/OrderController.java';
    const entityPath = 'src/main/java/com/example/entity/OrderEntity.java';
    const xmlPath = 'src/main/resources/mapper/OrderMapper.xml';
    await mkdir(join(root, 'src/main/java/com/example/mapper'), { recursive: true });
    await mkdir(join(root, 'src/main/java/com/example/controller'), { recursive: true });
    await mkdir(join(root, 'src/main/java/com/example/entity'), { recursive: true });
    await mkdir(join(root, 'src/main/resources/mapper'), { recursive: true });
    await writeFile(join(root, javaPath), `
      package com.example.mapper;
      import com.baomidou.mybatisplus.core.mapper.BaseMapper;
      import com.example.entity.OrderEntity;
      public interface OrderMapper extends BaseMapper<OrderEntity> {}
    `);
    await writeFile(join(root, controllerPath), `
      package com.example.controller;
      public class OrderController {
        public void listOrders() {}
      }
    `);
    await writeFile(join(root, entityPath), `
      package com.example.entity;
      import com.baomidou.mybatisplus.annotation.TableName;
      @TableName("order_info")
      public class OrderEntity {}
    `);
    await writeFile(join(root, xmlPath), `
      <mapper namespace="com.example.mapper.OrderMapper">
        <select id="listOrders">SELECT * FROM order_info</select>
      </mapper>
    `);
    const workspace = await initWorkspace(root);
    const databasePath = createCodeGraphFixture(root);
    const db = new DatabaseSync(databasePath);
    const insertFile = db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insertFile.run(javaPath, 'java-mapper', 'java', 200, 1, 3, 1, null);
    insertFile.run(controllerPath, 'java-controller', 'java', 180, 1, 3, 2, null);
    insertFile.run(xmlPath, 'xml-mapper', 'xml', 160, 1, 3, 1, null);
    const insertNode = db.prepare(`
      INSERT INTO nodes (
        id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run(
      'n-order-mapper',
      'interface',
      'OrderMapper',
      'com.example.mapper::OrderMapper',
      javaPath,
      'java',
      4,
      4,
      0,
      1,
      3,
    );
    insertNode.run(
      'n-list-orders-java',
      'method',
      'listOrders',
      'com.example.mapper::OrderMapper::listOrders',
      javaPath,
      'java',
      4,
      4,
      0,
      1,
      3,
    );
    insertNode.run(
      'n-order-controller-list',
      'method',
      'listOrders',
      'com.example.controller::OrderController::listOrders',
      controllerPath,
      'java',
      3,
      3,
      0,
      1,
      3,
    );
    insertNode.run(
      'n-order-route',
      'route',
      'GET /orders',
      `${controllerPath}::route:/orders`,
      controllerPath,
      'java',
      3,
      3,
      0,
      1,
      3,
    );
    insertNode.run(
      'n-list-orders-xml',
      'method',
      'listOrders',
      'com.example.mapper.OrderMapper::listOrders',
      xmlPath,
      'xml',
      2,
      2,
      0,
      1,
      3,
    );
    const insertEdge = db.prepare(
      'INSERT INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertEdge.run('n-order-route', 'n-order-controller-list', 'references', '{}', 3, 0, 'static');
    insertEdge.run('n-order-controller-list', 'n-list-orders-java', 'calls', '{}', 3, 0, 'static');
    insertEdge.run('n-list-orders-java', 'n-list-orders-xml', 'calls', '{}', 4, 0, 'static');
    db.close();

    const snapshot = await loadCodeGraphSnapshot(workspace);

    expect(snapshot.nodes).toContainEqual(expect.objectContaining({
      id: 'table:root:order_info',
      kind: 'table',
      projectId: 'root',
    }));
    expect(snapshot.nodes.some(({ id }) => id.includes('dataflow:java-mybatis:root:sql:'))).toBe(false);
    expect(snapshot.nodes.some(({ id }) => id.includes('dataflow:java-mybatis:root:mapper:'))).toBe(false);
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      source: 'symbol:root:n-list-orders-xml',
      target: 'table:root:order_info',
      kind: 'READS_FROM',
      sourceName: 'java-mybatis',
    }));
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      source: 'symbol:root:n-order-mapper',
      target: 'table:root:order_info',
      kind: 'MAPS_TO',
      sourceName: 'java-mybatis',
    }));
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'symbol:root:n-order-route',
        target: 'symbol:root:n-order-controller-list',
        kind: 'ROUTES_TO',
      }),
      expect.objectContaining({
        source: 'symbol:root:n-order-controller-list',
        target: 'symbol:root:n-list-orders-java',
        kind: 'CALLS',
      }),
      expect.objectContaining({
        source: 'symbol:root:n-list-orders-java',
        target: 'symbol:root:n-list-orders-xml',
        kind: 'CALLS',
      }),
    ]));
    expect(snapshot.nodes.find(({ id }) => id === 'symbol:root:n-list-orders-xml')?.metadata)
      .toMatchObject({ dataFlowProviders: ['java-mybatis'] });
  });

  it('preserves provider diagnostics without making a compatible project unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-diagnostic-'));
    await mkdir(join(root, 'src/main/resources/mapper'), { recursive: true });
    await writeFile(join(root, 'src/main/resources/mapper/BrokenMapper.xml'), `
      <mapper>
        <select id="list">SELECT * FROM ignored_table</select>
      </mapper>
    `);
    const workspace = await initWorkspace(root);
    createCodeGraphFixture(root);

    const snapshot = await loadCodeGraphSnapshot(workspace);

    expect(snapshot.projects[0]).toMatchObject({ compatible: true, indexed: true });
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      providerId: 'java-mybatis',
      projectId: 'root',
      severity: 'warning',
      code: 'mybatis-namespace-missing',
      filePath: 'src/main/resources/mapper/BrokenMapper.xml',
    }));
  });

  it('isolates same-name data tables across projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-data-projects-'));
    const firstRoot = join(root, 'first');
    const secondRoot = join(root, 'second');
    await mkdir(join(firstRoot, 'src/main/resources'), { recursive: true });
    await mkdir(join(secondRoot, 'src/main/resources'), { recursive: true });
    await initWorkspace(root, { empty: true });
    await addWorkspaceProject(root, firstRoot, { name: 'First' });
    const second = await addWorkspaceProject(root, secondRoot, { name: 'Second' });
    createCodeGraphFixture(firstRoot);
    createCodeGraphFixture(secondRoot);
    const mapper = `
      <mapper namespace="com.example.SharedMapper">
        <select id="list">SELECT * FROM shared_table</select>
      </mapper>
    `;
    await writeFile(join(firstRoot, 'src/main/resources/SharedMapper.xml'), mapper);
    await writeFile(join(secondRoot, 'src/main/resources/SharedMapper.xml'), mapper);

    const snapshot = await loadCodeGraphSnapshot(second.workspace);

    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'table:first:shared_table' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'table:second:shared_table' }));
  });

  it('aggregates a large project without overflowing the JavaScript call stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeatlas-cg-large-'));
    const workspace = await initWorkspace(root);
    const databasePath = createCodeGraphFixture(root);
    const db = new DatabaseSync(databasePath);
    const insertNode = db.prepare(`
      INSERT INTO nodes (
        id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = db.prepare(
      'INSERT INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    for (let index = 0; index < 70_000; index += 1) {
      const nodeId = `bulk-${index}`;
      insertNode.run(
        nodeId,
        'function',
        nodeId,
        `bulk.${nodeId}`,
        'src/session.ts',
        'typescript',
        2,
        3,
        0,
        1,
        2,
      );
      insertEdge.run('n-auth', nodeId, 'calls', '{}', 7, 2, 'static');
    }
    db.exec('COMMIT');
    db.close();

    const snapshot = await loadCodeGraphSnapshot(workspace);

    expect(snapshot.nodes.length).toBeGreaterThan(70_000);
    expect(snapshot.edges.length).toBeGreaterThan(70_000);
  });
});
