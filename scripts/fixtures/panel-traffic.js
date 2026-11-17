// Disposable-extension observer. It records counts, never message content.
(() => {
  const counts = { creates: 0, prompts: 0, selections: 0, approvals: 0, taskControls: 0, restoredViews: 0, historyRequests: 0, historySucceeded: 0 }
  const connect = chrome.runtime.connect.bind(chrome.runtime)
  chrome.runtime.connect = (...args) => {
    const port = connect(...args)
    if (port.name !== 'dsh-panel') return port
    const post = port.postMessage.bind(port), history = new Set()
    port.onMessage.addListener(message => {
      if (message?.type === 'rpc.result' && history.delete(message.id) && message.ok === true && message.result?.result?.ok === true) counts.historySucceeded++
    })
    port.postMessage = message => {
      if (message?.type === 'rpc' && message.method === 'session.create') counts.creates++
      if (message?.type === 'rpc' && message.method === 'session.prompt') counts.prompts++
      if (message?.type === 'tab-affinity.rebind') counts.selections++
      if (message?.type === 'approval.response') counts.approvals++
      if (message?.type === 'browser-run.retarget' || message?.type === 'rpc' && message.method === 'bridge.browserRuns.control') counts.taskControls++
      if (message?.type === 'session.active' && message.restore === true) counts.restoredViews++
      if (message?.type === 'rpc' && message.method === 'session.history') { counts.historyRequests++; history.add(message.id) }
      return post(message)
    }
    return port
  }
  Object.defineProperty(window, '__stridePanelTraffic', { value: () => ({ ...counts }) })
})()
