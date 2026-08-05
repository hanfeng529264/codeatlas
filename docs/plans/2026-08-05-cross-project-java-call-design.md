# 跨项目 Java 契约调用桥接设计

## 目标

在不合并各项目 CodeGraph 数据库的前提下，让消费项目中的 HTTP Route 沿真实静态证据跨越 RPC contract，继续到达提供项目的实现方法和数据库表。

首个真实验收链路：

```text
AppLearnController Route
  → LearnAppService.getDailyPlan
  ⇢ ILearnFacadeService.getDailyPlan
  → LearnFacadeServiceImpl.getDailyPlan
  → … → t_learn_task_completion
```

其中 `⇢` 是 CodeAtlas 新增的 `REMOTE_CALLS`。

## 组件

### Contract bridge 核心

新增语言和构建系统无关的 Overlay 契约，输入为工作空间、已聚合节点和边，输出跨项目边与诊断。首个 Provider 为 Java/Maven。这样数据流 Provider 继续只负责数据资源事实，跨项目调用不会混入 ORM 解析器。

### Maven 坐标发现

在项目根目录的有限深度内读取 `pom.xml`：

- 将项目内所有 `groupId:artifactId` 注册为该项目提供的坐标；
- 收集依赖项，并解析同一 POM `properties` 中的简单版本引用；
- 只对依赖坐标能够唯一指向另一个已注册项目时建立消费方向。

不运行 Maven，不解析远程 parent，不访问制品仓库。版本只作为证据保存，不作为源码项目是否匹配的硬性条件。

### Java 调用发现

仅扫描 CodeGraph 已索引的 Java 文件，并复用其方法行号：

- 从 import 建立简单类型到完整限定名的映射；
- 从字段、局部变量和参数声明建立变量到接口类型的映射；
- 识别 `receiver.method(args)`，通过括号深度计算参数个数；
- 调用行必须唯一落入一个方法节点；
- 完整限定接口 + 方法名 + 参数个数必须在提供项目唯一匹配。

## 证据与失败策略

成功边使用 `static-derived`，默认置信度 0.94。metadata 包含 Maven 坐标、manifest、接口限定名、方法名、参数个数、调用文件和行号。

以下情况均跳过：依赖目标不唯一、接口不唯一、重载无法按参数个数消歧、变量类型未知、调用点不属于唯一方法。文件级读取失败记录 warning，其余文件继续。

## API 与界面

- 调用图包含 `REMOTE_CALLS`；
- 数据链路反向可达集合包含 `REMOTE_CALLS`，因此 Route 能跨项目到 Table；
- Web 使用独立紫色箭头表达远程调用，并在关系详情中展示 Maven 与接口证据；
- 项目筛选保持严格边界：只选择单项目时不强行带入其他项目节点。

## 测试

- Maven 多模块坐标与消费依赖识别；
- 精确接口调用生成 `REMOTE_CALLS`；
- 同名接口/重载歧义不生成边；
- `REMOTE_CALLS` 进入 calls/data 投影；
- 真实五项目工作空间从 Route 到 Table 的完整只读验证；
- 全量 test、typecheck、build、E2E。
