export type ManagerTracePolicy = 'summary' | 'full';

export const DEFAULT_MANAGER_TRACE_POLICY: ManagerTracePolicy = 'summary';

export interface ManagerTracePolicyMetadata {
  policy: ManagerTracePolicy;
  rawWorkerStream: 'first-event-only' | 'all-events';
  workerUpdates: 'first-and-final-only' | 'all-events';
  checkpoints: 'interval-and-final';
  disableWith: 'METABOT_MANAGER_TRACE_POLICY=full';
}

export class ManagerTraceRecorder {
  private rawMessagesSeen = 0;
  private updatesSeen = 0;

  constructor(private readonly policy: ManagerTracePolicy) {}

  shouldRecordWorkerMessage(): boolean {
    this.rawMessagesSeen++;
    return this.policy === 'full' || this.rawMessagesSeen === 1;
  }

  shouldRecordWorkerUpdate(final: boolean): boolean {
    this.updatesSeen++;
    return this.policy === 'full' || this.updatesSeen === 1 || final;
  }
}

export function resolveManagerTracePolicy(value = process.env.METABOT_MANAGER_TRACE_POLICY): ManagerTracePolicy {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return DEFAULT_MANAGER_TRACE_POLICY;
  if (normalized === 'summary' || normalized === 'full') return normalized;
  throw new Error('METABOT_MANAGER_TRACE_POLICY must be "summary" or "full"');
}

export function managerTracePolicyMetadata(policy: ManagerTracePolicy): ManagerTracePolicyMetadata {
  return {
    policy,
    rawWorkerStream: policy === 'full' ? 'all-events' : 'first-event-only',
    workerUpdates: policy === 'full' ? 'all-events' : 'first-and-final-only',
    checkpoints: 'interval-and-final',
    disableWith: 'METABOT_MANAGER_TRACE_POLICY=full',
  };
}

export function managerTracePolicyFromMetadata(value: unknown): ManagerTracePolicy | undefined {
  return value === 'summary' || value === 'full' ? value : undefined;
}
