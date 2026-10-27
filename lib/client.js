// dsh-messaging 静态 Client 半区。
// 由 dsh-client-modules 按 exports["./client"] 原样下发给浏览器，必须是
// window.__ModuleLoader__ factory（不能写成 ESM）。
window.__ModuleLoader__.load({
  id: 'dsh-messaging',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    const CHANNELS = [
      { key: 'onebot', label: 'channel.onebot' },
      { key: 'telegram', label: 'channel.telegram' },
      { key: 'discord', label: 'channel.discord' },
      { key: 'slack', label: 'channel.slack' },
      { key: 'lark', label: 'channel.lark' },
      { key: 'wecom', label: 'channel.wecom' },
      { key: 'wechat', label: 'channel.wechat' },
    ]

    const CHANNEL_FIELDS = {
      onebot: [
        { key: 'endpoint', label: 'field.onebot.endpoint', type: 'text' },
        { key: 'accessToken', label: 'field.onebot.accessToken', type: 'password' },
        { key: 'secret', label: 'field.onebot.secret', type: 'password' },
        { key: 'webhookPath', label: 'field.onebot.webhookPath', type: 'text' },
        { key: 'selfId', label: 'field.onebot.selfId', type: 'number' },
      ],
      telegram: [
        { key: 'token', label: 'field.telegram.token', type: 'password' },
        { key: 'mode', label: 'field.telegram.mode', type: 'select', options: ['polling', 'webhook'] },
        { key: 'webhookSecret', label: 'field.telegram.webhookSecret', type: 'password' },
        { key: 'webhookPath', label: 'field.telegram.webhookPath', type: 'text' },
        { key: 'pollIntervalMs', label: 'field.telegram.pollIntervalMs', type: 'number' },
        { key: 'longPollTimeoutSec', label: 'field.telegram.longPollTimeoutSec', type: 'number' },
        { key: 'dropPendingUpdates', label: 'field.telegram.dropPendingUpdates', type: 'boolean' },
      ],
      discord: [
        { key: 'botToken', label: 'field.discord.botToken', type: 'password' },
        { key: 'intents', label: 'field.discord.intents', type: 'number' },
        { key: 'wsModulePath', label: 'field.discord.wsModulePath', type: 'text' },
      ],
      slack: [
        { key: 'botToken', label: 'field.slack.botToken', type: 'password' },
        { key: 'signingSecret', label: 'field.slack.signingSecret', type: 'password' },
        { key: 'verificationToken', label: 'field.slack.verificationToken', type: 'password' },
        { key: 'webhookPath', label: 'field.slack.webhookPath', type: 'text' },
      ],
      lark: [
        { key: 'appId', label: 'field.lark.appId', type: 'text' },
        { key: 'appSecret', label: 'field.lark.appSecret', type: 'password' },
        { key: 'mode', label: 'field.lark.mode', type: 'select', options: ['long-connection', 'webhook'] },
        { key: 'interactiveCard', label: 'field.lark.interactiveCard', type: 'boolean-select' },
        // webhookOnly: 长连接方式下不显示，避免把无关凭据摆给用户（见 renderChannel）。
        { key: 'verificationToken', label: 'field.lark.verificationToken', type: 'password', webhookOnly: true },
        { key: 'encryptKey', label: 'field.lark.encryptKey', type: 'password', webhookOnly: true },
        { key: 'webhookPath', label: 'field.lark.webhookPath', type: 'text', webhookOnly: true },
      ],
      wecom: [
        { key: 'corpId', label: 'field.wecom.corpId', type: 'text' },
        { key: 'agentId', label: 'field.wecom.agentId', type: 'text' },
        { key: 'secret', label: 'field.wecom.secret', type: 'password' },
        { key: 'token', label: 'field.wecom.token', type: 'password' },
        { key: 'encodingAESKey', label: 'field.wecom.encodingAESKey', type: 'password' },
        { key: 'webhookPath', label: 'field.wecom.webhookPath', type: 'text' },
      ],
      wechat: [
        // P2b：微信 token 改由扫码登录写入凭据 record，不再从表单读写。
        { key: 'baseUrl', label: 'field.wechat.baseUrl', type: 'text' },
        { key: 'baseUrl', label: 'field.wechat.baseUrl', type: 'text' },
        { key: 'botAgent', label: 'field.wechat.botAgent', type: 'text' },
        { key: 'pollIntervalMs', label: 'field.wechat.pollIntervalMs', type: 'number' },
        { key: 'longPollTimeoutSec', label: 'field.wechat.longPollTimeoutSec', type: 'number' },
      ],
    }

    const LOCALE_NS = 'dsh-messaging'

    const LOCALE_DICTS = {
      zh: {
        'channel.onebot': 'OneBot v11',
        'channel.telegram': 'Telegram',
        'channel.discord': 'Discord',
        'channel.slack': 'Slack',
        'channel.lark': '飞书 / Lark',
        'channel.wecom': '企业微信',
        'channel.wechat': '个人微信',
        'settings.title': '消息通道配置',
        'settings.reload': '重新加载',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.saved': '已保存，适配器已重载',
        'settings.conflict': '配置已被其他地方修改，已重新加载',
        'settings.unavailable': '配置暂不可用',
        'settings.readOnly': '当前配置为只读',
        'settings.saveFailed': '保存失败，请重试',
        'plugin.summary': '配置消息通道、扫码登录与入站凭据',
        'settings.loading': '正在加载配置…',
        'settings.error': '错误：{msg}',
        'settings.notice': '配置写入 Host 的 profile，保存后立即生效。',
        'settings.enabled': '已启用',
        'settings.disabled': '已禁用',
        'settings.enableField': '启用',
        'settings.yes': '是',
        'settings.no': '否',
        'settings.secretSet': '已设置（留空保持不变）',
        'settings.secretClear': '清除',
        'settings.secretUndoClear': '撤销清除',
        'settings.secretClearPending': '保存后将清除该密钥',
        'panel.title': 'dsh-messaging 网关',
        'panel.reload': '重新加载',
        'panel.reloading': '重载中…',
        'panel.inOut': '入 {in} / 出 {out}',
        'panel.lastError': '最后错误：{msg}',
        'panel.sessions': '会话（{n}）',
        'panel.recent': '最近动态',
        'panel.sessionRow': '{channel} · {conversation} · 消息 {n}',
        'panel.eventRow': '{kind} · {channel} · {text}',
        'field.onebot.endpoint': 'OneBot 端点',
        'field.onebot.accessToken': '访问令牌（API调用）',
        'field.onebot.secret': '上报签名密钥（X-Signature）',
        'field.onebot.webhookPath': 'Webhook 路径',
        'field.onebot.selfId': '自身 ID（回显抑制）',
        'field.telegram.token': '机器人令牌',
        'field.telegram.mode': '模式',
        'field.telegram.webhookSecret': 'Webhook 密钥（secret_token）',
        'field.telegram.webhookPath': 'Webhook 路径',
        'field.telegram.pollIntervalMs': '轮询间隔（毫秒）',
        'field.telegram.longPollTimeoutSec': '长轮询超时（秒）',
        'field.telegram.dropPendingUpdates': '丢弃待处理更新',
        'field.discord.botToken': '机器人令牌',
        'field.discord.intents': '网关意图',
        'field.discord.wsModulePath': 'ws 模块路径',
        'field.slack.botToken': '机器人令牌',
        'field.slack.signingSecret': '签名密钥',
        'field.slack.verificationToken': '验证令牌',
        'field.slack.webhookPath': 'Webhook 路径',
        'field.lark.appId': '应用 ID',
        'field.lark.appSecret': '应用密钥',
        'field.lark.mode': '订阅方式',
        'field.lark.interactiveCard': '是否启用交互式卡片',
        'field.lark.verificationToken': '验证令牌（Verification Token）',
        'field.lark.encryptKey': '加密密钥（Encrypt Key，可留空）',
        'field.lark.webhookPath': 'Webhook 路径',
        'lark.setup.titleLong': '飞书订阅方式：长连接（推荐）',
        'lark.setup.hintLong': '只需 App ID 与 App Secret。插件主动建立 WebSocket 长连接，只在建连时鉴权，事件为明文，因此无需公网地址、无需 Verification Token、无需 Encrypt Key。',
        'lark.setup.noteLong': '注意：飞书要求先有客户端建连，才能在事件订阅里保存「使用长连接接收事件」；因此请先保存本页配置并确保该渠道为「已启用」，再去飞书控制台选择长连接。',
        'lark.setup.title': '飞书订阅方式：Webhook（需自行填写凭据）',
        'lark.setup.hint': '请在飞书开放平台同一个应用的「事件与回调」里复制 Verification Token，填入上面的「验证令牌」。两项凭据必须与 App ID / App Secret 属于同一应用，且与本插件中所填的值完全一致。',
        'lark.setup.encryptNotice': '加密策略：飞书侧若开启加密推送，把控制台的 Encrypt Key 复制填入上面的「加密密钥」；留空则要求飞书侧以「明文模式」推送。两个凭据都填即最严：既比对令牌，也要求 payload 能被解密。',
        'diag.title': '飞书诊断（Lark）',
        'diag.connection': '连接',
        'diag.configured': '配置输出方式',
        'diag.observed': '实际观察方式',
        'diag.grant': '权限查询',
        'diag.evidence': '实际操作证据（CardKit）',
        'diag.userState': '诊断结论',
        'diag.missing': '当前后端未提供 diagnostics（旧版本、未知 schema 或尚未生成）；连接/发送状态不代表权限已验证。',
        'diag.none': '—',
        'diag.unknownValue': '未知',
        'diag.notObserved': '未观测',
        'diag.mode.card': '交互卡片（CardKit 实时）',
        'diag.mode.text': '文本消息',
        'diag.out.pending': '进行中',
        'diag.out.live_card': '实时卡片（流式更新）',
        'diag.out.static_interactive': '最终静态卡片',
        'diag.out.text': '文本',
        'diag.out.failed': '失败',
        'diag.grantUnknown': '尚未验证',
        'diag.grantGranted': '查询已授权（scope 读取结果，非调用验证）',
        'diag.grantDenied': '未授权',
        'diag.grantMeta': ' · 来源 {source} · {at}',
        'diag.grantMetaAt': ' · {at}',
        'diag.query.never': '尚未查询',
        'diag.query.in_flight': '查询中',
        'diag.query.ok': '查询完成',
        'diag.query.failed': '查询失败（{category}）',
        'diag.query.stale': '结果已过期',
        'diag.evUnknown': '尚无实际调用证据',
        'diag.evSuccess': '已观察成功（真实调用）',
        'diag.evDenied': '实际调用被拒',
        'diag.evFailure': '{operation} · HTTP {http} · code {code} · {at}',
        'diag.evScope': '缺少权限 {scope}',
        'diag.evVerified': '已验证操作：{ops}',
        'diag.requiredScope': '所需权限：{scope}',
        'diag.user.waiting_new_request': '等待新消息（发一条新请求验证）',
        'diag.user.receiving_no_output': '已收到回合但暂无输出',
        'diag.user.live_card': '实时卡片输出中',
        'diag.user.multi_text': '多段文本实时输出',
        'diag.user.static_final': '已走最终静态卡片',
        'diag.user.missing_scope': '缺少 CardKit 权限',
        'diag.user.rate_limited': '被限流，稍后再试',
        'diag.user.unknown_delivery': '投递状态未知（不重发）',
        'diag.user.failed': '输出失败',
        'diag.user.completed': '回合已完成',
        'diag.user.unknown': '尚未验证',
        'diag.failureReason': '失败原因',
        'diag.fr.cards_unclosed': '卡片未收尾（开卡多于闭卡）',
        'diag.fr.delivery_unknown': '投递结果未知',
        'diag.fr.engine_incomplete': '引擎回合未完整',
        'diag.fr.transport_failure': '传输失败',
        'diag.fr.local_refusal': '本地拒绝（未发请求）',
        'diag.frMissing': '未提供',
        'diag.frUnknown': '未知原因（不显示原文）',
        'diag.completion': '收尾进度',
        'diag.completionRow': '任务待结 {pt} · 操作待结 {po} · 引擎待结 {ep} · 卡片开 {co}/闭 {cc} · 不完整step {is}',
        'diag.endKind': '结束方式',
        'diag.ek.committed': '已提交',
        'diag.ek.abandoned': '已放弃',
        'diag.ekUnknown': '未知（不显示原文）',
        'diag.op.card_create': '创建',
        'diag.op.card_reference': '引用',
        'diag.op.card_put': '更新',
        'diag.op.card_close': '收尾',
        'diag.op.static_interactive': '静态卡',
        'diag.op.text_send': '文本发送',
        'diag.op.scope_read': '权限查询',
        'diag.ops': '操作计数',
        'diag.opsRow': '{label} 尝试{a}/成功{s}/失败{f}/未知{u}',
        'diag.engine': '帧与引擎计数',
        'diag.engineHost': '宿主 seen s:{s} c:{c} δ:{d} b:{b} e:{e}',
        'diag.engineAccepted': '引擎 accepted s:{s} δ:{d} e:{e}',
        'diag.engineRejected': '引擎拒绝 重复{dup} 重复index{dupidx} 回退{reg} 跳号{gap} 形状{shape} 未绑定{unbound} 过期{stale}',
        'diag.refusals': '本地拒绝（未发请求）',
        'diag.refusalsRow': '{count} 次 · 原因 {category} · {at}',
        'diag.turns': '回合事件',
        'diag.turnsRow': 'final 收到 {f} · turnEnd {t} · 中止 {a}',
        'diag.firstAckLabel': '首段发送确认延迟（从首个有效文本增量起）',
        'diag.firstAckNote': '（服务端 ACK 代理值，非屏幕首显延迟）',
        'diag.textDelta': '已接受 text-delta {n}',
        'diag.putBeforeFinal': 'final 前 PUT 确认成功 {n}',
        'diag.putBeforeTurnEnd': 'turnEnd 前 PUT 确认成功 {n}',
        'diag.putDispatch': 'final 前 PUT 派发 {f} · turnEnd 前 PUT 派发 {t}（派发≠确认成功 ACK）',
        'diag.putTotal': 'PUT 总数 {n}',
        'diag.counters': '本回合计数',
        'diag.countersRow': '{a} · {b} · {c} · {d}',
        'diag.timings': '本回合时序（相对 startedAt）',
        'diag.timingsRow': '首个accepted δ {fad} · 首派发 {fd} · 末派发 {ld} · 首PUT {fp} · 末PUT {lp} · final {fr} · liveEnd {le} · turnEnd {te} · 收卡 {tc}',
        'diag.turnMeta': '回合 {id} · step {step} · {outcome} · {at}',
        'diag.staticFinal': '最终静态卡',
        'diag.staticFinalRow': '{count} 次 · 原因 {reason} · {at}',
        'diag.turnStatic': '本回合静态收尾',
        'diag.turnStaticRow': '{used}（{reason}）',
        'diag.fb.no_live_frames': '无实时帧',
        'diag.fb.live_rejected': '实时帧被拒',
        'diag.fb.permission_denied': '权限被拒',
        'diag.fb.known_transport_failure': '已知传输失败',
        'diag.fb.delivery_unknown': '投递状态未知',
        'diag.fb.non_streaming': '非流式回合',
        'diag.fb.canceled': '已取消',
        'diag.fb.stale': '已过期',
        'diag.fb.unknown': '未知',
        'diag.oc.in_progress': '进行中',
        'diag.oc.completed': '已完成',
        'diag.oc.canceled': '已取消',
        'diag.oc.aborted': '已中止',
        'diag.oc.failed': '失败',
        'diag.cat.scope_denied': '缺少权限',
        'diag.cat.card_identity': '目标卡片身份问题',
        'diag.cat.rate_limited': '被限流',
        'diag.cat.http_error': 'HTTP 错误',
        'diag.cat.network_unknown': '网络状态未知',
        'diag.cat.no_id': '未返回卡片 ID',
        'diag.cat.shape_mismatch': '响应形状不符',
        'diag.cat.budget_exceeded': '超出预算',
        'diag.cat.malformed': '响应无法解析',
        'diag.cat.stale_generation': '过期代次',
        'diag.unknownCategory': '未知类别',
        'diag.dedup.title': '消息去重账本',
        'diag.dedup.ok': '账本正常（内核文件锁）',
        'diag.dedup.unavailable': '账本不可用：飞书消息的持久去重与发送回执暂不可用；其他渠道不受影响',
        'diag.dedup.poisoned': '账本已停用（写入结果不确定）',
        'diag.dedup.noLock': '系统文件锁不可用（仅支持 linux/darwin）：飞书持久处理暂不可用；其他渠道不受影响',
        'diag.dedup.reopenHint': '状态面板（dsh-messaging 网关）顶部「重新加载」可重开账本；记录保留待接线验证',
        'diag.dedup.capMissing': '容量未提供',
        'diag.dedup.capDefault': '（默认）',
        'diag.dedup.capConfigured': '（配置）',
        'diag.dedup.histBackpressure': '历史容量背压 {n} 次',
        'diag.dedup.backpressure': '容量已满：新记录被明确拒绝（背压，不静默丢弃）',
        'diag.dedup.claims': '入站认领 {n}',
        'diag.dedup.delivered': '确认投递 {n}',
        'diag.dedup.rejected': '可见失败 {n}',
        'diag.dedup.recoverable': '待恢复 {n}',
        'diag.dedup.sendUsed': '发送回执 {u}/{c}',
        'diag.dedup.sendSent': '发送成功 {n}',
        'diag.dedup.counters': '账本计数（匿名）',
        'diag.dedup.capacityNote': '容量配置待接入；无清空/删除账本功能',
        'diag.dedupErr.store_poisoned': '写入不确定性',
        'diag.dedupErr.lock_unavailable': '文件锁能力缺失',
        'diag.dedupErr.lock_held': '被其他实例占用',
        'diag.dedupErr.write_failed': '存储写入失败',
        'diag.dedupErr.corrupt_journal': '账本损坏',
        'diag.dedupErr.closed': '账本已关闭',
        'diag.dedupErr.not_open': '账本未打开',
        'diag.dedupErr.at_capacity': '容量满',
        'diag.dedupErr.seq_exhausted': '序号耗尽',
        'diag.dedupErrUnknown': '未知账本错误',
        'diag.img.title': '图片诊断',
        'diag.img.available': '图片服务可用（不等于实际收发已通过）',
        'diag.img.unavailable': '图片服务不可用（不代表实际收发失败）',
        'diag.img.permUpload': '上传图片权限',
        'diag.img.permDownload': '下载图片权限',
        'diag.img.permGroupHistory': '群历史重拉权限',
        'diag.img.grant.granted': '已授予',
        'diag.img.grant.denied': '被拒绝',
        'diag.img.grant.unknown': '未知（未返回/查询失败）',
        'diag.img.stale': '（结果已过期）',
        'diag.img.checkedAt': '查询于 {at}',
        'diag.img.scopeNote': '需以下任一：{scopes}',
        'diag.img.opRow': '尝试 {a}/成功 {s}/失败 {f}/未知 {u}',
        'diag.img.op.image_upload': '图片上传',
        'diag.img.op.image_download': '图片下载',
        'diag.img.op.image_send': '图片发送',
        'diag.img.receipts': '发送回执存储错误',
        'diag.img.receiptCount': '发送回执存储错误 {n} 次',
        'diag.refresh': '刷新权限状态',
        'diag.refreshing': '查询中…',
        'diag.refreshHint': '只读查询 scope 授权状态：不发送任何消息、不申请或修改权限，也不代表已验证实时流式输出。',
        'diag.refreshStatus': '权限刷新',
        'diag.refreshOk': '查询完成',
        'diag.refreshError.adapter': '渠道未运行，无法查询',
        'diag.refreshError.in_flight': '已有查询进行中',
        'diag.refreshError.rate_limited': '查询过于频繁，请稍后再试',
        'diag.refreshError.read_failed': 'scope 读取失败',
        'diag.refreshError.malformed': 'scope 列表格式异常',
        'diag.refreshError.truncated': 'scope 列表不完整（被截断）',
        'diag.refreshError.api_error': '查询接口返回异常',
        'diag.refreshError.unreachable': '查询不可达（离线或旧版本无此接口）',
        'diag.refreshError.status_failed': '状态读取失败（仍显示旧快照）',
        'diag.refreshError.stale_generation': '检测到代际变化（状态已重载），请重试',
        'diag.refreshError.identity_unknown': '身份不可验证（重新加载页面以重建连接）',
        'diag.statusFailed': '状态读取失败（未获得新鲜诊断）',
        'diag.reloadFailed': '重载失败（状态未刷新）',
        'diag.generation': 'generation {gen}',
        'diag.fixTitle': '缺少权限时如何补齐',
        'diag.fix1': '1. 打开飞书开放平台应用后台 →「权限管理」。',
        'diag.fix2': '2. 添加「创建与更新卡片」权限（cardkit:card:write）；仅在需要审批/发布时才执行发布流程。',
        'diag.fix3': '3. 保存后新发一条消息验证（插件不会自动申请或修改权限）。',
        'diag.fixNoSecret': '切勿在诊断或会话中粘贴任何密钥。',
        'diag.fixNoDowngrade': '开卡失败只显示最终静态卡片诊断（保持 interactive 消息），不会自动降级为纯文本。',
        'field.wecom.corpId': '企业 ID',
        'field.wecom.agentId': '应用 ID',
        'field.wecom.secret': '密钥',
        'field.wecom.token': '回调令牌',
        'field.wecom.encodingAESKey': 'AES 加密密钥',
        'field.wecom.webhookPath': 'Webhook 路径',
        'field.wechat.baseUrl': 'ilink 网关地址',
        'field.wechat.botAgent': '机器人标识（bot_agent）',
        'field.wechat.pollIntervalMs': '轮询间隔（毫秒）',
        'field.wechat.longPollTimeoutSec': '长轮询超时（秒）',
        'wechat.login.title': '扫码登录',
        'wechat.login.generate': '生成二维码',
        'wechat.login.cancel': '取消',
        'wechat.login.hint': '无需安装 openclaw，用手机微信扫码即可连接（与 Tencent/openclaw-weixin 同协议）。',
        'wechat.login.wait': '等待扫码…',
        'wechat.login.scaned': '已扫描，请在手机上确认…',
        'wechat.login.needVerify': '请在手机上确认，并输入显示的配对数字：',
        'wechat.login.verifyPlaceholder': '配对数字',
        'wechat.login.verifySubmit': '提交',
        'wechat.login.verifying': '正在验证…',
        'wechat.login.expired': '二维码已过期，已自动刷新，请重新扫码。',
        'wechat.login.confirmed': '登录成功，Token 已保存。',
        'wechat.login.binded': '该账号此前已连接过，无需重复登录。',
        'wechat.login.failed': '登录失败：{msg}',
        'wechat.login.blocked': '配对数字多次错误，请重新扫码。',
        'wechat.login.noCredentials': '保存失败：宿主未提供凭据存储服务，Token 未写入配置，请联系管理员。',
      },
      en: {
        'channel.onebot': 'OneBot v11',
        'channel.telegram': 'Telegram',
        'channel.discord': 'Discord',
        'channel.slack': 'Slack',
        'channel.lark': 'Lark / Feishu',
        'channel.wecom': 'WeCom',
        'channel.wechat': 'Personal WeChat',
        'settings.title': 'Message Channel Configuration',
        'settings.reload': 'Reload',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved; adapters reloaded',
        'settings.conflict': 'The configuration changed elsewhere and has been reloaded',
        'settings.unavailable': 'Configuration is unavailable right now',
        'settings.readOnly': 'These settings are read-only',
        'settings.saveFailed': 'The save failed, please try again',
        'plugin.summary': 'Configure message channels, QR login and inbound credentials',
        'settings.loading': 'Loading configuration…',
        'settings.error': 'Error: {msg}',
        'settings.notice': 'Settings are written to the Host profile and apply immediately.',
        'settings.enabled': 'enabled',
        'settings.disabled': 'disabled',
        'settings.enableField': 'Enabled',
        'settings.yes': 'Yes',
        'settings.no': 'No',
        'settings.secretSet': 'Set — leave blank to keep',
        'settings.secretClear': 'Clear',
        'settings.secretUndoClear': 'Undo clear',
        'settings.secretClearPending': 'Cleared when you save',
        'panel.title': 'dsh-messaging gateway',
        'panel.reload': 'Reload',
        'panel.reloading': 'Reloading…',
        'panel.inOut': 'in {in} / out {out}',
        'panel.lastError': 'last error: {msg}',
        'panel.sessions': 'Sessions ({n})',
        'panel.recent': 'Recent',
        'panel.sessionRow': '{channel} · {conversation} · msgs {n}',
        'panel.eventRow': '{kind} · {channel} · {text}',
        'field.onebot.endpoint': 'OneBot endpoint',
        'field.onebot.accessToken': 'Access token (API call)',
        'field.onebot.secret': 'Webhook secret (X-Signature)',
        'field.onebot.webhookPath': 'Webhook path',
        'field.onebot.selfId': 'Self id (echo suppression)',
        'field.telegram.token': 'Bot token',
        'field.telegram.mode': 'Mode',
        'field.telegram.webhookSecret': 'Webhook secret (secret_token)',
        'field.telegram.webhookPath': 'Webhook path',
        'field.telegram.pollIntervalMs': 'Poll interval (ms)',
        'field.telegram.longPollTimeoutSec': 'Long-poll timeout (s)',
        'field.telegram.dropPendingUpdates': 'Drop pending updates',
        'field.discord.botToken': 'Bot token',
        'field.discord.intents': 'Gateway intents',
        'field.discord.wsModulePath': 'ws module path',
        'field.slack.botToken': 'Bot token',
        'field.slack.signingSecret': 'Signing secret',
        'field.slack.verificationToken': 'Verification token',
        'field.slack.webhookPath': 'Webhook path',
        'field.lark.appId': 'App id',
        'field.lark.appSecret': 'App secret',
        'field.lark.mode': 'Subscription mode',
        'field.lark.interactiveCard': 'Enable interactive cards',
        'field.lark.verificationToken': 'Verification token',
        'field.lark.encryptKey': 'Encrypt key (optional)',
        'field.lark.webhookPath': 'Webhook path',
        'lark.setup.titleLong': 'Feishu subscription: long connection (recommended)',
        'lark.setup.hintLong': 'Only the App ID and App Secret are needed. The plugin opens a WebSocket long connection and authenticates at connect time; pushed events are plaintext, so no public address, no Verification Token and no Encrypt Key are required.',
        'lark.setup.noteLong': 'Note: Feishu only offers the "receive events over a long connection" option once a client has connected, so save this configuration and enable the channel before selecting it in the Feishu console.',
        'lark.setup.title': 'Feishu subscription: Webhook (you supply the credentials)',
        'lark.setup.hint': 'Copy the Verification Token from the event subscription settings of the same app in the Feishu console into the Verification token field above. Both credentials must belong to the app that owns the App ID and App Secret, and must match the values entered here exactly.',
        'lark.setup.encryptNotice': 'Encryption: if the Feishu side pushes encrypted payloads, copy its Encrypt Key into the Encrypt key field above; leaving it empty requires the Feishu side to stay in plaintext mode. Supplying both is strictest: the token is compared and the payload must decrypt.',
        'diag.title': 'Feishu diagnostics (Lark)',
        'diag.connection': 'Connection',
        'diag.configured': 'Configured output',
        'diag.observed': 'Observed output',
        'diag.grant': 'Permission query',
        'diag.evidence': 'Operation evidence (CardKit)',
        'diag.userState': 'Diagnosis',
        'diag.missing': 'This backend does not provide diagnostics yet (older build, unknown schema, or none recorded); connection/send status does not mean permissions are verified.',
        'diag.none': '—',
        'diag.unknownValue': 'unknown',
        'diag.notObserved': 'Not observed',
        'diag.mode.card': 'Interactive card (CardKit live)',
        'diag.mode.text': 'Text messages',
        'diag.out.pending': 'In progress',
        'diag.out.live_card': 'Live card (streaming updates)',
        'diag.out.static_interactive': 'Final static card',
        'diag.out.text': 'Text',
        'diag.out.failed': 'Failed',
        'diag.grantUnknown': 'Not verified yet',
        'diag.grantGranted': 'Query reports granted (scope read — not call-verified)',
        'diag.grantDenied': 'Not granted',
        'diag.grantMeta': ' · source {source} · {at}',
        'diag.grantMetaAt': ' · {at}',
        'diag.query.never': 'never queried',
        'diag.query.in_flight': 'query in flight',
        'diag.query.ok': 'query ok',
        'diag.query.failed': 'query failed ({category})',
        'diag.query.stale': 'result stale',
        'diag.evUnknown': 'No operation evidence yet',
        'diag.evSuccess': 'Observed success (real calls)',
        'diag.evDenied': 'Real call denied',
        'diag.evFailure': '{operation} · HTTP {http} · code {code} · {at}',
        'diag.evScope': 'Missing scope {scope}',
        'diag.evVerified': 'Verified operations: {ops}',
        'diag.requiredScope': 'Required scope: {scope}',
        'diag.user.waiting_new_request': 'Waiting for a new message (send one to verify)',
        'diag.user.receiving_no_output': 'Turn received, no output yet',
        'diag.user.live_card': 'Live card output in progress',
        'diag.user.multi_text': 'Multi-segment text streaming',
        'diag.user.static_final': 'Final static card used',
        'diag.user.missing_scope': 'Missing CardKit permission',
        'diag.user.rate_limited': 'Rate limited, retry later',
        'diag.user.unknown_delivery': 'Delivery unknown (no resend)',
        'diag.user.failed': 'Output failed',
        'diag.user.completed': 'Turn completed',
        'diag.user.unknown': 'Not verified yet',
        'diag.failureReason': 'Failure reason',
        'diag.fr.cards_unclosed': 'Cards still open at settlement',
        'diag.fr.delivery_unknown': 'Delivery result unknown',
        'diag.fr.engine_incomplete': 'Engine turn incomplete',
        'diag.fr.transport_failure': 'Transport failure',
        'diag.fr.local_refusal': 'Local refusal (no request sent)',
        'diag.frMissing': 'Not provided',
        'diag.frUnknown': 'Unknown reason (raw value not shown)',
        'diag.completion': 'Settlement progress',
        'diag.completionRow': 'tasks pending {pt} · ops pending {po} · engines pending {ep} · cards open {co}/closed {cc} · incomplete steps {is}',
        'diag.endKind': 'End kind',
        'diag.ek.committed': 'Committed',
        'diag.ek.abandoned': 'Abandoned',
        'diag.ekUnknown': 'Unknown (raw value not shown)',
        'diag.op.card_create': 'create',
        'diag.op.card_reference': 'reference',
        'diag.op.card_put': 'update',
        'diag.op.card_close': 'close',
        'diag.op.static_interactive': 'static card',
        'diag.op.text_send': 'text send',
        'diag.op.scope_read': 'scope read',
        'diag.ops': 'Operation counters',
        'diag.opsRow': '{label} tried {a}/ok {s}/failed {f}/unknown {u}',
        'diag.engine': 'Frame & engine counters',
        'diag.engineHost': 'host seen s:{s} c:{c} δ:{d} b:{b} e:{e}',
        'diag.engineAccepted': 'engine accepted s:{s} δ:{d} e:{e}',
        'diag.engineRejected': 'engine rejected dup{dup} dupIndex {dupidx} regressed{reg} gap{gap} shape{shape} unbound{unbound} stale{stale}',
        'diag.refusals': 'Local refusals (no request sent)',
        'diag.refusalsRow': '{count}× · reason {category} · {at}',
        'diag.turns': 'Turn events',
        'diag.turnsRow': 'final {f} · turnEnd {t} · aborted {a}',
        'diag.firstAckLabel': 'First-segment delivery ack (from first accepted text delta)',
        'diag.firstAckNote': '(server ACK proxy — not screen-visible latency)',
        'diag.textDelta': 'accepted text-delta {n}',
        'diag.putBeforeFinal': 'PUT confirmed ok before final {n}',
        'diag.putBeforeTurnEnd': 'PUT confirmed ok before turnEnd {n}',
        'diag.putDispatch': 'PUT dispatched before final {f} · before turnEnd {t} (dispatch ≠ confirmed ACK)',
        'diag.putTotal': 'PUT total {n}',
        'diag.counters': 'This-turn counters',
        'diag.countersRow': '{a} · {b} · {c} · {d}',
        'diag.timings': 'This-turn timings (relative to startedAt)',
        'diag.timingsRow': 'first accepted δ {fad} · first dispatch {fd} · last dispatch {ld} · first PUT {fp} · last PUT {lp} · final {fr} · liveEnd {le} · turnEnd {te} · close {tc}',
        'diag.turnMeta': 'Turn {id} · step {step} · {outcome} · {at}',
        'diag.staticFinal': 'Final static cards',
        'diag.staticFinalRow': '{count}× · reason {reason} · {at}',
        'diag.turnStatic': 'Static finish this turn',
        'diag.turnStaticRow': '{used} ({reason})',
        'diag.fb.no_live_frames': 'no live frames',
        'diag.fb.live_rejected': 'live frames rejected',
        'diag.fb.permission_denied': 'permission denied',
        'diag.fb.known_transport_failure': 'known transport failure',
        'diag.fb.delivery_unknown': 'delivery unknown',
        'diag.fb.non_streaming': 'non-streaming turn',
        'diag.fb.canceled': 'canceled',
        'diag.fb.stale': 'stale',
        'diag.fb.unknown': 'unknown',
        'diag.oc.in_progress': 'In progress',
        'diag.oc.completed': 'Completed',
        'diag.oc.canceled': 'Canceled',
        'diag.oc.aborted': 'Aborted',
        'diag.oc.failed': 'Failed',
        'diag.cat.scope_denied': 'Missing scope',
        'diag.cat.card_identity': 'Target card identity',
        'diag.cat.rate_limited': 'Rate limited',
        'diag.cat.http_error': 'HTTP error',
        'diag.cat.network_unknown': 'Network unknown',
        'diag.cat.no_id': 'No card id',
        'diag.cat.shape_mismatch': 'Response shape mismatch',
        'diag.cat.budget_exceeded': 'Budget exceeded',
        'diag.cat.malformed': 'Malformed response',
        'diag.cat.stale_generation': 'Stale generation',
        'diag.unknownCategory': 'Unknown category',
        'diag.dedup.title': 'Message dedup ledger',
        'diag.dedup.ok': 'Ledger healthy (kernel file lock)',
        'diag.dedup.unavailable': 'Ledger unavailable: persistent Feishu dedup and send receipts are paused; other channels are unaffected',
        'diag.dedup.poisoned': 'Ledger disabled (write outcome uncertain)',
        'diag.dedup.noLock': 'System file lock unavailable (linux/darwin only): persistent Feishu handling is paused; other channels are unaffected',
        'diag.dedup.reopenHint': '"Reload" at the top of the status panel ("dsh-messaging gateway") reopens the ledger; record retention awaits wiring verification',
        'diag.dedup.capMissing': 'capacity not provided',
        'diag.dedup.capDefault': ' (default)',
        'diag.dedup.capConfigured': ' (configured)',
        'diag.dedup.histBackpressure': 'historical capacity backpressure x{n}',
        'diag.dedup.backpressure': 'Capacity reached: new records are explicitly refused (backpressure, nothing silently dropped)',
        'diag.dedup.claims': 'Inbound claims {n}',
        'diag.dedup.delivered': 'Confirmed delivered {n}',
        'diag.dedup.rejected': 'Visible failures {n}',
        'diag.dedup.recoverable': 'Awaiting recovery {n}',
        'diag.dedup.sendUsed': 'Send receipts {u}/{c}',
        'diag.dedup.sendSent': 'Sends succeeded {n}',
        'diag.dedup.counters': 'Ledger counters (anonymous)',
        'diag.dedup.capacityNote': 'Capacity configuration not yet wired; no clear/delete-ledger feature exists',
        'diag.dedupErr.store_poisoned': 'write uncertainty',
        'diag.dedupErr.lock_unavailable': 'file lock capability missing',
        'diag.dedupErr.lock_held': 'held by another instance',
        'diag.dedupErr.write_failed': 'storage write failed',
        'diag.dedupErr.corrupt_journal': 'ledger corrupt',
        'diag.dedupErr.closed': 'ledger closed',
        'diag.dedupErr.not_open': 'ledger not open',
        'diag.dedupErr.at_capacity': 'capacity reached',
        'diag.dedupErr.seq_exhausted': 'sequence exhausted',
        'diag.dedupErrUnknown': 'Unknown ledger error',
        'diag.img.title': 'Image diagnostics',
        'diag.img.available': 'Image service available (not proof of any successful transfer)',
        'diag.img.unavailable': 'Image service unavailable (not evidence of a transfer failure)',
        'diag.img.permUpload': 'Image upload permission',
        'diag.img.permDownload': 'Image download permission',
        'diag.img.permGroupHistory': 'Group history re-fetch permission',
        'diag.img.grant.granted': 'Granted',
        'diag.img.grant.denied': 'Denied',
        'diag.img.grant.unknown': 'Unknown (not returned / query failed)',
        'diag.img.stale': '(result stale)',
        'diag.img.checkedAt': 'checked at {at}',
        'diag.img.scopeNote': 'requires any of: {scopes}',
        'diag.img.opRow': 'tried {a}/ok {s}/failed {f}/unknown {u}',
        'diag.img.op.image_upload': 'Image upload',
        'diag.img.op.image_download': 'Image download',
        'diag.img.op.image_send': 'Image send',
        'diag.img.receipts': 'Send receipt store errors',
        'diag.img.receiptCount': 'Send receipt store errors x{n}',
        'diag.refresh': 'Refresh permission status',
        'diag.refreshing': 'Refreshing…',
        'diag.refreshHint': 'Read-only scope query: sends no messages, never requests or changes permissions, and does not verify live streaming.',
        'diag.refreshStatus': 'Permission refresh',
        'diag.refreshOk': 'Query complete',
        'diag.refreshError.adapter': 'Channel not running, cannot query',
        'diag.refreshError.in_flight': 'A query is already running',
        'diag.refreshError.rate_limited': 'Too frequent, please retry shortly',
        'diag.refreshError.read_failed': 'Scope read failed',
        'diag.refreshError.malformed': 'Malformed scope list',
        'diag.refreshError.truncated': 'Scope list truncated',
        'diag.refreshError.api_error': 'Unexpected API response',
        'diag.refreshError.unreachable': 'Unreachable (offline or older backend without this endpoint)',
        'diag.refreshError.status_failed': 'Status read failed (previous snapshot still shown)',
        'diag.refreshError.stale_generation': 'Generation changed (state reloaded), please retry',
        'diag.refreshError.identity_unknown': 'Identity unverifiable (reload the page to rebuild the connection)',
        'diag.statusFailed': 'Status read failed (no fresh diagnostics)',
        'diag.reloadFailed': 'Reload failed (status not refreshed)',
        'diag.generation': 'generation {gen}',
        'diag.fixTitle': 'How to add the missing permission',
        'diag.fix1': '1. Open the Feishu Open Platform app console → "Permissions".',
        'diag.fix2': '2. Add "Create and update cards" (cardkit:card:write); run the approval/publish flow only when it is actually required.',
        'diag.fix3': '3. Save, then send one new message to verify (the plugin never requests or changes permissions by itself).',
        'diag.fixNoSecret': 'Never paste any secret into diagnostics or a chat.',
        'diag.fixNoDowngrade': 'When card creation fails only the final static-card diagnostic is shown (messages stay interactive); it never auto-downgrades to plain text.',
        'field.wecom.corpId': 'Corp id',
        'field.wecom.agentId': 'Agent id',
        'field.wecom.secret': 'Secret',
        'field.wecom.token': 'Callback token',
        'field.wecom.encodingAESKey': 'Encoding AES key',
        'field.wecom.webhookPath': 'Webhook path',
        'field.wechat.baseUrl': 'ilink gateway URL',
        'field.wechat.botAgent': 'Bot agent',
        'field.wechat.pollIntervalMs': 'Poll interval (ms)',
        'field.wechat.longPollTimeoutSec': 'Long-poll timeout (s)',
        'wechat.login.title': 'QR code login',
        'wechat.login.generate': 'Generate QR code',
        'wechat.login.cancel': 'Cancel',
        'wechat.login.hint': 'No OpenClaw installation needed — scan with WeChat to connect (same protocol as Tencent/openclaw-weixin).',
        'wechat.login.wait': 'Waiting for scan…',
        'wechat.login.scaned': 'Scanned — confirm on your phone…',
        'wechat.login.needVerify': 'Confirm on your phone, then enter the pairing number:',
        'wechat.login.verifyPlaceholder': 'Pairing number',
        'wechat.login.verifySubmit': 'Submit',
        'wechat.login.verifying': 'Verifying…',
        'wechat.login.expired': 'QR expired — refreshed automatically, please scan again.',
        'wechat.login.confirmed': 'Login successful, token saved.',
        'wechat.login.binded': 'This account was already connected; no need to log in again.',
        'wechat.login.failed': 'Login failed: {msg}',
        'wechat.login.blocked': 'Pairing number rejected multiple times, please scan again.',
        'wechat.login.noCredentials': 'Save failed: the host provides no credentials store, so the token was not written to the configuration. Contact your administrator.',
      },
    }

    function displayValue(value) {
      return value === undefined || value === null ? '' : String(value)
    }

    // 注入缺席时的空 hook：保证组件里 hook 的调用次数在渲染之间稳定（不因
    // 注入面缺失而变成条件调用）。
    function absentHook() {
      return undefined
    }

    // owner 没有传 t 时的兜底：直接读本包字典（不碰 ctx）。
    function fallbackT(key, params) {
      const template = (LOCALE_DICTS.en && LOCALE_DICTS.en[key]) || key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function rpc(method, path, body) {
      const init = {
        method: method,
        credentials: 'same-origin',
        referrerPolicy: 'origin',
        headers: { Accept: 'application/json' },
      }
      if (method !== 'GET' && body !== undefined) {
        init.headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(path, init).then(function (res) {
        return res.text().then(function (text) {
          var data = null
          if (text) {
            try { data = JSON.parse(text) } catch (err) {
              data = { ok: false, error: text.slice(0, 300) }
            }
          }
          if (!res.ok) {
            var message = (data && data.error) || ('HTTP ' + res.status)
            var error = new Error(message)
            error.status = res.status
            error.data = data
            throw error
          }
          return data
        })
      })
    }

    function apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return

        const locale = ctx.get('locale')
        // 语言：owner 通过注册项的 locale 给组件传 t（组件不再 ctx.get）；这里只登记字典。
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(LOCALE_NS, LOCALE_DICTS))
        }

        const styles = {
          root: {
            border: '1px solid var(--color-border, #d8d8d8)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxWidth: 720,
          },
          header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
          title: { fontSize: 14, fontWeight: 600, margin: 0 },
          button: {
            border: '1px solid currentColor',
            background: 'transparent',
            borderRadius: 6,
            padding: '3px 8px',
            cursor: 'pointer',
          },
          grid: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: 8,
          },
          card: {
            border: '1px solid var(--color-border, #e1e1e1)',
            borderRadius: 6,
            padding: 8,
            background: 'var(--color-bg-soft, #fafafa)',
          },
          cardHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
          name: { fontWeight: 600 },
          muted: { color: 'var(--color-muted, #777)', marginTop: 2 },
          stateRunning: { color: '#1a7f37' },
          stateError: { color: '#c62828' },
          stateDisabled: { color: '#777' },
          section: { marginTop: 4, fontWeight: 600 },
          list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 },
          row: { borderTop: '1px solid var(--color-border, #eee)', paddingTop: 4, wordBreak: 'break-word' },
          form: {
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxWidth: 760,
            fontSize: 13,
          },
          formHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
          formTitle: { fontSize: 15, fontWeight: 600, margin: 0 },
          formActions: { display: 'flex', gap: 8 },
          primary: {
            border: '1px solid var(--color-accent, #4a6ee0)',
            background: 'var(--color-accent-soft, #eaf0ff)',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
          },
          details: {
            border: '1px solid var(--color-border, #e1e1e1)',
            borderRadius: 8,
            padding: '8px 10px',
          },
          summary: { cursor: 'pointer', fontWeight: 600, display: 'flex', justifyContent: 'space-between' },
          badge: { color: 'var(--color-muted, #777)', fontWeight: 500 },
          fieldGrid: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: '8px 12px',
            marginTop: 8,
          },
          field: { display: 'flex', flexDirection: 'column', gap: 3 },
          fieldLabel: { color: 'var(--color-muted, #777)', fontSize: 11 },
          input: {
            border: '1px solid var(--color-border, #d8d8d8)',
            borderRadius: 6,
            padding: '5px 7px',
            background: 'var(--color-bg, #fff)',
            color: 'var(--color-text, #111)',
            fontSize: 12,
            width: '100%',
            boxSizing: 'border-box',
          },
          toggle: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
          notice: { color: 'var(--color-muted, #777)' },
          loginBox: {
            border: '1px dashed var(--color-border, #d0d0d0)',
            borderRadius: 8,
            padding: 10,
            marginTop: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          },
          loginHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
          loginTitle: { fontWeight: 600 },
          loginHint: { color: 'var(--color-muted, #777)', fontSize: 11 },
          qrImage: {
            width: 168,
            height: 168,
            imageRendering: 'pixelated',
            border: '1px solid var(--color-border, #e1e1e1)',
            borderRadius: 6,
            background: '#fff',
            alignSelf: 'center',
          },
          verifyRow: { display: 'flex', gap: 6, alignItems: 'center' },
          setupBox: {
            border: '1px dashed var(--color-border, #d0d0d0)',
            borderRadius: 8,
            padding: 10,
            marginTop: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
          setupTitle: { fontWeight: 600 },
          setupHint: { color: 'var(--color-muted, #777)', fontSize: 11 },
          secretRow: { display: 'flex', alignItems: 'center', gap: 6 },
          secretInput: { flex: 1, width: 'auto', minWidth: 0 },
        }

        function Field(props) {
          const type = props.type === 'password' ? 'password' : props.type === 'number' ? 'number' : 'text'
          if (props.type === 'boolean') {
            return React.createElement('label', { style: styles.toggle },
              React.createElement('input', {
                type: 'checkbox',
                checked: Boolean(props.value),
                disabled: Boolean(props.disabled),
                onChange: (event) => props.onChange(event.target.checked),
              }),
              React.createElement('span', null, props.label),
            )
          }
          if (props.type === 'select' || props.type === 'boolean-select') {
            const booleanSelect = props.type === 'boolean-select'
            const options = booleanSelect
              ? [{ value: 'true', label: props.yesLabel }, { value: 'false', label: props.noLabel }]
              : (props.options || []).map((option) => ({ value: option, label: option }))
            return React.createElement('label', { style: styles.field },
              React.createElement('span', { style: styles.fieldLabel }, props.label),
              React.createElement('select', {
                value: booleanSelect ? String(props.value === true) : displayValue(props.value),
                disabled: Boolean(props.disabled),
                onChange: (event) => props.onChange(booleanSelect ? event.target.value === 'true' : event.target.value),
                style: styles.input,
              },
                options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
              ),
            )
          }
          const handleChange = (event) => {
            const raw = event.target.value
            if (props.type === 'number') {
              const parsed = raw === '' ? null : Number(raw)
              props.onChange(Number.isFinite(parsed) ? parsed : null)
            }
            else props.onChange(raw)
          }
          const input = React.createElement('input', {
            type,
            value: displayValue(props.value),
            placeholder: props.placeholder || '',
            disabled: Boolean(props.disabled),
            onChange: handleChange,
            style: props.onClear ? Object.assign({}, styles.input, styles.secretInput) : styles.input,
          })
          // 密钥字段：宿主只回传「是否已设置」，明文永不到浏览器，因此输入框为空
          // 既可能是「未配置」也可能是「已设置但被抹掉」——用占位提示区分，并给出
          // 显式清除入口（空串本身在服务端只表示「保持不变」，不代表清除）。
          if (props.onClear) {
            return React.createElement('label', { style: styles.field },
              React.createElement('span', { style: styles.fieldLabel }, props.label),
              React.createElement('div', { style: styles.secretRow },
                input,
                React.createElement('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: Boolean(props.disabled),
                  onClick: props.onClear,
                }, props.clearLabel),
              ),
            )
          }
          return React.createElement('label', { style: styles.field },
            React.createElement('span', { style: styles.fieldLabel }, props.label),
            input,
          )
        }

        // 扫码登录面板：只渲染快照与动作（轮询、超时都在 WechatLoginController）。
        function WeChatLoginPanel(props) {
          const t = props.t || fallbackT
          const useLogin = props.useWechatLogin || absentHook
          const login = useLogin((snapshot) => snapshot) || {}
          const disabled = Boolean(props.disabled)
          const busy = Boolean(login.busy)
          // 与旧 effect 同时序：状态/码变化后唤醒一次首轮询（controller 内部防并发）。
          React.useEffect(() => {
            if (props.wake) props.wake()
          }, [login.sessionKey, login.qrUrl, login.status])

          const statusText = () => {
            if (login.status === 'wait') return t('wechat.login.wait')
            if (login.status === 'scaned') return t('wechat.login.scaned')
            if (login.status === 'need_verifycode') return t('wechat.login.needVerify')
            if (login.status === 'expired') return t('wechat.login.expired')
            if (login.status === 'confirmed') return login.alreadyConnected ? t('wechat.login.binded') : t('wechat.login.confirmed')
            if (login.status === 'verify_code_blocked') return t('wechat.login.blocked')
            if (login.status === 'failed') {
              // 宿主明确区分「缺凭据服务」这类可操作错误，换本地化文案展示。
              if (login.errorCode === 'CREDENTIALS_UNAVAILABLE') return t('wechat.login.noCredentials')
              return login.error ? t('wechat.login.failed', { msg: login.error }) : t('wechat.login.failed', { msg: 'unknown' })
            }
            return ''
          }

          return React.createElement('div', { style: styles.loginBox },
            React.createElement('div', { style: styles.loginHeader },
              React.createElement('span', { style: styles.loginTitle }, t('wechat.login.title')),
              login.qrUrl
                ? React.createElement('button', { style: styles.button, disabled: disabled || busy, onClick: props.cancel }, t('wechat.login.cancel'))
                : React.createElement('button', { style: styles.button, disabled: disabled || busy, onClick: props.generate }, t('wechat.login.generate')),
            ),
            React.createElement('div', { style: styles.loginHint }, t('wechat.login.hint')),
            login.qrUrl ? React.createElement('img', { src: login.qrUrl, style: styles.qrImage, alt: 'QR' }) : null,
            statusText() ? React.createElement('div', { style: login.status === 'failed' ? styles.stateError : styles.muted }, statusText()) : null,
            login.status === 'need_verifycode'
              ? React.createElement('div', { style: styles.verifyRow },
                  React.createElement('input', {
                    style: styles.input,
                    value: login.verifyCode || '',
                    placeholder: t('wechat.login.verifyPlaceholder'),
                    disabled: disabled || busy,
                    onChange: (event) => props.setVerifyCode(event.target.value),
                  }),
                  React.createElement('button', { style: styles.primary, disabled: disabled || busy, onClick: props.submitVerify }, busy ? t('wechat.login.verifying') : t('wechat.login.verifySubmit')),
                )
              : null,
          )
        }

        // 飞书订阅方式决定用户要做什么：长连接不需要任何入站凭据，只需 appId /
        // appSecret；webhook 需要用户自己把飞书控制台的 Verification Token 与
        // Encrypt Key 填进上面的字段（取值必须两端一致，插件无法代为生成）。
        function LarkSetupPanel(props) {
          const t = props.t || fallbackT
          if (props.mode !== 'webhook') {
            return React.createElement('div', { style: styles.setupBox },
              React.createElement('div', { style: styles.setupTitle }, t('lark.setup.titleLong')),
              React.createElement('div', { style: styles.setupHint }, t('lark.setup.hintLong')),
              React.createElement('div', { style: styles.setupHint }, t('lark.setup.noteLong')),
            )
          }

          return React.createElement('div', { style: styles.setupBox },
            React.createElement('div', { style: styles.setupTitle }, t('lark.setup.title')),
            React.createElement('div', { style: styles.setupHint }, t('lark.setup.hint')),
            React.createElement('div', { style: styles.setupHint }, t('lark.setup.encryptNotice')),
          )
        }

        // ── 飞书诊断：status.channels[].diagnostics（schemaVersion 1）──────────
        // 连接 / 权限查询(grant) / 实际操作证据(operationsVerified+cardkit.state) /
        // 实际输出(observedMode+userState+staticFinal) 分域展示；未知 schema、缺字段、
        // turn=null 一律安全降级为「未观测/尚未验证」，绝不因 running 假绿。
        // GET /status 只是读取状态，不代表已鉴权；「刷新权限状态」按钮只读（点击时一次
        // POST + 一次权威 status 重读）；「复制诊断」仍未加（将来只含白名单聚合）。
        const DIAG_GRANT_STATES = ['unknown', 'granted', 'denied']
        const DIAG_QUERY_STATES = ['never', 'in_flight', 'ok', 'failed']
        const DIAG_CARDKIT_STATES = ['unknown', 'denied', 'observed_success']
        const DIAG_OBSERVED_MODES = ['pending', 'live_card', 'static_interactive', 'text', 'failed']
        const DIAG_USER_STATES = ['waiting_new_request', 'receiving_no_output', 'live_card', 'multi_text', 'static_final', 'missing_scope', 'rate_limited', 'unknown_delivery', 'failed', 'completed']
        const DIAG_STATIC_REASONS = ['no_live_frames', 'live_rejected', 'permission_denied', 'known_transport_failure', 'delivery_unknown', 'non_streaming', 'canceled', 'stale', 'unknown']
        const DIAG_OPERATIONS = ['card_create', 'card_reference', 'card_put', 'card_close', 'static_interactive', 'text_send', 'scope_read']
        // 固定白名单：缺权提示只认这一个 scope，后端 requiredScope 的任意字符串不进 UI。
        const REQUIRED_CARDKIT_SCOPE = 'cardkit:card:write'
        // 操作失败类别（backend v1 定稿枚举，与 scope 查询 failedCategory 分域）。
        const DIAG_FAILURE_CATEGORIES = ['scope_denied', 'card_identity', 'rate_limited', 'http_error', 'network_unknown', 'no_id', 'shape_mismatch', 'budget_exceeded', 'malformed', 'stale_generation']
        // scope 查询失败类别（独立小枚举，不与操作失败混域）。
        const DIAG_GRANT_FAILED_CATEGORIES = ['network', 'timeout', 'http_error', 'malformed']
        // 回合 outcome（v1 固定枚举）：未知值不原样显示，只显示「—」。
        const DIAG_TURN_OUTCOMES = ['in_progress', 'completed', 'canceled', 'aborted', 'failed']
        // 失败原因（backend 固定枚举）：未知值不原样渲染；null/缺字段显示「未提供」，不猜。
        const DIAG_FAILURE_REASONS = ['cards_unclosed', 'delivery_unknown', 'engine_incomplete', 'transport_failure', 'local_refusal']
        // 回合结束方式（固定枚举）：未知值不原样渲染。
        const DIAG_TURN_END_KINDS = ['committed', 'abandoned']
        // 本地拒绝类别（未发请求，与网络操作失败分域）。
        const DIAG_LOCAL_REFUSAL_CATEGORIES = ['malformed', 'budget_exceeded', 'shape_mismatch']
        // 权限刷新错误（后端固定枚举的本地映射）：未知错误一律 api_error，绝不渲染原始响应。
        const DIAG_REFRESH_ERRORS = ['adapter', 'in_flight', 'rate_limited', 'read_failed', 'malformed', 'truncated', 'api_error', 'unreachable', 'status_failed', 'stale_generation', 'identity_unknown']
        // 去重账本状态（backend 提供 diagnostics.dedup，消费其 serialize 真实形状）：
        // lastError 双方固定枚举（与 lib/lark-diagnostics.js LARK_DEDUP_LAST_ERRORS 对齐，
        // 流中断言两份列表；store 级真实错误全集=这 9 项，不开放任意 ledger code 透传）。
        const DIAG_DEDUP_ERRORS = ['lock_unavailable', 'lock_held', 'store_poisoned', 'write_failed', 'corrupt_journal', 'closed', 'not_open', 'at_capacity', 'seq_exhausted']
        // counts.* 是唯一计数源（键名沿 backend DEDUP_COUNT_KEYS 子集，不自造扁平字段）。
        const DIAG_DEDUP_COUNT_KEYS = ['claims', 'delivered', 'rejected', 'recoverable', 'duplicateTerminal', 'duplicateInflight', 'sendRecords', 'sendCapacityErrors', 'sendSent']
        // 图片诊断（backend 提供 diagnostics.images，schemaVersion 1）：
        // 三权限 OR 组判定在后端（固定 scope 规则同本端常量）；三个操作桶独立计数；
        // receiptErrors 固定译名；路径/ID/digest/原始错误永不进白名单。
        const DIAG_IMAGE_OPERATIONS = ['image_upload', 'image_download', 'image_send']
        const DIAG_IMAGE_GRANTS = ['unknown', 'granted', 'denied']
        // 固定 scope 常量（仅用于显示说明，判定在后端同规则）：
        // upload = im:resource | im:resource:upload（任一）；
        // download = im:message | im:message:readonly | im:message.history:readonly（任一）；
        // groupHistory = im:message.group_msg（仅群历史重拉条件，不是「群发送」）。
        const DIAG_SCOPE_UPLOAD = ['im:resource', 'im:resource:upload']
        const DIAG_SCOPE_DOWNLOAD = ['im:message', 'im:message:readonly', 'im:message.history:readonly']
        const DIAG_SCOPE_GROUP_HISTORY = ['im:message.group_msg']

        function diagOneOf(value, allowed) {
          return allowed.indexOf(value) !== -1 ? value : null
        }

        function diagObject(value) {
          return value && typeof value === 'object' && !Array.isArray(value) ? value : null
        }

        function diagCount(value) {
          return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.floor(value) : null
        }

        // 严格非负安全整数（收尾进度/派发契约字段）：小数、字符串、负数、非有限一律拒绝，不靠取整放行。
        function diagInt(value) {
          return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
        }

        // 诊断文本消毒：只收 string/number，去控制字符、封顶长度。
        // 永远只作 React 文本子节点（自动转义），不进 href/src/innerHTML 等属性。
        function sanitizeDiagText(value, max) {
          const limit = max || 120
          if (typeof value === 'number' && isFinite(value)) return String(value)
          if (typeof value !== 'string') return ''
          return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit)
        }

        // 时间只接受有限安全整数毫秒（契约数值）；字符串一律丢弃，不靠正则放行。
        function formatDiagTime(value) {
          if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
            try {
              return new Date(value).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
            } catch (timeError) {
              return ''
            }
          }
          return ''
        }

        // 本地匿名安全整数标识（turnId/generation 契约）：不接受任意字符串/数字串/小数/负数。
        function diagLocalId(value) {
          return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null
        }

        function diagReason(value) {
          if (typeof value !== 'string' || !value) return null
          return diagOneOf(value, DIAG_STATIC_REASONS) || 'unknown'
        }

        // 去重账本块 reader（字段沿 ledger stats 形状；旧版缺块 → null，整块隐藏）。
        // lockMode 白名单仅 'flock'：'link'/其它一律按 null（不宣称已废弃的虚假锁能力）；
        // lastError 固定枚举；全部计数为安全非负整数；reader 缺失/不可用绝不假称健康。
        function larkDedupView(diag) {
          const raw = diagObject(diag.dedup)
          if (!raw) return null
          const rawCounts = diagObject(raw.counts)
          const rawCapacity = diagObject(raw.capacity)
          // counts.* 是唯一计数源（键名沿 backend DEDUP_COUNT_KEYS）。
          const counts = {}
          for (const key of DIAG_DEDUP_COUNT_KEYS) counts[key] = rawCounts ? diagInt(rawCounts[key]) : null
          // 容量：capacity={sendReceipts:int|null, source:'default'|'configured'|null}；
          // 缺失/reader 失败 → null（显示“未提供”），**不在 UI 凭空补默认 2000**。
          const capacity = rawCapacity ? diagInt(rawCapacity.sendReceipts) : null
          const capacitySource = rawCapacity
            && (rawCapacity.source === 'default' || rawCapacity.source === 'configured')
            ? rawCapacity.source
            : null
          return Object.freeze({
            available: raw.available === true,
            poisoned: raw.poisoned === true,
            lockMode: raw.lockMode === 'flock' ? 'flock' : null,
            lastError: diagOneOf(raw.lastError, DIAG_DEDUP_ERRORS),
            // N1：有非 null 非空值但不在白名单（含 raw 对象/短枚举）→ 固定“未知账本错误”，
            // 绝不渲原值、绝不 healthy；严格 boolean（字符串 'true' 不算可用，见 available）。
            lastErrorUnknown: (() => {
              const v = raw.lastError
              const present = v !== null && v !== undefined && v !== '' && v !== false
              return raw.lastErrorUnknown === true || (present && diagOneOf(v, DIAG_DEDUP_ERRORS) === null)
            })(),
            // reopen 是权威字段（仅 'none'|'needed'），不自行用 available/poisoned 推导。
            reopen: raw.reopen === 'needed' ? 'needed' : (raw.reopen === 'none' ? 'none' : null),
            counts,
            capacity,
            capacitySource,
            // 当前满只按 used>=capacity；历史 sendCapacityErrors 单独展示，不作当前依据。
            currentFull: capacity !== null && counts.sendRecords !== null && counts.sendRecords >= capacity,
          })
        }

        // 图片诊断块 reader（保留 schemaVersion 门槛：未知 schema/缺块 → null 整块隐藏）。
        // 旧单域 imagesGrant（编辑态偶现）只当未知——绝不映射成任一权限 granted。
        // 三权限 OR 组判定在后端（同固定 scope 常量），本端只显示；三操作桶独立计数；
        // receiptErrors 固定译名；路径/ID/digest/原始错误永不进白名单。
        function larkImagesView(diag) {
          const raw = diagObject(diag.images)
          if (!raw || raw.schemaVersion !== 1) return null
          const parsePermission = (entry) => {
            const obj = diagObject(entry)
            return Object.freeze({
              grant: obj ? (diagOneOf(obj.grant, DIAG_IMAGE_GRANTS) || 'unknown') : 'unknown',
              source: obj && obj.source === 'scope_read' ? 'scope_read' : null,
              checkedAt: obj ? diagInt(obj.checkedAt) : null,
              stale: Boolean(obj && obj.stale === true),
            })
          }
          const rawPermissions = diagObject(raw.permissions)
          const permissions = Object.freeze({
            upload: parsePermission(rawPermissions ? rawPermissions.upload : null),
            download: parsePermission(rawPermissions ? rawPermissions.download : null),
            groupHistory: parsePermission(rawPermissions ? rawPermissions.groupHistory : null),
          })
          const rawOps = diagObject(raw.operations)
          const operations = {}
          for (const op of DIAG_IMAGE_OPERATIONS) {
            const entry = rawOps ? diagObject(rawOps[op]) : null
            operations[op] = entry ? Object.freeze({
              attempted: diagInt(entry.attempted),
              succeeded: diagInt(entry.succeeded),
              failed: diagInt(entry.failed),
              unknown: diagInt(entry.deliveryUnknown !== undefined ? entry.deliveryUnknown : entry.unknown),
            }) : null
          }
          const receiptErrors = diagInt(raw.receiptErrors) // 后台契约：单个非负整数计数
          return Object.freeze({
            available: raw.available === true,
            permissions,
            operations: Object.freeze(operations),
            receiptErrors,
            receiptData: receiptErrors !== null && receiptErrors > 0,
          })
        }

        // 视图归一：只读 schemaVersion 1 的白名单字段；权限 grant 与实际调用证据
        // 是两个独立证据域，granted 决不冒充 observed_success；缺字段一律 null→未观测。
        function larkDiagnosticsView(channel) {
          const diag = diagObject(channel && channel.diagnostics)
          if (!diag || diag.schemaVersion !== 1) return { available: false }
          const permissions = diagObject(diag.permissions) || {}
          const cardkitWrite = diagObject(permissions.cardkitWrite) || {}
          const cardkit = diagObject(diag.cardkit) || {}
          const operations = diagObject(diag.operations) || {}
          const stream = diagObject(diag.stream) || {}
          const hostSeen = diagObject(stream.hostSeen) || {}
          const engineAccepted = diagObject(stream.engineAccepted) || {}
          const engineRejected = diagObject(stream.engineRejected) || {}
          const finalStatic = diagObject(stream.finalStatic) || {}
          const localRefusals = diagObject(stream.localRefusals) || {}
          const turn = diagObject(diag.turn)
          const timings = turn ? (diagObject(turn.timings) || {}) : {}
          const turnCounts = turn ? (diagObject(turn.counts) || {}) : {}
          const turnStatic = turn ? (diagObject(turn.staticFinal) || {}) : {}
          const turnCompletion = turn ? (diagObject(turn.completion) || {}) : {}
          const turnFailureRaw = turn ? turn.failureReason : undefined
          const turnEndKindRaw = turn ? turn.endKind : undefined
          // 三态判定：有值（白名单或未知）vs null/缺字段（未提供）；非字符串有值也归「未知」，绝不原样渲染。
          const hasFailureReason = Boolean(turn)
            && !(turnFailureRaw === null || turnFailureRaw === undefined || turnFailureRaw === '')
          const hasEndKind = Boolean(turn)
            && !(turnEndKindRaw === null || turnEndKindRaw === undefined || turnEndKindRaw === '')

          // 固定白名单 scope：即使后端给了 requiredScope 字段也不采信任意字符串。
          const requiredScope = REQUIRED_CARDKIT_SCOPE
          const grantState = diagOneOf(cardkitWrite.grant, DIAG_GRANT_STATES) || 'unknown'
          const queryState = diagOneOf(cardkitWrite.queryState, DIAG_QUERY_STATES) || null
          const failedCategory = diagOneOf(cardkitWrite.failedCategory, DIAG_GRANT_FAILED_CATEGORIES) || null
          const lastFailureRaw = diagObject(cardkit.lastFailure)
          const cardkitState = diagOneOf(cardkit.state, DIAG_CARDKIT_STATES) || 'unknown'
          const rawFailureCategory = lastFailureRaw ? lastFailureRaw.category : undefined
          const lastFailure = lastFailureRaw ? {
            operation: DIAG_OPERATIONS.indexOf(lastFailureRaw.operation) !== -1 ? lastFailureRaw.operation : null,
            httpStatus: diagCount(lastFailureRaw.httpStatus),
            apiCode: diagCount(lastFailureRaw.apiCode),
            category: diagOneOf(rawFailureCategory, DIAG_FAILURE_CATEGORIES),
            // 类别存在但不在白名单：显示「未知类别」，绝不原样渲染。
            categoryUnknown: typeof rawFailureCategory === 'string' && rawFailureCategory !== ''
              && diagOneOf(rawFailureCategory, DIAG_FAILURE_CATEGORIES) === null,
            // scope 只有命中固定白名单才显示/参与判定，其余字符串一律丢弃。
            scope: lastFailureRaw.scope === REQUIRED_CARDKIT_SCOPE ? REQUIRED_CARDKIT_SCOPE : null,
            at: formatDiagTime(lastFailureRaw.at),
          } : null
          // 缺权判定白名单：grant=denied；或（固定 scope 命中且非 300311）且
          // cardkit.state=denied / category=scope_denied / apiCode=99991672 之一；
          // 300311（目标卡片身份）永远不算缺 scope。
          const failureMatchesScope = Boolean(lastFailure) && lastFailure.scope === requiredScope
          const scopeDenied = grantState === 'denied'
            || (failureMatchesScope
              && lastFailure.apiCode !== 300311
              && (cardkitState === 'denied'
                || lastFailure.category === 'scope_denied'
                || lastFailure.apiCode === 99991672))
          const operationsVerified = Array.isArray(cardkit.operationsVerified)
            ? cardkit.operationsVerified.filter((op) => DIAG_OPERATIONS.indexOf(op) !== -1)
            : []
          const ops = {}
          for (const op of DIAG_OPERATIONS) {
            const entry = diagObject(operations[op])
            ops[op] = entry ? {
              attempted: diagCount(entry.attempted),
              succeeded: diagCount(entry.succeeded),
              failed: diagCount(entry.failed),
              deliveryUnknown: diagCount(entry.deliveryUnknown),
            } : null
          }
          const userState = diagOneOf(diag.userState, DIAG_USER_STATES)
          return {
            available: true,
            generation: diagLocalId(diag.generation),
            configuredMode: diagOneOf(diag.configuredMode, ['card', 'text']),
            grant: {
              state: grantState,
              source: cardkitWrite.source === 'scope_read' ? 'scope_read' : null,
              checkedAt: formatDiagTime(cardkitWrite.checkedAt),
              queryState,
              failedCategory: queryState === 'failed' ? (failedCategory || null) : null,
              stale: cardkitWrite.stale === true,
              requiredScope,
            },
            evidence: {
              state: cardkitState,
              operationsVerified,
              lastFailure,
            },
            observedMode: diagOneOf(stream.observedMode, DIAG_OBSERVED_MODES),
            userState,
            scopeDenied: Boolean(scopeDenied) || userState === 'missing_scope',
            staticFinal: {
              count: diagCount(finalStatic.count),
              lastReason: diagReason(finalStatic.lastReason),
              lastAt: formatDiagTime(finalStatic.lastAt),
            },
            engine: {
              hostSeen: {
                start: diagCount(hostSeen.start),
                chunk: diagCount(hostSeen.chunk),
                textDelta: diagCount(hostSeen.textDelta),
                blockEnd: diagCount(hostSeen.blockEnd),
                end: diagCount(hostSeen.end),
              },
              accepted: {
                start: diagCount(engineAccepted.start),
                textDelta: diagCount(engineAccepted.textDelta),
                end: diagCount(engineAccepted.end),
              },
              rejected: {
                duplicateRevision: diagCount(engineRejected.duplicateRevision),
                duplicateIndex: diagCount(engineRejected.duplicateIndex),
                regressedRevision: diagCount(engineRejected.regressedRevision),
                denseIndexGap: diagCount(engineRejected.denseIndexGap),
                shape: diagCount(engineRejected.shape),
                unbound: diagCount(engineRejected.unbound),
                stale: diagCount(engineRejected.stale),
              },
              finalReceived: diagCount(stream.finalReceived),
              turnEndReceived: diagCount(stream.turnEndReceived),
              aborted: diagCount(stream.aborted),
            },
            refusals: {
              count: diagCount(localRefusals.count),
              lastCategory: diagOneOf(localRefusals.lastCategory, DIAG_LOCAL_REFUSAL_CATEGORIES),
              lastAt: formatDiagTime(localRefusals.lastAt),
            },
            turn: turn ? {
              // turnId 只收本地匿名安全整数；outcome 只收 v1 固定枚举（未知显示为 —）。
              turnId: diagLocalId(turn.turnId),
              step: diagCount(turn.step),
              startedAt: formatDiagTime(turn.startedAt),
              outcome: diagOneOf(turn.outcome, DIAG_TURN_OUTCOMES),
              // 失败原因三态：白名单译名 / 有值但未知（固定占位） / null或缺字段（未提供）。
              failureReason: hasFailureReason ? diagOneOf(turnFailureRaw, DIAG_FAILURE_REASONS) : null,
              failureReasonUnknown: hasFailureReason && diagOneOf(turnFailureRaw, DIAG_FAILURE_REASONS) === null,
              failureReasonMissing: !hasFailureReason,
              endKind: hasEndKind ? diagOneOf(turnEndKindRaw, DIAG_TURN_END_KINDS) : null,
              endKindUnknown: hasEndKind && diagOneOf(turnEndKindRaw, DIAG_TURN_END_KINDS) === null,
              // 收尾进度（严格非负安全整数）：解释在途/开闭卡；缺字段全 null → 不出行。
              completion: {
                pendingTasks: diagInt(turnCompletion.pendingTasks),
                pendingOps: diagInt(turnCompletion.pendingOps),
                enginesPending: diagInt(turnCompletion.enginesPending),
                cardsOpened: diagInt(turnCompletion.cardsOpened),
                cardsClosed: diagInt(turnCompletion.cardsClosed),
                incompleteSteps: diagInt(turnCompletion.incompleteSteps),
              },
              timings: {
                firstAcceptedTextDeltaMs: diagCount(timings.firstAcceptedTextDeltaMs),
                firstDeliveryAckMs: diagCount(timings.firstDeliveryAckMs),
                firstPutDispatchMs: diagInt(timings.firstPutDispatchMs),
                lastPutDispatchMs: diagInt(timings.lastPutDispatchMs),
                firstPutSuccessMs: diagCount(timings.firstPutSuccessMs),
                lastPutSuccessMs: diagCount(timings.lastPutSuccessMs),
                finalReceivedMs: diagCount(timings.finalReceivedMs),
                liveEndMs: diagCount(timings.liveEndMs),
                turnEndMs: diagCount(timings.turnEndMs),
                terminalCloseMs: diagCount(timings.terminalCloseMs),
              },
              counts: {
                acceptedTextDelta: diagCount(turnCounts.acceptedTextDelta),
                putBeforeFinal: diagCount(turnCounts.putBeforeFinal),
                putBeforeTurnEnd: diagCount(turnCounts.putBeforeTurnEnd),
                putDispatchedBeforeFinal: diagInt(turnCounts.putDispatchedBeforeFinal),
                putDispatchedBeforeTurnEnd: diagInt(turnCounts.putDispatchedBeforeTurnEnd),
                putTotal: diagCount(turnCounts.putTotal),
              },
              staticFinal: { used: turnStatic.used === true, reason: diagReason(turnStatic.reason) },
            } : null,
            ops,
            dedup: larkDedupView(diag),
            images: larkImagesView(diag),
            opHasData(entry) {
              if (!entry) return false
              return ['attempted', 'succeeded', 'failed', 'deliveryUnknown']
                .some((key) => entry[key] !== null)
            },
          }
        }

        // 诊断面板：只渲染视图白名单字段（已消毒/封顶）；不新增按钮与请求。
        function LarkDiagnosticsPanel(props) {
          const t = props.t || fallbackT
          const channel = props.channel || {}
          const view = larkDiagnosticsView(channel)
          const none = t('diag.none')
          const row = (key, label, value, style) => React.createElement(
            'div',
            { 'data-diag': key, style: style || styles.muted },
            label ? label + ': ' + value : value,
          )
          const connStyle = channel.state === 'running'
            ? styles.stateRunning
            : (channel.state === 'error' ? styles.stateError : styles.stateDisabled)
          const box = [
            React.createElement('div', { key: 'title', 'data-diag': 'title', style: styles.setupTitle }, t('diag.title')),
            row('connection', t('diag.connection'), sanitizeDiagText(channel.state, 32) || t('diag.unknownValue'), connStyle),
          ]
          if (!view.available) {
            box.push(row('missing', null, t('diag.missing'), styles.stateDisabled))
            return React.createElement('div', { style: styles.setupBox }, box)
          }
          box.push(row('configured', t('diag.configured'), view.configuredMode ? t('diag.mode.' + view.configuredMode) : none, styles.muted))
          box.push(row('observed', t('diag.observed'), view.observedMode ? t('diag.out.' + view.observedMode) : t('diag.notObserved'), styles.muted))

          // 权限查询（grant）：unknown 永不显绿；granted 只代表 scope 读取结果。
          const grantStyle = view.grant.state === 'granted'
            ? styles.stateRunning
            : (view.grant.state === 'denied' ? styles.stateError : styles.stateDisabled)
          let grantText = view.grant.state === 'granted'
            ? t('diag.grantGranted')
            : (view.grant.state === 'denied' ? t('diag.grantDenied') : t('diag.grantUnknown'))
          if (view.grant.state !== 'unknown') {
            if (view.grant.source) grantText += t('diag.grantMeta', { source: view.grant.source, at: view.grant.checkedAt || none })
            else if (view.grant.checkedAt) grantText += t('diag.grantMetaAt', { at: view.grant.checkedAt })
          }
          if (view.grant.queryState) {
            grantText += ' · ' + (view.grant.queryState === 'failed'
              ? t('diag.query.failed', { category: view.grant.failedCategory || t('diag.unknownValue') })
              : t('diag.query.' + view.grant.queryState))
          }
          if (view.grant.stale) grantText += ' · ' + t('diag.query.stale')
          box.push(row('grant', t('diag.grant'), grantText, grantStyle))

          // 只读权限刷新：无接口（旧版）时隐藏；单飞/5s 窗口内禁用；结果只分四态，
          // 错误全部走本地枚举译名，不渲染原始 response。成功查询≠grant 变绿（grant 行独立）。
          if (typeof props.onRefreshScope === 'function') {
            const scopeState = props.scope || {}
            const refreshing = scopeState.state === 'in_flight'
            // 冷却由 controller 本地定时器到期 publish 驱动，不依赖轮询重渲染。
            box.push(React.createElement('button', {
              key: 'refresh',
              'data-diag': 'refresh',
              style: styles.button,
              disabled: Boolean(refreshing || scopeState.coolingDown),
              onClick: props.onRefreshScope,
            }, refreshing ? t('diag.refreshing') : t('diag.refresh')))
            box.push(React.createElement('div', { key: 'refreshHint', 'data-diag': 'refreshHint', style: styles.muted }, t('diag.refreshHint')))
            if (scopeState.state === 'ok') {
              // 完成标记绑定 epoch+generation：组件层同样只在与当前权威 status 完全一致时
              // 显示绿色；换实例（即便 generation 相同）、身份未知/缺失都撤绿，不假绿。
              const diagGen = view.available ? view.generation : null
              const markerGen = scopeState.generation
              const markerEpoch = scopeState.epoch
              const genMatch = diagGen !== null && markerGen !== null && markerGen !== undefined && String(markerGen) === diagGen
              if (props.statusEpoch === null) {
                box.push(row('refreshStatus', t('diag.refreshStatus'), t('diag.refreshError.identity_unknown'), styles.stateError))
              } else if (props.statusEpoch === undefined) {
                // 旧后端无身份字段：从未携带过 epoch 的标记按 generation 链展示；携带过的降级为未确认。
                if (markerEpoch !== null && markerEpoch !== undefined) {
                  box.push(row('refreshStatus', t('diag.refreshStatus'), t('diag.refreshError.stale_generation'), styles.stateError))
                } else if (genMatch) {
                  box.push(row('refreshStatus', t('diag.refreshStatus'), t('diag.refreshOk'), styles.stateRunning))
                }
              } else if (markerEpoch === null || markerEpoch === undefined || markerEpoch !== props.statusEpoch) {
                box.push(row('refreshStatus', t('diag.refreshStatus'), t('diag.refreshError.stale_generation'), styles.stateError))
              } else if (genMatch) {
                box.push(row('refreshStatus', t('diag.refreshStatus'), t('diag.refreshOk'), styles.stateRunning))
              } else if (diagGen !== null && markerGen !== null && markerGen !== undefined) {
                box.push(row('refreshStatus', t('diag.refreshStatus'), t('diag.refreshError.stale_generation'), styles.stateError))
              }
              // 代际缺失（旧版/降级）→ 不显示成功也不显示错误（未确认不绿）。
            } else if (scopeState.state === 'error') {
              const errKey = DIAG_REFRESH_ERRORS.indexOf(scopeState.error) !== -1 ? scopeState.error : 'api_error'
              box.push(row('refreshStatus', t('diag.refreshStatus'), t('diag.refreshError.' + errKey), styles.stateError))
            }
          }

          // 实际操作证据：只有真实调用成功（observed_success）才显绿。
          const evStyle = view.evidence.state === 'observed_success'
            ? styles.stateRunning
            : (view.evidence.state === 'denied' ? styles.stateError : styles.stateDisabled)
          let evText = view.evidence.state === 'observed_success'
            ? t('diag.evSuccess')
            : (view.evidence.state === 'denied' ? t('diag.evDenied') : t('diag.evUnknown'))
          if (view.evidence.operationsVerified.length) {
            evText += ' · ' + t('diag.evVerified', {
              ops: view.evidence.operationsVerified.map((op) => t('diag.op.' + op)).join('/'),
            })
          }
          const failure = view.evidence.lastFailure
          if (failure) {
            const parts = []
            if (failure.operation) parts.push(failure.operation)
            if (failure.httpStatus !== null) parts.push('HTTP ' + failure.httpStatus)
            if (failure.apiCode !== null) parts.push('code ' + failure.apiCode)
            // 失败类别固定枚举译名；未知类别显示占位，绝不原样显示后端字符串。
            if (failure.category) parts.push(t('diag.cat.' + failure.category))
            else if (failure.categoryUnknown) parts.push(t('diag.unknownCategory'))
            if (failure.at) parts.push(failure.at)
            if (parts.length) evText += ' — ' + parts.join(' · ')
            if (failure.scope) evText += ' · ' + t('diag.evScope', { scope: failure.scope })
          }
          box.push(row('evidence', t('diag.evidence'), evText, evStyle))

          // 诊断结论（userState）与 observedMode / staticFinal 并列，互不掩盖。
          const userStyle = (view.userState === 'live_card' || view.userState === 'multi_text' || view.userState === 'completed')
            ? styles.stateRunning
            : ((view.userState === 'missing_scope' || view.userState === 'failed') ? styles.stateError : styles.stateDisabled)
          box.push(row('userState', t('diag.userState'), t('diag.user.' + (view.userState || 'unknown')), userStyle))
          // 失败原因：固定枚举中英译名；未知/原文绝不渲染；无字段（含旧版）=「未提供」，不猜。
          // 与下方收尾进度共同解释在途，不把业务分支猜成后端已声明的原因。
          if (view.turn && (view.turn.outcome === 'failed' || view.turn.failureReason || view.turn.failureReasonUnknown)) {
            const frText = view.turn.failureReason
              ? t('diag.fr.' + view.turn.failureReason)
              : (view.turn.failureReasonUnknown ? t('diag.frUnknown') : t('diag.frMissing'))
            box.push(row('failureReason', t('diag.failureReason'), frText,
              view.turn.outcome === 'failed' ? styles.stateError : styles.muted))
          }
          if (view.staticFinal.count !== null || view.staticFinal.lastReason) {
            box.push(row('staticFinal', t('diag.staticFinal'), t('diag.staticFinalRow', {
              count: view.staticFinal.count === null ? none : view.staticFinal.count,
              reason: view.staticFinal.lastReason ? t('diag.fb.' + view.staticFinal.lastReason) : none,
              at: view.staticFinal.lastAt || none,
            }), styles.muted))
          }

          // 首段发送确认延迟（起点=首个 accepted delta）；无值/非流式 → 未观测。
          const ackMs = view.turn ? view.turn.timings.firstDeliveryAckMs : null
          box.push(React.createElement('div', { key: 'firstAck', 'data-diag': 'firstAck', style: styles.muted },
            t('diag.firstAckLabel') + ': '
            + (ackMs !== null ? ackMs + ' ms ' + t('diag.firstAckNote') : t('diag.notObserved'))))

          if (view.turn) {
            const counts = view.turn.counts
            const counterParts = []
            if (counts.acceptedTextDelta !== null) counterParts.push(t('diag.textDelta', { n: counts.acceptedTextDelta }))
            if (counts.putBeforeFinal !== null) counterParts.push(t('diag.putBeforeFinal', { n: counts.putBeforeFinal }))
            if (counts.putBeforeTurnEnd !== null) counterParts.push(t('diag.putBeforeTurnEnd', { n: counts.putBeforeTurnEnd }))
            // 派发与确认成功（ACK）是两套口径：派发只是发出请求，成功 ACK 才是确认。
            if (counts.putDispatchedBeforeFinal !== null || counts.putDispatchedBeforeTurnEnd !== null) {
              counterParts.push(t('diag.putDispatch', {
                f: counts.putDispatchedBeforeFinal === null ? none : counts.putDispatchedBeforeFinal,
                t: counts.putDispatchedBeforeTurnEnd === null ? none : counts.putDispatchedBeforeTurnEnd,
              }))
            }
            if (counts.putTotal !== null) counterParts.push(t('diag.putTotal', { n: counts.putTotal }))
            if (counterParts.length) {
              box.push(row('counters', t('diag.counters'), counterParts.join(' · '), styles.muted))
            }
            // 收尾进度：待结任务/操作/引擎与开闭卡数，解释「在途/为何未完结」；全缺字段不出行。
            const comp = view.turn.completion
            const compValues = [comp.pendingTasks, comp.pendingOps, comp.enginesPending, comp.cardsOpened, comp.cardsClosed, comp.incompleteSteps]
            if (compValues.some((value) => value !== null)) {
              box.push(row('completion', t('diag.completion'), t('diag.completionRow', {
                pt: comp.pendingTasks === null ? none : comp.pendingTasks,
                po: comp.pendingOps === null ? none : comp.pendingOps,
                ep: comp.enginesPending === null ? none : comp.enginesPending,
                co: comp.cardsOpened === null ? none : comp.cardsOpened,
                cc: comp.cardsClosed === null ? none : comp.cardsClosed,
                is: comp.incompleteSteps === null ? none : comp.incompleteSteps,
              }), styles.muted))
            }
            // 结束方式（committed/abandoned）：未知/原文不渲染，缺字段不出行。
            if (view.turn.endKind || view.turn.endKindUnknown) {
              box.push(row('endKind', t('diag.endKind'), view.turn.endKind
                ? t('diag.ek.' + view.turn.endKind)
                : t('diag.ekUnknown'), styles.muted))
            }
            const tm = view.turn.timings
            const timingKeys = ['firstAcceptedTextDeltaMs', 'firstPutDispatchMs', 'lastPutDispatchMs', 'firstPutSuccessMs', 'lastPutSuccessMs', 'finalReceivedMs', 'liveEndMs', 'turnEndMs', 'terminalCloseMs']
            if (timingKeys.some((key) => tm[key] !== null)) {
              box.push(row('timings', t('diag.timings'), t('diag.timingsRow', {
                fad: tm.firstAcceptedTextDeltaMs === null ? none : tm.firstAcceptedTextDeltaMs,
                fd: tm.firstPutDispatchMs === null ? none : tm.firstPutDispatchMs,
                ld: tm.lastPutDispatchMs === null ? none : tm.lastPutDispatchMs,
                fp: tm.firstPutSuccessMs === null ? none : tm.firstPutSuccessMs,
                lp: tm.lastPutSuccessMs === null ? none : tm.lastPutSuccessMs,
                fr: tm.finalReceivedMs === null ? none : tm.finalReceivedMs,
                le: tm.liveEndMs === null ? none : tm.liveEndMs,
                te: tm.turnEndMs === null ? none : tm.turnEndMs,
                tc: tm.terminalCloseMs === null ? none : tm.terminalCloseMs,
              }), styles.muted))
            }
            if (view.turn.turnId || view.turn.outcome || view.turn.startedAt || view.turn.step !== null) {
              box.push(row('turn', null, t('diag.turnMeta', {
                id: view.turn.turnId || none,
                step: view.turn.step === null ? none : view.turn.step,
                outcome: view.turn.outcome ? t('diag.oc.' + view.turn.outcome) : none,
                at: view.turn.startedAt || none,
              }), styles.muted))
            }
            if (view.turn.staticFinal.used || view.turn.staticFinal.reason) {
              box.push(row('turnStatic', t('diag.turnStatic'), t('diag.turnStaticRow', {
                used: view.turn.staticFinal.used ? t('settings.yes') : t('settings.no'),
                reason: view.turn.staticFinal.reason ? t('diag.fb.' + view.turn.staticFinal.reason) : none,
              }), styles.muted))
            }
          }

          // 去重账本状态（旧版缺块隐藏）：lastError 固定枚举主导（存在时绝不显示 healthy）；
          // reopen 用权威字段；当前满仅 used>=capacity，历史背压单独展示；重开指引指向状态
          // 面板顶部「重新加载」（真实 POST reload），记录保留待接线验证；无清空/删除账本
          // 功能，容量配置待接入；锁能力缺失只影响飞书持久处理。
          if (view.dedup) {
            const dd = view.dedup
            const ddParts = []
            if (dd.lastError) ddParts.push(t('diag.dedupErr.' + dd.lastError)) // 错误主导，绝不 healthy
            else if (dd.lastErrorUnknown) ddParts.push(t('diag.dedupErrUnknown')) // N1：白名单外固定占位
            if (!dd.available) ddParts.push(t('diag.dedup.unavailable'))
            else if (dd.poisoned) ddParts.push(t('diag.dedup.poisoned'))
            else if (dd.lockMode !== 'flock') ddParts.push(t('diag.dedup.noLock'))
            else if (!dd.lastError && !dd.lastErrorUnknown) ddParts.push(t('diag.dedup.ok'))
            if (dd.reopen === 'needed') ddParts.push(t('diag.dedup.reopenHint'))
            if (dd.currentFull) ddParts.push(t('diag.dedup.backpressure'))
            const ddUnhealthy = dd.lastError !== null || dd.lastErrorUnknown || !dd.available || dd.poisoned || dd.lockMode !== 'flock'
            box.push(row('dedupStatus', t('diag.dedup.title'), ddParts.join(' · '),
              ddUnhealthy ? styles.stateError : styles.muted))
            const ddCountParts = []
            if (dd.counts.claims !== null) ddCountParts.push(t('diag.dedup.claims', { n: dd.counts.claims }))
            if (dd.counts.delivered !== null) ddCountParts.push(t('diag.dedup.delivered', { n: dd.counts.delivered }))
            if (dd.counts.rejected !== null) ddCountParts.push(t('diag.dedup.rejected', { n: dd.counts.rejected }))
            if (dd.counts.recoverable !== null) ddCountParts.push(t('diag.dedup.recoverable', { n: dd.counts.recoverable }))
            if (dd.counts.sendRecords !== null) {
              let sendPart = t('diag.dedup.sendUsed', { u: dd.counts.sendRecords, c: dd.capacity !== null ? String(dd.capacity) : none })
              if (dd.capacity === null) sendPart += ' · ' + t('diag.dedup.capMissing')
              else if (dd.capacitySource === 'default') sendPart += t('diag.dedup.capDefault')
              else if (dd.capacitySource === 'configured') sendPart += t('diag.dedup.capConfigured')
              ddCountParts.push(sendPart)
            }
            if (dd.counts.sendSent !== null) ddCountParts.push(t('diag.dedup.sendSent', { n: dd.counts.sendSent }))
            // 历史容量背压（累计）：单独展示，绝不作为“当前满”的依据。
            if (dd.counts.sendCapacityErrors !== null && dd.counts.sendCapacityErrors > 0) {
              ddCountParts.push(t('diag.dedup.histBackpressure', { n: dd.counts.sendCapacityErrors }))
            }
            // N2：available 严格 true 才显示计数/容量读数（不可用时的全 0 不是实际读数）；
            // 状态/恢复指引行在上方，不受此门影响。
            if (dd.available && ddCountParts.length) {
              box.push(row('dedupCounts', t('diag.dedup.counters'), ddCountParts.join(' · '), styles.muted))
              box.push(row('dedupHint', null, t('diag.dedup.capacityNote'), styles.muted))
            }
          }

          // 图片诊断（旧版/未知 schema 缺块隐藏）：三权限只显后台 grant（固定 scope 附说明），
          // 三操作桶为实际收发证据（与 grant 分开）；receipt 错误固定译名，不渲路径/ID/原文。
          if (view.images) {
            const im = view.images
            box.push(row('imgStatus', t('diag.img.title'),
              im.available ? t('diag.img.available') : t('diag.img.unavailable'),
              im.available ? styles.muted : styles.stateError))
            const imgPermRow = (key, labelKey, perm, scopes) => {
              const grantStyle = perm.grant === 'granted'
                ? styles.stateRunning
                : (perm.grant === 'denied' ? styles.stateError : styles.stateDisabled)
              let text = t('diag.img.grant.' + perm.grant)
              if (perm.stale) text += ' ' + t('diag.img.stale')
              if (perm.checkedAt !== null) text += ' · ' + t('diag.img.checkedAt', { at: formatDiagTime(perm.checkedAt) || none })
              text += ' · ' + t('diag.img.scopeNote', { scopes: scopes.join(' | ') })
              return row(key, t(labelKey), text, grantStyle)
            }
            box.push(imgPermRow('imgPermUpload', 'diag.img.permUpload', im.permissions.upload, DIAG_SCOPE_UPLOAD))
            box.push(imgPermRow('imgPermDownload', 'diag.img.permDownload', im.permissions.download, DIAG_SCOPE_DOWNLOAD))
            box.push(imgPermRow('imgPermGroupHistory', 'diag.img.permGroupHistory', im.permissions.groupHistory, DIAG_SCOPE_GROUP_HISTORY))
            for (const op of DIAG_IMAGE_OPERATIONS) {
              const entry = im.operations[op]
              if (!entry) continue
              // 实际收发证据：至少一项 >0 才出行（全零/全缺不出行，不冒充实发活动）。
              if (![entry.attempted, entry.succeeded, entry.failed, entry.unknown].some((v) => v !== null && v > 0)) continue
              box.push(row('imgOp_' + op, t('diag.img.op.' + op), t('diag.img.opRow', {
                a: entry.attempted === null ? none : entry.attempted,
                s: entry.succeeded === null ? none : entry.succeeded,
                f: entry.failed === null ? none : entry.failed,
                u: entry.unknown === null ? none : entry.unknown,
              }), styles.muted))
            }
            if (im.receiptData) {
              box.push(row('imgReceipts', t('diag.img.receipts'), t('diag.img.receiptCount', { n: im.receiptErrors }), styles.muted))
            }
          }

          // 帧/引擎计数与回合事件（仅在有数据时出现）。
          const engine = view.engine
          const engineParts = []
          const hs = engine.hostSeen
          if ([hs.start, hs.chunk, hs.textDelta, hs.blockEnd, hs.end].some((n) => n !== null)) {
            engineParts.push(t('diag.engineHost', {
              s: hs.start === null ? none : hs.start,
              c: hs.chunk === null ? none : hs.chunk,
              d: hs.textDelta === null ? none : hs.textDelta,
              b: hs.blockEnd === null ? none : hs.blockEnd,
              e: hs.end === null ? none : hs.end,
            }))
          }
          const ac = engine.accepted
          if ([ac.start, ac.textDelta, ac.end].some((n) => n !== null)) {
            engineParts.push(t('diag.engineAccepted', {
              s: ac.start === null ? none : ac.start,
              d: ac.textDelta === null ? none : ac.textDelta,
              e: ac.end === null ? none : ac.end,
            }))
          }
          const rj = engine.rejected
          if ([rj.duplicateRevision, rj.duplicateIndex, rj.regressedRevision, rj.denseIndexGap, rj.shape, rj.unbound, rj.stale].some((n) => n !== null)) {
            engineParts.push(t('diag.engineRejected', {
              dup: rj.duplicateRevision === null ? none : rj.duplicateRevision,
              dupidx: rj.duplicateIndex === null ? none : rj.duplicateIndex,
              reg: rj.regressedRevision === null ? none : rj.regressedRevision,
              gap: rj.denseIndexGap === null ? none : rj.denseIndexGap,
              shape: rj.shape === null ? none : rj.shape,
              unbound: rj.unbound === null ? none : rj.unbound,
              stale: rj.stale === null ? none : rj.stale,
            }))
          }
          if (engineParts.length) {
            box.push(row('engine', t('diag.engine'), engineParts.join(' · '), styles.muted))
          }
          // 本地拒绝（malformed/budget/shape）：未发请求，不计入网络操作计数，单独展示。
          if (view.refusals.count !== null || view.refusals.lastCategory || view.refusals.lastAt) {
            box.push(row('refusals', t('diag.refusals'), t('diag.refusalsRow', {
              count: view.refusals.count === null ? none : view.refusals.count,
              category: view.refusals.lastCategory ? t('diag.cat.' + view.refusals.lastCategory) : none,
              at: view.refusals.lastAt || none,
            }), styles.muted))
          }
          if (engine.finalReceived !== null || engine.turnEndReceived !== null || engine.aborted !== null) {
            box.push(row('turnEvents', t('diag.turns'), t('diag.turnsRow', {
              f: engine.finalReceived === null ? none : engine.finalReceived,
              t: engine.turnEndReceived === null ? none : engine.turnEndReceived,
              a: engine.aborted === null ? none : engine.aborted,
            }), styles.muted))
          }

          // 操作计数（只渲染白名单枚举内、且有数据的桶）。
          const opSegments = []
          for (const op of DIAG_OPERATIONS) {
            const entry = view.ops[op]
            if (!view.opHasData(entry)) continue
            opSegments.push(t('diag.opsRow', {
              label: t('diag.op.' + op),
              a: entry.attempted === null ? none : entry.attempted,
              s: entry.succeeded === null ? none : entry.succeeded,
              f: entry.failed === null ? none : entry.failed,
              u: entry.deliveryUnknown === null ? none : entry.deliveryUnknown,
            }))
          }
          if (opSegments.length) {
            box.push(row('ops', t('diag.ops'), opSegments.join(' · '), styles.muted))
          }

          if (view.generation) {
            box.push(row('generation', null, t('diag.generation', { gen: view.generation }), styles.muted))
          }

          // 缺权最少步骤：仅 grant=denied / userState=missing_scope / 99991672+精确 scope；
          // 300311（目标卡片身份）等其他 code 永不触发；不提供自动降级或申请按钮。
          if (view.scopeDenied) {
            box.push(React.createElement('div', { key: 'fixTitle', 'data-diag': 'fix', style: styles.setupTitle }, t('diag.fixTitle')))
            box.push(React.createElement('div', { key: 'fix1', 'data-diag': 'fix', style: styles.setupHint }, t('diag.fix1')))
            box.push(React.createElement('div', { key: 'fix2', 'data-diag': 'fix', style: styles.setupHint }, t('diag.fix2')))
            box.push(React.createElement('div', { key: 'fix3', 'data-diag': 'fix', style: styles.setupHint }, t('diag.fix3')))
            box.push(React.createElement('div', { key: 'fixScope', 'data-diag': 'fix', style: styles.setupHint }, t('diag.requiredScope', { scope: view.grant.requiredScope })))
            box.push(React.createElement('div', { key: 'fixNoSecret', 'data-diag': 'fix', style: styles.setupHint }, t('diag.fixNoSecret')))
            box.push(React.createElement('div', { key: 'fixNoDowngrade', 'data-diag': 'fix', style: styles.setupHint }, t('diag.fixNoDowngrade')))
          }
          return React.createElement('div', { style: styles.setupBox }, box)
        }

        // ── P3：配置入口从「设置」迁到插件页（plugins.row.config）────────────
        // 宿主 bundle 内置模块（官方卡片同样直接 require）；拿不到时退回自绘外壳。
        let OfficialSettingsForm = null
        try {
          OfficialSettingsForm = require('@deepseek-ai/dsh-client-ui-primitives').SettingsForm
        } catch (formError) {
          OfficialSettingsForm = null
        }

        const SETTINGS_NS = 'dsh-messaging'
        // 行 id 取自 cordis.patch.yml 的 `id: dsh-messaging`。
        const PLUGIN_ROW_KEY = 'dsh-messaging#dsh-messaging'

        function readPathValue(root, dotted) {
          let cursor = root
          const keys = dotted.split('.')
          for (let index = 0; index < keys.length; index += 1) {
            if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
            cursor = cursor[keys[index]]
          }
          return cursor
        }

        function settingsMirror() {
          try {
            const configForms = ctx.get('configForms')
            if (!configForms || typeof configForms.describe !== 'function') return null
            return configForms.describe()
          } catch (mirrorError) {
            return null
          }
        }

        // 密钥「是否已设置」来自 Host describe({redactSecrets:true}) 的 sidecar：
        // 它随镜像下发（form.state 只有 value/base/user/revision/writable/status）。
        // ── P4：状态与传输都留在 apply 闭包的 controller 里，组件只拿 props ─────
        // 最小快照 store：getSnapshot 在值不变时身份稳定（slots 的 selector hook 依赖）。
        function createSnapshotStore(initial) {
          let snapshot = initial
          const listeners = new Set()
          return {
            getSnapshot: () => snapshot,
            set(next) {
              if (Object.is(next, snapshot)) return false
              snapshot = next
              for (const listener of [...listeners]) listener()
              return true
            },
            listeners,
          }
        }

        const STATUS_POLL_MS = 5000
        const LOGIN_POLL_MS = 1000

        function sameSecrets(left, right) {
          const a = left || {}
          const b = right || {}
          const keys = Object.keys(a)
          if (keys.length !== Object.keys(b).length) return false
          for (const key of keys) if (Boolean(a[key]) !== Boolean(b[key])) return false
          return true
        }

        // 状态面板：轮询 /status。只有存在订阅者时才发请求，没有订阅者就停。
        function createStatusController() {
          const store = createSnapshotStore({ data: null, error: '', busy: false, scope: { inFlight: false, state: 'idle', error: '', at: 0 } })
          let timer = null
          const publish = (patch) => store.set(Object.assign({}, store.getSnapshot(), patch))
          // 状态读取统一护栏：单调 requestId（迟到旧 GET 不发布不回滚）+ 已观测代际只增
          // 不减 + 发布前最小形状校验；所有 GET 异常一律固定公开枚举 status_failed，
          // 绝不把 loadError.message / raw response 写入 store 或全局 UI（轮询/重载/刷新同口径）。
          // options.guard：dispose 后的迟到结果不发布；返回 true（成功）/ false（失败或形状
          // 不合格）/'expired'（被更新请求或代际取代 → 上层归类 stale_generation）。
          let statusRequestId = 0
          let lastAppliedStatusId = 0
          let observedGeneration = -1
          // 可信实例身份：后端 instanceEpoch（匿名随机非负整数，只比相等不比大小；
          // 同一次插件 apply 稳定、新 apply 不同；显式 null = 明确未知身份）。请求发出时
          // 观测到的身份用 **async 闭包**随请求存活到结算（无淘汰、无共享索引，
          // 在途身份绝不因容量被逐出）；上下文缺失一律不可信，绝不据此重置。
          let observedInstanceEpoch = null
          let identityUnknown = false // 最新已应用 status 明确报告身份未知（instanceEpoch:null）
          // 读 status 的实例身份：undefined=旧后端无字段 / null=明确未知 / 数字=已知。
          const readInstanceEpoch = (data) => {
            if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'instanceEpoch')) return undefined
            return Number.isSafeInteger(data.instanceEpoch) && data.instanceEpoch >= 0 ? data.instanceEpoch : null
          }
          // 最小可用形状：channels 必须是对象数组（面板与代际提取都迭代它），其余列表字段
          // 存在时必须是数组；HTTP 200 但形状不合格 → 保留旧快照并显示固定错误。
          const isUsableStatus = (data) => {
            if (!data || typeof data !== 'object' || Array.isArray(data)) return false
            if (!Array.isArray(data.channels)) return false
            for (const channel of data.channels) {
              if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return false
              // 组件直接渲染的字段：必须是标量（对象子节点会让 React 抛错）。
              for (const field of ['key', 'label', 'state']) {
                const value = channel[field]
                if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') return false
              }
            }
            // 实际渲染的列表项做与 channels 同口径的非 null 对象项校验（sessions/recent 会被
            // 直接读 key/at，null 项会让面板抛错）；其余未渲染字段不做全 schema 重构。
            for (const field of ['sessions', 'recent', 'errors']) {
              const value = data[field]
              if (value !== undefined && value !== null && !Array.isArray(value)) return false
              if (Array.isArray(value)) {
                for (const item of value) {
                  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
                }
              }
            }
            return true
          }
          const load = async (options) => {
            const guard = options && options.guard
            const requestId = ++statusRequestId
            const capturedEpoch = observedInstanceEpoch // 闭包随本请求存活到结算（不淘汰）
            try {
              const data = await rpc('GET', '/__dsh-messaging/status')
              if (guard && !guard()) return 'expired'
              if (requestId <= lastAppliedStatusId) return 'expired' // 过期成功：不发布、不回滚
              if (!isUsableStatus(data)) {
                lastAppliedStatusId = requestId
                publish({ data: store.getSnapshot().data, error: 'status_failed', busy: false }) // 保留旧快照
                return false
              }
              const generation = diagnosticsGenerationOf(data)
              // 实例身份判定（只比相等；捕获身份 = 本请求发出时的观测值）：
              //   响应回当前观测身份 → 同实例常规护栏；
              //   响应=本请求发出时捕获的身份但≠当前 → 旧实例迟到响应，拒绝回写（即便数字更大、
              //   请求序更新）；
              //   捕获=当前观测 && 响应≠当前 → 宿主已换实例（可信重置：清旧 scope 成功标记、
              //   代际水位归零，新实例 generation 任意起点）；
              //   捕获缺失/已被替代 → 上下文不可信，一律拒绝（fail-closed，绝不据此重置）。
              const epochOfResponse = readInstanceEpoch(data)
              let instanceReset = false
              if (epochOfResponse === null) {
                identityUnknown = true // 明确未知身份：status/诊断仍可读，但不可跨实例确认
              } else if (epochOfResponse !== undefined) {
                identityUnknown = false
                if (observedInstanceEpoch === null) {
                  observedInstanceEpoch = epochOfResponse // 首次观测：建立边界
                } else if (epochOfResponse !== observedInstanceEpoch) {
                  if (capturedEpoch !== observedInstanceEpoch || capturedEpoch === null) return 'expired' // 上下文缺失/已被替代 → 不可信
                  // captured === 当前观测 → 服务端在本请求期间换了实例（可信重置）。
                  instanceReset = true
                  observedGeneration = -1
                  observedInstanceEpoch = epochOfResponse
                  const scope = store.getSnapshot().scope
                  if (scope && !scope.inFlight && (scope.state === 'ok' || scope.state === 'error')) {
                    const marker = Object.assign({}, scope, { generation: null })
                    if (scope.state === 'ok') marker.epoch = null
                    publish({ scope: Object.assign({}, marker, { state: 'idle', error: '' }) })
                  }
                }
              }
              // 旧后端无 instanceEpoch：不做跨实例校验（保持同实例护栏）；跨实例恢复需重新加载页面。
              // 有效且非过期的响应（请求序/生命周期/旧实例护栏均已通过）报告身份未知（null）或
              // 字段缺失：必须在下方低代早返之前撤销旧 scope 成功——即便 generation 更低会拒绝本
              // 响应。缓存数据可留，但已失去当前实例保证：null → 固定 identity_unknown；缺失 →
              // 未确认（idle）。不猜 epoch、不据此重置已验证实例、不放松任何旧响应护栏。
              if (epochOfResponse === null || epochOfResponse === undefined) {
                const markerScope = store.getSnapshot().scope
                if (markerScope && markerScope.state === 'ok') {
                  const withdrawn = Object.assign({}, markerScope, { epoch: null, generation: null })
                  if (epochOfResponse === null) {
                    publish({ scope: Object.assign({}, withdrawn, { state: 'error', error: 'identity_unknown' }) })
                  } else {
                    publish({ scope: Object.assign({}, withdrawn, { state: 'idle', error: '' }) })
                  }
                }
              }
              if (!instanceReset && generation !== null && generation < observedGeneration) return 'expired' // 同实例代际回退防护
              lastAppliedStatusId = requestId
              if (generation !== null) observedGeneration = generation
              publish({ data, error: '', busy: false })
              revalidateScopeMarker(data)
              return true
            } catch (loadError) {
              if (guard && !guard()) return 'expired'
              if (requestId <= lastAppliedStatusId) return 'expired' // 过期失败也不覆盖新状态/新错误
              lastAppliedStatusId = requestId
              publish({ data: store.getSnapshot().data, error: 'status_failed', busy: false }) // 固定枚举，绝不 raw
              return false
            }
          }
          // 从权威 status 数据提取 lark diagnostics.generation（仅数组 channels，安全整数否则 null）。
          const diagnosticsGenerationOf = (data) => {
            if (!data || typeof data !== 'object' || !Array.isArray(data.channels)) return null
            for (const channel of data.channels) {
              if (channel && typeof channel === 'object' && channel.key === 'lark' && channel.diagnostics && typeof channel.diagnostics === 'object') {
                const generation = channel.diagnostics.generation
                if (Number.isSafeInteger(generation) && generation >= 0) return generation
              }
            }
            return null
          }
          // 完成标记绑定实例 epoch + 生成代际：每次 load 成功后重校验——换实例（即便
          // generation 相同）、代际变化、身份字段消失都撤旧成功；身份明确未知固定提示，不假绿。
          const revalidateScopeMarker = (data) => {
            const scope = store.getSnapshot().scope
            if (!scope || scope.state !== 'ok') return
            const epochOfData = readInstanceEpoch(data)
            if (epochOfData === null) {
              publish({ scope: Object.assign({}, scope, { state: 'error', error: 'identity_unknown', epoch: null, generation: null }) })
              return
            }
            const markerEpoch = scope.epoch
            if (epochOfData !== undefined) {
              if (markerEpoch === null || markerEpoch === undefined || markerEpoch !== epochOfData) {
                publish({ scope: Object.assign({}, scope, { state: 'error', error: 'stale_generation', epoch: null, generation: null }) })
                return
              }
            } else if (markerEpoch !== null && markerEpoch !== undefined) {
              // 身份字段消失（旧后端/降级）→ 未确认，撤下成功标记。
              publish({ scope: Object.assign({}, scope, { state: 'idle', error: '', generation: null, epoch: null }) })
              return
            }
            const fresh = diagnosticsGenerationOf(data)
            if (fresh === null) {
              publish({ scope: Object.assign({}, scope, { state: 'idle', error: '', generation: null, epoch: null }) })
              return
            }
            if (fresh !== scope.generation) {
              publish({ scope: Object.assign({}, scope, { state: 'error', error: 'stale_generation', epoch: null, generation: null }) })
            }
          }
          const start = () => {
            if (timer) return
            void load()
            timer = ctx.interval(() => { void load() }, STATUS_POLL_MS)
          }
          const stop = () => {
            if (!timer) return
            timer()
            timer = null
          }
          // 「重新加载」是服务端动作：POST /reload 让宿主整体重建，再读一次状态。
          // 重载 POST 失败同样用固定本地枚举（不渲染原始异常）；busy 由 reload 自身在
          // 终局路径清零（含 load 返回 expired），不会卡在“重载中”。
          const reload = async () => {
            publish({ busy: true })
            try {
              await rpc('POST', '/__dsh-messaging/reload', {})
            } catch (reloadError) {
              publish({ data: store.getSnapshot().data, error: 'reload_failed', busy: false })
              return
            }
            try {
              return await load()
            } finally {
              publish({ busy: false }) // 过期/失败/成功都释放自身 busy（busy 仅重载使用）
            }
          }
          // 订阅即开始轮询，最后一个订阅者离开就停（组件卸载 = hook 退订）。
          function subscribe(listener) {
            store.listeners.add(listener)
            if (store.listeners.size === 1) start()
            return () => {
              store.listeners.delete(listener)
              if (store.listeners.size === 0) stop()
            }
          }
          // 权限只读刷新：POST diagnostics/refresh-scope（body {}）。单飞 + 5s 最小间隔
          // （服务端同样限频）；局部 response 只用于错误分类，权威完整 diagnostics 随后
          // 从 GET /status 读取，不把局部 permissions 当完整诊断、也不每轮自动刷新 scope。
          const SCOPE_REFRESH_MIN_MS = 5000
          const SCOPE_ERROR_MAP = {
            adapter_not_running: 'adapter',
            in_flight: 'in_flight',
            rate_limited: 'rate_limited',
            'scope read failed': 'read_failed',
            'malformed scope list': 'malformed',
            'scope list truncated': 'truncated',
            stale_generation: 'stale_generation',
          }
          const refreshScope = async () => {
            const before = store.getSnapshot().scope || { inFlight: false, state: 'idle', error: '', at: 0, coolingDown: false, generation: null }
            if (before.inFlight) return false // 单飞：覆盖整个闭环
            if (before.coolingDown) return false // 本地 5s 冷却（本地定时器到期解除）
            const myEpoch = scopeEpoch
            const epoch0 = observedInstanceEpoch // 刷新发起时的实例身份
            const unknown0 = identityUnknown // 发起时后端是否已明确“身份未知”
            const gen0 = diagnosticsGenerationOf(store.getSnapshot().data)
            const now = Date.now()
            publish({ scope: Object.assign({}, before, { inFlight: true, state: 'in_flight', error: '', at: now, coolingDown: true }) })
            if (scopeCooldownTimer) scopeCooldownTimer()
            scopeCooldownTimer = ctx.timeout(() => {
              scopeCooldownTimer = null
              if (myEpoch !== scopeEpoch) return
              const snapshot = store.getSnapshot().scope
              if (snapshot) publish({ scope: Object.assign({}, snapshot, { coolingDown: false }) })
            }, SCOPE_REFRESH_MIN_MS)
            let nextState = 'ok'
            let nextError = ''
            let nextGeneration = null
            let nextEpoch = null
            // 无论 POST 成功/失败/畸形/异常，只要任务仍有效都安全重读权威 status
            //（契约：成败都重读；单飞覆盖结算；dispose 例外不追加 GET）。
            const reread = () => load({ guard: () => myEpoch === scopeEpoch })
            try {
              const result = await rpc('POST', '/__dsh-messaging/diagnostics/refresh-scope', {})
              if (myEpoch !== scopeEpoch) return false
              if (!(result && result.ok === true && result.refreshed === true)) {
                nextState = 'error'
                const raw = result && typeof result.error === 'string' ? result.error : ''
                nextError = SCOPE_ERROR_MAP[raw] || 'api_error' // 含服务端 stale_generation 固定键
                await reread()
              } else {
                const respGen = Number.isSafeInteger(result.generation) && result.generation >= 0 ? result.generation : null
                const respEpoch = Number.isSafeInteger(result.instanceEpoch) && result.instanceEpoch >= 0 ? result.instanceEpoch : null
                if (unknown0) {
                  // 发起时身份即未知（instanceEpoch:null）：不以任何 null==null 虚构成功。
                  nextState = 'error'
                  nextError = 'identity_unknown'
                  await reread()
                } else if (respGen === null) {
                  nextState = 'error'
                  nextError = 'api_error'
                  await reread()
                } else if (epoch0 !== null && respEpoch === null) {
                  // 当前后端有实例身份而 refresh 回包缺失：契约不完整，不判成功（兼容但不虚构绿）。
                  nextState = 'error'
                  nextError = 'api_error'
                  await reread()
                } else if (epoch0 !== null && respEpoch !== epoch0) {
                  // POST 被不同实例处理：不判成功；重读让 status 侧完成实例切换。
                  nextState = 'error'
                  nextError = 'stale_generation'
                  await reread()
                } else {
                  const statusResult = await reread()
                  if (statusResult === true) {
                    // 权威身份三方同实例检查（发起/POST/最终采用 status 必须全等且合法），
                    // 连同 generation 三方比较；旧实例的查询不能证明新实例也查询完成。
                    const freshEpoch = readInstanceEpoch(store.getSnapshot().data)
                    const genAfter = diagnosticsGenerationOf(store.getSnapshot().data)
                    if (identityUnknown || freshEpoch === null) {
                      nextState = 'error'
                      nextError = 'identity_unknown' // 后端明确未知身份：不虚构跨实例确认成功
                    } else if (epoch0 !== null && (freshEpoch === undefined || freshEpoch !== epoch0 || freshEpoch !== respEpoch)) {
                      nextState = 'error'
                      nextError = freshEpoch === undefined ? 'identity_unknown' : 'stale_generation'
                    } else if (gen0 === null || genAfter === null) {
                      nextState = 'error'
                      nextError = 'api_error' // 旧版缺代际 → 未确认，不自行补成功
                    } else if (gen0 !== respGen || genAfter !== respGen) {
                      nextState = 'error'
                      nextError = 'stale_generation' // 跨代：旧代响应不得显示为新代成功
                    } else {
                      nextState = 'ok'
                      nextGeneration = genAfter
                      nextEpoch = freshEpoch === undefined ? null : freshEpoch // 完成标记携 epoch
                    }
                  } else if (statusResult === 'expired') {
                    // 读取被更新请求取代/代际回退 → 显示代际变化，不假绿。
                    nextState = 'error'
                    nextError = 'stale_generation'
                  } else {
                    nextState = 'error'
                    nextError = 'status_failed'
                  }
                }
              }
            } catch (refreshError) {
              if (myEpoch !== scopeEpoch) return false
              nextState = 'error'
              nextError = 'unreachable'
              await reread() // POST 异常也安全重读（原始异常只供分类，不进 UI）
            }
            if (myEpoch !== scopeEpoch) return false
            const latest = store.getSnapshot().scope || before
            publish({
              scope: Object.assign({}, latest, {
                inFlight: false,
                state: nextState,
                error: nextError,
                at: now,
                generation: nextGeneration,
                epoch: nextEpoch, // 完成标记携最终采用 status 的实例身份（错误时为 null）
              }),
            })
            return true
          }
          // dispose 提取为具名函数：controller 清理 + 注入面共享同一实现。
          const dispose = () => {
            stop()
            scopeEpoch += 1 // 使挂起请求的迟到结果失效
            if (scopeCooldownTimer) {
              scopeCooldownTimer()
              scopeCooldownTimer = null
            }
            store.listeners.clear()
          }
          let scopeCooldownTimer = null
          let scopeEpoch = 0 // 代际失效：dispose 后挂起的 POST/GET 迟到结果不发布、不 GET
          // 注入面只建一次：hook 的身份要稳定，否则每次渲染都重新绑定。
          const statusFace = { hooks: { status: { getSnapshot: store.getSnapshot, set: store.set, subscribe } }, reload, refreshScope, dispose }
          return {
            store,
            reload,
            subscribe,
            dispose,
            // 注入面只建一次：hook 的身份要稳定，否则每次渲染都重新绑定。
            inject: () => statusFace,
          }
        }

        // 配置页：包装 settings 镜像 —— 密钥标记、revision、保存结果都从这里发。
        // revision 取自镜像快照（同一份 describe），写入冲突由它判定。
        function createConfigPageController() {
          const store = createSnapshotStore({
            secrets: {}, revision: undefined, value: undefined, writable: undefined,
            saving: false, failed: '', message: '',
          })
          let mirrorOff = null
          const read = () => {
            const mirror = settingsMirror()
            const row = mirror && typeof mirror.namespace === 'function' ? mirror.namespace(SETTINGS_NS) : null
            const secrets = {}
            const list = (row && row.secrets) || []
            for (let index = 0; index < list.length; index += 1) {
              const secret = list[index]
              if (Array.isArray(secret.path)) secrets[secret.path.join('.')] = Boolean(secret.set)
            }
            const revision = row && typeof row.revision === 'number' ? row.revision : undefined
            // P5 step0：value / writable 与 revision / secrets 取自同一份 mirror 快照；
            // 页面不再从 props.form.state 读值，form 只保留 mutate 一个入口。
            const value = row && row.value && typeof row.value === 'object' ? row.value : undefined
            let writable
            if (row && typeof row.writable === 'boolean') writable = row.writable
            if (writable === undefined && mirror && typeof mirror.getSnapshot === 'function') {
              try {
                const snapshot = mirror.getSnapshot()
                const view = snapshot && snapshot.view
                if (view && typeof view.writable === 'boolean') writable = view.writable
              } catch (snapshotError) {
                // 快照不可读时留给 form.state 兼容回退。
              }
            }
            const current = store.getSnapshot()
            if (current.revision === revision
              && sameSecrets(current.secrets, secrets)
              && Object.is(current.value, value)
              && current.writable === writable) return
            store.set(Object.assign({}, current, { secrets, revision, value, writable }))
          }
          const currentRevision = () => store.getSnapshot().revision
          const reload = () => {
            const mirror = settingsMirror()
            if (mirror && typeof mirror.load === 'function') {
              try { mirror.load() } catch (loadError) { /* 回读失败由下次订阅补上 */ }
            }
            read()
          }
          // 保存仍走 owner 给的 form.mutate(ops, revision)；saved/conflict/generic 的
          // 判定只在这里做一次。冲突 = 期望 revision 与镜像里的不一致。
          const save = async (form, ops, revision) => {
            if (!form || typeof form.mutate !== 'function' || !Array.isArray(ops) || !ops.length) return 'noop'
            store.set(Object.assign({}, store.getSnapshot(), { saving: true, failed: '', message: '' }))
            const sent = revision
            const finish = (failed) => {
              read()
              const latest = store.getSnapshot()
              store.set(Object.assign({}, latest, { saving: false, failed, message: failed ? '' : 'saved' }))
              return failed || 'saved'
            }
            try {
              const landed = await form.mutate(ops, sent)
              if (landed === false) {
                read()
                const fresh = currentRevision()
                return finish(typeof sent === 'number' && fresh !== sent ? 'conflict' : 'generic')
              }
              return finish('')
            } catch (saveError) {
              const code = saveError && (saveError.code || saveError.name)
              const conflict = code === 'SettingsConflictError' || code === 'SETTINGS_CONFLICT' || (saveError && saveError.status === 409)
              return finish(conflict ? 'conflict' : 'generic')
            }
          }
          // 注入面只建一次：hook 的身份要稳定，否则每次渲染都重新绑定。
          // 订阅即开始读镜像，最后一个订阅者离开就退订。
          function subscribe(listener) {
            store.listeners.add(listener)
            if (store.listeners.size === 1) {
              const mirror = settingsMirror()
              if (mirror && typeof mirror.subscribe === 'function') mirrorOff = mirror.subscribe(() => read())
              read()
            }
            return () => {
              store.listeners.delete(listener)
              if (store.listeners.size === 0 && mirrorOff) {
                mirrorOff()
                mirrorOff = null
              }
            }
          }
          // 注入面只建一次：hook 的身份要稳定，否则每次渲染都重新绑定。
          const configFace = { hooks: { configPage: { getSnapshot: store.getSnapshot, set: store.set, subscribe } }, save, reload }
          return {
            store,
            read,
            reload,
            save,
            subscribe,
            dispose() {
              if (mirrorOff) mirrorOff()
              mirrorOff = null
              store.listeners.clear()
            },
            inject: () => configFace,
          }
        }

        // 扫码登录状态机：状态、轮询、超时都在这里，组件只拿快照与动作。
        function createWechatLoginController(configPage) {
          const store = createSnapshotStore({
            status: 'idle', sessionKey: '', qrUrl: '', verifyCode: '',
            busy: false, error: '', errorCode: '', alreadyConnected: false,
          })
          let pollTimer = null
          let inFlight = false
          const publish = (patch) => store.set(Object.assign({}, store.getSnapshot(), patch))
          const watching = () => {
            const status = store.getSnapshot().status
            return status === 'wait' || status === 'scaned'
          }
          const cancelTimer = () => {
            if (!pollTimer) return
            pollTimer()
            pollTimer = null
          }
          const schedule = (delay) => {
            cancelTimer()
            if (!store.listeners.size || !watching()) return
            pollTimer = ctx.timeout(() => { pollTimer = null; void poll() }, delay)
          }
          const poll = async () => {
            const snapshot = store.getSnapshot()
            if (inFlight) return
            if (!snapshot.sessionKey || !snapshot.qrUrl || !watching()) return
            inFlight = true
            try {
              const result = await rpc('POST', '/__dsh-messaging/ilink/login/status', { sessionKey: snapshot.sessionKey, verifyCode: snapshot.verifyCode })
              if (!watching()) return
              if (!result) {
                publish({ status: 'failed', error: 'no response' })
                cancelTimer()
                return
              }
              if (result.status === 'confirmed') {
                publish({ status: 'confirmed', qrUrl: '', alreadyConnected: Boolean(result.alreadyConnected) })
                cancelTimer()
                if (configPage) configPage.reload()
                return
              }
              if (result.status === 'failed') {
                publish({ status: 'failed', error: result.error || 'login failed', errorCode: result.code || '' })
                cancelTimer()
                return
              }
              if (result.status === 'expired') {
                // 宿主自动换新码：回到 wait 继续轮询；没有新码才是终局 expired。
                if (result.qrcodeUrl) {
                  publish({ status: 'wait', qrUrl: result.qrcodeUrl })
                  schedule(LOGIN_POLL_MS)
                  return
                }
                publish({ status: 'expired' })
                cancelTimer()
                return
              }
              publish({ status: result.status })
              if (result.status === 'wait' || result.status === 'scaned') schedule(LOGIN_POLL_MS)
            } catch (pollError) {
              if (watching()) publish({ status: 'failed', error: pollError && pollError.message ? pollError.message : String(pollError) })
              cancelTimer()
            } finally {
              inFlight = false
            }
          }
          // 与旧 effect 同时序：状态/码变化后由组件的 effect 唤醒，立刻拉一次
          // 并顶掉待发的定时器（同一状态下仍由定时器驱动下一轮）。
          const wake = () => {
            if (!store.listeners.size || !watching()) return
            if (inFlight) return
            cancelTimer()
            void poll()
          }
          const generate = async () => {
            cancelTimer()
            publish({ busy: true, error: '', errorCode: '', verifyCode: '', alreadyConnected: false, status: 'wait' })
            try {
              const result = await rpc('POST', '/__dsh-messaging/ilink/login/start')
              if (!result || !result.ok) throw new Error((result && result.error) || 'login start failed')
              publish({ busy: false, sessionKey: result.sessionKey, qrUrl: result.qrcodeUrl })
            } catch (loginError) {
              publish({ busy: false, status: 'failed', error: loginError && loginError.message ? loginError.message : String(loginError) })
            }
          }
          const cancel = () => {
            cancelTimer()
            const snapshot = store.getSnapshot()
            if (snapshot.sessionKey) rpc('POST', '/__dsh-messaging/ilink/login/cancel', { sessionKey: snapshot.sessionKey }).catch(() => {})
            store.set(Object.assign({}, store.getSnapshot(), {
              status: 'idle', sessionKey: '', qrUrl: '', verifyCode: '',
              alreadyConnected: false, error: '', errorCode: '', busy: false,
            }))
          }
          const setVerifyCode = (text) => publish({ verifyCode: text })
          const submitVerify = async () => {
            const snapshot = store.getSnapshot()
            if (!snapshot.sessionKey) return
            publish({ busy: true, error: '' })
            try {
              await rpc('POST', '/__dsh-messaging/ilink/login/verify', { sessionKey: snapshot.sessionKey, verifyCode: snapshot.verifyCode })
              publish({ busy: false, verifyCode: '', status: 'wait' })
              wake()
            } catch (verifyError) {
              publish({ busy: false, error: verifyError && verifyError.message ? verifyError.message : String(verifyError) })
            }
          }
          // 最后一个订阅者离开时取消待处理的轮询定时器（卸载后不残留 timer）。
          function subscribe(listener) {
            store.listeners.add(listener)
            return () => {
              store.listeners.delete(listener)
              if (store.listeners.size === 0) cancelTimer()
            }
          }
          // 注入面只建一次：hook 的身份要稳定，否则每次渲染都重新绑定。
          const loginFace = {
            hooks: { wechatLogin: { getSnapshot: store.getSnapshot, set: store.set, subscribe } },
            wake, generate, cancel, submitVerify, setVerifyCode,
          }
          return {
            store,
            wake,
            generate,
            cancel,
            submitVerify,
            setVerifyCode,
            subscribe,
            dispose() {
              cancelTimer()
              store.listeners.clear()
            },
            inject: () => loginFace,
          }
        }

        const statusController = createStatusController()
        const configPageController = createConfigPageController()
        const loginController = createWechatLoginController(configPageController)
        ctx.effect(() => () => {
          statusController.dispose()
          configPageController.dispose()
          loginController.dispose()
        })

        // 插件页注入面：hooks（组件用 props.useXxx(selector) 订阅）+ 动作。
        let pageFace = null
        function pageInject() {
          if (pageFace) return pageFace
          const configFace = configPageController.inject()
          const loginFace = loginController.inject()
          pageFace = {
            hooks: Object.assign({}, configFace.hooks, loginFace.hooks),
            save: configFace.save,
            reload: configFace.reload,
            wake: loginFace.wake,
            generate: loginFace.generate,
            cancel: loginFace.cancel,
            submitVerify: loginFace.submitVerify,
            setVerifyCode: loginFace.setVerifyCode,
          }
          return pageFace
        }

        function MessagingSettingsPage(props) {
          const t = props.t || fallbackT
          const useConfigPage = props.useConfigPage || absentHook
          const page = useConfigPage((snapshot) => snapshot) || {}
          const form = props.form
          const formState = form && form.state ? form.state : null
          // 草稿是纯视图状态：只在组件里，离开页面（卸载）即丢弃。
          const [drafts, setDrafts] = React.useState({})
          const discardRef = { current: null }
          const discard = () => { setDrafts({}) }
          discardRef.current = discard
          React.useEffect(() => () => { discardRef.current() }, [])
          // 冲突：镜像已被回读到最新值，丢掉草稿，让用户在新值上重改。
          React.useEffect(() => {
            if (page.failed === 'conflict') setDrafts({})
          }, [page.failed])

          const secrets = page.secrets || {}
          const revision = page.revision
          // P5 step0：值与可写性都来自 controller 的 mirror 快照（与 revision/secrets 同源）；
          // mirror 缺席（服务降级）时才退回 form.state——form 只剩 mutate 一个入口。
          const value = (page.value && typeof page.value === 'object')
            ? page.value
            : ((formState && formState.value) || {})
          const writable = typeof page.writable === 'boolean'
            ? page.writable
            : (!formState || formState.writable !== false)
          const available = Boolean(formState) && formState.status !== 'unavailable'
          const saving = Boolean(page.saving)
          const draftKeys = Object.keys(drafts)
          const dirty = draftKeys.length > 0
          const invalid = draftKeys.some((key) => drafts[key].kind === 'invalid')
          // 只读部署：所有输入、清除与扫码入口一起禁掉。
          const disabled = !writable

          // 显示值：草稿优先；clear/unset 的草稿显示为空。
          const valueAt = (dotted) => {
            const staged = drafts[dotted]
            if (staged) return staged.kind === 'set' ? staged.value : ''
            return readPathValue(value, dotted)
          }
          const isStaged = (dotted) => Object.prototype.hasOwnProperty.call(drafts, dotted)
          const isPendingClear = (dotted) => isStaged(dotted) && drafts[dotted].kind === 'clear'

          const stage = (dotted, entry) => {
            setDrafts((previous) => {
              const next = Object.assign({}, previous)
              if (entry === null || entry === undefined) delete next[dotted]
              else next[dotted] = entry
              return next
            })
          }

          // ops 生成规则：set = 新值；unset = 清空/放弃覆盖；密钥留空不产生操作。
          const editField = (dotted, raw, type) => {
            if (disabled) return
            if (type === 'boolean' || type === 'boolean-select') return stage(dotted, { kind: 'set', value: Boolean(raw) })
            if (type === 'select') return stage(dotted, { kind: 'set', value: raw })
            if (type === 'number') {
              if (raw === '') return stage(dotted, { kind: 'unset', value: null })
              const parsed = Number(raw)
              if (!Number.isFinite(parsed)) return stage(dotted, { kind: 'invalid', text: raw })
              return stage(dotted, { kind: 'set', value: parsed })
            }
            if (type === 'password') {
              // 密钥留空 = 保持不变（不产生任何操作）。
              return stage(dotted, raw === '' ? null : { kind: 'set', value: raw })
            }
            // 普通文本清空 = 放弃覆盖，回到组合层默认值（unset）。
            return stage(dotted, raw === '' ? { kind: 'unset', value: null } : { kind: 'set', value: raw })
          }

          const toggleClear = (dotted) => {
            if (disabled) return
            const staged = isStaged(dotted) ? drafts[dotted] : null
            stage(dotted, staged && staged.kind === 'clear' ? null : { kind: 'clear', value: '' })
          }

          const buildOps = () => {
            const ops = []
            for (let index = 0; index < draftKeys.length; index += 1) {
              const dotted = draftKeys[index]
              const staged = drafts[dotted]
              if (staged.kind === 'invalid') continue
              const fieldPath = dotted.split('.')
              ops.push(staged.kind === 'set'
                ? { op: 'set', path: fieldPath, value: staged.value }
                : { op: 'unset', path: fieldPath })
            }
            return ops
          }

          const save = async () => {
            if (!form || typeof props.save !== 'function') return
            if (invalid || !writable || saving) return
            const ops = buildOps()
            if (!ops.length) return
            // 保存与结果状态都由 ConfigPageController 负责（仍走 props.form.mutate）。
            const outcome = await props.save(form, ops, revision)
            // 成功与冲突都丢草稿（冲突时镜像已回读到新值）；失败保留供修正。
            if (outcome === 'saved' || outcome === 'conflict') setDrafts({})
          }

          const reload = () => {
            if (typeof props.reload === 'function') props.reload()
          }

          if (!available) {
            return React.createElement('p', { role: 'status' }, t('settings.unavailable'))
          }

          const renderChannel = (channel) => {
            const adapter = value.adapters && value.adapters[channel.key] ? value.adapters[channel.key] : {}
            // webhookOnly 字段只在 webhook 订阅方式下显示：长连接不需要这些入站凭据，
            // 摆出来只会让用户以为必须填。（非飞书渠道没有 mode，此过滤对其无影响。）
            const fields = (CHANNEL_FIELDS[channel.key] || []).filter(
              (field) => !field.webhookOnly || adapter.mode === 'webhook',
            )
            return React.createElement('details', { key: channel.key, style: styles.details },
              React.createElement('summary', { style: styles.summary },
                React.createElement('span', null, t(channel.label)),
                React.createElement('span', { style: styles.badge }, valueAt('adapters.' + channel.key + '.enabled') ? t('settings.enabled') : t('settings.disabled')),
              ),
              React.createElement('div', { style: styles.fieldGrid },
                React.createElement(Field, {
                  key: 'enabled',
                  label: t('settings.enableField'),
                  type: 'boolean',
                  value: Boolean(valueAt('adapters.' + channel.key + '.enabled')),
                  disabled: disabled,
                  onChange: (next) => editField('adapters.' + channel.key + '.enabled', next, 'boolean'),
                }),
                fields.map((field) => {
                  const fieldPath = 'adapters.' + channel.key + '.' + field.key
                  const isSecret = field.type === 'password'
                  const configured = isSecret && Boolean(secrets[fieldPath])
                  const pendingClear = isSecret && isPendingClear(fieldPath)
                  const text = displayValue(valueAt(fieldPath))
                  return React.createElement(Field, {
                    key: field.key,
                    label: t(field.label),
                    type: field.type,
                    options: field.options,
                    yesLabel: t('settings.yes'),
                    noLabel: t('settings.no'),
                    disabled: disabled,
                    value: valueAt(fieldPath),
                    placeholder: pendingClear
                      ? t('settings.secretClearPending')
                      : (configured && text === '' ? t('settings.secretSet') : ''),
                    clearLabel: pendingClear ? t('settings.secretUndoClear') : t('settings.secretClear'),
                    onClear: configured ? () => toggleClear(fieldPath) : null,
                    onChange: (next) => editField(fieldPath, next, field.type),
                  })
                }),
              ),
              channel.key === 'wechat'
                ? React.createElement(WeChatLoginPanel, {
                  t,
                  useWechatLogin: props.useWechatLogin,
                  wake: props.wake,
                  generate: props.generate,
                  cancel: props.cancel,
                  submitVerify: props.submitVerify,
                  setVerifyCode: props.setVerifyCode,
                  disabled: disabled,
                })
                : null,
              channel.key === 'lark'
                ? React.createElement(LarkSetupPanel, { t, mode: valueAt('adapters.lark.mode') })
                : null,
            )
          }

          const hasShell = Boolean(OfficialSettingsForm)
          const failedLine = page.failed === 'conflict'
            ? t('settings.conflict')
            : (page.failed === 'generic' ? t('settings.saveFailed') : '')
          const body = React.createElement('div', { style: styles.form },
            React.createElement('div', { style: styles.formHeader },
              React.createElement('h3', { style: styles.formTitle }, t('settings.title')),
              React.createElement('div', { style: styles.formActions },
                React.createElement('button', { style: styles.button, onClick: reload }, t('settings.reload')),
                // 官方外壳自带保存按钮（带 dirty/invalid 门控）；没有外壳才自绘。
                hasShell ? null : React.createElement('button', {
                  style: styles.primary,
                  disabled: saving || !dirty || invalid || !writable,
                  onClick: save,
                }, saving ? t('settings.saving') : t('settings.save')),
              ),
            ),
            page.message === 'saved' ? React.createElement('div', { style: styles.stateRunning }, t('settings.saved')) : null,
            (!hasShell && failedLine) ? React.createElement('div', { style: styles.stateError }, failedLine) : null,
            CHANNELS.map(renderChannel),
            React.createElement('div', { style: styles.notice }, t('settings.notice')),
          )

          if (!hasShell) return body
          return React.createElement(OfficialSettingsForm, {
            state: { available: true, writable, dirty, invalid, saving, failed: Boolean(page.failed) },
            labels: {
              unavailable: t('settings.unavailable'),
              readOnly: t('settings.readOnly'),
              saveFailed: failedLine || t('settings.saveFailed'),
              saving: t('settings.saving'),
              save: t('settings.save'),
            },
            onSave: save,
            onDiscard: discard,
            children: body,
          })
        }

        // 插件页入口：summary 是一行描述，page 是完整配置页（数据从注入面来）。
        function PluginConfigSection(props) {
          const t = props.t || fallbackT
          if (props.view === 'summary') {
            return React.createElement('span', { style: styles.muted }, t('plugin.summary'))
          }
          return React.createElement(MessagingSettingsPage, props)
        }

        function MessagingPanel(props) {
          const t = props.t || fallbackT
          const useStatus = props.useStatus || absentHook
          const status = useStatus((snapshot) => snapshot) || { data: null, error: '', busy: false }
          const data = status.data
          const error = status.error
          const busy = Boolean(status.busy)
          const scopeRefresh = status.scope || {}
          // 当前权威 status 的实例身份：undefined=旧后端无字段 / null=明确未知 / 数字=已知。
          const statusEpoch = data && Object.prototype.hasOwnProperty.call(data, 'instanceEpoch')
            ? (Number.isSafeInteger(data.instanceEpoch) && data.instanceEpoch >= 0 ? data.instanceEpoch : null)
            : undefined

          const stateClass = (stateName) => {
            if (stateName === 'running') return styles.stateRunning
            if (stateName === 'error') return styles.stateError
            return styles.stateDisabled
          }

          return React.createElement('div', { style: styles.root },
            React.createElement('div', { style: styles.header },
              React.createElement('h3', { style: styles.title }, t('panel.title')),
              React.createElement('button', { style: styles.button, disabled: busy, onClick: props.reload }, busy ? t('panel.reloading') : t('panel.reload')),
            ),
            // status 读取/重载失败都用固定本地译名，绝不渲染原始异常；其余业务错误域保持原样。
            error
              ? React.createElement('div', { style: styles.muted },
                error === 'status_failed'
                  ? t('diag.statusFailed')
                  : (error === 'reload_failed' ? t('diag.reloadFailed') : t('settings.error', { msg: error })))
              : null,
            data ? React.createElement('div', { style: styles.grid },
              (data.channels || []).map((channel) =>
                React.createElement('div', { key: channel.key, style: styles.card },
                  React.createElement('div', { style: styles.cardHeader },
                    React.createElement('span', { style: styles.name }, channel.label || channel.key),
                    React.createElement('span', { style: stateClass(channel.state) }, channel.state),
                  ),
                  React.createElement('div', { style: styles.muted }, t('panel.inOut', { in: channel.inboundCount || 0, out: channel.outboundCount || 0 })),
                  channel.lastError ? React.createElement('div', { style: styles.muted }, t('panel.lastError', { msg: channel.lastError })) : null,
                  channel.key === 'lark'
                    ? React.createElement(LarkDiagnosticsPanel, { t, channel, scope: scopeRefresh, statusEpoch, onRefreshScope: props.refreshScope })
                    : null,
                ),
              ),
            ) : null,
            data ? React.createElement('div', null,
              React.createElement('div', { style: styles.section }, t('panel.sessions', { n: (data.sessions || []).length })),
              React.createElement('ul', { style: styles.list },
                (data.sessions || []).slice(0, 8).map((session) =>
                  React.createElement('li', { key: session.key, style: styles.row },
                    t('panel.sessionRow', { channel: session.channel, conversation: session.conversation, n: session.messageCount }),
                  ),
                ),
              ),
            ) : null,
            data ? React.createElement('div', null,
              React.createElement('div', { style: styles.section }, t('panel.recent')),
              React.createElement('ul', { style: styles.list },
                (data.recent || []).slice(-8).map((event, index) =>
                  React.createElement('li', { key: event.at + '-' + index, style: styles.row },
                    t('panel.eventRow', { kind: event.kind, channel: event.channel || '-', text: event.text || event.reason || '' }),
                  ),
                ),
              ),
            ) : null,
          )
        }

        slots.inject('tool.view.cordis', () => slots.register(
          { name: 'tool.view.cordis', key: 'self', locale: LOCALE_NS, inject: () => statusController.inject() },
          MessagingPanel,
        ))

        // P3/P4：配置入口在插件页。whileServed 保证 Host 不提供 dsh-messaging
        // 命名空间时页面也不出现。
        const configForms = ctx.get('configForms')
        if (configForms && typeof configForms.whileServed === 'function') {
          ctx.effect(() => configForms.whileServed([SETTINGS_NS], () => slots.inject('plugins.row.config', () => slots.register(
            { name: 'plugins.row.config', key: PLUGIN_ROW_KEY, locale: LOCALE_NS, inject: pageInject },
            PluginConfigSection,
          ))))
        }
      }

    exports.name = 'dsh-messaging'
    exports.inject = ['slots', 'locale', 'timer', 'configForms']
    exports.apply = apply
    return module.exports
  },
})
