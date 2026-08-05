export interface DragPoint {
  x: number;
  y: number;
}

interface ActiveDrag {
  nodeId: string;
  start: DragPoint;
  moved: boolean;
}

export class NodeDragController {
  private active: ActiveDrag | null = null;
  private suppressClick = false;

  constructor(private readonly threshold = 4) {}

  begin(nodeId: string, point: DragPoint): void {
    this.active = { nodeId, start: point, moved: false };
    this.suppressClick = false;
  }

  move(point: DragPoint): string | null {
    if (!this.active) return null;
    if (!this.active.moved) {
      const deltaX = point.x - this.active.start.x;
      const deltaY = point.y - this.active.start.y;
      this.active.moved = deltaX * deltaX + deltaY * deltaY >= this.threshold * this.threshold;
    }
    return this.active.moved ? this.active.nodeId : null;
  }

  end(): boolean {
    const moved = this.active?.moved ?? false;
    this.active = null;
    this.suppressClick = moved;
    return moved;
  }

  consumeSuppressedClick(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  clearSuppressedClick(): void {
    this.suppressClick = false;
  }
}
