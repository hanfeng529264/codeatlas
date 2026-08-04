import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createCodeGraphFixture(root: string): string {
  const databasePath = join(root, '.codegraph', 'codegraph.db');
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      node_count INTEGER DEFAULT 0,
      errors TEXT
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      language TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      docstring TEXT,
      signature TEXT,
      visibility TEXT,
      is_exported INTEGER DEFAULT 0,
      is_async INTEGER DEFAULT 0,
      is_static INTEGER DEFAULT 0,
      is_abstract INTEGER DEFAULT 0,
      decorators TEXT,
      type_parameters TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT,
      line INTEGER,
      col INTEGER,
      provenance TEXT DEFAULT NULL
    );
  `);
  const insertFile = db.prepare(
    'INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertFile.run('src/auth.ts', 'a', 'typescript', 200, 1, 2, 1, null);
  insertFile.run('src/session.ts', 'b', 'typescript', 160, 1, 2, 1, null);
  const insertNode = db.prepare(`
    INSERT INTO nodes (
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertNode.run('file:src/auth.ts', 'file', 'auth.ts', 'src/auth.ts', 'src/auth.ts', 'typescript', 1, 12, 0, 1, 2);
  insertNode.run('file:src/session.ts', 'file', 'session.ts', 'src/session.ts', 'src/session.ts', 'typescript', 1, 9, 0, 1, 2);
  insertNode.run('n-auth', 'function', 'login', 'auth.login', 'src/auth.ts', 'typescript', 3, 10, 0, 1, 2);
  insertNode.run('n-session', 'function', 'createSession', 'session.createSession', 'src/session.ts', 'typescript', 2, 7, 0, 1, 2);
  db.prepare(
    'INSERT INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('file:src/auth.ts', 'n-auth', 'contains', '{}', 3, 0, 'static');
  db.prepare(
    'INSERT INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('file:src/session.ts', 'n-session', 'contains', '{}', 2, 0, 'static');
  db.prepare(
    'INSERT INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('n-auth', 'n-session', 'calls', '{"receiver":"session"}', 7, 2, 'static');
  db.close();
  return databasePath;
}
