// Disposable-extension fixture: delay one read-only status reply, never an action.
(() => {
  let armed = false, held = false, released = false, deliveries = [], actions = { start: 0, stop: 0, status: 0 }, failedReplies = 0, viewDisconnects = 0
  const connect = chrome.runtime.connect.bind(chrome.runtime)
  chrome.runtime.connect = (...args) => {
    const port = connect(...args)
    if (port.name !== 'dsh-panel') return port
    const ids = new Set(), post = port.postMessage.bind(port)
    let viewPort = false
    port.onDisconnect.addListener(() => { if (viewPort && armed) viewDisconnects++ })
    port.postMessage = message => {
      if (message?.type === 'session.active') viewPort = true
      if (message?.type === 'page-diagnostics' && Object.hasOwn(actions, message.action)) actions[message.action]++
      if (armed && !held && message?.type === 'page-diagnostics' && message.action === 'status') ids.add(message.id)
      return post(message)
    }
    const add = port.onMessage.addListener.bind(port.onMessage), remove = port.onMessage.removeListener.bind(port.onMessage), listeners = new Map()
    port.onMessage.addListener = listener => {
      const wrapped = (...values) => {
        const message = values[0]
        if (message?.type === 'page-diagnostics.result' && message.ok === false) failedReplies++
        if (!released && armed && ids.has(message?.id) && message.type === 'page-diagnostics.result' && message.ok === true && message.result?.enabled === false) {
          held = true; deliveries.push(() => listener(...values)); return
        }
        listener(...values)
      }
      listeners.set(listener, wrapped); add(wrapped)
    }
    port.onMessage.removeListener = listener => { remove(listeners.get(listener) ?? listener); listeners.delete(listener) }
    return port
  }
  Object.defineProperty(window, '__strideDiagnosticRace', { value: {
    arm() { armed = true },
    status() { return { held, released, delayedDeliveries: deliveries.length, actions: { ...actions }, failedReplies, viewDisconnects } },
    release() { released = true; armed = false; const pending = deliveries; deliveries = []; for (const deliver of pending) deliver() },
  } })
})()
