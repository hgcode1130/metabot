import * as fs from 'node:fs';

export interface FilePermissionStatus {
  path: string;
  exists: boolean;
  mode?: string;
  private: boolean;
}

export function ensurePrivateFileMode(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  fs.chmodSync(filePath, 0o600);
}

export function filePermissionStatus(filePath: string | undefined): FilePermissionStatus | undefined {
  if (!filePath) return undefined;
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, private: false };
  const mode = fs.statSync(filePath).mode & 0o777;
  return {
    path: filePath,
    exists: true,
    mode: mode.toString(8).padStart(4, '0'),
    private: (mode & 0o077) === 0,
  };
}
