


import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  SyncQueueItem,
  SyncResult,
  BatchSyncRequest,
  BatchSyncResponse,
  SyncError,
} from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

/**
 * SyncService: orchestrates offline -> server synchronization.
 *
 * NOTE: This implementation expects the Database and TaskService to provide
 * the methods called in the code. Adjust method names to match your concrete classes.
 */
export class SyncService {
  private apiUrl: string;
  private batchSize: number;
  private maxRetries: number;

  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
    this.batchSize = Number(process.env.SYNC_BATCH_SIZE || 10);
    this.maxRetries = Number(process.env.SYNC_MAX_RETRIES || 5);
  }

  /**
   * Main sync orchestration
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: [],
    };

    // 1) Connectivity check
    const online = await this.checkConnectivity();
    if (!online) {
      result.success = false;
      result.errors.push({
        task_id: 'N/A',
        operation: 'connectivity',
        error: 'Server unreachable',
        timestamp: new Date(),
      });
      return result;
    }

    // 2) Fetch all pending queue items
    const allItems: SyncQueueItem[] = await this.db.getAllSyncQueueItems();

    if (!allItems || allItems.length === 0) {
      return result; // nothing to do
    }

    // 3) Group into batches
    for (let i = 0; i < allItems.length; i += this.batchSize) {
      const batch = allItems.slice(i, i + this.batchSize);

      try {
        // 4) Process batch
        const batchResp = await this.processBatch(batch);

        // 5) Apply results
        for (const processed of batchResp.processed_items) {
          const clientId = processed.client_id;
          const queueItem = batch.find((b) => b.id === clientId);
          if (!queueItem) continue; // defensive

          if (processed.status === 'success') {
            // Mark local task as synced, update server_id if provided
            await this.updateSyncStatus(queueItem.task_id, 'synced', {
              server_id: processed.server_id,
              // resolved_data may also carry timestamps etc
              ...(processed.resolved_data ? processed.resolved_data : {}),
            });
            result.synced_items += 1;
          } else if (processed.status === 'conflict') {
            // Resolve conflict locally (last-write-wins)
            if (processed.resolved_data) {
              const resolved = await this.resolveConflict(
                (await this.db.getTaskById(queueItem.task_id)) as Task,
                processed.resolved_data
              );
              // Persist resolved data locally
               this.db.updateTask(queueItem.task_id, {
                title: resolved.title,
                description: resolved.description,
                completed: resolved.completed,
                created_at: resolved.created_at,
                updated_at: resolved.updated_at,
                is_deleted: resolved.is_deleted,
                server_id: resolved.server_id,
                sync_status: 'synced',
                last_synced_at: new Date(),
              });
              // delete queue item (applied)
           this.db.deleteSyncQueueItem(queueItem.id, {
  retry_count: queueItem.retry_count ?? 0,
  error_message: queueItem.error_message ?? ''
});

              result.synced_items += 1;
            } else {
              // If no resolved_data returned, treat as error
              await this.handleSyncError(queueItem, new Error('Conflict with no resolved_data from server'));
              result.failed_items += 1;
              result.success = false;
              result.errors.push({
                task_id: queueItem.task_id,
                operation: queueItem.operation,
                error: 'Conflict resolved failed: no resolved data',
                timestamp: new Date(),
              });
            }
          } else if (processed.status === 'error') {
            // Server reported error for this item
            const errMsg = processed.error || 'Unknown server error';
            await this.handleSyncError(queueItem, new Error(errMsg));
            result.failed_items += 1;
            result.success = false;
            result.errors.push({
              task_id: queueItem.task_id,
              operation: queueItem.operation,
              error: errMsg,
              timestamp: new Date(),
            });
          }
        }
      } catch (err: any) {
        // Entire batch failed (network/server), increment retry for all items
        for (const item of batch) {
          await this.handleSyncError(item, err instanceof Error ? err : new Error(String(err)));
          result.failed_items += 1;
          result.success = false;
          result.errors.push({
            task_id: item.task_id,
            operation: item.operation,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date(),
          });
        }
      }
    }

    return result;
  }

  /**
   * Add operation to sync queue
   */
 async addToSyncQueue(
  taskId: string,
  operation: 'create' | 'update' | 'delete',
  data: Partial<Task>
): Promise<void> {
  const item: SyncQueueItem = {
    id: uuidv4(),
    task_id: taskId,
    operation,
    data,
    created_at: new Date(),
    retry_count: 0,
    error_message: undefined,
  };

  // persist the queue item (await it)
  await this.db.insertSyncQueueItem(item);

  // Try to fetch existing task
  const existing = await this.db.getTaskById(taskId);

  if (existing) {
    // We have a full task row — update only the sync_status
    const updatedTask: Task = {
      ...existing,
      sync_status: 'pending',
      // update updated_at so record shows a local change
      updated_at: new Date(),
    };

    // If your Database.updateTask expects a full Task-like object, pass it
     this.db.updateTask(taskId, updatedTask as any);
    return;
  }

  // No existing task found — create a minimal full task object
  const now = new Date();
  const newTask: Task = {
    id: taskId,
    title: data.title ?? 'Untitled',
    description: data.description,
    completed: data.completed ?? false,
    created_at: data.created_at ?? now,
    updated_at: data.updated_at ?? now,
    is_deleted: data.is_deleted ?? false,
    sync_status: 'pending',
    server_id: data.server_id,
    last_synced_at: data.last_synced_at ?? now,
  };

  // Either insert or call updateTask depending on your DB API.
  // Prefer insertTask when creating new row; fallback to updateTask if that's how your DB works.
  if (typeof this.db.insertTask === 'function') {
     this.db.insertTask(newTask);
  } else {
     this.db.updateTask(taskId, newTask as any);
  }
}

  /**
   * Process a batch of sync items by sending them to server and returning server response
   */
  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const payload: BatchSyncRequest = {
      items,
      client_timestamp: new Date(),
    };

    try {
      const resp = await axios.post<BatchSyncResponse>(`${this.apiUrl}/sync/batch`, payload, { timeout: 15000 });
      return resp.data;
    } catch (err) {
      // rethrow to be handled by caller
      throw err;
    }
  }

  /**
   * Last-write-wins conflict resolution:
   * Compares updated_at timestamps and returns task which has later updated_at.
   */
  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    // Defensive: if one is missing updated_at, prefer the other
    const localUpdated = localTask?.updated_at ? new Date(localTask.updated_at) : new Date(0);
    const serverUpdated = serverTask?.updated_at ? new Date(serverTask.updated_at) : new Date(0);

    const chosen = serverUpdated > localUpdated ? serverTask : localTask;

    // Log decision - you may adapt to use a logger
    // console.info(`[SyncService] Conflict for task ${localTask.id} resolved to ${chosen.server_id || chosen.id}`);

    return chosen;
  }

  /**
   * Update task sync status in DB and remove from queue if synced
   */
private async updateSyncStatus(
  taskId: string,
  status: 'synced' | 'error',
  serverData?: Partial<Task>
): Promise<void> {
  const updates: Partial<Task> = {
    sync_status: status === 'synced' ? 'synced' : 'error',
    last_synced_at: new Date(),
  };

  if (serverData?.server_id) {
    updates.server_id = serverData.server_id;
  }

  // Only copy properties that are actually defined
  if (serverData?.title !== undefined) updates.title = serverData.title;
  if (serverData?.description !== undefined) updates.description = serverData.description;
  if (serverData?.completed !== undefined) updates.completed = serverData.completed;
  if (serverData?.updated_at !== undefined) updates.updated_at = serverData.updated_at;
  if (serverData?.created_at !== undefined) updates.created_at = serverData.created_at;
  if (serverData?.is_deleted !== undefined) updates.is_deleted = serverData.is_deleted;

  // ✅ Explicitly cast Partial<Task> to any to satisfy stricter DB typing
   this.db.updateTask(taskId, updates as any);

 if (status === 'synced') {
  // ensure we await and treat return as SyncQueueItem[]
  const queueItems = (this.db.findSyncQueueItemsByTaskId(taskId)) as unknown as SyncQueueItem[];

  for (const qi of queueItems) {
    // deleteSyncQueueItem expects two args according to your Database type.
    // pass current retry_count and error_message (or sensible defaults)
   this.db.deleteSyncQueueItem(qi.id, {
      retry_count: qi.retry_count,
      error_message: qi.error_message ?? '',
    });
  }
}
}


  /**
   * Handle per-item sync errors: increment retry_count, store error, mark permanent failure after maxRetries.
   */
  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const nextRetry = item.retry_count + 1;
     this.db.deleteSyncQueueItem(item.id, {
      retry_count: nextRetry,
      error_message: error.message,
    });

    if (nextRetry >= this.maxRetries) {
      // Mark as permanent failure on local task
      this.db.updateTask(item.task_id, {
        sync_status: 'error',
        last_synced_at: new Date(),
        title: '',
        description: undefined,
        completed: false,
        created_at: new Date(),
        updated_at: new Date(),
        is_deleted: false,
        server_id: undefined
      });

      // Optionally move to a dead-letter table or keep queue item with permanent flag
      this.db.deleteSyncQueueItem(item.id, {
        error_message: `Permanent failure after ${nextRetry} retries: ${error.message}`,
        retry_count: 0
      });
    }

    // else, leave it in queue (will be retried on next sync)
  }

  /**
   * Health-check for remote server
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
