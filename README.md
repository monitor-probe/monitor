# monitor

文档：[monitor-document.pages.dev](https://monitor-document.pages.dev)，安装、配置、反向代理与主题开发都在这里。

主题站：[monitor-themes.pages.dev](https://monitor-themes.pages.dev)，在线预览各个公开页主题，复制地址即可在面板安装。

## 特性

- 实时监控：秒级实时数据展示
- 轻量高效：Rust 语言构建，低资源占用，极简高效
- 自托管：完全掌控数据隐私，部署简单
- 通知：节点掉线、流量、到期与登录，推送到 Telegram 或自定义 Webhook

## 群晖 Chat 通知

在 Synology Chat 的“整合”中创建传入 Webhook，并复制其完整地址。在 Monitor 的通知设置中，将 Webhook 类型选择为“群晖 Chat”，粘贴地址，填写文字消息模板，保存后点击“发送测试”。

消息模板支持 `{{title}}`、`{{message}}`、`{{node}}`、`{{event}}`、`{{site}}` 和 `{{time}}`。无须填写 JSON 或 `payload`；Monitor 会按照[群晖官方说明](https://kb.synology.com/en-us/DSM/tutorial/How_to_configure_webhooks_and_slash_commands_in_Chat_Integration)将消息作为 `payload` 表单参数发送，并检查群晖返回的成功标志。群晖拒收消息时，测试会显示失败，即使 HTTP 状态为 200。

群晖模式会自动设置发送格式，自定义请求头中的 `Content-Type` 不会覆盖它。“通用 JSON”仍是默认类型，两种类型分别保存模板，切换时不会清除原模板。Webhook 地址包含访问凭据，请勿公开。

## 组成

| 仓库 | 说明 |
|---|---|
| [monitor](https://github.com/monitor-probe/monitor) | hub：后台、API、公开页宿主 |
| [agent](https://github.com/monitor-probe/agent) | Linux agent |
| [monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | 内置默认主题 |
| [themes](https://github.com/monitor-probe/themes) | 主题站：收录第三方主题，提供在线预览 |

```
agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  hub (axum + SQLite)  ──▶  后台 + 状态页
```
