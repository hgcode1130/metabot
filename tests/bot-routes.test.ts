import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBotRoutes } from '../src/api/routes/bot-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

function req(body?: unknown): any {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(chunks) as any;
  stream.headers = { host: 'localhost' };
  return stream;
}

function res(): any {
  return {
    statusCode: 0,
    body: undefined as any,
    writeHead: vi.fn(function (this: any, status: number) { this.statusCode = status; }),
    end: vi.fn(function (this: any, body: string) { this.body = JSON.parse(body); }),
  };
}

function ctx(configPath: string): RouteContext {
  return {
    botsConfigPath: configPath,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    registry: {} as any,
    ws: { handle: { broadcastBotList: vi.fn() } as any },
  } as RouteContext;
}

describe('bot routes', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    vi.restoreAllMocks();
  });

  it('returns 400 for invalid bot config updates instead of throwing', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'metabot-bot-routes-'));
    const configPath = join(tmpDir, 'bots.json');
    writeFileSync(configPath, JSON.stringify({
      webBots: [{ name: 'worker-code', defaultWorkingDirectory: '/tmp/worker-code' }],
    }, null, 2));

    const out = res();
    const handled = await handleBotRoutes(
      ctx(configPath),
      req({ manager: { enabled: true, maxConcurrentWorkerTasks: -1 } }),
      out,
      'PUT',
      '/api/bots/worker-code',
    );

    expect(handled).toBe(true);
    expect(out.statusCode).toBe(400);
    expect(out.body.error).toContain('validation failed');
    expect(readFileSync(configPath, 'utf-8')).toContain('worker-code');
  });
});
