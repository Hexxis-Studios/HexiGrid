import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ZERO_SHA = /^0+$/;
const forbiddenPaths = [
  /(^|\/)\.env(?:\.(?!example$).+)?$/i,
  /(^|\/)(?:data\/vault|data\/runner-profiles|data\/workspace|data\/media|data\/plugins)(?:\/|$)/i,
  /(^|\/)data\/(?:control-room\.json|\.runtime\.json|\.instance\.lock|.*\.state-key)$/i,
  /(^|\/)data\/\.development-fresh-start$/i,
  /(^|\/)(?:credentials|client_secret|token)[^/]*\.json$/i,
  /\.(?:pem|key|p12|pfx)$/i
];
const secretPatterns = [
  ['OpenAI-style key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['authorization bearer value', /\bauthorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+\/-]{20,}/gi],
  ['machine-specific Windows profile', /[A-Za-z]:\\Users\\(?!Public\\|Default\\)[^\\\s"']+/gi]
];

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function candidateFiles() {
  return git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
}

function pushedPatch(localSha, remoteSha) {
  if (!localSha) return '';
  if (!remoteSha || ZERO_SHA.test(remoteSha)) return git(['log', '--format=', '--no-ext-diff', '-p', localSha]);
  return git(['log', '--format=', '--no-ext-diff', '-p', `${remoteSha}..${localSha}`]);
}

function privateDevelopmentPath(file) {
  return /^(?:AGENTS\.md|WORKER_SUMMARY[^/]*\.md)$/i.test(file)
    || /^docs\/(?:evidence|qa|legal-review)\//i.test(file)
    || /^docs\/(?:.*[-_])?(?:HANDOFF|PLAN|PLANS|READINESS|ACCEPTANCE|WORKSTREAMS|ROADMAP)(?:[-_.]|$)/i.test(file)
    || /^docs\/(?:BROWSER-ACCESS-DIAGNOSTIC|PROJECT-COMPLETION-BOARD)\.md$/i.test(file);
}

function scan(label, content, findings) {
  if (content.includes('\0')) return;
  for (const [kind, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (kind === 'Google API key' && (['client/firebase-google.js', 'public/vendor/firebase-google.js'].includes(label) || label === 'outgoing commit history')) {
      const publicKeys = [...new Set(content.match(pattern) || [])];
      pattern.lastIndex = 0;
      const isBoundFirebaseConfig = publicKeys.length === 1 && content.includes('hexigrid.firebaseapp.com') && content.includes('1007956777224');
      if (isBoundFirebaseConfig) continue;
    }
    if (pattern.test(content)) findings.push(`${label}: possible ${kind}`);
  }
}

const [localSha, remoteSha] = process.argv.slice(2);
const findings = [];
const files = candidateFiles();
for (const file of files) {
  const normalized = file.replaceAll('\\', '/');
  if (forbiddenPaths.some((pattern) => pattern.test(normalized))) findings.push(`${file}: private runtime or credential file must not be tracked`);
  if (!localSha) {
    try { scan(file, await import('node:fs/promises').then(({ readFile }) => readFile(path.join(ROOT, file), 'utf8')), findings); } catch { /* Binary or unreadable file. */ }
    continue;
  }
  try {
    const content = git(['show', `${localSha}:${normalized}`]);
    scan(file, content, findings);
  } catch { /* Untracked working files are not part of this outgoing commit. */ }
}
if (localSha) {
  scan('outgoing commit history', pushedPatch(localSha, remoteSha), findings);
  const range = !remoteSha || ZERO_SHA.test(remoteSha) ? [localSha] : [`${remoteSha}..${localSha}`];
  const historyPaths = git(['log', '--format=', '--name-only', ...range]).split(/\r?\n/).filter(Boolean);
  if (historyPaths.some(privateDevelopmentPath)) {
    findings.push('outgoing commit history contains internal plans, handoffs or QA material; use a reviewed clean source snapshot instead of publishing this private working history');
  }
}

if (findings.length) {
  console.error('HexiGrid privacy gate blocked this push:');
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`HexiGrid privacy gate passed: ${files.length} candidate files checked${localSha ? ' plus the outgoing commit range' : ''}.`);
