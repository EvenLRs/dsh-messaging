# dsh-messaging 静态插件改造调研

- 日期：2026-08-25
- 范围：评估能否把 `dsh-messaging` 从「静态启动壳 + 动态双半区」改成真正的静态 host/client 插件，解决 **Client 半区需用户手动 Run** 的问题。
- 工作副本：`D:\AI Workspace\DeepsSeek Harness\dsh-messaging`（`dsh-messaging@0.1.2`，commit `7f0c3b8` / `985196f`）
- 对照实现：DeepRein 已落地的静态插件 `@deeprein/host-bridge`、`@deeprein/update-checker`，以及官方/社区静态包 `dshmarket`、`dsh-mnemon`、`dsh-better-sidebar`
- 任务所列参考文档（`memory/dsh-plugin-spec-and-messaging-gap.md` 等）在当前工作区不存在；下列结论以仓库源码与已安装的 `@deepseek-ai/dsh@0.1.0-rc.6` 为准。

---

## 结论

**可以改，而且值得改；不是「从零补 package.json」，而是拆掉动态半区。**

当前包已经是可被 DSH 静态加载的 **npm 插件**：

| 官方静态充分条件 | 现状 |
|---|---|
| `package.json` + `main` | 有，`lib/index.js` |
| `dsh.bundle.patch` + `cordis.patch.yml` | 有，insert `dshmsg-boot` → `dsh-messaging` |
| host 半区 ESM `export { name, inject, apply }` | 启动壳已满足；真正业务在动态 VM 里 |
| `exports["./client"]` + `dsh.client.platform=web` | **没有** —— 所以 Web UI 不走静态 client 扫描 |
| `__ModuleLoader__` client bundle | **没有** —— 设置页走动态 `clientCode` |

用户痛点不是「插件没装上」，而是：

1. Host 业务被 `dynamicCordisRunner.define()` 进 **会话级动态插件**，源码在内存，重启后要靠启动壳再 define + `runHostHalf`。
2. 动态插件的 **Client 半区受官方安全模型限制，不能随 Host 静默激活**；必须用户在 Cordis 面板点 Run。这是 README 写明的已知限制，也是这次改造要解决的问题。
3. `dynamic/manifest.json` 只是本项目自用元数据（`hostSource` / `clientSource`），**DSH 官方加载器不读它**。

改造的充分条件不是再补一份 `package.json`，而是：

- 把 `dynamic/host.js` 的 `apply(ctx)` 迁到静态 host 入口（直接用真实 `ctx`，不再走 VM façade / `harness.*`）。
- 把 `dynamic/client.js` 改成官方静态 client bundle，并声明 `dsh.client`。
- 用 **同源 HTTP**（或其它静态可用通道）替换动态专用的 `host.call` / `harness.handle`。
- 删除启动壳里的 `define()` / `runHostHalf` / bootstrap 会话。

工作量中等偏大（host ~1668 行、client ~765 行，外加 RPC 改道），但路径清晰，社区已有同类先例（`dshmarket`）。

**建议：做。** 这是解决「每次重启后设置页要手动 Run」的唯一稳妥办法；继续叠动态壳解决不了官方安全模型。

---

## 1. 当前架构（动态半区为什么重启不恢复 Client）

### 1.1 其实已经是「静态包 + 动态插件」两层

```
dsh plugin add dsh-messaging
        │  pnpm add + reconcile dsh.profile.bundles
        ▼
web profile 启动
        │  读取 dsh.bundle.patch = cordis.patch.yml
        ▼
静态 host 插件  id=dshmsg-boot  name=dsh-messaging
        │  lib/index.js apply(ctx)
        │  ① 同步 companion → ~/.dsh-messaging/companion
        │  ② 预置 ~/.dsh-messaging/config.json
        │  ③ ctx.interval 等到 agents + dynamicCordisRunner
        ▼
agents.create({ sessionId: 'dsh-messaging-bootstrap' })   ← 会话级、内存
        │
runner.define({
  plugin: { kind: 'new', idPrefix: 'dshmsg' },
  code: { host: dynamic/host.js, client: dynamic/client.js }
})                                                        ← 源码进内存 Package
        │
runner.runHostHalf(..., 'run', null, false)               ← 只自动跑 Host
        │
Host 半区在线（webhook / 轮询 / Discord 子进程）
Client 半区：官方禁止静默 Run → 用户必须在 Cordis 面板手动激活
```

关键代码：

- 启动壳：`lib/index.js:96-161`（`define` + `runHostHalf`；注释写明 Client 需手动 Run）
- 动态 host 工厂：`new Function('harness', hostSource)` 形态（`test/host-smoke.cjs:16-17`），`inject = ['webServer','shell','fs','agents','timer','agentDefaultModel']`
- 动态 client 工厂：`new Function('React','host', clientSource)`（`test/client-smoke.cjs`），`host.call('messaging_*')`
- patch：`cordis.patch.yml` 只插入启动壳，不插入动态 plugin id

### 1.2 「重启不恢复」具体指什么

| 层 | 重启后 |
|---|---|
| npm 包 / profile.bundles / `dshmsg-boot` | 恢复。ensure-plugin / `dsh plugin add` 已经把它当静态包装进 web profile。 |
| Host 业务（消息收发） | **能恢复。** 启动壳每次进程启动都会重新 `define` + `runHostHalf`。用户不需要点任何按钮，网关会再上线。 |
| Client 设置页 / 状态面板 | **不恢复。** 动态 Client 半区必须用户手势激活；Cordis 面板的 Run 状态不写入 profile，刷新/重启后要再点一次。 |
| `define()` 产出的 pluginId / packageId | 不持久。每次都是 `kind: 'new'`，新的动态插件身份。 |

所以任务描述里的「define() + 内存激活，重启不恢复」对 **Client UI** 成立，对 **Host 网关** 不完全成立。用户感知到的问题几乎全是设置页。

### 1.3 官方为什么禁止自动跑 Client

`@deepseek-ai/dsh-cordis-host-runner` 把动态插件分成 Host / Client 两半：

- Host：在 Node VM 里跑，façade 白名单（`ctx.webServer` / `ctx.shell` / `ctx.fs` / `harness.handle` / `harness.defineTool`）
- Client：浏览器拉 `getClientCode()`，再单独激活；`runHostHalf` 即使 `requestId=null`（启动壳这条路径）也只批 Host，并把 client package 记入 `approvedClientPackages`，**不等于替用户 Run Client**

这是安全模型，不是 dsh-messaging 的 bug。继续留在动态体系里，无法用启动壳「顺便把 Client 也 run 了」来绕过。

---

## 2. 静态插件充分条件（官方实际读取的字段）

DSH 加载器认的是 **npm 包声明**，不是 `dynamic/manifest.json`。

### 2.1 Host 静态挂载

来源：`dsh.bundle.patch` → profile `dsh.profile.bundles` → 启动时 merge patch。

```yaml
# cordis.patch.yml（官方读取）
- insert:
    - id: <唯一 id>
      name: '<package.json name>'
```

`package.json` 需要：

```json
{
  "name": "dsh-messaging",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

host 入口必须是 ESM：

```js
export const name = 'dsh-messaging'
export const inject = [/* 真实服务名 */]
export function apply(ctx) { /* 直接用 ctx，不是 harness façade */ }
```

DeepRein 的 `ensure-plugin.mjs` 会在 `pnpm add` 之后 `reconcileBundles()`：只要安装包声明了 `dsh.bundle.patch`，就把包名推进 `dsh.profile.bundles`。所以静态 host 一旦声明正确，随壳分发/用户 `dsh plugin add` 都能自动挂载。

### 2.2 Client 静态半区

来源：`@deepseek-ai/dsh-client-modules` 扫描 **已激活的 loader 条目**：

1. `package.json.dsh.client.platform === "web"`
2. `exports["./client"]` 指向磁盘上的 bundle 文件
3. 该 bundle **必须**是 `window.__ModuleLoader__.load({ id, factory })`（浏览器原样下发，不是 ESM）
4. `dsh.client.inject` 是 **包名边**（如 `@deepseek-ai/dsh-client-ui-settings`），给 boot graph 做边；factory 内部的 `export const inject` 才是 cordis 服务名（如 `slots` / `locale`）

设置页注册惯例（`dshmarket` / `update-checker` / `dsh-mnemon`）：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'messaging',
  order: 25,
  label: () => t('settings.title'),
  locale: NS,
}, MessagingSettingsSection))
```

满足以上条件后，client 随 web profile 启动自动进 `__DSH_BOOT__`，**不需要 Cordis 面板手动 Run**。这正是本次改造要换到的轨道。

### 2.3 任务里的「技术缺口」对照（已过时）

| 任务原述缺口 | 2026-08 仓库实情 |
|---|---|
| 独立仓库缺 `package.json` | 已有，且已发 npm `dsh-messaging@0.1.2` |
| 缺 `cordis.patch.yml` / `lib/` | 已有。`lib/index.js` 是启动壳，不是业务 host |
| `manifest.json` 非官方规范 | 仍然正确：官方不读 `dynamic/manifest.json` |

真正缺口是 **业务代码仍是动态工厂源码**，以及 **没有 `dsh.client` / `exports["./client"]`**。

---

## 3. 改造方案

### 3.1 目标形态

```
dsh-messaging/
├── package.json            + exports["./client"] + dsh.client
├── cordis.patch.yml        id 建议改为 dsh-messaging（可保留 dshmsg-boot 一版兼容）
├── lib/
│   ├── index.js            静态 host：原 dynamic/host.js 的 apply + companion 同步
│   └── client.js           静态 client：__ModuleLoader__ factory
├── companion/              不变
├── config.example.json     不变
└── test/                   host-smoke / client-smoke 改为加载 ESM / ModuleLoader
```

`dynamic/` 在过渡期可留作对照，稳定后删除。`dynamic/manifest.json` 不再需要。

### 3.2 必补 / 必改清单

**A. `package.json`**

- `exports["./client"] = "./lib/client.js"`（或 `./client/client.js`，与 dshmarket 二选一）
- `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-slots"] }`
- `files` 纳入 client bundle
- 可选 peer：`react`、上述 `@deepseek-ai/dsh-client-*`（静态 client 用 `require()` 从 ModuleLoader 表取，不进 tarball）

**B. Host：`lib/index.js` 吃掉 `dynamic/host.js`**

启动壳里仍要保留、且应在 `apply()` 开头做的：

- 同步 `companion/*.cjs` → `~/.dsh-messaging/companion`
- 若无配置则预置 `~/.dsh-messaging/config.json`（`nodePath` / `wsModulePath` / `companionDir`）

删掉：

- `agents.create` bootstrap 会话
- `dynamicCordisRunner.define` / `runHostHalf` / `undefine`
- `CONFIG_ROOT_OVERRIDE` 字符串替换（改成 host 里直接 `homedir()`）
- 对 `timer` 的轮询等待（静态 apply 时 `webServer`/`shell`/`agents` 已可 `inject`）

`dynamic/host.js` 迁移注意：

1. 去掉 `return { name, inject, apply }` 工厂包装，改 ESM `export`。
2. `inject` 改为真实 cordis 服务名，与现在动态声明一致即可：`webServer, shell, fs, agents, timer, agentDefaultModel`。
3. **`harness.defineTool` / `harness.registerTool` / `harness.handle` 全部替换。**
   - 工具：改用静态插件常规的 `@deepseek-ai/dsh-tools` `defineTool`（若要保留 `messaging_status` 给 agent 用）。
   - UI RPC：不要再走动态 `host.call`。改为 `ctx.webServer.register` 一组同源路径，例如：
     - `GET  /__dsh-messaging/status`
     - `GET  /__dsh-messaging/config`
     - `POST /__dsh-messaging/config`
     - `POST /__dsh-messaging/reload`
     - `POST /__dsh-messaging/send`
     - `POST /__dsh-messaging/ilink/login/{start,status,verify,cancel}`
   - 鉴权对齐 host-bridge：Origin === 回环 Host，不把文件系统 token 塞给浏览器。
4. `ctx.fs` / `ctx.shell` / `ctx.webServer` / `ctx.agents.create` 在静态 host 上是真服务，语义与 façade 接近，但 **不再有 VM 白名单**——`danger-full-access` 的 shell 调用会以插件身份直接跑。这是能力，也是风险（见 §4）。
5. `joinPath` 手写路径可继续用，不必引入 `node:path`（动态源码刻意不 import Node 模块，迁静态后可用 `node:fs`/`node:path` 简化 companion 同步）。

**C. Client：`lib/client.js` 吃掉 `dynamic/client.js`**

1. 包成 `window.__ModuleLoader__.load({ id: "dsh-messaging", factory })`。
2. `require("react")`，不要依赖动态注入的全局 `React` / `host`。
3. `export const inject = ['slots', 'locale']`（以及若用 connection/remote 再加）。
4. `host.call('messaging_*')` → `fetch('/__dsh-messaging/...', { credentials: 'same-origin' })`。
5. 设置页 `settings.section` 的 `id: 'messaging'`、`order: 25` 可保持，避免已有用户习惯跳动。
6. `tool.view.cordis` 状态面板：静态插件同样可以 `slots.inject('tool.view.cordis', ...)`；若官方 cordis 工具页只展示动态插件，则状态信息改放到设置页内（推荐，少一个手动入口）。

**D. Patch id**

- 现 id `dshmsg-boot` 名不副实。改为 `dsh-messaging` 更干净。
- 兼容：若用户 profile 已有 `dshmsg-boot`，ensure-plugin 的 bundles 列表存的是 **包名** `dsh-messaging` 而不是 patch id；id 冲突风险在 profile 自己的 patch 层。发布时在 README 写明：旧动态 pluginId（`dshmsg-*`）会残留在 Cordis 面板，可手动删，不影响静态实例。

**E. 测试**

- `host-smoke.cjs`：改为 `import()` ESM host，mock `ctx.webServer.register` / `ctx.shell` / `ctx.fs` / `ctx.agents`，断言路由表而不是 `harness.handle`。
- `client-smoke.cjs`：改为 VM 跑 `__ModuleLoader__`（可直接抄 `plugins/deeprein-update-checker/test/client-smoke.cjs`），断言 `settings.section` 注册、首渲零请求、按钮才 fetch。

**F. DeepRein 随壳分发**

`deeprein/scripts/bundle-backend.mjs` 已有 `{ name: 'dsh-messaging', spec: 'dsh-messaging@0.1.2' }`。发新版后只需 bump spec；本地联调可改成 `local: join(root, '..', 'dsh-messaging')`。不需要改 ensure-plugin 逻辑。

### 3.3 建议实施顺序

1. **先做静态 client 所需的 HTTP RPC**（host 仍可暂时留在动态半区，并行挂同一组路由）——可单独验证 Origin 校验与设置页。不推荐长期双栈。
2. **host 迁静态 ESM**，启动壳变成「companion 同步 + apply 业务」，删除 define/runHostHalf。此时消息网关已不依赖动态插件。
3. **client 迁 `__ModuleLoader__` + `dsh.client`**，设置页自动出现。
4. 删 `dynamic/`，升版本（建议 `0.2.0`，行为对用户是 breaking：Cordis 面板里的旧动态条目失效）。
5. DeepRein bump 打包版本，走现有 Reviewer 流程。

不要试图「静态 host + 继续动态 client」作为终态：Client 手动 Run 的问题会原样留下。

### 3.4 明确不做的事

- 不把 `dynamic/manifest.json` 当成官方入口去「补全规范」——那条路不通。
- 不在启动壳里伪造用户手势去 `runClientHalf`——会和官方安全模型对着干，审计过不了。
- 不把 client 写成 ESM 直接 `export function apply`。`dsh-client-modules` 是按文件内容当 `__ModuleLoader__` factory 下发的；ESM 在浏览器会直接语法失败（`update-checker` 已踩过这个约定）。

---

## 4. 风险评估

| 风险 | 级别 | 说明 | 缓解 |
|---|---|---|---|
| Host 失去 VM 沙箱 | **高** | 动态 host 跑在 façade 白名单里；静态 host 是进程内真插件，`ctx.shell.run({ sandboxPolicy: danger-full-access })` 以 DSH 进程权限执行 companion/curl。 | 保持现有命令构造（`pwshQuote` / 参数数组）；webhook 入站鉴权不能回退（Slack 仍无签名，静态后同样不能暴露公网）；新增 HTTP RPC 必须 Origin/回环校验。 |
| `host.call` 语义丢失 | **高** | 设置页、微信扫码、保存配置全部走动态 RPC。漏迁一个 method 就造成静默功能空洞。 | 先列出 `harness.handle` 全表（见下），逐个做 HTTP 对照测试；client-smoke 覆盖每个按钮。 |
| `ctx.agents.create` 会话模型变化 | 中 | 动态 host 在 bootstrap 会话里 `ensureAgent`。静态 host 的 `ctx.agents` 是全局服务，创建的会话不再挂在 `dsh-messaging-bootstrap` 下。 | 需要实测入站消息是否仍能 `followup` 到正确 conversation；必要时显式 `sessionId` 前缀 `dshmsg-`。 |
| Client 包格式错误 | 中 | 写成 ESM / 漏 `dsh.client` / `exports["./client"]` 条件字段不对，启动期 `client-modules` 会 throw `declares dsh.client but exports no "./client" bundle`，严重时拖垮 web 前端。 | 对照 `update-checker`/`dshmarket`；`platform` 必须是 `"web"` 字符串。 |
| 旧动态实例残留 | 中 | 已手动 Run 过的用户，Cordis 面板可能仍显示 `dshmsg-*`。和新静态实例双开 → 双份 webhook、双份轮询。 | 0.2.0 changelog 写清；启动时检测并 log；可选在静态 apply 里不兼容旧 idPrefix。 |
| patch id 更名 | 低 | `dshmsg-boot` → `dsh-messaging`。bundles 按包名 reconcile，一般不炸。 | 保留旧 id 也能工作；更名非必须。 |
| Discord `ws` | 低 | 现有问题，与静态/动态无关：包未声明 `ws`，靠 `require.resolve('ws')` 或配置路径。 | 静态化时可把 `ws` 写成 optionalDependency，不阻塞改造。 |
| DeepRein 打包 | 低 | 只 bump `dsh-messaging@x.y.z`。 | 不改 ensure-plugin。 |
| 测试负债 | 中 | 目前除 OneBot 外渠道无自动化。静态化不会改善渠道正确性，但会打乱现有 smoke 的 `new Function` 加载方式。 | 迁移同时改 smoke；不要承诺七渠道等价可用。 |

`harness.handle` 全表（必须有静态等价物）：

- `messaging_status` / `messaging_get_config` / `messaging_set_config` / `messaging_reload` / `messaging_send`
- `config-get` / `config-set`（与 get/set_config 重复，可合并）
- `ilink_login_start` / `ilink_login_status` / `ilink_login_verify` / `ilink_login_cancel`
- `harness.defineTool('messaging_status')`（agent 工具，独立于 UI RPC）

---

## 5. 动态 vs 静态对比

| | 当前：静态壳 + 动态双半区 | 改造后：真静态 host + 静态 client |
|---|---|---|
| 安装 | `dsh plugin add` / DeepRein ensure-plugin | 相同 |
| Host 随进程启动 | 是（启动壳自动 runHostHalf） | 是（loader 直接 apply） |
| 设置页随进程启动 | **否，必须手动 Run** | **是** |
| 重启后 UI | 丢失 | 恢复 |
| 代码驻留 | host/client 源码字符串在动态 Package 内存 | 磁盘 ESM + client bundle |
| 热更新插件源码 | 理论上可 redefine（当前未用） | 需重装包 / 重启 |
| 安全边界 | Host 在 VM façade 内 | Host 与其它静态插件同权 |
| 官方支持面 | 动态插件是「用户/模型定义的临时包」通道 | 正统第三方插件通道（dshmarket 同款） |
| Client 通信 | `host.call` / `harness.handle` | 同源 `fetch` 或 connection.rpc |
| 对 DeepRein 的适配 | 已随壳分发，但设置页仍要教用户点 Run | 与 `update-checker` 一样打开设置即可见 |
| 实现复杂度 | 启动壳 + 动态源码两套生命周期 | 一套生命周期，client 要打 ModuleLoader 包 |

动态方案的唯一真实优点是：Host 跑在 VM 白名单里，误用 `ctx` 内部字段会被 façade 挡掉。dsh-messaging 已经大量使用 `danger-full-access` shell 和 webhook，这个优点很薄，却用「每次打开设置都要点 Run」换。

---

## 6. 工作量估计（供排期，非承诺）

| 步骤 | 规模 |
|---|---|
| Host ESM 化 + 去掉工厂包装 / CONFIG_ROOT 替换 | 小（机械） |
| `harness.handle` → HTTP 路由 + Origin 校验 | 中 |
| `defineTool` 迁到静态 tools API | 小 |
| Client 改 ModuleLoader + fetch | 中（UI 本身可基本原样搬） |
| smoke 测试重写 | 小到中 |
| 真机：安装、重启、设置页、OneBot 收发、微信扫码 | 中（阻塞项） |
| 发 npm `0.2.0` + DeepRein bump | 小 |

没有未知平台 API；卡点是 RPC 改道与真机回归，不是「DSH 能不能静态加载」——已经能。

---

## 7. 建议决策

1. **立项做静态化**，目标版本 `dsh-messaging@0.2.0`，changelog 标明：设置页自动出现；Cordis 面板里旧的 `dshmsg-*` 动态条目应删除。
2. **不要**再投入启动壳去「自动点 Client Run」。
3. 若只想快速缓解 DeepRein 用户体验、暂不动独立仓库：不可行。DeepRein 装的就是这个 npm 包，壳解决不了动态 Client 安全模型。
4. Slack 入站无签名、Discord 缺 `ws` 依赖是既有问题，可顺手记到 0.2.0，但不是静态化的阻塞项。

报告完。未改业务代码、未发版、未提交。
