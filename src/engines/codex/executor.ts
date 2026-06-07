import { spawn, type ChildProcess } from 'node:child_process';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, ExecutorOptions, SDKMessage } from '../claude/executor.js';
import { createCodexTranslatorState, translateCodexJsonEvent, type CodexJsonEvent } from './jsonl-translator.js';
import { buildCodexArgs, resolveCodexModelMetadata, resolveCodexPath } from './codex-cli.js';
import { buildCodexManagerMcpConfigArgs, buildCodexManagerMcpEnv } from './manager-mcp-config.js';
import { buildCodexPromptWithContext } from './prompt-context.js';
import { evaluateToolUseActionGate, type ActionGateDecision, type ActionGatePolicy } from '../../utils/action-gate.js';

const CODEX_EXECUTABLE = resolveCodexPath();
export { buildCodexArgs, resolveCodexModelMetadata } from './codex-cli.js';

export class CodexExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;
    const codexConfig = this.config.codex ?? {};
    const model = options.model ?? codexConfig.model;
    const modelMetadata = resolveCodexModelMetadata(codexConfig, model);
    const fullPrompt = buildCodexPromptWithContext({ prompt, outputsDir, apiContext });
    const queue = new AsyncQueue<SDKMessage>();
    const state = createCodexTranslatorState({
      model: modelMetadata.model,
      contextWindow: modelMetadata.contextWindow,
    });
    const managerMcpConfigArgs = buildCodexManagerMcpConfigArgs(apiContext);
    const managerMcpEnv = buildCodexManagerMcpEnv(apiContext);
    const startTime = Date.now();
    let child: ChildProcess | undefined;
    let sawResult = false;
    let stderr = '';
    let stdoutBuffer = '';

    this.logger.info({ cwd, hasSession: !!sessionId, outputsDir, engine: 'codex' }, 'Starting Codex execution');

    const finishWithError = (message: string): void => {
      if (sawResult) return;
      sawResult = true;
      queue.enqueue({
        type: 'result',
        subtype: abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
        session_id: state.sessionId ?? sessionId,
        duration_ms: Date.now() - startTime,
        result: state.lastAgentText,
        is_error: true,
        errors: [message],
      });
    };

    const blockForbiddenCommand = (event: CodexJsonEvent): boolean => {
      if (event.type !== 'item.started' || event.item?.type !== 'command_execution') return false;
      const decision = evaluateCodexActionGateEvent(options.actionGatePolicy, event);
      if (decision.allowed) return false;
      this.logger.warn(
        { action: decision.action, command: decision.command, taskId: options.actionGatePolicy?.taskId, traceId: options.actionGatePolicy?.traceId },
        'Codex action gate blocked command execution',
      );
      options.onActionGateBlocked?.(decision);
      finishWithError(decision.reason ?? 'Action blocked by instruction contract');
      if (child && !child.killed) child.kill('SIGTERM');
      queue.finish();
      return true;
    };

    const emitEvent = (event: CodexJsonEvent): void => {
      if (blockForbiddenCommand(event)) return;
      const messages = translateCodexJsonEvent(event, state);
      for (const message of messages) {
        if (message.type === 'result') sawResult = true;
        queue.enqueue(message);
      }
    };

    const processStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          emitEvent(JSON.parse(line) as CodexJsonEvent);
        } catch (err) {
          this.logger.warn({ err, line }, 'Failed to parse Codex JSONL event');
        }
      }
    };

    try {
      const spawnConfig = codexConfig;
      const args = buildCodexArgs(spawnConfig, cwd, fullPrompt, sessionId, model, managerMcpConfigArgs);
      child = spawn(spawnConfig.executable || CODEX_EXECUTABLE, args, {
        cwd,
        env: { ...process.env, ...(spawnConfig.env ?? {}), ...managerMcpEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      finishWithError(err?.message || String(err));
      queue.finish();
    }

    if (child) {
      if (abortController.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        abortController.signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true });
      }

      child.stdout?.on('data', processStdout);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        finishWithError(err.message);
        queue.finish();
      });
      child.on('close', (code, signal) => {
        if (stdoutBuffer.trim()) {
          try {
            emitEvent(JSON.parse(stdoutBuffer) as CodexJsonEvent);
          } catch (err) {
            this.logger.warn({ err, line: stdoutBuffer }, 'Failed to parse final Codex JSONL event');
          }
        }
        if (code !== 0 && !sawResult) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          finishWithError(`Codex exited with ${signal ? `signal ${signal}` : `code ${code}`}${suffix}`);
        }
        if (stderr.trim()) {
          this.logger.debug({ stderr: stderr.trim() }, 'Codex stderr');
        }
        queue.finish();
      });
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'codex' }, 'sendAnswer called on Codex executor — not implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'codex' }, 'resolveQuestion called on Codex executor — not implemented');
      },
      finish: () => {
        if (child && !child.killed) child.kill('SIGTERM');
        queue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const msg of handle.stream) {
        yield msg;
      }
    } finally {
      handle.finish();
    }
  }
}

export function evaluateCodexActionGateEvent(
  policy: ActionGatePolicy | undefined,
  event: CodexJsonEvent,
): ActionGateDecision {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return { allowed: true };
  if (event.item?.type !== 'command_execution') return { allowed: true };
  return evaluateToolUseActionGate(policy, 'Bash', { command: event.item.command });
}
