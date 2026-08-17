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
    { key: 'webhookPath', label: 'field.onebot.webhookPath', type: 'text' },
    { key: 'selfId', label: 'field.onebot.selfId', type: 'number' },
  ],
  telegram: [
    { key: 'token', label: 'field.telegram.token', type: 'password' },
    { key: 'mode', label: 'field.telegram.mode', type: 'select', options: ['polling', 'webhook'] },
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
    { key: 'verificationToken', label: 'field.lark.verificationToken', type: 'password' },
    { key: 'encryptKey', label: 'field.lark.encryptKey', type: 'password' },
    { key: 'webhookPath', label: 'field.lark.webhookPath', type: 'text' },
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
    'field.onebot.accessToken': '访问令牌',
    'field.onebot.webhookPath': 'Webhook 路径',
    'field.onebot.selfId': '自身 ID（回显抑制）',
    'field.telegram.token': '机器人令牌',
    'field.telegram.mode': '模式',
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
    'field.lark.verificationToken': '验证令牌',
    'field.lark.encryptKey': '加密密钥',
    'field.lark.webhookPath': 'Webhook 路径',
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
    'field.onebot.accessToken': 'Access token',
    'field.onebot.webhookPath': 'Webhook path',
    'field.onebot.selfId': 'Self id (echo suppression)',
    'field.telegram.token': 'Bot token',
    'field.telegram.mode': 'Mode',
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
    'field.lark.verificationToken': 'Verification token',
    'field.lark.encryptKey': 'Encrypt key',
    'field.lark.webhookPath': 'Webhook path',
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

function useLocaleRefresh(ctx) {
  const [, setRevision] = React.useState(0)
  React.useEffect(() => {
    const locale = ctx.get('locale')
    if (!locale || typeof locale.subscribe !== 'function') return
    return locale.subscribe(() => setRevision((revision) => revision + 1))
  }, [])
}

return {
  name: 'dsh-messaging-client',
  inject: ['timer'],

  apply(ctx) {
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

    function MessagingSettingsSection() {
      useLocaleRefresh(ctx)
      const [config, setConfig] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)

      const load = async () => {
        try {
          const response = await host.call('messaging_get_config')
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
          await host.call('messaging_set_config', cloneJson(config))
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
        const fields = CHANNEL_FIELDS[channel.key] || []
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
          setData(await host.call('messaging_status'))
          setError('')
        } catch (loadError) {
          setError(loadError && loadError.message ? loadError.message : String(loadError))
        }
      }

      React.useEffect(() => {
        let alive = true
        const first = async () => {
          const value = await host.call('messaging_status').catch((loadError) => {
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
          setData(await host.call('messaging_reload'))
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
      },
      MessagingSettingsSection,
    ))
  },
}
