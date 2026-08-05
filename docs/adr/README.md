# CodeAtlas 架构决策记录

| ADR | 状态 | 决策 |
|---|---|---|
| [0001](0001-local-first-cli-web.md) | Accepted | 本地优先的 CLI + Web 架构 |
| [0002](0002-unified-graph-projections.md) | Accepted | 统一底层图谱与多视图投影 |
| [0003](0003-codegraph-adapter.md) | Accepted | 通过适配器集成 CodeGraph |
| [0004](0004-sqlite-over-graph-database.md) | Accepted | MVP 使用 SQLite 而非独立图数据库 |
| [0005](0005-full-graph-progressive-rendering.md) | Accepted | 完整图采用 WebGL 与分级渲染 |
| [0006](0006-project-index-aggregation.md) | Accepted | 聚合每个项目的独立 CodeGraph 索引 |
| [0007](0007-language-neutral-data-flow-providers.md) | Accepted | 使用语言无关核心与内部框架 Provider 构建数据链路 |

ADR 记录已确认且会影响长期维护成本的架构决策。发生方向变化时新增 ADR 并标记旧决策为 Superseded，不直接改写历史原因。
