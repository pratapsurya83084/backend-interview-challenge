export interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  created_at: Date;
  updated_at: Date;
  is_deleted: boolean;
  sync_status?: 'pending' | 'synced' | 'error';
  server_id?: string;
  last_synced_at?: Date;
}

export interface SyncQueueItem {
  id: string;
  task_id: string;
  operation: 'create' | 'update' | 'delete';
  data: Partial<Task>;
  created_at: Date;
  retry_count: number;
  error_message?: string;
}

export interface SyncResult {
  success: boolean;
  synced_items: number;
  failed_items: number;
  errors: SyncError[];
}

export interface SyncError {
  task_id: string;
  operation: string;
  error: string;
  timestamp: Date;
}

export interface ConflictResolution {
  strategy: 'last-write-wins' | 'client-wins' | 'server-wins';
  resolved_task: Task;
}

export interface BatchSyncRequest {
  items: SyncQueueItem[];
  client_timestamp: Date;
}

export interface BatchSyncResponse {
  results: any;
  processed_items: {
    client_id: string;
    server_id: string;
    status: 'success' | 'conflict' | 'error';
    resolved_data?: Task;
    error?: string;
  }[];
}