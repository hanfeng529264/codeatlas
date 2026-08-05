import { describe, expect, it } from 'vitest';
import { extractSqlTableFacts } from '../src/adapters/java-data-flow.js';

describe('SQL table fact extraction', () => {
  it('extracts SELECT sources and JOIN targets with source lines', () => {
    const facts = extractSqlTableFacts(`
      SELECT o.id, u.name
      FROM order_info o
      LEFT JOIN user_profile u ON u.id = o.user_id
      JOIN \`catalog\`.\`course\` c ON c.id = o.course_id
    `, 20);

    expect(facts).toEqual([
      { tableName: 'order_info', operation: 'select', access: 'read', line: 22 },
      { tableName: 'user_profile', operation: 'select', access: 'read', line: 23 },
      { tableName: 'catalog.course', operation: 'select', access: 'read', line: 24 },
    ]);
  });

  it('distinguishes INSERT, UPDATE, and DELETE write targets', () => {
    expect(extractSqlTableFacts('INSERT INTO audit_log (id) SELECT id FROM order_info')).toEqual([
      { tableName: 'audit_log', operation: 'insert', access: 'write', line: 1 },
      { tableName: 'order_info', operation: 'insert', access: 'read', line: 1 },
    ]);
    expect(extractSqlTableFacts('UPDATE order_info SET status = 2 WHERE id = 1')).toEqual([
      { tableName: 'order_info', operation: 'update', access: 'write', line: 1 },
    ]);
    expect(extractSqlTableFacts('DELETE FROM order_info WHERE id = 1')).toEqual([
      { tableName: 'order_info', operation: 'delete', access: 'write', line: 1 },
    ]);
  });

  it('normalizes quoted and schema-qualified table names', () => {
    const facts = extractSqlTableFacts('SELECT * FROM "Reporting"."Daily_Order"');

    expect(facts).toEqual([
      { tableName: 'reporting.daily_order', operation: 'select', access: 'read', line: 1 },
    ]);
  });

  it('ignores comments, subqueries, and runtime table substitutions', () => {
    const facts = extractSqlTableFacts(`
      -- FROM ignored_comment
      SELECT *
      FROM (SELECT id FROM nested_source) nested
      JOIN \${dynamic_table} d ON d.id = nested.id
      /* JOIN ignored_block ON 1 = 1 */
    `);

    expect(facts).toEqual([
      { tableName: 'nested_source', operation: 'select', access: 'read', line: 4 },
    ]);
  });

  it('deduplicates repeated access to the same table', () => {
    const facts = extractSqlTableFacts('SELECT * FROM order_info o JOIN order_info parent ON parent.id = o.parent_id');

    expect(facts).toEqual([
      { tableName: 'order_info', operation: 'select', access: 'read', line: 1 },
    ]);
  });
});
