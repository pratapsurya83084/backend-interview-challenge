


// src/routes/sync.ts
import { Router, Request, Response } from 'express';
import { Database } from '../db/database';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { BatchSyncRequest, SyncQueueItem, Task } from '../types';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync
  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const online = await syncService.checkConnectivity();
      if (!online) {
        return res.status(503).json({ error: 'Server unreachable' });
      }
      const result = await syncService.sync();
      return res.status(200).json(result);
    } catch (err: any) {
      console.error('[sync trigger] error', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  

  // GET /status  - done
router.get('/status', async (req: Request, res: Response) => {
  try {
    // pending count (number of queue rows)
    const pending = await db.countPendingSyncQueueItems();

    // last synced timestamp (Date | null) -> convert to ISO string or null
    const lastSyncedDate = await db.getLastSyncedAt();
    const last_sync_timestamp = lastSyncedDate ? lastSyncedDate.toISOString() : null;

    // connectivity check
    const is_online = await syncService.checkConnectivity();

    // size of sync queue — same as pending for now, but kept explicit
    const sync_queue_size = pending;

    return res.status(200).json({
      pending_sync_count: pending,
      last_sync_timestamp,
      is_online,
      sync_queue_size,
    });
  } catch (err: any) {
    console.error('[sync status] error', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
      path: req.path,
    });
  }
});


  // Batch sync endpoint (SERVER SIDE) - done
  router.post('/batch', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<BatchSyncRequest>;
      if (!body || !Array.isArray(body.items)) {
        return res.status(400).json({ error: 'Invalid payload' });
      }

      const items = body.items as SyncQueueItem[];

      const response = {
        results: { received: items.length },
        processed_items: [] as {
          client_id: string;
          server_id: string;
          status: 'success' | 'conflict' | 'error';
          resolved_data?: Task;
          error?: string;
        }[],
      };

      for (const it of items) {
        try {
          if (!it || !it.task_id || !it.operation) {
            response.processed_items.push({ client_id: it?.id ?? 'unknown', server_id: '', status: 'error', error: 'Invalid item' });
            continue;
          }

          const serverTask = await db.getTaskById(it.task_id);

          if (it.operation === 'create') {
            if (serverTask) {
              // conflict: server already has it
              response.processed_items.push({ client_id: it.id, server_id: serverTask.server_id ?? serverTask.id, status: 'conflict', resolved_data: serverTask });
              continue;
            }

            const now = new Date();
            const t: Task = {
              id: it.task_id,
              title: (it.data as any)?.title ?? 'Untitled',
              description: (it.data as any)?.description,
              completed: (it.data as any)?.completed ?? false,
              created_at: it.data?.created_at ? new Date(it.data.created_at as any) : now,
              updated_at: it.data?.updated_at ? new Date(it.data.updated_at as any) : now,
              is_deleted: (it.data as any)?.is_deleted ?? false,
              sync_status: 'synced',
              server_id: it.task_id,
              last_synced_at: new Date(),
            };
            await db.insertTask(t);
            response.processed_items.push({ client_id: it.id, server_id: t.server_id ?? t.id, status: 'success', resolved_data: t });
          } else if (it.operation === 'update') {
            if (!serverTask) {
              // no server record -> create
              const now = new Date();
              const t: Task = {
                id: it.task_id,
                title: (it.data as any)?.title ?? 'Untitled',
                description: (it.data as any)?.description,
                completed: (it.data as any)?.completed ?? false,
                created_at: it.data?.created_at ? new Date(it.data.created_at as any) : now,
                updated_at: it.data?.updated_at ? new Date(it.data.updated_at as any) : now,
                is_deleted: (it.data as any)?.is_deleted ?? false,
                sync_status: 'synced',
                server_id: it.task_id,
                last_synced_at: new Date(),
              };
              await db.insertTask(t);
              response.processed_items.push({ client_id: it.id, server_id: t.server_id ?? t.id, status: 'success', resolved_data: t });
              continue;
            }

            const clientUpdated = it.data?.updated_at ? new Date(it.data.updated_at as any) : null;
            const serverUpdated = serverTask.updated_at ? new Date(serverTask.updated_at) : null;

            if (clientUpdated && serverUpdated && serverUpdated > clientUpdated) {
              // server newer -> conflict
              response.processed_items.push({ client_id: it.id, server_id: serverTask.server_id ?? serverTask.id, status: 'conflict', resolved_data: serverTask });
              continue;
            }

            const updates: Partial<Task> = {
              title: (it.data as any)?.title ?? serverTask.title,
              description: (it.data as any)?.description ?? serverTask.description,
              completed: (it.data as any)?.completed ?? serverTask.completed,
              updated_at: it.data?.updated_at ? new Date(it.data.updated_at as any) : new Date(),
              is_deleted: (it.data as any)?.is_deleted ?? serverTask.is_deleted,
              sync_status: 'synced',
              last_synced_at: new Date(),
            };

            await db.updateTask(it.task_id, updates as any);
            const merged = await db.getTaskById(it?.task_id);
            // response.processed_items.push({ client_id: it.id, server_id: merged?.server_id ?? merged?.id , status: 'success', resolved_data: merged });
         response.processed_items.push({
    client_id: it.id,
    server_id: '',
    status: 'success',
  });
        
          } else if (it.operation === 'delete') {
            if (!serverTask) {
              response.processed_items.push({ client_id: it.id, server_id: '', status: 'success' });
              continue;
            }
            // perform soft delete
            await db.updateTask(it.task_id, { ...serverTask, is_deleted: true, updated_at: new Date(), sync_status: 'synced', last_synced_at: new Date() } as any);
            response.processed_items.push({ client_id: it.id, server_id: serverTask.server_id ?? serverTask.id, status: 'success' });
          } else {
            response.processed_items.push({ client_id: it.id, server_id: '', status: 'error', error: `Unsupported operation ${it.operation}` });
          }
        } catch (itemErr: any) {
          console.error('[sync batch item] error', itemErr);
          response.processed_items.push({ client_id: it.id, server_id: '', status: 'error', error: itemErr instanceof Error ? itemErr.message : String(itemErr) });
        }
      }

      return res.status(200).json(response);
    } catch (err: any) {
      console.error('[sync batch] error', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // health -  done 
  router.get('/health', async (_req: Request, res: Response) => {
    return res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}
