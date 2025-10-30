import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';
import { response } from 'express';

export class TaskService {
  constructor(private db: Database) {}

  // 1. Generate UUID for the task
  // 2. Set default values
  // 3. Set sync_status to 'pending'
  // 4. Insert into database
  // 5. Add to sync queue

  //done
  // async createTask(taskData: Partial<Task>): Promise<Task> {
  //   try {
  //     // 1. Generate UUID for the task
  //     const id = uuidv4();
  //     const now = new Date();

  //     const task: Task = {
  //       id,
  //       title: taskData.title ?? '',
  //       description: taskData.description ?? '',
  //       completed: false,
  //       created_at: now,
  //       updated_at: now,
  //       is_deleted: false,
  //       sync_status: 'pending',
  //       server_id: null as any,
  //       last_synced_at: now,
  //     };

  //     console.log("iinserting task into DB:", task);

  //     const insertSql = `
  //     INSERT INTO tasks (
  //       id, title, description, completed, created_at, updated_at,
  //       is_deleted, sync_status, server_id, last_synced_at
  //     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  //   `;

  //     await new Promise<void>((resolve, reject) => {
  //       this.db.run(
  //         insertSql,
  //         [
  //           task.id,
  //           task.title,
  //           task.description,
  //           task.completed ? 1 : 0,
  //           task.created_at.toISOString(),
  //           task.updated_at.toISOString(),
  //           task.is_deleted ? 1 : 0,
  //           task.sync_status,
  //           task.server_id ?? null,
  //           task.last_synced_at ? task.last_synced_at.toISOString() : null,
  //         ],
  //         (err: Error | null) => {
  //           if (err) {
  //             console.error('❌ DB insert failed:', err);
  //             reject(err);
  //           } else {
  //             console.log('✅ DB insert success:', task.id);
  //             resolve();
  //           }
  //         },
  //       );
  //     });

  //     // // Add to sync queue
  //     const syncSql = `
  //     INSERT INTO sync_queue (task_id, status, created_at)
  //     VALUES (?, ?, ?)
  //   `;
  //     await new Promise<void>((resolve, reject) => {
  //       this.db.run(
  //         syncSql,
  //         [task.id, 'pending', now.toISOString()],
  //         (err: Error | null) => {
  //           if (err) reject(err);
  //           else resolve();
  //         },
  //       );
  //     });

  //     return task;

  //   } catch (err) {
  //     console.error('🔥 Error in createTask:', err);
  //     throw err;
  //   }
  // }


// Replace your existing createTask with this
async createTask(taskData: Partial<Task>): Promise<Task> {
  try {
    // 1. Generate UUID for the task
    const id = uuidv4();
    const now = new Date();

    const task: Task = {
      id,
      title: taskData.title ?? '',
      description: taskData.description ?? '',
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
      server_id: null as any,
      last_synced_at: now,
    };

    console.log('iinserting task into DB:', task);

    const insertSql = `
      INSERT INTO tasks (
        id, title, description, completed, created_at, updated_at,
        is_deleted, sync_status, server_id, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await new Promise<void>((resolve, reject) => {
      this.db.run(
        insertSql,
        [
          task.id,
          task.title,
          task.description,
          task.completed ? 1 : 0,
          task.created_at.toISOString(),
          task.updated_at.toISOString(),
          task.is_deleted ? 1 : 0,
          task.sync_status,
          task.server_id ?? null,
          task.last_synced_at ? task.last_synced_at.toISOString() : null,
        ],
        (err: Error | null) => {
          if (err) {
            console.error('❌ DB insert failed:', err);
            return reject(err);
          }
          console.log('✅ DB insert success:', task.id);
          resolve();
        },
      );
    });

    // Enqueue sync job — provide all required columns (id, task_id, operation, data, status, created_at, retry_count, error_message)
    const syncQueueId = uuidv4();
    const syncSql = `
      INSERT INTO sync_queue (
        id, task_id, operation, data, status, created_at, retry_count, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      await new Promise<void>((resolve, reject) => {
        this.db.run(
          syncSql,
          [
            syncQueueId,
            task.id,
            'create',               // operation (NOT NULL)
            JSON.stringify({}),     // data (NOT NULL)
            'pending',              // status
            now.toISOString(),      // created_at
            0,                      // retry_count
            null                    // error_message
          ],
          (err: Error | null) => {
            if (err) {
              console.warn('⚠️ Warning: sync_queue insert failed:', err);
              return reject(err);
            }
            console.log('✅ Enqueued sync job:', syncQueueId);
            resolve();
          },
        );
      });
    } catch (err) {
      // IMPORTANT: don't rethrow — task creation succeeded; enqueue failed due to schema or other issue.
      console.error('⚠️ Sync queue enqueue failed (continuing):', err);
      // Optionally persist the failure to a fallback table or monitoring system here.
    }

    return task;
  } catch (err) {
    console.error('🔥 Error in createTask:', err);
    throw err;
  }
}


  //done
  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    // TODO: Implement task update
    // 1. Check if task exists
    // 2. Update task in database
    // 3. Update updated_at timestamp
    // 4. Set sync_status to 'pending'
    // 5. Add to sync queue
    try {
      if (!id) throw new Error('Invalid id');

      // 1) Check if task exists and is not deleted
      const selectSql = `SELECT * FROM tasks WHERE id = ? LIMIT 1`;
      let existingRow: any;
      if (typeof (this.db as any).get === 'function') {
        existingRow = await (this.db as any).get(selectSql, [id]);
      } else {
        existingRow = await new Promise<any>((resolve, reject) => {
          (this.db as any).db.get(
            selectSql,
            [id],
            (err: Error | null, row: any) => {
              if (err) return reject(err);
              resolve(row);
            },
          );
        });
      }

      if (!existingRow) {
        // not found
        return null;
      }
      if (existingRow.is_deleted && Number(existingRow.is_deleted) === 1) {
        // soft-deleted, treat as not found
        return null;
      }

      // 2) Build update statement dynamically from provided fields
      const allowedFields: Array<keyof Task> = [
        'title',
        'description',
        'completed',
      ];
      const setParts: string[] = [];
      const params: any[] = [];

      for (const key of allowedFields) {
        if (key in updates && updates[key] !== undefined) {
          if (key === 'completed') {
            setParts.push(`completed = ?`);
            params.push(updates.completed ? 1 : 0);
          } else if (key === 'title') {
            setParts.push(`title = ?`);
            params.push(updates.title);
          } else if (key === 'description') {
            setParts.push(`description = ?`);
            params.push(updates.description ?? '');
          }
        }
      }

      // If no updatable fields provided, just return the existing task (or you can treat as error)
      if (setParts.length === 0) {
        // Convert existingRow to Task and return
        const existingTask: Task = {
          id: existingRow.id,
          title: existingRow.title,
          description: existingRow.description ?? '',
          completed: Boolean(existingRow.completed),
          created_at: new Date(existingRow.created_at),
          updated_at: new Date(existingRow.updated_at),
          is_deleted: Boolean(existingRow.is_deleted),
          sync_status: existingRow.sync_status as
            | 'pending'
            | 'synced'
            | 'error',
          server_id: existingRow.server_id ?? undefined,
          last_synced_at: existingRow.last_synced_at
            ? new Date(existingRow.last_synced_at)
            : undefined,
        };
        return existingTask;
      }

      // 3) Update updated_at and 4) set sync_status to 'pending'
      const now = new Date();
      setParts.push(`updated_at = ?`);
      params.push(now.toISOString());

      setParts.push(`sync_status = ?`);
      params.push('pending');

      const updateSql = `UPDATE tasks SET ${setParts.join(', ')} WHERE id = ?`;
      params.push(id); // id as last param

      // Execute update (use promise-style run if available)
      if (typeof (this.db as any).run === 'function') {
        await (this.db as any).run(updateSql, params);
      } else {
        await new Promise<void>((resolve, reject) => {
          (this.db as any).db.run(
            updateSql,
            params,
            function (err: Error | null) {
              if (err) return reject(err);
              resolve();
            },
          );
        });
      }

      // 5) Add to sync queue (enqueue update)
      const queueId = uuidv4();
      const payload = JSON.stringify({
        id,
        ...Object.fromEntries(
          Object.entries(updates).filter(([k, v]) => v !== undefined),
        ),
      });

      const insertQueueSql = `
      INSERT INTO sync_queue (id, task_id, operation, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `;
      const queueParams = [queueId, id, 'update', payload, now.toISOString()];

      if (typeof (this.db as any).run === 'function') {
        await (this.db as any).run(insertQueueSql, queueParams);
      } else {
        await new Promise<void>((resolve, reject) => {
          (this.db as any).db.run(
            insertQueueSql,
            queueParams,
            function (err: Error | null) {
              if (err) return reject(err);
              resolve();
            },
          );
        });
      }

      // Fetch the updated row to return
      const rowAfter: any = await (typeof (this.db as any).get === 'function'
        ? (this.db as any).get(selectSql, [id])
        : new Promise<any>((resolve, reject) => {
            (this.db as any).db.get(
              selectSql,
              [id],
              (err: Error | null, row: any) => {
                if (err) return reject(err);
                resolve(row);
              },
            );
          }));

      if (!rowAfter) {
        return null; // shouldn't happen, but safe-guard
      }

      // Map DB row to Task
      const updatedTask: Task = {
        id: rowAfter.id,
        title: rowAfter.title,
        description: rowAfter.description ?? '',
        completed: Boolean(rowAfter.completed),
        created_at: new Date(rowAfter.created_at),
        updated_at: new Date(rowAfter.updated_at),
        is_deleted: Boolean(rowAfter.is_deleted),
        sync_status: rowAfter.sync_status as 'pending' | 'synced' | 'error',
        server_id: rowAfter.server_id ?? undefined,
        last_synced_at: rowAfter.last_synced_at
          ? new Date(rowAfter.last_synced_at)
          : undefined,
      };

      return updatedTask;
    } catch (err) {
      console.error('🔥 Error in updateTask:', err);
      throw err;
    }
  }

  //done delete task
  async deleteTask(id: string): Promise<boolean> {
    try {
      if (!id) throw new Error('Invalid id');

      const selectSql = `SELECT id, is_deleted FROM tasks WHERE id = ? LIMIT 1`;

      // 1) Fetch row (support both promise-style db.get and callback-style native db)
      let row: any;
      if (typeof (this.db as any).get === 'function') {
        // promise-style wrapper
        row = await (this.db as any).get(selectSql, [id]);
      } else {
        // fallback to native sqlite3 Database instance
        row = await new Promise<any>((resolve, reject) => {
          (this.db as any).db.get(
            selectSql,
            [id],
            (err: Error | null, r: any) => {
              if (err) return reject(err);
              resolve(r);
            },
          );
        });
      }

      if (!row) {
        // not found
        return false;
      }

      if (row.is_deleted && Number(row.is_deleted) === 1) {
        // already deleted
        return false;
      }

      // 2-4) Soft delete: update is_deleted, updated_at, sync_status
      const now = new Date();
      const updateSql = `
      UPDATE tasks
      SET is_deleted = 1,
          updated_at = ?,
          sync_status = 'pending'
      WHERE id = ?
    `;

      if (typeof (this.db as any).run === 'function') {
        // prefer promise-style run
        await (this.db as any).run(updateSql, [now.toISOString(), id]);
      } else {
        // fallback to native .db.run
        await new Promise<void>((resolve, reject) => {
          (this.db as any).db.run(
            updateSql,
            [now.toISOString(), id],
            function (err: Error | null) {
              if (err) return reject(err);
              resolve();
            },
          );
        });
      }

      // 5) Add to sync_queue (enqueue delete operation)
      const queueId = uuidv4();
      const opPayload = JSON.stringify({ id });
      const insertQueueSql = `
      INSERT INTO sync_queue (id, task_id, operation, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `;

      if (typeof (this.db as any).run === 'function') {
        await (this.db as any).run(insertQueueSql, [
          queueId,
          id,
          'delete',
          opPayload,
          now.toISOString(),
        ]);
      } else {
        await new Promise<void>((resolve, reject) => {
          (this.db as any).db.run(
            insertQueueSql,
            [queueId, id, 'delete', opPayload, now.toISOString()],
            function (err: Error | null) {
              if (err) return reject(err);
              resolve();
            },
          );
        });
      }

      console.log(
        ` deleteTask: task ${id} soft-deleted and enqueued (queue id ${queueId})`,
      );
      return true;
    } catch (err) {
      console.error('🔥 Error in deleteTask:', err);
      throw err;
    }
  }

  //done specific get task
  async getTask(id: string): Promise<Task | null> {
    try {
      const query = `
      SELECT 
        id, title, description, completed, created_at, updated_at,
        is_deleted, sync_status, server_id, last_synced_at
      FROM tasks
      WHERE id = ? AND is_deleted = 0
      LIMIT 1
    `;

      const row = await new Promise<any>((resolve, reject) => {
        (this.db as any).db.get(query, [id], (err: Error | null, row: any) => {
          if (err) {
            console.error('❌ DB query failed (getTask):', err);
            reject(err);
          } else {
            resolve(row);
          }
        });
      });

      if (!row) {
        console.log(`⚠️ No task found for id: ${id}`);
        return null;
      }

      // Convert DB row into Task object
      const task: Task = {
        id: row.id,
        title: row.title,
        description: row.description,
        completed: !!row.completed,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        is_deleted: !!row.is_deleted,
        sync_status: row.sync_status ?? 'pending',
        server_id: row.server_id ?? null,
        last_synced_at: row.last_synced_at ?? null,
      };

      return task;
    } catch (err) {
      console.error('🔥 Error in getTask:', err);
      throw err;
    }
  }

  //done all task retrievee
  async getAllTasks(): Promise<Task[]> {
    // TODO: Implement get all non-deleted tasks
    // 1. Query database for all tasks where is_deleted = false
    // 2. Return array of tasks
    try {
      console.log(' Fetching all non-deleted tasks...');

      const query = `
      SELECT 
        id, title, description, completed, created_at, updated_at,
        is_deleted, sync_status, server_id, last_synced_at
      FROM tasks
      WHERE is_deleted = 0
      ORDER BY created_at DESC
    `;

      const rows = await this.db.all(query);

      // Map database rows → Task[]
      const tasks: Task[] = rows.map(
        (row: any): Task => ({
          id: row.id,
          title: row.title,
          description: row.description ?? '',
          completed: Boolean(row.completed),
          created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at),
          is_deleted: Boolean(row.is_deleted),
          sync_status: row.sync_status as 'pending' | 'synced' | 'error',
          server_id: row.server_id ?? undefined,
          last_synced_at: row.last_synced_at
            ? new Date(row.last_synced_at)
            : undefined,
        }),
      );

      console.log(` Retrieved ${tasks.length} tasks`);
      return tasks;
    } catch (error) {
      console.error(' Error fetching tasks:', error);
      throw error;
    }
  }


  
  async getTasksNeedingSync(): Promise<Task[]> {
    // TODO: Get all tasks with sync_status = 'pending' or 'error'
    const query = `
      SELECT *FROM tasks
      WHERE sync_status = 'pending' or 'error'`;
    const rows = await this.db.all(query);

    // Map database rows → Task[]
    const tasks: Task[] = rows.map(
      (row: any): Task => ({
        id: row.id,
        title: row.title,
        description: row.description ?? '',
        completed: Boolean(row.completed),
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        is_deleted: Boolean(row.is_deleted),
        sync_status: row.sync_status as 'pending' | 'synced' | 'error',
        server_id: row.server_id ?? undefined,
        last_synced_at: row.last_synced_at
          ? new Date(row.last_synced_at)
          : undefined,
      }),
    );

    return tasks;
  }
}
