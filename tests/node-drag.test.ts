import { describe, expect, it } from 'vitest';
import { NodeDragController } from '../web/graph/drag.js';

describe('node drag controller', () => {
  it('keeps a short pointer movement as a normal click', () => {
    const drag = new NodeDragController(4);
    drag.begin('node-a', { x: 10, y: 10 });

    expect(drag.move({ x: 12, y: 12 })).toBeNull();
    expect(drag.end()).toBe(false);
    expect(drag.consumeSuppressedClick()).toBe(false);
  });

  it('starts dragging after the movement threshold is reached', () => {
    const drag = new NodeDragController(4);
    drag.begin('node-a', { x: 10, y: 10 });

    expect(drag.move({ x: 14, y: 10 })).toBe('node-a');
    expect(drag.move({ x: 30, y: 40 })).toBe('node-a');
    expect(drag.end()).toBe(true);
  });

  it('suppresses only the click immediately following a drag', () => {
    const drag = new NodeDragController();
    drag.begin('node-a', { x: 0, y: 0 });
    drag.move({ x: 8, y: 0 });
    drag.end();

    expect(drag.consumeSuppressedClick()).toBe(true);
    expect(drag.consumeSuppressedClick()).toBe(false);
  });

  it('resets cleanly for the next node interaction', () => {
    const drag = new NodeDragController();
    drag.begin('node-a', { x: 0, y: 0 });
    drag.move({ x: 8, y: 0 });
    drag.end();
    drag.clearSuppressedClick();
    drag.begin('node-b', { x: 5, y: 5 });

    expect(drag.move({ x: 6, y: 6 })).toBeNull();
    expect(drag.end()).toBe(false);
  });
});
