// Hold one native debugger reply in the disposable test worker.
(() => {
  const original = chrome.debugger.sendCommand.bind(chrome.debugger)
  const holdFrameRead = globalThis.__strideDiagnosticHoldFrameRead === true
  const method = holdFrameRead ? 'Page.getFrameTree' : 'Network.enable'
  let used = false, held = false, released = false, resume
  const hold = () => new Promise(resolve => {
    held = true
    resume = () => { released = true; resolve() }
  })
  chrome.debugger.sendCommand = (...args) => {
    const result = original(...args)
    if (args[1] !== method || used) return result
    used = true
    if (holdFrameRead) return Promise.allSettled([result, hold()]).then(([reply]) => {
      if (reply.status === 'rejected') throw reply.reason
      return reply.value
    })
    return Promise.resolve(result).then(async value => { await hold(); return value })
  }
  Object.defineProperty(globalThis, '__strideDiagnosticStartDelay', { value: {
    status() { return { held, released } },
    release() { resume?.() },
  } })
})()
