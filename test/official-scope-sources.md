# 官方权限 scope 来源（可复查 fixture）

核验/访问日期：**2026-10-08**（curl 实测 HTTP 200）。下表“行号”指**该访问日期**抓取的
`.md` 官方纯文本版中的行号（`grep -n` 自查实测，非固定永恒值）；官方文档更新后行号会漂移，
复验时以重抓后的“权限要求”行为准。

**访问方式（只用 open.feishu.cn 官方源，不用第三方镜像）**：飞书文档页 HTML 声明
`<link rel="alternate" type="text/markdown" href="….md" tip="pure markdown version">`，
即对任意文档 URL 追加 `.md` 取官方纯文本版：

```bash
curl -sL "https://open.feishu.cn/document/<slug>.md"
```

本文件位于 `test/`，不在 package.json `files` 白名单内 → 不随 npm 包发布。

| # | 官方文档（访问 2026-10-08） | 行号 | 官方短原文（≤25 词） | 对应本插件用途 |
| --- | --- | --- | --- | --- |
| 1 | [创建卡片实体](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/create)（`uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/create`） | L20 | 权限要求：「创建与更新卡片(cardkit:card:write)」，「开启其中任意一项权限即可调用」 | `POST /cardkit/v1/cards`（开卡） |
| 2 | [流式更新文本](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card-element/content)（`…/cardkit-v1/card-element/content`） | L31 | 权限要求：「创建与更新卡片(cardkit:card:write)」 | `PUT …/cards/:card_id/elements/:element_id/content`（流式正文） |
| 3 | [更新卡片配置](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/settings)（`…/cardkit-v1/card/settings`） | L18 | 权限要求：「创建与更新卡片(cardkit:card:write)」 | `PATCH …/cards/:card_id/settings`（收尾） |
| 4 | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)（`server-docs/im-v1/message/create`） | L24 | 「应用身份发消息：需申请下面三个权限之一」：`im:message` / `im:message:send_as_bot` / `im:message:send`；同段标注「发送消息V2【历史版本】」(`im:message:send`) 为 legacy，推荐 `im:message:send_as_bot` 或 `im:message` | 文本模式分段实时返回、静态出站（`POST /im/v1/messages`） |
| 5 | [接收消息事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/receive)（`…/im-v1/message/events/receive`） | L38 | 「开启任一权限即可订阅」：「读取用户发给机器人的单聊消息(im:message.p2p_msg:readonly)」；「获取群组中用户@机器人消息(im:message.group_at_msg:readonly)」（同列表的无后缀 `im:message.p2p_msg` 另标【历史版本】） | 长连接订阅 `im.message.receive_v1` |

复验方式：重跑上表 curl，比对对应「权限要求」行（1–3 见 L20 / L31 / L18，4 见 L24
“开启任一权限即可”段，5 见 L38 事件页权限列表——均指 2026-10-08 抓取版，行号以重抓为准）；
若取不到官方原文，应标注待验证，不得以第三方镜像或记忆中的名称顶替。
