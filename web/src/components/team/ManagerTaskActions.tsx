import type { ManagerTask } from '../../types';
import s from './ManagerTasksPanel.module.css';

export type ManagerTaskAction = 'cancel' | 'resume';

interface Props {
  task: ManagerTask;
  disabled: boolean;
  onAction: (task: ManagerTask, action: ManagerTaskAction) => void;
}

export function ManagerTaskActions({ task, disabled, onAction }: Props) {
  const canCancel = task.availableActions?.includes('cancel') ?? canCancelTask(task);
  const canResume = task.availableActions?.includes('resume') ?? canResumeTask(task);
  if (!canCancel && !canResume) return null;
  return (
    <div className={s.actions}>
      {canCancel && (
        <button
          type="button"
          className={s.actionButton}
          disabled={disabled}
          onClick={() => onAction(task, 'cancel')}
          title="Cancel worker task"
          aria-label="Cancel worker task"
        >
          <StopIcon />
        </button>
      )}
      {canResume && (
        <button
          type="button"
          className={s.actionButton}
          disabled={disabled}
          onClick={() => onAction(task, 'resume')}
          title="Resume worker task"
          aria-label="Resume worker task"
        >
          <PlayIcon />
        </button>
      )}
    </div>
  );
}

function canCancelTask(task: ManagerTask): boolean {
  return task.status === 'queued' || task.status === 'running';
}

function canResumeTask(task: ManagerTask): boolean {
  return task.status === 'failed';
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
