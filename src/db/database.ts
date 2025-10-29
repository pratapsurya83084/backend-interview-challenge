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
  run(sql: string, params: any[] = [], p0: (err: Error | null) => void): Promise<{ lastID?: number; changes?: number }> {
    return new Promise((resolve, reject) => {
      // Use function() to get sqlite's `this` (lastID / changes)
      (this.db as any).run(sql, params, function (this: any, err: Error | null) {
        if (err) return reject(err);
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
