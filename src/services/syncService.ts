import axios from 'axios';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;
  batchSize: number | undefined;
  
  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  // async sync(): Promise<SyncResult> {
  //   // TODO: Main sync orchestration method
  //   // 1. Get all items from sync queue
  //   // 2. Group items by batch (use SYNC_BATCH_SIZE from env)
  //   // 3. Process each batch
  //   // 4. Handle success/failure for each item
  //   // 5. Update sync status in database
  //   // 6. Return sync result summary

  // }



  
  // }


private batchSize(): number {
  const env = Number(process.env.SYNC_BATCH_SIZE ?? this.batchSize ?? 10);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 10;
}

private maxRetries(): number {
  const env = Number(process.env.SYNC_MAX_RETRIES ?? 5);
  return Number.isFinite(env) && env >= 0 ? Math.floor(env) : 5;
}

/**
 * Process one batch of sync items by POSTing to remote /sync/batch.
 * Expects BatchSyncResponse to include per-item results.
 */
private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
  // Build request payload
  const req: BatchSyncRequest = {
    items: items.map((it) => ({
      queue_id: it.id,
      task_id: it.task_id,
      operation: it.operation,
      data: typeof it.data === 'string' ? JSON.parse(it.data) : it.data,
    })),
  };

  try {
    const url = `${this.apiUrl.replace(/\/$/, '')}/sync/batch`;
    const resp = await axios.post<BatchSyncResponse>(url, req, {
      timeout: Number(process.env.SYNC_REQUEST_TIMEOUT_MS ?? 15000),
    });

    // Validate response shape
    if (!resp || !resp.data) {
      throw new Error('Invalid batch sync response');
    }

    return resp.data;
  } catch (err: any) {
    // Re-throw an error that caller will handle
    throw new Error(err?.message ?? String(err));
  }
}

/**
 * Resolve conflicts with last-write-wins: compare updated_at and return the newer Task
 */
private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
  // If serverTask.updated_at is newer, prefer it; otherwise prefer localTask
  try {
    const localTs = localTask.updated_at instanceof Date ? localTask.updated_at.getTime() : new Date(localTask.updated_at).getTime();
    const serverTs = serverTask.updated_at instanceof Date ? serverTask.updated_at.getTime() : new Date(serverTask.updated_at).getTime();

    const winner = serverTs > localTs ? serverTask : localTask;
    console.log(`resolveConflict: winner for task ${localTask.id} is ${serverTs > localTs ? 'server' : 'local'}`);
    return winner;
  } catch (err) {
    // on parse error, fallback to local
    return localTask;
  }
}

/**
 * Update the task's sync status in DB, optionally update server_id / last_synced_at.
 * If status is 'synced', remove the sync_queue row for this operation (by queueId) if provided.
 */
private async updateSyncStatus(
  taskId: string,
  status: 'synced' | 'error',
  serverData?: Partial<Task>,
  queueId?: string
): Promise<void> {
  const nowIso = new Date().toISOString();

  // Update server_id and last_synced_at when provided
  const updates: string[] = [];
  const params: any[] = [];

  updates.push('sync_status = ?');
  params.push(status);

  if (serverData?.server_id !== undefined) {
    updates.push('server_id = ?');
    params.push(serverData.server_id);
  }

  if (status === 'synced') {
    updates.push('last_synced_at = ?');
    params.push(nowIso);
  }

  const sql = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`;
  params.push(taskId);

  await this.db.run(sql, params);

  // remove from queue if synced and queueId provided
  if (status === 'synced' && queueId) {
    await this.db.run('DELETE FROM sync_queue WHERE id = ?', [queueId]);
  }
}

/**
 * Handle a sync error for an item: increment retry_count, set error_message, and set task sync_status to 'error'.
 * If retry_count exceeds max, leaves it marked for manual investigation (could move to dead-letter).
 */
private async handleSyncError(item: SyncQueueItem, error: Error | string): Promise<void> {
  const errMsg = typeof error === 'string' ? error : String(error?.message ?? error);
  const nowIso = new Date().toISOString();

  // increment retry_count
  const newRetrySql = `UPDATE sync_queue SET retry_count = COALESCE(retry_count, 0) + 1, error_message = ?, created_at = ? WHERE id = ?`;
  await this.db.run(newRetrySql, [errMsg, nowIso, item.id]);

  // update task sync_status = 'error'
  await this.db.run(`UPDATE tasks SET sync_status = 'error' WHERE id = ?`, [item.task_id]);

  // Optionally if retry_count > max, you could mark permanently failed — keep for now
  const row: any = await this.db.get(`SELECT retry_count FROM sync_queue WHERE id = ? LIMIT 1`, [item.id]);
  const retryCount = Number(row?.retry_count ?? 0);
  if (retryCount > this.maxRetries()) {
    console.warn(`Sync item ${item.id} exceeded max retries (${retryCount}). Needs manual handling.`);
    // Could set a 'permanent_failure' flag or move to dead-letter table
  }
}

/**
 * Orchestrates sync: batches queue items, calls processBatch, updates DB and returns summary.
 */
public async sync(): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    synced_items: 0,
    failed_items: 0,
    errors: [],
  };

  // quick connectivity check
  const reachable = await this.checkConnectivity();
  if (!reachable) {
    // nothing to do (or could return failure)
    return { ...result, success: false, errors: [{ task_id: '', operation: 'sync', error: 'remote unreachable', timestamp: new Date().toISOString() }] };
  }

  // fetch all queue items (oldest first)
  const allQueueSql = `SELECT id, task_id, operation, data, created_at, retry_count, error_message FROM sync_queue ORDER BY created_at ASC`;
  const items: SyncQueueItem[] = (await this.db.all(allQueueSql)) || [];

  if (!items.length) {
    result.success = true;
    return result;
  }

  const batchSize = this.batchSize();

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    // attempt to process entire batch via remote endpoint
    try {
      const batchResp = await this.processBatch(batch);

      // BatchResponse expected to have per-item result items
      // assume BatchSyncResponse.results: { queue_id, success, server_task?, error? }[]
      for (const r of batchResp.results) {
        const queueId = r.queue_id;
        const queueItem = batch.find((b) => b.id === queueId);
        if (!queueItem) continue; // defensive

        if (r.success) {
          // if server returned a task object, maybe resolve conflict
          if (r.server_task) {
            // optional conflict resolution
            try {
              const localTaskRow: any = await this.db.get(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [queueItem.task_id]);
              if (localTaskRow) {
                const localTask: Task = {
                  id: localTaskRow.id,
                  title: localTaskRow.title,
                  description: localTaskRow.description ?? '',
                  completed: Boolean(localTaskRow.completed),
                  created_at: new Date(localTaskRow.created_at),
                  updated_at: new Date(localTaskRow.updated_at),
                  is_deleted: Boolean(localTaskRow.is_deleted),
                  sync_status: localTaskRow.sync_status,
                  server_id: localTaskRow.server_id ?? undefined,
                  last_synced_at: localTaskRow.last_synced_at ? new Date(localTaskRow.last_synced_at) : undefined,
                };
                const winner = await this.resolveConflict(localTask, r.server_task);
                // persist winner if it's the server version (server_task newer)
                if (winner && winner.server_id !== localTask.server_id) {
                  await this.db.run(
                    `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, server_id = ?, sync_status = 'synced', last_synced_at = ? WHERE id = ?`,
                    [
                      winner.title,
                      winner.description ?? '',
                      winner.completed ? 1 : 0,
                      winner.updated_at.toISOString(),
                      winner.server_id ?? null,
                      new Date().toISOString(),
                      localTask.id,
                    ]
                  );
                } else {
                  // just mark synced
                  await this.updateSyncStatus(queueItem.task_id, 'synced', undefined, queueId);
                }
              } else {
                // no local row, mark as synced
                await this.updateSyncStatus(queueItem.task_id, 'synced', undefined, queueId);
              }
            } catch (e) {
              // if conflict resolution fails, mark as synced without merge
              await this.updateSyncStatus(queueItem.task_id, 'synced', undefined, queueId);
            }
          } else {
            // no server_task payload — simple success
            await this.updateSyncStatus(queueItem.task_id, 'synced', undefined, queueId);
          }

          result.synced_items += 1;
        } else {
          // failure for this item
          await this.handleSyncError(queueItem, r.error ?? 'remote error');
          result.failed_items += 1;
          result.errors.push({
            task_id: queueItem.task_id,
            operation: queueItem.operation,
            error: r.error ?? 'remote error',
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (batchErr: any) {
      // If the batch itself failed (network, server down), fall back to per-item handling:
      console.error('Batch sync failed:', batchErr?.message ?? batchErr);
      for (const item of batch) {
        try {
          // Attempt individual item push as fallback using same axios to /sync/item
          const itemUrl = `${this.apiUrl.replace(/\/$/, '')}/sync/item`;
          try {
            const body = {
              operation: item.operation,
              data: typeof item.data === 'string' ? JSON.parse(item.data) : item.data,
              local_task_id: item.task_id,
            };
            const resp = await axios.post(itemUrl, body, { timeout: 10000 });
            if (resp.status >= 200 && resp.status < 300) {
              // success — update status & delete queue
              await this.updateSyncStatus(item.task_id, 'synced', resp.data?.server_task, item.id);
              result.synced_items += 1;
              continue;
            } else {
              throw new Error(`HTTP ${resp.status}`);
            }
          } catch (itErr) {
            await this.handleSyncError(item, itErr as Error);
            result.failed_items += 1;
            result.errors.push({
              task_id: item.task_id,
              operation: item.operation,
              error: String((itErr as any)?.message ?? itErr),
              timestamp: new Date().toISOString(),
            });
          }
        } catch (outerErr) {
          console.error('Error in fallback per-item sync:', outerErr);
        }
      }
    }
  } // end batches

  result.success = result.failed_items === 0;
  return result;
}

/**
 * Add a task change operation to the sync queue (convenience wrapper)
 */
async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
  const payload = JSON.stringify(data ?? {});
  const createdAt = new Date().toISOString();
  const retryCount = 0;
  const errorMessage = null;

  const insertSql = `
    INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `.trim();

  const queueId = require('uuid').v4(); // generate id for queue
  await this.db.run(insertSql, [queueId, taskId, operation, payload, createdAt, retryCount, errorMessage]);
}

}



// import axios from 'axios';
// import {
//   Task,
//   SyncQueueItem,
//   SyncResult,
//   BatchSyncRequest,
//   BatchSyncResponse,
// } from '../types';
// import { Database } from '../db/database';
// import { TaskService } from './taskService';
// import { v4 as uuidv4 } from 'uuid';

// export class SyncService {
//   private apiUrl: string;
//   private batchSize: number;

//   constructor(
//     private db: Database,
//     private taskService: TaskService,
//     apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
//   ) {
//     this.apiUrl = apiUrl;
//     this.batchSize = Number(process.env.SYNC_BATCH_SIZE) || 10; // default batch size
//   }

//   /**
//    * Main synchronization process:
//    * 1. Fetch all pending items in sync_queue
//    * 2. Send in batches to server
//    * 3. Handle responses, update DB status
//    */
//  async sync(): Promise<SyncResult> {
//   const result: SyncResult = {
//     success: true,
//     synced_items: 0,
//     failed_items: 0,
//     errors: [],
//   };

//   // ensure batchSize is sane
//   const batchSize = Number(this.batchSize) > 0 ? Number(this.batchSize) : 10;

//   // quick connectivity check
//   const reachable = await this.checkConnectivity();
//   if (!reachable) {
//     result.success = false;
//     result.errors.push({
//       task_id: 'connectivity',
//       operation: 'sync',
//       error: 'Server unreachable',
//       timestamp: new Date(),
//     });
//     return result;
//   }

//   // fetch pending sync items
//   const rows: any[] = await this.db.all(`SELECT * FROM sync_queue ORDER BY created_at ASC`);
//   if (!rows || rows.length === 0) {
//     result.success = true;
//     return result;
//   }

//   // safe JSON parse helper
//   const safeParse = (s: any) => {
//     if (!s || typeof s !== 'string') return { ok: true, value: s || {} };
//     try {
//       return { ok: true, value: JSON.parse(s) };
//     } catch (e: any) {
//       return { ok: false, error: e.message || String(e) };
//     }
//   };

//   // map DB rows -> SyncQueueItem[], skipping rows with malformed data and recording an error
//   const items: SyncQueueItem[] = [];
//   for (const r of rows) {
//     const parsed = safeParse(r.data);
//     if (!parsed.ok) {
//       // mark this row as failed (increment retry etc.) but continue processing others
//       await this.handleSyncError(
//         {
//           id: r.id,
//           task_id: r.task_id,
//           operation: r.operation,
//           data: {},
//           created_at: r.created_at ? new Date(r.created_at) : new Date(),
//           retry_count: r.retry_count || 0,
//           error_message: parsed.error,
//         } as SyncQueueItem,
//         new Error(`Invalid JSON in sync_queue.data: ${parsed.error}`)
//       );
//       result.failed_items++;
//       result.errors.push({
//         task_id: r.task_id,
//         operation: r.operation,
//         error: `Invalid JSON in sync_queue.data: ${parsed.error}`,
//         timestamp: new Date(),
//       });
//       continue;
//     }

//     items.push({
//       id: r.id,
//       task_id: r.task_id,
//       operation: r.operation,
//       data: parsed.value,
//       created_at: r.created_at ? new Date(r.created_at) : new Date(),
//       retry_count: r.retry_count || 0,
//       error_message: r.error_message || undefined,
//     } as SyncQueueItem);
//   }

//   // process batches
//   for (let i = 0; i < items.length; i += batchSize) {
//     const batch = items.slice(i, i + batchSize);
//     try {
//       const batchResp = await this.processBatch(batch);

//       // validate response shape
//       if (!batchResp || !Array.isArray((batchResp as any).processed_items)) {
//         console.error('Invalid batch response:', batchResp);
//         for (const it of batch) {
//           await this.handleSyncError(it, new Error('Invalid batch response from server'));
//           result.failed_items++;
//           result.errors.push({
//             task_id: it.task_id,
//             operation: it.operation,
//             error: 'Invalid batch response from server',
//             timestamp: new Date(),
//           });
//         }
//         continue;
//       }

//       // iterate processed items
//       for (const p of (batchResp as BatchSyncResponse).processed_items) {
//         const clientId = String((p as any).client_id || '');
//         const serverId = String((p as any).server_id || '');

//         if (p.status === 'success') {
//           // update using sync_queue id (clientId) — updateSyncStatus should lookup task_id from sync_queue
//           await this.updateSyncStatus(clientId, 'synced', {
//             server_id: serverId,
//             ...(p.resolved_data || {}),
//           });
//           result.synced_items++;
//         } else if (p.status === 'conflict' && p.resolved_data) {
//           await this.updateSyncStatus(clientId, 'synced', p.resolved_data);
//           result.synced_items++;
//         } else {
//           // treat as error
//           await this.handleSyncError(
//             {
//               id: clientId,
//               task_id: serverId || '',
//               operation: 'update',
//               data: {},
//               created_at: new Date(),
//               retry_count: 0,
//             } as SyncQueueItem,
//             new Error(p.error || 'Server error')
//           );
//           result.failed_items++;
//           result.errors.push({
//             task_id: serverId || (p as any).client_id || 'unknown',
//             operation: 'server',
//             error: p.error || 'Server returned error status',
//             timestamp: new Date(),
//           });
//         }
//       }
//     } catch (err: any) {
//       console.error('Batch processing failed:', err);
//       // mark all items in batch as failed (increment retry)
//       for (const it of batch) {
//         await this.handleSyncError(it, err instanceof Error ? err : new Error(String(err)));
//         result.failed_items++;
//         result.errors.push({
//           task_id: it.task_id,
//           operation: it.operation,
//           error: String(err),
//           timestamp: new Date(),
//         });
//       }
//     }
//   }

//   // final success flag
//   result.success = result.failed_items === 0;
//   return result;
// }


//   /**
//    * Adds a new operation to the sync queue.
//    * Used when a task is created, updated, or deleted offline.
//    */
//   async addToSyncQueue(
//     taskId: string,
//     operation: 'create' | 'update' | 'delete',
//     data: Partial<Task>
//   ): Promise<void> {
//     const id = uuidv4();
//     const jsonData = JSON.stringify(data);

//     await this.db.run(
//       `INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, ?, ?)`,
//       [id, taskId, operation, jsonData]
//     );
//   }

//   /**
//    * Send a batch of sync items to the server and return the response.
//    */
// private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
//   // Local type for the request item's wire format
//   type BatchItemPayload = {
//     id: string;
//     task_id: string;
//     operation: 'create' | 'update' | 'delete';
//     data: string;           // stringified JSON on the wire
//     created_at: string;     // ISO string on the wire
//     retry_count: number;
//     error_message?: string;
//   };

//   const payload: { items: BatchItemPayload[]; client_timestamp: string } = {
//     items: items.map((it) => ({
//       id: it.id,
//       task_id: it.task_id,
//       operation: it.operation,
//       data: typeof it.data === 'string' ? it.data : JSON.stringify(it.data || {}),
//       created_at: it.created_at instanceof Date ? it.created_at.toISOString() : new Date(it.created_at).toISOString(),
//       retry_count: it.retry_count || 0,
//       error_message: it.error_message || undefined,
//     })),
//     client_timestamp: new Date().toISOString(),
//   };

//   try {
//     const url = `${this.apiUrl.replace(/\/$/, '')}/batch`;
//     const response = await axios.post(url, payload, {
//       timeout: 20000,
//       headers: { 'Content-Type': 'application/json' },
//     });

//     if (!response?.data || !Array.isArray((response.data as any).processed_items)) {
//       throw new Error('Invalid batch response format from server');
//     }

//     return response.data as BatchSyncResponse;
//   } catch (err: any) {
//     console.error('processBatch error:', err?.message || err);
//     throw new Error('Failed to send batch to server: ' + (err?.message || String(err)));
//   }
// }




//   /**
//    * Conflict resolution using "last-write-wins" strategy.
//    */
//   private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
//     const localTime = new Date(localTask.updated_at).getTime();
//     const serverTime = new Date(serverTask.updated_at).getTime();
//     return localTime > serverTime ? localTask : serverTask;
//   }

//   /**
//    * Updates a task's sync status and removes it from sync_queue if successful.
//    */
// /**
//  * Update local sync status for the task referenced by a sync_queue row.
//  * queueId is the sync_queue.id (client-side unique id).
//  * If successful, remove the sync_queue entry.
//  */
// private async updateSyncStatus(
//   queueId: string,
//   status: 'synced' | 'error',
//   serverData?: Partial<Task>
// ): Promise<void> {
//   // find the sync_queue row to get the real task id
//   const row: any = await this.db.get(`SELECT * FROM sync_queue WHERE id = ?`, [queueId]);
//   if (!row) return;

//   const taskId = row.task_id;

//   const now = new Date().toISOString();
//   const serverId = serverData?.server_id ?? (serverData as any)?.id ?? null;

//   // update the tasks table (use taskId)
//   await this.db.run(
//     `UPDATE tasks SET sync_status = ?, server_id = COALESCE(?, server_id), last_synced_at = ? WHERE id = ?`,
//     [status, serverId, now, taskId]
//   );

//   // remove queue entry if synced
//   if (status === 'synced') {
//     await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [queueId]);
//   }
// }


//   /**
//    * Handles synchronization errors (increment retry count, log error).
//    */
//   private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
//     const newRetry = (item.retry_count || 0) + 1;
//     const errorMsg = error.message || 'Unknown error';

//     if (newRetry >= 5) {
//       // Mark as permanently failed after 5 attempts
//       await this.db.run(
//         `UPDATE sync_queue SET error_message = ?, retry_count = ?, operation = 'failed' WHERE id = ?`,
//         [errorMsg, newRetry, item.id]
//       );
//     } else {
//       await this.db.run(
//         `UPDATE sync_queue SET error_message = ?, retry_count = ? WHERE id = ?`,
//         [errorMsg, newRetry, item.id]
//       );
//     }
//   }

//   /**
//    * Simple connectivity check to verify remote server availability.
//    */
//   async checkConnectivity(): Promise<boolean> {
//     try {
//       const res = await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
//       return res.status === 200;
//     } catch {
//       return false;
//     }
//   }
// }
