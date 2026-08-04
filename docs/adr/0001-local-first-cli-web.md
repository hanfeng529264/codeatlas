# ADR-0001：采用本地优先的 CLI + Web 架构

## Status

Accepted

## Context

CodeAtlas 需要跨平台初始化本地工作空间、运行索引与查询服务，并展示大规模交互式图谱。第一版面向单机用户，源代码和图谱默认不能离开设备。原生桌面应用会增加打包和平台适配成本，纯命令行又无法承载复杂图形交互。

## Decision

第一版采用 CLI 管理工作空间和服务生命周期，通过只监听回环地址的本地 HTTP/WebSocket 服务提供 API，并在浏览器中运行 Web 可视化界面。桌面封装延后到核心交互验证之后。

## Consequences

### Positive

- 跨平台且安装、调试和迭代成本较低。
- WebGL、Web Worker 和前端图形生态适合大图交互。
- Web 与 MCP 可以共享同一个本地查询引擎。
- 默认无需云端基础设施。

### Negative

- 需要处理本地端口、会话令牌和浏览器安全边界。
- 浏览器内存和 GPU 能力存在设备差异。
- 与编辑器集成需要额外跳转协议或插件。

### Neutral

- 未来可以用 Tauri/Electron 封装现有 Web UI，而不改变查询层。

## Alternatives Considered

- 原生桌面应用：首版平台和打包成本过高。
- 纯 CLI/TUI：无法满足完整图谱的交互需求。
- 云端 Web 服务：违背第一版本地优先和低运维目标。
