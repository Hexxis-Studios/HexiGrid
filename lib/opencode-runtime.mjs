import { spawn } from 'node:child_process';

function runtimeEnvironment(overrides = {}) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ComSpec', 'COMSPEC', 'LANG', 'LC_ALL'];
  return { ...Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]])), ...overrides };
}

function permissionConfig(mode, approvalPolicy, approved, subagents) {
  const canRead = ['setup', 'plan', 'goal', 'sketch', 'research', 'build', 'watch'].includes(mode);
  const canNetwork = ['setup', 'plan', 'goal', 'sketch', 'research', 'build', 'watch'].includes(mode);
  const canEdit = ['goal', 'sketch', 'build'].includes(mode);
  const canShell = ['goal', 'build'].includes(mode);
  const canDelegate = subagents === true && ['goal', 'research', 'build', 'watch'].includes(mode);
  const actionApproved = approvalPolicy === 'full' || approvalPolicy === 'review' || approved === true;
  const allow = (condition) => condition && actionApproved ? 'allow' : 'deny';
  return {
    permission: {
      '*': 'deny',
      read: canRead ? 'allow' : 'deny', glob: canRead ? 'allow' : 'deny', grep: canRead ? 'allow' : 'deny', list: canRead ? 'allow' : 'deny',
      lsp: canRead ? 'allow' : 'deny', webfetch: canNetwork ? 'allow' : 'deny', websearch: canNetwork ? 'allow' : 'deny',
      edit: allow(canEdit), task: allow(canDelegate), skill: allow(canDelegate), external_directory: 'deny',
      bash: canShell && actionApproved ? {
        '*': approvalPolicy === 'full' || approved === true ? 'allow' : 'deny',
        'git push*': 'deny', 'git reset --hard*': 'deny', 'rm -rf*': 'deny', 'Remove-Item * -Recurse*': 'deny',
        'shutdown*': 'deny', 'format *': 'deny', 'diskpart*': 'deny'
      } : 'deny',
      todowrite: canEdit ? 'allow' : 'deny', question: 'deny', doom_loop: 'deny'
    },
    share: 'disabled',
    autoupdate: false
  };
}

export function parseOpenCodeEvents(raw) {
  const events = String(raw || '').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const text = events.filter((event) => event.type === 'text' && typeof event.part?.text === 'string').map((event) => event.part.text).join('');
  const sessionId = events.find((event) => typeof event.sessionID === 'string')?.sessionID || null;
  const finish = [...events].reverse().find((event) => event.type === 'step_finish' && event.part?.tokens);
  const failure = events.find((event) => event.type === 'error');
  // Provider error envelopes may contain headers, URLs or private diagnostics.
  // Only this known actionable denial crosses into the product response.
  const errorMessage = failure?.error?.data?.message === "OpenCode's free tier can only be used from within OpenCode"
    ? 'OpenCode rejected this free-tier request. Choose another available free or local AI connection; HexiGrid will not switch to a paid model automatically.'
    : failure ? 'OpenCode could not complete this request. Check the selected AI connection and try again.' : null;
  const toolReceipts = events.filter((event) => event.type === 'tool_use' || event.type === 'tool_result' || event.part?.type === 'tool').map((event) => ({
    type: event.type || event.part?.type,
    tool: event.part?.tool || event.part?.name || 'tool',
    status: event.part?.state?.status || event.part?.status || 'reported',
    timestamp: event.timestamp || Date.now()
  })).slice(-100);
  return {
    content: text.trim(), sessionId, errorMessage,
    inputTokens: Number.isSafeInteger(finish?.part?.tokens?.input) ? finish.part.tokens.input : null,
    outputTokens: Number.isSafeInteger(finish?.part?.tokens?.output) ? finish.part.tokens.output : null,
    toolReceipts
  };
}

export function executeOpenCode({ command, prefixArgs = [], prompt, model, sessionId, cwd, workMode, approvalPolicy, approved = false, subagents = false, timeoutMs = 180000, signal }) {
  return new Promise((resolve, reject) => {
    if (/^(cmd|powershell|pwsh)(\.exe)?$/i.test(command.split(/[\\/]/).pop()) || /\.(cmd|bat|ps1)$/i.test(command)) {
      return reject(new Error('OpenCode requires a native executable; a shell launcher cannot safely carry multiline prompts. Set OPENCODE_CLI to opencode.exe.'));
    }
    const config = permissionConfig(workMode, approvalPolicy, approved, subagents);
    const acting = ['goal', 'sketch', 'build'].includes(workMode) && (approvalPolicy !== 'ask' || approved);
    const args = [...prefixArgs, 'run', '--pure', '--dir', cwd, '--model', model, '--agent', acting ? 'build' : 'plan', '--format', 'json'];
    if (sessionId) args.push('--session', sessionId);
    if (acting) args.push('--auto');
    args.push(prompt);
    const env = runtimeEnvironment({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_AUTO_SHARE: 'false', OPENCODE_DISABLE_AUTOUPDATE: 'true' });
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      const error = new Error('The agent run was stopped.');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error('OpenCode timed out while the agent was working.')); } }, timeoutMs);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('OpenCode is not installed or could not be started.')); } });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const parsed = parseOpenCodeEvents(stdout);
      if (parsed.errorMessage) return reject(new Error(parsed.errorMessage));
      if (code !== 0) return reject(new Error((stderr.trim() || `OpenCode exited with code ${code}.`).slice(0, 1200)));
      if (!parsed.content) return reject(new Error('OpenCode returned no text.'));
      resolve(parsed);
    });
  });
}

export { permissionConfig as openCodePermissionConfig };
