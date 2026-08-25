# Phase 1 RPC 对照表（dynamic host.call vs 同源 HTTP）

Phase 2 起 Host 已是静态 ESM（`lib/index.js`）。Phase 3 起 Client 为 `lib/client.js` 的 `__ModuleLoader__` bundle，全部 `host.call` 已改为同源 `fetch`。

鉴权（所有 `/__dsh-messaging/*`）：Origin（或 Referer 推导）必须与 `Host` 同源，且 hostname 只能是 `127.0.0.1` / `localhost` / `::1`。WHATWG `URL.hostname` 对 IPv6 可能是 `[::1]`，比较前会剥掉方括号。失败返回 `403 { ok:false, error:"forbidden origin" }`。不信任 `X-Forwarded-Proto`。

| 动态 RPC（`host.call` / `harness.handle`） | HTTP | 请求体 | 成功响应 | 错误 |
|---|---|---|---|---|
| `messaging_status` | `GET /__dsh-messaging/status` | 无 | `statusSnapshot()`（channels/sessions/recent/errors） | 403；405 |
| `messaging_get_config` / `config-get` | `GET /__dsh-messaging/config` | 无 | `{ config }` | 403；405 |
| `messaging_set_config` / `config-set` | `POST /__dsh-messaging/config` | 完整 config 对象（与 `host.call` 第二参相同） | `statusSnapshot()`（保存并 rebuild 后） | 非对象 → 500；403 |
| `messaging_reload` | `POST /__dsh-messaging/reload` | 可空 `{}` | `statusSnapshot()` | 403 |
| `messaging_send` | `POST /__dsh-messaging/send` | `{ channel, conversation, text, meta? }` | `adapter.sendText` 结果 | 缺字段 → 500 `messaging_send requires...`；adapter 未就绪 → 500 |
| `ilink_login_start` | `POST /__dsh-messaging/ilink/login/start` | 可空 `{}` | `{ ok, sessionKey, qrcodeUrl }` 或 `{ ok:false, error }`（不抛） | 403 |
| `ilink_login_status` | `POST /__dsh-messaging/ilink/login/status` | `{ sessionKey, verifyCode? }` | poll 状态对象 | 403 |
| `ilink_login_verify` | `POST /__dsh-messaging/ilink/login/verify` | `{ sessionKey, verifyCode }` | `{ ok:true }` 或 `{ ok:false, error:"no active login" }` | 403 |
| `ilink_login_cancel` | `POST /__dsh-messaging/ilink/login/cancel` | `{ sessionKey }` | `{ ok:true }` | 403 |

说明：

- Client：`lib/client.js` 的 `rpc(method, path, body)` 封装 fetch；`credentials:'same-origin'`；非 2xx 抛 `Error(json.error || HTTP status)`。
- `GET`/`POST /__dsh-messaging/config` 合为一条 exact 路由（webServer exact 按 path 覆盖）。
- `messaging_status` agent 工具已在 Phase 2 移除，仅 HTTP UI。
- 测试：`node test/http-routes.cjs`；`node test/host-smoke.cjs`；`node test/client-smoke.cjs`。
