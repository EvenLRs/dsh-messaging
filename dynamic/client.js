const CHANNELS = [
  { key: 'onebot', label: 'OneBot v11' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'discord', label: 'Discord' },
  { key: 'slack', label: 'Slack' },
  { key: 'lark', label: 'Lark / Feishu' },
  { key: 'wecom', label: 'WeCom' },
  { key: 'wechat', label: 'Personal WeChat' },
]

const RUNTIME_FIELDS = [
  { key: 'nodePath', label: 'Node executable', type: 'text' },
  { key: 'wsModulePath', label: 'ws module path', type: 'text' },
  { key: 'companionDir', label: 'Companion directory', type: 'text' },
  { key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number' },
  { key: 'telegramLongPollTimeoutSec', label: 'Telegram long-poll timeout (s)', type: 'number' },
  { key: 'shellTimeoutMs', label: 'Shell timeout (ms)', type: 'number' },
  { key: 'stdoutMaxBytes', label: 'stdout max bytes', type: 'number' },
]

const AGENT_FIELDS = [
  { key: 'cwd', label: 'Agent cwd', type: 'text' },
  { key: 'agentPreset', label: 'Agent preset', type: 'text' },
  { key: 'provider', label: 'Provider', type: 'text' },
  { key: 'model', label: 'Model', type: 'text' },
]

const CHANNEL_FIELDS = {
  onebot: [
    { key: 'endpoint', label: 'OneBot endpoint', type: 'text' },
    { key: 'accessToken', label: 'Access token', type: 'password' },
    { key: 'webhookPath', label: 'Webhook path', type: 'text' },
    { key: 'selfId', label: 'Self id (echo suppression)', type: 'number' },
  ],
  telegram: [
    { key: 'token', label: 'Bot token', type: 'password' },
    { key: 'mode', label: 'Mode', type: 'select', options: ['polling', 'webhook'] },
    { key: 'webhookPath', label: 'Webhook path', type: 'text' },
    { key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number' },
    { key: 'longPollTimeoutSec', label: 'Long-poll timeout (s)', type: 'number' },
    { key: 'dropPendingUpdates', label: 'Drop pending updates', type: 'boolean' },
  ],
  discord: [
    { key: 'botToken', label: 'Bot token', type: 'password' },
    { key: 'intents', label: 'Gateway intents', type: 'number' },
    { key: 'wsModulePath', label: 'ws module path', type: 'text' },
  ],
  slack: [
    { key: 'botToken', label: 'Bot token', type: 'password' },
    { key: 'signingSecret', label: 'Signing secret', type: 'password' },
    { key: 'verificationToken', label: 'Verification token', type: 'password' },
    { key: 'webhookPath', label: 'Webhook path', type: 'text' },
  ],
  lark: [
    { key: 'appId', label: 'App id', type: 'text' },
    { key: 'appSecret', label: 'App secret', type: 'password' },
    { key: 'verificationToken', label: 'Verification token', type: 'password' },
    { key: 'encryptKey', label: 'Encrypt key', type: 'password' },
    { key: 'webhookPath', label: 'Webhook path', type: 'text' },
  ],
  wecom: [
    { key: 'corpId', label: 'Corp id', type: 'text' },
    { key: 'agentId', label: 'Agent id', type: 'text' },
    { key: 'secret', label: 'Secret', type: 'password' },
    { key: 'token', label: 'Callback token', type: 'password' },
    { key: 'encodingAESKey', label: 'Encoding AES key', type: 'password' },
    { key: 'webhookPath', label: 'Webhook path', type: 'text' },
  ],
  wechat: [
    { key: 'driver', label: 'Driver', type: 'select', options: ['wcf', 'gewe'] },
    { key: 'baseUrl', label: 'Bridge base URL', type: 'text' },
    { key: 'collectPath', label: 'Collect path', type: 'text' },
    { key: 'sendTextPath', label: 'Send-text path (wcf)', type: 'text' },
    { key: 'postTextPath', label: 'Post-text path (gewe)', type: 'text' },
    { key: 'appId', label: 'App id (gewe)', type: 'text' },
    { key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number' },
  ],
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

return {
  name: 'dsh-messaging-client',
  inject: ['timer'],

  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

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
          setMessage('Saved; adapters reloaded')
        } catch (saveError) {
          setError(saveError && saveError.message ? saveError.message : String(saveError))
        } finally {
          setSaving(false)
        }
      }

      if (!config) {
        return React.createElement('div', { style: styles.form },
          error ? React.createElement('div', { style: styles.muted }, 'Error: ' + error) : React.createElement('div', { style: styles.muted }, 'Loading configuration…'),
        )
      }

      const renderChannel = (channel) => {
        const adapter = config.adapters && config.adapters[channel.key] ? config.adapters[channel.key] : {}
        const fields = CHANNEL_FIELDS[channel.key] || []
        return React.createElement('details', { key: channel.key, style: styles.details },
          React.createElement('summary', { style: styles.summary },
            React.createElement('span', null, channel.label),
            React.createElement('span', { style: styles.badge }, adapter.enabled ? 'enabled' : 'disabled'),
          ),
          React.createElement('div', { style: styles.fieldGrid },
            React.createElement(Field, {
              key: 'enabled',
              label: 'Enabled',
              type: 'boolean',
              value: adapter.enabled,
              onChange: (value) => setPath(['adapters', channel.key, 'enabled'], value),
            }),
            fields.map((field) => React.createElement(Field, {
              key: field.key,
              label: field.label,
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
          React.createElement('h3', { style: styles.formTitle }, 'Message Channel Configuration'),
          React.createElement('div', { style: styles.formActions },
            React.createElement('button', { style: styles.button, onClick: load }, 'Reload'),
            React.createElement('button', { style: styles.primary, disabled: saving, onClick: save }, saving ? 'Saving…' : 'Save'),
          ),
        ),
        error ? React.createElement('div', { style: styles.stateError }, 'Error: ' + error) : null,
        message ? React.createElement('div', { style: styles.stateRunning }, message) : null,
        React.createElement('details', { style: styles.details, open: true },
          React.createElement('summary', { style: styles.summary }, 'General'),
          React.createElement('div', { style: styles.fieldGrid },
            React.createElement(Field, {
              label: 'Workspace root',
              type: 'text',
              value: config.workspaceRoot,
              onChange: (value) => setPath(['workspaceRoot'], value),
            }),
          ),
        ),
        React.createElement('details', { style: styles.details },
          React.createElement('summary', { style: styles.summary }, 'Runtime'),
          React.createElement('div', { style: styles.fieldGrid },
            RUNTIME_FIELDS.map((field) => React.createElement(Field, {
              key: field.key,
              label: field.label,
              type: field.type,
              value: config.runtime ? config.runtime[field.key] : null,
              onChange: (value) => setPath(['runtime', field.key], value),
            })),
          ),
        ),
        React.createElement('details', { style: styles.details },
          React.createElement('summary', { style: styles.summary }, 'Agent'),
          React.createElement('div', { style: styles.fieldGrid },
            AGENT_FIELDS.map((field) => React.createElement(Field, {
              key: field.key,
              label: field.label,
              type: field.type,
              value: config.agent ? config.agent[field.key] : null,
              onChange: (value) => setPath(['agent', field.key], value),
            })),
          ),
        ),
        CHANNELS.map(renderChannel),
        React.createElement('div', { style: styles.notice }, 'Configuration is stored in .dsh-messaging/config.json and applies after Save.'),
      )
    }

    function MessagingPanel() {
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
          React.createElement('h3', { style: styles.title }, 'dsh-messaging gateway'),
          React.createElement('button', { style: styles.button, disabled: busy, onClick: reload }, busy ? 'Reloading…' : 'Reload'),
        ),
        error ? React.createElement('div', { style: styles.muted }, 'Error: ' + error) : null,
        data ? React.createElement('div', { style: styles.grid },
          (data.channels || []).map((channel) =>
            React.createElement('div', { key: channel.key, style: styles.card },
              React.createElement('div', { style: styles.cardHeader },
                React.createElement('span', { style: styles.name }, channel.label || channel.key),
                React.createElement('span', { style: stateClass(channel.state) }, channel.state),
              ),
              React.createElement('div', { style: styles.muted }, 'in ' + (channel.inboundCount || 0) + ' / out ' + (channel.outboundCount || 0)),
              channel.lastError ? React.createElement('div', { style: styles.muted }, 'last error: ' + channel.lastError) : null,
            ),
          ),
        ) : null,
        data ? React.createElement('div', null,
          React.createElement('div', { style: styles.section }, 'Sessions (' + (data.sessions || []).length + ')'),
          React.createElement('ul', { style: styles.list },
            (data.sessions || []).slice(0, 8).map((session) =>
              React.createElement('li', { key: session.key, style: styles.row },
                session.channel + ' · ' + session.conversation + ' · msgs ' + session.messageCount,
              ),
            ),
          ),
        ) : null,
        data ? React.createElement('div', null,
          React.createElement('div', { style: styles.section }, 'Recent'),
          React.createElement('ul', { style: styles.list },
            (data.recent || []).slice(-8).map((event, index) =>
              React.createElement('li', { key: event.at + '-' + index, style: styles.row },
                event.kind + ' · ' + (event.channel || '-') + ' · ' + event.text,
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
        label: () => 'Messaging',
      },
      MessagingSettingsSection,
    ))
  },
}
