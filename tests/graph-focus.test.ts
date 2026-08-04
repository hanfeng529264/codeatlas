import { describe, expect, it } from 'vitest';
import { edgeIsOutsideSelection, nodeIsOutsideSelection } from '../web/graph/focus.js';

describe('selected graph isolation', () => {
  it('keeps incoming and outgoing edges connected to the selected node', () => {
    expect(edgeIsOutsideSelection('current', 'caller', 'current')).toBe(false);
    expect(edgeIsOutsideSelection('current', 'current', 'callee')).toBe(false);
  });

  it('hides unrelated edges only while a node is selected', () => {
    expect(edgeIsOutsideSelection('current', 'other-a', 'other-b')).toBe(true);
    expect(edgeIsOutsideSelection(null, 'other-a', 'other-b')).toBe(false);
  });

  it('keeps the selected node and its neighbors while hiding unrelated nodes', () => {
    expect(nodeIsOutsideSelection('current', 'current', false)).toBe(false);
    expect(nodeIsOutsideSelection('current', 'caller', true)).toBe(false);
    expect(nodeIsOutsideSelection('current', 'unrelated', false)).toBe(true);
    expect(nodeIsOutsideSelection(null, 'unrelated', false)).toBe(false);
  });
});
