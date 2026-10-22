import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEVELOPMENT_RESET_MARKER = '.development-fresh-start';

const PRIVATE_DIRECTORIES = ['vault', 'workspace', 'media', 'plugins', 'runner-profiles'];
const PRIVATE_FILES = [
  'control-room.json',
  'control-room.json.previous',
  'control-room.json.state-key',
  '.runtime.json'
];

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function developmentResetEnabled(dataDir) {
  try {
    return (await fs.readFile(path.join(dataDir, DEVELOPMENT_RESET_MARKER), 'utf8')).trim() === 'enabled-for-local-testing';
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function resetDevelopmentData(dataDir) {
  const root = path.resolve(dataDir);
  const marker = path.join(root, DEVELOPMENT_RESET_MARKER);
  if (!inside(root, marker) || !(await developmentResetEnabled(root))) return false;

  for (const name of PRIVATE_DIRECTORIES) {
    const target = path.join(root, name);
    if (!inside(root, target)) throw new Error('Development reset target escaped the private data folder.');
    await fs.rm(target, { recursive: true, force: true });
  }
  for (const name of PRIVATE_FILES) {
    const target = path.join(root, name);
    if (!inside(root, target)) throw new Error('Development reset target escaped the private data folder.');
    await fs.rm(target, { force: true });
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^control-room\.json\.(?:\d+\.pending|restore-|rollback-)/.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (!inside(root, target)) throw new Error('Development reset target escaped the private data folder.');
    await fs.rm(target, { force: true });
  }
  return true;
}
