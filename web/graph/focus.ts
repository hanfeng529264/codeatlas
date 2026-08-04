export function edgeIsOutsideSelection(
  selectedId: string | null,
  source: string,
  target: string,
): boolean {
  return Boolean(selectedId) && source !== selectedId && target !== selectedId;
}

export function nodeIsOutsideSelection(
  selectedId: string | null,
  nodeId: string,
  isNeighbor: boolean,
): boolean {
  return Boolean(selectedId) && nodeId !== selectedId && !isNeighbor;
}
