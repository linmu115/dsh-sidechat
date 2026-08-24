import type { AnnotationCoreClient } from 'dsh-annotation-core/client-api'

export interface AnnotationSafetyRecord {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly blocked: true
  readonly operationIds: readonly string[]
}

export interface AnnotationSafetyRecordStore {
  read(sessionId: string): Promise<AnnotationSafetyRecord | undefined>
  /** One strict read-write transaction that merges and durably commits the id. */
  addOperation(sessionId: string, operationId: string): Promise<AnnotationSafetyRecord>
  /** A second strict transaction; deletes only if the durable operation set is unchanged. */
  deleteIfOperationsMatch(sessionId: string, operationIds: readonly string[]): Promise<boolean>
}

const DB_NAME = 'dsh-sidechat-annotation-safety'
const STORE_NAME = 'guards'
const DB_VERSION = 1

function sameOperations(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validRecord(value: unknown, sessionId: string): AnnotationSafetyRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Partial<AnnotationSafetyRecord>
  if (row.schemaVersion !== 1 || row.sessionId !== sessionId || row.blocked !== true) return undefined
  if (!Array.isArray(row.operationIds) || row.operationIds.some(id => typeof id !== 'string' || id.length === 0)) return undefined
  return { schemaVersion: 1, sessionId, blocked: true, operationIds: [...row.operationIds] }
}

export class IndexedDbSafetyRecordStore implements AnnotationSafetyRecordStore {
  private database?: Promise<IDBDatabase>

  private open(): Promise<IDBDatabase> {
    if (this.database !== undefined) return this.database
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable; sidechat annotation admission is disabled'))
        return
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Unable to open annotation safety database'))
    })
    return this.database
  }

  async read(sessionId: string): Promise<AnnotationSafetyRecord | undefined> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(sessionId)
      request.onsuccess = () => resolve(validRecord(request.result, sessionId))
      request.onerror = () => reject(request.error ?? new Error('Unable to read annotation safety guard'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Annotation safety read aborted'))
    })
  }

  async addOperation(sessionId: string, operationId: string): Promise<AnnotationSafetyRecord> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
      const objectStore = transaction.objectStore(STORE_NAME)
      let committed: AnnotationSafetyRecord | undefined
      const read = objectStore.get(sessionId)
      read.onsuccess = () => {
        const current = validRecord(read.result, sessionId)
        committed = {
          schemaVersion: 1,
          sessionId,
          blocked: true,
          operationIds: [...new Set([...(current?.operationIds ?? []), operationId])],
        }
        objectStore.put(committed)
      }
      read.onerror = () => transaction.abort()
      transaction.oncomplete = () => committed === undefined
        ? reject(new Error('Annotation safety operation was not committed'))
        : resolve(committed)
      transaction.onerror = () => reject(transaction.error ?? new Error('Annotation safety write failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Annotation safety write aborted'))
    })
  }

  async deleteIfOperationsMatch(sessionId: string, operationIds: readonly string[]): Promise<boolean> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
      const objectStore = transaction.objectStore(STORE_NAME)
      let deleted = false
      const read = objectStore.get(sessionId)
      read.onsuccess = () => {
        const current = validRecord(read.result, sessionId)
        if (current !== undefined && sameOperations(current.operationIds, operationIds)) {
          objectStore.delete(sessionId)
          deleted = true
        }
      }
      read.onerror = () => transaction.abort()
      transaction.oncomplete = () => resolve(deleted)
      transaction.onerror = () => reject(transaction.error ?? new Error('Annotation safety delete failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Annotation safety delete aborted'))
    })
  }
}

type ReconciliationCore = Pick<AnnotationCoreClient, 'fenceReferenceOperation' | 'readPendingState'>
type SettlementCore = ReconciliationCore & Pick<AnnotationCoreClient, 'discardPendingOperation'>

interface ActiveOperation {
  readonly sessionId: string
  readonly operationId: string
  readonly controller: AbortController
  readonly core: SettlementCore
}

export class AnnotationSafetyGuard {
  private readonly activeByTab = new Map<string, Map<string, ActiveOperation>>()

  constructor(readonly store: AnnotationSafetyRecordStore = new IndexedDbSafetyRecordStore()) {}

  async arm(sessionId: string, operationId: string): Promise<void> {
    await this.store.addOperation(sessionId, operationId)
    const verified = await this.store.read(sessionId)
    if (verified === undefined || !verified.operationIds.includes(operationId)) {
      throw new Error('The durable annotation safety barrier could not be verified')
    }
  }

  async isBlocked(sessionId: string): Promise<boolean> {
    try { return (await this.store.read(sessionId))?.blocked === true } catch { return true }
  }

  async reconcile(sessionId: string, core: ReconciliationCore): Promise<boolean> {
    const before = await this.store.read(sessionId)
    if (before === undefined) return true
    let maxFenceRevision = 0
    for (const operationId of before.operationIds) {
      let fenced: Awaited<ReturnType<ReconciliationCore['fenceReferenceOperation']>>
      try { fenced = await core.fenceReferenceOperation(sessionId, operationId) } catch { return false }
      maxFenceRevision = Math.max(maxFenceRevision, fenced.fenceRevision)
    }
    const pending = await core.readPendingState(sessionId)
    if (pending.revision < maxFenceRevision || pending.pendingCount !== 0) return false
    const verified = await this.store.read(sessionId)
    if (verified === undefined) return true
    if (!sameOperations(verified.operationIds, before.operationIds)) return false
    return this.store.deleteIfOperationsMatch(sessionId, before.operationIds)
  }

  async runAdd<T>(
    tabId: string,
    sessionId: string,
    task: (operationId: string, signal: AbortSignal) => Promise<T>,
    core: SettlementCore,
  ): Promise<T> {
    const operationId = `operation-${crypto.randomUUID()}`
    const controller = new AbortController()
    const operation: ActiveOperation = { sessionId, operationId, controller, core }
    const byOperation = this.activeByTab.get(tabId) ?? new Map<string, ActiveOperation>()
    byOperation.set(operationId, operation)
    this.activeByTab.set(tabId, byOperation)
    try {
      await this.arm(sessionId, operationId)
      if (controller.signal.aborted) throw new DOMException('Side-chat reference was canceled', 'AbortError')
      return await task(operationId, controller.signal)
    } catch (error) {
      try { await core.discardPendingOperation(sessionId, operationId) } catch {}
      try { await this.reconcile(sessionId, core) } catch {}
      throw error
    } finally {
      byOperation.delete(operationId)
      if (byOperation.size === 0) this.activeByTab.delete(tabId)
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const operations = [...(this.activeByTab.get(tabId)?.values() ?? [])]
    this.activeByTab.delete(tabId)
    await Promise.all(operations.map(async operation => {
      operation.controller.abort()
      try { await operation.core.discardPendingOperation(operation.sessionId, operation.operationId) } catch {}
      try { await this.reconcile(operation.sessionId, operation.core) } catch {}
    }))
  }
}

export const annotationSafetyGuard = new AnnotationSafetyGuard()
