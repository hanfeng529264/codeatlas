# CodeAtlas v0.3.0 数据链路设计

## 目标与范围

v0.3.0 第一阶段让用户从 HTTP 接口或数据表切入，查看 Java/Spring/MyBatis 项目的静态数据访问链路：`Route → Controller → Service → Mapper → SQL → Table`。本阶段聚焦“哪些入口通过哪些代码读取或写入哪些表”，不尝试证明字段值在每一行代码中的精确传播，也不连接真实数据库。

真实工作空间验证表明，CodeGraph 已能识别 Spring 路由、Java 方法调用、Mapper 接口、MyBatis XML SQL 节点，以及 Java Mapper 与 XML 语句之间的合成调用关系。因此 CodeAtlas 不重新解析完整 Java 调用图，而是在其上增加数据库知识覆盖层。

## 架构

新增 Java 数据访问增强器。它按工作空间项目扫描 MyBatis XML 和相关 Java 源文件，把 XML 中的 `select/insert/update/delete` 与 `FROM/JOIN/INTO/UPDATE/DELETE FROM` 表引用转换为 `table` 节点，以及 `READS_FROM`、`WRITES_TO` 边。对于 MyBatis-Plus，增强器解析 `@TableName`、实体类和 `BaseMapper<Entity>`，生成 Mapper 到表的 `MAPS_TO` 关系。

增强结果在 CodeGraph 适配器聚合阶段合并，不另建数据库。原始 CodeGraph 节点继续作为 Controller、Service、Mapper 和 SQL 语句证据；CodeAtlas 只增加缺失的表节点和数据关系。节点 ID 使用项目命名空间，避免多项目同名表冲突。

## 证据与失败处理

XML 中明确出现的表名标记为 `static-derived`，记录项目、文件、行号、SQL 操作和语句 ID。`@TableName` 明确映射同样是静态推导；仅能从实体类名或动态 SQL 推测时标记为 `heuristic` 并降低置信度。无法确定表名的 `${...}`、运行时拼接 SQL 不生成确定关系，也不把不完整链路伪装成完整结果。

单个文件解析失败只影响该文件，项目状态和 API 返回明确诊断信息；现有代码图仍可使用。

## 查询与可视化

GraphStore 新增 `data` 投影，从 `table` 节点沿 `READS_FROM/WRITES_TO/MAPS_TO/CALLS/ROUTES_TO` 反向收集可达入口，避免把无数据库关系的普通调用全部画出。Web 左侧新增“数据链路”视图；表节点和读写关系使用独立颜色，详情面板显示表名、读写类型、SQL 来源和置信度。搜索、项目筛选、局部上下游、节点拖动和大图预算沿用现有能力。

## 验收

- 单元测试覆盖 XML SELECT/JOIN、INSERT、UPDATE、DELETE、动态表名忽略、`@TableName` 和 `BaseMapper`。
- API 测试证明数据投影只返回能够到达数据表的链路，并保留完整计数与证据。
- 在真实五项目空间中至少验证一条 `Controller → Service → Mapper XML → Table` 链路。
- 完整 Vitest、类型检查、生产构建、Playwright E2E 和浏览器视觉验收通过。
