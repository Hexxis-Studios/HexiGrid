import { existsSync } from 'node:fs';
import path from 'node:path';

// npm's Windows shim passes arguments through cmd.exe (%*). Embedded newlines
// are truncated there, and shell metacharacters must never interpret a prompt.
export function openCodeCommand(candidate, { platform = process.platform, exists = existsSync } = {}) {
  if (platform === 'win32' && /\.(cmd|ps1|bat)$/i.test(candidate)) {
    const native = path.win32.join(path.win32.dirname(candidate), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (exists(native)) return { command: native, args: [] };
    throw new Error('OpenCode needs its native executable for safe multiline prompts. Set OPENCODE_CLI to opencode.exe or reinstall OpenCode from its official package.');
  }
  return { command: candidate, args: [] };
}
