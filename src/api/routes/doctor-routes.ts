import type * as http from 'node:http';
import { buildDoctorReport } from '../doctor.js';
import type { RouteContext } from './types.js';
import { jsonResponse } from './helpers.js';

export async function handleDoctorRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method !== 'GET' || url !== '/api/doctor') return false;
  jsonResponse(res, 200, {
    report: buildDoctorReport({
      registry: ctx.registry,
      botsConfigPath: ctx.botsConfigPath,
      activityStore: ctx.activityStore,
      managerService: ctx.managerService,
      memoryServerUrl: ctx.memoryServerUrl,
    }),
  });
  return true;
}
