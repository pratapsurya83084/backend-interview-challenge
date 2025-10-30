// import sqlite3 from 'sqlite3';
// import { promisify } from 'util';
// import { Task, SyncQueueItem } from '../types';

// const sqlite = sqlite3.verbose();

// export class Database {
//   private db: sqlite3.Database;

//   constructor(filename: string = ':memory:') {
//     this.db = new sqlite.Database(filename);
//   }

//   async initialize(): Promise<void> {
//     await this.createTables();
//   }

//   private async createTables(): Promise<void> {
//     const createTasksTable = `
//       CREATE TABLE IF NOT EXISTS tasks (
//         id TEXT PRIMARY KEY,
//         title TEXT NOT NULL,
//         description TEXT,
//         completed INTEGER DEFAULT 0,
//         created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//         is_deleted INTEGER DEFAULT 0,
//         sync_status TEXT DEFAULT 'pending',
//         server_id TEXT,
//         last_synced_at DATETIME
//       )
//     `;

//     const createSyncQueueTable = `
//       CREATE TABLE IF NOT EXISTS sync_queue (
//         id TEXT PRIMARY KEY,
//         task_id TEXT NOT NULL,
//         operation TEXT NOT NULL,
//         data TEXT NOT NULL,
//         created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//         retry_count INTEGER DEFAULT 0,
//         error_message TEXT,
//         FOREIGN KEY (task_id) REFERENCES tasks(id)
//       )
//     `;

//     await this.run(createTasksTable);
//     await this.run(createSyncQueueTable);
//   }

//   // Helper methods
//   run(sql: string, params: any[] = [], p0: (err: Error | null) => void): Promise<void> {
//     return new Promise((resolve, reject) => {
//       this.db.run(sql, params, (err) => {
//         if (err) reject(err);
//         else resolve();
//       });
//     });
//   }

//   get(sql: string, params: any[] = []): Promise<any> {
//     return new Promise((resolve, reject) => {
//       this.db.get(sql, params, (err, row) => {
//         if (err) reject(err);
//         else resolve(row);
//       });
//     });
//   }

//   all(sql: string, params: any[] = []): Promise<any[]> {
//     return new Promise((resolve, reject) => {
//       this.db.all(sql, params, (err, rows) => {
//         if (err) reject(err);
//         else resolve(rows);
//       });
//     });
//   }

//   close(): Promise<void> {
//     return new Promise((resolve, reject) => {
//       this.db.close((err) => {
//         if (err) reject(err);
//         else resolve();
//       });
//     });
//   }
// }



// db/database.ts
import sqlite3 from 'sqlite3';
import path from 'path';
import { Task, SyncQueueItem } from '../types';

const sqlite = sqlite3.verbose();

/**
 * Small sqlite wrapper that exposes Promise-friendly methods.
 * - run() resolves with { lastID, changes }
 * - get() resolves with a single row or undefined
 * - all() resolves with row array
 */
export class Database {


 async getLastSyncedAt(): Promise<Date | null> {
    const row = await this.get<{ last_synced_at: string }>(`SELECT last_synced_at FROM tasks WHERE last_synced_at IS NOT NULL ORDER BY last_synced_at DESC LIMIT 1`);
    if (!row || !row.last_synced_at) return null;
    return new Date(row.last_synced_at);
  }

  /**
   * Count pending items in sync_queue.
   */
  async countPendingSyncQueueItems(): Promise<number> {
    const row = await this.get<{ c: number }>(`SELECT COUNT(*) as c FROM sync_queue`);
    return row?.c ?? 0;
  }

  /**
   * Soft-delete a task (mark is_deleted = 1) and update timestamps.
   */
  async deleteTask(taskId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      `UPDATE tasks SET is_deleted = 1, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      [now, taskId]
    );
  }

  /**
   * Insert a task. If the task id already exists, do an upsert using INSERT OR REPLACE pattern.
   */
  async insertTask(newTask: Task): Promise<void> {
    // Use INSERT OR REPLACE to upsert (so caller can call insertTask safely)
    const stmt = `
      INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        completed = excluded.completed,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted,
        sync_status = excluded.sync_status,
        server_id = excluded.server_id,
        last_synced_at = excluded.last_synced_at;
    `;

    await this.run(stmt, [
      newTask.id,
      newTask.title,
      newTask.description ?? null,
      newTask.completed ? 1 : 0,
      (newTask.created_at ?? new Date()).toISOString(),
      (newTask.updated_at ?? new Date()).toISOString(),
      newTask.is_deleted ? 1 : 0,
      newTask.sync_status ?? null,
      newTask.server_id ?? null,
      newTask.last_synced_at ? newTask.last_synced_at.toISOString() : null,
    ]);
  }

  /**
   * Find all sync queue items for a given task id.
   */
  async findSyncQueueItemsByTaskId(taskId: string): Promise<SyncQueueItem[]> {
    const rows = await this.all<any>(`SELECT * FROM sync_queue WHERE task_id = ? ORDER BY created_at ASC`, [taskId]);
    return rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      operation: r.operation,
      data: JSON.parse(r.data ?? '{}'),
      created_at: r.created_at ? new Date(r.created_at) : new Date(),
      retry_count: r.retry_count ?? 0,
      error_message: r.error_message ?? undefined,
    })) as SyncQueueItem[];
  }

  /**
   * Delete a sync queue item (meta param accepted for compatibility).
   */
  async deleteSyncQueueItem(id: string, _meta: { retry_count: number; error_message: string }): Promise<void> {
    await this.run(`DELETE FROM sync_queue WHERE id = ?`, [id]);
  }

  /**
   * Update a task. Accepts either a complete object or partial fields.
   * We'll merge with existing row (if present) to avoid inserting undefined dates.
   */
  async updateTask(
    task_id: string,
    arg1: { title: string; description: string | undefined; completed: boolean; created_at: Date; updated_at: Date; is_deleted: boolean; server_id: string | undefined; sync_status: string; last_synced_at: Date; } | Partial<Task>
  ): Promise<void> {
    const existingRow = await this.get<any>(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [task_id]);

    const existing: Partial<Task> = existingRow
      ? {
          id: existingRow.id,
          title: existingRow.title,
          description: existingRow.description ?? undefined,
          completed: !!existingRow.completed,
          created_at: existingRow.created_at ? new Date(existingRow.created_at) : new Date(),
          updated_at: existingRow.updated_at ? new Date(existingRow.updated_at) : new Date(),
          is_deleted: !!existingRow.is_deleted,
          server_id: existingRow.server_id ?? undefined,
          sync_status: existingRow.sync_status ?? undefined,
          last_synced_at: existingRow.last_synced_at ? new Date(existingRow.last_synced_at) : undefined,
        }
      : {};

    const updates = { ...(existing as any), ...(arg1 as any) } as Partial<Task>;

    // Ensure required date fields are present
    const createdAt = updates.created_at ? (updates.created_at as Date) : new Date();
    const updatedAt = updates.updated_at ? (updates.updated_at as Date) : new Date();

    const stmt = `
      INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        completed = excluded.completed,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted,
        sync_status = excluded.sync_status,
        server_id = excluded.server_id,
        last_synced_at = excluded.last_synced_at;
    `;

    await this.run(stmt, [
      task_id,
      updates.title ?? 'Untitled',
      updates.description ?? null,
      updates.completed ? 1 : 0,
      createdAt.toISOString(),
      updatedAt.toISOString(),
      updates.is_deleted ? 1 : 0,
      updates.sync_status ?? null,
      updates.server_id ?? null,
      updates.last_synced_at ? (updates.last_synced_at as Date).toISOString() : null,
    ]);
  }

  /**
   * Get a single task by id. Returns null when not found.
   */
  async getTaskById(task_id: string): Promise<Task | null> {
    const row = await this.get<any>(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [task_id]);
    if (!row) return null;

    const t: Task = {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      completed: !!row.completed,
      created_at: row.created_at ? new Date(row.created_at) : new Date(),
      updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
      is_deleted: !!row.is_deleted,
      server_id: row.server_id ?? undefined,
      sync_status: (row.sync_status as any) ?? undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    };
    return t;
  }

  /**
   * Return all sync queue items (ordered by created_at asc).
   */
  async getAllSyncQueueItems(): Promise<SyncQueueItem[]> {
    const rows = await this.all<any>(`SELECT * FROM sync_queue ORDER BY created_at ASC`);
    return rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      operation: r.operation,
      data: JSON.parse(r.data ?? '{}'),
      created_at: r.created_at ? new Date(r.created_at) : new Date(),
      retry_count: r.retry_count ?? 0,
      error_message: r.error_message ?? undefined,
    })) as SyncQueueItem[];
  }

  /**
   * Insert a sync queue item.
   */
  async insertSyncQueueItem(item: SyncQueueItem): Promise<void> {
    await this.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.task_id,
        item.operation,
        JSON.stringify(item.data ?? {}),
        (item.created_at ?? new Date()).toISOString(),
        item.retry_count ?? 0,
        item.error_message ?? null,
      ]
    );
  }






  private db: sqlite3.Database;

  constructor(filename: string = path.join(__dirname, '../data/tasks.sqlite3')) {
    this.db = new sqlite.Database(filename);
  }

  async initialize(): Promise<void> {
    await this.createTables();
  }

  private async createTables(): Promise<void> {
    const createTasksTable = `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        completed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_deleted INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        server_id TEXT,
        last_synced_at DATETIME
      );
    `;

    const createSyncQueueTable = `
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
    `;

    await this.run(createTasksTable);
    await this.run(createSyncQueueTable);
  }

  /**
   * Run an SQL statement. Resolves with info { lastID, changes }.
   */
  run(sql: string, params: any[] = [], _cb?: (err: Error | null) => void): Promise<{ lastID?: number; changes?: number }> {
    return new Promise((resolve, reject) => {
      // Use function() to get sqlite's `this` (lastID / changes)
      (this.db as any).run(sql, params, function (this: any, err: Error | null) {
        if (err) {
          if (typeof _cb === 'function') _cb(err);
          return reject(err);
        }
        if (typeof _cb === 'function') _cb(null);
        resolve({ lastID: this?.lastID, changes: this?.changes });
      });
    });
  }

  get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      (this.db as any).get(sql, params, (err: Error | null, row: any) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      (this.db as any).all(sql, params, (err: Error | null, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err: Error | null) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}
