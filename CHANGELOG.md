# Changelog

本文件记录 CodeAtlas 的重要版本变化。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- Java/MyBatis 表级数据链路，包括 XML SQL、MyBatis-Plus 实体映射和 `READS_FROM`、`WRITES_TO`、`MAPS_TO`。
- “数据链路”Web 投影、表节点视觉语义、读写方向、Provider 诊断和关系证据详情。
- Java/Maven 跨项目契约桥接：使用 Maven 坐标、完整限定接口、方法名和参数个数生成 `REMOTE_CALLS`。
- 独立项目中的 HTTP Route 现在可以沿可信静态调用链到达 core 项目的数据库表。

### Known limitations

- 首个数据流 Provider 覆盖 Java/Spring/MyBatis；其他语言和 ORM 尚待接入。
- 跨项目方法桥接首个 Provider 覆盖 Java/Maven；候选不唯一或类型无法静态还原时会跳过并给出诊断。
- 当前为表级静态链路，不包含字段级污点传播和运行时 Trace。

### Planned

- 保存视角、链路和人工知识标注。
- 面向 AI 客户端的 CodeAtlas MCP 服务。
- Schema、字段级静态数据流和运行时 Trace 数据源。

## [0.2.0] - 2026-08-05

多项目工作空间版本。

### Added

- Schema 2 工作空间项目注册表，以及 `init --empty` 和 `project add/list/remove` CLI。
- `project scan [directory]` 自动发现、批量注册并索引一级子项目。
- `open` 零配置工作流：自动初始化工作空间、发现项目、建立缺失索引并避让占用端口。
- 多个独立 CodeGraph SQLite 索引的命名空间隔离与统一聚合。
- 全部项目与单项目图谱切换、项目范围搜索、项目健康状态和稳定配色。
- 基于工作空间 `package.json` 明确依赖的跨项目 `DEPENDS_ON` 关系。
- 节点可临时拖动并固定，关系线实时跟随；切换视图或刷新后恢复默认布局。
- 多项目 API、单元/集成测试、Playwright 端到端测试和 GitHub Actions CI。

### Changed

- `status` 与 `sync` 现在遍历工作空间内注册的所有项目。
- `init` 默认识别约定的多项目布局；可用 `--no-discover` 关闭。
- Schema 1 单项目工作空间在读取时自动迁移到 Schema 2，无需重新初始化。
- 项目与工作空间节点名称固定显示，提高全空间图的可读性。

### Known limitations

- 项目必须位于工作空间根目录内部。
- 跨项目关系目前只解析 JavaScript/TypeScript `package.json`；不推断方法级跨项目调用。
- 尚未实现 MCP、知识持久化、数据库关系图和完整数据流。

## [0.1.0] - 2026-08-04

首个可运行的 MVP 版本。

### Added

- `codeatlas init`、`status`、`sync` 和 `open` CLI 工作流。
- CodeGraph SQLite 数据库适配器。
- 完整空间、目录层级、代码结构、方法和调用关系视图。
- 文件与符号搜索、节点详情、上游、下游和双向关系展开。
- 有向边箭头，以及入向和出向关系配色。
- 选中节点后的无关节点与关系视觉隔离。
- 节点悬停证据卡，包括作用域、可见性、签名、参数、注释和源码位置。
- 本机回环地址监听和随机会话令牌保护。
- Vitest 单元与集成测试、Playwright 端到端测试。

### Fixed

- 修复 `npm link` 符号链接场景下 CLI 入口不执行的问题。
- 修复高亮节点白色标签底板上的文字对比度问题。
- 修复复杂图中背景节点和关系遮挡选中链路的问题。

### Known limitations

- 一个 CodeAtlas 页面当前只能读取一个 CodeGraph 索引。
- 尚未实现多项目聚合、MCP、知识持久化、数据库关系图和完整数据链路图。
- 当前版本从源码安装，尚未发布 npm 安装包。
