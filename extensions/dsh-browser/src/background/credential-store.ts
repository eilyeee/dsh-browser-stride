// Extension-origin IndexedDB is available to the background and extension
// pages, while content-script web storage belongs to the page's origin.
const DATABASE = 'dsh-browser-private'
const STORE = 'credentials'
const KEY = 'bridge'
const DISCONNECTED = 'disconnected'

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('Cannot open credential store')) }
    request.onblocked = () => { reject(new Error('Credential store is blocked')) }
  })
}

export async function readBridgeCredential(): Promise<string | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(KEY)
      request.onsuccess = () => { resolve(typeof request.result === 'string' ? request.result : undefined) }
      request.onerror = () => { reject(request.error ?? new Error('Cannot read credential')) }
      transaction.onabort = () => { reject(transaction.error ?? new Error('Credential read aborted')) }
    })
  } finally { db.close() }
}

/** Resolve only after the transaction commits; never fall back to public storage. */
export async function writeBridgeCredential(value: string, connection?: 'enable' | 'disable', admitted: () => boolean = () => true): Promise<void> {
  const db = await database()
  try {
    // Check after opening the database, immediately before queueing the transaction.
    // A superseded pairing must not clear a newer disconnect marker.
    if (!admitted()) throw new Error('Credential write was superseded')
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      if (value === '') store.delete(KEY)
      else store.put(value, KEY)
      if (connection === 'disable') store.put(true, DISCONNECTED)
      else if (connection === 'enable') store.delete(DISCONNECTED)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Cannot save credential')) }
      transaction.onabort = () => { reject(transaction.error ?? new Error('Credential save aborted')) }
    })
  } finally { db.close() }
}

export async function readBridgeDisconnected(): Promise<boolean> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(DISCONNECTED)
      request.onsuccess = () => resolve(request.result === true)
      request.onerror = () => reject(request.error ?? new Error('Cannot read connection state'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Connection state read aborted'))
    })
  } finally { db.close() }
}
