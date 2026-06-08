import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceReport,
  parseWorkerResult,
  workerResultSummary,
} from '../src/api/worker-result.js';

function resultBlock(): string {
  return [
    'Done.',
    '',
    '```json METABOT_WORKER_RESULT',
    '{',
    '  "summary": "implemented p0-p1",',
    '  "actionsTaken": ["edited files"],',
    '  "commands": ["npm test"],',
    '  "files": ["src/index.ts"],',
    '  "artifacts": [{"path":"artifacts/report.json","type":"report","description":"audit","sha256":"abc"}],',
    '  "verification": [{"command":"npm test","status":"passed","details":"ok"}],',
    '  "risks": ["none"],',
    '  "nextAction": "review"',
    '}',
    '```',
  ].join('\n');
}

describe('worker result parser', () => {
  it('parses the fenced worker result block', () => {
    const parsed = parseWorkerResult(resultBlock());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.summary).toBe('implemented p0-p1');
    expect(parsed.result.artifacts[0]).toMatchObject({
      path: 'artifacts/report.json',
      sha256: 'abc',
    });
    expect(workerResultSummary(parsed.result)).toMatchObject({
      summary: 'implemented p0-p1',
      nextAction: 'review',
    });
  });

  it('reports missing or malformed result blocks explicitly', () => {
    expect(parseWorkerResult('plain text')).toEqual({
      ok: false,
      error: 'METABOT_WORKER_RESULT block not found',
    });
    expect(parseWorkerResult('METABOT_WORKER_RESULT {bad json').ok).toBe(false);
  });

  it('rejects result blocks that omit required trace fields', () => {
    const parsed = parseWorkerResult([
      'Done.',
      '',
      '```json METABOT_WORKER_RESULT',
      '{',
      '  "summary": "done",',
      '  "actionsTaken": [],',
      '  "commands": [],',
      '  "files": [],',
      '  "artifacts": [],',
      '  "risks": []',
      '}',
      '```',
    ].join('\n'));

    expect(parsed).toEqual({
      ok: false,
      error: 'METABOT_WORKER_RESULT.verification must be an array',
    });
  });

  it('builds an acceptance report without pretending deterministic verification', () => {
    const parsed = parseWorkerResult(resultBlock());
    const report = buildAcceptanceReport(['tests pass'], parsed);

    expect(report).toMatchObject({
      status: 'worker_reported',
      criteria: [{ criterion: 'tests pass', status: 'not_deterministically_verified' }],
      workerSummary: 'implemented p0-p1',
    });
  });
});
