# 消息渠道网关插件（Messaging Gateway）实施方案

目标：以 Harness 动态 Cordis 插件形式，实现 7 个消息渠道的对接：
OneBot v11、Telegram、Discord、Slack、飞书/Lark、企业微信、个人微信。

## 已确认的运行时事实（第 1 轮勘察结论）

- 插件运行在 Host 沙箱（node:vm），**没有** fetch/WebSocket/crypto/timer/require/process/Buffer。
- 网络出口：`ctx.web.fetch` 仅支持 GET（只有 `url` 字段）→ **出站 POST 必须走 `ctx.shell` + curl**
  （`ShellExecRequest.stdin` 传 JSON body，`stdoutMaxBytes` 限流，curl 出口已验证可用）。
- 入站 HTTP：`ctx.webServer.register({ kind:'exact', path, handler(req,res) })`，Node 原生 req/res。
- WebSocket 客户端 / AES 解密：**伴随进程**方案 —— 内置 Node v24.18.0
  `/Applications/deeprein.app/Contents/Resources/_up_/backend/node/bin/node`，
  `ws` 包在 `/Applications/deeprein.app/Contents/Resources/_up_/backend/dsh/node_modules/ws`。
- 驱动 Agent：`ctx.agents.create({ sessionId, meta:{cwd, agentPreset}, agentOptions })` →
  `agent.followup(userMessage)`；`UserMessage = { id, role:'user', content:[{type:'text',text}], source:{kind:'user'} }`（id 无格式校验）。
- 捕获回复：`ctx.on('session/event', (session, event))`：
  `assistant/message`（`event.data.message.content` 里 text 块）按 turn 缓冲，`turn/end` 时发出。
- 动态工具 DSL：`harness.defineTool({ name, description, parameters, output:{schema, render}, execute })` + `harness.registerTool(ctx, tool)`。
- 配置持久化：`ctx.fs` 读写 `<workspaceRoot>/.dsh-messaging/config.json`（沙箱无 settings 的 schemastery 可用）。
- 注意：`agents.create` 的 agent 归属插件 fiber，插件 stop/update 会销毁其 session；如需跨版本保活后续再处理。

## 架构

```
[渠道端] → (webhook/轮询/伴随进程) → 适配器 → deliver(channel, conversation, text)
   → ensureRecord: ctx.agents.create(...) → agent.followup(UserMessage)
   → session/event: assistant/message 缓冲 → turn/end → 适配器.sendText → curl POST → [渠道端]
```

- 会话键：`channel + ':' + conversation`（onebot `group:123`/`private:456`，telegram chat_id 等）。
- 状态：`status.channels[7]`、`status.sessions[]`、`status.recent[]`（供 `messaging_status` 工具与 Client 面板）。
- 配置重载：`harness.handle('config-set')` → 重读文件 → 重建适配器（generation 计数 + 全部 disposer 记录）。

## 7 个子目标（每渠道一个）

| # | 渠道 | 入站 | 出站 | 关键实现点 |
|---|------|------|------|-----------|
| 1 | OneBot v11 | HTTP webhook（webServer 路由，`post_type=message`） | `POST {endpoint}/send_private_msg|send_group_msg`（`Authorization: Bearer` 可选） | raw_message/数组消息解析、self_id 回显抑制 |
| 2 | Telegram | getUpdates 长轮询（`timeout=40`，offset 递增）或 webhook 二选一 | `POST api.telegram.org/bot<token>/sendMessage` | 4096 分片、curl --max-time 55 |
| 3 | Discord | Gateway WS（伴随进程：heartbeat/resume/IDENTIFY，intents） | REST `POST /channels/<id>/messages`（`Bot <token>`） | ws 包绝对路径 require、伴随进程 JSON-lines 协议 |
| 4 | Slack | Events API 路由（url_verification challenge + event_callback） | `chat.postMessage`（`Bearer <botToken>`） | 签名校验（可选，需 crypto → 伴随进程）；Socket Mode 后续可选 |
| 5 | 飞书/Lark | 事件订阅路由（URL 验证 challenge + im.message.receive_v1） | app_access_token（缓存 2h）→ `im/v1/messages?receive_id_type=` | message.content 是 JSON 字符串需二次解析 |
| 6 | 企业微信 | 回调路由（GET 验证 echostr + POST 消息，AES 解密经伴随进程 crypto） | gettoken(corpid+secret) → `message/send`；或群机器人 webhook | msg_signature 校验、XML 解析 |
| 7 | 个人微信 | WeChatFerry(wcf) HTTP 桥接轮询 / gewe API 轮询 `message/callback/collect` | wcf `/send-text` / gewe `message/postText` | 外部运行时（微信 PC 注入/ipad 协议）由用户自备，插件只做集成层 |

## 交付节奏（按 round 递增包版本）

- v1（本轮起）：核心框架 + OneBot v11 + Telegram + `messaging_status` 工具 → run → 合成事件验证。
- v2：Discord + Slack（引入伴随进程 WS）。
- v3：飞书 + 企业微信（伴随进程 AES 解密）。
- v4：个人微信（wcf/gewe 双驱动）。
- v5：Client 状态面板（tool.view.cordis）+ 完整文档 + 全渠道回环验证。

## 验证手段

- `messaging_status` 模型工具：读渠道状态、会话映射、最近事件（我在下一步可直接调用）。
- 合成入站：`curl -X POST http://127.0.0.1:3080/messaging/onebot -d '<event json>'`。
- 出站验证：渠道状态里记录每次发送的 HTTP 状态；Telegram 用 getMe 校验 token。
