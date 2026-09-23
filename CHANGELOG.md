# Changelog

## 0.2.0

纯静态插件架构。设置页随 DSH Web profile 启动自动出现。本版包含静态化迁移与
随后的渠道修复（原 Unreleased 段内容，随本版首次发布 npm 一并发出）。

### Breaking（0.2.0 新增的运行时行为变化）

- **OneBot webhook 现在要求 secret。** `adapters.onebot.secret` 为空时 host 拒绝注册 webhook 路由（channel 进入 error 状态，并记录 `webhook startup refused: secret is required`），直到在设置页填入上报签名密钥。从 0.1.x 升级且未配置 secret 的部署会在升级后失去 webhook 入站，需补配 secret。

- **设置页不再需要手动 Run。** Host 与 Client 都是静态半区：loader 直接 `apply` Host，`dsh.client` 自动注入 Client bundle。升级后打开设置即可看到「消息通道配置」。
- **Cordis 面板里旧的 `dshmsg-*` 动态条目必须手动删除。** 0.1.x 启动壳会 `define()` 出会话级动态插件；升级后若残留，会与静态实例双开（双份 webhook / 轮询）。patch id 从 `dshmsg-boot` 改为 `dsh-messaging`。
- 动态 `host.call` / `harness.handle` 已移除。Client 只走同源 HTTP：`/__dsh-messaging/{status,config,reload,send,ilink/login/*}`，Origin 必须是回环地址。
- `messaging_status` agent 工具（`harness.defineTool`）暂未迁到静态 `@deepseek-ai/dsh-tools`；需要 agent 读网关状态时请用 HTTP 或后续补回。
- 安装包不再包含 `dynamic/`。

### Fixed

- **个人微信扫码登录的二维码永远无法加载。** `ilink get_bot_qrcode` 返回的
  `qrcode_img_content` 是「要编码进二维码的内容」（登录链接
  `https://liteapp.weixin.qq.com/q/…`），**不是图片地址**——参考实现
  openclaw-weixin 是把它交给 `qrcode-terminal` 画成终端码的。原实现把它直接放进
  `<img src>`，浏览器 GET 到的是 liteapp 的 HTML 页面（`Content-Type: text/html`），
  图片永远渲染不出来。现改为宿主侧本地把载荷编码成 **SVG data URL**
  （`lib/qr-image.js`，vendored `qrcode-generator`，MIT，见 `lib/vendor/LICENSE`）：
  `login/start` / `login/status` 返回的 `qrcodeUrl` 仍是可直接作 `<img src>` 的
  图片源，client 契约与代码零改动；二维码过期自动刷新路径（`expired` → 重新取码）
  同样走这条渲染。EC 级别 M、静区 4 模块、`shape-rendering="crispEdges"`。
  字节模式改用 UTF-8 编码（库默认逐字符截断为单字节，非 ASCII 载荷会被截坏成
  另一个字符串——码能扫出来但内容是错的）。
  新增 `test/qrcode-smoke.cjs`：用**独立手写的解码器**（格式信息 BCH、功能图形、
  zigzag 反掩码、RS 分块反交织与校验子、字节模式段解析）对生成的 SVG 做整码回环
  解码，4 组载荷（真实形状 ilink 链接 / v1 短码 / 非 ASCII / v32 长码含版本信息块）
  全部还原一致，双向互证编码与渲染均正确；新增 `test/login-qr-route.cjs`：
  以脚本化 ilink 网关驱动真实登录路由全链路（生成 → wait → expired 自动刷新 →
  网关故障 → 取消），断言每一步返回的 `qrcodeUrl` 都是内联 SVG data URL。
- **扫码登录在第一个二维码过期后卡死（评审发现的既有 client 缺陷，随本次一并修复）。**
  宿主报 `expired` 并自动换新码后，client 只换图、把状态置为 `expired`，而轮询 effect
  的守卫只放行 `wait`/`scaned`——轮询就此终止，新码上再次扫码的 `confirmed` 永远收
  不到，登录只能取消重来。现 `expired` 且带新码时状态回到 `wait` 并显式续排下一次
  轮询（`lib/client.js`）；无新码的终局 `expired`（会话超时删除）停止行为不变。新增
  `test/client-login-flow.cjs`：队列化定时器 + 手动渲染周期模拟 effect 生命周期，走完
  生成 → wait → expired 换码 → wait → confirmed 全流程（旧实现在 expired 处停摆，
  该用例会在第 3 次 status 轮询处失败）。
- **重启或保存设置后，既有会话的消息会因「会话已存在」而被丢弃。** 会话 id 由会话键确定性
  推导（`dsh-msg-<渠道>-<会话>`），因此进程重启后、以及**每次保存设置触发的适配器重载**
  （`disposeAdapters` 会清空进程内的会话/agent 映射）之后，插件会再次对同一个 id 调用
  `ctx.agents.create()`。而 DSH 的持久化契约规定 `create` 对已存在的 id 以
  `SessionAlreadyExistsError` 拒绝（`SessionPersistenceNotFoundError` 才是「不存在」），
  于是消息被丢弃、仅在渠道错误列表里留一条 `agent followup` 记录。
  现改为**先 `resume` 续接既有会话**，仅在确认没有已持久化会话时才 `create`；错误按 `name`
  判断，不引入对 DSH 内部类型的依赖。修复后同一飞书会话在重启/保存后**延续同一会话及其
  历史**。测试的 `ctx.agents` 替身原先永远 create 成功，掩盖了该缺陷；现已建模真实契约
  （重复 create 拒绝、缺失 resume 拒绝）并新增「重载后必须 resume」的回归用例。
- **会话标识出现双渠道前缀（`lark:lark:oc_xxx`，影响 discord / slack / lark / wecom）。**
  `sessionKey()` 无条件拼接渠道名，而这四个渠道传入的 `conversation` 本身已带渠道前缀
  （适配器发送时会剥掉它），于是 key 与会话 id 都多出一层，如 `dsh-msg-lark-lark-oc-…`。
  现改为：`conversation` 已以 `渠道名:` 开头时不再重复拼接。不带前缀的渠道（onebot 的
  `private:1001`、telegram 的数字 id）行为不变。
  **副作用**：既有会话的 key 与会话 id 会变化，同一会话将建立新的 DSH 会话（一次性）。
- **飞书入站事件被静默丢弃（长连接与 v2 webhook 均受影响）。** 事件类型原先只从
  `event.event.type`（v1 形状）读取，而飞书现在推送的是 **v2 事件**：类型在
  `header.event_type`，经 SDK 摊平后位于顶层 `event_type`，**没有 `type` 字段**。
  于是 `callback.type !== 'im.message.receive_v1'` 恒为真，每个事件都在解析前被丢弃——
  表现为长连接「连得上、心跳正常、零错误、却永远收不到消息」，且日志无任何线索。
  现按形状分别取类型与事件体（v2 在顶层，v1 在 `event` 之下），两条入站路径共用。
  同时修正发送者读取位置（v2 的 `sender` 在顶层，原先从 `message.sender` 读，恒为空）。
  测试原先用手写的 **v1 形状**驱动处理器，因此掩盖了该 bug；现改为**由真实 SDK 的
  `EventDispatcher` 生成 v2 形状**再喂给处理器，并补充 v2 webhook 用例。

### Added

- 静态 Host ESM：`lib/index.js`（companion 同步、渠道适配器、HTTP RPC、Origin/`::1` 鉴权）。
- 静态 Client：`lib/client.js`（`window.__ModuleLoader__` factory）。
- `test/http-routes.cjs`：Origin 拒绝 / 回环放行 / IPv6 `[::1]`。
- `package.json`：新增 `dependencies.ws`（Discord 网关 companion 用）与 `scripts.test`
  （`npm test` 串联 qrcode-smoke / login-qr-route / host-smoke / http-routes /
  client-smoke / client-login-flow 六项）。
- **飞书渠道新增长连接（WebSocket）订阅方式，并作为默认。** `adapters.lark.mode` 取值
  `long-connection`（默认）或 `webhook`。长连接下用户只需 `appId` + `appSecret`：SDK 只在
  建连时鉴权，飞书推送的事件是明文，因此**不需要公网地址、不需要 `verificationToken`、
  不需要 `encryptKey`**（[官方说明](https://open.larkoffice.com/document/server-side-sdk/nodejs-sdk/handling-events.md)）。
  这是「用户只暴露 appId / appSecret」目标唯一能完全达成的路径。
  新增运行时依赖 `@larksuiteoapi/node-sdk@^1.74.0`（长连接需 ≥1.24.0；约 29 MB）。
  已知约束（飞书侧规定）：仅支持企业自建应用；事件需 3 秒内处理完；每应用最多 50 个连接；
  集群模式推送，同应用多实例只有随机一个收到。

### Changed

- **飞书渠道改由 `adapters.lark.mode` 决定入站方式。** 默认 `long-connection` 时用户只需
  `appId` / `appSecret`；改为 `webhook` 时，`verificationToken` 与 `encryptKey` 仍由**用户
  自行填写**，插件不做生成、改写或校验它们的一致性——取值必须与飞书控制台「事件与回调」
  一致，因为这两个凭据本就是两端的共享值（Encrypt Key 由控制台生成，只能复制）。
  设置页里这两个字段（以及 `webhookPath`）标记为 `webhookOnly`，长连接方式下不显示。
- 设置页飞书卡片按 `mode` 展示不同说明：长连接显示「只需 App ID / App Secret」及「需先有
  客户端建连才能在飞书侧保存该订阅方式」；webhook 显示「凭据须自行从控制台复制并两端一致」
  的填写指引。

### 澄清：webhook 鉴权的既有语义

`handleLarkEvent` 的判定顺序是既有的，本次未改，但易被误解，故记录：

- 配了 `verificationToken`：只比对回调 body 的 `token`（常量时间比较），**不要求** payload 加密；
- 只配 `encryptKey`：要求 payload 能被该密钥解密（明文 payload 会被拒）；
- 两个都配：**只走令牌比对**，不额外要求加密；密文 payload 在解密成功后仍会走同一条令牌比对。

也就是说，`verificationToken` 优先于 `encryptKey`，二者并非「都填即最严」。若飞书侧开启加密
推送，回调 body 只有 `encrypt`（无 `token`），此时**不要**配 `verificationToken`，否则请求会被
令牌比对拒掉——这是按解密路径鉴权的场景。

### Known limitations

- 长连接方式的连接失败（例如 appId 无效）只由 SDK 内部日志报告，不会触发 `onError`、
  连接状态也停留 `idle`。因此这一类失败不会进入渠道状态的错误列表，目前只能从宿主进程
  日志中看到（实测：`[error]: [ '[ws]', 'invalid appId: …' ]`）。
- 个人微信走腾讯 ilink Bot API（与 Tencent/openclaw-weixin 同协议），属非官方接入，
  稳定性随微信侧策略波动；入站以文本消息为主，媒体/语音/文件暂未处理。
- `messaging_status` agent 工具未随静态化迁移（见 Breaking）。

### Migration from 0.1.x

1. 安装 0.2.0（`dsh plugin --profile web add dsh-messaging@0.2.0` 或本地目录）。
2. 重启 DSH。
3. 打开 Cordis 面板，删除任何 `dshmsg-*` 动态插件。
4. 打开设置 → 「消息通道配置」应已自动出现。
5. 若要继续使用 OneBot webhook 入站：在设置页填入 `adapters.onebot.secret`（与 OneBot 实现的上报签名密钥一致），否则 0.2.0 会拒绝注册 webhook 路由（安全修复）。
