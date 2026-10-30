/**
 * Browser half of `@eilyeee/dsh-stride-browser-bridge`.
 *
 * When the host plugin is active, this client registers a General-settings row
 * that shows the pasteable bridge WebSocket URL for the Chrome extension.
 */
window.__ModuleLoader__.load({
  id: '@eilyeee/dsh-stride-browser-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    const BRIDGE_PATH = '/ext/bridge'
    const BRIDGE_CONFIG_PATH = '/ext/bridge-config'
    const LOCALE_NS = 'bridge-browser'
    const STYLE_ID = '@eilyeee/dsh-stride-browser-bridge/BridgeAddressRow'
    const inject = ['slots', 'locale']

    const dictionaries = {
      zh: {
        'bridgeAddress.title': '浏览器桥地址',
        'bridgeAddress.help': '扩展会自动发现本机地址。也可手动粘贴到扩展的「桥地址」设置。',
        'bridgeAddress.copy': '复制',
        'bridgeAddress.copied': '已复制',
        'bridgeAddress.loading': '正在读取…',
        'bridgeAddress.unavailable': '暂时无法读取桥地址',
        'pairing.title': '浏览器配对',
        'pairing.help': '先在扩展设置中点击「连接本机 DSH」，核对两端校验码一致后再确认。配对允许该浏览器访问当前 DSH 会话，以后自动重连。连接将替换当前浏览器连接，页面操作仍遵循扩展审批设置。',
        'pairing.empty': '暂无配对请求',
        'pairing.approve': '确认配对',
        'pairing.deny': '拒绝',
        'pairing.approved': '已确认，等待扩展领取凭据…',
        'pairing.error': '配对请求暂时不可用，请刷新 DSH；请求可能已经过期。',
      },
      en: {
        'bridgeAddress.title': 'Browser bridge address',
        'bridgeAddress.help': 'The extension discovers the local address automatically. You can also paste it into its Bridge address setting.',
        'bridgeAddress.copy': 'Copy',
        'bridgeAddress.copied': 'Copied',
        'bridgeAddress.loading': 'Loading…',
        'bridgeAddress.unavailable': 'Bridge address unavailable',
        'pairing.title': 'Browser pairing',
        'pairing.help': 'Click “Connect to local DSH” in the extension settings first. Confirm only if both codes match. Pairing grants this browser access to current DSH sessions, with automatic reconnect. Connecting replaces the current browser connection; page actions still follow extension approval settings.',
        'pairing.empty': 'No pairing requests',
        'pairing.approve': 'Confirm pairing',
        'pairing.deny': 'Deny',
        'pairing.approved': 'Confirmed; waiting for the extension…',
        'pairing.error': 'Pairing requests are unavailable. Refresh DSH; the request may have expired.',
      },
    }

    function bridgeWsUrlFromLocation(location) {
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const hostname = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname
      const host = location.port === '' ? hostname : `${hostname}:${location.port}`
      return `${wsProtocol}//${host}${BRIDGE_PATH}`
    }

    async function resolveBridgeWsUrl(location) {
      const fallback = bridgeWsUrlFromLocation(location)
      try {
        const response = await fetch(`${location.origin}${BRIDGE_CONFIG_PATH}`, {
          signal: AbortSignal.timeout(1_500),
        })
        if (!response.ok) return fallback
        const body = await response.json()
        if (typeof body?.wsUrl === 'string'
          && (body.wsUrl.startsWith('ws://') || body.wsUrl.startsWith('wss://'))) {
          return body.wsUrl
        }
      } catch {
        // Fall through to the reconstructed URL.
      }
      return fallback
    }

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) {
        return () => {}
      }
      const style = document.createElement('style')
      style.dataset.plugin = '@eilyeee/dsh-stride-browser-bridge'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = [
        '.dshBridgeAddressRow{border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;padding:16px 0}',
        '.dshBridgeAddressTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
        '.dshBridgeAddressHelp{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
        '.dshBridgeAddressBody{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dshBridgeAddressValue{flex:1;min-width:0;margin:0;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:400 12px/18px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;user-select:all;-webkit-user-select:all;overflow-x:auto;white-space:nowrap}',
        '.dshBridgeAddressCopy{flex:none;height:32px;padding:0 12px;border:none;border-radius:16px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
        '.dshBridgeAddressCopy:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshBridgeAddressCopy:disabled{cursor:default;opacity:0.6}',
      ].join('')
      document.head.append(style)
      return () => style.remove()
    }

    function BridgeAddressRow({ t }) {
      const [address, setAddress] = React.useState('')
      const [status, setStatus] = React.useState('loading')
      const [copied, setCopied] = React.useState(false)
      const [requests, setRequests] = React.useState([])
      const [pairingError, setPairingError] = React.useState(false)
      const [deciding, setDeciding] = React.useState(false)
      const pairingPath = `${window.location.origin}/api/stride-browser-pairing`

      React.useEffect(() => {
        let cancelled = false
        const refresh = async () => {
          try {
            const response = await fetch(pairingPath, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3_000) })
            if (!response.ok) throw new Error('unavailable')
            const body = await response.json()
            if (!Array.isArray(body.requests)) throw new Error('invalid response')
            if (!cancelled) { setRequests(body.requests); setPairingError(false) }
          } catch { if (!cancelled) setPairingError(true) }
        }
        void refresh()
        const timer = window.setInterval(() => { void refresh() }, 2_000)
        return () => { cancelled = true; window.clearInterval(timer) }
      }, [pairingPath])

      const decide = async (event, request, decision) => {
        event.preventDefault()
        // Page scripts and browser_* DOM clicks cannot stand in for a user.
        if (!event.isTrusted || deciding) return
        setDeciding(true)
        try {
          const response = await fetch(pairingPath, {
            method: 'POST', redirect: 'error', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: request.requestId, verificationCode: request.verificationCode, decision }),
            signal: AbortSignal.timeout(5_000),
          })
          if (!response.ok) throw new Error('unavailable')
          setRequests(current => current.filter(candidate => candidate.requestId !== request.requestId))
          setPairingError(false)
        } catch { setPairingError(true) } finally { setDeciding(false) }
      }

      React.useEffect(() => {
        let cancelled = false
        void resolveBridgeWsUrl(window.location).then((url) => {
          if (cancelled) return
          setAddress(url)
          setStatus('ready')
        }).catch(() => {
          if (cancelled) return
          setStatus('error')
        })
        return () => { cancelled = true }
      }, [])

      React.useEffect(() => {
        if (!copied) return undefined
        const timer = window.setTimeout(() => setCopied(false), 1_500)
        return () => window.clearTimeout(timer)
      }, [copied])

      const onCopy = React.useCallback(async () => {
        if (address === '') return
        try {
          await navigator.clipboard.writeText(address)
          setCopied(true)
        } catch {
          const selection = window.getSelection()
          const node = document.querySelector('.dshBridgeAddressValue')
          if (selection !== null && node instanceof HTMLElement) {
            const range = document.createRange()
            range.selectNodeContents(node)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }, [address])

      const value = status === 'loading'
        ? t('bridgeAddress.loading')
        : status === 'error'
          ? t('bridgeAddress.unavailable')
          : address

      return React.createElement(
        'div',
        { className: 'dshBridgeAddressRow' },
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, t('bridgeAddress.title')),
        React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('bridgeAddress.help')),
        React.createElement(
          'div',
          { className: 'dshBridgeAddressBody' },
          React.createElement(
            'code',
            {
              className: 'dshBridgeAddressValue',
              title: address || undefined,
            },
            value,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshBridgeAddressCopy',
              type: 'button',
              disabled: status !== 'ready' || address === '',
              onClick: () => { void onCopy() },
            },
            copied ? t('bridgeAddress.copied') : t('bridgeAddress.copy'),
          ),
        ),
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, t('pairing.title')),
        React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('pairing.help')),
        pairingError ? React.createElement('p', { role: 'alert' }, t('pairing.error')) : null,
        requests.length === 0 ? React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('pairing.empty')) : null,
        ...requests.map(request => React.createElement('div', { key: request.requestId, className: 'dshBridgeAddressBody' },
          React.createElement('code', { className: 'dshBridgeAddressValue' }, request.verificationCode),
          request.status === 'approved' ? React.createElement('span', null, t('pairing.approved')) : React.createElement(React.Fragment, null,
            React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', disabled: deciding, onClick: event => { void decide(event, request, 'approve') } }, t('pairing.approve')),
            React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', disabled: deciding, onClick: event => { void decide(event, request, 'deny') } }, t('pairing.deny')),
          ),
        )),
      )
    }

    function apply(ctx) {
      ctx.effect(() => installStyle(), 'bridge-browser: settings row styles')
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, dictionaries),
        'bridge-browser: settings dictionaries',
      )
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'bridge-browser-address',
        order: 100,
        locale: LOCALE_NS,
      }, BridgeAddressRow))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
