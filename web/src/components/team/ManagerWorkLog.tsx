import type { ManagerTaskSummary } from '../../types';
import s from './ManagerTasksPanel.module.css';

interface Props {
  summary?: ManagerTaskSummary;
  loading: boolean;
  error: string;
}

export function ManagerWorkLog({ summary, loading, error }: Props) {
  if (error) return <div className={s.error}>{error}</div>;
  if (loading) return <div className={s.empty}>Loading work log...</div>;
  if (!summary) return null;

  return (
    <div className={s.workLog}>
      <div className={s.workLogStats}>
        <span>Trace {Math.round(summary.traceCoverage.traceCoverageRate * 100)}%</span>
        <span>{summary.evidence.files.length} files</span>
        <span>{summary.evidence.commands.length} commands</span>
        <span>{summary.verification.performed.length} checks</span>
      </div>
      {summary.traceCoverage.unsupportedClaim && (
        <div className={s.warning}>Unsupported claim present</div>
      )}
      <pre className={s.payload}>{summary.summaryMarkdown}</pre>
    </div>
  );
}
