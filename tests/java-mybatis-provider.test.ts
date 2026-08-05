import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataFlowProjectContext } from '../src/data-flow/provider.js';
import { javaMyBatisProvider } from '../src/data-flow/providers/java-mybatis.js';

async function fixtureContext(): Promise<DataFlowProjectContext> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'codeatlas-mybatis-'));
  return {
    workspaceRoot: projectRoot,
    projectRoot,
    project: { id: 'orders', name: 'Orders', path: '.' },
  };
}

async function fixtureFile(root: string, path: string, content: string): Promise<void> {
  const filePath = join(root, path);
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, content);
}

describe('java-mybatis data-flow provider', () => {
  it('detects source artifacts but ignores generated build directories', async () => {
    const context = await fixtureContext();
    await fixtureFile(context.projectRoot, 'target/classes/mapper/GeneratedMapper.xml', `
      <mapper namespace="com.example.GeneratedMapper">
        <select id="list">SELECT * FROM generated_table</select>
      </mapper>
    `);

    await expect(javaMyBatisProvider.supports(context)).resolves.toBe(false);

    await fixtureFile(context.projectRoot, 'src/main/resources/mapper/OrderMapper.xml', `
      <mapper namespace="com.example.OrderMapper">
        <select id="list">SELECT * FROM order_info</select>
      </mapper>
    `);

    await expect(javaMyBatisProvider.supports(context)).resolves.toBe(true);
  });

  it('extracts directional table access from MyBatis XML statements', async () => {
    const context = await fixtureContext();
    await fixtureFile(context.projectRoot, 'src/main/resources/mapper/OrderMapper.xml', `
      <?xml version="1.0" encoding="UTF-8"?>
      <mapper namespace="com.example.OrderMapper">
        <select id="listOrders">
          SELECT o.id FROM order_info o
          JOIN user_profile u ON u.id = o.user_id
        </select>
        <insert id="archiveOrders">
          INSERT INTO order_archive (id) SELECT id FROM order_info
        </insert>
        <update id="closeOrder">UPDATE order_info SET status = 2 WHERE id = #{id}</update>
        <delete id="deleteArchive">DELETE FROM order_archive WHERE id = #{id}</delete>
        <select id="dynamicTable">SELECT * FROM \${runtime_table}</select>
      </mapper>
    `);

    const overlay = await javaMyBatisProvider.extract(context);

    expect(overlay.diagnostics).toEqual([]);
    expect(overlay.nodes.filter(({ kind }) => kind === 'sql')).toHaveLength(5);
    expect(overlay.nodes.filter(({ kind }) => kind === 'table').map(({ label }) => label).sort())
      .toEqual(['order_archive', 'order_info', 'user_profile']);
    expect(overlay.edges.map(({ kind, source, target }) => ({ kind, source, target })))
      .toEqual(expect.arrayContaining([
        {
          kind: 'READS_FROM',
          source: 'dataflow:java-mybatis:orders:sql:com.example.OrderMapper#listOrders',
          target: 'table:orders:order_info',
        },
        {
          kind: 'READS_FROM',
          source: 'dataflow:java-mybatis:orders:sql:com.example.OrderMapper#listOrders',
          target: 'table:orders:user_profile',
        },
        {
          kind: 'WRITES_TO',
          source: 'dataflow:java-mybatis:orders:sql:com.example.OrderMapper#archiveOrders',
          target: 'table:orders:order_archive',
        },
        {
          kind: 'READS_FROM',
          source: 'dataflow:java-mybatis:orders:sql:com.example.OrderMapper#archiveOrders',
          target: 'table:orders:order_info',
        },
        {
          kind: 'WRITES_TO',
          source: 'dataflow:java-mybatis:orders:sql:com.example.OrderMapper#closeOrder',
          target: 'table:orders:order_info',
        },
        {
          kind: 'WRITES_TO',
          source: 'dataflow:java-mybatis:orders:sql:com.example.OrderMapper#deleteArchive',
          target: 'table:orders:order_archive',
        },
      ]));
    expect(overlay.edges.some(({ source }) => source.endsWith('#dynamicTable'))).toBe(false);
    expect(overlay.nodes.find(({ id }) => id.endsWith('#listOrders'))).toMatchObject({
      qualifiedName: 'com.example.OrderMapper#listOrders',
      filePath: 'src/main/resources/mapper/OrderMapper.xml',
      language: 'xml',
      evidenceClass: 'static-derived',
      metadata: { providerId: 'java-mybatis', statementId: 'listOrders', operation: 'select' },
    });
  });

  it('maps MyBatis-Plus BaseMapper entities to explicit and inferred tables', async () => {
    const context = await fixtureContext();
    await fixtureFile(context.projectRoot, 'src/main/java/com/example/entity/OrderEntity.java', `
      package com.example.entity;
      import com.baomidou.mybatisplus.annotation.TableName;
      @TableName(value = "t_order")
      public class OrderEntity {}
    `);
    await fixtureFile(context.projectRoot, 'src/main/java/com/example/mapper/OrderMapper.java', `
      package com.example.mapper;
      import com.baomidou.mybatisplus.core.mapper.BaseMapper;
      import com.example.entity.OrderEntity;
      public interface OrderMapper extends BaseMapper<OrderEntity> {}
    `);
    await fixtureFile(context.projectRoot, 'src/main/java/com/example/entity/AuditEvent.java', `
      package com.example.entity;
      public class AuditEvent {}
    `);
    await fixtureFile(context.projectRoot, 'src/main/java/com/example/mapper/AuditMapper.java', `
      package com.example.mapper;
      import com.baomidou.mybatisplus.core.mapper.BaseMapper;
      import com.example.entity.AuditEvent;
      public interface AuditMapper extends BaseMapper<AuditEvent> {}
    `);

    const overlay = await javaMyBatisProvider.extract(context);
    const mappingEdges = overlay.edges.filter(({ kind }) => kind === 'MAPS_TO');

    expect(mappingEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'dataflow:java-mybatis:orders:mapper:com.example.mapper.OrderMapper',
        target: 'table:orders:t_order',
        evidenceClass: 'static-derived',
        confidence: 1,
        metadata: expect.objectContaining({ entityQualifiedName: 'com.example.entity.OrderEntity' }),
      }),
      expect.objectContaining({
        source: 'dataflow:java-mybatis:orders:mapper:com.example.mapper.AuditMapper',
        target: 'table:orders:audit_event',
        evidenceClass: 'heuristic',
        confidence: 0.65,
        metadata: expect.objectContaining({ entityQualifiedName: 'com.example.entity.AuditEvent' }),
      }),
    ]));
    expect(overlay.nodes.find(({ id }) => id.endsWith('mapper:com.example.mapper.OrderMapper')))
      .toMatchObject({
        kind: 'interface',
        qualifiedName: 'com.example.mapper.OrderMapper',
        language: 'java',
      });
  });

  it('does not fail the whole project when one candidate file cannot be parsed', async () => {
    const context = await fixtureContext();
    await fixtureFile(context.projectRoot, 'src/main/resources/mapper/BrokenMapper.xml', `
      <mapper>
        <select id="broken">SELECT * FROM ignored_without_namespace</select>
      </mapper>
    `);
    await fixtureFile(context.projectRoot, 'src/main/resources/mapper/HealthyMapper.xml', `
      <mapper namespace="com.example.HealthyMapper">
        <select id="healthy">SELECT * FROM healthy_table</select>
      </mapper>
    `);

    const overlay = await javaMyBatisProvider.extract(context);

    expect(overlay.nodes).toContainEqual(expect.objectContaining({ id: 'table:orders:healthy_table' }));
    expect(overlay.diagnostics).toContainEqual(expect.objectContaining({
      providerId: 'java-mybatis',
      severity: 'warning',
      code: 'mybatis-namespace-missing',
      filePath: 'src/main/resources/mapper/BrokenMapper.xml',
    }));
  });
});
