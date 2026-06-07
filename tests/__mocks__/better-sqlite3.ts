type TaskRow = Record<string, any>;
type EventRow = Record<string, any>;
type ActivityRow = Record<string, any>;

interface FakeDbState {
  tasks: TaskRow[];
  events: EventRow[];
  activities: ActivityRow[];
}

const dbs = new Map<string, FakeDbState>();

export default class FakeDatabase {
  private state: FakeDbState;

  constructor(private dbPath: string) {
    let state = dbs.get(dbPath);
    if (!state) {
      state = { tasks: [], events: [], activities: [] };
      dbs.set(dbPath, state);
    }
    this.state = state;
  }

  pragma(): void {}
  exec(): void {}
  close(): void {}

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: any[]) => fn(...args)) as T;
  }

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      run: (...params: any[]) => this.run(normalized, params),
      get: (...params: any[]) => this.get(normalized, params),
      all: (...params: any[]) => this.all(normalized, params),
    };
  }

  private run(sql: string, params: any[]) {
    if (sql.startsWith('INSERT INTO manager_tasks')) {
      const [
        id,
        traceId,
        managerBotName,
        managerChatId,
        workerBotName,
        workerChatId,
        label,
        prompt,
        status,
        createdAt,
        updatedAt,
        attemptCountOrMetadata,
        maxAttempts,
        maybeMetadataJson,
      ] = params;
      const hasRetryColumns = params.length >= 14;
      this.state.tasks.push({
        id,
        trace_id: traceId,
        manager_bot_name: managerBotName,
        manager_chat_id: managerChatId,
        worker_bot_name: workerBotName,
        worker_chat_id: workerChatId,
        label,
        prompt,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
        attempt_count: hasRetryColumns ? attemptCountOrMetadata : 0,
        max_attempts: hasRetryColumns ? maxAttempts : 5,
        next_attempt_at: null,
        last_checkpoint_at: null,
        last_retry_reason: null,
        started_at: null,
        completed_at: null,
        cost_usd: null,
        duration_ms: null,
        result_text: null,
        error: null,
        metadata_json: hasRetryColumns ? maybeMetadataJson : attemptCountOrMetadata,
      });
      return { changes: 1 };
    }

    if (sql.startsWith('INSERT INTO manager_task_events')) {
      const [id, taskId, type, payloadJson, createdAt] = params;
      this.state.events.push({
        id,
        task_id: taskId,
        type,
        payload_json: payloadJson,
        created_at: createdAt,
        rowid: this.state.events.length + 1,
      });
      return { changes: 1 };
    }

    if (sql.startsWith('INSERT INTO activity_events')) {
      const [
        id, type, botName, chatId, userId, prompt, responsePreview,
        costUsd, durationMs, errorMessage, errorCode, errorKind,
        retryable, providerStatus, timestamp,
      ] = params;
      this.state.activities.push({
        id,
        type,
        bot_name: botName,
        chat_id: chatId,
        user_id: userId,
        prompt,
        response_preview: responsePreview,
        cost_usd: costUsd,
        duration_ms: durationMs,
        error_message: errorMessage,
        error_code: errorCode,
        error_kind: errorKind,
        retryable,
        provider_status: providerStatus,
        timestamp,
      });
      return { changes: 1 };
    }

    if (sql.startsWith('DELETE FROM activity_events')) {
      const cutoff = params[0];
      const before = this.state.activities.length;
      this.state.activities = this.state.activities.filter((row) => row.timestamp >= cutoff);
      return { changes: before - this.state.activities.length };
    }

    if (sql.includes("SET status = 'failed'")) {
      const [updatedAt, completedAt, error, retryReasonOrId, maybeId] = params;
      const id = maybeId ?? retryReasonOrId;
      const row = this.state.tasks.find((task) => task.id === id && ['queued', 'running'].includes(task.status));
      if (!row) return { changes: 0 };
      Object.assign(row, {
        status: 'failed',
        updated_at: updatedAt,
        completed_at: completedAt,
        error,
        ...(maybeId ? { last_retry_reason: retryReasonOrId } : {}),
      });
      return { changes: 1 };
    }

    if (sql.includes("SET status = 'queued'")) {
      const [updatedAt, nextAttemptAt, retryReason, id] = params;
      const row = this.state.tasks.find((task) => task.id === id && ['queued', 'running'].includes(task.status));
      if (!row) return { changes: 0 };
      Object.assign(row, {
        status: 'queued',
        updated_at: updatedAt,
        next_attempt_at: nextAttemptAt,
        last_retry_reason: retryReason,
      });
      return { changes: 1 };
    }

    if (sql.startsWith('UPDATE manager_tasks SET')) {
      const id = params[params.length - 1];
      const row = this.state.tasks.find((task) => task.id === id);
      if (!row) return { changes: 0 };
      let i = 0;
      row.updated_at = params[i++];
      if (sql.includes('status = ?')) row.status = params[i++];
      if (sql.includes('started_at = ?')) row.started_at = params[i++];
      if (sql.includes('completed_at = ?')) row.completed_at = params[i++];
      if (sql.includes('cost_usd = ?')) row.cost_usd = params[i++];
      if (sql.includes('duration_ms = ?')) row.duration_ms = params[i++];
      if (sql.includes('result_text = ?')) row.result_text = params[i++];
      if (sql.includes('error = ?')) row.error = params[i++];
      if (sql.includes('attempt_count = ?')) row.attempt_count = params[i++];
      if (sql.includes('max_attempts = ?')) row.max_attempts = params[i++];
      if (sql.includes('next_attempt_at = ?')) row.next_attempt_at = params[i++];
      if (sql.includes('last_checkpoint_at = ?')) row.last_checkpoint_at = params[i++];
      if (sql.includes('last_retry_reason = ?')) row.last_retry_reason = params[i++];
      if (sql.includes('metadata_json = ?')) row.metadata_json = params[i];
      return { changes: 1 };
    }

    return { changes: 0 };
  }

  private get(sql: string, params: any[]) {
    if (sql.startsWith('SELECT * FROM manager_tasks WHERE id = ?')) {
      return this.state.tasks.find((task) => task.id === params[0]);
    }
    return undefined;
  }

  private all(sql: string, params: any[]) {
    if (sql.includes('FROM manager_task_events')) {
      let idx = 0;
      const taskId = params[idx++];
      let rows = this.state.events.filter((event) => event.task_id === taskId);
      if (sql.includes('AND type = ?')) {
        const value = params[idx++];
        rows = rows.filter((event) => event.type === value);
      }
      const limit = params[idx] ?? 200;
      return rows
        .sort((a, b) => (b.created_at - a.created_at) || (b.rowid - a.rowid))
        .slice(0, limit)
        .sort((a, b) => (a.created_at - b.created_at) || (a.rowid - b.rowid));
    }

    if (sql.startsWith('SELECT * FROM activity_events')) {
      let idx = 0;
      let rows = [...this.state.activities];
      if (sql.includes('bot_name = ?')) {
        const value = params[idx++];
        rows = rows.filter((row) => row.bot_name === value);
      }
      if (sql.includes('timestamp > ?')) {
        const value = params[idx++];
        rows = rows.filter((row) => row.timestamp > value);
      }
      const limit = params[idx] ?? 50;
      return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }

    if (sql.includes("status IN ('queued', 'running')")) {
      return this.state.tasks
        .filter((task) => ['queued', 'running'].includes(task.status))
        .sort((a, b) => a.created_at - b.created_at);
    }

    if (sql.includes('FROM manager_tasks')) {
      let idx = 0;
      let rows = [...this.state.tasks];
      if (sql.includes('manager_bot_name = ?')) {
        const value = params[idx++];
        rows = rows.filter((row) => row.manager_bot_name === value);
      }
      if (sql.includes('manager_chat_id = ?')) {
        const value = params[idx++];
        rows = rows.filter((row) => row.manager_chat_id === value);
      }
      if (sql.includes('worker_bot_name = ?')) {
        const value = params[idx++];
        rows = rows.filter((row) => row.worker_bot_name === value);
      }
      if (sql.includes(' AND status = ?')) {
        const value = params[idx++];
        rows = rows.filter((row) => row.status === value);
      }
      const limit = params[idx] ?? 50;
      return rows.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
    }

    return [];
  }
}
