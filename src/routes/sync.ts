// import { Router, Request, Response } from 'express';
// import { SyncService } from '../services/syncService';
// import { TaskService } from '../services/taskService';
// import { Database } from '../db/database';

// export function createSyncRouter(db: Database): Router {
//   const router = Router();
//   const taskService = new TaskService(db);
//   const syncService = new SyncService(db, taskService);

//   // Trigger manual sync
//   router.post('/sync', async (req: Request, res: Response) => {
//     // TODO: Implement sync endpoint
//     // 1. Check connectivity first
//     // 2. Call syncService.sync()
//     // 3. Return sync result
//     res.status(501).json({ error: 'Not implemented' });
//   });

//   // Check sync status
//   router.get('/status', async (req: Request, res: Response) => {
//     // TODO: Implement sync status endpoint
//     // 1. Get pending sync count
//     // 2. Get last sync timestamp
//     // 3. Check connectivity
//     // 4. Return status summary
//     res.status(501).json({ error: 'Not implemented' });
//   });

//   // Batch sync endpoint (for server-side)
//   router.post('/batch', async (req: Request, res: Response) => {
//     // TODO: Implement batch sync endpoint
//     // This would be implemented on the server side
//     // to handle batch sync requests from clients
//     res.status(501).json({ error: 'Not implemented' });
//   });

//   // Health check endpoint
//   router.get('/health', async (req: Request, res: Response) => {
//     res.json({ status: 'ok', timestamp: new Date() });
//   });

//   return router;
// }



import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import { SyncQueueItem, BatchSyncResponse } from '../types';

/**
 * Sync router:
 *  - POST /sync   -> client triggers a sync (push local queue -> remote server)
 *  - GET  /status -> info about pending syncs, last sync time, connectivity
 *  - POST /batch  -> server endpoint to accept client batch requests
 *  - GET  /health -> simple health check
 *
 * The /batch response shape matches the BatchSyncResponse expected by SyncService:
 *   { processed_items: [ { client_id, server_id, status, resolved_data?, error? } ] }
 */
export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // POST /sync -> trigger SyncService.sync() router.post('/sync', 
  async (req: Request, res: Response) => {
    try {
      // 1. Check remote connectivity
      const reachable = await syncService.checkConnectivity();
      if (!reachable) {
        return res.status(503).json({
          success: false,
          message: 'Remote server unreachable. Try again later.',
        });
      }

      // 2. Run sync orchestration
      const syncResult = await syncService.sync();

      // 3. Return result (SyncResult shape)
      return res.json(syncResult);
    } catch (err: any) {
      console.error('POST /sync error:', err);
      return res.status(500).json({
        success: false,
        message: err?.message || 'Internal server error during sync',
      });
    }
  }

  async function dbGetAsync(sql: string, params: any[] = []): Promise<any> {
    if (typeof (db as any).get === 'function') {
      try {
        const maybePromise = (db as any).get(sql, params);
        if (maybePromise && typeof maybePromise.then === 'function') {
          return await maybePromise;
        }
      } catch {
        // fallthrough to callback-style below
      }

      return new Promise<any>((resolve, reject) => {
        try {
          (db as any).get(sql, params, (err: Error | null, row: any) => {
            if (err) return reject(err);
            resolve(row);
          });
        } catch (e) {
          reject(e);
        }
      });
    }
    throw new Error('db.get is not available');
  }

  // GET /status -> summary: pending count, last sync timestamp, connectivity
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      // 1) pending sync count (exclude permanently failed queue entries with operation = 'failed')
      const pendingRow: any = await dbGetAsync(
        `SELECT COUNT(*) as cnt FROM sync_queue WHERE operation != 'failed'`
      );
      const pendingCount = pendingRow ? Number(pendingRow.cnt) : 0;

      // 2) total sync_queue size
      const totalRow: any = await dbGetAsync(`SELECT COUNT(*) as cnt FROM sync_queue`);
      const totalCount = totalRow ? Number(totalRow.cnt) : 0;

      // 3) last sync timestamp (latest last_synced_at from tasks)
      const lastSyncRow: any = await dbGetAsync(`SELECT MAX(last_synced_at) as last_sync FROM tasks`);
      let lastSync: string | null = null;
      if (lastSyncRow && lastSyncRow.last_sync) {
        const raw = lastSyncRow.last_sync;
        const d = new Date(raw);
        lastSync = !isNaN(d.getTime()) ? d.toISOString() : String(raw);
      }

      // 4) connectivity
      const isOnline = Boolean(await syncService.checkConnectivity());

      // Return the exact shape you requested
      return res.json({
        pending_sync_count: pendingCount,
        last_sync_timestamp: lastSync,
        is_online: isOnline,
        sync_queue_size: totalCount,
      });
    } catch (err: any) {
      console.error('GET /status error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
    }
  });

  /**
   * POST /batch
   * Accepts a client BatchSyncRequest and applies the items using TaskService.
   * Response shape:
   * {
   *   processed_items: [
   *     { client_id, server_id, status: 'success'|'conflict'|'error', resolved_data?, error? }
   *   ]
   * }
   */
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const body = req.body as { items?: any[]; client_timestamp?: string } | undefined;
    if (!body || !Array.isArray(body.items)) {
      return res.status(400).json({ error: 'Invalid payload: items array required' });
    }

    const items = body.items;
    const processed_items: BatchSyncResponse['processed_items'] = [];

    // Helper to safely parse JSON
    const safeParse = (value: any) => {
      if (typeof value !== 'string') return { ok: true, data: value };
      try {
        return { ok: true, data: JSON.parse(value) };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    };

    // Normalize task object returned from TaskService to ensure ISO timestamps and ids
    const normalizeTask = (t: any) => {
      if (!t || typeof t !== 'object') return t;
      const out: any = { ...t };

      // server id preference: server_id then id
      out.id = out.id ?? out.server_id ?? out._id ?? out.task_id ?? out.id;
      // Ensure server_id is present separately if available
      out.server_id = out.server_id ?? out.id ?? undefined;

      // Normalize timestamps to ISO strings if possible
      for (const tsKey of ['created_at', 'createdAt', 'updated_at', 'updatedAt', 'last_synced_at']) {
        if (out[tsKey]) {
          const d = new Date(out[tsKey]);
          if (!isNaN(d.getTime())) out[tsKey] = d.toISOString();
          else out[tsKey] = String(out[tsKey]);
        }
      }
      // also standardize keys to created_at and updated_at if camelCase provided
      if (out.createdAt && !out.created_at) out.created_at = out.createdAt;
      if (out.updatedAt && !out.updated_at) out.updated_at = out.updatedAt;

      return out;
    };

    for (const it of items) {
      const clientId: string = it.id ?? it.client_id ?? '';
      const taskId: string = it.task_id ?? '';
      const operation: string = it.operation ?? '';

      const parsed = safeParse(it.data);
      if (!parsed.ok) {
        processed_items.push({
          client_id: clientId,
          server_id: '',
          status: 'error',
          error: `Invalid JSON in data: ${parsed.error}`,
        });
        continue;
      }

      const data = parsed.data;

      try {
        if (operation === 'create') {
          // Ensure we pass id if provided by client
          const payload = { ...(data || {}), id: data?.id || taskId || undefined };
          const created = await taskService.createTask(payload);

          const normalized = normalizeTask(created);
          const serverId = String(normalized?.server_id ?? normalized?.id ?? '');

          processed_items.push({
            client_id: clientId,
            server_id: serverId,
            status: 'success',
            resolved_data: normalized || undefined,
          });
        } else if (operation === 'update') {
          const updated = await taskService.updateTask(taskId, data || {});
          const normalized = normalizeTask(updated);
          const serverId = String(normalized?.server_id ?? normalized?.id ?? '');

          processed_items.push({
            client_id: clientId,
            server_id: serverId,
            status: 'success',
            resolved_data: normalized || undefined,
          });
        } else if (operation === 'delete') {
          await taskService.deleteTask(taskId);
          processed_items.push({
            client_id: clientId,
            server_id: String(taskId || ''),
            status: 'success',
          });
        } else {
          processed_items.push({
            client_id: clientId,
            server_id: '',
            status: 'error',
            error: `Unknown operation: ${operation}`,
          });
        }
      } catch (itemErr: any) {
        console.error('Batch item failed:', itemErr);
        processed_items.push({
          client_id: clientId,
          server_id: '',
          status: 'error',
          error: itemErr?.message || String(itemErr),
        });
      }
    }

    return res.json({ processed_items });
  } catch (err: any) {
    console.error('POST /batch error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});


  // Health check used by SyncService.checkConnectivity()
  router.get('/health', async (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}
