// Disposable worker fixture: hold one completed native enable reply, not consent.
(() => {
  const original = chrome.debugger.sendCommand.bind(chrome.debugger)
  let used = false, held = false, released = false, resume
  chrome.debugger.sendCommand = (...args) => {
    const result = original(...args)
    if (args[1] !== 'Network.enable' || used) return result
    used = true
    return Promise.resolve(result).then(value => new Promise(resolve => {
      held = true
      resume = () => { released = true; resolve(value) }
    }))
  }
  Object.defineProperty(globalThis, '__strideDiagnosticStartDelay', { value: {
    status() { return { held, released } },
    release() { resume?.() },
  } })
})()
