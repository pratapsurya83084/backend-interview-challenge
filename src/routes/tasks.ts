import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Get all tasks
  router.get('/getall-task', async (req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
  router.post('/create-task', async (req: Request, res: Response) => {
    console.log('POST /api/tasks/create-task hit', req.body);
    const { title, description } = req.body ?? {};
    if (!title || typeof title !== 'string') {
      return res
        .status(400)
        .json({ error: 'title is required and must be a string' });
    }

    try {
      const created = await taskService.createTask({ title, description });
      // exact response shape with ISO strings for dates
      return res.status(201).json({
        id: created.id,
        title: created.title,
        description: created.description ?? '',
        completed: created.completed,
        created_at: created.created_at.toISOString(),
        updated_at: created.updated_at.toISOString(),
        is_deleted: created.is_deleted,
        sync_status: created.sync_status ?? 'pending',
        server_id: created.server_id ?? null,
        last_synced_at: created.last_synced_at ? created.last_synced_at.toISOString() : null,
      });
    } catch (err) {
      console.error('Error creating task:', err);
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Update task
router.put('/update/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, description, completed } = req.body ?? {};

  // 1. Basic validation
  if (!id) {
    return res.status(400).json({ error: 'Task id is required in URL' });
  }

  if (title !== undefined && typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }

  if (description !== undefined && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }

  if (completed !== undefined && typeof completed !== 'boolean') {
    return res.status(400).json({ error: 'completed must be a boolean' });
  }

  // Build updates object only with provided fields
  const updates: Partial<Record<string, any>> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (completed !== undefined) updates.completed = completed;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  try {
    // 2. Call service to update
    const updated = await taskService.updateTask(id, updates as any);

    // 3. Handle not found
    if (!updated) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // 4. Return updated task (convert Date fields to ISO strings)
    return res.status(200).json({
      id: updated.id,
      title: updated.title,
      description: updated.description ?? '',
      completed: updated.completed,
      created_at: updated.created_at instanceof Date ? updated.created_at.toISOString() : updated.created_at,
      updated_at: updated.updated_at instanceof Date ? updated.updated_at.toISOString() : updated.updated_at,
      is_deleted: updated.is_deleted,
      sync_status: updated.sync_status ?? 'pending',
      server_id: updated.server_id ?? null,
      last_synced_at: updated.last_synced_at ? (updated.last_synced_at instanceof Date ? updated.last_synced_at.toISOString() : updated.last_synced_at) : null,
    });
  } catch (err) {
    console.error('Error updating task:', err);
    return res.status(500).json({ error: 'Failed to update task' });
  }
});


  // Delete task
router.delete('/delete/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'Task ID is required' });
    }

    const deleted = await taskService.deleteTask(id);

    if (!deleted) {
      return res.status(204).json({ message: 'Task not found or already deleted' });
    }

    return res.status(200).json({
      message: 'Task deleted successfully ',
      id,
      deleted: true,
    });
  } catch (error) {
    console.error(' Error deleting task:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});



//need - sync
router.get('/need-sync', async (req: Request, res: Response) => {
  try {
    const tasks = await taskService.getTasksNeedingSync();

    if (!tasks || tasks.length === 0) {
      return res.status(404).json({ message: 'No tasks needing sync' });
    }

    res.status(200).json({
      message: 'Tasks needing sync fetched successfully',
      count: tasks.length,
      data: tasks,
    });
  } catch (error: any) {
    console.error('Error fetching tasks needing sync:', error);
    res.status(500).json({ error: 'Failed to fetch tasks needing sync' });
  }
});

  return router;
}
