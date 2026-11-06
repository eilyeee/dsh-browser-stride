import { BRIDGE_PROTOCOL_VERSION, type BridgeCaps } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import type { UiLocale } from '../i18n.ts'
export function installedExtensionVersion(): string {
  try { return chrome.runtime.getManifest().version } catch { return '?' }
}
export function versionStatus(caps: BridgeCaps | null, extensionVersion: string): 'unknown' | 'different' | 'matched' {
  return caps?.release === undefined ? 'unknown' : caps.release.bridgeVersion === extensionVersion ? 'matched' : 'different'
}
export function VersionStatus({ caps, locale, detailed = false }: { caps: BridgeCaps | null; locale: UiLocale; detailed?: boolean }) {
  const extensionVersion = installedExtensionVersion()
  const status = versionStatus(caps, extensionVersion)
  if (!detailed && status !== 'different') return null
  const zh = locale === 'zh'
  return <section className="version-status" role="status">
    <p>{zh ? '版本' : 'Versions'}: DSH {caps?.release?.dshVersion ?? '?'} · Host {caps?.release?.bridgeVersion ?? '?'} · {zh ? '扩展' : 'Extension'} {extensionVersion} · {zh ? '协议' : 'Wire'} {BRIDGE_PROTOCOL_VERSION}</p>
    {status === 'unknown' && <p>{zh ? '连接后显示 Host 版本；旧版 Host 可能不提供版本信息。' : 'Connect to see Host versions. Older Hosts may not report them.'}</p>}
    {status === 'different' && <p>{zh ? 'Host 与扩展版本不同。请用同一份发布包更新两端，再重启 Host、重载扩展；已有配对可以保留。协议已匹配不代表功能已经配套。' : 'Host and extension versions differ. Update both from the same release, restart the Host and reload the extension. Keep the existing pairing. A matching wire version does not establish feature parity.'}</p>}
    {caps?.release && caps.release.dshVersion !== '0.2.1-rc.5' && <p>{zh ? '此 DSH 版本尚未纳入本轮兼容性验收。' : 'This DSH version has not been included in this compatibility check.'}</p>}
    {detailed && <p>{zh ? '更新扩展后，已有页面需要重新点击工具栏图标授权。保存的资料和验收记录不会替代页面授权。' : 'After reloading the extension, authorize existing pages with its toolbar icon. Saved notes and reports do not replace page grants.'}</p>}
  </section>
}
