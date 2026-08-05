import { type CSSProperties, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { GraphCanvas } from './graph/GraphCanvas';
import type { AtlasNode, GraphProjection, ViewId, WorkspaceStatus } from './types';

const VIEWS: Array<{ id: ViewId; code: string; label: string; caption: string }> = [
  { id: 'full', code: '00', label: '完整空间', caption: 'ALL FACTS' },
  { id: 'directory', code: '01', label: '目录层级', caption: 'STRUCTURE' },
  { id: 'structure', code: '02', label: '代码结构', caption: 'SYMBOLS' },
  { id: 'methods', code: '03', label: '方法图', caption: 'METHODS' },
  { id: 'calls', code: '04', label: '调用图', caption: 'CALL FLOW' },
];

const EVIDENCE_LABELS: Record<string, string> = {
  verified: '已验证',
  'static-derived': '静态推导',
  heuristic: '启发式',
  'ai-inferred': 'AI 推断',
  'user-defined': '用户定义',
};

function readableValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function App() {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [graph, setGraph] = useState<GraphProjection | null>(null);
  const [view, setView] = useState<ViewId>('full');
  const [selected, setSelected] = useState<AtlasNode | null>(null);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<AtlasNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('all');

  const loadView = useCallback(async (
    nextView: ViewId,
    projectId = selectedProjectId,
    complete = false,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const projectQuery = projectId === 'all' ? '' : `&project=${encodeURIComponent(projectId)}`;
      const completeQuery = complete ? '&complete=1' : '';
      const nextGraph = await api<GraphProjection>(`/api/graph?view=${nextView}${projectQuery}${completeQuery}`);
      setGraph(nextGraph);
      setView(nextView);
      setSelected(null);
      setFocused(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    Promise.all([api<WorkspaceStatus>('/api/status'), api<GraphProjection>('/api/graph?view=full')])
      .then(([nextStatus, nextGraph]) => {
        setStatus(nextStatus);
        setGraph(nextGraph);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const projectQuery = selectedProjectId === 'all'
        ? ''
        : `&project=${encodeURIComponent(selectedProjectId)}`;
      const response = await api<{ results: AtlasNode[] }>(
        `/api/search?q=${encodeURIComponent(search)}${projectQuery}`,
      );
      setSearchResults(response.results);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const focusNode = async (node: AtlasNode, direction: 'in' | 'out' | 'both') => {
    setLoading(true);
    try {
      const nextGraph = await api<GraphProjection>('/api/graph/neighborhood', {
        method: 'POST',
        body: JSON.stringify({ nodeId: node.id, direction, depth: 2, maxNodes: 800 }),
      });
      setGraph(nextGraph);
      setSelected(node);
      setFocused(true);
      setSearchResults([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const selectSearchResult = async (node: AtlasNode) => {
    await focusNode(node, 'both');
  };

  const selectProject = async (projectId: string) => {
    setSelectedProjectId(projectId);
    setSearchResults([]);
    await loadView(view, projectId);
  };

  const projectNameById = useMemo(
    () => new Map((status?.workspace.projects ?? []).map((project) => [project.id, project.name])),
    [status],
  );
  const selectedProject = selectedProjectId === 'all'
    ? null
    : status?.workspace.projects.find((project) => project.id === selectedProjectId) ?? null;

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph?.nodes ?? []) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [graph]);

  if (error && !graph) {
    return (
      <main className="fatal-screen">
        <span className="eyebrow">CODEATLAS / CONNECTION FAULT</span>
        <h1>图谱连接中断</h1>
        <p>{error}</p>
        <code>codeatlas open</code>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <div className="brand">CODEATLAS</div>
            <div className="brand-subtitle">WORKSPACE CARTOGRAPHY</div>
          </div>
        </div>
        <form className="search" onSubmit={handleSearch}>
          <span className="search-index">⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索项目、文件、类或方法…"
            aria-label="Search workspace graph"
          />
          <button type="submit" className="search-submit" aria-label="Run search">↵</button>
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((node) => (
                <button type="button" key={node.id} onClick={() => void selectSearchResult(node)}>
                  <span className="result-kind">{node.kind}</span>
                  <span>{node.label}</span>
                  <small>{node.projectId ? `${projectNameById.get(node.projectId) ?? node.projectId} · ` : ''}{node.filePath ?? node.qualifiedName}</small>
                </button>
              ))}
            </div>
          )}
        </form>
        <div className="system-state">
          <span className="pulse" />
          <div>
            <strong>INDEX LIVE</strong>
            <small>CG {status?.codegraph.version ?? '—'}</small>
          </div>
        </div>
      </header>

      <aside className="left-rail">
        <div className="workspace-identity">
          <span className="rail-label">CURRENT SPACE</span>
          <h2>{status?.workspace.name ?? 'Loading…'}</h2>
          <p title={status?.workspace.rootPath}>{status?.workspace.rootPath ?? 'Resolving workspace'}</p>
        </div>

        <section className="project-scope" aria-label="Project scope">
          <span className="rail-label">PROJECT SCOPE</span>
          <button
            type="button"
            className={selectedProjectId === 'all' ? 'active' : ''}
            onClick={() => void selectProject('all')}
          >
            <span className="project-swatch project-all" />
            <span>全部项目<small>ALL PROJECTS</small></span>
            <strong>{status?.workspace.projects.length ?? 0}</strong>
          </button>
          {status?.codegraph.projects.map((project, index) => (
            <button
              type="button"
              key={project.id}
              className={selectedProjectId === project.id ? 'active' : ''}
              onClick={() => void selectProject(project.id)}
              style={{ '--project-index': index } as CSSProperties}
            >
              <span className="project-swatch" />
              <span>{project.name}<small>{project.indexed && project.compatible ? 'INDEXED' : 'ATTENTION'}</small></span>
              <strong>{project.totalNodes.toLocaleString()}</strong>
            </button>
          ))}
        </section>

        <nav className="view-nav" aria-label="Graph views">
          <span className="rail-label">GRAPH PROJECTIONS</span>
          {VIEWS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={view === item.id && !focused ? 'active' : ''}
              onClick={() => void loadView(item.id)}
            >
              <span className="view-code">{item.code}</span>
              <span className="view-name">{item.label}<small>{item.caption}</small></span>
              <span className="view-arrow">↗</span>
            </button>
          ))}
        </nav>

        <div className="composition">
          <span className="rail-label">VISIBLE COMPOSITION</span>
          {kindCounts.map(([kind, count]) => (
            <div className="composition-row" key={kind}>
              <span className={`kind-dot kind-${kind}`} />
              <span>{kind}</span>
              <strong>{count.toLocaleString()}</strong>
            </div>
          ))}
        </div>

        <div className="legend">
          <span className="rail-label">EVIDENCE</span>
          <div><i className="line-solid" />确定 / 静态关系</div>
          <div><i className="line-dashed" />启发式关系</div>
        </div>
      </aside>

      <main className="map-stage">
        <div className="stage-header">
          <div>
            <span className="stage-kicker">{focused ? 'FOCUSED PROJECTION' : selectedProject ? 'PROJECT SCOPE' : 'COMPLETE WORKSPACE'}</span>
            <h1>{focused ? selected?.label ?? '局部探索' : VIEWS.find((item) => item.id === view)?.label}</h1>
            <p className="scope-caption">{selectedProject ? `${selectedProject.name} PROJECT` : 'ALL PROJECTS'}</p>
          </div>
          <div className="stage-actions">
            {focused && <button type="button" onClick={() => void loadView(view)}>← 返回完整空间</button>}
            {!focused && graph?.projection.overview && (
              <button type="button" className="render-all" onClick={() => void loadView(view, selectedProjectId, true)}>
                渲染全部 {graph.projection.totalMatchedNodes.toLocaleString()} 个节点
              </button>
            )}
            <span className={graph?.projection.truncated ? 'data-warning' : 'data-complete'}>
              {graph?.projection.overview ? 'OVERVIEW' : graph?.projection.truncated ? 'PARTIAL' : 'COMPLETE'}
            </span>
          </div>
        </div>

        <div className="map-frame">
          <div className="coordinate coordinate-nw">N 31°14′ / E 121°29′</div>
          <div className="coordinate coordinate-se">GRAPH/{graph?.version.slice(0, 8) ?? '--------'}</div>
          {graph && <GraphCanvas graphData={graph} selectedId={selected?.id ?? null} onSelect={setSelected} />}
          {loading && <div className="loading-plate"><span /><b>RECALCULATING PROJECTION</b></div>}
          <div className="scale-mark"><span>0</span><i /><span>RELATION DEPTH</span></div>
        </div>

        <footer className="map-status">
          <div><span>RENDERED NODES</span><strong>{graph?.projection.returnedNodes.toLocaleString() ?? '—'}</strong></div>
          <div><span>WORKSPACE NODES</span><strong>{status?.graph.totalNodes.toLocaleString() ?? '—'}</strong></div>
          <div><span>RENDERED EDGES</span><strong>{graph?.projection.returnedEdges.toLocaleString() ?? '—'}</strong></div>
          <div><span>WORKSPACE EDGES</span><strong>{status?.graph.totalEdges.toLocaleString() ?? '—'}</strong></div>
          {graph?.projection.truncationReason && (
            <p className={graph.projection.overview ? 'overview-message' : undefined}>
              {graph.projection.truncationReason}
            </p>
          )}
        </footer>
      </main>

      <aside className="detail-panel">
        {selected ? (
          <>
            <div className="detail-heading">
              <span className="node-kind">{selected.kind}</span>
              <button type="button" className="close-detail" onClick={() => setSelected(null)}>×</button>
              <h2>{selected.label}</h2>
              <p>{selected.qualifiedName ?? selected.filePath ?? selected.id}</p>
            </div>

            <div className="evidence-card">
              <div><span>EVIDENCE</span><strong>{EVIDENCE_LABELS[selected.evidenceClass]}</strong></div>
              <div><span>CONFIDENCE</span><strong>{Math.round(selected.confidence * 100)}%</strong></div>
              <div><span>SOURCE</span><strong>{selected.source}</strong></div>
            </div>

            <section className="detail-section">
              <h3>LOCATION</h3>
              <dl>
                <div><dt>File</dt><dd>{selected.filePath ?? '—'}</dd></div>
                <div><dt>Project</dt><dd>{selected.projectId ? projectNameById.get(selected.projectId) ?? selected.projectId : '—'}</dd></div>
                <div><dt>Lines</dt><dd>{selected.startLine ? `${selected.startLine}–${selected.endLine}` : '—'}</dd></div>
                <div><dt>Language</dt><dd>{selected.language ?? '—'}</dd></div>
              </dl>
            </section>

            <section className="detail-section">
              <h3>EXPLORE RELATIONS</h3>
              <div className="relation-actions">
                <button type="button" onClick={() => void focusNode(selected, 'in')}>上游调用者 <span>←</span></button>
                <button type="button" onClick={() => void focusNode(selected, 'out')}>下游调用 <span>→</span></button>
                <button type="button" onClick={() => void focusNode(selected, 'both')}>双向展开 <span>↔</span></button>
              </div>
            </section>

            <section className="detail-section metadata-section">
              <h3>ATTRIBUTES</h3>
              <dl>
                {Object.entries(selected.metadata).slice(0, 10).map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{readableValue(value)}</dd></div>
                ))}
              </dl>
            </section>
          </>
        ) : (
          <div className="empty-detail">
            <div className="reticle"><span /><span /></div>
            <span className="rail-label">INSPECTOR</span>
            <h2>选择一个节点</h2>
            <p>点击图中的任意项目、目录、文件或方法，查看它的证据、位置与上下游关系。</p>
            <ol>
              <li><span>01</span>选择切入点</li>
              <li><span>02</span>验证关系来源</li>
              <li><span>03</span>展开调用链路</li>
            </ol>
          </div>
        )}
      </aside>

      {error && <div className="toast" role="alert"><strong>QUERY FAULT</strong>{error}<button onClick={() => setError(null)}>×</button></div>}
    </div>
  );
}
