import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotStatus } from '../../store';
import { useStore } from '../../store';
import type { ManagerTask, ManagerTaskEvent, ManagerTaskSummary } from '../../types';
import { ManagerTaskActions, type ManagerTaskAction } from './ManagerTaskActions';
import { ManagerWorkLog } from './ManagerWorkLog';
import s from './ManagerTasksPanel.module.css';

const TASK_LIMIT = 12;
const EVENT_LIMIT = 20;
const POLL_MS = 5000;
const EVENT_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Result', value: 'worker_result' },
  { label: 'Budget', value: 'delegation_budget' },
  { label: 'Checkpoint', value: 'checkpoint' },
  { label: 'Update', value: 'worker_update' },
  { label: 'Failed', value: 'failed' },
  { label: 'Retry', value: 'retry_scheduled' },
  { label: 'Cancelled', value: 'cancel_confirmed' },
  { label: 'Cancel Fail', value: 'cancel_failed_to_stop' },
  { label: 'Blocked', value: 'action_gate_blocked' },
  { label: 'Notify', value: 'manager_notification_failed' },
] as const;

type EventFilter = (typeof EVENT_FILTERS)[number]['value'];

interface Props {
  bot: BotStatus;
}

export function ManagerTasksPanel({ bot }: Props) {
  const token = useStore((st) => st.token);
  const [tasks, setTasks] = useState<ManagerTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<ManagerTaskEvent[]>([]);
  const [summary, setSummary] = useState<ManagerTaskSummary | undefined>();
  const [eventFilter, setEventFilter] = useState<EventFilter>('');
  const [loading, setLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [eventsError, setEventsError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const activeBotRef = useRef(bot.name);
  const activeTaskRef = useRef<string | null>(null);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedId) ?? tasks[0], [tasks, selectedId]);
  const selectedTaskId = selectedTask?.id ?? null;

  const loadTasks = useCallback(async () => {
    if (!token || !bot.managerEnabled) return;
    const requestBotName = bot.name;
    setLoading(true);
    try {
      const params = new URLSearchParams({ managerBotName: requestBotName, limit: String(TASK_LIMIT) });
      const res = await fetch(`/api/manager/tasks/recent?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await responseError(res));
      const data = await res.json() as { tasks?: ManagerTask[] };
      const nextTasks = Array.isArray(data.tasks) ? data.tasks : [];
      if (activeBotRef.current !== requestBotName) return;
      setTasks(nextTasks);
      setSelectedId((current) => current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id ?? null);
      setError('');
    } catch (err) {
      if (activeBotRef.current !== requestBotName) return;
      setError(err instanceof Error ? err.message : 'Failed to load manager tasks');
    } finally {
      if (activeBotRef.current === requestBotName) setLoading(false);
    }
  }, [bot.managerEnabled, bot.name, token]);

  const loadEvents = useCallback(async (task: ManagerTask, filter: EventFilter) => {
    if (!token) return;
    const requestTaskId = task.id;
    setEventsLoading(true);
    try {
      const params = new URLSearchParams({
        managerBotName: task.managerBotName,
        managerChatId: task.managerChatId,
        limit: String(EVENT_LIMIT),
        payload: 'preview',
      });
      if (filter) params.set('type', filter);
      const res = await fetch(`/api/manager/tasks/${encodeURIComponent(task.id)}/events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await responseError(res));
      const data = await res.json() as { events?: ManagerTaskEvent[] };
      if (activeTaskRef.current !== requestTaskId) return;
      setEvents(Array.isArray(data.events) ? data.events : []);
      setEventsError('');
    } catch (err) {
      if (activeTaskRef.current !== requestTaskId) return;
      setEventsError(err instanceof Error ? err.message : 'Failed to load task events');
    } finally {
      if (activeTaskRef.current === requestTaskId) setEventsLoading(false);
    }
  }, [token]);

  const loadSummary = useCallback(async (task: ManagerTask) => {
    if (!token) return;
    const requestTaskId = task.id;
    setSummaryLoading(true);
    try {
      const params = new URLSearchParams({
        managerBotName: task.managerBotName,
        managerChatId: task.managerChatId,
      });
      const res = await fetch(`/api/manager/tasks/${encodeURIComponent(task.id)}/summary?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await responseError(res));
      const data = await res.json() as { summary?: ManagerTaskSummary };
      if (activeTaskRef.current !== requestTaskId) return;
      setSummary(data.summary);
      setSummaryError('');
    } catch (err) {
      if (activeTaskRef.current !== requestTaskId) return;
      setSummaryError(err instanceof Error ? err.message : 'Failed to load work log');
    } finally {
      if (activeTaskRef.current === requestTaskId) setSummaryLoading(false);
    }
  }, [token]);

  const runTaskAction = useCallback(async (task: ManagerTask, action: ManagerTaskAction) => {
    if (!token) return;
    setActionTaskId(task.id);
    setEventsError('');
    try {
      const endpoint = `/api/manager/tasks/${encodeURIComponent(task.id)}/${action}`;
      const body = actionBody(task, action);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await responseError(res));
      await loadTasks();
      activeTaskRef.current = task.id;
      await loadEvents(task, eventFilter);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : `Failed to ${action} task`);
    } finally {
      setActionTaskId(null);
    }
  }, [eventFilter, loadEvents, loadTasks, token]);

  useEffect(() => {
    activeBotRef.current = bot.name;
    activeTaskRef.current = null;
    setTasks([]);
    setSelectedId(null);
    setEvents([]);
    setSummary(undefined);
    setEventFilter('');
    setError('');
    setEventsError('');
    setSummaryError('');
  }, [bot.name]);

  useEffect(() => {
    if (!bot.managerEnabled) return undefined;
    void loadTasks();
    const id = setInterval(() => { void loadTasks(); }, POLL_MS);
    return () => clearInterval(id);
  }, [bot.managerEnabled, loadTasks]);

  useEffect(() => {
    activeTaskRef.current = selectedTaskId;
    setEvents([]);
    setSummary(undefined);
    setEventsError('');
    setSummaryError('');
    if (selectedTask) {
      void loadEvents(selectedTask, eventFilter);
      void loadSummary(selectedTask);
    }
  }, [eventFilter, loadEvents, loadSummary, selectedTaskId]);

  useEffect(() => {
    if (!selectedTask || !isActiveTask(selectedTask)) return undefined;
    const id = setInterval(() => { void loadEvents(selectedTask, eventFilter); }, POLL_MS);
    return () => clearInterval(id);
  }, [eventFilter, loadEvents, selectedTask]);

  if (!bot.managerEnabled) return null;

  return (
    <section className={s.panel}>
      <div className={s.header}>
        <div>
          <h3 className={s.title}>MetaBot Worker Tasks</h3>
          <span className={s.subtitle}>{tasks.length} recent</span>
        </div>
        <button className={s.iconButton} onClick={() => { void loadTasks(); }} title="Refresh MetaBot worker tasks" aria-label="Refresh MetaBot worker tasks">
          <RefreshIcon />
        </button>
      </div>

      {error && <div className={s.error}>{error}</div>}
      {!error && tasks.length === 0 && (
        <div className={s.empty}>{loading ? 'Loading worker tasks...' : 'No worker tasks'}</div>
      )}

      {tasks.length > 0 && (
        <div className={s.taskList}>
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`${s.taskCard} ${selectedTask?.id === task.id ? s.taskCardActive : ''}`}
              onClick={() => setSelectedId(task.id)}
            >
              <span className={`${s.status} ${s[`status-${task.status}`]}`}>{task.substatus || task.status}</span>
              <span className={s.taskTitle}>{task.label || task.prompt}</span>
              <span className={s.taskMeta}>
                {task.workerBotName} | {shortId(task.managerChatId)} | {shortId(task.id)} | {taskDuration(task)}
              </span>
            </button>
          ))}
        </div>
      )}

      {selectedTask && (
        <div className={s.detail}>
          <div className={s.detailHeader}>
            <div className={s.detailMeta}>
              <code>{selectedTask.traceId}</code>
              <span>{selectedTask.attemptCount}/{selectedTask.maxAttempts} attempts</span>
            </div>
            <ManagerTaskActions
              task={selectedTask}
              disabled={actionTaskId === selectedTask.id}
              onAction={(task, action) => { void runTaskAction(task, action); }}
            />
          </div>
          {selectedTask.workflowId && <div className={s.empty}>Workflow: {selectedTask.workflowId}</div>}
          {selectedTask.nextAttemptAt && <div className={s.empty}>Next retry: {formatTime(selectedTask.nextAttemptAt)}</div>}
          {selectedTask.lastCheckpointPreview && (
            <pre className={s.payload}>{payloadPreview({ preview: selectedTask.lastCheckpointPreview })}</pre>
          )}
          {selectedTask.error && <div className={s.error}>{selectedTask.error}</div>}
          <ManagerWorkLog summary={summary} loading={summaryLoading} error={summaryError} />
          <div className={s.filters}>
            {EVENT_FILTERS.map((filter) => (
              <button
                key={filter.value || 'all'}
                className={`${s.filterButton} ${eventFilter === filter.value ? s.filterButtonActive : ''}`}
                onClick={() => setEventFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {eventsError && <div className={s.error}>{eventsError}</div>}
          {!eventsError && eventsLoading && <div className={s.empty}>Loading events...</div>}
          {!eventsError && !eventsLoading && events.length === 0 && <div className={s.empty}>No events</div>}
          {!eventsError && events.length > 0 && (
            <div className={s.eventList}>
              {events.map((event) => (
                <div key={event.id} className={s.eventRow}>
                  <div className={s.eventHead}>
                    <span className={s.eventType}>{event.type}</span>
                    <time>{formatTime(event.createdAt)}</time>
                  </div>
                  {event.payload && <pre className={s.payload}>{payloadPreview(event.payload)}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

async function responseError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error || `HTTP ${res.status}`;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function actionBody(task: ManagerTask, action: ManagerTaskAction): Record<string, string> {
  const scope = { managerBotName: task.managerBotName, managerChatId: task.managerChatId };
  if (action === 'resume') return scope;
  return { ...scope, reason: 'Cancelled from web dashboard' };
}

function isActiveTask(task: ManagerTask): boolean {
  return task.status === 'queued' || task.status === 'running';
}

function taskDuration(task: ManagerTask): string {
  if (task.durationMs != null) return formatDuration(task.durationMs);
  const started = task.startedAt ? Date.parse(task.startedAt) : Date.parse(task.createdAt);
  return formatDuration(Math.max(0, Date.now() - started));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function payloadPreview(payload: Record<string, unknown>): string {
  const source = typeof payload.preview === 'string' ? payload.preview : JSON.stringify(payload, null, 2);
  return source.length > 700 ? `${source.slice(0, 700)}...` : source;
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 1-15.5 6.2" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8" />
      <path d="M18 2v4h4" />
      <path d="M6 22v-4H2" />
    </svg>
  );
}
