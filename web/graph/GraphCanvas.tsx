import { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import Sigma from 'sigma';
import type { Attributes } from 'graphology-types';
import type { AtlasNode, GraphProjection, ViewId } from '../types';
import { NodeDragController } from './drag';
import { edgeIsOutsideSelection, nodeIsOutsideSelection } from './focus';
import { NodeHoverCard } from './NodeHoverCard';

interface GraphCanvasProps {
  graphData: GraphProjection;
  view: ViewId;
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
  sql: '#e98a4a',
  table: '#b7d866',
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
  sql: 6,
  table: 9,
};

const DEFAULT_LABEL_COLOR = '#d7e1dc';
const HIGHLIGHT_LABEL_COLOR = '#17211e';
const INBOUND_EDGE_COLOR = '#5dc9c1';
const OUTBOUND_EDGE_COLOR = '#f2b84b';
const CALL_RELATIONS = new Set(['CALLS', 'ROUTES_TO', 'PUBLISHES', 'SUBSCRIBES']);
const FLOW_RELATIONS = new Set([
  ...CALL_RELATIONS,
  'CALLS_API',
  'MAPS_TO',
  'PUBLISHES_TO',
  'READS_FROM',
  'SUBSCRIBES_TO',
  'WRITES_TO',
]);
const EDGE_COLORS: Record<string, string> = {
  CALLS: '#587d75',
  ROUTES_TO: '#e98a4a',
  READS_FROM: '#5dc9c1',
  WRITES_TO: '#ff8066',
  MAPS_TO: '#b9a0d6',
  CALLS_API: '#7fa7ff',
  PUBLISHES_TO: '#f2b84b',
  SUBSCRIBES_TO: '#8db2a5',
};
const PROJECT_COLORS = ['#f2b84b', '#5dc9c1', '#7fa7ff', '#e98a4a', '#b9a0d6', '#ff8066'];

interface HoverCardState {
  node: AtlasNode;
  x: number;
  y: number;
}

function hash(value: string): number {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

function colorForNode(node: AtlasNode): string {
  if (node.kind === 'project' && node.projectId) {
    return PROJECT_COLORS[hash(node.projectId) % PROJECT_COLORS.length];
  }
  return NODE_COLORS[node.kind] ?? '#a9b8b2';
}

export function colorForEdge(kind: string, evidenceClass: string): string {
  if (evidenceClass === 'heuristic') return '#806a3b';
  return EDGE_COLORS[kind] ?? '#30443f';
}

function buildGraph(data: GraphProjection): Graph<Attributes, Attributes, Attributes> {
  const graph = new Graph({ type: 'directed', multi: true, allowSelfLoops: true });
  const layoutGroups = new Map<string, AtlasNode[]>();
  for (const node of data.nodes) {
    const groupKey = data.projection.overview ? (node.projectId ?? '__workspace__') : node.kind;
    const group = layoutGroups.get(groupKey) ?? [];
    group.push(node);
    layoutGroups.set(groupKey, group);
  }
  const groupKeys = [...layoutGroups.keys()].sort((left, right) => {
    if (left === '__workspace__') return -1;
    if (right === '__workspace__') return 1;
    return left.localeCompare(right);
  });
  const nodeIndexes = new Map<string, number>();
  for (const group of layoutGroups.values()) {
    group.forEach((node, index) => nodeIndexes.set(node.id, index));
  }
  for (const node of data.nodes) {
    const groupKey = data.projection.overview ? (node.projectId ?? '__workspace__') : node.kind;
    const group = layoutGroups.get(groupKey) ?? [node];
    const index = nodeIndexes.get(node.id) ?? 0;
    const groupIndex = Math.max(0, groupKeys.indexOf(groupKey));
    let x: number;
    let y: number;
    if (data.projection.overview) {
      const projectGroups = Math.max(1, groupKeys.length - (groupKeys[0] === '__workspace__' ? 1 : 0));
      const projectIndex = groupKey === '__workspace__' ? 0 : groupIndex - (groupKeys[0] === '__workspace__' ? 1 : 0);
      const clusterAngle = (projectIndex / projectGroups) * Math.PI * 2 - Math.PI / 2;
      const centerRadius = groupKey === '__workspace__' ? 0 : 230;
      const centerX = Math.cos(clusterAngle) * centerRadius;
      const centerY = Math.sin(clusterAngle) * centerRadius;
      if (node.kind === 'workspace' || node.kind === 'project') {
        x = centerX;
        y = centerY;
      } else {
        const localAngle = index * 2.399963229728653 + (hash(node.id) % 13) / 13;
        const localRadius = 10 + Math.sqrt(index) * 4.2;
        x = centerX + Math.cos(localAngle) * localRadius;
        y = centerY + Math.sin(localAngle) * localRadius;
      }
    } else {
      const angle = (index / Math.max(1, group.length)) * Math.PI * 2 + (hash(node.id) % 17) / 17;
      const radius = 15 + groupIndex * 21 + Math.sqrt(index) * 4;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
    }
    graph.addNode(node.id, {
      label: node.label,
      x,
      y,
      size: NODE_SIZES[node.kind] ?? 4,
      color: colorForNode(node),
      labelColor: DEFAULT_LABEL_COLOR,
      forceLabel: node.kind === 'workspace' || node.kind === 'project' || node.kind === 'table',
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
      type: edge.kind === 'CONTAINS' ? 'line' : 'arrow',
      color: colorForEdge(edge.kind, edge.evidenceClass),
      size: edge.evidenceClass === 'heuristic'
        ? 0.45
        : ['READS_FROM', 'WRITES_TO', 'MAPS_TO'].includes(edge.kind)
          ? 1.8
          : edge.kind === 'CALLS'
            ? 1.25
            : 0.65,
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

export function GraphCanvas({ graphData, view, selectedId, onSelect }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  const hoveredRef = useRef<string | null>(null);
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const graph = buildGraph(graphData);
    const drag = new NodeDragController();
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: false,
      defaultNodeColor: '#9cb2ab',
      defaultEdgeColor: '#314943',
      labelColor: { attribute: 'labelColor', color: DEFAULT_LABEL_COLOR },
      labelFont: 'Avenir Next Condensed, DIN Alternate, sans-serif',
      labelSize: 12,
      labelWeight: '500',
      labelDensity: 0.08,
      labelGridCellSize: 110,
      labelRenderedSizeThreshold: 7,
      renderEdgeLabels: true,
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
            labelColor: HIGHLIGHT_LABEL_COLOR,
            zIndex: 100,
          };
        }
        const focus = selected ?? hovered;
        const isNeighbor = Boolean(focus && (graph.hasEdge(node, focus) || graph.hasEdge(focus, node)));
        if (isNeighbor) {
          return {
            ...attributes,
            highlighted: true,
            labelColor: HIGHLIGHT_LABEL_COLOR,
            zIndex: 50,
          };
        }
        if (nodeIsOutsideSelection(selected, node, isNeighbor)) {
          return { ...attributes, hidden: true, label: '', zIndex: 0 };
        }
        return { ...attributes, color: '#263632', label: '', zIndex: 0 };
      },
      edgeReducer: (edge, attributes) => {
        const selected = selectedRef.current;
        const focus = selected ?? hoveredRef.current;
        if (!focus) return { ...attributes, label: '' };
        const [source, target] = graph.extremities(edge);
        const inbound = target === focus;
        const outbound = source === focus;
        if (inbound || outbound) {
          const relation = String(attributes.kind);
          const directionEdges = inbound ? graph.inEdges(focus) : graph.outEdges(focus);
          const labelEdge = directionEdges.find(
            (candidate) => String(graph.getEdgeAttribute(candidate, 'kind')) === relation,
          );
          const showRelationLabel = FLOW_RELATIONS.has(relation) && edge === labelEdge;
          return {
            ...attributes,
            type: 'arrow',
            label: showRelationLabel ? `${relation} · ${inbound ? 'IN' : 'OUT'}` : '',
            forceLabel: showRelationLabel,
            color: EDGE_COLORS[relation] ?? (inbound ? INBOUND_EDGE_COLOR : OUTBOUND_EDGE_COLOR),
            size: selected ? 3.2 : 2.4,
            zIndex: 100,
          };
        }
        return {
          ...attributes,
          color: '#182522',
          label: '',
          hidden: edgeIsOutsideSelection(selected, source, target),
          zIndex: 0,
        };
      },
    });
    renderer.on('downNode', ({ node, event, preventSigmaDefault }) => {
      drag.begin(node, event);
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
      preventSigmaDefault();
    });
    renderer.getMouseCaptor().on('mousemovebody', (event) => {
      const node = drag.move(event);
      if (!node) return;
      event.preventSigmaDefault();
      event.original.preventDefault();
      event.original.stopPropagation();
      const position = renderer.viewportToGraph(event);
      graph.mergeNodeAttributes(node, position);
      renderer.getContainer().style.cursor = 'grabbing';
    });
    renderer.getMouseCaptor().on('mouseup', () => {
      const moved = drag.end();
      if (!moved) return;
      renderer.getContainer().style.cursor = 'grab';
      window.setTimeout(() => drag.clearSuppressedClick(), 0);
    });
    renderer.on('clickNode', ({ node }) => {
      if (drag.consumeSuppressedClick()) return;
      const attributes = graph.getNodeAttributes(node);
      onSelect(attributes.node as AtlasNode);
    });
    renderer.on('clickStage', () => {
      if (drag.consumeSuppressedClick()) return;
      onSelect(null);
    });
    renderer.on('enterNode', ({ node, event }) => {
      hoveredRef.current = node;
      const attributes = graph.getNodeAttributes(node);
      const container = renderer.getContainer();
      const cardWidth = 330;
      const cardHeight = 330;
      setHoverCard({
        node: attributes.node as AtlasNode,
        x: Math.max(14, Math.min(event.x + 18, container.clientWidth - cardWidth - 14)),
        y: Math.max(14, Math.min(event.y + 18, container.clientHeight - cardHeight - 14)),
      });
      renderer.getContainer().style.cursor = 'grab';
      renderer.refresh();
    });
    renderer.on('leaveNode', () => {
      hoveredRef.current = null;
      setHoverCard(null);
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
      const ratio = renderer.getGraph().order > 40 ? 0.48 : renderer.getGraph().order > 15 ? 0.36 : 0.28;
      if (data) void renderer.getCamera().animate({ x: data.x, y: data.y, ratio }, { duration: 420 });
    }
  }, [selectedId]);

  return (
    <>
      <div className="graph-canvas" ref={containerRef} aria-label="Interactive workspace graph" />
      {hoverCard && <NodeHoverCard node={hoverCard.node} x={hoverCard.x} y={hoverCard.y} />}
      <div className={`graph-direction-key${selectedId ? ' is-active' : ''}${view === 'data' ? ' data-flow-key' : ''}`} aria-label="关系方向图例">
        {view === 'data' ? (
          <>
            <span className="relation-read"><i>→</i> READS_FROM</span>
            <span className="relation-write"><i>→</i> WRITES_TO</span>
            <span className="relation-map"><i>→</i> MAPS_TO</span>
            <span className="relation-call"><i>→</i> CALLS</span>
            <span className="direction-isolated">箭头指向关系目标 <small>{selectedId ? 'FOCUS' : 'FLOW'}</small></span>
          </>
        ) : selectedId ? (
          <>
            <span className="direction-in"><i>→</i> 进入当前节点 <small>IN</small></span>
            <span className="direction-out"><i>→</i> 从当前节点发出 <small>OUT</small></span>
            <span className="direction-isolated">背景节点与关系已隐藏 <small>FOCUS</small></span>
          </>
        ) : (
          <span><i>→</i> 箭头指向关系目标</span>
        )}
      </div>
    </>
  );
}
