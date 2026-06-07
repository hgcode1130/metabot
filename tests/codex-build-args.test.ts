import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs, evaluateCodexActionGateEvent, resolveCodexModelMetadata } from '../src/engines/codex/executor.js';
import {
  buildCodexManagerMcpConfigArgs,
  buildCodexManagerMcpEnv,
} from '../src/engines/codex/manager-mcp-config.js';
import { resolveManagerMcpApiSecret } from '../src/engines/codex/manager-mcp-server.js';
import { buildCodexPromptWithContext } from '../src/engines/codex/prompt-context.js';
import type { CodexBotConfig } from '../src/config.js';

describe('buildCodexArgs', () => {
  const cwd = '/work/proj';
  const prompt = 'run pwd';

  it('defaults to bypassing Codex approvals and sandbox', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined);
    expect(args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      cwd,
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      prompt,
    ]);
  });

  it('honors explicit approvalPolicy and sandbox', () => {
    const cfg: CodexBotConfig = { approvalPolicy: 'on-failure', sandbox: 'read-only' };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    expect(args.slice(0, 4)).toEqual(['-a', 'on-failure', '--sandbox', 'read-only']);
  });

  it('replaces policy/sandbox flags when dangerouslyBypassApprovalsAndSandbox is set', () => {
    const cfg: CodexBotConfig = {
      dangerouslyBypassApprovalsAndSandbox: true,
      approvalPolicy: 'on-failure',
      sandbox: 'read-only',
    };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    expect(args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('-a');
    expect(args).not.toContain('--sandbox');
  });

  it('passes model and profile when provided', () => {
    const cfg: CodexBotConfig = { profile: 'staging' };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, 'gpt-5.4-codex');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.4-codex');
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('staging');
  });

  it('appends extraArgs verbatim between global flags and the exec subcommand', () => {
    const cfg: CodexBotConfig = { extraArgs: ['--foo', 'bar baz', '--qux'] };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    const execIdx = args.indexOf('exec');
    expect(args.slice(execIdx - 3, execIdx)).toEqual(['--foo', 'bar baz', '--qux']);
  });

  it('injects config overrides before the exec subcommand', () => {
    const cfgArgs = ['-c', 'mcp_servers.metabot-manager.command="node"'];
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined, cfgArgs);
    const execIdx = args.indexOf('exec');
    expect(args.slice(execIdx - 2, execIdx)).toEqual(cfgArgs);
  });

  it('uses `exec resume <sessionId>` when a session id is provided', () => {
    const args = buildCodexArgs({}, cwd, prompt, 'sess-abc', undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', 'sess-abc', prompt]);
    // resume path does NOT pass --color never (Codex resume subcommand differs)
    expect(tail).not.toContain('--color');
  });

  it('passes `--color never` for fresh executions (no session id)', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', '--json', '--color', 'never', '--skip-git-repo-check', prompt]);
  });

  it('keeps prompt as a single argv entry even with whitespace / metacharacters', () => {
    // spawn() receives argv as an array, so shell metacharacters are safe.
    const evil = 'ignore; rm -rf /\n`whoami`';
    const args = buildCodexArgs({}, cwd, evil, undefined, undefined);
    expect(args[args.length - 1]).toBe(evil);
  });

  it('infers Codex display model and context from CODEX_HOME files', () => {
    const priorCodexHome = process.env.CODEX_HOME;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-'));
    try {
      process.env.CODEX_HOME = dir;
      writeFileSync(join(dir, 'config.toml'), 'model = "gpt-test"\n');
      writeFileSync(
        join(dir, 'models_cache.json'),
        JSON.stringify({
          models: [
            { slug: 'gpt-test', context_window: 123456 },
            { slug: 'gpt-other', context_window: 999 },
          ],
        }),
      );

      expect(resolveCodexModelMetadata({})).toEqual({
        model: 'gpt-test',
        contextWindow: 123456,
      });
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds per-turn manager MCP config overrides for Codex without putting secrets in argv', () => {
    const priorPort = process.env.METABOT_API_PORT;
    const priorSecret = process.env.METABOT_API_SECRET;
    process.env.METABOT_API_PORT = '9191';
    process.env.METABOT_API_SECRET = 'manager-secret';
    try {
      const args = buildCodexManagerMcpConfigArgs({
        botName: 'manager',
        chatId: 'chat-a',
        managerToolsEnabled: true,
      });
      expect(args).toContain('-c');
      expect(args.join('\n')).toContain('experimental_use_rmcp_client=true');
      expect(args.join('\n')).toContain('mcp_servers.metabot-manager.command=');
      expect(args.join('\n')).toContain('mcp_servers.metabot-manager.args=');
      expect(args.join('\n')).toContain('METABOT_MANAGER_BOT_NAME="manager"');
      expect(args.join('\n')).toContain('METABOT_MANAGER_CHAT_ID="chat-a"');
      expect(args.join('\n')).toContain('METABOT_MANAGER_API_BASE_URL="http://127.0.0.1:9191"');
      expect(args.join('\n')).not.toContain('METABOT_API_SECRET');
      expect(args.join('\n')).not.toContain('manager-secret');
      expect(buildCodexManagerMcpEnv({
        botName: 'manager',
        chatId: 'chat-a',
        managerToolsEnabled: true,
      })).toEqual({ METABOT_API_SECRET: 'manager-secret' });
    } finally {
      if (priorPort === undefined) delete process.env.METABOT_API_PORT;
      else process.env.METABOT_API_PORT = priorPort;
      if (priorSecret === undefined) delete process.env.METABOT_API_SECRET;
      else process.env.METABOT_API_SECRET = priorSecret;
    }
  });

  it('lets the Codex manager MCP server recover API auth from MetaBot .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-manager-mcp-'));
    try {
      writeFileSync(join(dir, '.env'), 'API_SECRET=from-env-file\n');
      expect(resolveManagerMcpApiSecret({ METABOT_HOME: dir })).toBe('from-env-file');
      expect(resolveManagerMcpApiSecret({
        METABOT_HOME: dir,
        METABOT_API_SECRET: 'from-process-env',
      })).toBe('from-process-env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds manager-worker guidance to Codex prompts when manager tools are enabled', () => {
    const fullPrompt = buildCodexPromptWithContext({
      prompt,
      apiContext: { botName: 'manager', chatId: 'chat-a', managerToolsEnabled: true },
    });
    expect(fullPrompt).toContain('Manager / Worker Tools');
    expect(fullPrompt).toContain('metabot-manager MCP tools');
    expect(fullPrompt).toContain('get_worker_task');
  });

  it('evaluates Codex command execution events with the action gate', () => {
    const decision = evaluateCodexActionGateEvent(
      { forbiddenActions: ['push'], taskId: 'task-1', traceId: 'trace-1' },
      {
        type: 'item.started',
        item: { id: 'cmd-1', type: 'command_execution', command: 'git push origin main' },
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      action: 'push',
      command: 'git push origin main',
    });
  });

  it('does not hard-block Codex command events only because policy is read-only', () => {
    const decision = evaluateCodexActionGateEvent(
      { forbiddenActions: [], sideEffectClass: 'readOnly' },
      {
        type: 'item.started',
        item: { id: 'cmd-1', type: 'command_execution', command: 'ls -la' },
      },
    );

    expect(decision).toEqual({ allowed: true });
  });
});
