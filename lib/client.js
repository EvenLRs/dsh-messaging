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
        'field.lark.verificationToken': '验证令牌（Verification Token）',
        'field.lark.encryptKey': '加密密钥（Encrypt Key，可留空）',
        'field.lark.webhookPath': 'Webhook 路径',
        'lark.setup.titleLong': '飞书订阅方式：长连接（推荐）',
        'lark.setup.hintLong': '只需 App ID 与 App Secret。插件主动建立 WebSocket 长连接，只在建连时鉴权，事件为明文，因此无需公网地址、无需 Verification Token、无需 Encrypt Key。',
        'lark.setup.noteLong': '注意：飞书要求先有客户端建连，才能在事件订阅里保存「使用长连接接收事件」；因此请先保存本页配置并确保该渠道为「已启用」，再去飞书控制台选择长连接。',
        'lark.setup.title': '飞书订阅方式：Webhook（需自行填写凭据）',
        'lark.setup.hint': '请在飞书开放平台同一个应用的「事件与回调」里复制 Verification Token，填入上面的「验证令牌」。两项凭据必须与 App ID / App Secret 属于同一应用，且与本插件中所填的值完全一致。',
        'lark.setup.encryptNotice': '加密策略：飞书侧若开启加密推送，把控制台的 Encrypt Key 复制填入上面的「加密密钥」；留空则要求飞书侧以「明文模式」推送。两个凭据都填即最严：既比对令牌，也要求 payload 能被解密。',
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
        'field.lark.verificationToken': 'Verification token',
        'field.lark.encryptKey': 'Encrypt key (optional)',
        'field.lark.webhookPath': 'Webhook path',
        'lark.setup.titleLong': 'Feishu subscription: long connection (recommended)',
        'lark.setup.hintLong': 'Only the App ID and App Secret are needed. The plugin opens a WebSocket long connection and authenticates at connect time; pushed events are plaintext, so no public address, no Verification Token and no Encrypt Key are required.',
        'lark.setup.noteLong': 'Note: Feishu only offers the "receive events over a long connection" option once a client has connected, so save this configuration and enable the channel before selecting it in the Feishu console.',
        'lark.setup.title': 'Feishu subscription: Webhook (you supply the credentials)',
        'lark.setup.hint': 'Copy the Verification Token from the event subscription settings of the same app in the Feishu console into the Verification token field above. Both credentials must belong to the app that owns the App ID and App Secret, and must match the values entered here exactly.',
        'lark.setup.encryptNotice': 'Encryption: if the Feishu side pushes encrypted payloads, copy its Encrypt Key into the Encrypt key field above; leaving it empty requires the Feishu side to stay in plaintext mode. Supplying both is strictest: the token is compared and the payload must decrypt.',
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
          if (props.type === 'select') {
            return React.createElement('label', { style: styles.field },
              React.createElement('span', { style: styles.fieldLabel }, props.label),
              React.createElement('select', {
                value: displayValue(props.value),
                disabled: Boolean(props.disabled),
                onChange: (event) => props.onChange(event.target.value),
                style: styles.input,
              },
                (props.options || []).map((option) => React.createElement('option', { key: option, value: option }, option)),
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
          const store = createSnapshotStore({ data: null, error: '', busy: false })
          let timer = null
          const publish = (patch) => store.set(Object.assign({}, store.getSnapshot(), patch))
          const load = async () => {
            try {
              const data = await rpc('GET', '/__dsh-messaging/status')
              publish({ data, error: '', busy: false })
            } catch (loadError) {
              publish({ data: store.getSnapshot().data, error: loadError && loadError.message ? loadError.message : String(loadError), busy: false })
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
          const reload = async () => {
            publish({ busy: true })
            try {
              await rpc('POST', '/__dsh-messaging/reload', {})
            } catch (reloadError) {
              publish({ data: store.getSnapshot().data, error: reloadError && reloadError.message ? reloadError.message : String(reloadError), busy: false })
              return
            }
            return load()
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
          // 注入面只建一次：hook 的身份要稳定，否则每次渲染都重新绑定。
          const statusFace = { hooks: { status: { getSnapshot: store.getSnapshot, set: store.set, subscribe } }, reload }
          return {
            store,
            reload,
            subscribe,
            dispose() {
              stop()
              store.listeners.clear()
            },
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
            if (type === 'boolean') return stage(dotted, { kind: 'set', value: Boolean(raw) })
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
            error ? React.createElement('div', { style: styles.muted }, t('settings.error', { msg: error })) : null,
            data ? React.createElement('div', { style: styles.grid },
              (data.channels || []).map((channel) =>
                React.createElement('div', { key: channel.key, style: styles.card },
                  React.createElement('div', { style: styles.cardHeader },
                    React.createElement('span', { style: styles.name }, channel.label || channel.key),
                    React.createElement('span', { style: stateClass(channel.state) }, channel.state),
                  ),
                  React.createElement('div', { style: styles.muted }, t('panel.inOut', { in: channel.inboundCount || 0, out: channel.outboundCount || 0 })),
                  channel.lastError ? React.createElement('div', { style: styles.muted }, t('panel.lastError', { msg: channel.lastError })) : null,
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
