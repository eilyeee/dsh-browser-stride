// Disposable worker observer. Record only fixed command labels and settlement.
(() => {
  const trace = [], labels = new Set(['Page.enable', 'Page.getFrameTree', 'Runtime.enable', 'Runtime.disable', 'Network.enable', 'Network.disable'])
  const record = (command, state) => { if (trace.length < 64) trace.push({ command, state }) }
  Object.defineProperty(globalThis, '__strideDiagnosticNativeTrace', { value: trace })
  for (const name of ['attach', 'detach', 'sendCommand']) {
    const original = chrome.debugger[name].bind(chrome.debugger)
    chrome.debugger[name] = (...args) => {
      const command = name === 'sendCommand' ? labels.has(args[1]) ? args[1] : 'other-command' : name
      record(command, 'started')
      let value
      try { value = original(...args) } catch (error) { record(command, 'rejected'); throw error }
      return Promise.resolve(value).then(result => { record(command, 'resolved'); return result }, error => { record(command, 'rejected'); throw error })
    }
  }
})()
