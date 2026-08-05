export type SqlOperation = 'select' | 'insert' | 'update' | 'delete';
export type TableAccess = 'read' | 'write';

export interface SqlTableFact {
  tableName: string;
  operation: SqlOperation;
  access: TableAccess;
  line: number;
}

const IDENTIFIER_PART = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
const QUALIFIED_IDENTIFIER = `${IDENTIFIER_PART}(?:\\s*\\.\\s*${IDENTIFIER_PART})?`;

function maskSqlNoise(sql: string): string {
  const characters = [...sql];
  let state: 'code' | 'string' | 'line-comment' | 'block-comment' | 'dynamic' = 'code';
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index];
    const next = characters[index + 1];
    if (state === 'code') {
      if (current === "'") {
        characters[index] = ' ';
        state = 'string';
      } else if (current === '-' && next === '-') {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        index += 1;
        state = 'line-comment';
      } else if (current === '/' && next === '*') {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        index += 1;
        state = 'block-comment';
      } else if (current === '$' && next === '{') {
        characters[index] = '$';
        characters[index + 1] = ' ';
        index += 1;
        state = 'dynamic';
      }
      continue;
    }
    if (state === 'string') {
      if (current === "'" && next === "'") {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        index += 1;
      } else if (current === "'") {
        characters[index] = ' ';
        state = 'code';
      } else if (current !== '\n') {
        characters[index] = ' ';
      }
    } else if (state === 'line-comment') {
      if (current === '\n') state = 'code';
      else characters[index] = ' ';
    } else if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n') {
        characters[index] = ' ';
      }
    } else if (state === 'dynamic') {
      if (current === '}') state = 'code';
      if (current !== '\n') characters[index] = ' ';
    }
  }
  return characters.join('');
}

function normalizeTableName(value: string): string {
  return value
    .split(/\s*\.\s*/)
    .map((part) => part.replace(/^([`"\[])|([`"\]])$/g, ''))
    .join('.')
    .toLocaleLowerCase();
}

function sourceLine(sql: string, offset: number, startLine: number): number {
  let line = startLine;
  for (let index = 0; index < offset; index += 1) {
    if (sql[index] === '\n') line += 1;
  }
  return line;
}

function operationFor(sql: string): SqlOperation {
  const match = /\b(select|insert|update|delete)\b/i.exec(sql);
  return (match?.[1].toLocaleLowerCase() as SqlOperation | undefined) ?? 'select';
}

export function extractSqlTableFacts(sql: string, startLine = 1): SqlTableFact[] {
  const masked = maskSqlNoise(sql);
  const operation = operationFor(masked);
  const facts: SqlTableFact[] = [];
  const seen = new Set<string>();
  const writeTargets = new Set<string>();

  const addFact = (rawName: string, access: TableAccess, offset: number): void => {
    const tableName = normalizeTableName(rawName);
    if (!tableName) return;
    const key = `${access}\0${tableName}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (access === 'write') writeTargets.add(tableName);
    facts.push({ tableName, operation, access, line: sourceLine(masked, offset, startLine) });
  };

  const writePattern = operation === 'insert'
    ? new RegExp(`\\binsert\\s+(?:ignore\\s+)?into\\s+(${QUALIFIED_IDENTIFIER})`, 'gi')
    : operation === 'update'
      ? new RegExp(`\\bupdate\\s+(${QUALIFIED_IDENTIFIER})`, 'gi')
      : operation === 'delete'
        ? new RegExp(`\\bdelete\\s+from\\s+(${QUALIFIED_IDENTIFIER})`, 'gi')
        : null;
  if (writePattern) {
    for (const match of masked.matchAll(writePattern)) {
      addFact(match[1], 'write', match.index ?? 0);
    }
  }

  const readPattern = new RegExp(`\\b(?:from|join)\\s+(?!\\()(${QUALIFIED_IDENTIFIER})`, 'gi');
  for (const match of masked.matchAll(readPattern)) {
    const tableName = normalizeTableName(match[1]);
    if (operation === 'delete' && writeTargets.has(tableName)) continue;
    addFact(match[1], 'read', match.index ?? 0);
  }

  return facts;
}
