import { openWorkspaceDatabase } from './draft-store'

/** Shared local protection for immutable Agent operations; subject/target identity is part of every key. */
export class ReliableRecordStore<T extends { key: string }> {
  constructor(private partition: 'studentResponses' | 'agentControls' | 'pdfMaterials' | 'personalMaterials') {}
  async read(key: string): Promise<T | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.partition, 'readonly'), request = tx.objectStore(this.partition).get(key)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => {}
    })
  }
  async change<R extends T = T>(key: string, update: (saved: T | undefined) => R): Promise<R> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.partition, 'readwrite'), store = tx.objectStore(this.partition), request = store.get(key)
      let result: R, failure: unknown
      request.onsuccess = () => {
        try { result = update(request.result); if (result.key !== key) throw new Error('操作不属于当前记录。'); store.put(result) }
        catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('操作尚未在本机可靠保留。'))
      tx.onerror = () => {}
    })
  }
}
