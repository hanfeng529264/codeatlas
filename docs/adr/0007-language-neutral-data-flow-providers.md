# ADR-0007：语言无关的数据链路 Provider

## Status

Accepted

## Context

v0.3.0 的真实测试项目使用 Java/Spring/MyBatis，但 CodeAtlas 的目标空间会包含多种语言和框架。如果直接把 SQL 提取、项目探测、框架解析和图谱合并写进 Java 适配器，后续 TypeScript、Python、Go 等实现会复制公共逻辑，或者形成大量语言分支。另一方面，在只有一个真实 Provider 时发布完整第三方插件 SDK，会过早固定尚未被第二种实现验证的 API。

## Decision

数据链路采用“语言无关核心 + 内部框架 Provider”结构。核心定义统一的项目上下文、Overlay、图节点、图关系、诊断、证据和置信度；通用 SQL 提取器不属于任何宿主语言。每个 Provider 自行探测项目特征，并将框架特有知识转换为统一 Overlay。

注册器运行所有匹配的 Provider，因此同一个多语言项目可以同时产生多类数据链路。结果按稳定注册顺序合并，并按节点和边 ID 去重。单个 Provider 的能力探测或提取失败转换为诊断信息，不中断其他 Provider 或基础代码图。

Java/MyBatis 是第一个 Provider，而不是核心模型。公开插件 SDK 推迟到至少第二种真实语言 Provider 验证接口以后。

## Consequences

### Positive

- SQL、图谱合并、诊断和证据规则可以跨语言复用。
- 多语言项目无需选择唯一技术栈，可以组合多个 Provider。
- 单个框架解析失败不会拖垮整个工作空间。
- UI 和 API 使用数据关系语义，不需要为每种语言建立独立视图。

### Negative

- Provider 输出必须遵循稳定的节点、边 ID 和证据约定。
- 合并多个 Provider 时需要处理重复事实和潜在冲突。
- 内部接口未来成为公开 SDK 前可能发生兼容性调整。

### Neutral

- v0.3.0 的首个可用实现仍然优先覆盖当前 Java/MyBatis 真实项目。

## Alternatives Considered

- 在单个实现中增加语言判断：初期文件少，但公共逻辑和框架逻辑会快速耦合。
- 立即发布完整插件系统：扩展能力强，但在单一实现阶段缺少足够依据确定长期 API。
- 为每种语言建立独立数据图：隔离清晰，但无法自然表达多语言项目中的统一链路。
