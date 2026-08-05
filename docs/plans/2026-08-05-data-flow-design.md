# CodeAtlas v0.3.0 数据链路设计

## 目标与范围

CodeAtlas 的数据链路能力面向多语言、多框架项目，不把“数据链路”等同于 Java。v0.3.0 首个可交付 Provider 聚焦当前真实测试项目使用的 Java/Spring/MyBatis，允许用户从 HTTP 接口或数据表切入，查看静态数据访问链路：`Route → Controller → Service → Mapper → SQL → Table`。

本阶段回答“哪些入口通过哪些代码读取或写入哪些表”，不尝试证明字段值在每一行代码中的精确传播，也不连接真实数据库。未来的 TypeScript、Python、Go、PHP 和 C# 等技术栈通过相同扩展边界接入，不修改数据链路核心。

真实工作空间验证表明，CodeGraph 已能识别 Spring 路由、Java 方法调用、Mapper 接口、MyBatis XML SQL 节点，以及 Java Mapper 与 XML 语句之间的合成调用关系。因此 CodeAtlas 不重新解析完整调用图，而是在其上增加数据库知识覆盖层。

## 分层架构

数据链路分为三个层次：

1. **语言无关核心**：定义 Provider 契约、项目上下文、统一 Overlay、诊断信息、合并与去重规则。核心只认识图节点、图关系、证据和置信度。
2. **通用提取器**：SQL 表关系提取不依赖宿主语言或 ORM，可被 Java XML、TypeScript 字符串、Python 查询文件等 Provider 复用。
3. **框架 Provider**：负责识别项目是否适用，并把框架特有信息转换为统一 Overlay。v0.3.0 首个 Provider 为 `java-mybatis`；后续可增加 `typescript-prisma`、`python-sqlalchemy`、`go-gorm` 等。

```text
Project
  ├─ java-mybatis Provider ─┐
  ├─ typescript-prisma ─────┼─→ DataFlow Overlay → CodeGraph Snapshot
  └─ other providers ───────┘
               ↑
        language-neutral SQL extractor
```

Provider 通过项目文件和框架特征自行执行 `supports` 探测，而不是依赖一个排他的“项目语言”开关。同一个多语言项目可以同时运行多个 Provider。注册器并行执行匹配的 Provider，按稳定注册顺序合并结果，并按节点和边 ID 去重。

当前内部接口为：

```ts
interface DataFlowProvider {
  readonly id: string;
  supports(context: DataFlowProjectContext): boolean | Promise<boolean>;
  extract(context: DataFlowProjectContext): DataFlowOverlay | Promise<DataFlowOverlay>;
}
```

v0.3.0 先稳定内部 Provider 接口；在第二种真实语言 Provider 接入并验证抽象后，再评估公开插件 SDK，避免过早固化不成熟的外部 API。

## Java/MyBatis 首个 Provider

`java-mybatis` Provider 扫描 MyBatis XML 和相关 Java 源文件，把 XML 中的 `select/insert/update/delete` 与 `FROM/JOIN/INTO/UPDATE/DELETE FROM` 表引用转换为 `table` 节点，以及 `READS_FROM`、`WRITES_TO` 边。对于 MyBatis-Plus，Provider 解析 `@TableName`、实体类和 `BaseMapper<Entity>`，生成 Mapper 到表的 `MAPS_TO` 关系。

增强结果在 CodeGraph 适配器聚合阶段合并，不另建数据库。原始 CodeGraph 节点继续作为 Controller、Service、Mapper 和 SQL 语句证据；CodeAtlas 只增加缺失的表节点和数据关系。节点 ID 使用项目命名空间，避免多项目同名表冲突。

## 统一语义与证据

首批语言无关关系为 `READS_FROM`、`WRITES_TO`、`MAPS_TO`。后续消息队列、外部 API 和缓存可继续扩展 `PUBLISHES_TO`、`SUBSCRIBES_TO`、`CALLS_API` 等语义，而无需修改 Provider 生命周期。

每条推导记录 Provider ID、项目、文件、行号、操作、证据类别和置信度。源码中明确出现的表名标记为 `static-derived`；仅能从命名约定推测时标记为 `heuristic` 并降低置信度。无法确定表名的 `${...}`、运行时拼接 SQL 不生成确定关系，也不把不完整链路伪装成完整结果。

## 失败处理

Provider 的能力探测或提取失败会转换为带 Provider ID 的诊断信息，不中断其他 Provider，也不影响现有代码图。单个文件解析失败只影响该文件。这样多项目、多语言空间中的局部失败不会让整个工作空间不可用。

## 查询与可视化

GraphStore 新增 `data` 投影，从数据资源节点沿数据关系和调用关系反向收集可达入口，避免把无数据关系的普通调用全部画出。Web 左侧新增“数据链路”视图，而不是“Java 数据链路”；表节点和读写关系使用独立颜色，详情面板显示资源名、读写类型、来源 Provider、源文件和置信度。

搜索、项目筛选、局部上下游、节点拖动和大图预算沿用现有能力。语言和 Provider 是筛选与证据维度，不是 UI 图类型。

Web 继续采用现有工业制图仪表盘风格。Table 使用酸绿色资源节点并优先显示标签；`READS_FROM` 使用青色、`WRITES_TO` 使用珊瑚红、`MAPS_TO` 使用紫色，所有箭头均指向关系目标。视图头部显示 Tables、Reads、Writes、Maps 实际渲染数量，右上图例解释关系颜色和方向。选中节点后，详情面板列出相邻数据关系、流入/流出方向、另一端节点、Provider 和操作类型。

Provider 存在 warning/error 时显示诊断徽章，并通过悬停提供具体原因。项目范围内没有可达数据资源时显示明确空状态，避免把空白画布误解为加载失败。聚焦、高亮、非相关节点隐藏和临时拖拽继续沿用现有行为。

## 验收

- 通用 SQL 测试覆盖 SELECT/JOIN、INSERT、UPDATE、DELETE、动态表名忽略和去重。
- Provider 注册器测试覆盖多 Provider 共同运行、能力探测、事实去重和故障隔离。
- Java Provider 测试覆盖 MyBatis XML、`@TableName` 和 `BaseMapper`。
- API 测试证明数据投影只返回能够到达数据资源的链路，并保留完整计数与证据。
- 在真实五项目空间中至少验证一条 `Controller → Service → Mapper XML → Table` 链路。
- 完整 Vitest、类型检查、生产构建、Playwright E2E 和浏览器视觉验收通过。
