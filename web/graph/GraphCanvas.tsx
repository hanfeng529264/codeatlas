import { useEffect, useRef } from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import Sigma from 'sigma';
import type { Attributes } from 'graphology-types';
import type { AtlasNode, GraphProjection } from '../types';

interface GraphCanvasProps {
  graphData: GraphProjection;
  selectedId: string | null;
  onSelect: (node: AtlasNode | null) => void;
}

const NODE_COLORS: Record<string, string> = {
  workspace: '#f2b84b',
  project: '#f0d58a',
  module: '#e98a4a',
  directory: '#647d76',
  file: '#8db2a5',
  class: '#5dc9c1',
  interface: '#7fa7ff',
  function: '#e7e0c6',
  method: '#f4f0dc',
  field: '#b9a0d6',
  variable: '#9c8cad',
  route: '#ff8066',
};

const NODE_SIZES: Record<string, number> = {
  workspace: 20,
  project: 15,
  module: 11,
  directory: 7,
  file: 6,
  class: 8,
  interface: 8,
  function: 5,
  method: 4.5,
};

function hash(value: string): number {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

function buildGraph(data: GraphProjection): Graph<Attributes, Attributes, Attributes> {
  const graph = new Graph({ type: 'directed', multi: true, allowSelfLoops: true });
  const kindGroups = new Map<string, AtlasNode[]>();
  for (const node of data.nodes) {
    const group = kindGroups.get(node.kind) ?? [];
    group.push(node);
    kindGroups.set(node.kind, group);
  }
  const kinds = [...kindGroups.keys()].sort();
  for (const node of data.nodes) {
    const group = kindGroups.get(node.kind) ?? [node];
    const index = group.findIndex((candidate) => candidate.id === node.id);
    const kindIndex = Math.max(0, kinds.indexOf(node.kind));
    const angle = (index / Math.max(1, group.length)) * Math.PI * 2 + (hash(node.id) % 17) / 17;
    const radius = 15 + kindIndex * 21 + Math.sqrt(index) * 4;
    graph.addNode(node.id, {
      label: node.label,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: NODE_SIZES[node.kind] ?? 4,
      color: NODE_COLORS[node.kind] ?? '#a9b8b2',
      kind: node.kind,
      node,
      zIndex: NODE_SIZES[node.kind] ?? 4,
    });
  }
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
      label: edge.kind,
      kind: edge.kind,
      color:
        edge.evidenceClass === 'heuristic'
          ? '#806a3b'
          : edge.kind === 'CALLS'
            ? '#587d75'
            : '#30443f',
      size: edge.evidenceClass === 'heuristic' ? 0.45 : edge.kind === 'CALLS' ? 1.25 : 0.65,
      edge,
    });
  }
  if (graph.order > 2 && graph.order < 2_000 && graph.size > 0) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      iterations: Math.min(90, 22 + Math.ceil(Math.sqrt(graph.order))),
      settings: { ...settings, gravity: 0.08, scalingRatio: 12, slowDown: 3 },
    });
  }
  return graph;
}

export function GraphCanvas({ graphData, selectedId, onSelect }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  const hoveredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const graph = buildGraph(graphData);
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: false,
      defaultNodeColor: '#9cb2ab',
      defaultEdgeColor: '#314943',
      labelColor: { color: '#d7e1dc' },
      labelFont: 'Avenir Next Condensed, DIN Alternate, sans-serif',
      labelSize: 12,
      labelWeight: '500',
      labelDensity: 0.08,
      labelGridCellSize: 110,
      labelRenderedSizeThreshold: 7,
      renderEdgeLabels: false,
      hideEdgesOnMove: graph.size > 25_000,
      minCameraRatio: 0.02,
      maxCameraRatio: 8,
      zIndex: true,
      nodeReducer: (node, attributes) => {
        const selected = selectedRef.current;
        const hovered = hoveredRef.current;
        if (!selected && !hovered) return attributes;
        if (node === selected || node === hovered) {
          return {
            ...attributes,
            highlighted: true,
            size: Number(attributes.size) * 1.8,
            color: '#ffd166',
            zIndex: 100,
          };
        }
        const focus = selected ?? hovered;
        if (focus && (graph.hasEdge(node, focus) || graph.hasEdge(focus, node))) {
          return { ...attributes, highlighted: true, zIndex: 50 };
        }
        return { ...attributes, color: '#263632', label: '', zIndex: 0 };
      },
      edgeReducer: (edge, attributes) => {
        const focus = selectedRef.current ?? hoveredRef.current;
        if (!focus) return attributes;
        const [source, target] = graph.extremities(edge);
        return source === focus || target === focus
          ? { ...attributes, color: '#d89b3c', size: 2.2, zIndex: 50 }
          : { ...attributes, color: '#182522', hidden: false, zIndex: 0 };
      },
    });
    renderer.on('clickNode', ({ node }) => {
      const attributes = graph.getNodeAttributes(node);
      onSelect(attributes.node as AtlasNode);
    });
    renderer.on('clickStage', () => onSelect(null));
    renderer.on('enterNode', ({ node }) => {
      hoveredRef.current = node;
      renderer.getContainer().style.cursor = 'crosshair';
      renderer.refresh();
    });
    renderer.on('leaveNode', () => {
      hoveredRef.current = null;
      renderer.getContainer().style.cursor = 'grab';
      renderer.refresh();
    });
    rendererRef.current = renderer;
    return () => {
      renderer.kill();
      rendererRef.current = null;
    };
  }, [graphData, onSelect]);

  useEffect(() => {
    selectedRef.current = selectedId;
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.refresh();
    if (selectedId) {
      const data = renderer.getNodeDisplayData(selectedId);
      if (data) void renderer.getCamera().animate({ x: data.x, y: data.y, ratio: 0.22 }, { duration: 420 });
    }
  }, [selectedId]);

  return <div className="graph-canvas" ref={containerRef} aria-label="Interactive workspace graph" />;
}
