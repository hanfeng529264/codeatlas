# Project Scan 设计

- 日期：2026-08-05
- 版本：v0.2.0
- 分支：`codex/v0.2-multi-project`
- 目标：将多项目注册从重复的 `project add` 操作收敛为一个可预测的批量命令。

## 用户体验

在工作空间内运行：

```bash
codeatlas project scan
```

如果工作空间包含 `projects/`，默认扫描该目录；否则扫描工作空间根目录。也可以显式指定目录：

```bash
codeatlas project scan ./services
```

扫描只查看目标目录的一级子目录。发现的项目使用目录名作为默认名称，批量注册后逐个初始化 CodeGraph，最后输出新增、已索引、已注册和失败数量。

## 识别与安全边界

子目录具备以下任一入口时视为项目：

- `.git`
- Maven、Gradle、npm、Go、Rust 或 Python 构建清单
- `src`、`client`、`server`、`service` 或 `contract` 源码入口

隐藏目录以及 `node_modules`、`target`、`build`、`dist`、`coverage`、`vendor`、`logs`、`tmp` 被忽略。扫描目录必须位于工作空间内部；已注册路径不会重复写入。单个项目失败不会阻断后续项目，汇总中会明确报告失败数量。

## 验证

- 工作空间测试覆盖默认 `projects/`、入口识别、噪声排除和已注册去重。
- CLI 测试覆盖一条命令注册多个项目以及汇总输出。
- 完整回归覆盖现有单项目和多项目行为。
