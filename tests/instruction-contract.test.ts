import { describe, expect, it } from 'vitest';
import {
  buildInstructionContract,
  contractMetadata,
  INSTRUCTION_CONTRACT_VERSION,
  readInstructionContract,
} from '../src/utils/instruction-contract.js';

describe('instruction contract', () => {
  it('extracts explicit forbidden actions from prompt and metadata', () => {
    const contract = buildInstructionContract({
      prompt: '请继续完成任务，不要启动 train，也不要 push。',
      metadata: {
        forbiddenActions: ['delete'],
        acceptanceCriteria: ['tests passed'],
      },
      sideEffectClass: 'readOnly',
      idempotencyKey: 'idem-1',
    });

    expect(contract.version).toBe(INSTRUCTION_CONTRACT_VERSION);
    expect(contract.forbiddenActions).toEqual(['train', 'push', 'delete']);
    expect(contract.acceptanceCriteria).toEqual(['tests passed']);
    expect(contract.sideEffectClass).toBe('readOnly');
    expect(contract.idempotencyKey).toBe('idem-1');
  });

  it('round-trips compact metadata', () => {
    const contract = buildInstructionContract({
      prompt: '完成 P0-P1',
      metadata: { acceptanceCriteria: ['p0 done', 'p1 done'] },
    });
    const parsed = readInstructionContract(contractMetadata(contract));

    expect(parsed).toMatchObject({
      version: INSTRUCTION_CONTRACT_VERSION,
      forbiddenActions: [],
      acceptanceCriteria: ['p0 done', 'p1 done'],
      sideEffectClass: 'unknown',
    });
  });
});
