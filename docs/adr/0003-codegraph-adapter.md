# ADR-0003：通过适配器集成 CodeGraph

## Status

Accepted

## Context

CodeGraph 已具备多语言解析、引用解析、增量同步和本地代码图谱能力。直接依赖其内部 SQLite Schema 可以快速验证，但会把 CodeAtlas 与具体版本绑定；从头重写解析器则会显著扩大范围。

## Decision

第一版复用 CodeGraph 作为代码事实来源，但所有访问都经过 `CodeGraphAdapter`。适配器负责能力检测、版本兼容、状态、类型归一化和证据映射。优先评估公开 SDK/API；若性能要求必须只读数据库，则将其封装为带契约测试的版本化兼容层。

## Consequences

### Positive

- 快速获得成熟的多语言代码图谱。
- CodeAtlas 保持自己的领域模型和产品边界。
- 后续可以增加数据库、OpenAPI、Git 和 Trace 适配器。
- CodeGraph 变更集中在单一兼容层处理。

### Negative

- 仍依赖外部项目的能力、版本和发布节奏。
- SDK/API 可能无法一次提供可视化所需的全量数据。
- 兼容测试和版本矩阵会产生维护成本。

### Neutral

- CodeGraph DB 与 CodeAtlas knowledge DB 保持独立生命周期。

## Alternatives Considered

- 直接在业务代码中查询 CodeGraph DB：耦合过高，难以演进。
- 自研解析与引用解析：超出 MVP 范围，重复已有成熟能力。
- 只调用 CLI 文本输出：集成简单，但结构、性能和错误处理不足。
