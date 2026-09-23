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
        { key: 'token', label: 'field.wechat.token', type: 'password' },
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
        'settings.loading': '正在加载配置…',
        'settings.error': '错误：{msg}',
        'settings.notice': '配置保存在 .dsh-messaging/config.json，保存后生效。',
        'settings.enabled': '已启用',
        'settings.disabled': '已禁用',
        'settings.enableField': '启用',
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
        'field.wechat.token': '机器人令牌',
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
        'settings.loading': 'Loading configuration…',
        'settings.error': 'Error: {msg}',
        'settings.notice': 'Configuration is stored in .dsh-messaging/config.json and applies after Save.',
        'settings.enabled': 'enabled',
        'settings.disabled': 'disabled',
        'settings.enableField': 'Enabled',
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
        'field.wechat.token': 'Bot token',
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
      },
    }

    function cloneJson(value) {
      if (value === undefined) return null
      if (Array.isArray(value)) return value.map(cloneJson)
      if (value !== null && typeof value === 'object') {
        const result = {}
        for (const key of Object.keys(value)) result[key] = cloneJson(value[key])
        return result
      }
      return value
    }

    function displayValue(value) {
      return value === undefined || value === null ? '' : String(value)
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

    function useLocaleRefresh(ctx) {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        const locale = ctx.get('locale')
        if (!locale || typeof locale.subscribe !== 'function') return
        return locale.subscribe(() => setRevision((revision) => revision + 1))
      }, [])
    }

    function apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return

        const locale = ctx.get('locale')
        let t
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(LOCALE_NS, LOCALE_DICTS))
          t = locale.bind(LOCALE_NS)
        } else {
          t = (key, params) => {
            const template = (LOCALE_DICTS.en && LOCALE_DICTS.en[key]) || key
            if (!params) return template
            return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
          }
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
        }

        function Field(props) {
          const type = props.type === 'password' ? 'password' : props.type === 'number' ? 'number' : 'text'
          if (props.type === 'boolean') {
            return React.createElement('label', { style: styles.toggle },
              React.createElement('input', {
                type: 'checkbox',
                checked: Boolean(props.value),
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
                onChange: (event) => props.onChange(event.target.value),
                style: styles.input,
              },
                (props.options || []).map((option) => React.createElement('option', { key: option, value: option }, option)),
              ),
            )
          }
          return React.createElement('label', { style: styles.field },
            React.createElement('span', { style: styles.fieldLabel }, props.label),
            React.createElement('input', {
              type,
              value: displayValue(props.value),
              onChange: (event) => {
                const raw = event.target.value
                if (props.type === 'number') {
                  const parsed = raw === '' ? null : Number(raw)
                  props.onChange(Number.isFinite(parsed) ? parsed : null)
                }
                else props.onChange(raw)
              },
              style: styles.input,
            }),
          )
        }

        function WeChatLoginPanel(props) {
          useLocaleRefresh(ctx)
          const [sessionKey, setSessionKey] = React.useState(null)
          const [qrUrl, setQrUrl] = React.useState('')
          const [status, setStatus] = React.useState('idle')
          const [verifyCode, setVerifyCode] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          const [alreadyConnected, setAlreadyConnected] = React.useState(false)

          const generate = async () => {
            setBusy(true)
            setError('')
            setVerifyCode('')
            setAlreadyConnected(false)
            setStatus('wait')
            try {
              const result = await rpc('POST', '/__dsh-messaging/ilink/login/start')
              if (!result || !result.ok) throw new Error((result && result.error) || 'login start failed')
              setSessionKey(result.sessionKey)
              setQrUrl(result.qrcodeUrl)
            } catch (loginError) {
              setStatus('failed')
              setError(loginError && loginError.message ? loginError.message : String(loginError))
            } finally {
              setBusy(false)
            }
          }

          const cancel = async () => {
            if (sessionKey) rpc('POST', '/__dsh-messaging/ilink/login/cancel', { sessionKey }).catch(() => {})
            setSessionKey(null)
            setQrUrl('')
            setStatus('idle')
            setVerifyCode('')
            setAlreadyConnected(false)
            setError('')
          }

          const submitVerify = async () => {
            if (!sessionKey) return
            setBusy(true)
            setError('')
            try {
              await rpc('POST', '/__dsh-messaging/ilink/login/verify', { sessionKey, verifyCode })
              setVerifyCode('')
              setStatus('wait')
            } catch (verifyError) {
              setError(verifyError && verifyError.message ? verifyError.message : String(verifyError))
            } finally {
              setBusy(false)
            }
          }

          React.useEffect(() => {
            if (!sessionKey || !qrUrl) return
            if (status !== 'wait' && status !== 'scaned') return
            let alive = true
            let timerDispose = null
            const tick = async () => {
              if (!alive) return
              try {
                const result = await rpc('POST', '/__dsh-messaging/ilink/login/status', { sessionKey })
                if (!alive) return
                if (!result) {
                  setStatus('failed')
                  setError('no response')
                  return
                }
                if (result.status === 'confirmed') {
                  setStatus('confirmed')
                  setAlreadyConnected(Boolean(result.alreadyConnected))
                  setQrUrl('')
                  if (props.onLoginSuccess) props.onLoginSuccess()
                  return
                }
                if (result.status === 'expired' && result.qrcodeUrl) setQrUrl(result.qrcodeUrl)
                if (result.status === 'failed') {
                  setStatus('failed')
                  setError(result.error || 'login failed')
                  return
                }
                setStatus(result.status)
                if (result.status === 'wait' || result.status === 'scaned') {
                  timerDispose = ctx.timeout(() => { if (alive) tick() }, 1000)
                }
              } catch (pollError) {
                if (!alive) return
                setStatus('failed')
                setError(pollError && pollError.message ? pollError.message : String(pollError))
              }
            }
            tick()
            return () => {
              alive = false
              if (timerDispose) timerDispose()
            }
          }, [sessionKey, qrUrl, status])

          const statusText = () => {
            if (status === 'wait') return t('wechat.login.wait')
            if (status === 'scaned') return t('wechat.login.scaned')
            if (status === 'need_verifycode') return t('wechat.login.needVerify')
            if (status === 'expired') return t('wechat.login.expired')
            if (status === 'confirmed') return alreadyConnected ? t('wechat.login.binded') : t('wechat.login.confirmed')
            if (status === 'verify_code_blocked') return t('wechat.login.blocked')
            if (status === 'failed') return error ? t('wechat.login.failed', { msg: error }) : t('wechat.login.failed', { msg: 'unknown' })
            return ''
          }

          return React.createElement('div', { style: styles.loginBox },
            React.createElement('div', { style: styles.loginHeader },
              React.createElement('span', { style: styles.loginTitle }, t('wechat.login.title')),
              qrUrl
                ? React.createElement('button', { style: styles.button, disabled: busy, onClick: cancel }, t('wechat.login.cancel'))
                : React.createElement('button', { style: styles.button, disabled: busy, onClick: generate }, t('wechat.login.generate')),
            ),
            React.createElement('div', { style: styles.loginHint }, t('wechat.login.hint')),
            qrUrl ? React.createElement('img', { src: qrUrl, style: styles.qrImage, alt: 'QR' }) : null,
            statusText() ? React.createElement('div', { style: status === 'failed' ? styles.stateError : styles.muted }, statusText()) : null,
            status === 'need_verifycode'
              ? React.createElement('div', { style: styles.verifyRow },
                  React.createElement('input', {
                    style: styles.input,
                    value: verifyCode,
                    placeholder: t('wechat.login.verifyPlaceholder'),
                    onChange: (event) => setVerifyCode(event.target.value),
                  }),
                  React.createElement('button', { style: styles.primary, disabled: busy, onClick: submitVerify }, busy ? t('wechat.login.verifying') : t('wechat.login.verifySubmit')),
                )
              : null,
          )
        }

        // 飞书订阅方式决定用户要做什么：长连接不需要任何入站凭据，只需 appId /
        // appSecret；webhook 需要用户自己把飞书控制台的 Verification Token 与
        // Encrypt Key 填进上面的字段（取值必须两端一致，插件无法代为生成）。
        function LarkSetupPanel(props) {
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

        function MessagingSettingsSection() {
          useLocaleRefresh(ctx)
          const [config, setConfig] = React.useState(null)
          const [message, setMessage] = React.useState('')
          const [error, setError] = React.useState('')
          const [saving, setSaving] = React.useState(false)

          const load = async () => {
            try {
              const response = await rpc('GET', '/__dsh-messaging/config')
              setConfig(response && response.config ? cloneJson(response.config) : null)
              setError('')
            } catch (loadError) {
              setError(loadError && loadError.message ? loadError.message : String(loadError))
            }
          }

          React.useEffect(() => {
            load()
          }, [])

          const setPath = (path, value) => {
            setConfig((previous) => {
              const next = cloneJson(previous || {})
              let cursor = next
              for (let index = 0; index < path.length - 1; index += 1) {
                const key = path[index]
                if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {}
                cursor = cursor[key]
              }
              cursor[path[path.length - 1]] = value
              return next
            })
          }

          const save = async () => {
            setSaving(true)
            setMessage('')
            setError('')
            try {
              await rpc('POST', '/__dsh-messaging/config', cloneJson(config))
              setMessage(t('settings.saved'))
            } catch (saveError) {
              setError(saveError && saveError.message ? saveError.message : String(saveError))
            } finally {
              setSaving(false)
            }
          }

          if (!config) {
            return React.createElement('div', { style: styles.form },
              error ? React.createElement('div', { style: styles.muted }, t('settings.error', { msg: error })) : React.createElement('div', { style: styles.muted }, t('settings.loading')),
            )
          }

          const renderChannel = (channel) => {
            const adapter = config.adapters && config.adapters[channel.key] ? config.adapters[channel.key] : {}
            // webhookOnly 字段只在 webhook 订阅方式下显示：长连接不需要这些入站凭据，
            // 摆出来只会让用户以为必须填。（非飞书渠道没有 mode，此过滤对其无影响。）
            const fields = (CHANNEL_FIELDS[channel.key] || []).filter(
              (field) => !field.webhookOnly || adapter.mode === 'webhook',
            )
            return React.createElement('details', { key: channel.key, style: styles.details },
              React.createElement('summary', { style: styles.summary },
                React.createElement('span', null, t(channel.label)),
                React.createElement('span', { style: styles.badge }, adapter.enabled ? t('settings.enabled') : t('settings.disabled')),
              ),
              React.createElement('div', { style: styles.fieldGrid },
                React.createElement(Field, {
                  key: 'enabled',
                  label: t('settings.enableField'),
                  type: 'boolean',
                  value: adapter.enabled,
                  onChange: (value) => setPath(['adapters', channel.key, 'enabled'], value),
                }),
                fields.map((field) => React.createElement(Field, {
                  key: field.key,
                  label: t(field.label),
                  type: field.type,
                  options: field.options,
                  value: adapter[field.key],
                  onChange: (value) => setPath(['adapters', channel.key, field.key], value),
                })),
              ),
              channel.key === 'wechat'
                ? React.createElement(WeChatLoginPanel, { onLoginSuccess: load })
                : null,
              channel.key === 'lark'
                ? React.createElement(LarkSetupPanel, { mode: adapter.mode })
                : null,
            )
          }

          return React.createElement('div', { style: styles.form },
            React.createElement('div', { style: styles.formHeader },
              React.createElement('h3', { style: styles.formTitle }, t('settings.title')),
              React.createElement('div', { style: styles.formActions },
                React.createElement('button', { style: styles.button, onClick: load }, t('settings.reload')),
                React.createElement('button', { style: styles.primary, disabled: saving, onClick: save }, saving ? t('settings.saving') : t('settings.save')),
              ),
            ),
            error ? React.createElement('div', { style: styles.stateError }, t('settings.error', { msg: error })) : null,
            message ? React.createElement('div', { style: styles.stateRunning }, message) : null,
            CHANNELS.map(renderChannel),
            React.createElement('div', { style: styles.notice }, t('settings.notice')),
          )
        }

        function MessagingPanel() {
          useLocaleRefresh(ctx)
          const [data, setData] = React.useState(null)
          const [error, setError] = React.useState('')
          const [busy, setBusy] = React.useState(false)

          const load = async () => {
            try {
              setData(await rpc('GET', '/__dsh-messaging/status'))
              setError('')
            } catch (loadError) {
              setError(loadError && loadError.message ? loadError.message : String(loadError))
            }
          }

          React.useEffect(() => {
            let alive = true
            const first = async () => {
              const value = await rpc('GET', '/__dsh-messaging/status').catch((loadError) => {
                if (alive) setError(loadError && loadError.message ? loadError.message : String(loadError))
                return null
              })
              if (alive) setData(value)
            }
            first()
            const dispose = ctx.interval(() => {
              if (alive) load()
            }, 5000)
            return () => {
              alive = false
              dispose()
            }
          }, [])

          const reload = async () => {
            setBusy(true)
            try {
              setData(await rpc('POST', '/__dsh-messaging/reload', {}))
              setError('')
            } catch (reloadError) {
              setError(reloadError && reloadError.message ? reloadError.message : String(reloadError))
            } finally {
              setBusy(false)
            }
          }

          const stateClass = (stateName) => {
            if (stateName === 'running') return styles.stateRunning
            if (stateName === 'error') return styles.stateError
            return styles.stateDisabled
          }

          return React.createElement('div', { style: styles.root },
            React.createElement('div', { style: styles.header },
              React.createElement('h3', { style: styles.title }, t('panel.title')),
              React.createElement('button', { style: styles.button, disabled: busy, onClick: reload }, busy ? t('panel.reloading') : t('panel.reload')),
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
                    t('panel.eventRow', { kind: event.kind, channel: event.channel || '-', text: event.text }),
                  ),
                ),
              ),
            ) : null,
          )
        }

        slots.inject('tool.view.cordis', () => slots.register(
          { name: 'tool.view.cordis', key: 'self' },
          () => React.createElement(MessagingPanel),
        ))

        slots.inject('settings.section', () => slots.register(
          {
            name: 'settings.section',
            id: 'messaging',
            order: 25,
            label: () => t('settings.title'),
            locale: LOCALE_NS,
          },
          MessagingSettingsSection,
        ))
      }

    exports.name = 'dsh-messaging'
    exports.inject = ['slots', 'locale', 'timer']
    exports.apply = apply
    return module.exports
  },
})
