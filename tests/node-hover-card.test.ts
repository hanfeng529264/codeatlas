import { describe, expect, it } from 'vitest';
import { ownerFromQualifiedName, parametersFromSignature } from '../web/graph/NodeHoverCard.js';
import type { AtlasNode } from '../web/types.js';

function node(overrides: Partial<AtlasNode> = {}): AtlasNode {
  return {
    id: 'method:save',
    kind: 'method',
    label: 'save',
    qualifiedName: 'com.example.UserService.save',
    source: 'codegraph',
    evidenceClass: 'static-derived',
    confidence: 1,
    metadata: {},
    ...overrides,
  };
}

describe('node hover details', () => {
  it('extracts the owning class from a qualified method name', () => {
    expect(ownerFromQualifiedName(node())).toBe('UserService');
  });

  it('does not present a source file as an owning class', () => {
    expect(ownerFromQualifiedName(node({
      label: 'loadGraph',
      qualifiedName: 'src/graph.ts::loadGraph',
    }))).toBeUndefined();
  });

  it('extracts parameters and represents an empty parameter list', () => {
    expect(parametersFromSignature('(userId: string, force = false): Promise<void>')).toBe(
      'userId: string, force = false',
    );
    expect(parametersFromSignature('(): void')).toBe('无参数');
  });
});
