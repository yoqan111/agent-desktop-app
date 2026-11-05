import path from 'node:path';
import { isTrackedTemp } from './media';

const grantedInputs = new Set<string>();

export function grantInput(filePath: string): string {
  const absolute = path.resolve(filePath);
  grantedInputs.add(absolute);
  return absolute;
}

export function assertAgentPath(filePath: string): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('路径不合法。');
  }
  const absolute = path.resolve(filePath);
  if (grantedInputs.has(absolute) || isTrackedTemp(absolute)) {
    return absolute;
  }
  throw new Error('这个路径还没被用户允许。请先调用 media_grant。');
}
