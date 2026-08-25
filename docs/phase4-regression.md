# Phase 4 回归报告

日期：2026-08-25  
仓库：`D:\AI Workspace\DeepsSeek Harness\dsh-messaging`（未提交，版本号仍为 `0.1.2`，发版在 Phase 5）

## 清理

- 已删除 `dynamic/`（`host.js` / `client.js` / `manifest.json`）。
- `package.json` `files` 不含 `dynamic/`。
- tarball 内容：`lib/index.js`、`lib/client.js`、`companion/`、`cordis.patch.yml`、`config.example.json`、`README.md`。无 `dynamic/`。
- `cordis.patch.yml` id = `dsh-messaging`（不再是 `dshmsg-boot`）。

## 自动化测试

```
node --check lib/index.js
node --check lib/client.js
node test/http-routes.cjs    # Origin 拒绝 / 回环 / [::1]
node test/host-smoke.cjs     # 静态 Host + OneBot inbound/outbound followup
node test/client-smoke.cjs   # ModuleLoader；挂载只 GET config；Save 才 POST
```

全部通过。测试用 `ctx.get('dshMessaging.root')=/mock/workspace`，未写真实 home。

## 本机安装验证（已做）

环境：Windows，`DSH_HOME=C:\Users\shx\.dsh`，CLI 为 DeepRein 随包 Node + `@deepseek-ai/dsh@0.1.0-rc.6`。

1. `pnpm pack` → `C:\Users\shx\.dsh\profiles\web\.deeprein\plugins\dsh-messaging-0.1.2.tgz`  
   注意：同版本号下 `dsh plugin add` 会判定 Already up to date。先 `plugin remove dsh-messaging` 再 `add <tgz>` 才换上静态包。Phase 5 必须 bump 到 `0.2.0`。
2. 安装后 `node_modules/dsh-messaging`：
   - 有 `dsh.client.platform=web` 与 `exports["./client"]`
   - 有 `lib/client.js` ModuleLoader bundle
   - Host 注释为「静态 Host 半区」
   - **无** `dynamic/`
3. `dsh --profile web --dump-config` 组成树末尾为：
   ```
   - id: dsh-messaging
     name: dsh-messaging
   ```
   无 `dshmsg-boot` / `dshmsg-*`。profile `dsh.profile.bundles` 含 `dsh-messaging`。

## 未做的真机 UI 项（阻塞完整发版，不阻塞本阶段代码清理）

本环境没有启动完整 DSH Web GUI（未跑 `dsh web` / DeepRein 主窗口），因此下列只能文档化，留给 Phase 5 或人工点验：

| 项 | 状态 |
|---|---|
| 重启 DSH 后设置页自动出现 | 未点验。静态声明 + dump-config 已挂上，按官方 client-modules 扫描应自动注入。 |
| OneBot 真收发 | 未对真实 OneBot 服务。`host-smoke` 覆盖 webhook 入站 + curl 出站。 |
| 微信扫码 | 未对真实 iLink。HTTP 路由与 client `rpc()` 映射已测。 |
| 设置页保存 + 重载 | client-smoke 覆盖 GET config / POST config。 |
| Cordis 面板无旧动态条目 | dump-config 无 `dshmsg-*`。若用户曾经手动 Run 过 0.1.x 动态插件，面板里可能仍有会话级残留，需手动删（CHANGELOG Breaking）。 |

## 升级注意

同版本号 tarball 替换必须先 remove 再 add。发 0.2.0 后 `dsh plugin add dsh-messaging@0.2.0` 即可。
