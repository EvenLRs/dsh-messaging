# Changelog

## 0.2.0 (unreleased)

纯静态插件架构。设置页随 DSH Web profile 启动自动出现。Phase 5 发版时再把 `package.json` 版本从 `0.1.2` 改为 `0.2.0`。

### Breaking

- **设置页不再需要手动 Run。** Host 与 Client 都是静态半区：loader 直接 `apply` Host，`dsh.client` 自动注入 Client bundle。升级后打开设置即可看到「消息通道配置」。
- **Cordis 面板里旧的 `dshmsg-*` 动态条目必须手动删除。** 0.1.x 启动壳会 `define()` 出会话级动态插件；升级后若残留，会与静态实例双开（双份 webhook / 轮询）。patch id 从 `dshmsg-boot` 改为 `dsh-messaging`。
- 动态 `host.call` / `harness.handle` 已移除。Client 只走同源 HTTP：`/__dsh-messaging/{status,config,reload,send,ilink/login/*}`，Origin 必须是回环地址。
- `messaging_status` agent 工具（`harness.defineTool`）暂未迁到静态 `@deepseek-ai/dsh-tools`；需要 agent 读网关状态时请用 HTTP 或后续补回。
- 安装包不再包含 `dynamic/`。

### Added

- 静态 Host ESM：`lib/index.js`（companion 同步、渠道适配器、HTTP RPC、Origin/`::1` 鉴权）。
- 静态 Client：`lib/client.js`（`window.__ModuleLoader__` factory）。
- `test/http-routes.cjs`：Origin 拒绝 / 回环放行 / IPv6 `[::1]`。

### Migration from 0.1.x

1. 安装 0.2.0（`dsh plugin --profile web add dsh-messaging@0.2.0` 或本地目录）。
2. 重启 DSH。
3. 打开 Cordis 面板，删除任何 `dshmsg-*` 动态插件。
4. 打开设置 → 「消息通道配置」应已自动出现。
