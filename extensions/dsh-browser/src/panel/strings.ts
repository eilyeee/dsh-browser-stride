import type { BridgeState } from '../background/bridge.ts'
import type { UiLocale } from '../i18n.ts'
import type { BrowserRunCopy } from './browser-runs.ts'

export interface PanelCopy {
  runs: BrowserRunCopy
  documentTitle: string
  status: Record<BridgeState, string>
  approval: {
    eyebrow: string
    readTitle: string
    actionTitle: string
    request: string
    origins: string
    unknownOrigin: string
    deny: string
    allowOnce: string
    alwaysAllowReads: string
    trustSession: string
    readFootnote: string
    actionFootnote: string
  }
  tool: {
    running: string
    complete: string
    inProgress: string
    completed: string
    done: string
    labels: Record<string, string>
    overflow: (shown: string[], total: number) => string
  }
  pageAccess: { required: string; selectExisting: string; granted: string; revoke: string; failed: string }
  controlGroup: {
    title: string
    body: string
    page: string
    choose: string
    empty: string
    selecting: string
    failed: string
  }
  question: {
    eyebrow: string
    title: string
    customAlternative: string
    customAnswer: string
    dismiss: string
    answer: string
    answering: string
    alreadyAnswered: string
    answerRejected: string
  }
  settings: {
    back: string
    eyebrow: string
    title: string
    bridgeAddress: string
    bridgeHelp: string
    bridgePlaceholder: string
    tokenLabel: string
    tokenHelp: string
    tokenPlaceholder: string
    pair: string
    pairingHelp: string
    pairingWaiting: string
    pairingSaving: string
    pairingSaved: string
    pairingCancel: string
    unpair: string
    unpairing: string
    unpairHelp: string
    unpaired: string
    unpairLocalOnly: string
    pairingOpenHost: string
    pairingError: (code: string) => string
    pageSharing: string
    pageSharingHelp: string
    sharingAuto: string
    sharingAsk: string
    sharingOff: string
    unrestrictedBrowserAccess: string
    unrestrictedBrowserAccessHelp: string
    autoControlNewTabs: string
    autoControlNewTabsHelp: string
    approvalNotifications: string
    approvalNotificationsHelp: string
    autoResumeSession: string
    autoResumeSessionHelp: string
    trustedOrigins: string
    trustedOriginsHelp: string
    trustedOriginInput: string
    add: string
    invalidOrigin: string
    noTrustedOrigins: string
    remove: string
    removeOrigin: (origin: string) => string
    save: string
    cancel: string
    snapshotHint: (maxChars: number) => string
    relaySection: string
    relayHelp: string
    relayName: string
    relayNamePlaceholder: string
    relayProtocol: string
    relayProtocolClaude: string
    relayProtocolOpenai: string
    relayProtocolCodex: string
    relayBaseUrl: string
    relayToken: string
    relayTokenPlaceholder: (configured: boolean) => string
    relayModels: string
    relayModelsHelp: string
    relayModelsPlaceholder: string
    relayAdd: string
    relayRemove: string
    relaySetDefault: string
    relaySetDefaultHelp: string
    relayFetchModels: string
    relayFetching: string
    relayFetchOk: (count: number) => string
    relayNeedBaseUrl: string
    relayOpenaiListingNote: string
    relayTest: string
    relayTesting: string
    relayTestOk: (count: number, names: string) => string
    relayTestFailed: (reason: string) => string
    relayTestManualOnly: string
    relaySavedOk: string
    relaySaveFailed: (reason: string) => string
    relayEmpty: string
    relayInvalidName: string
  }
  textSize: {
    open: string
    title: string
    smaller: string
    larger: string
    reset: string
    value: (percent: string) => string
  }
  app: {
    openSettings: string
    settings: string
    openSessions: string
    sessions: string
    newSession: string
    sessionPickerLoading: string
    sessionPickerEmpty: string
    deleteSession: string
    deleteSessionConfirm: (title: string) => string
    deleteSessionFailed: (reason: string) => string
    deletePurgeFailed: (reason: string) => string
    emptyTitle: string
    emptyDescription: string
    overviewPage: string
    overviewPrompt: string
    assistant: string
    assistantWorking: string
    organizingResults: string
    thinking: string
    connectedPlaceholder: string
    disconnectedPlaceholder: string
    composerHelp: string
    sendMessage: string
    selectModel: string
    noModelsConfigured: string
    stopTurn: string
    stoppingTurn: string
    addImages: string
    imageUnavailable: string
    removeImage: (name: string) => string
    image: string
    imageLoading: string
    imageLoadFailed: string
    openImage: string
    openNamedImage: (name: string) => string
    imagePreview: string
    closeImage: string
    imageUnsupported: (name: string) => string
    imageTooMany: (max: number) => string
    imageTooLarge: (name: string, max: string) => string
    imageMessageTooLarge: (max: string) => string
    imageDimensionTooLarge: (name: string, max: number) => string
    imagePixelsTooLarge: (name: string, max: number) => string
    imageDecodeFailed: (name: string) => string
    imageModelUnsupported: string
    imageSubagentUnsupported: string
    imageSendFailed: (reason: string) => string
    selectionChip: string
    selectionAttached: string
    selectionTruncated: string
    removeSelection: string
    scrollToBottom: string
  }
}

const EN: PanelCopy = {
  runs: {
    title: 'Browser tasks', task: suffix => `Task · ${suffix}`,
    states: { queued: 'Queued', running: 'Running', blocked: 'Blocked', paused: 'Paused', stopping: 'Stopping', stopped: 'Stopped', completed: 'Completed', failed: 'Failed' },
    pause: 'Pause task', stop: 'Stop task', refresh: 'Refresh tasks', loading: 'Reading task status…',
    retarget: 'Continue on selected page',
    start: 'Bind and start',
    waitingHelp: 'Select the intended browser page, then bind and start this task. No model runs while waiting.',
    newPageUrl: 'New page URL', startNewPage: 'Open a new page and start',
    automaticControlRequired: 'Enable “Automatically control DSH-created pages” in settings, then save and connect.',
    outcomes: { pending: '', verified: 'Result independently verified', 'needs-review': 'Needs verification; automatic actions have stopped',
      'not-completed': 'The goal was not verified as complete', 'budget-exhausted': 'Execution limit reached; automatic actions have stopped. To continue the work, stop this task and create a new one.' },
    retargetHelp: 'Check the bound page above before continuing. The executor must pick up the updated task.',
    pausedHelp: 'Further actions are paused. This task will not continue automatically.',
    disconnectedHelp: 'The browser connection was lost and the task was paused. Reconnect, check the page access and binding, then choose “Continue on selected page”.',
    targetLostHelp: 'The task’s page control or binding was lost, so the task was paused. Authorize and bind the intended page, then choose “Continue on selected page”. Authorizing alone does not resume it.',
    stoppingHelp: 'Stop requested; waiting for the executor to confirm. Earlier actions may already have taken effect.',
    reconcileHelp: 'Some results are unresolved. Check the page before continuing.',
    truncated: (shown, total) => `Showing ${shown} of ${total} tasks, with unfinished tasks first.`,
    error: code => code === 'stale-version' ? 'Task status changed. Review the refreshed status before trying again.'
      : code === 'budget-exhausted' ? 'Execution limit reached. Stop this task before creating another; pausing or changing pages does not reset its limits.'
      : code === 'start-uncertain' ? 'Startup is unconfirmed. The page was kept; check task status before doing anything else.'
      : code === 'start-cleanup-unconfirmed' ? 'Task did not start. Check whether the new page is still open.'
      : code === 'load-failed' ? 'Could not read task status. Refresh to try again.'
      : 'The control result is unconfirmed. Review the refreshed status before submitting another request.',
  },
  documentTitle: 'dsh Browser Assistant',
  status: {
    connected: 'Connected',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    stopped: 'Disconnected',
    'update-host': 'Update the DSH Bridge to connect',
    'update-extension': 'Update this extension to connect',
    incompatible: 'Incompatible Bridge; rebuild and update both components',
  },
  approval: {
    eyebrow: 'Security check',
    readTitle: 'Allow page access?',
    actionTitle: 'Allow page action?',
    request: 'Request',
    origins: 'Origins involved',
    unknownOrigin: 'Unknown origin',
    deny: 'Deny',
    allowOnce: 'Allow once',
    alwaysAllowReads: 'Always allow reads',
    trustSession: 'Trust this domain for this session',
    readFootnote: 'Esc to deny · You can disable automatic reading in Settings at any time',
    actionFootnote: 'Esc to deny · Temporary trust ends when the side panel closes · Typed content is never shown',
  },
  tool: {
    running: 'Working on page',
    complete: 'Page action',
    inProgress: 'In progress',
    completed: 'Completed',
    done: 'Done',
    labels: {
      browser_snapshot: 'Read page',
      browser_screenshot: 'View page screenshot',
      browser_click_at: 'Click screenshot point',
      browser_click: 'Click element',
      browser_type: 'Enter text',
      browser_select: 'Select an option',
      browser_press: 'Press key',
      browser_scroll: 'Scroll page',
      browser_navigate: 'Open page',
      browser_open_tab: 'Open or reuse page',
      browser_list_tabs: 'List open tabs',
      browser_follow_tab: 'Select group page',
      browser_close_tab: 'Close tab',
      browser_back: 'Go back',
      browser_forward: 'Go forward',
      browser_reload: 'Reload page',
      browser_get_text: 'Extract text',
      browser_wait: 'Wait for page',
    },
    overflow: (shown, total) => `${shown.join(' → ')} → ${total - shown.length} more`,
  },
  pageAccess: { required: 'Click the DSH Stride toolbar icon on an unpinned page to authorize it and add it to the DSH control group.', selectExisting: 'Select an already authorized page below for this conversation. You do not need to authorize it again.', granted: 'The target page is authorized. Moving other tabs into the DSH 控制 group does not authorize them.', revoke: 'Stop controlling this page', failed: 'Stopping page control was not confirmed. Reload the extension and check page access.' },
  controlGroup: {
    title: 'DSH control group',
    body: 'DSH uses authorized pages in its group. Switching your tabs does not change its target.',
    page: 'Control-group page',
    choose: 'Select a group page',
    empty: 'No group page is authorized. Click the toolbar icon on an unpinned page to add it.',
    selecting: 'Selecting group page…',
    failed: 'Page selection was not confirmed. Check the selected group page and try again.',
  },
  question: {
    eyebrow: 'Waiting for your answer',
    title: 'The assistant needs your input',
    customAlternative: 'Or type a different answer',
    customAnswer: 'Type your answer',
    dismiss: 'Dismiss',
    answer: 'Answer',
    answering: 'Answering…',
    alreadyAnswered: 'This question was already handled in another window.',
    answerRejected: 'The answer was not accepted. Review it and try again.',
  },
  settings: {
    back: 'Back to chat',
    eyebrow: 'Browser assistant',
    title: 'Settings',
    bridgeAddress: 'Bridge address',
    bridgeHelp: 'Leave blank to detect a local service automatically',
    bridgePlaceholder: 'Auto-detect 3080 / 3081 / 3090 / 14389 / 43189',
    tokenLabel: 'Pairing code',
    tokenHelp: 'Enter a one-time pairing code generated on the Host',
    tokenPlaceholder: 'Leave blank to keep the saved credential',
    pair: 'Connect to local DSH',
    pairingHelp: 'Confirm the matching verification code in DSH → Settings → General → Browser pairing. No code copying is needed. Keep this panel open.',
    pairingWaiting: 'Waiting for confirmation in DSH',
    pairingSaving: 'Saving the connection…',
    pairingSaved: 'Connection saved. The extension reconnects automatically.',
    pairingCancel: 'Cancel pairing',
    unpair: 'Unpair DSH',
    unpairing: 'Unpairing…',
    unpairHelp: 'Disconnect and remove this browser’s saved credential. Pair again to reconnect.',
    unpaired: 'This browser has been unpaired from DSH.',
    unpairLocalOnly: 'The local connection and credential were removed. DSH has not confirmed removal of its pairing record.',
    pairingOpenHost: 'Open DSH',
    pairingError: (code) => ({
      'pairing-denied': 'Pairing was denied in DSH.',
      'pairing-cancelled': 'Pairing cancelled.',
      'pairing-unavailable': 'The request expired or DSH restarted. Request pairing again.',
      'pairing-busy': 'Another request is waiting. Cancel it or wait for it to expire.',
      'protocol-upgrade-host': 'Update the DSH Bridge before pairing.',
      'protocol-upgrade-extension': 'Update and reload this extension before pairing.',
      'update-host': 'Update the DSH Bridge to a version supporting pairing requests.',
      'already-connected': 'This browser is already connected.',
      'unpair-failed': 'The connection credential could not be fully removed. Retry unpairing.',
      'connection-lost': 'Background connection lost. Request pairing again.',
    } as Record<string, string>)[code] ?? 'Pairing failed. Check the local DSH address and retry.',
    pageSharing: 'Page content sharing',
    pageSharingHelp: 'Control when the assistant can read page text and viewport images',
    sharingAuto: 'Share automatically (default)',
    sharingAsk: 'Ask every time',
    sharingOff: 'Off',
    unrestrictedBrowserAccess: 'Skip action confirmations on authorized pages',
    unrestrictedBrowserAccessHelp: 'Enabled by default. Automatically share page content and skip action confirmations on authorized tabs, including DSH-created tabs when automatic control is enabled. This cannot grant access to other tabs.',
    autoControlNewTabs: 'Automatically control pages opened by DSH',
    autoControlNewTabsHelp: 'Chrome only. Allow DSH chat to open, bind and group new pages without a toolbar click. Chrome grants broad debugger access; Stride limits it to these new tabs. Existing tabs need separate authorization. Page sharing and action confirmations still follow your settings. Turning this off stops automatic page control.',
    approvalNotifications: 'Browser approval notifications',
    approvalNotificationsHelp: 'Notify you when an approval arrives while the side panel is closed',
    autoResumeSession: "Resume this page's conversation",
    autoResumeSessionHelp: 'Reopen the conversation associated with this tab and page path; other pages start a new conversation',
    trustedOrigins: 'Always-allowed domains',
    trustedOriginsHelp: 'The approval dialog can trust a domain for the current side-panel session only. Domains added here permanently skip action confirmation when every known origin is trusted. Wildcards include the base domain and subdomains, and stay scoped to their scheme and port; `*.example.com` defaults to HTTPS.',
    trustedOriginInput: 'Domain to always trust (e.g. https://example.com or https://*.example.com)',
    add: 'Add',
    invalidOrigin: 'Enter an http:// or https:// origin, or a wildcard such as https://*.example.com.',
    noTrustedOrigins: 'No domains are currently trusted.',
    remove: 'Remove',
    removeOrigin: (origin) => `Remove ${origin}`,
    save: 'Save & Connect',
    cancel: 'Cancel',
    snapshotHint: (maxChars) => `Page snapshots are limited to ${maxChars} characters and longer content is truncated. Change snapshotMaxChars in the dsh plugin to adjust this limit.`,
    relaySection: 'Models & API relay',
    relayHelp: 'Configure an API relay. This requires the Host to enable management access; browser pairing alone does not grant it.',
    relayName: 'Profile name',
    relayNamePlaceholder: 'e.g. my-relay',
    relayProtocol: 'API format',
    relayProtocolClaude: 'Claude (Anthropic Messages)',
    relayProtocolOpenai: 'OpenAI (Chat Completions)',
    relayProtocolCodex: 'Codex (OpenAI Responses)',
    relayBaseUrl: 'Base URL',
    relayToken: 'Token',
    relayTokenPlaceholder: (configured) => configured ? 'Saved — type to replace' : 'API token for the relay',
    relayModels: 'Models',
    relayModelsHelp: 'One model per line as `id, context window` — e.g. `claude-sonnet-4-5, 200000`. The context window is optional.',
    relayModelsPlaceholder: 'model-id, 128000',
    relayFetchModels: 'Fetch models',
    relayFetching: 'Fetching models…',
    relayFetchOk: (count) => `Filled in ${count} models from the relay.`,
    relayNeedBaseUrl: 'Enter a base URL first.',
    relayOpenaiListingNote: ' (listed via the relay\'s OpenAI-compatible endpoint)',
    relayAdd: 'Add profile',
    relayRemove: 'Remove profile',
    relaySetDefault: 'Use as default model',
    relaySetDefaultHelp: 'New conversations start with the first model of this profile',
    relayTest: 'Test connection',
    relayTesting: 'Testing…',
    relayTestOk: (count, names) => `OK — ${count} model(s): ${names}`,
    relayTestFailed: (reason) => `Failed: ${reason}`,
    relayTestManualOnly: 'This protocol does not support listing models; fill them in manually.',
    relaySavedOk: 'Relay profiles saved.',
    relaySaveFailed: (reason) => `Saving failed: ${reason}`,
    relayEmpty: 'No relay profiles yet.',
    relayInvalidName: 'Enter a profile name.',
  },
  textSize: {
    open: 'Text size',
    title: 'Text size',
    smaller: 'Smaller text',
    larger: 'Larger text',
    reset: 'Reset',
    value: (percent) => `Text size ${percent}`,
  },
  app: {
    openSettings: 'Open settings',
    settings: 'Settings',
    openSessions: 'Session history',
    sessions: 'Sessions',
    newSession: 'New chat',
    sessionPickerLoading: 'Loading…',
    sessionPickerEmpty: 'No past sessions yet',
    deleteSession: 'Delete session',
    deleteSessionConfirm: (title) => `Delete “${title}”? Its conversation history will be removed permanently.`,
    deleteSessionFailed: (reason) => `Delete failed: ${reason}`,
    deletePurgeFailed: (reason) => `Removed from the list, but file cleanup failed (it may reappear after dsh restarts): ${reason}`,
    emptyTitle: 'Work with pages in the DSH group',
    emptyDescription: 'I can read the page, find information, and click, fill, or navigate for you.',
    overviewPage: 'Summarize the selected page',
    overviewPrompt: 'First give me an overview of the selected authorized group page, tell me the most important information, and wait for my next instruction.',
    assistant: 'Assistant',
    assistantWorking: 'Assistant is working',
    organizingResults: 'Organizing results',
    thinking: 'Thinking',
    connectedPlaceholder: 'Tell me what you want to do on this page…',
    disconnectedPlaceholder: 'Connect to dsh to get started',
    composerHelp: 'Enter to send · Shift + Enter for a new line',
    sendMessage: 'Send message',
    selectModel: 'Model',
    noModelsConfigured: 'No models yet — Host has no routable models.',
    stopTurn: 'Stop generating',
    stoppingTurn: 'Stopping…',
    addImages: 'Add images',
    imageUnavailable: 'This dsh host does not advertise image input',
    removeImage: (name) => `Remove ${name}`,
    image: 'Image',
    imageLoading: 'Loading…',
    imageLoadFailed: 'Could not load · Retry',
    openImage: 'Open original image',
    openNamedImage: (name) => `Open ${name}`,
    imagePreview: 'Image preview',
    closeImage: 'Close image preview',
    imageUnsupported: (name) => `${name} is not an image format supported by this dsh host.`,
    imageTooMany: (max) => `You can attach up to ${max} images to one message.`,
    imageTooLarge: (name, max) => `${name} is larger than the per-image limit of ${max}.`,
    imageMessageTooLarge: (max) => `The images in this message exceed the combined limit of ${max}.`,
    imageDimensionTooLarge: (name, max) => `${name} exceeds the maximum width or height of ${max}px.`,
    imagePixelsTooLarge: (name, max) => `${name} exceeds the ${max.toLocaleString()}-pixel limit.`,
    imageDecodeFailed: (name) => `${name} could not be decoded as an image.`,
    imageModelUnsupported: 'The current model does not support images; switch to a model that does.',
    imageSubagentUnsupported: 'Subagent sessions do not support images yet.',
    imageSendFailed: (reason) => `Sending images failed (${reason}). Your draft has been restored; try again.`,
    selectionChip: '1 selection',
    selectionAttached: 'Selected text',
    selectionTruncated: '(truncated)',
    removeSelection: 'Remove the selected text',
    scrollToBottom: 'Scroll to latest',
  },
}

const ZH: PanelCopy = {
  runs: {
    title: '浏览器任务', task: suffix => `任务 · ${suffix}`,
    states: { queued: '排队中', running: '运行中', blocked: '已阻塞', paused: '已暂停', stopping: '停止中', stopped: '已停止', completed: '已完成', failed: '失败' },
    pause: '暂停任务', stop: '停止任务', refresh: '刷新任务', loading: '正在读取任务状态…',
    retarget: '在已绑定页面继续',
    start: '绑定并开始',
    waitingHelp: '选择目标浏览器页面，再绑定并开始任务。等待期间不会启动模型。',
    newPageUrl: '新页面网址', startNewPage: '新建页面并开始',
    automaticControlRequired: '请在设置中开启“自动控制 DSH 新建页面”，再点击保存并连接。',
    outcomes: { pending: '', verified: '结果已独立核验', 'needs-review': '待核实，自动操作已停止',
      'not-completed': '未核验为完成', 'budget-exhausted': '已达到执行上限，自动操作已停止。要继续处理，请停止本任务后新建。' },
    retargetHelp: '继续前请确认上方绑定的页面，任务随后等待执行器接手。',
    pausedHelp: '任务已暂停，不会自动继续。',
    disconnectedHelp: '浏览器连接已中断，任务已暂停。重新连接后，确认页面的控制授权和绑定，再点击“在已绑定页面继续”。',
    targetLostHelp: '页面控制或绑定已失效，任务已暂停。请重新授权并绑定目标页，再点击“在已绑定页面继续”；仅重新授权不会续跑。',
    stoppingHelp: '已请求停止，等待执行器确认。此前的操作可能已产生效果。',
    reconcileHelp: '部分操作结果尚未明确，继续前需要先核对页面。',
    truncated: (shown, total) => `显示 ${total} 项任务中的 ${shown} 项，未结束任务优先。`,
    error: code => code === 'stale-version' ? '任务状态已变化，请核对刷新后的状态再操作。'
      : code === 'budget-exhausted' ? '已达到执行上限。请先停止本任务后新建；暂停或更换页面不会重置上限。'
      : code === 'start-uncertain' ? '尚未确认是否启动，已保留页面。请先核对任务状态。'
      : code === 'start-cleanup-unconfirmed' ? '任务未启动，请检查新建页面是否仍然打开。'
      : code === 'load-failed' ? '无法读取任务状态，请点击刷新重试。'
      : '控制结果尚未确认，请先核对刷新后的状态再提交其他请求。',
  },
  documentTitle: 'dsh 浏览器助手',
  status: {
    connected: '已连接',
    connecting: '连接中…',
    reconnecting: '重连中…',
    stopped: '未连接',
    'update-host': '请更新 DSH Bridge 后重试',
    'update-extension': '请更新浏览器扩展后重试',
    incompatible: 'Bridge 不兼容，请重新构建并更新两端',
  },
  approval: {
    eyebrow: '安全检查',
    readTitle: '允许读取页面？',
    actionTitle: '允许执行页面操作？',
    request: '请求',
    origins: '涉及来源',
    unknownOrigin: '未知来源',
    deny: '拒绝',
    allowOnce: '仅允许这一次',
    alwaysAllowReads: '始终允许读取',
    trustSession: '本次会话信任此域',
    readFootnote: 'Esc 拒绝 · 可随时在设置中关闭自动读取',
    actionFootnote: 'Esc 拒绝 · 关闭侧栏后临时信任失效 · 输入内容不会显示',
  },
  tool: {
    running: '正在操作页面',
    complete: '页面操作',
    inProgress: '进行中',
    completed: '已完成',
    done: '完成',
    labels: {
      browser_snapshot: '读取页面',
      browser_screenshot: '查看页面截图',
      browser_click_at: '点击截图位置',
      browser_click: '点击元素',
      browser_type: '填写内容',
      browser_select: '选择选项',
      browser_press: '按下按键',
      browser_scroll: '滚动页面',
      browser_navigate: '打开页面',
      browser_open_tab: '打开或复用页面',
      browser_list_tabs: '列出标签页',
      browser_follow_tab: '选择分组页面',
      browser_close_tab: '关闭标签页',
      browser_back: '返回上一页',
      browser_forward: '前进下一页',
      browser_reload: '刷新页面',
      browser_get_text: '提取文字',
      browser_wait: '等待页面',
    },
    overflow: (shown, total) => `${shown.join(' → ')} 等${total}个工具`,
  },
  pageAccess: { required: '请在未固定的目标页面点击工具栏上的 DSH Stride 图标，将它授权并加入「DSH 控制」分组。', selectExisting: '请在下方为当前对话选择一个已授权的分组页面，无需重复授权。', granted: '目标页面已授权。手动拖入「DSH 控制」分组不会自动授权其他页面。', revoke: '停止控制此页', failed: '停止控制的结果尚未确认，请重新加载扩展后核对页面授权。' },
  controlGroup: {
    title: 'DSH 控制分组',
    body: 'DSH 只操作分组内已授权的页面。你切换标签页时，控制目标保持不变。',
    page: '分组内的控制页面',
    choose: '选择分组内页面',
    empty: '还没有已授权的分组页面。请在未固定的页面点击工具栏图标添加。',
    selecting: '正在选择分组页面…',
    failed: '选页结果尚未确认，请核对分组内的控制页面后重试。',
  },
  question: {
    eyebrow: '等待你的回答',
    title: '助手需要你确认',
    customAlternative: '或输入其他答案',
    customAnswer: '输入你的答案',
    dismiss: '放弃',
    answer: '回答',
    answering: '回答中…',
    alreadyAnswered: '这个问题已在另一个窗口中处理。',
    answerRejected: '回答未被接受，请检查后重试。',
  },
  settings: {
    back: '返回对话',
    eyebrow: '浏览器助手',
    title: '设置',
    bridgeAddress: '桥地址',
    bridgeHelp: '留空时自动检测本机服务',
    bridgePlaceholder: '自动检测 3080 / 3081 / 3090 / 14389 / 43189',
    tokenLabel: '配对码',
    tokenHelp: '填写在 Host 上生成的一次性配对码',
    tokenPlaceholder: '留空以继续使用已保存的凭据',
    pair: '连接本机 DSH',
    pairingHelp: '在 DSH → 设置 → 通用 → 浏览器配对中核对并确认校验码，无需复制配对码。请保持此侧栏打开。',
    pairingWaiting: '等待在 DSH 中确认',
    pairingSaving: '正在保存连接…',
    pairingSaved: '连接已保存，以后会自动重连。',
    pairingCancel: '取消配对',
    unpair: '解绑 DSH',
    unpairing: '正在解绑…',
    unpairHelp: '断开连接并清除本机配对凭据；再次连接需要重新配对。',
    unpaired: '已解除此浏览器与 DSH 的配对。',
    unpairLocalOnly: '本机连接及凭据已清除，DSH 尚未确认删除配对记录。',
    pairingOpenHost: '打开 DSH',
    pairingError: (code) => ({
      'pairing-denied': 'DSH 已拒绝本次配对。',
      'pairing-cancelled': '已取消配对。',
      'pairing-unavailable': '请求已过期或 DSH 已重启，请重新发起配对。',
      'pairing-busy': '已有请求正在等待确认，请取消或等待其过期。',
      'protocol-upgrade-host': '请先更新 DSH Bridge，再发起配对。',
      'protocol-upgrade-extension': '请先更新并重新加载此扩展。',
      'update-host': '请更新 DSH Bridge，以支持配对请求。',
      'already-connected': '此浏览器已经连接。',
      'unpair-failed': '连接凭据未能完全清除，请重试解绑。',
      'connection-lost': '后台连接已断开，请重新发起配对。',
    } as Record<string, string>)[code] ?? '配对失败，请检查本机 DSH 地址后重试。',
    pageSharing: '页面内容共享',
    pageSharingHelp: '控制助手何时可以读取页面文字和截图',
    sharingAuto: '自动共享（默认）',
    sharingAsk: '每次询问',
    sharingOff: '关闭',
    unrestrictedBrowserAccess: '已授权页面内免确认操作',
    unrestrictedBrowserAccessHelp: '默认开启。自动分享已授权页面的内容，并免除操作确认，包含开启自动控制后由 DSH 新建的页面；不会授予其他页面的访问权限。',
    autoControlNewTabs: '自动控制 DSH 新建页面',
    autoControlNewTabsHelp: '仅 Chrome。允许 DSH 对话新建页面后自动绑定和分组，无需再点工具栏图标。浏览器授予较大的调试权限，Stride 将使用范围限制为这些新标签页。原有页面仍需单独授权。页面分享和操作确认遵循现有设置；关闭后停止自动页面控制。',
    approvalNotifications: '浏览器审批通知',
    approvalNotificationsHelp: '侧栏关闭时收到审批请求，通过系统通知提醒你',
    autoResumeSession: '续接当前页面会话',
    autoResumeSessionHelp: '重新打开当前标签页此页面的会话；其他页面会新建会话',
    trustedOrigins: '永久免确认域名',
    trustedOriginsHelp: '审批框可只信任本次侧栏会话。这里添加的域名仅在所有已知来源均受信任时免除操作确认。通配符包含主域及其子域，并严格区分协议和端口；`*.example.com` 默认使用 HTTPS。',
    trustedOriginInput: '要永久信任的域名（如 https://example.com 或 https://*.example.com）',
    add: '添加',
    invalidOrigin: '请输入 http://、https:// 来源或 https://*.example.com 形式的通配符。',
    noTrustedOrigins: '尚未信任任何域名。',
    remove: '移除',
    removeOrigin: (origin) => `移除 ${origin}`,
    save: '保存并连接',
    cancel: '取消',
    snapshotHint: (maxChars) => `页面快照上限为 ${maxChars} 字符，超出内容会被截断。可在 dsh 插件中调整 snapshotMaxChars。`,
    relaySection: '模型与中转服务',
    relayHelp: '配置 API 中转服务需要 Host 显式启用管理权限；浏览器配对本身不会授予该权限。',
    relayName: '档案名称',
    relayNamePlaceholder: '例如 my-relay',
    relayProtocol: '接口格式',
    relayProtocolClaude: 'Claude（Anthropic Messages）',
    relayProtocolOpenai: 'OpenAI（Chat Completions）',
    relayProtocolCodex: 'Codex（OpenAI Responses）',
    relayBaseUrl: '中转地址 Base URL',
    relayToken: '令牌 Token',
    relayTokenPlaceholder: (configured) => configured ? '已保存 — 输入可替换' : '中转站的 API 令牌',
    relayModels: '模型列表',
    relayModelsHelp: '每行一个模型，格式 `模型ID, 上下文窗口` — 如 `claude-sonnet-4-5, 200000`。上下文窗口可省略。',
    relayModelsPlaceholder: 'model-id, 128000',
    relayFetchModels: '获取模型列表',
    relayFetching: '正在获取模型列表…',
    relayFetchOk: (count) => `已从中转站填入 ${count} 个模型。`,
    relayNeedBaseUrl: '请先填写中转地址 Base URL。',
    relayOpenaiListingNote: '（经中转站的 OpenAI 兼容接口列出）',
    relayAdd: '添加档案',
    relayRemove: '删除档案',
    relaySetDefault: '设为默认模型',
    relaySetDefaultHelp: '新会话将默认使用该档案的第一个模型',
    relayTest: '测试连接',
    relayTesting: '测试中…',
    relayTestOk: (count, names) => `连接成功 — ${count} 个模型：${names}`,
    relayTestFailed: (reason) => `连接失败：${reason}`,
    relayTestManualOnly: '该协议不支持在线列出模型，请手动填写模型列表。',
    relaySavedOk: '中转配置已保存。',
    relaySaveFailed: (reason) => `保存失败：${reason}`,
    relayEmpty: '还没有中转档案。',
    relayInvalidName: '请填写档案名称。',
  },
  textSize: {
    open: '字号',
    title: '字号',
    smaller: '缩小字号',
    larger: '放大字号',
    reset: '恢复默认',
    value: (percent) => `字号 ${percent}`,
  },
  app: {
    openSettings: '打开设置',
    settings: '设置',
    openSessions: '历史会话',
    sessions: '会话',
    newSession: '新对话',
    sessionPickerLoading: '加载中…',
    sessionPickerEmpty: '暂无历史会话',
    deleteSession: '删除会话',
    deleteSessionConfirm: (title) => `确定删除「${title}」吗？对话历史将被永久移除。`,
    deleteSessionFailed: (reason) => `删除失败：${reason}`,
    deletePurgeFailed: (reason) => `已从列表移除，但文件清理失败（dsh 重启后可能再次出现）：${reason}`,
    emptyTitle: '在 DSH 分组里处理网页',
    emptyDescription: '我可以阅读页面、查找信息，也可以替你点击、填写和导航。',
    overviewPage: '先概览选定的页面',
    overviewPrompt: '请先概览已选定的分组内授权页面，告诉我最重要的信息，并等待我的下一步指令。',
    assistant: '助手',
    assistantWorking: '助手正在处理',
    organizingResults: '正在整理结果',
    thinking: '正在思考',
    connectedPlaceholder: '告诉我想在这个页面做什么…',
    disconnectedPlaceholder: '连接 dsh 后即可开始',
    composerHelp: 'Enter 发送 · Shift + Enter 换行',
    sendMessage: '发送消息',
    selectModel: '模型',
    noModelsConfigured: '暂无模型 — Host 尚未提供可用模型。',
    stopTurn: '停止生成',
    stoppingTurn: '正在停止…',
    addImages: '添加图片',
    imageUnavailable: '当前 dsh 宿主未声明图片输入能力',
    removeImage: (name) => `移除 ${name}`,
    image: '图片',
    imageLoading: '加载中…',
    imageLoadFailed: '加载失败 · 重试',
    openImage: '查看原图',
    openNamedImage: (name) => `查看 ${name}`,
    imagePreview: '图片预览',
    closeImage: '关闭图片预览',
    imageUnsupported: (name) => `${name} 不是当前 dsh 宿主支持的图片格式。`,
    imageTooMany: (max) => `每条消息最多可添加 ${max} 张图片。`,
    imageTooLarge: (name, max) => `${name} 超过单张图片 ${max} 的限制。`,
    imageMessageTooLarge: (max) => `本条消息的图片总大小超过 ${max}。`,
    imageDimensionTooLarge: (name, max) => `${name} 的宽或高超过 ${max}px。`,
    imagePixelsTooLarge: (name, max) => `${name} 超过 ${max.toLocaleString()} 像素的限制。`,
    imageDecodeFailed: (name) => `无法将 ${name} 解码为图片。`,
    imageModelUnsupported: '当前模型不支持图片，请切换到支持图片的模型。',
    imageSubagentUnsupported: '子智能体会话暂不支持图片。',
    imageSendFailed: (reason) => `图片发送失败（${reason}）。草稿已恢复，请重试。`,
    selectionChip: '1 处选中内容',
    selectionAttached: '选中的网页内容',
    selectionTruncated: '（已截断）',
    removeSelection: '移除选中内容',
    scrollToBottom: '回到最新消息',
  },
}

export const PANEL_COPY: Record<UiLocale, PanelCopy> = { en: EN, zh: ZH }
