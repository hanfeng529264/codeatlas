import type { CSSProperties } from 'react';
import type { AtlasNode } from '../types';

interface NodeHoverCardProps {
  node: AtlasNode;
  x: number;
  y: number;
}

function metadataString(node: AtlasNode, key: string): string | undefined {
  const value = node.metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parametersFromSignature(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  const start = signature.indexOf('(');
  const end = signature.lastIndexOf(')');
  if (start < 0 || end <= start) return undefined;
  const parameters = signature.slice(start + 1, end).trim();
  return parameters || '无参数';
}

export function ownerFromQualifiedName(node: AtlasNode): string | undefined {
  if (!node.qualifiedName) return undefined;
  if (node.qualifiedName.includes('::')) {
    const scopes = node.qualifiedName.split('::').filter(Boolean);
    if (scopes.at(-1) === node.label) scopes.pop();
    const owner = scopes.at(-1);
    if (!owner || owner.includes('/') || /\.[a-z0-9]+$/i.test(owner)) return undefined;
    return owner;
  }
  const segments = node.qualifiedName.split(/[.#]/).filter(Boolean);
  const nodeIndex = segments.lastIndexOf(node.label);
  const owner = segments[(nodeIndex >= 0 ? nodeIndex : segments.length) - 1];
  if (!owner || owner.includes('/') || /\.[a-z0-9]+$/i.test(owner)) return undefined;
  return owner;
}

export function NodeHoverCard({ node, x, y }: NodeHoverCardProps) {
  const signature = metadataString(node, 'signature');
  const parameters = parametersFromSignature(signature);
  const visibility = metadataString(node, 'visibility') ?? '未标记';
  const docstring = metadataString(node, 'docstring') ?? '暂无注释';
  const owner = ownerFromQualifiedName(node) ?? '顶层 / 未识别';
  const visibilityClass = ['public', 'private', 'protected', 'internal'].includes(visibility.toLowerCase())
    ? ` visibility-${visibility.toLowerCase()}`
    : '';

  return (
    <aside
      className="node-hover-card"
      role="tooltip"
      aria-label={`${node.label} 节点详情`}
      style={{ '--hover-x': `${x}px`, '--hover-y': `${y}px` } as CSSProperties}
    >
      <div className="hover-card-heading">
        <span>{node.kind}</span>
        <strong>{node.label}</strong>
        <em className={visibilityClass}>{visibility}</em>
      </div>

      <dl className="hover-card-facts">
        <div><dt>OWNER</dt><dd>{owner}</dd></div>
        <div><dt>QUALIFIED</dt><dd>{node.qualifiedName ?? '—'}</dd></div>
      </dl>

      {signature && (
        <section className="hover-card-code">
          <span>SIGNATURE</span>
          <code>{signature}</code>
        </section>
      )}

      {parameters && (
        <section className="hover-card-parameters">
          <span>PARAMETERS</span>
          <p>{parameters}</p>
        </section>
      )}

      <section className="hover-card-note">
        <span>NOTE</span>
        <p>{docstring}</p>
      </section>

      <footer>
        <span>{node.filePath ?? 'NO SOURCE FILE'}{node.startLine ? `:${node.startLine}` : ''}</span>
        <b>{node.source} · {Math.round(node.confidence * 100)}%</b>
      </footer>
    </aside>
  );
}
